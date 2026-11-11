import { closeSync, mkdirSync, openSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { KeyValueStorage } from "../../src/persistence/storage";

export const DEFAULT_CAREER_AGENT_STATE_DB = ".local/career-agent/state.db";

const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

// Keys and values are stored as UTF-8 bytes, not TEXT: submission-fence keys
// contain a NUL separator ("application-…\0career-job-…"), and SQLite text cut
// them short at it (caught by the import check, 2026-11-10).
const bytes = (value: string): Uint8Array => Buffer.from(value, "utf8");
const text = (value: Uint8Array): string => Buffer.from(value).toString("utf8");
const exclusiveLockContext = new AsyncLocalStorage<SqliteKeyValueStorage>();

/**
 * The agent's state in SQLite (2026-11-10), replacing one 17 MB JSON file that
 * every process rewrote whole on each save. The Slack listener, the browser
 * host and one-off commands each open their own connection:
 *
 * - a write changes only its own key, so two programs can't erase each
 *   other's changes to different keys;
 * - `updateItem` reads, changes and writes a key inside one short
 *   `BEGIN IMMEDIATE` transaction, so two programs changing the same job list
 *   are put in line by SQLite instead of overwriting each other;
 * - WAL mode lets readers keep reading while another process writes, and
 *   `busy_timeout` makes a writer wait briefly instead of failing.
 *
 * Reads are cached per key and the cache is dropped whenever SQLite's
 * `data_version` shows another connection committed.
 *
 * The cross-process maintenance lock (`withExclusiveLock*`) is kept as the
 * same OS-visible lock file the JSON storage used, so commands that hold it
 * across a browser run behave exactly as before.
 */
export class SqliteKeyValueStorage implements KeyValueStorage {
  readonly filePath: string;
  private readonly db: DatabaseSync;
  private readonly select: StatementSync;
  private readonly upsert: StatementSync;
  private readonly remove: StatementSync;
  private readonly version: StatementSync;
  private readonly cache = new Map<string, string | null>();
  private seenVersion: number | undefined;
  private syncLockDepth = 0;

  constructor(filePath = DEFAULT_CAREER_AGENT_STATE_DB) {
    this.filePath = resolve(filePath);
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 15000;
      CREATE TABLE IF NOT EXISTS kv (key BLOB PRIMARY KEY, value BLOB NOT NULL);
    `);
    this.select = this.db.prepare("SELECT value FROM kv WHERE key = ?");
    this.upsert = this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    this.remove = this.db.prepare("DELETE FROM kv WHERE key = ?");
    this.version = this.db.prepare("PRAGMA data_version");
  }

  /** Drop cached reads when another connection has committed since we last looked. */
  private refreshIfChanged(): void {
    const current = Number((this.version.get() as { data_version?: number } | undefined)?.data_version);
    if (current !== this.seenVersion) {
      this.cache.clear();
      this.seenVersion = current;
    }
  }

  private read(key: string): string | null {
    const row = this.select.get(bytes(key)) as { value?: unknown } | undefined;
    return row?.value instanceof Uint8Array ? text(row.value) : null;
  }

  getItem(key: string): string | null {
    this.refreshIfChanged();
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    const value = this.read(key);
    this.cache.set(key, value);
    return value;
  }

  setItem(key: string, value: string): void {
    this.upsert.run(bytes(key), bytes(value));
    this.cache.set(key, value);
  }

  removeItem(key: string): void {
    this.remove.run(bytes(key));
    this.cache.set(key, null);
  }

  updateItem(key: string, change: (current: string | null) => string): void {
    this.db.exec("BEGIN IMMEDIATE");
    let next: string;
    try {
      next = change(this.read(key));
      this.upsert.run(bytes(key), bytes(next));
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      this.cache.delete(key);
      throw error;
    }
    this.cache.set(key, next);
  }

  /** Every key and value, for backups and the one-time import check. */
  entries(): [string, string][] {
    return (this.db.prepare("SELECT key, value FROM kv ORDER BY key").all() as { key: Uint8Array; value: Uint8Array }[])
      .map((row) => [text(row.key), text(row.value)]);
  }

  /** Write many keys in one transaction (the one-time import). */
  importEntries(entries: Iterable<[string, string]>): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [key, value] of entries) this.upsert.run(bytes(key), bytes(value));
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }
    this.cache.clear();
  }

  reload(): void {
    this.cache.clear();
    this.seenVersion = undefined;
  }

  close(): void {
    this.db.close();
  }

  /** Same OS-visible maintenance lock the JSON storage used (`<file>.lock`). */
  withExclusiveLock<T>(operation: () => T): T {
    if (exclusiveLockContext.getStore() === this || this.syncLockDepth > 0) return operation();
    const lockPath = `${this.filePath}.lock`;
    let descriptor: number | undefined;
    for (;;) {
      try {
        descriptor = openSync(lockPath, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > 30_000) unlinkSync(lockPath);
        } catch { /* Another process owns or is replacing the lock. */ }
        Atomics.wait(lockWaitBuffer, 0, 0, 5);
      }
    }
    this.syncLockDepth += 1;
    try {
      this.reload();
      return operation();
    } finally {
      this.syncLockDepth -= 1;
      try { closeSync(descriptor); } finally { try { unlinkSync(lockPath); } catch { /* already released */ } }
    }
  }

  async withExclusiveLockAsync<T>(operation: () => Promise<T>): Promise<T> {
    if (exclusiveLockContext.getStore() === this) return operation();
    const lockPath = `${this.filePath}.lock`;
    let descriptor: number | undefined;
    for (;;) {
      try {
        descriptor = openSync(lockPath, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > 30_000) unlinkSync(lockPath);
        } catch { /* Another process owns or is replacing the lock. */ }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      }
    }
    const heartbeat = setInterval(() => {
      try { utimesSync(lockPath, new Date(), new Date()); } catch { /* The owner or cleanup already released the lock. */ }
    }, 5_000);
    try {
      this.reload();
      return await exclusiveLockContext.run(this, operation);
    } finally {
      clearInterval(heartbeat);
      try { closeSync(descriptor); } finally { try { unlinkSync(lockPath); } catch { /* already released */ } }
    }
  }
}
