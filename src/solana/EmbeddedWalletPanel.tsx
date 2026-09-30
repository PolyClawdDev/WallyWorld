/* ------------------------------------------------------------------ *
 * The embedded wallet, on screen.
 *
 * This is the only wallet in Voxels, and the only place in the app where
 * a secret key can appear on screen at all. It is kept in its own file
 * rather than inlined into `WalletPanel.tsx` — which is the frame around
 * it and touches no key of any kind — so that the reveal path stays short
 * enough to read in one sitting.
 *
 * Three rules this component follows:
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
import { fetchSolLamports } from './rpc'
import { formatSol } from './units'

/* ------------------------------------------------------------------ *
 * What this key is for, and the one clause that must never be softened:
 * a key in browser storage is readable by script on this page and by
 * anyone who can reach the machine. The panel shows the address and an
 * explorer link, so a player can fund it, so the ceiling has to be said.
 * ------------------------------------------------------------------ */
const STORAGE_WARNING =
  'This key signs your identity, and nothing else \u2014 the game never spends from it, so the address holds nothing unless you send funds to it yourself. It is kept in this browser\u2019s storage, which means anything that can run scripts on this page, and anyone with access to this computer and browser profile, can read it. So if you do fund it, keep it to small amounts: this is not a hardware wallet and not a place for savings.'

/* ------------------------------------------------------------------ *
 * Pixel glyphs.
 *
 * The pouch above draws its item icons as SVG rects, one per pixel, and
 * these blocks sit directly under it, so they are drawn the same way at
 * the same size. `Wallet.tsx` has its own copy of this renderer; it is
 * private to the pouch and stays that way, so this is a second small one
 * rather than a change to a file the pouch owns.
 * ------------------------------------------------------------------ */

const GLYPH_PALETTE: Record<string, string> = {
  K: '#d5a64b', // brass
  d: '#8a5a1e', // brass, in shadow
  B: '#ffd0be', // bone, for the hazard marks
  i: '#2a0e07', // ember ink, for a mark on an ember plate
}

const GLYPHS = {
  key: [
    '............',
    '....KKK.....',
    '...K...K....',
    '...K...K....',
    '...K...d....',
    '....KKd.....',
    '.....K......',
    '.....K......',
    '.....KK.....',
    '.....K......',
    '.....Kd.....',
    '............',
  ],
  coin: [
    '............',
    '....dddd....',
    '...dKKKKd...',
    '..dKKKKKKd..',
    '..dKKddKKd..',
    '..dKKddKKd..',
    '..dKKddKKd..',
    '..dKKKKKKd..',
    '...dKKKKd...',
    '....dddd....',
    '............',
    '............',
  ],
  skull: [
    '............',
    '...BBBBBB...',
    '..BBBBBBBB..',
    '..BBiBBiBB..',
    '..BBiBBiBB..',
    '..BBBBBBBB..',
    '...BBBBBB...',
    '...B.BB.B...',
    '...BBBBBB...',
    '............',
    '............',
    '............',
  ],
  /* The same mark inked dark, for when it sits on the ember plate itself. */
  skullInk: [
    '............',
    '...iiiiii...',
    '..iiiiiiii..',
    '..ii.ii.ii..',
    '..ii.ii.ii..',
    '..iiiiiiii..',
    '...iiiiii...',
    '...i.ii.i...',
    '...iiiiii...',
    '............',
    '............',
    '............',
  ],
} as const

export function PixelGlyph({ glyph }: { glyph: keyof typeof GLYPHS }) {
  const cells: React.ReactNode[] = []
  GLYPHS[glyph].forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const color = GLYPH_PALETTE[row[x]]
      if (color) cells.push(<rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={color} />)
    }
  })
  return (
    <svg className="pixel-icon sol-glyph" viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden="true">
      {cells}
    </svg>
  )
}

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
      <div className="sol-block-head">
        <span className="sol-buckle bad" aria-hidden="true" />
        <div>
          <strong className="sol-confirm-head">EXPORT SECRET KEY</strong>
          <small>{revealed ? 'the key itself is on screen' : 'the key itself, not your address'}</small>
        </div>
      </div>
      {!revealed ? (
        <>
          {/*
            * Three separate rules rather than one paragraph, because these are
            * things a player has to carry out of this dialog and act on later,
            * and the first two are the ones that get people robbed. They were
            * a clause each in the middle of prose before, which is how a key
            * ends up pasted into a chat window by an owner who read the text.
            */}
          <ul className="emb-rules">
            <li className="never">
              <i aria-hidden="true">!</i>
              <span>
                <strong>Nobody will ever ask you for this key.</strong>
                Not the Voxels developers, not support, not a moderator, not an admin, not a giveaway or an
                airdrop, not anyone offering to fix your account. Anyone who asks is trying to rob you, however
                convincing they sound and whoever they claim to be.
              </span>
            </li>
            <li className="never">
              <i aria-hidden="true">!</i>
              <span>
                <strong>Never paste it anywhere but a wallet you trust.</strong>
                Not into a chat, a direct message, an email, a support request, a bug report, a web form, or
                anything that offers to &ldquo;validate&rdquo; or &ldquo;verify&rdquo; it. Do not photograph it
                or screenshot it. Sending it once is giving the wallet away for good.
              </span>
            </li>
            <li>
              <i aria-hidden="true">!</i>
              <span>
                Anyone who sees it owns this wallet permanently and irreversibly — there is no way to change it,
                revoke it or get it back. Check that nobody can see your screen, and that you are not sharing or
                recording it.
              </span>
            </li>
            <li>
              <i aria-hidden="true">·</i>
              <span>
                There is no seed phrase for this wallet, because this key was generated at random rather than
                derived from one. Twelve words would not restore it, so none are shown.
              </span>
            </li>
          </ul>
          <div className="sol-note">
            <PixelGlyph glyph="key" />
            <p className="sol-fine">{STORAGE_WARNING}</p>
          </div>
          <div className="sol-actions">
            <button type="button" className="primary" onClick={() => setRevealed(exportEmbeddedSecret())}>
              I understand — show the key
            </button>
            <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          {/*
            * The revealed value is wrapped in its own hazard-banded frame so it
            * cannot be mistaken for an ordinary read-only field. It is still a
            * plain textarea: the player has to be able to select it with the
            * keyboard when the clipboard is blocked, and backing the key up is
            * the entire point of this dialog.
            */}
          <div className="emb-danger">
            <div className="emb-danger-head">
              <PixelGlyph glyph="skullInk" />
              <span>SECRET KEY ON SCREEN — THIS IS THE WHOLE WALLET</span>
            </div>
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
            <p className="sol-fine">
              <strong>It belongs in a password manager or on paper, and nowhere else.</strong> Not in a chat, a
              message, an email, a support ticket or a screenshot. Hide it as soon as you have it.
            </p>
          </div>
          <div className="sol-actions">
            <CopyButton value={format === 'base58' ? revealed.base58 : revealed.jsonArray} label="Copy to clipboard" />
            <button type="button" className="ghost danger" onClick={() => { setRevealed(null); onClose() }}>Hide and close</button>
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
    <div className="sol-confirm emb-import">
      <div className="sol-block-head">
        <span className="sol-buckle" aria-hidden="true" />
        <div>
          <strong className="sol-confirm-head">IMPORT A SECRET KEY</strong>
          <small>replaces the wallet this browser holds</small>
        </div>
      </div>
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
      <div className="sol-note">
        <PixelGlyph glyph="key" />
        <p className="sol-fine">{STORAGE_WARNING}</p>
      </div>
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

  /*
   * Read-only. `null` is "not known", never 0: an unreachable RPC and an empty
   * wallet are different facts, and showing the first as the second would tell
   * the player something false about their own money. Polled because a deposit
   * is made from outside this app entirely, so there is no event to hear.
   */
  const [lamports, setLamports] = useState<bigint | null>(null)
  const [reading, setReading] = useState(false)
  const address = wallet?.address ?? null

  useEffect(() => {
    if (!address) { setLamports(null); return }
    let cancelled = false
    const read = async () => {
      setReading(true)
      try {
        const next = await fetchSolLamports(address)
        if (!cancelled) setLamports(next)
      } catch {
        // Leaves any balance already shown in place rather than blanking it.
      } finally {
        if (!cancelled) setReading(false)
      }
    }
    void read()
    const timer = window.setInterval(() => { void read() }, 20_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [address])

  if (!wallet) return null

  return (
    <div className="sol-block">
      <div className="sol-block-head">
        <span className="sol-buckle" aria-hidden="true" />
        <div>
          <strong>THIS BROWSER&rsquo;S WALLET</strong>
          <small>the game cannot spend from it</small>
        </div>
        {/* The cluster plate stays brass on mainnet and cyan elsewhere: it
            names a network, and ember is kept for faults. */}
        <b className={IS_MAINNET ? 'sol-plate cluster' : 'sol-plate on'}>
          <i aria-hidden="true" />{CLUSTER.toUpperCase()}
        </b>
      </div>

      <div className="sol-row">
        <span>Address</span>
        <div>
          <code title={wallet.address}>{truncateAddress(wallet.address, 6, 6)}</code>
          <CopyButton value={wallet.address} label="Copy" />
          <a href={explorerAddress(wallet.address)} target="_blank" rel="noopener noreferrer">↗</a>
        </div>
      </div>

      {/*
        * This readout used to sit in the pouch, beside the gold, and that was a
        * mistake: the pouch is game inventory, so a real chain balance in it
        * read as something the game could spend. It cannot. This is the
        * player's own wallet and there is no transaction signer in this app.
        * Next to the address it states what it is.
        */}
      <div className="sol-row">
        <span>Balance</span>
        <div>
          <code>{lamports === null ? '—' : `${formatSol(lamports)} SOL`}</code>
          <small>{lamports === null
            ? (reading ? 'reading…' : 'could not read the chain')
            : 'yours, not the game\u2019s'}</small>
        </div>
      </div>

      <div className="sol-row">
        <span>Account</span>
        <div>
          {claim.phase === 'linked' ? <b className="sol-plate on"><i aria-hidden="true" />LINKED</b>
            : claim.phase === 'working' ? <b className="sol-plate"><i aria-hidden="true" />LINKING…</b>
            : claim.phase === 'conflict' ? <b className="sol-plate warn"><i aria-hidden="true" />NEEDS A DECISION</b>
            : claim.phase === 'failed' ? <b className="sol-plate warn"><i aria-hidden="true" />NOT LINKED</b>
            : <b className="sol-plate off"><i aria-hidden="true" />—</b>}
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

      {/* The same two facts as before, pressed into the leather like the
          pouch's own note rather than set as body copy. */}
      <div className="sol-note">
        <PixelGlyph glyph="key" />
        <p className="sol-fine">
          A real Solana keypair, generated in this browser and kept here, so it is the same wallet every time you come
          back. {wallet.imported ? 'It was imported from a key you pasted in.' : 'Nothing was sent to the server to make it — the server only ever saw the address and one signature.'}
        </p>
      </div>
      <div className="sol-note">
        <PixelGlyph glyph="skull" />
        <p className="sol-fine">{STORAGE_WARNING}</p>
      </div>

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
            <button type="button" className="ghost danger" onClick={() => setDialog('forget')}>Delete</button>
        </div>
      )}
    </div>
  )
}
