/* ------------------------------------------------------------------ *
 * Base-unit arithmetic.
 *
 * Every balance and amount in the Solana layer is an integer of base
 * units held in a bigint: lamports for SOL, raw token units for SPL
 * tokens. Nothing here ever produces or consumes a float, so 0.1 + 0.2
 * problems cannot reach a balance or an amount to be signed. Decimals
 * exist only to place a separator when rendering, and user-typed decimal
 * strings are parsed digit by digit rather than through parseFloat.
 * ------------------------------------------------------------------ */

export const SOL_DECIMALS = 9

/** 1 SOL in lamports, as an integer. Matches LAMPORTS_PER_SOL from web3.js. */
export const LAMPORTS_PER_SOL = 1_000_000_000n

/** Integer base units to a grouped display string. The only float-free→text step. */
export function formatBaseUnits(amount: bigint, decimals: number, maxFractionDigits = decimals): string {
  const negative = amount < 0n
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  let fraction = decimals ? digits.slice(digits.length - decimals) : ''
  if (maxFractionDigits < fraction.length) fraction = fraction.slice(0, maxFractionDigits)
  fraction = fraction.replace(/0+$/, '')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}${grouped}${fraction ? `.${fraction}` : ''}`
}

export const formatSol = (lamports: bigint, maxFractionDigits = 9) =>
  formatBaseUnits(lamports, SOL_DECIMALS, maxFractionDigits)

export type ParseResult = { ok: true; baseUnits: bigint } | { ok: false; reason: string }

/**
 * Parses a human-typed decimal amount into integer base units.
 *
 * Deliberately strict: digits, at most one separator, no exponent, no sign,
 * and no more fractional digits than the asset actually has. Rejecting is
 * always safer than rounding someone's transfer amount for them.
 */
export function parseAmountToBaseUnits(input: string, decimals: number): ParseResult {
  const trimmed = input.trim()
  if (!trimmed) return { ok: false, reason: 'Enter an amount.' }
  if (!/^\d*(\.\d*)?$/.test(trimmed)) return { ok: false, reason: 'Amounts may only contain digits and one decimal point.' }

  const [wholeRaw = '', fractionRaw = ''] = trimmed.split('.')
  if (!wholeRaw && !fractionRaw) return { ok: false, reason: 'Enter an amount.' }
  if (fractionRaw.length > decimals) {
    return { ok: false, reason: decimals === 0 ? 'This asset has no fractional units.' : `At most ${decimals} decimal places.` }
  }

  const padded = `${wholeRaw || '0'}${fractionRaw.padEnd(decimals, '0')}`
  const baseUnits = BigInt(padded)
  if (baseUnits <= 0n) return { ok: false, reason: 'Amount must be greater than zero.' }
  return { ok: true, baseUnits }
}
