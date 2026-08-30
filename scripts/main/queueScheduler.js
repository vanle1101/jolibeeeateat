import { getDirname, getProjectRoot, loadEnvFile, log, parseArgs } from '../utils.js'
import { createAccountQueue, dispatchAvailableJobs } from '../queue/dispatcher.js'
import { JobStore } from '../queue/jobStore.js'
import { localDayStartUtc, queueRuntimeConfig } from '../queue/config.js'

const projectRoot = getProjectRoot(getDirname(import.meta.url))
loadEnvFile(projectRoot)
const args = parseArgs()
const store = new JobStore(projectRoot)
const config = queueRuntimeConfig()
let queueResources = null

try {
    const batch = store.createBatch({
        source: String(args.source || 'manual'),
        maxAttempts: config.maxAttempts,
        proxyConcurrency: config.proxyConcurrency,
        directConcurrency: config.directConcurrency,
        skipSucceededSince: config.skipSucceededToday ? localDayStartUtc() : null
    })
    log(
        'SUCCESS',
        `Batch ${batch.batchId} created with ${batch.jobs} jobs across ${batch.routes} route(s) and ${batch.lockGroups} concurrency slot(s); skippedToday=${batch.skippedSucceeded}.`
    )
    if (batch.jobs === 0) {
        log('INFO', 'No jobs dispatched because every eligible account already completed successfully today.')
        process.exitCode = 0
    } else if (config.backend === 'redis') {
        queueResources = createAccountQueue()
        const dispatch = await dispatchAvailableJobs(queueResources.queue, store)
        log('INFO', `Dispatched ${dispatch.dispatched} job(s); reconciled ${dispatch.reconciled} queued job(s).`)
    } else {
        log('INFO', 'Jobs are ready in the local SQLite queue. No Redis connection is required.')
    }
} finally {
    store.close()
    if (queueResources) {
        await queueResources.queue.close()
        await queueResources.connection.quit()
    }
}
