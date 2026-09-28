/* ------------------------------------------------------------------ *
 * Standalone durable-queue worker.  `npm run worker:queue`
 *
 * The normal deployment runs the queue inside the background worker in
 * `src/worker/`, alongside the session sweep and the database keepalive.
 * This entrypoint runs the queue and nothing else, which is what the test
 * suite drives and what an operator wants when they are watching one thing.
 *
 * Either way there is no signer in the process. §6 of the specification
 * requires the Zcash signer to be isolated from both the language model and
 * the general web server; the seam is here for when there is something to
 * isolate, and the honest statement today is that there is not.
 * ------------------------------------------------------------------ */

import { safeLog } from '../redact'
import { schemaVersions } from '../store'
import { handlerKinds } from './handlers'
import { runQueueLoop, workerId } from './runner'

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true
    safeLog(`[queue] ${signal} — finishing the current job. Leases expire on their own, so nothing is stranded.`)
  })
}

const versions = schemaVersions()
safeLog(`Voxels durable queue worker ${workerId()}`)
safeLog(`  schema         core v${versions.core} · finance v${versions.finance}`)
safeLog(`  handlers       ${handlerKinds().map(h => `${h.kind} (${h.retrySafety})`).join(', ')}`)
safeLog('  custody        none — this process holds no keys and cannot sign')

void runQueueLoop({ stop: () => stopping })
