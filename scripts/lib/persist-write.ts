/*
 * Write phase of the restart test. Run as its own process by
 * `scripts/test-persistence.ts`, and exits so the database files are closed
 * before anything reads them back.
 *
 * Everything written here is something a player would expect to still be there
 * tomorrow: the account, the wallet link, the balance, the provenance of that
 * balance, a job, an artifact, a receipt and a live withdrawal reservation.
 */
import { createHash, randomBytes } from 'node:crypto'
import { ed25519 } from '@noble/curves/ed25519.js'
import bs58 from 'bs58'

const { buildSiwsMessage } = await import('../../src/shared/siws')
const { saveSession, writeProfile } = await import('../../src/server/db')
const { DEFAULT_PROFILE } = await import('../../src/shared/profile')
const { resolveUserForPrincipal, hashGuestKey } = await import('../../src/server/identity/users')
const { issueClaimChallenge, verifyClaim, LINK_STATEMENT } = await import('../../src/server/identity/claim')
const { grantStartingGold, creditGold, goldSnapshot } = await import('../../src/server/money/gold')
const { enqueueJob, saveArtifact } = await import('../../src/server/jobs/queue')
const { withFingerprint } = await import('../../src/server/treasury/config')
const { quoteWithdrawal, issueDestinationChallenge, confirmDestination, reserveWithdrawal, fundTestTreasury, DESTINATION_STATEMENT } =
  await import('../../src/server/treasury/withdrawals')
const { migrationReport, schemaVersions } = await import('../../src/server/store')

const guestKey = randomBytes(32).toString('hex')
const guestPrincipal = `gst_${hashGuestKey(guestKey).slice(0, 24)}`
const { userId } = resolveUserForPrincipal(guestPrincipal)

writeProfile(guestPrincipal, { ...DEFAULT_PROFILE, playerName: 'Ember', character: 'ORBIT' }, 'test')
grantStartingGold(userId)
creditGold({ userId, amount: 1_500n, provenance: 'hunt_verified', idemScope: 'kill', idemKey: 'restart-hunt', note: 'verified hunt' })
creditGold({ userId, amount: 700n, provenance: 'legacy_demo', idemScope: 'legacy', idemKey: 'restart-legacy', note: 'old demo balance' })

const secret = ed25519.utils.randomSecretKey()
const wallet = bs58.encode(ed25519.getPublicKey(secret))
const sign = (message: string) => bs58.encode(ed25519.sign(new TextEncoder().encode(message), secret))

const token = randomBytes(32).toString('base64url')
const sessionHash = createHash('sha256').update(token).digest('hex')
saveSession(sessionHash, guestPrincipal, Date.now(), Date.now() + 24 * 60 * 60 * 1000)

const challenge = issueClaimChallenge({
  userId, wallet, domain: 'voxels.test', uri: 'https://voxels.test', sessionHash,
})
const claimed = verifyClaim({
  userId,
  sessionHash,
  wallet,
  nonce: challenge.fields.nonce,
  signature: sign(buildSiwsMessage({ ...challenge.fields, statement: LINK_STATEMENT })),
})

const job = enqueueJob({
  ownerUserId: userId, kind: 'ledger.audit', retrySafety: 'safe_read', idempotencyKey: 'restart-job', request: { note: 'survives a restart' },
})
const artifactId = saveArtifact({
  ownerUserId: userId, jobId: job.job.job_id, kind: 'report', mediaType: 'application/json',
  byteLength: 64, sha256: 'b'.repeat(64), storageRef: 'file://reports/restart.json',
})

const CONFIG = withFingerprint({
  rateLamportsPerGold: 1_000n,
  minimumGold: 100n,
  perPlayerLimitGold: 5_000n,
  campaignBudgetLamports: 10_000_000n,
  feeReserveLamports: 5_000n,
})
fundTestTreasury(5_000_000n)
const quote = quoteWithdrawal({ userId, goldAmount: '1000', configOverride: CONFIG, idempotencyKey: 'restart-wd' })
let withdrawalId: string | null = null
if (quote.ok) {
  withdrawalId = quote.withdrawalId
  const destChallenge = issueDestinationChallenge({
    userId, withdrawalId, address: wallet, domain: 'voxels.test', uri: 'https://voxels.test', sessionHash,
  })
  if (destChallenge.ok) {
    confirmDestination({
      userId, sessionHash, withdrawalId, address: wallet,
      nonce: destChallenge.fields.nonce,
      signature: sign(buildSiwsMessage({ ...destChallenge.fields, statement: DESTINATION_STATEMENT })),
    })
    reserveWithdrawal({ userId, withdrawalId, configOverride: CONFIG })
  }
}

const snapshot = goldSnapshot(userId)
process.stdout.write(
  `${JSON.stringify({
    guestPrincipal,
    userId,
    wallet,
    sessionHash,
    jobId: job.job.job_id,
    artifactId,
    withdrawalId,
    linked: claimed.ok && claimed.kind === 'linked',
    gold: {
      available: snapshot.available.toString(),
      reserved: snapshot.reserved.toString(),
      redeemable: snapshot.redeemable.toString(),
    },
    configFingerprint: CONFIG.fingerprint,
    migrationsApplied: migrationReport.core.length + migrationReport.finance.length,
    schema: schemaVersions(),
  })}\n`,
)
process.exit(0)
