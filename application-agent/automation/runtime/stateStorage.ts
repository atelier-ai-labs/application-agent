import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_CAREER_AGENT_STATE_FILE, FileKeyValueStorage } from "./fileKeyValueStorage";
import { DEFAULT_CAREER_AGENT_STATE_DB, SqliteKeyValueStorage } from "./sqliteKeyValueStorage";

export { DEFAULT_CAREER_AGENT_STATE_DB };

export type CareerAgentStateStorage = FileKeyValueStorage | SqliteKeyValueStorage;

const siblingDb = (path: string) => path.replace(/\.json$/i, ".db");
const siblingJson = (path: string) => path.replace(/\.db$/i, ".json");

/**
 * The one place every program (Slack listener, browser host, one-off commands)
 * opens the agent's state, so they always share the same store.
 *
 * - `.db` → SQLite. If the database doesn't exist yet but the old `state.json`
 *   does, refuse to start instead of silently beginning with no jobs.
 * - `.json` → the SQLite database next to it when one exists (an old config
 *   or default must never split the processes across two stores), otherwise
 *   the JSON file (tests, or before the one-time import).
 */
export function openStateStorage(path?: string): CareerAgentStateStorage {
  // ATELIER_CAREER_AGENT_STATE_FILE also picks the default for code that opens
  // state without naming a file (the browser host's submission fences); the
  // test setup points it at a temporary folder so tests never touch real state.
  const resolved = resolve(path ?? (process.env.ATELIER_CAREER_AGENT_STATE_FILE?.trim() || DEFAULT_CAREER_AGENT_STATE_DB));
  if (/\.json$/i.test(resolved)) {
    const db = siblingDb(resolved);
    return existsSync(db) ? new SqliteKeyValueStorage(db) : new FileKeyValueStorage(resolved);
  }
  if (!existsSync(resolved) && existsSync(siblingJson(resolved))) {
    throw new Error(`Career Agent state is still in ${siblingJson(resolved)}. Run \`npm run career-agent:migrate-state\` once to move it into SQLite.`);
  }
  return new SqliteKeyValueStorage(resolved);
}
