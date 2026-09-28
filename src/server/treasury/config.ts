/* ------------------------------------------------------------------ *
 * Withdrawal configuration, and the precise reason it is absent.
 *
 * Five numbers decide what a withdrawal means, and none of them can be
 * guessed:
 *
 *   reward rate            how many lamports one gold is worth. There is no
 *                          market for game gold, so there is no rate to
 *                          look up and inventing one would be inventing an
 *                          exchange rate. This value is a business
 *                          decision, not a measurement.
 *   minimum withdrawal     below which a payout costs more in fees than it
 *                          delivers.
 *   per-player limit       the cap one account can take from the campaign.
 *   campaign budget        the total the operator has committed. Without
 *                          it, "reserve treasury funds" has nothing to
 *                          reserve against.
 *   fee reserve            lamports held back per payout for network fees,
 *                          so a payout cannot succeed and then fail to be
 *                          payable.
 *
 * None of them are set in this repository and none have defaults. The
 * quote endpoint therefore returns a `missing_configuration` state naming
 * each absent key and what it is for. That is a precise answer, not a
 * failure — and it is deliberately not a zero, because a rate of zero is
 * an exchange rate too.
 * ------------------------------------------------------------------ */

const env = (key: string): string => (process.env[key] ?? '').trim()

export type WithdrawalConfigKey =
  | 'WALLY_REWARD_RATE_LAMPORTS_PER_GOLD'
  | 'WALLY_WITHDRAWAL_MINIMUM_GOLD'
  | 'WALLY_WITHDRAWAL_PER_PLAYER_LIMIT_GOLD'
  | 'WALLY_CAMPAIGN_BUDGET_LAMPORTS'
  | 'WALLY_WITHDRAWAL_FEE_RESERVE_LAMPORTS'

export const WITHDRAWAL_CONFIG_KEYS: Record<WithdrawalConfigKey, string> = {
  WALLY_REWARD_RATE_LAMPORTS_PER_GOLD:
    'Lamports paid per redeemable gold. A business decision with no market price to read; this server will not invent one.',
  WALLY_WITHDRAWAL_MINIMUM_GOLD: 'Smallest withdrawal accepted, in gold base units.',
  WALLY_WITHDRAWAL_PER_PLAYER_LIMIT_GOLD: 'Most one account may withdraw in total, in gold base units.',
  WALLY_CAMPAIGN_BUDGET_LAMPORTS: 'Total lamports the operator has committed to rewards. Reservations are made against this.',
  WALLY_WITHDRAWAL_FEE_RESERVE_LAMPORTS: 'Lamports held back per payout to cover network fees.',
}

export type WithdrawalConfig = {
  rateLamportsPerGold: bigint
  minimumGold: bigint
  perPlayerLimitGold: bigint
  campaignBudgetLamports: bigint
  feeReserveLamports: bigint
  /** Identifies the configuration a quote was produced under. Stored on the row. */
  fingerprint: string
}

export type MissingConfig = { key: WithdrawalConfigKey; what: string }

export type ConfigOutcome =
  | { ok: true; config: WithdrawalConfig }
  | { ok: false; missing: MissingConfig[]; invalid: Array<{ key: WithdrawalConfigKey; reason: string }> }

function readPositiveInt(key: WithdrawalConfigKey): { present: false } | { present: true; ok: true; value: bigint } | { present: true; ok: false; reason: string } {
  const raw = env(key)
  if (!raw) return { present: false }
  if (!/^[1-9][0-9]{0,29}$/.test(raw)) {
    return { present: true, ok: false, reason: `${key} must be a whole number greater than zero, with no decimal point` }
  }
  return { present: true, ok: true, value: BigInt(raw) }
}

/**
 * Reads the configuration, or reports exactly what is missing.
 *
 * Note there is no partial success: a withdrawal quoted with four of the five
 * numbers would be a quote with a hole in it, so all five are required together.
 */
export function readWithdrawalConfig(): ConfigOutcome {
  const keys = Object.keys(WITHDRAWAL_CONFIG_KEYS) as WithdrawalConfigKey[]
  const missing: MissingConfig[] = []
  const invalid: Array<{ key: WithdrawalConfigKey; reason: string }> = []
  const values = new Map<WithdrawalConfigKey, bigint>()

  for (const key of keys) {
    const read = readPositiveInt(key)
    if (!read.present) missing.push({ key, what: WITHDRAWAL_CONFIG_KEYS[key] })
    else if (!read.ok) invalid.push({ key, reason: read.reason })
    else values.set(key, read.value)
  }

  if (missing.length || invalid.length) return { ok: false, missing, invalid }

  return {
    ok: true,
    config: withFingerprint({
      rateLamportsPerGold: values.get('WALLY_REWARD_RATE_LAMPORTS_PER_GOLD')!,
      minimumGold: values.get('WALLY_WITHDRAWAL_MINIMUM_GOLD')!,
      perPlayerLimitGold: values.get('WALLY_WITHDRAWAL_PER_PLAYER_LIMIT_GOLD')!,
      campaignBudgetLamports: values.get('WALLY_CAMPAIGN_BUDGET_LAMPORTS')!,
      feeReserveLamports: values.get('WALLY_WITHDRAWAL_FEE_RESERVE_LAMPORTS')!,
    }),
  }
}

/**
 * Stamps a configuration so a quote records which one produced it.
 *
 * A rate change must not silently revalue a quote that was already shown to a
 * player: the reservation step compares fingerprints and refuses if they differ.
 */
export function withFingerprint(config: Omit<WithdrawalConfig, 'fingerprint'>): WithdrawalConfig {
  const fingerprint = [
    config.rateLamportsPerGold,
    config.minimumGold,
    config.perPlayerLimitGold,
    config.campaignBudgetLamports,
    config.feeReserveLamports,
  ].join(':')
  return { ...config, fingerprint }
}

/**
 * There is no treasury key in this process and no code that could use one.
 *
 * This is not a configuration gap that setting a variable would close: the server
 * holds no signing capability of any kind, by design, and adding one is a custody
 * decision. `docs/integration-matrix.md` §9 is the citable reason.
 */
export const TREASURY_SIGNER = {
  available: false as const,
  reason:
    'No treasury signer exists in this process. It holds no private key and has no signing capability, so it cannot submit a payout. Adding one is a custody decision, not a configuration change.',
}
