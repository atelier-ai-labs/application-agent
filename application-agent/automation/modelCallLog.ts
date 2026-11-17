import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

/**
 * One line per call to the local model (2026-11-14). Until now a draft that
 * was rejected, retried or timed out left no trace; this is the record an
 * eval, a prompt change or a "why did it write that?" question starts from.
 * It stays on this machine: it holds the candidate's own answers.
 */
export interface ModelCallRecord {
  at: string;
  /** What the call was for: an essay draft or an answer-bank match. */
  purpose: "essay_draft" | "answer_bank_match";
  model: string;
  /** Changes whenever the prompt text or template changes. */
  promptVersion: string;
  /** 1 for the first try, 2 for the retry after filler was found. */
  attempt: number;
  company?: string;
  question?: string;
  /** Phrases the retry was told to avoid. */
  avoid?: readonly string[];
  /** "drafted", "matched", or why the output was dropped. */
  outcome: string;
  output?: string;
  /** Quality problems found in the output (filler, copied posting phrases). */
  problems?: readonly string[];
  latencyMs: number;
  promptTokens?: number;
  outputTokens?: number;
}

export interface ModelCallLogger {
  record(entry: ModelCallRecord): void;
}

export const DEFAULT_MODEL_CALL_LOG_FILE = ".local/career-agent/model-calls.jsonl";
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** A short, stable version id from the prompt text and template source. */
export function promptVersion(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 10);
}

/** Appends records to a JSON-lines file, keeping roughly the newest half once it passes 5 MB. */
export class FileModelCallLogger implements ModelCallLogger {
  readonly filePath: string;

  constructor(filePath = DEFAULT_MODEL_CALL_LOG_FILE) {
    this.filePath = resolve(filePath);
  }

  record(entry: ModelCallRecord): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      if (statSync(this.filePath).size > MAX_LOG_BYTES) {
        const lines = readFileSync(this.filePath, "utf8").split("\n").filter(Boolean);
        writeFileSync(this.filePath, `${lines.slice(Math.floor(lines.length / 2)).join("\n")}\n`, { mode: 0o600 });
      }
    } catch {
      // Logging must never break drafting.
    }
  }
}

/** Reads the log back (for the eval report and quick inspection). */
export function readModelCallLog(filePath = DEFAULT_MODEL_CALL_LOG_FILE): ModelCallRecord[] {
  const path = resolve(filePath);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as ModelCallRecord]; } catch { return []; }
  });
}
