import { DatabaseSync } from 'node:sqlite'

export function configureSqliteDatabase(db: DatabaseSync, readonly: boolean = false): void {
    if (!readonly) {
        try {
            db.exec('PRAGMA journal_mode = WAL;')
        } catch {}
    }
    try {
        db.exec('PRAGMA synchronous = NORMAL;')
    } catch {}
    try {
        db.exec('PRAGMA busy_timeout = 5000;')
    } catch {}
}

export function withSqliteBusyRetry<T>(
    fn: () => T,
    maxRetries: number = 5,
    delayMs: number = 100
): T {
    let lastError: unknown
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return fn()
        } catch (error: any) {
            lastError = error
            const isBusy =
                error &&
                (error.code === 'SQLITE_BUSY' ||
                    error.code === 'SQLITE_LOCKED' ||
                    (typeof error.message === 'string' &&
                        (error.message.includes('busy') || error.message.includes('locked'))))
            if (isBusy) {
                const sleepDuration = delayMs * Math.pow(1.5, attempt)
                const start = Date.now()
                while (Date.now() - start < sleepDuration) {
                    // spin wait
                }
                continue
            }
            throw error
        }
    }
    throw lastError
}

export function withSqliteTransaction<T>(db: DatabaseSync, fn: () => T): T {
    return withSqliteBusyRetry(() => {
        db.exec('BEGIN IMMEDIATE')
        try {
            const result = fn()
            db.exec('COMMIT')
            return result
        } catch (error) {
            try {
                db.exec('ROLLBACK')
            } catch {}
            throw error
        }
    })
}
