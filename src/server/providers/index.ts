/* ------------------------------------------------------------------ *
 * Provider adapter layer.
 *
 * Every adapter here obeys the same two rules:
 *
 *   - **A missing credential is a value, not a lie and not an exception.**
 *     Adapters return `missingConfiguration([...variables], detail)` so the
 *     operator console can render the precise gap. Nothing returns a fabricated
 *     success, a stub transaction id, or a mocked confirmation.
 *   - **Anything that could sign or spend takes a `SpendPermit` first.** That is
 *     what makes the policy engine unavoidable rather than customary, including
 *     for the operations that are unimplemented — those check the permit and
 *     then refuse, so the check travels with the code if it ever gets built.
 * ------------------------------------------------------------------ */

export {
  PUBLIC_TESTNET_FACILITATOR,
  PaidServiceSession,
  SETTLEMENT_DEDUPE_TTL_MS,
  X402AssetError,
  X402_FACILITATOR_VARS,
  X402_PROVIDER_ID,
  X402_SDK,
  X402_SVM_SDK,
  assertSplAsset,
  buildPaymentRequired,
  defaultUsdcMint,
  probeX402,
  settlePayment,
  verifyPaymentPayload,
  type DeliveryState,
  type PaymentRequiredInput,
  type PaymentState,
  type SettlementEvidence,
  type SolanaClusterName,
  type VerifiedPayment,
} from './x402'

export {
  JUPITER_ORDER_URL,
  JUPITER_PROVIDER_ID,
  JUPITER_QUOTE_TTL_MS,
  JupiterExecutionUnavailable,
  USDC_MAINNET_MINT,
  WSOL_MINT,
  buildSwapTransaction,
  probeJupiter,
  quoteSolToUsdc,
  type JupiterQuote,
} from './jupiter'

export {
  ONECLICK_AUTH_VARS,
  ONECLICK_PROVIDER_ID,
  ONECLICK_SDK,
  OneClickDepositUnavailable,
  OneClickSafetyError,
  ZEC_DELIVERY_EVIDENCE,
  ZEC_DELIVERY_UNVERIFIABLE_BY_DESIGN,
  ZEC_DOCUMENTED_SUPPORT,
  ZEC_DOCUMENTED_SUPPORT_URL,
  ZEC_EXECUTOR,
  ZEC_NATIVE_ASSET_ID,
  classifyZecDelivery,
  configureOneClickAuth,
  discoverZecAsset,
  dryQuote,
  planZecPayout,
  prepareDeposit,
  probeOneClick,
  type DeliveryEvidenceItem,
  type DryQuoteInput,
  type DryQuoteResult,
  type ShieldedVerdict,
  type ZecAssetFinding,
  type ZecDeliveryAssessment,
  type ZecPayoutPlan,
} from './oneclick'

export {
  COURIER_CONFIG_KEYS,
  COURIER_ORIGIN_ASSET_ID,
  COURIER_SERVICE_ID,
  COURIER_SIGNER,
  COURIER_TRANSITIONS,
  PRIVACY_STATEMENT,
  acceptDestination,
  canTransition as canCourierTransition,
  describeQuote,
  formatSol,
  formatZec,
  fundDeposit,
  quoteCourierRun,
  recordIntent,
  type AcceptedDestination,
  type CourierConfigKey,
  type CourierIntent,
  type CourierQuote,
  type CourierQuoteInput,
  type CourierState,
  type DestinationRefusal,
  type FundDepositResult,
  type QuoteDescription,
} from './courier'

export {
  ZCASH_ADDRESS_PROVIDER_ID,
  ZCASH_ADDRESS_SDK,
  parseZcashAddress,
  probeZcashAddress,
  receiverForPolicy,
  selectShieldedReceiver,
  type KnownReceiver,
  type ParsedZcashAddress,
  type SelectedShieldedReceiver,
  type ZcashNetwork,
} from './zcashAddress'

export {
  CONFIRMATION_POLICY,
  NoZcashSignerError,
  SIGNER_STATUS,
  WALLET_BACKENDS,
  ZCASH_WALLET_PROVIDER_ID,
  probeZcashWallet,
  unavailableSigner,
  type BackendAssessment,
  type ShieldedSend,
  type ShieldingOperation,
  type SyncStatus,
  type TransparentReceipt,
  type ZcashCourierWallet,
  type ZcashPool,
} from './zcashWallet'

export {
  FUNDS_AT_RISK_FROM,
  ROUTE_STAGES,
  preflightRoute,
  renderPreflight,
  type PreflightInput,
  type PreflightOutcome,
  type RouteStage,
  type StageResult,
} from './preflight'

export { httpEvidence, parseJson, probe, type ProbeResponse } from './probe'

export {
  READINESS_STATES,
  deriveState,
  envPresent,
  isLiveVerified,
  missingConfiguration,
  missingVariables,
  providerFailure,
  type AdapterResult,
  type Capability,
  type ConfigEvidence,
  type DocEvidence,
  type Evidence,
  type ExecutionEvidence,
  type HttpEvidence,
  type IntegrationReport,
  type MissingConfiguration,
  type ProbeEnvironment,
  type ProviderFailure,
  type ReadinessState,
  type SdkEvidence,
} from './types'
