import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv } from "vite";
import { loadBackgroundCandidateProfile } from "../runtime/careerAgentRuntime";
import { LocalStorageCareerRepository } from "../../src/persistence/careerRepository";
import { FileKeyValueStorage } from "../runtime/fileKeyValueStorage";
import { FileAnswerBankStore } from "../answerBank/fileAnswerBankStore";
import { createOllamaAnswerBankMatcher } from "../answerBank/ollamaAnswerBankMatcher";
import { DEFAULT_FORM_SNAPSHOT_DIR, FormSnapshotStore, type FormSnapshot } from "./formSnapshot";
import { compareReplays, replayForm, replayTotals, type FormReplay } from "./formReplay";

export const DEFAULT_REPLAY_BASELINE = ".local/career-agent/replay-baseline.json";

/** Company and role for snapshots taken before they were recorded, from the agent's own job records. */
function withIdentity(snapshots: readonly FormSnapshot[]): FormSnapshot[] {
  let jobs: ReturnType<LocalStorageCareerRepository["listJobs"]> = [];
  try { jobs = new LocalStorageCareerRepository(new FileKeyValueStorage()).listJobs(); } catch { /* no state yet */ }
  return snapshots.map((snapshot) => {
    if (snapshot.company && snapshot.role) return snapshot;
    const job = jobs.find((candidate) => candidate.applicationId === snapshot.applicationId) ??
      jobs.find((candidate) => candidate.job.applicationUrl === snapshot.url || candidate.job.sourceUrl === snapshot.url);
    return job ? { ...snapshot, company: job.job.company, role: job.job.title } : snapshot;
  });
}

const pct = (part: number, whole: number) => whole === 0 ? "—" : `${Math.round((part / whole) * 100)}%`;

/** Entry point for `npm run career-agent:replay` (`--save-baseline`, `--with-model`). */
export async function runReplayCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const loaded = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
  for (const [name, value] of Object.entries(loaded)) if (process.env[name] === undefined) process.env[name] = value;
  const env = process.env as Record<string, string | undefined>;
  const profile = loadBackgroundCandidateProfile(env);
  const snapshots = withIdentity(new FormSnapshotStore(env.ATELIER_FORM_SNAPSHOT_DIR?.trim() || DEFAULT_FORM_SNAPSHOT_DIR).list());
  if (snapshots.length === 0) {
    console.log("No form snapshots yet. They are saved as the agent opens real forms, or run career-agent:capture.");
    return 0;
  }
  const bank = new FileAnswerBankStore(env.ATELIER_CAREER_AGENT_ANSWER_BANK_FILE?.trim() || undefined).entries();
  const model = env.ATELIER_CAREER_AGENT_OLLAMA_MODEL?.trim();
  const matcher = argv.includes("--with-model") && model ? createOllamaAnswerBankMatcher({ model }) : undefined;

  const replays: FormReplay[] = [];
  for (const snapshot of snapshots) replays.push(await replayForm(snapshot, { profile, answerBank: bank, ...(matcher ? { matcher } : {}) }));

  console.log("Form                                              fields  filled  bank  ask  blank");
  for (const form of replays) {
    const t = replayTotals([form]);
    const name = `${form.company} — ${form.role}`.slice(0, 48).padEnd(48);
    if (form.state === "error") { console.log(`${name}  replay error: ${form.reason}`); continue; }
    const stopped = t.filled === 0 && form.reason ? `  (stopped: ${form.reason.slice(0, 80)})` : "";
    console.log(`${name}  ${String(t.fields).padStart(6)}  ${String(t.filled).padStart(6)}  ${String(t.bank).padStart(4)}  ${String(t.asked).padStart(3)}  ${String(t.blank).padStart(5)}${stopped}`);
    if (argv.includes("--quiet")) continue;
    for (const field of form.fields.filter((candidate) => candidate.outcome === "asked")) console.log(`      asks: ${field.label.replace(/\s+/g, " ").trim().slice(0, 100)}`);
  }
  const totals = replayTotals(replays);
  console.log(`\n${totals.forms} forms, ${totals.fields} fields: ${pct(totals.filled, totals.fields)} filled by the agent, ${pct(totals.bank, totals.fields)} from the answer bank, ${totals.asked} questions would go to Slack (${(totals.asked / Math.max(1, totals.forms - totals.errors)).toFixed(1)} per form).${totals.errors ? ` ${totals.errors} forms failed to replay.` : ""}`);

  const baselinePath = resolve(env.ATELIER_REPLAY_BASELINE_FILE?.trim() || DEFAULT_REPLAY_BASELINE);
  let regressions = 0;
  if (existsSync(baselinePath)) {
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as { savedAt: string; forms: FormReplay[] };
    const changes = compareReplays(baseline.forms, replays);
    regressions = changes.filter((change) => change.kind === "worse").length;
    if (changes.length === 0) console.log(`No field changed since the baseline (${baseline.savedAt.slice(0, 10)}).`);
    for (const kind of ["worse", "better", "changed"] as const) {
      const rows = changes.filter((change) => change.kind === kind);
      if (rows.length === 0) continue;
      console.log(`\n${kind === "worse" ? "Regressions" : kind === "better" ? "Improvements" : "Filled with a different value"} (${rows.length}):`);
      for (const change of rows) console.log(`  ${change.form}: ${change.field.slice(0, 80)} (${change.from} → ${change.to})`);
    }
  } else {
    console.log("\nNo baseline yet; run with --save-baseline to record this as the baseline.");
  }
  if (argv.includes("--save-baseline")) {
    writeFileSync(baselinePath, JSON.stringify({ savedAt: new Date().toISOString(), forms: replays }, null, 2) + "\n");
    console.log(`Saved the baseline to ${baselinePath}.`);
  }
  return regressions > 0 ? 1 : 0;
}

process.exitCode = await runReplayCli();
