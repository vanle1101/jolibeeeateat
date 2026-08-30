import { getDirname, getProjectRoot, loadEnvFile, log } from '../utils.js'
import { localDayStartUtc, queueRuntimeConfig } from '../queue/config.js'
import { JobStore } from '../queue/jobStore.js'

const projectRoot = getProjectRoot(getDirname(import.meta.url))
loadEnvFile(projectRoot)
const config = queueRuntimeConfig()
if (config.backend !== 'sqlite')
    throw new Error('`queue:run` is for QUEUE_BACKEND=sqlite. Use separate Redis workers otherwise.')

function discardOwnedLocalRun(batchId) {
    const cleanupStore = new JobStore(projectRoot)
    try {
        return cleanupStore.discardLocalRunBatches({ batchId, ownerPid: process.pid })
    } finally {
        cleanupStore.close()
    }
}

const store = new JobStore(projectRoot)
let batch
try {
    const discarded = store.discardLocalRunBatches()
    if (discarded.batches) {
        log('INFO', `Discarded ${discarded.batches} stale local run(s) containing ${discarded.jobs} job(s).`)
    }
    const created = store.createBatch({
        source: 'local-run',
        ownerPid: process.pid,
        maxAttempts: config.maxAttempts,
        proxyConcurrency: config.proxyConcurrency,
        directConcurrency: config.directConcurrency,
        skipSucceededSince: config.skipSucceededToday ? localDayStartUtc() : null
    })
    batch = store.getBatch(created.batchId)
    log(
        'SUCCESS',
        `Batch ${created.batchId} created with ${created.jobs} jobs across ${created.routes} route(s) and ${created.lockGroups} concurrency slot(s); skippedToday=${created.skippedSucceeded}.`
    )
} finally {
    store.close()
}

if (Number(batch?.total_jobs || 0) === 0) {
    discardOwnedLocalRun(batch.id)
    log('SUCCESS', `No account needs to run; every eligible account already completed successfully today.`)
    process.exit(0)
}

process.env.QUEUE_EXIT_WHEN_IDLE = 'true'
await import('./sqliteQueueWorker.js')

const resultStore = new JobStore(projectRoot)
const result = resultStore.getBatch(batch.id)
resultStore.close()
const discarded = discardOwnedLocalRun(batch.id)
log(
    'INFO',
    `Local run finished with status ${result?.status || 'unknown'}; removed ${discarded.jobs} transient job record(s).`
)
if (!result || result.status === 'completed_with_errors') process.exitCode = 1
