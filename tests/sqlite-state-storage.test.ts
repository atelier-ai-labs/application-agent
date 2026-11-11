// @vitest-environment node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteKeyValueStorage } from "../application-agent/automation/runtime/sqliteKeyValueStorage";
import { FileKeyValueStorage } from "../application-agent/automation/runtime/fileKeyValueStorage";
import { openStateStorage } from "../application-agent/automation/runtime/stateStorage";
import { LocalStorageCareerRepository } from "../application-agent/src/persistence/careerRepository";
import { DurableSubmissionAuthority } from "../application-agent/automation/executionHost/submissionAuthority";

const directories: string[] = [];
function location() {
  const directory = mkdtempSync(join(tmpdir(), "career-sqlite-test-"));
  directories.push(directory);
  return { directory, db: join(directory, "state.db"), json: join(directory, "state.json") };
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("SQLite state storage", () => {
  it("saves, reads back in a new connection, and removes", () => {
    const { db } = location();
    const first = new SqliteKeyValueStorage(db);
    first.setItem("jobs", "[1]");
    first.setItem("__proto__", "safe");
    // Submission-fence keys hold a NUL separator; SQLite text would cut them short.
    first.setItem("fence:application-1\u0000career-job-1", "claimed\u0000x");
    expect(new SqliteKeyValueStorage(db).getItem("fence:application-1\u0000career-job-1")).toBe("claimed\u0000x");
    expect(new SqliteKeyValueStorage(db).entries().map(([key]) => key)).toContain("fence:application-1\u0000career-job-1");
    expect(new SqliteKeyValueStorage(db).getItem("jobs")).toBe("[1]");
    expect(new SqliteKeyValueStorage(db).getItem("__proto__")).toBe("safe");
    first.removeItem("jobs");
    expect(new SqliteKeyValueStorage(db).getItem("jobs")).toBeNull();
  });

  it("sees another connection's commit even after caching a read", () => {
    const { db } = location();
    const host = new SqliteKeyValueStorage(db);
    const listener = new SqliteKeyValueStorage(db);
    host.setItem("fence", "none");
    expect(listener.getItem("fence")).toBe("none");
    host.setItem("fence", "claimed");
    expect(listener.getItem("fence")).toBe("claimed");
  });

  it("keeps both jobs when two connections save different jobs after stale reads (the Affirm case)", () => {
    const { db } = location();
    const key = "atelier.application-agent.career-jobs.v0";
    const cliStorage = new SqliteKeyValueStorage(db);
    const listenerStorage = new SqliteKeyValueStorage(db);
    const cli = new LocalStorageCareerRepository(cliStorage);
    const listener = new LocalStorageCareerRepository(listenerStorage);
    cliStorage.setItem(key, "[]");
    expect(listener.listJobs()).toEqual([]); // the listener now holds a cached, soon-stale copy
    // The repositories filter on the full job shape, so save through updateItem
    // the way saveJob does, with minimal records.
    cliStorage.updateItem(key, (raw) => JSON.stringify([...JSON.parse(raw ?? "[]"), { id: "affirm", status: "failed" }]));
    listenerStorage.updateItem(key, (raw) => JSON.stringify([...JSON.parse(raw ?? "[]"), { id: "latitude", status: "needs_input" }]));
    expect(JSON.parse(new SqliteKeyValueStorage(db).getItem(key)!)).toEqual([
      { id: "affirm", status: "failed" }, { id: "latitude", status: "needs_input" },
    ]);
    void cli;
  });

  it("keeps a submission fence claimed by another connection", () => {
    const { db } = location();
    const host = new DurableSubmissionAuthority("host", { storage: new SqliteKeyValueStorage(db) });
    const listener = new SqliteKeyValueStorage(db);
    listener.getItem("anything");
    const fence = host.claim("application-1", "job-1", new Date().toISOString());
    listener.setItem("atelier.application-agent.career-jobs.v0", "[]");
    expect(() => host.beforeClick(fence, new Date().toISOString())).not.toThrow();
  });

  it("loses nothing when two separate processes append to the same list at once", async () => {
    const { directory, db } = location();
    new SqliteKeyValueStorage(db).setItem("list", "[]");
    const worker = join(directory, "worker.mjs");
    writeFileSync(worker, `
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(process.argv[2]);
      db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 15000;");
      const key = Buffer.from("list", "utf8");
      const read = db.prepare("SELECT value FROM kv WHERE key = ?");
      const write = db.prepare("UPDATE kv SET value = ? WHERE key = ?");
      for (let i = 0; i < 200; i += 1) {
        db.exec("BEGIN IMMEDIATE");
        const list = JSON.parse(Buffer.from(read.get(key).value).toString("utf8"));
        list.push(process.argv[3] + i);
        write.run(Buffer.from(JSON.stringify(list), "utf8"), key);
        db.exec("COMMIT");
      }
    `);
    const run = (name: string) => new Promise<number>((resolvePromise, reject) => {
      const child = spawn(process.execPath, ["--no-warnings", worker, db, name], { stdio: "inherit" });
      child.on("exit", (code) => resolvePromise(code ?? 1));
      child.on("error", reject);
    });
    expect(await Promise.all([run("a"), run("b")])).toEqual([0, 0]);
    expect(JSON.parse(new SqliteKeyValueStorage(db).getItem("list")!)).toHaveLength(400);
  }, 60_000);

  it("chooses the store: SQLite when it exists, JSON before the import, and refuses a missing database next to old JSON", () => {
    const { json, db } = location();
    expect(openStateStorage(json)).toBeInstanceOf(FileKeyValueStorage);
    writeFileSync(json, JSON.stringify({ version: 1, values: {} }));
    expect(() => openStateStorage(db)).toThrow("migrate-state");
    new SqliteKeyValueStorage(db).setItem("k", "v");
    const fromJsonPath = openStateStorage(json);
    expect(fromJsonPath).toBeInstanceOf(SqliteKeyValueStorage);
    expect(fromJsonPath.getItem("k")).toBe("v");
  });
});
