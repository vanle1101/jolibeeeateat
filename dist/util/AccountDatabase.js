"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveAccountsDbPath = resolveAccountsDbPath;
exports.ensureAccountsDatabase = ensureAccountsDatabase;
exports.loadAccountsFromDatabase = loadAccountsFromDatabase;
exports.disableAccountInDatabase = disableAccountInDatabase;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const node_sqlite_1 = require("node:sqlite");
const AccountSecrets_1 = require("./AccountSecrets");
const SqliteRetry_1 = require("./SqliteRetry");
const DEFAULT_DB_PATH = path_1.default.join('data', 'accounts.db');
function resolveProjectRelative(projectRoot, maybeRelativePath) {
    return path_1.default.isAbsolute(maybeRelativePath) ? maybeRelativePath : path_1.default.join(projectRoot, maybeRelativePath);
}
function resolveAccountsDbPath(projectRoot) {
    const configured = process.env.ACCOUNTS_DB_PATH?.trim();
    return resolveProjectRelative(projectRoot, configured || DEFAULT_DB_PATH);
}
function ensureAccountsDatabase(dbPath) {
    fs_1.default.mkdirSync(path_1.default.dirname(dbPath), { recursive: true });
    const db = new node_sqlite_1.DatabaseSync(dbPath);
    try {
        (0, SqliteRetry_1.configureSqliteDatabase)(db);
        (0, SqliteRetry_1.withSqliteBusyRetry)(() => db.exec(`
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS proxies (
                id TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                proxy_http INTEGER NOT NULL DEFAULT 0,
                url TEXT NOT NULL,
                port INTEGER NOT NULL DEFAULT 0,
                username TEXT NOT NULL DEFAULT '',
                password TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'active',
                max_concurrency INTEGER NOT NULL DEFAULT 1,
                account_capacity INTEGER NOT NULL DEFAULT 1,
                identity_key TEXT,
                egress_ip TEXT,
                cooldown_seconds INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS accounts (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                password TEXT NOT NULL,
                totp_secret TEXT,
                recovery_email TEXT NOT NULL DEFAULT '',
                geo_locale TEXT NOT NULL DEFAULT 'auto',
                lang_code TEXT NOT NULL DEFAULT 'en',
                proxy_id TEXT REFERENCES proxies(id) ON UPDATE CASCADE ON DELETE SET NULL,
                use_proxy INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'ready',
                slot INTEGER,
                save_fingerprint_mobile INTEGER NOT NULL DEFAULT 1,
                save_fingerprint_desktop INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS deleted_accounts (
                email TEXT PRIMARY KEY COLLATE NOCASE,
                deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_accounts_proxy_id ON accounts(proxy_id);
            CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
            CREATE INDEX IF NOT EXISTS idx_accounts_slot ON accounts(slot);
            CREATE INDEX IF NOT EXISTS idx_proxies_status ON proxies(status);
        `));
        const proxyColumns = new Set((0, SqliteRetry_1.withSqliteBusyRetry)(() => db.prepare('PRAGMA table_info(proxies)').all()).map(row => row.name));
        if (!proxyColumns.has('account_capacity')) {
            (0, SqliteRetry_1.withSqliteBusyRetry)(() => db.exec('ALTER TABLE proxies ADD COLUMN account_capacity INTEGER NOT NULL DEFAULT 1'));
        }
        if (!proxyColumns.has('identity_key')) {
            (0, SqliteRetry_1.withSqliteBusyRetry)(() => db.exec('ALTER TABLE proxies ADD COLUMN identity_key TEXT'));
        }
        if (!proxyColumns.has('egress_ip')) {
            (0, SqliteRetry_1.withSqliteBusyRetry)(() => db.exec('ALTER TABLE proxies ADD COLUMN egress_ip TEXT'));
        }
        const accountColumns = new Set((0, SqliteRetry_1.withSqliteBusyRetry)(() => db.prepare('PRAGMA table_info(accounts)').all()).map(row => row.name));
        if (!accountColumns.has('use_proxy')) {
            (0, SqliteRetry_1.withSqliteBusyRetry)(() => db.exec('ALTER TABLE accounts ADD COLUMN use_proxy INTEGER NOT NULL DEFAULT 1'));
        }
        (0, SqliteRetry_1.withSqliteBusyRetry)(() => db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_proxies_identity_key ON proxies(identity_key)'));
    }
    finally {
        db.close();
    }
}
function loadAccountsFromDatabase(projectRoot) {
    const dbPath = resolveAccountsDbPath(projectRoot);
    if (!fs_1.default.existsSync(dbPath))
        return null;
    ensureAccountsDatabase(dbPath);
    const db = new node_sqlite_1.DatabaseSync(dbPath, { readOnly: true });
    try {
        (0, SqliteRetry_1.configureSqliteDatabase)(db, true);
        const rows = (0, SqliteRetry_1.withSqliteBusyRetry)(() => db
            .prepare(`
                SELECT
                    a.id AS account_id,
                    a.email,
                    a.password,
                    a.totp_secret,
                    a.recovery_email,
                    a.geo_locale,
                    a.lang_code,
                    a.proxy_id,
                    a.use_proxy,
                    a.status AS account_status,
                    a.slot,
                    a.save_fingerprint_mobile,
                    a.save_fingerprint_desktop,
                    p.proxy_http,
                    p.url AS proxy_url,
                    p.port AS proxy_port,
                    p.username AS proxy_username,
                    p.password AS proxy_password,
                    p.egress_ip AS proxy_egress_ip
                FROM accounts a
                LEFT JOIN proxies p ON p.id = a.proxy_id
                WHERE a.status IN ('ready', 'active')
                  AND (a.proxy_id IS NULL OR p.status = 'active')
                ORDER BY COALESCE(a.slot, 2147483647), a.email
                `)
            .all());
        return rows.map((row) => ({
            accountId: row.account_id,
            proxyId: row.proxy_id,
            useProxy: Boolean(row.use_proxy),
            status: row.account_status,
            slot: row.slot ?? undefined,
            email: row.email,
            password: (0, AccountSecrets_1.decryptAccountSecret)(row.password, `password for ${row.email}`),
            totpSecret: row.totp_secret
                ? (0, AccountSecrets_1.decryptAccountSecret)(row.totp_secret, `TOTP secret for ${row.email}`)
                : undefined,
            recoveryEmail: row.recovery_email ?? '',
            geoLocale: row.geo_locale ?? 'auto',
            langCode: row.lang_code ?? 'en',
            proxy: {
                proxyHttp: Boolean(row.proxy_http),
                url: row.proxy_url ?? '',
                port: row.proxy_port ?? 0,
                username: row.proxy_username ?? '',
                password: (0, AccountSecrets_1.decryptAccountSecret)(row.proxy_password, `proxy password for ${row.email}`),
                expectedEgressIp: row.proxy_egress_ip?.trim() || undefined
            },
            saveFingerprint: {
                mobile: Boolean(row.save_fingerprint_mobile),
                desktop: Boolean(row.save_fingerprint_desktop)
            }
        }));
    }
    finally {
        db.close();
    }
}
/**
 * Marks an account unusable in the accounts DB so it is excluded from every
 * future run (loadAccountsFromDatabase only returns 'ready'/'active' rows).
 *
 * - mode 'disable' (default, reversible): sets status = 'disabled'.
 * - mode 'delete' (irreversible): removes the row and records the email in
 *   deleted_accounts so a later import cannot silently re-add it.
 *
 * Safe to call for env-sourced accounts: it simply reports inDatabase=false.
 */
function disableAccountInDatabase(projectRoot, email, mode) {
    const normalizedEmail = email.trim();
    const dbPath = resolveAccountsDbPath(projectRoot);
    if (!normalizedEmail || !fs_1.default.existsSync(dbPath)) {
        return { persisted: false, inDatabase: false, mode };
    }
    ensureAccountsDatabase(dbPath);
    const db = new node_sqlite_1.DatabaseSync(dbPath);
    try {
        (0, SqliteRetry_1.configureSqliteDatabase)(db);
        const existing = (0, SqliteRetry_1.withSqliteBusyRetry)(() => db.prepare('SELECT id FROM accounts WHERE LOWER(email) = LOWER(?)').get(normalizedEmail));
        if (!existing)
            return { persisted: false, inDatabase: false, mode };
        if (mode === 'delete') {
            return (0, SqliteRetry_1.withSqliteTransaction)(db, () => {
                db.exec('PRAGMA foreign_keys = ON');
                db.prepare(`INSERT INTO deleted_accounts (email, deleted_at)
                     VALUES (?, CURRENT_TIMESTAMP)
                     ON CONFLICT(email) DO UPDATE SET deleted_at = excluded.deleted_at`).run(normalizedEmail);
                const result = db.prepare('DELETE FROM accounts WHERE id = ?').run(existing.id);
                return { persisted: Number(result.changes ?? 0) > 0, inDatabase: true, mode };
            });
        }
        const result = (0, SqliteRetry_1.withSqliteBusyRetry)(() => db
            .prepare(`UPDATE accounts SET status = 'disabled', updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND status != 'disabled'`)
            .run(existing.id));
        return { persisted: Number(result.changes ?? 0) > 0, inDatabase: true, mode };
    }
    finally {
        db.close();
    }
}
//# sourceMappingURL=AccountDatabase.js.map