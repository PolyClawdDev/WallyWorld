/* ------------------------------------------------------------------ *
 * The real wallet panel: Phantom connection, balances, sign-in, the
 * cross-device save, one user-signed payment, and the disabled payout.
 *
 * Nothing in this component can produce, request, or display a private
 * key or seed phrase. There is no field that accepts one and no button
 * that reveals one, because the app never has one: Phantom holds the key
 * and performs every signature.
 *
 * Amounts render from bigint base units through `formatBaseUnits`. No
 * amount is ever put through a float on the way to the screen or on the
 * way into a transaction.
 * ------------------------------------------------------------------ */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { explorerAddress, explorerTx, fundsLabel, truncateAddress, CLUSTER, RPC } from './cluster'
import { PHANTOM_DOWNLOAD_URL, describeWalletError, isUserRejection } from './phantom'
import { connect, disconnect, persistProfile, refreshBalances, signIn, signOut, useWallet, getProvider } from './wallet'
import { fetchPayoutStatus, fetchQuote, fetchReceipts, postReceipt, recheckReceipt, type Quote, type ReceiptView } from './api'
import { awaitConfirmation, checkAffordable, planTransfer, signAndSend, type TransferPlan } from './payments'
import { formatBaseUnits, formatSol } from './units'
import { applyPlayer, isPlayerReady, readPlayer, subscribePlayer } from './playerBridge'
import { toProfile } from './profileSync'
import type { MothStyle, WizardId } from '../characters'
import './solana.css'

/* ---------------------------------------------------------------- pieces */

function CopyableAddress({ address, label }: { address: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number>()
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address)
    } catch {
      // Clipboard permission can be denied; a selectable field is the fallback.
      const field = document.createElement('textarea')
      field.value = address
      field.style.position = 'fixed'
      field.style.opacity = '0'
      document.body.appendChild(field)
      field.select()
      try {
        document.execCommand('copy')
      } catch {
        /* nothing more we can do; the full address is in the title attribute */
      }
      document.body.removeChild(field)
    }
    setCopied(true)
    timer.current = window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="sol-address">
      <code title={address} aria-label={`${label}: ${address}`}>{truncateAddress(address, 6, 6)}</code>
      <button type="button" onClick={copy} aria-label={`Copy ${label} to clipboard`}>{copied ? '✓' : '⧉'}</button>
      <a href={explorerAddress(address)} target="_blank" rel="noopener noreferrer" aria-label={`View ${label} on Solana Explorer`}>↗</a>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="sol-row"><span>{label}</span><div>{children}</div></div>
}

/* ------------------------------------------------------------- balances */

function Balances() {
  const wallet = useWallet()
  if (!wallet.address) return null
  return (
    <div className="sol-block">
      <div className="sol-block-head">
        <span>ON-CHAIN BALANCES · {CLUSTER.toUpperCase()}</span>
        <button type="button" onClick={() => void refreshBalances()} disabled={wallet.balancesLoading}>
          {wallet.balancesLoading ? 'Reading…' : 'Refresh'}
        </button>
      </div>

      {wallet.balanceError && <p className="sol-error">Could not read balances: {wallet.balanceError}</p>}

      <div className="sol-balance-main">
        <strong>{wallet.lamports === null ? '—' : formatSol(wallet.lamports)}</strong>
        <small>SOL</small>
      </div>
      {/* The integer form is shown too: it is what actually gets signed. */}
      <p className="sol-fine">
        {wallet.lamports === null ? 'Balance not read yet.' : `${wallet.lamports.toString()} lamports`}
      </p>

      <div className="sol-tokens">
        <div className="sol-block-head"><span>SPL TOKENS HELD</span></div>
        {wallet.tokens.length === 0 ? (
          <p className="sol-fine">This wallet holds no SPL token accounts with a non-zero balance on {CLUSTER}.</p>
        ) : (
          <>
            {wallet.tokens.map(token => (
              <div className="sol-token" key={`${token.program}:${token.mint}`}>
                <div>
                  <strong>{formatBaseUnits(token.amount, token.decimals)}</strong>
                  <small>{token.program === 'token-2022' ? 'Token-2022' : 'SPL Token'}</small>
                </div>
                <CopyableAddress address={token.mint} label="token mint" />
              </div>
            ))}
            {/* Resolving a ticker needs a metadata source this build does not have,
                and guessing one from a mint address would be a way to mislabel a
                token. Mints are shown verbatim instead. */}
            <p className="sol-fine">Shown by mint address. This build has no token metadata source, so it does not display symbols or names.</p>
          </>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- sign-in */

function SignIn() {
  const wallet = useWallet()
  if (!wallet.address) return null

  if (!wallet.session) {
    return (
      <div className="sol-block">
        <div className="sol-block-head"><span>ACCOUNT</span><b className="sol-off">NOT SIGNED IN</b></div>
        <p className="sol-fine">
          Sign a one-time message to prove you control this wallet. The message is plain text issued by the
          Voxels server, is valid once, and expires. It is not a transaction: approving it costs no fee
          and cannot move funds. There is no password, and you will never be asked for a seed phrase.
        </p>
        <button className="primary full" onClick={() => void signIn()} disabled={wallet.signingIn}>
          {wallet.signingIn ? 'Waiting for Phantom…' : 'Sign in with Solana'}
        </button>
      </div>
    )
  }

  return (
    <div className="sol-block">
      <div className="sol-block-head"><span>ACCOUNT</span><b className="sol-on">SIGNED IN</b></div>
      <Row label="Wallet"><CopyableAddress address={wallet.session.wallet} label="signed-in wallet" /></Row>
      <button className="ghost full" onClick={() => void signOut()}>Sign out</button>
    </div>
  )
}

/* -------------------------------------------------------- character save */

function CharacterSave() {
  const wallet = useWallet()
  const [ready, setReady] = useState(isPlayerReady)
  const [notice, setNotice] = useState('')
  useEffect(() => subscribePlayer(() => setReady(isPlayerReady())), [])

  const save = async () => {
    const snapshot = readPlayer()
    if (!snapshot) return setNotice('The world is not loaded, so there is nothing to save.')
    const ok = await persistProfile(toProfile(snapshot))
    setNotice(ok ? 'Saved to this wallet.' : 'Could not save — see the message above.')
  }

  const load = () => {
    if (!wallet.profile) return setNotice('Nothing saved for this wallet yet.')
    const applied = applyPlayer({
      character: wallet.profile.character as WizardId,
      style: wallet.profile.style as MothStyle,
      playerName: wallet.profile.playerName,
      gold: wallet.profile.gold,
    })
    setNotice(applied ? 'Loaded the saved character.' : 'The world is not loaded yet.')
  }

  if (!wallet.session) return null

  return (
    <div className="sol-block">
      <div className="sol-block-head">
        <span>CHARACTER · SAVED TO THIS WALLET</span>
        {wallet.profileSyncing && <b>SAVING…</b>}
      </div>

      {wallet.profile ? (
        <>
          <Row label="Character">{wallet.profile.character}</Row>
          <Row label="Name">{wallet.profile.playerName}</Row>
          <Row label="Wardrobe">
            {wallet.profile.style.hat} · {wallet.profile.style.robe} · {wallet.profile.style.familiar} · {wallet.profile.style.accessory}
          </Row>
          <Row label="Gold">{formatBaseUnits(BigInt(wallet.profile.gold), 0)}</Row>
        </>
      ) : (
        <p className="sol-fine">No saved character for this wallet yet.</p>
      )}

      <div className="sol-actions">
        <button className="primary" onClick={() => void save()} disabled={!ready || wallet.profileSyncing}>Save to wallet</button>
        <button className="ghost" onClick={load} disabled={!ready || !wallet.profile}>Load save</button>
      </div>
      {notice && <p className="sol-fine">{notice}</p>}
      <p className="sol-fine">
        Stored server-side against your wallet address, so it follows you to another device. Gold is recorded
        for convenience only: the game runs in your browser, so the gold figure is whatever the browser reports
        and is not treated as a balance.
      </p>
    </div>
  )
}

/* ------------------------------------------------------------- payments */

type PayPhase =
  | { kind: 'idle' }
  | { kind: 'preparing' }
  | { kind: 'review'; plan: TransferPlan; label: string }
  | { kind: 'signing' }
  | { kind: 'confirming'; signature: string; elapsedMs: number }
  | { kind: 'settled'; receipt: ReceiptView }
  | { kind: 'failed'; message: string; signature: string | null }

function NpcPayment() {
  const wallet = useWallet()
  const [quote, setQuote] = useState<Quote | null>(null)
  const [phase, setPhase] = useState<PayPhase>({ kind: 'idle' })
  const [receipts, setReceipts] = useState<ReceiptView[]>([])
  const token = wallet.session?.token ?? null

  const loadReceipts = useCallback(async () => {
    if (!token) return
    try {
      setReceipts((await fetchReceipts(token)).receipts)
    } catch {
      /* the list is informational; a failure here must not block paying */
    }
  }, [token])

  useEffect(() => {
    if (!token) {
      setQuote(null)
      setReceipts([])
      return
    }
    let live = true
    void fetchQuote(token).then(
      next => live && setQuote(next),
      error => live && setQuote({ available: false, reason: error instanceof Error ? error.message : String(error) }),
    )
    void loadReceipts()
    return () => {
      live = false
    }
  }, [token, loadReceipts])

  const prepare = async () => {
    if (!token || !wallet.address || !quote?.available) return
    setPhase({ kind: 'preparing' })
    try {
      const plan = await planTransfer(wallet.address, quote.recipient, BigInt(quote.lamports))
      const affordable = await checkAffordable(plan)
      if (!affordable.ok) return setPhase({ kind: 'failed', message: affordable.reason, signature: null })
      setPhase({ kind: 'review', plan, label: quote.label })
    } catch (error) {
      setPhase({ kind: 'failed', message: error instanceof Error ? error.message : String(error), signature: null })
    }
  }

  /**
   * Submits, records, then confirms — in that order.
   *
   * The receipt is written to the server before confirmation is awaited, so a
   * closed tab or a dropped connection cannot lose the fact that a payment was
   * sent. The server keys receipts on the signature, so this is safe to retry.
   */
  const approve = async () => {
    if (phase.kind !== 'review' || !token) return
    const provider = getProvider()
    if (!provider) return setPhase({ kind: 'failed', message: 'Phantom is no longer available.', signature: null })
    const { plan } = phase

    let signature: string
    setPhase({ kind: 'signing' })
    try {
      signature = await signAndSend(provider, plan)
    } catch (error) {
      return setPhase({
        kind: 'failed',
        message: isUserRejection(error) ? 'Cancelled in Phantom. Nothing was sent.' : describeWalletError(error),
        signature: null,
      })
    }

    setPhase({ kind: 'confirming', signature, elapsedMs: 0 })
    try {
      await postReceipt(token, signature)
    } catch {
      /* Recorded again below after confirmation; the signature is the key. */
    }

    const outcome = await awaitConfirmation(signature, plan.lastValidBlockHeight, {
      onTick: elapsedMs => setPhase(current => (current.kind === 'confirming' ? { ...current, elapsedMs } : current)),
    })

    // The server re-derives the truth from the chain rather than trusting this
    // client's view of the outcome.
    try {
      const { receipt } = await recheckReceipt(token, signature)
      setPhase({ kind: 'settled', receipt })
    } catch {
      setPhase({
        kind: 'failed',
        message: `Submitted, and the cluster reported "${outcome.status}"${'detail' in outcome ? `: ${outcome.detail}` : ''}. The receipt could not be reconciled with the server — it is recorded under this signature and can be rechecked.`,
        signature,
      })
    }
    void loadReceipts()
  }

  const recheck = async (signature: string) => {
    if (!token) return
    try {
      const { receipt } = await recheckReceipt(token, signature)
      setPhase({ kind: 'settled', receipt })
      void loadReceipts()
    } catch (error) {
      setPhase({ kind: 'failed', message: error instanceof Error ? error.message : String(error), signature })
    }
  }

  if (!wallet.session) return null

  return (
    <div className="sol-block">
      <div className="sol-block-head"><span>PAY AN NPC FOR A SERVICE</span></div>

      {!quote ? (
        <p className="sol-fine">Loading the current price…</p>
      ) : !quote.available ? (
        <p className="sol-fine">Service payments are switched off: {quote.reason}</p>
      ) : phase.kind === 'review' ? (
        /* Everything the signature will do, stated before Phantom opens. */
        <div className="sol-confirm">
          <div className="sol-confirm-head">CONFIRM BEFORE SIGNING</div>
          <Row label="Service">{phase.label}</Row>
          <Row label="To"><CopyableAddress address={phase.plan.recipient} label="recipient" /></Row>
          <Row label="Amount"><strong>{formatSol(phase.plan.lamports)} SOL</strong> <small>({phase.plan.lamports.toString()} lamports)</small></Row>
          <Row label="Network fee">
            {phase.plan.feeLamports === null
              ? 'Could not be quoted by the RPC'
              : <>{formatSol(phase.plan.feeLamports)} SOL <small>({phase.plan.feeLamports.toString()} lamports)</small></>}
          </Row>
          <Row label="Total debit">
            {phase.plan.totalLamports === null ? '—' : <strong>{formatSol(phase.plan.totalLamports)} SOL</strong>}
          </Row>
          <Row label="Network">
            <span className={`sol-net sol-net-${fundsLabel(true).mode}`}>{CLUSTER}</span>
          </Row>
          <div className="sol-actions">
            <button className="primary" onClick={() => void approve()}>Approve in Phantom</button>
            <button className="ghost" onClick={() => setPhase({ kind: 'idle' })}>Cancel</button>
          </div>
          <p className="sol-fine">Phantom will show you this transaction again. Nothing is sent until you approve it there.</p>
        </div>
      ) : phase.kind === 'signing' ? (
        <p className="sol-fine">Waiting for you to approve or reject it in Phantom…</p>
      ) : phase.kind === 'confirming' ? (
        <div className="sol-pending">
          <strong>Submitted — not yet confirmed.</strong>
          <p className="sol-fine">
            Polling the cluster ({Math.round(phase.elapsedMs / 1000)}s). A signature only means the transaction was
            accepted for processing; it is not proof that it succeeded.
          </p>
          <a href={explorerTx(phase.signature)} target="_blank" rel="noopener noreferrer">View on Solana Explorer ↗</a>
        </div>
      ) : phase.kind === 'settled' ? (
        <ReceiptCard receipt={phase.receipt} onRecheck={() => void recheck(phase.receipt.signature)} onDone={() => setPhase({ kind: 'idle' })} />
      ) : phase.kind === 'failed' ? (
        <div className="sol-pending sol-bad">
          <strong>Not completed.</strong>
          <p className="sol-fine">{phase.message}</p>
          {phase.signature && (
            <>
              <a href={explorerTx(phase.signature)} target="_blank" rel="noopener noreferrer">View on Solana Explorer ↗</a>
              <button className="ghost" onClick={() => void recheck(phase.signature!)}>Check again</button>
            </>
          )}
          <button className="ghost" onClick={() => setPhase({ kind: 'idle' })}>Back</button>
        </div>
      ) : (
        <>
          <Row label="Service">{quote.label}</Row>
          <Row label="Price"><strong>{formatSol(BigInt(quote.lamports))} SOL</strong></Row>
          <Row label="To"><CopyableAddress address={quote.recipient} label="recipient" /></Row>
          <button className="primary full" onClick={() => void prepare()} disabled={phase.kind === 'preparing'}>
            {phase.kind === 'preparing' ? 'Quoting fee…' : 'Pay for this service'}
          </button>
        </>
      )}

      {receipts.length > 0 && (
        <div className="sol-receipts">
          <div className="sol-block-head"><span>RECEIPTS</span></div>
          {receipts.map(receipt => (
            <ReceiptLine key={receipt.signature} receipt={receipt} onRecheck={() => void recheck(receipt.signature)} />
          ))}
        </div>
      )}
    </div>
  )
}

const STATUS_COPY: Record<ReceiptView['status'], { label: string; tone: string; note: string }> = {
  confirmed: { label: 'CONFIRMED', tone: 'sol-on', note: 'The cluster confirmed this transfer and the server verified it against the chain.' },
  submitted: { label: 'PENDING', tone: 'sol-warn', note: 'Submitted but not yet confirmed. It may still land — recheck rather than resending.' },
  unknown: { label: 'UNKNOWN', tone: 'sol-warn', note: 'The cluster has no record of this signature. It may never have landed. Recheck before assuming either way.' },
  failed: { label: 'FAILED', tone: 'sol-bad-text', note: 'The transaction did not transfer what was expected. Nothing was credited.' },
}

function ReceiptCard({ receipt, onRecheck, onDone }: { receipt: ReceiptView; onRecheck: () => void; onDone: () => void }) {
  const copy = STATUS_COPY[receipt.status]
  return (
    <div className={`sol-pending${receipt.status === 'failed' ? ' sol-bad' : ''}`}>
      <strong className={copy.tone}>{copy.label}</strong>
      <p className="sol-fine">{copy.note}</p>
      {receipt.detail && <p className="sol-fine">Cluster said: {receipt.detail}</p>}
      <Row label="Amount">{formatSol(BigInt(receipt.lamports))} SOL</Row>
      <Row label="Signature"><code title={receipt.signature}>{truncateAddress(receipt.signature, 8, 8)}</code></Row>
      <a href={explorerTx(receipt.signature)} target="_blank" rel="noopener noreferrer">View on Solana Explorer ↗</a>
      <div className="sol-actions">
        {receipt.status !== 'confirmed' && <button className="ghost" onClick={onRecheck}>Check again</button>}
        <button className="ghost" onClick={onDone}>Done</button>
      </div>
    </div>
  )
}

function ReceiptLine({ receipt, onRecheck }: { receipt: ReceiptView; onRecheck: () => void }) {
  const copy = STATUS_COPY[receipt.status]
  return (
    <div className="sol-receipt">
      <i className={copy.tone}>{receipt.status === 'confirmed' ? '✓' : receipt.status === 'failed' ? '×' : '…'}</i>
      <div>
        <strong>{formatSol(BigInt(receipt.lamports))} SOL · {copy.label}</strong>
        <small>
          <a href={explorerTx(receipt.signature)} target="_blank" rel="noopener noreferrer">{truncateAddress(receipt.signature, 6, 6)} ↗</a>
          {' · '}{new Date(receipt.createdAtMs).toLocaleString()}
        </small>
      </div>
      {receipt.status !== 'confirmed' && <button className="ghost" onClick={onRecheck}>Recheck</button>}
    </div>
  )
}

/* --------------------------------------------------------------- payouts */

function PayoutNotice() {
  const [reason, setReason] = useState<string | null>(null)
  useEffect(() => {
    void fetchPayoutStatus().then(
      status => setReason(status.reason),
      () => setReason(null),
    )
  }, [])

  return (
    <div className="sol-block sol-disabled-block">
      <div className="sol-block-head"><span>GOLD → TOKEN REWARDS</span><b className="sol-off">UNAVAILABLE</b></div>
      <button className="primary full" disabled aria-disabled="true">Convert gold to tokens — not available</button>
      <p className="sol-fine">
        {reason ??
          'Gold is counted by your browser, so it cannot authorise a payment out of a treasury. A real payout would need server-authoritative gameplay, a custodied treasury, idempotent reconciliation against on-chain confirmation, and legal review. No WALLY token mint exists.'}
      </p>
      <p className="sol-fine">This is deliberate and is not a configuration you can switch on. See the README for the full list of what would have to exist first.</p>
    </div>
  )
}

/* ----------------------------------------------------------------- shell */

export function WalletSolanaPanel() {
  const wallet = useWallet()
  const label = useMemo(() => fundsLabel(wallet.status === 'connected'), [wallet.status])

  return (
    <div className="sol-panel">
      <div className={`sol-banner funds-${label.mode}`} role={label.mode === 'live' ? 'alert' : undefined}>
        <strong>{label.short}</strong>
        <span>{label.long}</span>
      </div>

      {wallet.configError && (
        <p className="sol-error"><strong>Configuration problem.</strong> {wallet.configError}</p>
      )}

      {wallet.clusterCheck?.status === 'mismatch' && (
        <p className="sol-error">
          <strong>Cluster mismatch.</strong> The app is configured for {CLUSTER}, but the configured RPC endpoint reports
          genesis hash {wallet.clusterCheck.actual} instead of {wallet.clusterCheck.expected}. Balances and payments are
          not trustworthy until this is fixed.
        </p>
      )}
      {wallet.clusterCheck?.status === 'unreachable' && (
        <p className="sol-error"><strong>RPC unreachable.</strong> {wallet.clusterCheck.detail}</p>
      )}

      {wallet.phantom === 'checking' && <p className="sol-fine">Looking for Phantom…</p>}

      {wallet.phantom === 'missing' && (
        <div className="sol-block">
          <div className="sol-block-head"><span>WALLET</span><b className="sol-off">PHANTOM NOT FOUND</b></div>
          <p className="sol-fine">
            This build connects to Phantom only. Install the extension, then reload this page.
          </p>
          <a className="primary full" href={PHANTOM_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">Get Phantom ↗</a>
          <p className="sol-fine">
            Only ever install a wallet from its official site. Voxels will never ask you for a seed phrase or a
            private key — not here, and not anywhere else in the game.
          </p>
        </div>
      )}

      {wallet.phantom === 'ready' && wallet.status !== 'connected' && (
        <div className="sol-block">
          <div className="sol-block-head"><span>WALLET</span><b className="sol-off">NOT CONNECTED</b></div>
          <p className="sol-fine">
            Connecting shares your public address only. Your key stays in Phantom, and every signature is approved by
            you inside the extension.
          </p>
          <button className="primary full" onClick={() => void connect()} disabled={wallet.status === 'connecting' || !RPC.ok}>
            {wallet.status === 'connecting' ? 'Waiting for Phantom…' : 'Connect Phantom'}
          </button>
        </div>
      )}

      {wallet.status === 'connected' && wallet.address && (
        <div className="sol-block">
          <div className="sol-block-head"><span>WALLET</span><b className="sol-on">CONNECTED</b></div>
          <Row label="Address"><CopyableAddress address={wallet.address} label="wallet address" /></Row>
          <button className="ghost full" onClick={() => void disconnect()}>Disconnect</button>
        </div>
      )}

      {wallet.error && <p className="sol-error">{wallet.error}</p>}

      {wallet.status === 'connected' && <Balances />}
      <SignIn />
      <CharacterSave />
      <NpcPayment />
      <PayoutNotice />

      <p className="sol-fine sol-footer">
        Non-custodial: Voxels never holds, stores, transmits, or displays your private key or seed phrase, and no
        part of the game will ever ask for one. Phantom signs; this app only asks.
      </p>
    </div>
  )
}
