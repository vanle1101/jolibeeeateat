import IORedis from 'ioredis'

export function queueName() {
    return process.env.JOB_QUEUE_NAME?.trim() || 'rewards-account-runs'
}

function positiveInt(value, fallback) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function queueRuntimeConfig() {
    const backend = (process.env.QUEUE_BACKEND || 'sqlite').trim().toLowerCase()
    if (!['sqlite', 'redis'].includes(backend)) throw new Error('QUEUE_BACKEND must be sqlite or redis.')
    const logMode = (process.env.QUEUE_LOG_MODE || 'compact').trim().toLowerCase()
    if (!['compact', 'verbose', 'silent'].includes(logMode))
        throw new Error('QUEUE_LOG_MODE must be compact, verbose, or silent.')
    const concurrency = positiveInt(process.env.WORKER_CONCURRENCY, 3)
    const directConcurrency = positiveInt(process.env.DIRECT_ROUTE_CONCURRENCY, concurrency)
    return {
        backend,
        concurrency,
        directConcurrency: Math.min(directConcurrency, concurrency),
        // Each proxy/egress route gets one slot by default so accounts sharing
        // a proxy are serialized even when many worker lanes are available.
        proxyConcurrency: positiveInt(process.env.QUEUE_PROXY_CONCURRENCY, 1),
        pollIntervalMs: Math.max(100, positiveInt(process.env.QUEUE_POLL_INTERVAL_MS, 1000)),
        leaseTtlMs: Math.max(15000, positiveInt(process.env.PROXY_LEASE_TTL_MS, 120000)),
        leaseRetryMs: Math.max(1000, positiveInt(process.env.PROXY_LEASE_RETRY_MS, 15000)),
        maxAttempts: positiveInt(process.env.JOB_MAX_ATTEMPTS, 3),
        retryDelayMs: Math.max(1000, positiveInt(process.env.JOB_RETRY_DELAY_MS, 30000)),
        // Long account runs are expected, but several minutes without any
        // child output indicates a stuck browser/driver rather than safe pacing.
        idleTimeoutMs: Math.max(60000, positiveInt(process.env.JOB_IDLE_TIMEOUT_MS, 300000)),
        dryRun: ['1', 'true', 'yes', 'on'].includes((process.env.QUEUE_DRY_RUN || '').toLowerCase()),
        exitWhenIdle: ['1', 'true', 'yes', 'on'].includes((process.env.QUEUE_EXIT_WHEN_IDLE || '').toLowerCase()),
        skipSucceededToday: !['0', 'false', 'no', 'off'].includes(
            (process.env.QUEUE_SKIP_SUCCEEDED_TODAY || '').toLowerCase()
        ),
        logMode
    }
}

export function localDayStartUtc() {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    return start.toISOString().slice(0, 19).replace('T', ' ')
}

export function createRedisConnection({ worker = false } = {}) {
    const url = process.env.REDIS_URL?.trim() || 'redis://127.0.0.1:6379'
    return new IORedis(url, {
        maxRetriesPerRequest: worker ? null : 1,
        enableReadyCheck: true,
        lazyConnect: false
    })
}
