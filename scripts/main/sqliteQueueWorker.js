import os from 'node:os'

import { getDirname, getProjectRoot, loadEnvFile, log } from '../utils.js'
import { queueRuntimeConfig } from '../queue/config.js'
import { createJobConsoleLogger } from '../queue/jobLogger.js'
import { JobStore } from '../queue/jobStore.js'
import { runAccountProcess } from '../queue/runAccount.js'

const projectRoot = getProjectRoot(getDirname(import.meta.url))
loadEnvFile(projectRoot)

const config = queueRuntimeConfig()
const workerId = `${os.hostname()}:${process.pid}`
const store = new JobStore(projectRoot)
const concurrency = store.concurrencyCapacity(config.concurrency)
const activeControllers = new Map()
let shuttingDown = false

const reset = store.prepareSqliteBackend()
if (reset) log('INFO', `Returned ${reset} Redis-queued job(s) to the local SQLite queue.`)

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function processJob(row, lane) {
    const controller = new AbortController()
    activeControllers.set(row.id, controller)
    let leaseLost = false
    let leaseValidUntil = Date.now() + config.leaseTtlMs
    let logPath = null
    const jobLog = createJobConsoleLogger({ row, lane, mode: config.logMode })

    const heartbeat = setInterval(
        () => {
            try {
                if (store.refreshSqliteLease(row.lock_key, row.leaseToken, config.leaseTtlMs)) {
                    leaseValidUntil = Date.now() + config.leaseTtlMs
                    return
                }

                // A false result means ownership really changed; continuing
                // would risk two accounts sharing one proxy route.
                leaseLost = true
                controller.abort()
                return
            } catch (error) {
                // SQLite contention on one heartbeat is transient. Keep the
                // child alive while the last confirmed lease is still valid.
                if (Date.now() < leaseValidUntil) {
                    jobLog.emit(
                        'warn',
                        'LEASE-HEARTBEAT',
                        `Lease refresh delayed by SQLite: ${error instanceof Error ? error.message : String(error)}`
                    )
                    return
                }
            }
            leaseLost = true
            controller.abort()
        },
        Math.max(1000, Math.floor(config.leaseTtlMs / 3))
    )
    heartbeat.unref?.()

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
            onSpawn: pid => store.setJobProcessPid(row.id, pid),
            onLog: entry => jobLog.child(entry)
        })
        logPath = execution.logPath
        if (leaseLost) throw new Error('SQLite proxy lease was lost before the account result was committed.')
        store.finishSuccess(row.id, row.attemptId, execution.result, execution.logPath)
        jobLog.emit(
            'success',
            'JOB-END',
            `Completed in ${(Number(execution.result.durationMs || 0) / 1000).toFixed(1)}s; raw=${execution.logPath}; jsonl=${execution.structuredLogPath}.`
        )
    } catch (error) {
        logPath = error.logPath || logPath
        const willRetry = Number(row.attempts) < Number(row.max_attempts) && !leaseLost
        const retryDelay = Math.min(config.retryDelayMs * 2 ** Math.max(0, Number(row.attempts) - 1), 3600000)
        store.finishSqliteFailure(row.id, row.attemptId, error, willRetry, logPath, retryDelay)
        jobLog.emit('error', 'JOB-ERROR', `${error.message}${willRetry ? ' Retry queued.' : ''}`)
    } finally {
        clearInterval(heartbeat)
        activeControllers.delete(row.id)
        controller.abort()
        store.releaseSqliteLease(row.lock_key, row.leaseToken)
    }
}

async function runLane(lane) {
    while (!shuttingDown) {
        const row = store.claimNextSqliteJob(workerId, config.leaseTtlMs)
        if (row) {
            await processJob(row, lane)
            continue
        }
        if (config.exitWhenIdle && store.activeJobCount() === 0) {
            shuttingDown = true
            break
        }
        await sleep(config.pollIntervalMs)
    }
}

function requestShutdown(signal) {
    if (shuttingDown) return
    shuttingDown = true
    log('INFO', `${signal} received; stopping ${activeControllers.size} active account process(es).`)
    for (const controller of activeControllers.values()) controller.abort()
}

process.on('SIGINT', () => requestShutdown('SIGINT'))
process.on('SIGTERM', () => requestShutdown('SIGTERM'))

log(
    'SUCCESS',
    `SQLite queue worker ${workerId} ready | lanes=${concurrency} | maxLanes=${config.concurrency} | directSlots=${config.directConcurrency} | proxySlots=${config.proxyConcurrency} | logMode=${config.logMode} | dryRun=${config.dryRun} | exitWhenIdle=${config.exitWhenIdle}`
)

try {
    await Promise.all(Array.from({ length: concurrency }, (_, index) => runLane(index + 1)))
} finally {
    for (const controller of activeControllers.values()) controller.abort()
    store.close()
}
