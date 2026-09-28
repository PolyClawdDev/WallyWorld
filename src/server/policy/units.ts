/* ------------------------------------------------------------------ *
 * Integer base units.
 *
 * Every amount in a money path is a whole number of the asset's smallest
 * unit, carried as a bigint. There is no conversion to or from a float
 * anywhere in this directory, and no helper here accepts a `number` for an
 * amount — a `number` cannot hold 2^53 lamports or zatoshis exactly, so
 * taking one would make the loss of precision a matter of luck.
 *
 * Decimals are recorded on `AssetRef` for display only. Nothing divides by
 * them.
 * ------------------------------------------------------------------ */

/** Decimal integer, optionally signed, with no separators, exponent, or point. */
const DECIMAL_INTEGER = /^-?(0|[1-9][0-9]*)$/

export class BaseUnitError extends Error {}

/**
 * Parses a decimal string into a bigint, rejecting everything that is not
 * exactly an integer.
 *
 * `BigInt("0x10")` is 16 and `BigInt("1e3")` throws, which are two different
 * kinds of surprise; the regex removes both by refusing anything that is not
 * plain base-ten digits. `"1.0"` is rejected rather than truncated, because a
 * caller that produced a decimal point was working in display units and
 * silently flooring their number is how a fee becomes zero.
 */
export function baseUnits(value: string): bigint {
  if (typeof value !== 'string' || !DECIMAL_INTEGER.test(value)) {
    throw new BaseUnitError(`not an integer base-unit string: ${JSON.stringify(value)}`)
  }
  return BigInt(value)
}

/** Same, but rejects negatives as well. Amounts of money are never negative here. */
export function positiveBaseUnits(value: string): bigint {
  const parsed = baseUnits(value)
  if (parsed < 0n) throw new BaseUnitError(`base units must not be negative: ${value}`)
  return parsed
}

/** Reads an untyped value (a JSON body, a provider response) as base units. */
export function readBaseUnits(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new BaseUnitError(`${field} must not be negative`)
    return value
  }
  if (typeof value === 'string') return positiveBaseUnits(value)
  // A number is refused even when it looks safe: accepting it here is what
  // eventually lets a float in, and every provider on this route quotes
  // amounts as strings precisely so that never has to happen.
  throw new BaseUnitError(`${field} must be a decimal integer string, got ${typeof value}`)
}

/** Sum with no intermediate float. Kept as a named helper so fee maths reads as a total. */
export const sumBaseUnits = (...values: readonly bigint[]): bigint =>
  values.reduce((total, value) => total + value, 0n)

/**
 * Basis points applied to an integer, rounding *down*.
 *
 * Rounding down is deliberate on both sides of the route: applied to a
 * minimum output it never invents value the user did not receive, and applied
 * to a fee ceiling it never quietly raises the ceiling.
 */
export function applyBps(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new BaseUnitError(`basis points must be an integer in 0..10000, got ${bps}`)
  }
  return (amount * BigInt(bps)) / 10_000n
}

/** Formats for display only. Never fed back into a money path. */
export function formatBaseUnits(amount: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new BaseUnitError(`decimals out of range: ${decimals}`)
  }
  const negative = amount < 0n
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = decimals === 0 ? '' : `.${digits.slice(digits.length - decimals)}`
  return `${negative ? '-' : ''}${whole}${fraction}`
}
