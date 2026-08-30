"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.configureSqliteDatabase = configureSqliteDatabase;
exports.withSqliteBusyRetry = withSqliteBusyRetry;
exports.withSqliteTransaction = withSqliteTransaction;
function configureSqliteDatabase(db, readonly = false) {
    if (!readonly) {
        try {
            db.exec('PRAGMA journal_mode = WAL;');
        }
        catch { }
    }
    try {
        db.exec('PRAGMA synchronous = NORMAL;');
    }
    catch { }
    try {
        db.exec('PRAGMA busy_timeout = 5000;');
    }
    catch { }
}
function withSqliteBusyRetry(fn, maxRetries = 5, delayMs = 100) {
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return fn();
        }
        catch (error) {
            lastError = error;
            const isBusy = error &&
                (error.code === 'SQLITE_BUSY' ||
                    error.code === 'SQLITE_LOCKED' ||
                    (typeof error.message === 'string' &&
                        (error.message.includes('busy') || error.message.includes('locked'))));
            if (isBusy) {
                const sleepDuration = delayMs * Math.pow(1.5, attempt);
                const start = Date.now();
                while (Date.now() - start < sleepDuration) {
                    // spin wait
                }
                continue;
            }
            throw error;
        }
    }
    throw lastError;
}
function withSqliteTransaction(db, fn) {
    return withSqliteBusyRetry(() => {
        db.exec('BEGIN IMMEDIATE');
        try {
            const result = fn();
            db.exec('COMMIT');
            return result;
        }
        catch (error) {
            try {
                db.exec('ROLLBACK');
            }
            catch { }
            throw error;
        }
    });
}
//# sourceMappingURL=SqliteRetry.js.map