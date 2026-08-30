import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { importAccountBundle } from '../accounts/store.js'
import { parseLogLine } from '../api/logParser.js'
import { dispatchAvailableJobs } from './dispatcher.js'
import { createJobConsoleLogger, formatQueueLog, maskEmail } from './jobLogger.js'
import { JobStore } from './jobStore.js'
import { ProxyLease } from './proxyLease.js'
import { accountRunFailure, runAccountProcess } from './runAccount.js'

class FakeQueue {
    constructor() {
        this.jobs = new Map()
    }

    async getJob(id) {
        return this.jobs.get(id) || null
    }

    async add(name, data, opts) {
        const job = { id: opts.jobId, name, data, opts }
        this.jobs.set(job.id, job)
        return job
    }
}

class FakeRedis {
    constructor() {
        this.values = new Map()
    }

    async set(key, value) {
        if (this.values.has(key)) return null
        this.values.set(key, value)
        return 'OK'
    }

    async eval(script, _keyCount, key, token) {
        if (this.values.get(key) !== token) return 0
        if (script.includes("redis.call('DEL'")) this.values.delete(key)
        return 1
    }
}

test('account imports reject direct routes', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-direct-account-test-'))
    process.env.ACCOUNTS_DB_PATH = path.join(tempDir, 'accounts.db')
    process.env.ACCOUNTS_DB_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

    try {
        assert.throws(
            () =>
                importAccountBundle(process.cwd(), {
                    accounts: [{ email: 'direct@example.com', password: 'secret' }]
                }),
            /requires a proxy; direct account traffic is disabled/
        )
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true })
    }
})

test('direct accounts can use multiple worker lanes without changing proxy safety', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-direct-lanes-'))
    process.env.ACCOUNTS_DB_PATH = path.join(tempDir, 'accounts.db')
    process.env.ACCOUNTS_DB_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

    importAccountBundle(process.cwd(), {
        allowDirectAccounts: true,
        accounts: [
            { email: 'direct-one@example.com', password: 'secret-1', useProxy: false },
            { email: 'direct-two@example.com', password: 'secret-2', useProxy: false },
            { email: 'direct-three@example.com', password: 'secret-3', useProxy: false },
            { email: 'direct-four@example.com', password: 'secret-4', useProxy: false }
        ]
    })

    const store = new JobStore(process.cwd())
    try {
        const batch = store.createBatch({ proxyConcurrency: 1, directConcurrency: 3 })
        assert.equal(batch.routes, 1)
        assert.equal(batch.lockGroups, 3)

        const active = [
            store.claimNextSqliteJob('lane-1', 15000),
            store.claimNextSqliteJob('lane-2', 15000),
            store.claimNextSqliteJob('lane-3', 15000)
        ]
        assert.equal(active.every(Boolean), true)
        assert.equal(new Set(active.map(row => row.lock_key)).size, 3)
        assert.equal(store.claimNextSqliteJob('lane-4', 15000), null)
    } finally {
        store.close()
        fs.rmSync(tempDir, { recursive: true, force: true })
    }
})

test('scheduler serializes accounts sharing an egress IP and leases enforce ownership', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-queue-test-'))
    process.env.ACCOUNTS_DB_PATH = path.join(tempDir, 'accounts.db')
    process.env.ACCOUNTS_DB_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

    importAccountBundle(process.cwd(), {
        proxies: [
            {
                label: 'endpoint-a',
                url: '192.0.2.10',
                port: 8001,
                username: 'proxy-user',
                password: 'proxy-password',
                egressIp: '203.0.113.10'
            },
            {
                label: 'endpoint-b',
                url: '192.0.2.11',
                port: 8002,
                username: 'proxy-user',
                password: 'proxy-password',
                egressIp: '203.0.113.10'
            }
        ],
        accounts: [
            { email: 'one@example.com', password: 'secret-1', proxyLabel: 'endpoint-a' },
            { email: 'two@example.com', password: 'secret-2', proxyLabel: 'endpoint-b' }
        ]
    })

    const store = new JobStore(process.cwd())
    try {
        const fingerprintDefaults = store.db
            .prepare('SELECT save_fingerprint_mobile, save_fingerprint_desktop FROM accounts ORDER BY email')
            .all()
        assert.equal(
            fingerprintDefaults.every(
                row => Number(row.save_fingerprint_mobile) === 1 && Number(row.save_fingerprint_desktop) === 1
            ),
            true
        )

        const batch = store.createBatch()
        assert.equal(batch.jobs, 2)
        assert.equal(batch.lockGroups, 1)

        const queue = new FakeQueue()
        const firstDispatch = await dispatchAvailableJobs(queue, store)
        assert.equal(firstDispatch.dispatched, 1)

        const first = store.listQueued()[0]
        const attempt = store.startAttempt(first.id, 'test-worker')
        store.finishSuccess(first.id, attempt.attemptId, { ok: true }, 'test.log')

        const secondDispatch = await dispatchAvailableJobs(queue, store, { reconcile: false })
        assert.equal(secondDispatch.dispatched, 1)
        assert.equal(store.listQueued().length, 1)

        const redis = new FakeRedis()
        const owner = new ProxyLease(redis, first.lock_key, 15000)
        const contender = new ProxyLease(redis, first.lock_key, 15000)
        assert.equal(await owner.acquire(), true)
        assert.equal(await contender.acquire(), false)
        assert.equal(await owner.release(), true)
        assert.equal(await contender.acquire(), true)
        await contender.release()

        assert.equal(store.prepareSqliteBackend(), 1)
        const localJob = store.claimNextSqliteJob('sqlite-test-worker', 15000)
        assert.ok(localJob)
        assert.equal(store.claimNextSqliteJob('sqlite-test-worker-2', 15000), null)
        assert.equal(store.refreshSqliteLease(localJob.lock_key, 'wrong-token', 15000), false)
        assert.equal(store.refreshSqliteLease(localJob.lock_key, localJob.leaseToken, 15000), true)
        store.finishSuccess(localJob.id, localJob.attemptId, { ok: true }, 'sqlite-test.log')
        assert.equal(store.releaseSqliteLease(localJob.lock_key, localJob.leaseToken), true)
        assert.equal(store.activeJobCount(), 0)

        store.createBatch({ maxAttempts: 3 })
        const abandoned = store.claimNextSqliteJob('crashed-worker', 15000)
        store.setJobProcessPid(abandoned.id, process.pid)
        store.db.prepare('UPDATE queue_leases SET expires_at = 0 WHERE owner_token = ?').run(abandoned.leaseToken)
        assert.equal(store.claimNextSqliteJob('blocked-recovery-worker', 15000), null)
        const recoveredLiveLease = store.db
            .prepare('SELECT owner_token, expires_at FROM queue_leases WHERE job_id = ?')
            .get(abandoned.id)
        assert.equal(recoveredLiveLease.owner_token, abandoned.leaseToken)
        assert.ok(Number(recoveredLiveLease.expires_at) > Date.now())
        assert.equal(store.refreshSqliteLease(abandoned.lock_key, abandoned.leaseToken, 15000), true)

        store.db.prepare('UPDATE account_jobs SET process_pid = NULL WHERE id = ?').run(abandoned.id)
        store.db.prepare('UPDATE queue_leases SET expires_at = 0 WHERE job_id = ?').run(abandoned.id)
        const recovered = store.claimNextSqliteJob('recovery-worker', 15000)
        assert.equal(recovered.id, abandoned.id)
        assert.equal(recovered.attempts, 2)
        const oldAttempt = store.db
            .prepare('SELECT status FROM job_attempts WHERE job_id = ? AND attempt_number = 1')
            .get(abandoned.id)
        assert.equal(oldAttempt.status, 'abandoned')
        store.finishSuccess(recovered.id, recovered.attemptId, { recovered: true }, 'recovered.log')
        store.releaseSqliteLease(recovered.lock_key, recovered.leaseToken)
    } finally {
        store.close()
        fs.rmSync(tempDir, { recursive: true, force: true })
    }
})

test('three lanes claim three different proxy locks and serialize a fourth account', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-three-lanes-'))
    process.env.ACCOUNTS_DB_PATH = path.join(tempDir, 'accounts.db')
    process.env.ACCOUNTS_DB_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

    importAccountBundle(process.cwd(), {
        proxies: [
            { label: 'proxy-a', url: '192.0.2.21', port: 8101 },
            { label: 'proxy-b', url: '192.0.2.22', port: 8102 },
            { label: 'proxy-c', url: '192.0.2.23', port: 8103 }
        ],
        accounts: [
            { email: 'a-one@example.com', password: 'secret-1', proxyLabel: 'proxy-a' },
            { email: 'a-two@example.com', password: 'secret-2', proxyLabel: 'proxy-a' },
            { email: 'b-one@example.com', password: 'secret-3', proxyLabel: 'proxy-b' },
            { email: 'c-one@example.com', password: 'secret-4', proxyLabel: 'proxy-c' }
        ]
    })

    const store = new JobStore(process.cwd())
    try {
        store.createBatch()
        const active = [
            store.claimNextSqliteJob('lane-1', 15000),
            store.claimNextSqliteJob('lane-2', 15000),
            store.claimNextSqliteJob('lane-3', 15000)
        ]
        assert.equal(active.every(Boolean), true)
        assert.equal(new Set(active.map(row => row.lock_key)).size, 3)
        assert.equal(store.claimNextSqliteJob('lane-4', 15000), null)

        const proxyA = active.find(row => row.proxy_label === 'proxy-a')
        store.finishSuccess(proxyA.id, proxyA.attemptId, { ok: true }, 'proxy-a.log')
        store.releaseSqliteLease(proxyA.lock_key, proxyA.leaseToken)

        const nextProxyA = store.claimNextSqliteJob('lane-1', 15000)
        assert.ok(nextProxyA)
        assert.equal(nextProxyA.proxy_label, 'proxy-a')
        assert.equal(nextProxyA.lock_key, proxyA.lock_key)
    } finally {
        store.close()
        fs.rmSync(tempDir, { recursive: true, force: true })
    }
})

test('throughput mode keeps three lanes busy and prefers distinct proxy routes first', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-throughput-lanes-'))
    process.env.ACCOUNTS_DB_PATH = path.join(tempDir, 'accounts.db')
    process.env.ACCOUNTS_DB_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

    importAccountBundle(process.cwd(), {
        proxies: [
            { label: 'proxy-a', url: '192.0.2.31', port: 8201 },
            { label: 'proxy-b', url: '192.0.2.32', port: 8202 }
        ],
        accounts: [
            { email: 'a-one@example.com', password: 'secret-1', proxyLabel: 'proxy-a' },
            { email: 'a-two@example.com', password: 'secret-2', proxyLabel: 'proxy-a' },
            { email: 'a-three@example.com', password: 'secret-3', proxyLabel: 'proxy-a' },
            { email: 'b-one@example.com', password: 'secret-4', proxyLabel: 'proxy-b' }
        ]
    })

    const store = new JobStore(process.cwd())
    try {
        const batch = store.createBatch({ proxyConcurrency: 3 })
        assert.equal(batch.routes, 2)
        assert.equal(batch.lockGroups, 4)

        const active = [
            store.claimNextSqliteJob('lane-1', 15000),
            store.claimNextSqliteJob('lane-2', 15000),
            store.claimNextSqliteJob('lane-3', 15000)
        ]
        assert.equal(active.every(Boolean), true)
        assert.equal(new Set(active.map(row => row.lock_key)).size, 3)
        assert.equal(new Set(active.slice(0, 2).map(row => row.route_key)).size, 2)
    } finally {
        store.close()
        fs.rmSync(tempDir, { recursive: true, force: true })
    }
})

test('daily scheduling skips only validated successes and keeps failed accounts eligible', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-daily-skip-'))
    process.env.ACCOUNTS_DB_PATH = path.join(tempDir, 'accounts.db')
    process.env.ACCOUNTS_DB_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

    importAccountBundle(process.cwd(), {
        proxies: [{ label: 'proxy-a', url: '192.0.2.41', port: 8301 }],
        accounts: [
            { email: 'success@example.com', password: 'secret-1', proxyLabel: 'proxy-a' },
            { email: 'failed@example.com', password: 'secret-2', proxyLabel: 'proxy-a' }
        ]
    })

    const store = new JobStore(process.cwd())
    try {
        store.createBatch()
        const success = store.claimNextSqliteJob('lane-1', 15000)
        store.finishSuccess(
            success.id,
            success.attemptId,
            { run: { accounts: [{ success: true, collectedPoints: 0 }] } },
            'success.log'
        )
        store.releaseSqliteLease(success.lock_key, success.leaseToken)

        const failed = store.claimNextSqliteJob('lane-1', 15000)
        store.finishSqliteFailure(failed.id, failed.attemptId, new Error('Flow failed'), false, 'failed.log', 0)
        store.releaseSqliteLease(failed.lock_key, failed.leaseToken)

        const next = store.createBatch({ skipSucceededSince: '2000-01-01 00:00:00' })
        assert.equal(next.jobs, 1)
        assert.equal(next.skippedSucceeded, 1)
        const queued = store.claimNextSqliteJob('lane-1', 15000)
        assert.equal(queued.email, 'failed@example.com')
    } finally {
        store.close()
        fs.rmSync(tempDir, { recursive: true, force: true })
    }
})

test('local runs are transient while daily success state survives cleanup', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-transient-local-run-'))
    process.env.ACCOUNTS_DB_PATH = path.join(tempDir, 'accounts.db')
    process.env.ACCOUNTS_DB_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

    importAccountBundle(process.cwd(), {
        proxies: [{ label: 'proxy-a', url: '192.0.2.51', port: 8401 }],
        accounts: [{ email: 'success@example.com', password: 'secret-1', proxyLabel: 'proxy-a' }]
    })

    const store = new JobStore(process.cwd())
    try {
        const batch = store.createBatch({ source: 'local-run', ownerPid: process.pid })
        assert.throws(() => store.discardLocalRunBatches(), /still owned by live process/)

        const job = store.claimNextSqliteJob('lane-1', 15000)
        store.finishSuccess(
            job.id,
            job.attemptId,
            { run: { accounts: [{ success: true, collectedPoints: 0 }] } },
            'success.log'
        )
        store.releaseSqliteLease(job.lock_key, job.leaseToken)

        const discarded = store.discardLocalRunBatches({ batchId: batch.batchId, ownerPid: process.pid })
        assert.deepEqual(discarded, { batches: 1, jobs: 1 })
        assert.equal(store.getBatch(batch.batchId), undefined)

        const next = store.createBatch({ skipSucceededSince: '2000-01-01 00:00:00' })
        assert.equal(next.jobs, 0)
        assert.equal(next.skippedSucceeded, 1)
    } finally {
        store.close()
        fs.rmSync(tempDir, { recursive: true, force: true })
    }
})

test('account result validation retries flow errors but accepts a valid zero-point completion', () => {
    assert.match(
        accountRunFailure({ finished: true, accounts: [{ success: false, error: 'Login failed' }] }),
        /Login failed/
    )
    assert.match(accountRunFailure({ finished: true, accounts: [] }), /Expected one account result/)
    assert.equal(accountRunFailure({ finished: true, accounts: [{ success: true, collectedPoints: 0 }] }), null)
})

test('multi-lane logger keeps context on every line and supports compact filtering', () => {
    assert.equal(maskEmail('account@example.com'), 'ac*****@example.com')

    const formatted = formatQueueLog({
        timestamp: '2026-07-18T07:00:00.000Z',
        level: 'info',
        lane: 3,
        proxy: 'proxy-c',
        account: 'account@example.com',
        jobId: '12345678-abcd',
        event: 'JOB-START',
        message: 'Started'
    })
    assert.match(formatted, /\[T03\] \[proxy:proxy-c\] \[ac\*{5}@example\.com\] \[job:12345678\]/)

    const records = []
    const logger = createJobConsoleLogger({
        row: { id: '12345678-abcd', email: 'account@example.com', proxy_label: 'proxy-c' },
        lane: 3,
        mode: 'compact',
        write: (_level, _line, record) => records.push(record)
    })
    logger.child({ level: 'debug', parsed: true, title: 'BROWSER-NOISE', message: 'hidden' })
    logger.child({ level: 'info', parsed: true, title: 'ACCOUNT-START', message: 'visible' })
    logger.child({ level: 'info', parsed: true, title: 'READ-TO-EARN', message: 'progress visible' })
    logger.child({ level: 'error', parsed: false, title: null, message: 'also visible' })
    assert.deepEqual(
        records.map(record => record.event),
        ['ACCOUNT-START', 'READ-TO-EARN', 'RAW']
    )
})

test('SQLite experimental warnings are debug noise instead of job errors', () => {
    const entry = parseLogLine(
        '(node:1234) ExperimentalWarning: SQLite is an experimental feature and might change at any time',
        'stderr'
    )
    assert.equal(entry.level, 'debug')
    assert.equal(entry.parsed, false)
})

test('account runner keeps raw and structured logs in separate per-job files', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-job-logs-'))
    const row = {
        id: 'job-log-test',
        batch_id: 'batch-log-test',
        account_id: 'account-log-test'
    }

    try {
        const execution = await runAccountProcess(tempDir, row, { dryRun: true })
        assert.equal(fs.existsSync(execution.logPath), true)
        assert.equal(fs.existsSync(execution.structuredLogPath), true)
        assert.match(fs.readFileSync(execution.logPath, 'utf8'), /\[dry-run\]/)

        const structured = fs
            .readFileSync(execution.structuredLogPath, 'utf8')
            .trim()
            .split(/\r?\n/)
            .map(line => JSON.parse(line))
        assert.equal(structured.length, 1)
        assert.equal(structured[0].type, 'dry-run')
        assert.equal(structured[0].jobId, row.id)
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true })
    }
})
