/* ------------------------------------------------------------------ *
 * Minimal text-frame WebSocket. Enough for presence and combat inputs;
 * not a general-purpose library.
 * ------------------------------------------------------------------ */

import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export function isUpgrade(req: IncomingMessage) {
  return (req.headers.upgrade ?? '').toLowerCase() === 'websocket'
}

export function acceptUpgrade(req: IncomingMessage, socket: Duplex): WsConn | null {
  const key = req.headers['sec-websocket-key']
  if (typeof key !== 'string' || !key) return null
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
  onMessage: (text: string) => void = () => {}
  onClose: () => void = () => {}

  constructor(private readonly socket: Duplex) {
    socket.on('data', chunk => this.push(chunk as Buffer))
    socket.on('close', () => this.die())
    socket.on('error', () => this.die())
  }

  send(text: string) {
    if (this.closed) return
    const payload = Buffer.from(text, 'utf8')
    this.socket.write(encodeFrame(0x1, payload))
  }

  close() {
    if (this.closed) return
    try {
      this.socket.write(encodeFrame(0x8, Buffer.alloc(0)))
    } catch {
      /* already gone */
    }
    this.die()
  }

  private push(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (true) {
      const frame = decodeFrame(this.buffer)
      if (!frame) return
      this.buffer = this.buffer.subarray(frame.consumed)
      if (frame.opcode === 0x8) {
        this.die()
        return
      }
      if (frame.opcode === 0x9) {
        this.socket.write(encodeFrame(0xa, frame.payload))
        continue
      }
      if (frame.opcode === 0x1) this.onMessage(frame.payload.toString('utf8'))
    }
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

function decodeFrame(buffer: Buffer): { opcode: number; payload: Buffer; consumed: number } | null {
  if (buffer.length < 2) return null
  const opcode = buffer[0] & 0x0f
  const masked = buffer[1] & 0x80
  let len = buffer[1] & 0x7f
  let offset = 2
  if (len === 126) {
    if (buffer.length < 4) return null
    len = buffer.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    if (buffer.length < 10) return null
    len = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  const maskOffset = masked ? offset + 4 : offset
  if (buffer.length < maskOffset + len) return null
  let payload = buffer.subarray(maskOffset, maskOffset + len)
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4)
    const copy = Buffer.from(payload)
    for (let i = 0; i < copy.length; i++) copy[i] ^= mask[i % 4]
    payload = copy
  }
  return { opcode, payload, consumed: maskOffset + len }
}
