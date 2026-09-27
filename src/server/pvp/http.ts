import type { IncomingMessage, ServerResponse } from 'node:http'
import { looksLikePlayerId } from '../../shared/pvp'
import { DUEL_RINGS } from '../../shared/zones'
import { walletFromAuthHeader } from '../auth'
import { inspectCard, journalFor, livePose } from './hub'
import { issueGuestSession } from './guest'
import { accountByPlayer, ensureAccount } from './ids'
import { goldView } from './ledger'
import { publicCard } from './challenges'

export type Send = (res: ServerResponse, status: number, body: Record<string, unknown> | Array<unknown>) => void
export type Fail = (res: ServerResponse, status: number, error: string, detail?: string) => void

export function handlePvpHttp(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  send: Send,
  fail: Fail,
): boolean {
  if (!path.startsWith('/api/pvp')) return false

  if (method === 'GET' && path === '/api/pvp/rings') {
    send(res, 200, { rings: DUEL_RINGS.map(r => ({ id: r.id, name: r.name, x: r.x, z: r.z })), notice: 'Outdoor rings. Town is protected.' })
    return true
  }

  const wallet = walletFromAuthHeader(req.headers.authorization)
  if (!wallet) {
    fail(res, 401, 'unauthenticated', 'Sign in with your wallet first.')
    return true
  }
  const account = ensureAccount(wallet)

  if (method === 'GET' && path === '/api/pvp/me') {
    send(res, 200, {
      playerId: account.player_id,
      gold: goldView(account.player_id),
      incomingDisabled: Boolean(account.incoming_off),
    })
    return true
  }

  if (method === 'GET' && path === '/api/pvp/journal') {
    send(res, 200, { entries: journalFor(account.player_id) })
    return true
  }

  if (method === 'GET' && path.startsWith('/api/pvp/player/')) {
    const other = path.slice('/api/pvp/player/'.length)
    if (!looksLikePlayerId(other)) {
      fail(res, 400, 'bad_request', 'playerId is required.')
      return true
    }
    const card = inspectCard(account.player_id, other)
    if (!card) {
      fail(res, 404, 'not_found')
      return true
    }
    send(res, 200, { card })
    return true
  }

  fail(res, 404, 'not_found')
  return true
}

export function publicPlayerPayload(playerId: string, you: string) {
  const row = accountByPlayer(playerId)
  if (!row) return null
  return publicCard(row, you, livePose(playerId))
}
