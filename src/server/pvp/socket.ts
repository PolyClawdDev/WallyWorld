/* ------------------------------------------------------------------ *
 * Minimal text-frame WebSocket. Enough for presence and combat inputs;
 * not a general-purpose library.
 *
 * It is small on purpose, but "small" and "trusting" are not the same
 * thing. Once this is on the public internet the bytes arriving here come
 * from anyone, so the parser enforces the parts of RFC 6455 that exist to
 * protect the server rather than to please a browser:
 *
 *   Client frames must be masked. The masking rule is not about secrecy —
 *   the key travels with the frame — it is about stopping an attacker
 *   from using a browser to write attacker-chosen bytes onto a socket
 *   that some intermediary might read as a second HTTP request. An
 *   unmasked frame did not come from a browser and is refused.
 *
 *   Every message has a size ceiling, enforced while the frame is still
 *   arriving. Without it a declared 64-bit length is an instruction to
 *   this process to allocate memory until it dies.
 *
 *   Every connection has a message-rate ceiling. Presence updates are
 *   naturally around twelve a second; a client sending thousands is not
 *   playing the game.
 *
 *   Writes are dropped when the kernel buffer is already full. A client
 *   that stops reading must not be able to make the server hold its
 *   backlog in memory on the client's behalf.
 * ------------------------------------------------------------------ */

import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Comfortably above the largest legitimate C2S message, far below anything harmful. */
export const MAX_MESSAGE_BYTES = 16 * 1024

/** Sustained ceiling. Presence is ~12/s and combat input is burstier but bounded. */
const MESSAGE_RATE = { windowMs: 1_000, max: 80 }

/** Past this much unflushed output the peer is not reading and further sends are pointless. */
const MAX_BUFFERED_BYTES = 1 << 20

/** RFC 6455 close codes used here. */
export const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  policy: 1008,
  tooBig: 1009,
} as const

export function isUpgrade(req: IncomingMessage) {
  return (req.headers.upgrade ?? '').toLowerCase() === 'websocket'
}

export function acceptUpgrade(req: IncomingMessage, socket: Duplex): WsConn | null {
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string' || !key) return null
  // Version 13 is the only version any current browser speaks, and accepting
  // an unknown one means agreeing to a framing this parser does not implement.
  const version = req.headers['sec-websocket-version']
  if (version !== undefined && String(version).trim() !== '13') return null

  // Nagle batches small writes, which is exactly wrong for a game: a 12 Hz
  // pose update would sit in the kernel waiting for company. The upgrade
  // socket is always a TCP socket in practice, but `Duplex` does not promise
  // it, so the call is guarded rather than asserted.
  ;(socket as Duplex & { setNoDelay?: (on: boolean) => void }).setNoDelay?.(true)

  const accept = createHash('sha1').update(key + GUID).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n',
  )
  return new WsConn(socket)
}

export class WsConn {
  private buffer = Buffer.alloc(0)
  private closed = false
  /** Payload of a fragmented message assembled so far. */
  private fragments: Buffer[] = []
  private fragmentBytes = 0
  private fragmentOpcode = 0
  private window = { count: 0, resetAt: 0 }

  /** Last time anything at all arrived, including a pong. Drives stale-connection sweeps. */
  lastSeenAt = Date.now()
  /** Last reply to a server-initiated ping. */
  lastPongAt = Date.now()

  onMessage: (text: string) => void = () => {}
  onClose: () => void = () => {}

  constructor(private readonly socket: Duplex) {
    socket.on('data', chunk => this.push(chunk as Buffer))
    socket.on('close', () => this.die())
    socket.on('error', () => this.die())
  }

  get isClosed() {
    return this.closed
  }

  send(text: string) {
    if (this.closed) return
    // Silently dropping is the right failure here: the alternative is buffering
    // for a peer that has stopped reading, and presence is a stream of
    // snapshots where the next one supersedes the one that was dropped.
    if (this.socket.writableLength > MAX_BUFFERED_BYTES) return
    const payload = Buffer.from(text, 'utf8')
    this.socket.write(encodeFrame(0x1, payload))
  }

  /** Server-initiated liveness probe. The peer's pong updates `lastPongAt`. */
  ping() {
    if (this.closed) return
    this.socket.write(encodeFrame(0x9, Buffer.alloc(0)))
  }

  close(code: number = CLOSE.normal, reason = '') {
    if (this.closed) return
    try {
      const body = Buffer.from(reason, 'utf8').subarray(0, 123)
      const payload = Buffer.alloc(2 + body.length)
      payload.writeUInt16BE(code, 0)
      body.copy(payload, 2)
      this.socket.write(encodeFrame(0x8, payload))
    } catch {
      /* already gone */
    }
    this.die()
  }

  /** True when the connection has exceeded its message budget for this window. */
  private overRate(now: number): boolean {
    if (now >= this.window.resetAt) {
      this.window = { count: 1, resetAt: now + MESSAGE_RATE.windowMs }
      return false
    }
    this.window.count += 1
    return this.window.count > MESSAGE_RATE.max
  }

  private push(chunk: Buffer) {
    this.lastSeenAt = Date.now()
    if (this.buffer.length + chunk.length > MAX_MESSAGE_BYTES * 4) {
      // The peer is sending faster than frames can be completed; nothing
      // legitimate produces a backlog four times the largest allowed message.
      this.close(CLOSE.tooBig, 'message too large')
      return
    }
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (!this.closed) {
      let frame: ReturnType<typeof decodeFrame>
      try {
        frame = decodeFrame(this.buffer)
      } catch (error) {
        this.close(CLOSE.protocolError, error instanceof Error ? error.message : 'bad frame')
        return
      }
      if (!frame) return
      this.buffer = this.buffer.subarray(frame.consumed)

      if (frame.opcode === 0x8) {
        this.close(CLOSE.normal)
        return
      }
      if (frame.opcode === 0x9) {
        this.socket.write(encodeFrame(0xa, frame.payload))
        continue
      }
      if (frame.opcode === 0xa) {
        this.lastPongAt = Date.now()
        continue
      }

      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        if (this.fragmentBytes > 0) {
          this.close(CLOSE.protocolError, 'interleaved message')
          return
        }
        if (frame.fin) {
          if (frame.opcode === 0x1) this.deliver(frame.payload)
          continue
        }
        this.fragmentOpcode = frame.opcode
        this.fragments = [frame.payload]
        this.fragmentBytes = frame.payload.length
        continue
      }

      if (frame.opcode === 0x0) {
        if (this.fragmentBytes === 0 && this.fragments.length === 0) {
          this.close(CLOSE.protocolError, 'continuation without a start')
          return
        }
        this.fragmentBytes += frame.payload.length
        if (this.fragmentBytes > MAX_MESSAGE_BYTES) {
          this.close(CLOSE.tooBig, 'message too large')
          return
        }
        this.fragments.push(frame.payload)
        if (!frame.fin) continue
        const whole = Buffer.concat(this.fragments)
        const opcode = this.fragmentOpcode
        this.fragments = []
        this.fragmentBytes = 0
        this.fragmentOpcode = 0
        if (opcode === 0x1) this.deliver(whole)
        continue
      }

      this.close(CLOSE.protocolError, 'unsupported opcode')
      return
    }
  }

  private deliver(payload: Buffer) {
    if (this.overRate(Date.now())) {
      this.close(CLOSE.policy, 'too many messages')
      return
    }
    this.onMessage(payload.toString('utf8'))
  }

  private die() {
    if (this.closed) return
    this.closed = true
    this.socket.destroy()
    this.onClose()
  }
}

function encodeFrame(opcode: number, payload: Buffer) {
  const len = payload.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.alloc(2)
    header[0] = 0x80 | opcode
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeUInt32BE(0, 2)
    header.writeUInt32BE(len, 6)
  }
  return Buffer.concat([header, payload])
}

type DecodedFrame = { opcode: number; payload: Buffer; consumed: number; fin: boolean }

/**
 * Returns null when the frame has not fully arrived, and throws when the
 * bytes are not a frame this server will process. Throwing rather than
 * returning null matters: an unmasked or over-long frame never becomes
 * valid by waiting for more data, and treating it as "incomplete" would
 * leave the parser spinning on it forever.
 */
function decodeFrame(buffer: Buffer): DecodedFrame | null {
  if (buffer.length < 2) return null
  const fin = (buffer[0] & 0x80) !== 0
  const reserved = buffer[0] & 0x70
  const opcode = buffer[0] & 0x0f
  const masked = (buffer[1] & 0x80) !== 0
  let len = buffer[1] & 0x7f
  let offset = 2

  // No extension was negotiated, so a reserved bit means the peer is speaking
  // a protocol this parser does not implement.
  if (reserved !== 0) throw new Error('reserved bits set')
  // Control frames are never fragmented and never carry a long payload.
  if (opcode >= 0x8 && (!fin || len > 125)) throw new Error('bad control frame')

  if (len === 126) {
    if (buffer.length < 4) return null
    len = buffer.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    if (buffer.length < 10) return null
    const big = buffer.readBigUInt64BE(2)
    if (big > BigInt(MAX_MESSAGE_BYTES)) throw new Error('message too large')
    len = Number(big)
    offset = 10
  }
  if (len > MAX_MESSAGE_BYTES) throw new Error('message too large')
  if (!masked) throw new Error('client frames must be masked')

  const maskOffset = offset + 4
  if (buffer.length < maskOffset + len) return null
  const mask = buffer.subarray(offset, offset + 4)
  const payload = Buffer.from(buffer.subarray(maskOffset, maskOffset + len))
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
  return { opcode, payload, consumed: maskOffset + len, fin }
}
