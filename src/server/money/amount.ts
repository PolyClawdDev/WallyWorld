/* ------------------------------------------------------------------ *
 * Money as exact integers, end to end.
 *
 * Every amount in the financial database is TEXT holding a decimal
 * integer in base units, and every amount in memory is a bigint. There is
 * no Number in the middle and no place where a value could pick up a
 * rounding error, because there is no operation that could introduce
 * one: no division, no floats, no `parseFloat`, no `toFixed`.
 *
 * The one place a bigint becomes a Number is `toSafeNumber`, used only
 * where an existing wire format already carries a JS number (the PvP
 * protocol does). It throws rather than silently truncating if the value
 * would not survive the conversion.
 * ------------------------------------------------------------------ */

/** Canonical stored form: optional `-`, then digits with no leading zeros. */
const CANONICAL = /^-?(0|[1-9][0-9]{0,29})$/

export const ZERO = 0n

/** Parses a value that came out of the database. A non-canonical row is a bug, not input. */
export function fromStored(text: string): bigint {
  if (!CANONICAL.test(text)) throw new Error(`stored amount is not a canonical decimal integer: ${JSON.stringify(text)}`)
  return BigInt(text)
}

/** The canonical stored form of a bigint. `BigInt.toString()` is already canonical. */
export function toStored(value: bigint): string {
  const text = value.toString()
  if (!CANONICAL.test(text)) throw new Error(`amount out of storable range: ${text}`)
  return text
}

/**
 * Parses untrusted input.
 *
 * Accepts a decimal integer string or a JS number that is already an integer.
 * Rejects floats, exponent notation, whitespace padding, `+` signs, leading
 * zeros and anything non-finite — all of which are either a client bug or an
 * attempt to smuggle a rounding error into a money path.
 */
export function parseAmount(input: unknown, options: { min?: bigint; max?: bigint } = {}): bigint | null {
  let value: bigint
  if (typeof input === 'bigint') {
    value = input
  } else if (typeof input === 'number') {
    if (!Number.isSafeInteger(input)) return null
    value = BigInt(input)
  } else if (typeof input === 'string') {
    if (!CANONICAL.test(input)) return null
    value = BigInt(input)
  } else {
    return null
  }
  if (options.min !== undefined && value < options.min) return null
  if (options.max !== undefined && value > options.max) return null
  return value
}

export function sum(values: Iterable<bigint>): bigint {
  let total = 0n
  for (const value of values) total += value
  return total
}

export const minAmount = (a: bigint, b: bigint) => (a < b ? a : b)
export const maxAmount = (a: bigint, b: bigint) => (a > b ? a : b)

/**
 * Converts to a JS number for a wire format that predates this module.
 *
 * Throws above 2^53−1 rather than rounding. Gold is capped far below that, so in
 * practice this never fires; if it ever does, the correct fix is to widen the
 * protocol, not to let the value drift.
 */
export function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`amount ${value} cannot be represented as a JS number without loss`)
  }
  return Number(value)
}

/**
 * Multiplies a base-unit quantity by an integer rate.
 *
 * Integer-only by design. A fractional rate would have to be expressed as a
 * ratio and rounded, and the rounding direction is a policy decision that nobody
 * has made — so this refuses to make it silently.
 */
export function multiplyByIntegerRate(quantity: bigint, rate: bigint): bigint {
  return quantity * rate
}
