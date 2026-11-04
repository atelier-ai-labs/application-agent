import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AnswerBankEntry, AnswerBankStore } from "../../src/domain/answerBank";

export const DEFAULT_ANSWER_BANK_FILE = ".local/career-agent/answer-bank.json";

/**
 * The bank is a plain JSON file so it can be read and corrected by hand:
 * change a `value`, or set `"disabled": true` to stop an answer being reused.
 * It is re-read on every lookup, so hand edits apply without a restart.
 */
export class FileAnswerBankStore implements AnswerBankStore {
  readonly path: string;
  constructor(path = DEFAULT_ANSWER_BANK_FILE) { this.path = resolve(path); }

  entries(): readonly AnswerBankEntry[] {
    if (!existsSync(this.path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as { entries?: unknown };
      return Array.isArray(parsed.entries) ? parsed.entries.filter(isEntry) : [];
    } catch {
      // A hand edit that broke the JSON must not stop applications; the bank
      // simply answers nothing until it is fixed.
      return [];
    }
  }

  save(entries: readonly AnswerBankEntry[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const sorted = [...entries].sort((a, b) => a.key.localeCompare(b.key));
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, entries: sorted }, null, 2) + "\n");
    renameSync(temporary, this.path);
  }
}

function isEntry(value: unknown): value is AnswerBankEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === "string" && typeof entry.key === "string" && typeof entry.question === "string" &&
    ["string", "number", "boolean"].includes(typeof entry.value) && ["low", "medium", "high"].includes(entry.tier as string);
}
