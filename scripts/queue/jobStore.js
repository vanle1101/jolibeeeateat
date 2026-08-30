import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import { ensureAccountsDatabase, resolveAccountsDbPath } from '../utils.js'

const ACTIVE_JOB_STATUSES = "'queued', 'running'"

export class JobStore {
    constructor(projectRoot) {
        this.dbPath = resolveAccountsDbPath(projectRoot)
        ensureAccountsDatabase(this.dbPath)
        this.db = new DatabaseSync(this.dbPath)
        this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;')
        this.ensureSchema()
    }

    ensureSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS job_batches (
                id TEXT PRIMARY KEY,
                source TEXT NOT NULL DEFAULT 'manual',
                owner_pid INTEGER,
                status TEXT NOT NULL DEFAULT 'running',
                total_jobs INTEGER NOT NULL DEFAULT 0,
                succeeded_jobs INTEGER NOT NULL DEFAULT 0,
                failed_jobs INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                finished_at TEXT
            );

            CREATE TABLE IF NOT EXISTS account_jobs (
                id TEXT PRIMARY KEY,
                batch_id TEXT NOT NULL REFERENCES job_batches(id) ON DELETE CASCADE,
                account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                proxy_id TEXT REFERENCES proxies(id) ON DELETE SET NULL,
                route_key TEXT NOT NULL,
                lock_key TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                queue_job_id TEXT NOT NULL UNIQUE,
                attempts INTEGER NOT NULL DEFAULT 0,
                max_attempts INTEGER NOT NULL DEFAULT 3,
                worker_id TEXT,
                process_pid INTEGER,
                error TEXT,
                result_json TEXT,
                log_path TEXT,
                available_at INTEGER NOT NULL DEFAULT 0,
                queued_at TEXT,
                started_at TEXT,
                finished_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS job_attempts (
                id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL REFERENCES account_jobs(id) ON DELETE CASCADE,
                attempt_number INTEGER NOT NULL,
                worker_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'running',
                error TEXT,
                started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                finished_at TEXT
            );

            CREATE TABLE IF NOT EXISTS queue_leases (
                lock_key TEXT PRIMARY KEY,
                owner_token TEXT NOT NULL UNIQUE,
                worker_id TEXT NOT NULL,
                job_id TEXT NOT NULL REFERENCES account_jobs(id) ON DELETE CASCADE,
                expires_at INTEGER NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS account_run_successes (
                account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
                finished_at TEXT NOT NULL,
                result_json TEXT,
                log_path TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_account_jobs_batch ON account_jobs(batch_id, status);
            CREATE INDEX IF NOT EXISTS idx_account_jobs_lock ON account_jobs(lock_key, status);
            CREATE INDEX IF NOT EXISTS idx_account_jobs_account ON account_jobs(account_id, created_at);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_account_jobs_one_active_lock
                ON account_jobs(lock_key) WHERE status IN (${ACTIVE_JOB_STATUSES});
            CREATE INDEX IF NOT EXISTS idx_job_attempts_job ON job_attempts(job_id, attempt_number);
            CREATE INDEX IF NOT EXISTS idx_queue_leases_expiry ON queue_leases(expires_at);
            CREATE INDEX IF NOT EXISTS idx_account_run_successes_finished
                ON account_run_successes(finished_at);
        `)

        const batchColumns = new Set(
            this.db
                .prepare('PRAGMA table_info(job_batches)')
                .all()
                .map(row => row.name)
        )
        if (!batchColumns.has('owner_pid')) {
            this.db.exec('ALTER TABLE job_batches ADD COLUMN owner_pid INTEGER')
        }

        const jobColumns = new Set(
            this.db
                .prepare('PRAGMA table_info(account_jobs)')
                .all()
                .map(row => row.name)
        )
        if (!jobColumns.has('available_at')) {
            this.db.exec('ALTER TABLE account_jobs ADD COLUMN available_at INTEGER NOT NULL DEFAULT 0')
        }
        if (!jobColumns.has('process_pid')) {
            this.db.exec('ALTER TABLE account_jobs ADD COLUMN process_pid INTEGER')
        }
        if (!jobColumns.has('route_key')) {
            this.db.exec('ALTER TABLE account_jobs ADD COLUMN route_key TEXT')
            this.db.exec('UPDATE account_jobs SET route_key = lock_key WHERE route_key IS NULL')
        }
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_account_jobs_route ON account_jobs(route_key, status)')
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_account_jobs_available ON account_jobs(status, available_at)')

        // Keep daily-success filtering independent from transient local batches.
        // This also migrates validated successes created by older versions.
        this.db.exec(`
            INSERT INTO account_run_successes (account_id, finished_at, result_json, log_path)
            SELECT j.account_id, j.finished_at, j.result_json, j.log_path
            FROM account_jobs j
            WHERE j.status = 'succeeded'
              AND j.finished_at IS NOT NULL
              AND json_extract(j.result_json, '$.run.accounts[0].success') = 1
              AND NOT EXISTS (
                  SELECT 1 FROM account_jobs newer
                  WHERE newer.account_id = j.account_id
                    AND newer.status = 'succeeded'
                    AND newer.finished_at IS NOT NULL
                    AND json_extract(newer.result_json, '$.run.accounts[0].success') = 1
                    AND (newer.finished_at > j.finished_at OR (newer.finished_at = j.finished_at AND newer.id > j.id))
              )
            ON CONFLICT(account_id) DO UPDATE SET
                finished_at = excluded.finished_at,
                result_json = excluded.result_json,
                log_path = excluded.log_path
            WHERE excluded.finished_at > account_run_successes.finished_at
        `)
    }

    discardLocalRunBatches({ batchId = null, ownerPid = null, now = Date.now() } = {}) {
        this.db.exec('BEGIN IMMEDIATE')
        try {
            const batches = this.db
                .prepare(
                    `
                    SELECT id, owner_pid FROM job_batches
                    WHERE source = 'local-run' AND (? IS NULL OR id = ?)
                `
                )
                .all(batchId, batchId)
            if (!batches.length) {
                this.db.exec('COMMIT')
                return { batches: 0, jobs: 0 }
            }

            const allowedOwnerPid = Number(ownerPid) || null
            const liveOwner = batches.find(
                row => Number(row.owner_pid) !== allowedOwnerPid && this.isProcessAlive(row.owner_pid)
            )
            if (liveOwner) {
                throw new Error(
                    `Local queue run ${liveOwner.id} is still owned by live process ${liveOwner.owner_pid}; stop it before starting another run.`
                )
            }

            const placeholders = batches.map(() => '?').join(', ')
            const batchIds = batches.map(row => row.id)
            const activeRows = this.db
                .prepare(
                    `
                    SELECT j.id, j.process_pid, lease.expires_at
                    FROM account_jobs j
                    LEFT JOIN queue_leases lease ON lease.job_id = j.id
                    WHERE j.batch_id IN (${placeholders})
                      AND j.status = 'running'
                `
                )
                .all(...batchIds)
            const liveJob = activeRows.find(
                row => Number(row.expires_at || 0) > now || this.isProcessAlive(row.process_pid)
            )
            if (liveJob) {
                throw new Error(
                    `Local queue job ${liveJob.id} is still running; stop its worker before discarding transient queue state.`
                )
            }

            const jobs = Number(
                this.db
                    .prepare(`SELECT COUNT(*) AS value FROM account_jobs WHERE batch_id IN (${placeholders})`)
                    .get(...batchIds).value
            )
            const result = this.db.prepare(`DELETE FROM job_batches WHERE id IN (${placeholders})`).run(...batchIds)
            this.db.exec('COMMIT')
            return { batches: Number(result.changes || 0), jobs }
        } catch (error) {
            this.db.exec('ROLLBACK')
            throw error
        }
    }

    prepareSqliteBackend() {
        this.db.exec('BEGIN IMMEDIATE')
        try {
            const reset = this.db
                .prepare(
                    `
                    UPDATE account_jobs SET status = 'pending', queued_at = NULL, updated_at = CURRENT_TIMESTAMP
                    WHERE status = 'queued'
                `
                )
                .run()
            this.db.exec('COMMIT')
            return Number(reset.changes || 0)
        } catch (error) {
            this.db.exec('ROLLBACK')
            throw error
        }
    }

    concurrencyCapacity(maxConcurrency = 1) {
        const requested = Math.max(1, Number(maxConcurrency) || 1)
        const row = this.db
            .prepare(
                `
                SELECT COUNT(*) AS value
                FROM accounts a
                LEFT JOIN proxies p ON p.id = a.proxy_id
                WHERE a.status IN ('ready', 'active')
                  AND (a.proxy_id IS NULL OR p.status = 'active')
                `
            )
            .get()

        return Math.min(requested, Math.max(1, Number(row?.value) || 0))
    }

    claimNextSqliteJob(workerId, leaseTtlMs) {
        const now = Date.now()
        this.db.exec('BEGIN IMMEDIATE')
        try {
            this.recoverExpiredSqliteLeases(now, leaseTtlMs)
            const row = this.db
                .prepare(
                    `
                    SELECT j.*, a.email, a.slot, p.label AS proxy_label
                    FROM account_jobs j
                    JOIN accounts a ON a.id = j.account_id
                    LEFT JOIN proxies p ON p.id = j.proxy_id
                    WHERE j.status = 'pending'
                      AND j.available_at <= ?
                      AND NOT EXISTS (
                          SELECT 1 FROM account_jobs active
                          WHERE active.lock_key = j.lock_key
                            AND active.status IN (${ACTIVE_JOB_STATUSES})
                      )
                      AND NOT EXISTS (
                          SELECT 1 FROM queue_leases lease
                          WHERE lease.lock_key = j.lock_key AND lease.expires_at > ?
                      )
                    ORDER BY (
                        SELECT COUNT(*) FROM account_jobs active_route
                        WHERE active_route.route_key = j.route_key
                          AND active_route.status IN (${ACTIVE_JOB_STATUSES})
                    ), j.created_at, COALESCE(a.slot, 2147483647), j.id
                    LIMIT 1
                `
                )
                .get(now, now)
            if (!row) {
                this.db.exec('COMMIT')
                return null
            }

            const leaseToken = crypto.randomUUID()
            const attemptId = crypto.randomUUID()
            const attemptNumber = Number(row.attempts) + 1
            this.db.prepare('DELETE FROM queue_leases WHERE lock_key = ? AND expires_at <= ?').run(row.lock_key, now)
            this.db
                .prepare(
                    `
                    INSERT INTO queue_leases (lock_key, owner_token, worker_id, job_id, expires_at)
                    VALUES (?, ?, ?, ?, ?)
                `
                )
                .run(row.lock_key, leaseToken, workerId, row.id, now + leaseTtlMs)
            this.db
                .prepare(
                    `
                    UPDATE account_jobs SET status = 'running', attempts = ?, worker_id = ?, error = NULL,
                        started_at = CURRENT_TIMESTAMP, finished_at = NULL, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ? AND status = 'pending'
                `
                )
                .run(attemptNumber, workerId, row.id)
            this.db
                .prepare(
                    `
                    INSERT INTO job_attempts (id, job_id, attempt_number, worker_id)
                    VALUES (?, ?, ?, ?)
                `
                )
                .run(attemptId, row.id, attemptNumber, workerId)
            this.db.exec('COMMIT')
            return { ...row, attempts: attemptNumber, attemptId, leaseToken }
        } catch (error) {
            this.db.exec('ROLLBACK')
            throw error
        }
    }

    recoverExpiredSqliteLeases(now = Date.now(), leaseTtlMs = 120000) {
        const stale = this.db
            .prepare(
                `
                SELECT j.id, j.batch_id, j.attempts, j.max_attempts, j.lock_key, j.process_pid
                FROM account_jobs j
                LEFT JOIN queue_leases lease ON lease.job_id = j.id AND lease.expires_at > ?
                WHERE j.status = 'running' AND lease.job_id IS NULL
            `
            )
            .all(now)
        const batches = new Set()
        for (const row of stale) {
            if (this.isProcessAlive(row.process_pid)) {
                const renewed = this.db
                    .prepare(
                        `
                        UPDATE queue_leases SET expires_at = ?, updated_at = CURRENT_TIMESTAMP
                        WHERE lock_key = ? AND job_id = ?
                    `
                    )
                    .run(now + leaseTtlMs, row.lock_key, row.id)

                // A live child may outlast its worker. Only create an orphan
                // owner when the original lease row is genuinely gone; never
                // replace the token of a healthy worker whose heartbeat was
                // briefly delayed.
                if (Number(renewed.changes || 0) === 0) {
                    this.db
                        .prepare(
                            `
                            INSERT INTO queue_leases (lock_key, owner_token, worker_id, job_id, expires_at)
                            VALUES (?, ?, 'orphan-process', ?, ?)
                        `
                        )
                        .run(row.lock_key, `orphan:${row.id}`, row.id, now + leaseTtlMs)
                }
                continue
            }
            const retry = Number(row.attempts) < Number(row.max_attempts)
            this.db
                .prepare(
                    `
                    UPDATE job_attempts SET status = 'abandoned', error = 'Worker lease expired',
                        finished_at = CURRENT_TIMESTAMP
                    WHERE job_id = ? AND status = 'running'
                `
                )
                .run(row.id)
            this.db
                .prepare(
                    `
                    UPDATE account_jobs SET status = ?, error = 'Worker lease expired', available_at = ?,
                        process_pid = NULL,
                        finished_at = CASE WHEN ? = 'failed' THEN CURRENT_TIMESTAMP ELSE NULL END,
                        updated_at = CURRENT_TIMESTAMP WHERE id = ?
                `
                )
                .run(retry ? 'pending' : 'failed', now, retry ? 'pending' : 'failed', row.id)
            this.db.prepare('DELETE FROM queue_leases WHERE job_id = ?').run(row.id)
            batches.add(row.batch_id)
        }
        this.db.prepare('DELETE FROM queue_leases WHERE expires_at <= ?').run(now)
        for (const batchId of batches) this.updateBatch(batchId)
        return stale.length
    }

    isProcessAlive(pid) {
        if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false
        try {
            process.kill(Number(pid), 0)
            return true
        } catch {
            return false
        }
    }

    setJobProcessPid(jobId, pid) {
        this.db
            .prepare(
                'UPDATE account_jobs SET process_pid = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?'
            )
            .run(Number(pid), jobId, 'running')
    }

    refreshSqliteLease(lockKey, leaseToken, leaseTtlMs) {
        const now = Date.now()
        const result = this.db
            .prepare(
                `
                UPDATE queue_leases SET expires_at = ?, updated_at = CURRENT_TIMESTAMP
                WHERE lock_key = ? AND owner_token = ?
            `
            )
            .run(now + leaseTtlMs, lockKey, leaseToken)
        return Number(result.changes || 0) === 1
    }

    releaseSqliteLease(lockKey, leaseToken) {
        const result = this.db
            .prepare('DELETE FROM queue_leases WHERE lock_key = ? AND owner_token = ?')
            .run(lockKey, leaseToken)
        return Number(result.changes || 0) === 1
    }

    finishSqliteFailure(jobId, attemptId, error, willRetry, logPath, retryDelayMs) {
        const message = String(error instanceof Error ? error.message : error).slice(0, 4000)
        const nextStatus = willRetry ? 'pending' : 'failed'
        const availableAt = willRetry ? Date.now() + retryDelayMs : 0
        this.db.exec('BEGIN IMMEDIATE')
        try {
            this.db
                .prepare(
                    "UPDATE job_attempts SET status = 'failed', error = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?"
                )
                .run(message, attemptId)
            this.db
                .prepare(
                    `
                    UPDATE account_jobs SET status = ?, error = ?, log_path = COALESCE(?, log_path), process_pid = NULL,
                        available_at = ?, finished_at = CASE WHEN ? = 'failed' THEN CURRENT_TIMESTAMP ELSE NULL END,
                        updated_at = CURRENT_TIMESTAMP WHERE id = ?
                `
                )
                .run(nextStatus, message, logPath, availableAt, nextStatus, jobId)
            const batchId = this.db.prepare('SELECT batch_id FROM account_jobs WHERE id = ?').get(jobId).batch_id
            this.updateBatch(batchId)
            this.db.exec('COMMIT')
        } catch (dbError) {
            this.db.exec('ROLLBACK')
            throw dbError
        }
    }

    activeJobCount() {
        return Number(
            this.db
                .prepare("SELECT COUNT(*) AS value FROM account_jobs WHERE status IN ('pending', 'queued', 'running')")
                .get().value
        )
    }

    activeBatch() {
        return this.db
            .prepare(
                `
                SELECT b.* FROM job_batches b
                WHERE EXISTS (
                    SELECT 1 FROM account_jobs j
                    WHERE j.batch_id = b.id AND j.status IN ('pending', 'queued', 'running')
                )
                ORDER BY b.created_at DESC LIMIT 1
            `
            )
            .get()
    }

    getBatch(batchId) {
        return this.db.prepare('SELECT * FROM job_batches WHERE id = ?').get(batchId)
    }

    createBatch({
        source = 'manual',
        ownerPid = null,
        maxAttempts = 3,
        proxyConcurrency = 1,
        directConcurrency = proxyConcurrency,
        skipSucceededSince = null
    } = {}) {
        this.db.exec('BEGIN IMMEDIATE')
        try {
            const active = Number(
                this.db
                    .prepare(
                        "SELECT COUNT(*) AS value FROM account_jobs WHERE status IN ('pending', 'queued', 'running')"
                    )
                    .get().value
            )
            if (active > 0) {
                throw new Error(`Cannot create a new batch while ${active} job(s) are still active.`)
            }

            const eligibleCount = Number(
                this.db
                    .prepare(
                        `
                        SELECT COUNT(*) AS value
                        FROM accounts a
                        LEFT JOIN proxies p ON p.id = a.proxy_id
                        WHERE a.status IN ('ready', 'active')
                          AND (
                              (a.use_proxy = 0 AND a.proxy_id IS NULL)
                              OR (a.use_proxy = 1 AND a.proxy_id IS NOT NULL AND p.status = 'active')
                          )
                    `
                    )
                    .get().value
            )
            if (!eligibleCount) throw new Error('No active accounts are available for scheduling.')

            const accountRows = this.db
                .prepare(
                    `
                    SELECT a.id AS account_id, a.proxy_id, a.slot, a.email,
                           CASE
                               WHEN a.proxy_id IS NULL THEN 'direct:default'
                               WHEN TRIM(COALESCE(p.egress_ip, '')) <> '' THEN 'ip:' || LOWER(p.egress_ip)
                               ELSE 'proxy:' || COALESCE(p.identity_key, p.id)
                           END AS route_key,
                           CASE WHEN a.proxy_id IS NULL THEN 1 ELSE 0 END AS is_direct
                    FROM accounts a
                    LEFT JOIN proxies p ON p.id = a.proxy_id
                    WHERE a.status IN ('ready', 'active')
                      AND (
                          (a.use_proxy = 0 AND a.proxy_id IS NULL)
                          OR (a.use_proxy = 1 AND a.proxy_id IS NOT NULL AND p.status = 'active')
                      )
                      AND (? IS NULL OR NOT EXISTS (
                          SELECT 1 FROM account_run_successes previous
                          WHERE previous.account_id = a.id
                            AND previous.finished_at >= ?
                      ))
                    ORDER BY COALESCE(a.slot, 2147483647), a.email
                `
                )
                .all(skipSucceededSince, skipSucceededSince)

            const proxyCapacity = Math.max(1, Number(proxyConcurrency) || 1)
            const directCapacity = Math.max(1, Number(directConcurrency) || 1)
            const routeOffsets = new Map()
            const accounts = accountRows.map(account => {
                const offset = routeOffsets.get(account.route_key) || 0
                routeOffsets.set(account.route_key, offset + 1)
                const capacity = Number(account.is_direct) ? directCapacity : proxyCapacity
                return {
                    ...account,
                    lock_key:
                        capacity === 1 ? account.route_key : `${account.route_key}|slot:${(offset % capacity) + 1}`
                }
            })

            const batchId = crypto.randomUUID()
            this.db
                .prepare(
                    `
                    INSERT INTO job_batches (id, source, owner_pid, status, total_jobs, finished_at)
                    VALUES (?, ?, ?, ?, ?, CASE WHEN ? = 0 THEN CURRENT_TIMESTAMP ELSE NULL END)
                `
                )
                .run(
                    batchId,
                    source,
                    Number.isSafeInteger(Number(ownerPid)) && Number(ownerPid) > 0 ? Number(ownerPid) : null,
                    accounts.length ? 'running' : 'completed',
                    accounts.length,
                    accounts.length
                )
            const insert = this.db.prepare(`
                INSERT INTO account_jobs (
                    id, batch_id, account_id, proxy_id, route_key, lock_key, queue_job_id, max_attempts
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `)
            for (const account of accounts) {
                const jobId = crypto.randomUUID()
                insert.run(
                    jobId,
                    batchId,
                    account.account_id,
                    account.proxy_id,
                    account.route_key,
                    account.lock_key,
                    jobId,
                    maxAttempts
                )
            }

            this.db.exec('COMMIT')
            return {
                batchId,
                jobs: accounts.length,
                skippedSucceeded: eligibleCount - accounts.length,
                routes: new Set(accounts.map(row => row.route_key)).size,
                lockGroups: new Set(accounts.map(row => row.lock_key)).size
            }
        } catch (error) {
            this.db.exec('ROLLBACK')
            throw error
        }
    }

    reserveDispatchable(limit = 1000) {
        this.db.exec('BEGIN IMMEDIATE')
        try {
            const pending = this.db
                .prepare(
                    `
                    SELECT j.id, j.queue_job_id, j.batch_id, j.account_id, j.proxy_id, j.lock_key,
                           j.max_attempts, COALESCE(a.slot, 2147483647) AS account_slot
                    FROM account_jobs j
                    JOIN accounts a ON a.id = j.account_id
                    WHERE j.status = 'pending'
                      AND NOT EXISTS (
                          SELECT 1 FROM account_jobs active
                          WHERE active.lock_key = j.lock_key
                            AND active.status IN (${ACTIVE_JOB_STATUSES})
                      )
                    ORDER BY j.created_at, account_slot, j.id
                `
                )
                .all()

            const selected = []
            const lockKeys = new Set()
            const reserve = this.db.prepare(`
                UPDATE account_jobs
                SET status = 'queued', queued_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, error = NULL
                WHERE id = ? AND status = 'pending'
            `)
            for (const row of pending) {
                if (selected.length >= limit || lockKeys.has(row.lock_key)) continue
                if (reserve.run(row.id).changes) {
                    selected.push(row)
                    lockKeys.add(row.lock_key)
                }
            }
            this.db.exec('COMMIT')
            return selected
        } catch (error) {
            this.db.exec('ROLLBACK')
            throw error
        }
    }

    listQueued() {
        return this.db
            .prepare(
                `
                SELECT id, queue_job_id, batch_id, account_id, proxy_id, lock_key, max_attempts
                FROM account_jobs WHERE status = 'queued' ORDER BY queued_at, created_at
            `
            )
            .all()
    }

    resetPending(jobId, error) {
        this.db
            .prepare(
                `
                UPDATE account_jobs
                SET status = 'pending', queued_at = NULL, error = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status = 'queued'
            `
            )
            .run(String(error || '').slice(0, 2000), jobId)
    }

    getJob(jobId) {
        return this.db
            .prepare(
                `
                SELECT j.*, a.email, a.slot, p.label AS proxy_label
                FROM account_jobs j
                JOIN accounts a ON a.id = j.account_id
                LEFT JOIN proxies p ON p.id = j.proxy_id
                WHERE j.id = ?
            `
            )
            .get(jobId)
    }

    markLeaseWait(jobId, message) {
        this.db
            .prepare(
                `
                UPDATE account_jobs SET status = 'queued', error = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status IN ('queued', 'running')
            `
            )
            .run(String(message).slice(0, 2000), jobId)
    }

    startAttempt(jobId, workerId) {
        this.db.exec('BEGIN IMMEDIATE')
        try {
            const row = this.db.prepare('SELECT attempts FROM account_jobs WHERE id = ?').get(jobId)
            if (!row) throw new Error(`Unknown account job: ${jobId}`)
            const attemptNumber = Number(row.attempts) + 1
            const attemptId = crypto.randomUUID()
            this.db
                .prepare(
                    `
                    UPDATE account_jobs SET status = 'running', attempts = ?, worker_id = ?,
                        started_at = CURRENT_TIMESTAMP, finished_at = NULL, error = NULL, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `
                )
                .run(attemptNumber, workerId, jobId)
            this.db
                .prepare(
                    `
                    INSERT INTO job_attempts (id, job_id, attempt_number, worker_id)
                    VALUES (?, ?, ?, ?)
                `
                )
                .run(attemptId, jobId, attemptNumber, workerId)
            this.db.exec('COMMIT')
            return { attemptId, attemptNumber }
        } catch (error) {
            this.db.exec('ROLLBACK')
            throw error
        }
    }

    finishSuccess(jobId, attemptId, result, logPath) {
        this.db.exec('BEGIN IMMEDIATE')
        try {
            this.db
                .prepare("UPDATE job_attempts SET status = 'succeeded', finished_at = CURRENT_TIMESTAMP WHERE id = ?")
                .run(attemptId)
            this.db
                .prepare(
                    `
                    UPDATE account_jobs SET status = 'succeeded', result_json = ?, log_path = ?, error = NULL,
                        process_pid = NULL,
                        finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?
                `
                )
                .run(JSON.stringify(result), logPath, jobId)
            const job = this.db.prepare('SELECT batch_id, account_id FROM account_jobs WHERE id = ?').get(jobId)
            if (result?.run?.accounts?.[0]?.success === true) {
                this.db
                    .prepare(
                        `
                        INSERT INTO account_run_successes (account_id, finished_at, result_json, log_path)
                        VALUES (?, CURRENT_TIMESTAMP, ?, ?)
                        ON CONFLICT(account_id) DO UPDATE SET
                            finished_at = excluded.finished_at,
                            result_json = excluded.result_json,
                            log_path = excluded.log_path
                    `
                    )
                    .run(job.account_id, JSON.stringify(result), logPath)
            }
            const batchId = job.batch_id
            this.updateBatch(batchId)
            this.db.exec('COMMIT')
        } catch (error) {
            this.db.exec('ROLLBACK')
            throw error
        }
    }

    finishFailure(jobId, attemptId, error, willRetry, logPath) {
        const message = String(error instanceof Error ? error.message : error).slice(0, 4000)
        this.db.exec('BEGIN IMMEDIATE')
        try {
            this.db
                .prepare(
                    "UPDATE job_attempts SET status = 'failed', error = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?"
                )
                .run(message, attemptId)
            this.db
                .prepare(
                    `
                    UPDATE account_jobs SET status = ?, error = ?, log_path = COALESCE(?, log_path), process_pid = NULL,
                        finished_at = CASE WHEN ? = 'failed' THEN CURRENT_TIMESTAMP ELSE NULL END,
                        updated_at = CURRENT_TIMESTAMP WHERE id = ?
                `
                )
                .run(willRetry ? 'queued' : 'failed', message, logPath, willRetry ? 'queued' : 'failed', jobId)
            const batchId = this.db.prepare('SELECT batch_id FROM account_jobs WHERE id = ?').get(jobId).batch_id
            this.updateBatch(batchId)
            this.db.exec('COMMIT')
        } catch (dbError) {
            this.db.exec('ROLLBACK')
            throw dbError
        }
    }

    updateBatch(batchId) {
        const counts = this.db
            .prepare(
                `
                SELECT COUNT(*) AS total,
                       SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
                       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                       SUM(CASE WHEN status IN ('pending', 'queued', 'running') THEN 1 ELSE 0 END) AS active
                FROM account_jobs WHERE batch_id = ?
            `
            )
            .get(batchId)
        const active = Number(counts.active || 0)
        const failed = Number(counts.failed || 0)
        const status = active > 0 ? 'running' : failed > 0 ? 'completed_with_errors' : 'completed'
        this.db
            .prepare(
                `
                UPDATE job_batches SET status = ?, succeeded_jobs = ?, failed_jobs = ?,
                    finished_at = CASE WHEN ? = 0 THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id = ?
            `
            )
            .run(status, Number(counts.succeeded || 0), failed, active, batchId)
    }

    stats() {
        const jobs = this.db
            .prepare('SELECT status, COUNT(*) AS count FROM account_jobs GROUP BY status ORDER BY status')
            .all()
        const latestBatches = this.db.prepare('SELECT * FROM job_batches ORDER BY created_at DESC LIMIT 10').all()
        return { dbPath: this.dbPath, jobs, latestBatches }
    }

    close() {
        this.db.close()
    }
}
