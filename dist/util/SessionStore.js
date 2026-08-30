"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadSession = loadSession;
exports.saveStorageState = saveStorageState;
exports.saveFingerprint = saveFingerprint;
exports.deleteSession = deleteSession;
exports.closeSessionStore = closeSessionStore;
const node_sqlite_1 = require("node:sqlite");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const SqliteRetry_1 = require("./SqliteRetry");
let db = null;
function platformOf(isMobile) {
    return isMobile ? 'mobile' : 'desktop';
}
function getDb(sessionPath) {
    if (db)
        return db;
    const dir = node_path_1.default.resolve(process.cwd(), sessionPath);
    node_fs_1.default.mkdirSync(dir, { recursive: true });
    const candidate = new node_sqlite_1.DatabaseSync(node_path_1.default.join(dir, 'sessions.db'));
    try {
        (0, SqliteRetry_1.configureSqliteDatabase)(candidate);
        (0, SqliteRetry_1.withSqliteBusyRetry)(() => candidate.exec(`
                CREATE TABLE IF NOT EXISTS sessions (
                    email         TEXT NOT NULL,
                    platform      TEXT NOT NULL,
                    storage_state TEXT,
                    fingerprint   TEXT,
                    updated_at    INTEGER NOT NULL,
                    PRIMARY KEY (email, platform)
                )
            `));
        db = candidate;
        return candidate;
    }
    catch (error) {
        candidate.close();
        throw error;
    }
}
function parseJson(value) {
    if (!value)
        return null;
    try {
        return JSON.parse(value);
    }
    catch {
        // A malformed old row must not prevent the account from re-authenticating.
        return null;
    }
}
function loadSession(sessionPath, email, isMobile, maxAgeMs) {
    const row = (0, SqliteRetry_1.withSqliteBusyRetry)(() => getDb(sessionPath)
        .prepare('SELECT storage_state, fingerprint, updated_at FROM sessions WHERE email = ? AND platform = ?')
        .get(email, platformOf(isMobile)));
    if (!row)
        return null;
    if (maxAgeMs && Date.now() - row.updated_at > maxAgeMs) {
        return null;
    }
    return {
        storageState: parseJson(row.storage_state),
        fingerprint: parseJson(row.fingerprint),
        updatedAt: row.updated_at
    };
}
function saveStorageState(sessionPath, email, isMobile, storageState) {
    (0, SqliteRetry_1.withSqliteBusyRetry)(() => getDb(sessionPath)
        .prepare(`INSERT INTO sessions (email, platform, storage_state, updated_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(email, platform)
                 DO UPDATE SET storage_state = excluded.storage_state, updated_at = excluded.updated_at`)
        .run(email, platformOf(isMobile), JSON.stringify(storageState), Date.now()));
}
function saveFingerprint(sessionPath, email, isMobile, fingerprint) {
    (0, SqliteRetry_1.withSqliteBusyRetry)(() => getDb(sessionPath)
        .prepare(`INSERT INTO sessions (email, platform, fingerprint, updated_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(email, platform)
                 DO UPDATE SET fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`)
        .run(email, platformOf(isMobile), JSON.stringify(fingerprint), Date.now()));
}
// Unused
function deleteSession(sessionPath, email, isMobile) {
    (0, SqliteRetry_1.withSqliteBusyRetry)(() => getDb(sessionPath)
        .prepare('DELETE FROM sessions WHERE email = ? AND platform = ?')
        .run(email, platformOf(isMobile)));
}
function closeSessionStore() {
    if (!db)
        return;
    try {
        // Do not force a TRUNCATE checkpoint while sibling account workers may
        // still be writing. SQLite will checkpoint the WAL normally.
        db.close();
    }
    catch { }
    db = null;
}
//# sourceMappingURL=SessionStore.js.map