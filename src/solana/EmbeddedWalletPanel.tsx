/* ------------------------------------------------------------------ *
 * The embedded wallet, on screen.
 *
 * Three rules this component follows, and they are why it is separate
 * from `WalletPanel.tsx`, which is the Phantom path and still holds no
 * key of any kind:
 *
 *   1. The secret key is rendered only after a deliberate click on a
 *      button whose label says what it does, and only from the value the
 *      export call returns. It is not in props, not in a parent's state,
 *      and it is dropped when the dialog closes.
 *   2. The security ceiling is stated where the player is, not buried in
 *      a README: at creation and again at export. Nothing here calls the
 *      wallet "secure" without saying what it is secure against.
 *   3. The cluster is on screen next to the address, every time, because
 *      "which network is this key on" is the question that decides
 *      whether a mistake costs nothing or costs money.
 * ------------------------------------------------------------------ */

import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { CLUSTER, IS_MAINNET, explorerAddress, truncateAddress } from './cluster'
import {
  embeddedWallet,
  embeddedWalletPersists,
  ensureEmbeddedWallet,
  exportEmbeddedSecret,
  forgetEmbeddedWallet,
  importEmbeddedSecret,
  subscribeEmbeddedWallet,
  type ExportedSecret,
} from './embeddedWallet'
import { claimAccountWithEmbeddedWallet, embeddedClaimState, subscribeEmbeddedClaim } from './embeddedIdentity'

/* ------------------------------------------------------------------ *
 * The one sentence that must never be softened.
 * ------------------------------------------------------------------ */
const STORAGE_WARNING =
  'This key is kept in this browser\u2019s storage. Anything that can run scripts on this page, and anyone with access to this computer and browser profile, can read it. That is fine for a game balance and small amounts. Do not keep savings here, and do not treat it as a hardware wallet.'

function useEmbedded() {
  return useSyncExternalStore(subscribeEmbeddedWallet, embeddedWallet, embeddedWallet)
}

function useClaim() {
  return useSyncExternalStore(subscribeEmbeddedClaim, embeddedClaimState, embeddedClaimState)
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setDone(true)
      window.setTimeout(() => setDone(false), 1600)
    } catch {
      setDone(false)
    }
  }
  return (
    <button type="button" className="ghost" onClick={() => void copy()}>
      {done ? 'Copied' : label}
    </button>
  )
}

/* ---------------------------------------------------------------- export */

function ExportDialog({ onClose }: { onClose: () => void }) {
  const [revealed, setRevealed] = useState<ExportedSecret | null>(null)
  const [format, setFormat] = useState<'base58' | 'json'>('base58')

  // Dropped as soon as the dialog goes away, so the value does not sit in a
  // retained React tree after the player has finished with it.
  useEffect(() => () => setRevealed(null), [])

  return (
    <div className="sol-confirm emb-export">
      <div className="sol-confirm-head">EXPORT SECRET KEY</div>
      {!revealed ? (
        <>
          <p className="sol-fine">
            This reveals the key itself, not your address. Anyone who sees it owns this wallet permanently and
            irreversibly — there is no way to change it, revoke it or get it back. Make sure nobody can see your
            screen, and never paste it into a chat, a form, a support ticket, or anything that offers to
            &ldquo;validate&rdquo; it.
          </p>
          <p className="sol-fine">
            There is no seed phrase for this wallet, because this key was generated at random rather than derived
            from one. Twelve words would not restore it, so none are shown.
          </p>
          <p className="sol-fine">{STORAGE_WARNING}</p>
          <div className="sol-actions">
            <button type="button" className="primary" onClick={() => setRevealed(exportEmbeddedSecret())}>
              I understand — show the key
            </button>
            <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <div className="sol-actions emb-format">
            <button type="button" className={format === 'base58' ? 'primary' : 'ghost'} onClick={() => setFormat('base58')}>
              Base58
            </button>
            <button type="button" className={format === 'json' ? 'primary' : 'ghost'} onClick={() => setFormat('json')}>
              JSON array
            </button>
          </div>
          <textarea className="emb-secret" readOnly rows={format === 'base58' ? 3 : 6} value={format === 'base58' ? revealed.base58 : revealed.jsonArray} spellCheck={false} />
          <p className="sol-fine">
            {format === 'base58'
              ? 'Base58 is what a wallet\u2019s \u201cimport private key\u201d field expects.'
              : 'The 64-byte array is what the Solana CLI reads from a keypair file.'}
            {' '}It is the key for <code>{revealed.address}</code> on {CLUSTER}.
          </p>
          <div className="sol-actions">
            <CopyButton value={format === 'base58' ? revealed.base58 : revealed.jsonArray} label="Copy to clipboard" />
            <button type="button" className="ghost" onClick={() => { setRevealed(null); onClose() }}>Hide and close</button>
          </div>
        </>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- import */

function ImportForm({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    const outcome = importEmbeddedSecret(text)
    if (!outcome.ok) {
      setError(outcome.reason)
      return
    }
    setText('')
    setError(null)
    void claimAccountWithEmbeddedWallet()
    onClose()
  }

  return (
    <div className="sol-confirm">
      <div className="sol-confirm-head">IMPORT A SECRET KEY</div>
      <p className="sol-fine">
        Paste a Solana secret key — base58, or the 64-number JSON array from a keypair file. It replaces the wallet
        this browser is using now, so export that one first if you still want it.
      </p>
      <textarea
        className="emb-secret"
        rows={3}
        value={text}
        spellCheck={false}
        placeholder="Base58 secret key, or [12, 34, ...]"
        onChange={event => { setText(event.target.value); setError(null) }}
      />
      {error && <p className="sol-error">{error}</p>}
      <div className="sol-actions">
        <button type="button" className="primary" onClick={submit} disabled={!text.trim()}>Import this key</button>
        <button type="button" className="ghost" onClick={() => { setText(''); onClose() }}>Cancel</button>
      </div>
      <p className="sol-fine">{STORAGE_WARNING}</p>
    </div>
  )
}

/* ----------------------------------------------------------------- panel */

type Dialog = 'none' | 'export' | 'import' | 'forget'

export function EmbeddedWalletBlock() {
  const wallet = useEmbedded()
  const claim = useClaim()
  const [dialog, setDialog] = useState<Dialog>('none')
  const [persists, setPersists] = useState(true)

  useEffect(() => {
    // Creating it here as well as at world entry means opening the pouch
    // before the world finishes loading still shows a real wallet.
    ensureEmbeddedWallet()
    setPersists(embeddedWalletPersists())
    void claimAccountWithEmbeddedWallet()
  }, [])

  const relink = useCallback(() => { void claimAccountWithEmbeddedWallet() }, [])

  if (!wallet) return null

  return (
    <div className="sol-block">
      <div className="sol-block-head">
        <span>THIS BROWSER&rsquo;S WALLET</span>
        <b className={IS_MAINNET ? 'sol-bad-text' : 'sol-on'}>{CLUSTER.toUpperCase()}</b>
      </div>

      {IS_MAINNET && (
        <p className="sol-error">
          <strong>Mainnet.</strong> This build is pointed at mainnet-beta, so an automatically generated key sitting in
          browser storage would be holding real value. Do not fund it. Move to a hardware wallet or Phantom for
          anything that matters.
        </p>
      )}

      <div className="sol-row">
        <span>Address</span>
        <div>
          <code title={wallet.address}>{truncateAddress(wallet.address, 6, 6)}</code>
          <CopyButton value={wallet.address} label="Copy" />
          <a href={explorerAddress(wallet.address)} target="_blank" rel="noopener noreferrer">↗</a>
        </div>
      </div>

      <div className="sol-row">
        <span>Account</span>
        <div>
          {claim.phase === 'linked' ? <b className="sol-on">LINKED</b>
            : claim.phase === 'working' ? <b>LINKING…</b>
            : claim.phase === 'conflict' ? <b className="sol-warn">NEEDS A DECISION</b>
            : claim.phase === 'failed' ? <b className="sol-warn">NOT LINKED</b>
            : <b className="sol-off">—</b>}
        </div>
      </div>

      {claim.phase === 'conflict' && (
        <p className="sol-error">
          <strong>This wallet already belongs to another Voxels account.</strong> {claim.detail} Nothing has been
          changed. Switching accounts or merging them is your call, not something this screen should guess.
        </p>
      )}
      {claim.phase === 'failed' && (
        <>
          <p className="sol-error">{claim.detail}</p>
          <button type="button" className="ghost full" onClick={relink}>Try linking again</button>
        </>
      )}

      {!persists && (
        <p className="sol-error">
          <strong>This browser is refusing storage.</strong> The wallet is real, but it exists only until you close
          the tab. Export it now if you want to keep it.
        </p>
      )}

      <p className="sol-fine">
        A real Solana keypair, generated in this browser and kept here, so it is the same wallet every time you come
        back. {wallet.imported ? 'It was imported from a key you pasted in.' : 'Nothing was sent to the server to make it — the server only ever saw the address and one signature.'}
      </p>
      <p className="sol-fine">{STORAGE_WARNING}</p>

      {dialog === 'export' && <ExportDialog onClose={() => setDialog('none')} />}
      {dialog === 'import' && <ImportForm onClose={() => setDialog('none')} />}
      {dialog === 'forget' && (
        <div className="sol-pending sol-bad">
          <strong>Delete this wallet from this browser?</strong>
          <p className="sol-fine">
            The key is gone for good unless you exported it first. Your character and your gold stay with the account
            on the server, but this address will no longer be yours on this machine.
          </p>
          <div className="sol-actions">
            <button type="button" className="primary" onClick={() => { forgetEmbeddedWallet(); ensureEmbeddedWallet(); void claimAccountWithEmbeddedWallet(); setDialog('none') }}>
              Delete and start a new one
            </button>
            <button type="button" className="ghost" onClick={() => setDialog('none')}>Keep it</button>
          </div>
        </div>
      )}

      {dialog === 'none' && (
        <div className="sol-actions">
          <button type="button" className="primary" onClick={() => setDialog('export')}>Export secret key</button>
          <button type="button" className="ghost" onClick={() => setDialog('import')}>Import a key</button>
          <button type="button" className="ghost" onClick={() => setDialog('forget')}>Delete</button>
        </div>
      )}
    </div>
  )
}
