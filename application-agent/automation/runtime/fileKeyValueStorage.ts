import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { KeyValueStorage } from "../../src/persistence/storage";

export const DEFAULT_CAREER_AGENT_STATE_FILE = ".local/career-agent/state.json";

const STATE_VERSION = 1;
let temporaryFileSequence = 0;

interface StateEnvelope {
  version: typeof STATE_VERSION;
  values: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEnvelope(value: unknown): StateEnvelope {
  if (!isRecord(value) || value.version !== STATE_VERSION || !isRecord(value.values)) {
    throw new Error("Career Agent state has an invalid or unsupported format. Restore a valid state file before starting.");
  }

  const values: Record<string, string> = Object.create(null);
  for (const [key, candidate] of Object.entries(value.values)) {
    if (typeof candidate !== "string") {
      throw new Error("Career Agent state contains an invalid stored value. Restore a valid state file before starting.");
    }
    values[key] = candidate;
  }
  return { version: STATE_VERSION, values };
}

function readEnvelope(filePath: string): StateEnvelope {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: STATE_VERSION, values: {} };
    throw new Error("Career Agent state could not be read. Check the state file and permissions before starting.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Career Agent state is not valid JSON. Restore a valid state file before starting.");
  }
  return parseEnvelope(parsed);
}

/**
 * Small synchronous file-backed implementation of the existing browser
 * KeyValueStorage contract. Repository writes are already synchronous, so a
 * synchronous atomic replace keeps the runtime boundary deterministic without
 * introducing a database or a second persistence model.
 */
export class FileKeyValueStorage implements KeyValueStorage {
  readonly filePath: string;
  private values: Map<string, string>;

  constructor(filePath = DEFAULT_CAREER_AGENT_STATE_FILE) {
    this.filePath = resolve(filePath);
    this.values = new Map(Object.entries(readEnvelope(this.filePath).values));
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    const next = new Map(this.values);
    next.set(key, value);
    this.persist(next);
    this.values = next;
  }

  removeItem(key: string): void {
    if (!this.values.has(key)) return;
    const next = new Map(this.values);
    next.delete(key);
    this.persist(next);
    this.values = next;
  }

  private persist(values: ReadonlyMap<string, string>): void {
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${++temporaryFileSequence}`;
    const payload = JSON.stringify({
      version: STATE_VERSION,
      values: Object.fromEntries(values),
    } satisfies StateEnvelope);

    let temporaryCreated = false;
    try {
      const descriptor = openSync(temporaryPath, "wx", 0o600);
      temporaryCreated = true;
      try {
        writeFileSync(descriptor, payload, { encoding: "utf8" });
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporaryPath, this.filePath);
    } finally {
      if (temporaryCreated) {
        try { unlinkSync(temporaryPath); } catch { /* Renamed already, or cleanup unavailable. */ }
      }
    }
  }
}
