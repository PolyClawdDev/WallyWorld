/* ------------------------------------------------------------------ *
 * The wallet panel: one wallet, the account it is linked to, and the
 * payout that is switched off.
 *
 * There is exactly one wallet in Voxels now — the Ed25519 keypair this
 * browser generated and keeps, in `embeddedWallet.ts` — and it signs
 * identity challenges and nothing else. There is no browser extension to
 * connect, no second address to confuse it with, and no code path in this
 * client that can submit a transaction.
 *
 * This file is the frame: the network banner, the three configuration
 * faults worth stating before anything else, the wallet block itself
 * (`EmbeddedWalletPanel.tsx`, kept separate because it is the one place a
 * secret key can be put on screen), and the payout notice.
 * ------------------------------------------------------------------ */

import React, { useEffect, useState } from 'react'
import { fundsLabel, CLUSTER, RPC_PROXY_URL } from './cluster'
import { EmbeddedWalletBlock, PixelGlyph } from './EmbeddedWalletPanel'
import { useClientStatus } from './clientStatus'
import { fetchPayoutStatus } from './api'
import './solana.css'

/* --------------------------------------------------------------- payouts */

/**
 * Why gold cannot be cashed out, stated as it actually stands.
 *
 * The previous wording — "gold is counted by your browser" — was true before
 * `server/money/ledger.ts` existed and is not true now, and an out-of-date
 * reason is worse than a blunt one: it invites the player to conclude that the
 * real blockers were solved when they were not.
 *
 * The server sends its own version of this and it wins, so the two are kept
 * saying the same thing; this is the fallback for a server that is not up.
 */
const PAYOUT_FALLBACK =
  'Your gold is held by the server now, in an append-only double-entry ledger of whole units — not counted by your browser. Only gold from a verified hunt claim is even eligible; gifts, duel winnings and imported demo gold are permanently not. What is missing is the payout side: there is no treasury signing key, the five withdrawal settings have no values and no defaults, and no WALLY token mint exists.'

/*
 * The same reason, as a list of absences.
 *
 * Every row names a thing that does not exist, so none of them can be read as
 * a switch waiting to be flipped, and the last one is the caveat that is
 * easiest to lose in prose and worst to lose at all: the server bounds what a
 * hunt can pay, but it does not watch the fight. These are a summary and not a
 * replacement — the authoritative wording, the server's when it is up, sits
 * one click below under "why", which is the only place this block shortens
 * anything rather than hiding it.
 */
const BLOCKERS: { label: string; state: string; caveat?: true }[] = [
  { label: 'Treasury signing key', state: 'NONE' },
  { label: 'Withdrawal settings', state: 'NO VALUES' },
  { label: 'WALLY token mint', state: 'DOES NOT EXIST' },
  { label: 'Gold that could ever qualify', state: 'VERIFIED HUNTS ONLY' },
  { label: 'Proof a hunt fight happened', state: 'NOT PROVEN', caveat: true },
]

function PayoutNotice() {
  const [reason, setReason] = useState<string | null>(null)
  const [why, setWhy] = useState(false)
  useEffect(() => {
    void fetchPayoutStatus().then(
      status => setReason(status.reason),
      () => setReason(null),
    )
  }, [])

  return (
    <div className="sol-block sol-disabled-block">
      <div className="sol-block-head">
        <span className="sol-buckle off" aria-hidden="true" />
        <div>
          <strong>GOLD → TOKEN REWARDS</strong>
          <small>nothing here to turn on</small>
        </div>
        <b className="sol-plate off"><i aria-hidden="true" />UNAVAILABLE</b>
      </div>
      <button className="primary full" disabled aria-disabled="true">Convert gold to tokens — not available</button>
      <ul className="sol-checks">
        {BLOCKERS.map(row => (
          <li key={row.label} className={row.caveat ? 'caveat' : undefined}>
            <span>{row.label}</span>
            <b>{row.state}</b>
          </li>
        ))}
      </ul>
      <button type="button" className="sol-why" aria-expanded={why} onClick={() => setWhy(open => !open)}>
        <span>Why this cannot be switched on</span>
        <i aria-hidden="true">{why ? '▾' : '▸'}</i>
      </button>
      {why && (
        <div className="sol-why-body">
          <p className="sol-fine">{reason ?? PAYOUT_FALLBACK}</p>
          <p className="sol-fine">
            <strong>The honest limit:</strong> hunting still runs in your browser. The server decides what each animal is
            worth, which species it was, that each one pays at most once, and how much a single trip can ever pay — but it
            does not watch the fight, so it cannot prove one happened.
          </p>
          <p className="sol-fine">This is not a setting anyone can switch on. See the README for what would have to exist first.</p>
        </div>
      )}
    </div>
  )
}

/* ----------------------------------------------------------------- shell */

export function WalletSolanaPanel() {
  const status = useClientStatus()
  const label = fundsLabel()

  return (
    <div className="sol-panel">
      <div className={`sol-banner funds-${label.mode}`}>
        <strong>{label.short}</strong>
        <span>{label.long}</span>
      </div>

      {status.configError && (
        <p className="sol-error"><strong>Configuration problem.</strong> {status.configError}</p>
      )}

      {/* Shown instead of a chain error, because when this is set no chain call
          was ever made: the address the client was pointed at is not this
          project's API. Naming the URL is the whole point. */}
      {status.apiError && (
        <p className="sol-error">
          <strong>The Voxels API is not where this page is looking.</strong> {status.apiError}
        </p>
      )}

      {status.clusterCheck?.status === 'mismatch' && (
        <p className="sol-error">
          <strong>Cluster mismatch.</strong> The app is configured for {CLUSTER}, but the configured RPC endpoint reports
          genesis hash {status.clusterCheck.actual} instead of {status.clusterCheck.expected}. Your wallet address is
          shown for the wrong network until this is fixed.
        </p>
      )}
      {status.clusterCheck?.status === 'unreachable' && !status.apiError && (
        <p className="sol-error">
          <strong>RPC unreachable.</strong> The API at {RPC_PROXY_URL} answered, but the chain read through it did
          not complete: {status.clusterCheck.detail}
        </p>
      )}

      <EmbeddedWalletBlock />
      <PayoutNotice />

      <div className="sol-fine sol-footer">
        <div className="sol-note">
          <PixelGlyph glyph="key" />
          <p>
            <strong>One wallet, and you hold it.</strong> The key is a real Solana keypair that was generated in this
            browser and sits in this browser&rsquo;s storage. The server never receives it — only your address and the
            signatures it makes over challenges the server issued. Voxels will never ask you for a seed phrase or a
            private key, not here and not anywhere else in the game.
          </p>
        </div>
        <div className="sol-note">
          <PixelGlyph glyph="skull" />
          <p>
            <strong>What that costs you.</strong> Nobody can recover the key for you, and any script that gets onto this
            page can read it. It also cannot spend: there is no transaction signer in this app, so the only way SOL
            leaves that address is if you import the key into a wallet of your own and send it yourself. Export it
            somewhere safe, and keep it to small amounts.
          </p>
        </div>
      </div>
    </div>
  )
}
