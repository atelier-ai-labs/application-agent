import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteAnswerBankStore } from "../application-agent/automation/answerBank/sqliteAnswerBankStore";
import { findAnswerBankEntries, withRecordedAnswer, type AnswerBankEntry } from "../application-agent/src/domain/answerBank";

const entry = (key: string, value: string, extra: Partial<AnswerBankEntry> = {}): AnswerBankEntry =>
  ({ id: `answer-${key}`, key, question: `${key}?`, value, tier: "low", source: "slack", recordedAt: "2026-11-17T00:00:00.000Z", ...extra });

const directories: string[] = [];
const freshDir = () => { const dir = mkdtempSync(join(tmpdir(), "answer-bank-")); directories.push(dir); return dir; };
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("answer bank in SQLite (2026-11-17)", () => {
  it("keeps both answers when two programs save at the same moment", () => {
    const db = join(freshDir(), "state.db");
    const listener = new SqliteAnswerBankStore(db);
    const host = new SqliteAnswerBankStore(db);
    const staleView = listener.entries();
    host.update((entries) => withRecordedAnswer(entries, entry("how did you hear about {company}", "LinkedIn")));
    // The listener's change runs against what is stored now, not its stale read.
    expect(staleView).toEqual([]);
    listener.update((entries) => withRecordedAnswer(entries, entry("what is your pronoun", "He/him")));
    expect(new SqliteAnswerBankStore(db).entries().map((saved) => saved.value)).toEqual(["LinkedIn", "He/him"]);
  });

  it("writes only the rows that changed, and never deletes a row it can't read", () => {
    const db = join(freshDir(), "state.db");
    const store = new SqliteAnswerBankStore(db);
    store.update(() => [entry("a", "1"), entry("b", "2")]);
    const raw = new DatabaseSync(db);
    raw.prepare("INSERT INTO answer_bank (owner_id, key, entry, updated_at) VALUES ('local', 'broken', '{not json', 'x')").run();
    raw.prepare("UPDATE answer_bank SET updated_at = 'untouched' WHERE key = 'a'").run();
    store.update((entries) => entries.filter((saved) => saved.key !== "b"));
    const rows = raw.prepare("SELECT key, updated_at FROM answer_bank ORDER BY key").all() as { key: string; updated_at: string }[];
    expect(rows).toEqual([{ key: "a", updated_at: "untouched" }, { key: "broken", updated_at: "x" }]);
    expect(store.entries().map((saved) => saved.key)).toEqual(["a"]);
  });

  it("rejects an incomplete or duplicate change and leaves the bank as it was", () => {
    const store = new SqliteAnswerBankStore(join(freshDir(), "state.db"));
    store.update(() => [entry("a", "1")]);
    expect(() => store.update((entries) => [...entries, { key: "x" } as AnswerBankEntry])).toThrow(/missing required fields/);
    expect(() => store.update((entries) => [...entries, entry("a", "2")])).toThrow(/two entries/);
    expect(store.entries().map((saved) => saved.value)).toEqual(["1"]);
  });

  it("keeps each user's answers apart", () => {
    const db = join(freshDir(), "state.db");
    new SqliteAnswerBankStore(db, { ownerId: "nate" }).update(() => [entry("a", "Nate's")]);
    const other = new SqliteAnswerBankStore(db, { ownerId: "someone-else" });
    expect(other.entries()).toEqual([]);
    other.update(() => [entry("a", "theirs")]);
    expect(new SqliteAnswerBankStore(db, { ownerId: "nate" }).entries()[0]!.value).toBe("Nate's");
  });

  it("imports answer-bank.json once, then renames it so it isn't edited by mistake", () => {
    const dir = freshDir();
    const json = join(dir, "answer-bank.json");
    writeFileSync(json, JSON.stringify({ version: 1, entries: [entry("a", "1"), entry("b", "2")] }));
    const store = new SqliteAnswerBankStore(join(dir, "state.db"), { legacyJsonPath: json });
    expect(store.entries().map((saved) => saved.key)).toEqual(["a", "b"]);
    expect(existsSync(json)).toBe(false);
    expect(readdirSync(dir).some((name) => name.startsWith("answer-bank.json.moved-to-state-db-"))).toBe(true);
    // A JSON file that shows up again never overwrites the database.
    writeFileSync(json, JSON.stringify({ version: 1, entries: [entry("a", "old")] }));
    expect(new SqliteAnswerBankStore(join(dir, "state.db"), { legacyJsonPath: json }).entries().map((saved) => saved.value)).toEqual(["1", "2"]);
  });

  it("refuses to start from a broken answer-bank.json instead of starting empty", () => {
    const dir = freshDir();
    const json = join(dir, "answer-bank.json");
    writeFileSync(json, '{"entries": [ oops');
    expect(() => new SqliteAnswerBankStore(join(dir, "state.db"), { legacyJsonPath: json })).toThrow(/could not be read/);
    expect(existsSync(json)).toBe(true);
  });

  it("finds an answer by its question for hand edits", () => {
    const entries = [entry("what is 10 times 10", "100 lol", { question: "What is 10 times 10?*" }), entry("how did you hear about {company}", "LinkedIn")];
    expect(findAnswerBankEntries(entries, "10 times 10").map((saved) => saved.key)).toEqual(["what is 10 times 10"]);
    expect(findAnswerBankEntries(entries, "What is 10 times 10?*").map((saved) => saved.key)).toEqual(["what is 10 times 10"]);
    expect(findAnswerBankEntries(entries, "nothing like this")).toEqual([]);
  });
});
