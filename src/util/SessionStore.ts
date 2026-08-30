import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

import type { BrowserContext } from 'patchright'
import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'
import { configureSqliteDatabase, withSqliteBusyRetry } from './SqliteRetry'

export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>

export interface LoadedSession {
    storageState: StorageState | null
    fingerprint: BrowserFingerprintWithHeaders | null
    updatedAt: number
}

interface SessionRow {
    storage_state: string | null
    fingerprint: string | null
    updated_at: number
}

let db: DatabaseSync | null = null

function platformOf(isMobile: boolean): 'mobile' | 'desktop' {
    return isMobile ? 'mobile' : 'desktop'
}

function getDb(sessionPath: string): DatabaseSync {
    if (db) return db

    const dir = path.resolve(process.cwd(), sessionPath)
    fs.mkdirSync(dir, { recursive: true })

    const candidate = new DatabaseSync(path.join(dir, 'sessions.db'))
    try {
        configureSqliteDatabase(candidate)
        withSqliteBusyRetry(() =>
            candidate.exec(`
                CREATE TABLE IF NOT EXISTS sessions (
                    email         TEXT NOT NULL,
                    platform      TEXT NOT NULL,
                    storage_state TEXT,
                    fingerprint   TEXT,
                    updated_at    INTEGER NOT NULL,
                    PRIMARY KEY (email, platform)
                )
            `)
        )
        db = candidate
        return candidate
    } catch (error) {
        candidate.close()
        throw error
    }
}

function parseJson<T>(value: string | null): T | null {
    if (!value) return null
    try {
        return JSON.parse(value) as T
    } catch {
        // A malformed old row must not prevent the account from re-authenticating.
        return null
    }
}

export function loadSession(
    sessionPath: string,
    email: string,
    isMobile: boolean,
    maxAgeMs?: number
): LoadedSession | null {
    const row = withSqliteBusyRetry(
        () =>
            getDb(sessionPath)
                .prepare('SELECT storage_state, fingerprint, updated_at FROM sessions WHERE email = ? AND platform = ?')
                .get(email, platformOf(isMobile)) as SessionRow | undefined
    )

    if (!row) return null

    if (maxAgeMs && Date.now() - row.updated_at > maxAgeMs) {
        return null
    }

    return {
        storageState: parseJson<StorageState>(row.storage_state),
        fingerprint: parseJson<BrowserFingerprintWithHeaders>(row.fingerprint),
        updatedAt: row.updated_at
    }
}

export function saveStorageState(
    sessionPath: string,
    email: string,
    isMobile: boolean,
    storageState: StorageState
): void {
    withSqliteBusyRetry(() =>
        getDb(sessionPath)
            .prepare(
                `INSERT INTO sessions (email, platform, storage_state, updated_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(email, platform)
                 DO UPDATE SET storage_state = excluded.storage_state, updated_at = excluded.updated_at`
            )
            .run(email, platformOf(isMobile), JSON.stringify(storageState), Date.now())
    )
}

export function saveFingerprint(
    sessionPath: string,
    email: string,
    isMobile: boolean,
    fingerprint: BrowserFingerprintWithHeaders
): void {
    withSqliteBusyRetry(() =>
        getDb(sessionPath)
            .prepare(
                `INSERT INTO sessions (email, platform, fingerprint, updated_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(email, platform)
                 DO UPDATE SET fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`
            )
            .run(email, platformOf(isMobile), JSON.stringify(fingerprint), Date.now())
    )
}

// Unused
export function deleteSession(sessionPath: string, email: string, isMobile: boolean): void {
    withSqliteBusyRetry(() =>
        getDb(sessionPath)
            .prepare('DELETE FROM sessions WHERE email = ? AND platform = ?')
            .run(email, platformOf(isMobile))
    )
}

export function closeSessionStore(): void {
    if (!db) return
    try {
        // Do not force a TRUNCATE checkpoint while sibling account workers may
        // still be writing. SQLite will checkpoint the WAL normally.
        db.close()
    } catch {}
    db = null
}
