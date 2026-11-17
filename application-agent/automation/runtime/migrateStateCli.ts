import { existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_CAREER_AGENT_STATE_FILE, FileKeyValueStorage } from "./fileKeyValueStorage";
import { DEFAULT_CAREER_AGENT_STATE_DB, SqliteKeyValueStorage } from "./sqliteKeyValueStorage";

/**
 * One-time move of the agent's state from state.json into SQLite (2026-11-10).
 * Stop the Slack listener and the execution host first. Every key is copied in
 * one transaction and read back to check it matches; only then is state.json
 * renamed to a dated backup (never deleted), so a failure leaves it in place.
 */
const json = resolve(process.argv[2] ?? DEFAULT_CAREER_AGENT_STATE_FILE);
const db = resolve(process.argv[3] ?? DEFAULT_CAREER_AGENT_STATE_DB);
if (!existsSync(json)) throw new Error(`No ${json} to import.`);
if (existsSync(db)) throw new Error(`${db} already exists; the import runs only once. Move it aside to redo it.`);

const source = new FileKeyValueStorage(json).entries();
const target = new SqliteKeyValueStorage(db);
target.importEntries(source);
const copied = new Map(target.entries());
const mismatched = source.filter(([key, value]) => copied.get(key) !== value).map(([key]) => key);
if (copied.size !== source.length || mismatched.length > 0) {
  target.close();
  renameSync(db, `${db}.failed-${Date.now()}`);
  throw new Error(`Import check failed (${mismatched.length} mismatched of ${source.length}); state.json was left in place.`);
}
target.close();
const backup = `${json}.pre-sqlite-${Date.now()}.backup`;
renameSync(json, backup);
console.log(`[career-agent-migrate] copied ${source.length} keys into ${db}; every value matched. state.json kept as ${backup}`);
