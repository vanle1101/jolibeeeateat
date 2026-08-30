import { DatabaseSync } from 'node:sqlite';
export declare function configureSqliteDatabase(db: DatabaseSync, readonly?: boolean): void;
export declare function withSqliteBusyRetry<T>(fn: () => T, maxRetries?: number, delayMs?: number): T;
export declare function withSqliteTransaction<T>(db: DatabaseSync, fn: () => T): T;
//# sourceMappingURL=SqliteRetry.d.ts.map