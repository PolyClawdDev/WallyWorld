/* ------------------------------------------------------------------ *
 * Phantom provider detection and event plumbing.
 *
 * This module touches only Phantom's injected provider API. It can ask
 * Phantom to connect, to sign a UTF-8 message, and to sign and send a
 * transaction. It has no way to obtain a private key or seed phrase and
 * never asks for one: every signature is produced inside the extension,
 * by the user, and the key material never enters this page.
 *
 * Detection follows Phantom's documented path — `window.phantom.solana`,
 * falling back to a legacy `window.solana` that self-identifies as
 * Phantom. We deliberately do not pull in the Wallet Standard registry
 * packages: the brief is Phantom-only, and a second provider abstraction
 * that cannot be exercised in this environment would be untested code.
 * ------------------------------------------------------------------ */

export const PHANTOM_DOWNLOAD_URL = 'https://phantom.app/download'

/** Phantom returns a web3.js PublicKey, but we only ever need its base58 form. */
type ProviderPublicKey = { toBase58(): string } | null

export type PhantomEvent = 'connect' | 'disconnect' | 'accountChanged'

export type PhantomProvider = {
  isPhantom?: boolean
  publicKey: ProviderPublicKey
  isConnected?: boolean
  connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: ProviderPublicKey }>
  disconnect(): Promise<void>
  /** Signs opaque bytes. We only ever pass UTF-8 sign-in text, never transaction bytes. */
  signMessage(message: Uint8Array, encoding?: 'utf8'): Promise<{ signature: Uint8Array; publicKey: ProviderPublicKey }>
  signAndSendTransaction<T>(transaction: T, options?: { maxRetries?: number }): Promise<{ signature: string }>
  on(event: PhantomEvent, handler: (payload?: unknown) => void): void
  off?(event: PhantomEvent, handler: (payload?: unknown) => void): void
  removeListener?(event: PhantomEvent, handler: (payload?: unknown) => void): void
}

type PhantomWindow = Window & {
  phantom?: { solana?: PhantomProvider }
  solana?: PhantomProvider
}

export function getPhantom(): PhantomProvider | null {
  if (typeof window === 'undefined') return null
  const w = window as PhantomWindow
  const namespaced = w.phantom?.solana
  if (namespaced?.isPhantom) return namespaced
  // Older injection point. The isPhantom check matters: other wallets also
  // claim window.solana, and this build only supports Phantom.
  if (w.solana?.isPhantom) return w.solana
  return null
}

export const isPhantomInstalled = () => getPhantom() !== null

/**
 * Extensions normally inject before the app runs, but on a cold start the
 * script can land a tick later. Poll briefly rather than telling a user with
 * Phantom installed to go and install Phantom.
 */
export function waitForPhantom(timeoutMs = 3000): Promise<PhantomProvider | null> {
  const found = getPhantom()
  if (found) return Promise.resolve(found)
  return new Promise(resolve => {
    const started = Date.now()
    const timer = window.setInterval(() => {
      const provider = getPhantom()
      if (provider || Date.now() - started >= timeoutMs) {
        window.clearInterval(timer)
        resolve(provider)
      }
    }, 100)
  })
}

/** Subscribes to a provider event and returns an unsubscribe that works on either API shape. */
export function onPhantomEvent(provider: PhantomProvider, event: PhantomEvent, handler: (payload?: unknown) => void) {
  provider.on(event, handler)
  return () => {
    const remove = provider.off ?? provider.removeListener
    remove?.call(provider, event, handler)
  }
}

/** Phantom uses the EIP-1193 rejection code for "the user said no". */
export function isUserRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  if (code === 4001) return true
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && /user rejected|user denied|request rejected/i.test(message)
}

export function describeWalletError(error: unknown): string {
  if (isUserRejection(error)) return 'Cancelled in Phantom.'
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string') return error
  return 'Phantom returned an unrecognised error.'
}
