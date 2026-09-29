/*
 * One service purchase, in its own process.
 *
 * `test-services.ts` spawns several of these at once against the same database
 * pair with the same idempotency key, which is the only way to get a genuine
 * race: a purchase is synchronous inside a process, so nothing there interleaves.
 * Each child prints one JSON line and exits.
 *
 * Arguments: <principal> <serviceId> <idempotencyKey> <label>
 */
const [principal, serviceId, idempotencyKey] = process.argv.slice(2)

const { resolveUserForPrincipal } = await import('../../src/server/identity/users')
const { ensureAccount } = await import('../../src/server/pvp/ids')
const { purchaseService } = await import('../../src/server/npc/orders')

const { userId } = resolveUserForPrincipal(principal)
const account = ensureAccount(principal)

const outcome = purchaseService({
  userId,
  playerId: account.player_id,
  displayName: account.display_name,
  serviceId,
  request: {},
  idempotencyKey,
})

if (outcome.ok) {
  process.stdout.write(`${JSON.stringify({
    status: outcome.replayed ? 'replayed' : 'delivered',
    orderId: outcome.order.orderId,
    sha: outcome.artifact.sha256,
    price: outcome.order.priceGold,
  })}\n`)
} else {
  process.stdout.write(`${JSON.stringify({ status: `refused:${outcome.code}`, reason: outcome.reason })}\n`)
}
process.exit(0)
