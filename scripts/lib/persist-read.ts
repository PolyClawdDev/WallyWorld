/*
 * Read phase of the restart test. A fresh process reading files another process
 * wrote and closed, which is what "survives a server restart" means.
 *
 * Reports what it finds rather than asserting, so the assertions live in one place
 * in `scripts/test-persistence.ts`.
 */
const [, , guestPrincipal, userId, wallet] = process.argv

const { readProfile } = await import('../../src/server/db')
const { resolveUserForPrincipal, walletOwner, walletsFor } = await import('../../src/server/identity/users')
const { goldSnapshot, provenanceBreakdown } = await import('../../src/server/money/gold')
const { conservationReport } = await import('../../src/server/money/ledger')
const { readJobForOwner, listJobsForOwner, listArtifactsForOwner } = await import('../../src/server/jobs/queue')
const { readWithdrawalForOwner, listWithdrawalsForOwner } = await import('../../src/server/treasury/withdrawals')
const { migrationReport, schemaVersions } = await import('../../src/server/store')

const snapshot = goldSnapshot(userId!)
const withdrawals = listWithdrawalsForOwner(userId!)
const report = conservationReport()

process.stdout.write(
  `${JSON.stringify({
    // Resolving each principal again must find the same account, not make a new one.
    byGuestKey: resolveUserForPrincipal(guestPrincipal!).userId,
    byGuestKeyCreated: resolveUserForPrincipal(guestPrincipal!).created,
    byWallet: resolveUserForPrincipal(wallet!).userId,
    byWalletCreated: resolveUserForPrincipal(wallet!).created,
    walletOwner: walletOwner(wallet!),
    walletCount: walletsFor(userId!).length,
    profile: readProfile(wallet!)?.profile ?? null,
    gold: {
      available: snapshot.available.toString(),
      reserved: snapshot.reserved.toString(),
      redeemable: snapshot.redeemable.toString(),
    },
    provenance: provenanceBreakdown(userId!),
    jobs: listJobsForOwner(userId!).length,
    jobRequest: listJobsForOwner(userId!)[0]?.request ?? null,
    strangerCanReadJob: readJobForOwner(listJobsForOwner(userId!)[0]?.jobId ?? '', 'usr_nobody') !== null,
    artifacts: listArtifactsForOwner(userId!).length,
    withdrawals: withdrawals.length,
    withdrawalState: withdrawals[0]?.state ?? null,
    withdrawalIsOwned: withdrawals[0] ? readWithdrawalForOwner(withdrawals[0].withdrawalId, userId!) !== null : false,
    withdrawalLeaksToStranger: withdrawals[0] ? readWithdrawalForOwner(withdrawals[0].withdrawalId, 'usr_nobody') !== null : false,
    conservation: { ok: report.ok, balanceSum: report.balanceSum.toString(), drifted: report.driftedAccounts.length },
    // Zero means the migration runner recognised the database as already current.
    migrationsApplied: migrationReport.core.length + migrationReport.finance.length,
    schema: schemaVersions(),
  })}\n`,
)
process.exit(0)
