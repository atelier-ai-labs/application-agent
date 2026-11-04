import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ApplicationFieldDescriptor, LeverBrowserSession, LeverBrowserSessionFactory } from "../../src/domain/executor";

/**
 * A form snapshot is what the agent saw when it first opened a real
 * application form: each field's label, type, options, and question text.
 * It never holds an answer, so snapshots can be replayed against new code
 * to see which fields the agent fills and which it would ask about.
 */
export const DEFAULT_FORM_SNAPSHOT_DIR = ".local/career-agent/form-snapshots";

export interface FormSnapshot {
  version: 1;
  applicationId: string;
  url: string;
  capturedAt: string;
  company?: string;
  role?: string;
  fields: ApplicationFieldDescriptor[];
}

/** Only descriptive properties are kept; live browser handles and values are dropped. */
export function snapshotField(field: ApplicationFieldDescriptor): ApplicationFieldDescriptor {
  const copy: ApplicationFieldDescriptor = {
    id: field.id,
    label: field.label,
    type: field.type,
    required: field.required,
    classification: field.classification,
    ...(field.fullPrompt ? { fullPrompt: field.fullPrompt } : {}),
    ...(field.section ? { section: field.section } : {}),
    ...(field.sourceSelector ? { sourceSelector: field.sourceSelector } : {}),
    ...(field.options ? { options: field.options.map((option) => ({ ...option })) } : {}),
    ...(field.questionDescriptor ? { questionDescriptor: JSON.parse(JSON.stringify(field.questionDescriptor)) } : {}),
  };
  return copy;
}

function fileNameFor(url: string): string {
  let host = "unknown";
  let path = url;
  try { const parsed = new URL(url); host = parsed.hostname; path = parsed.pathname; } catch { /* keep raw */ }
  const slug = `${host}${path}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 150);
  return `${slug || "form"}.json`;
}

export class FormSnapshotStore {
  readonly directory: string;
  constructor(directory = DEFAULT_FORM_SNAPSHOT_DIR) { this.directory = resolve(directory); }

  save(snapshot: FormSnapshot): string {
    mkdirSync(this.directory, { recursive: true });
    const path = join(this.directory, fileNameFor(snapshot.url));
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(snapshot, null, 2) + "\n");
    renameSync(temporary, path);
    return path;
  }

  list(): FormSnapshot[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory).filter((name) => name.endsWith(".json")).sort().flatMap((name) => {
      try {
        const parsed = JSON.parse(readFileSync(join(this.directory, name), "utf8")) as FormSnapshot;
        return parsed.version === 1 && Array.isArray(parsed.fields) && parsed.fields.length > 0 ? [parsed] : [];
      } catch {
        return [];
      }
    });
  }
}

/**
 * Wraps the real browser sessions so the first form read in each session is
 * saved as a snapshot. Everything else passes straight through; a failure to
 * save never affects the application.
 */
export function recordingSessionFactory(
  inner: LeverBrowserSessionFactory,
  store: FormSnapshotStore,
  now: () => string = () => new Date().toISOString(),
): LeverBrowserSessionFactory {
  return {
    async open(applicationId: string): Promise<LeverBrowserSession> {
      const session = await inner.open(applicationId);
      let url = "";
      let identity: { company?: string; role?: string } = {};
      let recorded = false;
      return new Proxy(session, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== "function") return value;
          if (property === "navigate") {
            return async (next: string) => { url = next; return value.call(target, next); };
          }
          if (property === "verifyPageIdentity" || property === "discoverApplicationRoute") {
            return async (company: string, role: string, ...rest: unknown[]) => {
              identity = { company, role };
              return value.call(target, company, role, ...rest);
            };
          }
          if (property === "inspectFields") {
            return async () => {
              const fields = await value.call(target);
              if (!recorded && Array.isArray(fields) && fields.length > 0) {
                recorded = true;
                try {
                  const current = await Promise.resolve(target.currentUrl()).catch(() => url);
                  store.save({
                    version: 1, applicationId, url: current || url, capturedAt: now(), ...identity,
                    fields: fields.map((field: ApplicationFieldDescriptor) => snapshotField(field)),
                  });
                } catch { /* snapshots are diagnostics only */ }
              }
              return fields;
            };
          }
          return value.bind(target);
        },
      });
    },
  };
}
