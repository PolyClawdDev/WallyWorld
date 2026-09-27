import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { ALLOWED_ORIGINS } from '../config'
import { handlePvpHttp, type Fail, type Send } from './http'
import { attachLive } from './hub'
import { acceptUpgrade, isUpgrade } from './socket'
import './schema'

export { handlePvpHttp }

export function attachPvpUpgrade(server: Server) {
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    if (url.pathname.replace(/\/+$/, '') !== '/ws/pvp') {
      socket.destroy()
      return
    }
    const origin = (req.headers.origin ?? '').replace(/\/+$/, '')
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (!isUpgrade(req)) {
      socket.destroy()
      return
    }
    const token = url.searchParams.get('token')
    const conn = acceptUpgrade(req, socket)
    if (!conn) {
      socket.destroy()
      return
    }
    attachLive(token ? `Bearer ${token}` : req.headers.authorization, conn)
  })
}

export type { Send, Fail }
