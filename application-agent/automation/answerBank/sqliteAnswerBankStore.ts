import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { isAnswerBankEntry, type AnswerBankEntry, type AnswerBankStore } from "../../src/domain/answerBank";
import { stateDatabasePath } from "../runtime/stateStorage";

/** The old home of the bank: a JSON file next to the state database. */
export const LEGACY_ANSWER_BANK_FILE = ".local/career-agent/answer-bank.json";

/** Until there are accounts, every answer belongs to the one local user. */
export const LOCAL_OWNER = "local";

/**
 * The answer bank in the agent's SQLite database (2026-11-17), one row per
 * answer, in its own table beside the `kv` state table.
 *
 * Why it moved from answer-bank.json:
 * - **Lost updates.** Saving meant reading the whole file, changing it and
 *   writing it all back, so two programs saving together could drop one
 *   answer (the same bug as state.json, 2026-11-10).
 * - **A broken file could wipe it.** A hand edit that broke the JSON read
 *   as an empty bank, and the next saved answer then overwrote the file with
 *   that one answer.
 *
 * Now `update` runs inside one `BEGIN IMMEDIATE` transaction: it reads the
 * rows as they are, applies the change, and writes only the rows that changed.
 * A row this code can't read is never deleted or overwritten by it.
 *
 * `owner_id` keeps each user's answers apart once there is more than one
 * user. The questions the agent learns about can be shared; the answers never
 * are.
 */
export class SqliteAnswerBankStore implements AnswerBankStore {
  readonly path: string;
  readonly ownerId: string;
  private readonly db: DatabaseSync;
  private readonly selectAll: StatementSync;
  private readonly upsert: StatementSync;
  private readonly remove: StatementSync;

  constructor(databasePath: string, options: { ownerId?: string; legacyJsonPath?: string } = {}) {
    this.path = resolve(databasePath);
    this.ownerId = options.ownerId ?? LOCAL_OWNER;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 15000;
      CREATE TABLE IF NOT EXISTS answer_bank (
        owner_id TEXT NOT NULL,
        key TEXT NOT NULL,
        entry TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (owner_id, key)
      );
    `);
    this.selectAll = this.db.prepare("SELECT key, entry FROM answer_bank WHERE owner_id = ? ORDER BY key");
    this.upsert = this.db.prepare(
      "INSERT INTO answer_bank (owner_id, key, entry, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(owner_id, key) DO UPDATE SET entry = excluded.entry, updated_at = excluded.updated_at",
    );
    this.remove = this.db.prepare("DELETE FROM answer_bank WHERE owner_id = ? AND key = ?");
    if (options.legacyJsonPath) this.importLegacyJson(resolve(options.legacyJsonPath));
  }

  /** Every readable answer, sorted by key. */
  entries(): readonly AnswerBankEntry[] {
    return this.readRows().entries;
  }

  update(change: (entries: readonly AnswerBankEntry[]) => readonly AnswerBankEntry[]): void {
    this.transaction(() => {
      const { entries: before } = this.readRows();
      const after = change(before);
      const seen = new Set<string>();
      for (const entry of after) {
        if (!isAnswerBankEntry(entry)) throw new Error(`Answer bank entry "${String((entry as { key?: unknown }).key)}" is missing required fields.`);
        if (entry.key.includes("\0")) throw new Error("Answer bank keys cannot contain NUL.");
        if (seen.has(entry.key)) throw new Error(`Answer bank has two entries for "${entry.key}".`);
        seen.add(entry.key);
      }
      const previous = new Map(before.map((entry) => [entry.key, JSON.stringify(entry)]));
      const now = new Date().toISOString();
      for (const entry of after) {
        const json = JSON.stringify(entry);
        if (previous.get(entry.key) !== json) this.upsert.run(this.ownerId, entry.key, json, now);
      }
      // Only rows this change saw can be removed by it.
      for (const key of previous.keys()) if (!seen.has(key)) this.remove.run(this.ownerId, key);
    });
  }

  close(): void {
    this.db.close();
  }

  private readRows(): { entries: AnswerBankEntry[]; unreadable: string[] } {
    const entries: AnswerBankEntry[] = [];
    const unreadable: string[] = [];
    for (const row of this.selectAll.all(this.ownerId) as { key: string; entry: string }[]) {
      try {
        const parsed = JSON.parse(row.entry) as unknown;
        if (isAnswerBankEntry(parsed) && parsed.key === row.key) entries.push(parsed);
        else unreadable.push(row.key);
      } catch {
        unreadable.push(row.key);
      }
    }
    return { entries, unreadable };
  }

  private transaction(work: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * One-time move from answer-bank.json. The import runs only into an empty
   * bank, inside one transaction (so two programs starting together import
   * once), and stops on a file it can't read instead of starting empty. The
   * file is then renamed so nobody edits it expecting the agent to read it.
   */
  private importLegacyJson(jsonPath: string): void {
    if (!existsSync(jsonPath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
    } catch {
      throw new Error(`${jsonPath} could not be read, so the answer bank was not moved into the database. Fix or remove the file, then start again.`);
    }
    const listed = (parsed as { entries?: unknown })?.entries;
    if (!Array.isArray(listed)) throw new Error(`${jsonPath} has no "entries" list, so the answer bank was not moved into the database.`);
    const valid = listed.filter(isAnswerBankEntry);
    if (valid.length !== listed.length) {
      throw new Error(`${listed.length - valid.length} of ${listed.length} entries in ${jsonPath} are incomplete, so nothing was moved. Fix them, then start again.`);
    }
    let imported = false;
    this.transaction(() => {
      if ((this.selectAll.all(this.ownerId) as unknown[]).length > 0) return;
      const now = new Date().toISOString();
      const byKey = new Map(valid.map((entry) => [entry.key, entry]));
      for (const entry of byKey.values()) this.upsert.run(this.ownerId, entry.key, JSON.stringify(entry), now);
      imported = true;
    });
    if (imported || this.entries().length >= new Set(valid.map((entry) => entry.key)).size) {
      try {
        renameSync(jsonPath, `${jsonPath}.moved-to-state-db-${Date.now()}`);
      } catch {
        // Another program renamed it first.
      }
    }
  }
}

/**
 * The one way programs open the bank: in the state database, importing the
 * old answer-bank.json the first time. `ATELIER_CAREER_AGENT_ANSWER_BANK_FILE`
 * now only names that old file.
 */
export function openAnswerBankStore(
  env: Partial<Record<"ATELIER_CAREER_AGENT_ANSWER_BANK_FILE" | "ATELIER_CAREER_AGENT_STATE_FILE", string | undefined>> = process.env,
  stateDbPath?: string,
): SqliteAnswerBankStore {
  const databasePath = stateDbPath ?? stateDatabasePath(env.ATELIER_CAREER_AGENT_STATE_FILE?.trim() || undefined);
  const legacy = env.ATELIER_CAREER_AGENT_ANSWER_BANK_FILE?.trim() || resolve(dirname(databasePath), "answer-bank.json");
  return new SqliteAnswerBankStore(databasePath, { legacyJsonPath: legacy });
}
