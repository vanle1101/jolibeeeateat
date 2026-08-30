import os from 'node:os'
import { DelayedError, Worker } from 'bullmq'

import { getDirname, getProjectRoot, loadEnvFile, log } from '../utils.js'
import { createRedisConnection, queueName, queueRuntimeConfig } from '../queue/config.js'
import { createAccountQueue, dispatchAvailableJobs } from '../queue/dispatcher.js'
import { createJobConsoleLogger } from '../queue/jobLogger.js'
import { JobStore } from '../queue/jobStore.js'
import { ProxyLease } from '../queue/proxyLease.js'
import { runAccountProcess } from '../queue/runAccount.js'

const projectRoot = getProjectRoot(getDirname(import.meta.url))
loadEnvFile(projectRoot)

const config = queueRuntimeConfig()
const configuredQueueName = queueName()
const workerId = `${os.hostname()}:${process.pid}`
const store = new JobStore(projectRoot)
const concurrency = store.concurrencyCapacity(config.concurrency)
const workerConnection = createRedisConnection({ worker: true })
const leaseConnection = createRedisConnection()
const { queue, connection: queueConnection } = createAccountQueue()
const activeControllers = new Map()
const availableLanes = Array.from({ length: concurrency }, (_, index) => index + 1)

function acquireLane() {
    return availableLanes.shift() ?? '?'
}

function releaseLane(lane) {
    if (typeof lane !== 'number') return
    availableLanes.push(lane)
    availableLanes.sort((a, b) => a - b)
}

await dispatchAvailableJobs(queue, store)

const worker = new Worker(
    configuredQueueName,
    async (job, token) => {
        const row = store.getJob(job.data.jobId)
        if (!row) throw new Error(`Database job not found: ${job.data.jobId}`)
        if (row.account_id !== job.data.accountId || row.lock_key !== job.data.lockKey) {
            throw new Error(`Queue payload does not match database job ${row.id}.`)
        }

        const lease = new ProxyLease(leaseConnection, row.lock_key, config.leaseTtlMs)
        if (!(await lease.acquire())) {
            store.markLeaseWait(row.id, `Lease busy for ${row.lock_key}; retrying.`)
            await job.moveToDelayed(Date.now() + config.leaseRetryMs, token)
            throw new DelayedError()
        }

        const controller = new AbortController()
        activeControllers.set(row.id, controller)
        lease.startHeartbeat(() => controller.abort())
        const attempt = store.startAttempt(row.id, workerId)
        const lane = acquireLane()
        const jobLog = createJobConsoleLogger({ row, lane, mode: config.logMode })
        let logPath = null
        let leaseReleased = false

        jobLog.emit(
            'info',
            'JOB-START',
            `Account slot ${row.slot} started; proxy lease ${row.lock_key} is owned by this lane.`
        )
        try {
            const execution = await runAccountProcess(projectRoot, row, {
                signal: controller.signal,
                dryRun: config.dryRun,
                idleTimeoutMs: config.idleTimeoutMs,
                onLog: entry => jobLog.child(entry)
            })
            logPath = execution.logPath
            if (lease.lost) throw new Error('Proxy lease was lost before the account result was committed.')

            store.finishSuccess(row.id, attempt.attemptId, execution.result, execution.logPath)
            await lease.release()
            leaseReleased = true
            try {
                await dispatchAvailableJobs(queue, store, { reconcile: false })
            } catch (dispatchError) {
                log('ERROR', `Job completed but dispatching the next account failed: ${dispatchError.message}`)
            }
            jobLog.emit(
                'success',
                'JOB-END',
                `Completed in ${(Number(execution.result.durationMs || 0) / 1000).toFixed(1)}s; raw=${execution.logPath}; jsonl=${execution.structuredLogPath}.`
            )
            return execution.result
        } catch (error) {
            logPath = error.logPath || logPath
            const attempts = Number(job.opts.attempts || 1)
            const willRetry = job.attemptsMade + 1 < attempts && !lease.lost
            store.finishFailure(row.id, attempt.attemptId, error, willRetry, logPath)
            if (!willRetry) {
                await lease.release()
                leaseReleased = true
                try {
                    await dispatchAvailableJobs(queue, store, { reconcile: false })
                } catch (dispatchError) {
                    log(
                        'ERROR',
                        `Final job failure was saved but dispatching the next account failed: ${dispatchError.message}`
                    )
                }
            }
            jobLog.emit('error', 'JOB-ERROR', `${error.message}${willRetry ? ' Retry queued.' : ''}`)
            throw error
        } finally {
            activeControllers.delete(row.id)
            controller.abort()
            if (!leaseReleased) await lease.release()
            releaseLane(lane)
        }
    },
    {
        connection: workerConnection,
        concurrency,
        maxStalledCount: 1,
        stalledInterval: 30000
    }
)

worker.on('completed', job => log('INFO', `Queue job ${job.id} marked completed.`))
worker.on('failed', (job, error) => log('ERROR', `Queue job ${job?.id || '?'} failed: ${error.message}`))
worker.on('error', error => log('ERROR', `Worker error: ${error.message}`))

log(
    'SUCCESS',
    `Redis queue worker ${workerId} ready | queue=${configuredQueueName} | lanes=${concurrency} | maxLanes=${config.concurrency} | directSlots=${config.directConcurrency} | proxySlots=${config.proxyConcurrency} | logMode=${config.logMode} | dryRun=${config.dryRun}`
)

let shuttingDown = false
async function shutdown(signal) {
    if (shuttingDown) return
    shuttingDown = true
    log('INFO', `${signal} received; stopping ${activeControllers.size} active account process(es).`)
    for (const controller of activeControllers.values()) controller.abort()
    await worker.close(false)
    store.close()
    await queue.close()
    await Promise.allSettled([workerConnection.quit(), leaseConnection.quit(), queueConnection.quit()])
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
