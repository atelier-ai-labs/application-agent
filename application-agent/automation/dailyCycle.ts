import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { classifyJobUrl } from "../src/domain/jobUrlClassifier";

/**
 * One scheduled pass of the agent: find jobs, read the inbox, then start
 * applications. Each phase runs its own CLI as a child process so one phase
 * failing (an expired Google token, a flaky board) never stops the others,
 * and every phase behaves exactly as it does when run by hand.
 *
 * Applications only *start* here. Each one stops at its first question or at
 * Submit, waiting in Slack, so the number started is bounded by the browser
 * windows the execution host can keep open, not by the daily cap alone.
 */
export type DailyPhase = "discover" | "inbox" | "apply";
export const DAILY_PHASES: readonly DailyPhase[] = ["discover", "inbox", "apply"];
export const DAILY_RUNS_FILE = ".local/career-agent/daily-runs.jsonl";

export interface QueueJob {
  jobId: string;
  company: string;
  role: string;
  jobLink: string;
  status: string;
  location?: string;
  description?: string;
  priority?: string;
  fit?: string;
}

export interface CommandResult { code: number; stdout: string; timedOut?: boolean }

export interface DailyCycleDependencies {
  run(script: string, args: readonly string[], timeoutMs: number): Promise<CommandResult>;
  /** Open and maximum browser sessions, or undefined when the host is down. */
  hostCapacity(): Promise<{ active: number; max: number } | undefined>;
  notify?(text: string): Promise<void>;
  now?(): Date;
}

export interface DailyCycleOptions {
  phases?: readonly DailyPhase[];
  /** Upper bound on applications started this run, below free host slots. */
  maxStarts?: number;
  jobTimeoutMs?: number;
}

export interface StartedApplication { jobId: string; company: string; role: string; status: string; error?: string }

export interface DailyRunRecord {
  startedAt: string;
  finishedAt: string;
  discovered?: { added: number; jobs: string[] } | { error: string };
  /** Job-board links swapped for the employer's own posting. */
  links?: { fixed: number } | { error: string };
  queueImport?: { promoted: number } | { error: string };
  inbox?: { updates: string[]; notices: number } | { error: string };
  apply?: { started: StartedApplication[]; waiting: number; skippedReason?: string } | { error: string };
}

const SUPPORTED_ATS = new Set(["greenhouse", "lever", "ashby", "rippling"]);
const EXCLUDED_ROLE = /\bpart[- ]time\b|\bcontract(?:or)?\b|\bfreelance\b|\btemporary\b/i;
const FIT_RANK: Record<string, number> = { excellent: 0, strong: 0, good: 1, stretch: 2 };
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** Ready rows the browser executor can fill, best fit first. */
export function pickJobsToStart(jobs: readonly QueueJob[], slots: number): QueueJob[] {
  if (slots <= 0) return [];
  return jobs
    .filter((job) => job.status === "Ready")
    .filter((job) => SUPPORTED_ATS.has(classifyJobUrl(job.jobLink).kind))
    .filter((job) => !EXCLUDED_ROLE.test(job.role) && !/\bpart[- ]time\b/i.test(job.description ?? ""))
    .map((job, index) => ({ job, index }))
    .sort((a, b) =>
      (FIT_RANK[a.job.fit?.trim().toLowerCase() ?? ""] ?? 3) - (FIT_RANK[b.job.fit?.trim().toLowerCase() ?? ""] ?? 3)
      || (PRIORITY_RANK[a.job.priority?.trim().toLowerCase() ?? ""] ?? 3) - (PRIORITY_RANK[b.job.priority?.trim().toLowerCase() ?? ""] ?? 3)
      || a.index - b.index)
    .slice(0, slots)
    .map(({ job }) => job);
}

function lastJson<T>(stdout: string, key: string): T | undefined {
  for (const line of stdout.trim().split("\n").reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (key in parsed) return parsed as T;
    } catch { /* not a result line */ }
  }
  return undefined;
}

function failure(result: CommandResult, label: string): string {
  const lastLine = result.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  return result.timedOut ? `${label} timed out` : `${label} exited ${result.code}${lastLine ? `: ${lastLine.slice(0, 200)}` : ""}`;
}

export async function runDailyCycle(deps: DailyCycleDependencies, options: DailyCycleOptions = {}): Promise<DailyRunRecord> {
  const now = deps.now ?? (() => new Date());
  const phases = new Set(options.phases ?? DAILY_PHASES);
  const record: DailyRunRecord = { startedAt: now().toISOString(), finishedAt: "" };

  if (phases.has("discover")) {
    const result = await deps.run("career-agent:discover", ["--apply"], 10 * 60_000);
    const jobs = result.stdout.split("\n").filter((line) => line.startsWith("+ ")).map((line) => line.slice(2).split(" | ").slice(0, 2).join(" — "));
    const added = Number(/(\d+) added to the tracker/.exec(result.stdout)?.[1] ?? 0);
    record.discovered = result.code === 0 ? { added, jobs: jobs.slice(0, added) } : { error: failure(result, "Job search") };
  }

  // Tracker rows that only link to a job board (Remotive, nogigiddy, ...) get
  // the employer's own posting when the board page or the company's board names it.
  if (phases.has("apply") || phases.has("discover")) {
    const result = await deps.run("career-agent:resolve-links", ["--apply"], 10 * 60_000);
    const fixed = Number(/(\d+) direct links? found/.exec(result.stdout)?.[1] ?? 0);
    record.links = result.code === 0 ? { fixed } : { error: failure(result, "Link check") };
  }

  if (phases.has("apply") || phases.has("discover")) {
    const result = await deps.run("career-agent:queue", ["--import-tracker", "--import-live"], 5 * 60_000);
    const imported = lastJson<{ promoted?: number }>(result.stdout, "promoted");
    record.queueImport = result.code === 0 && imported ? { promoted: imported.promoted ?? 0 } : { error: failure(result, "Queue import") };
  }

  if (phases.has("inbox")) {
    const result = await deps.run("career-agent:inbox", ["--apply"], 5 * 60_000);
    const updates = result.stdout.split("\n").filter((line) => line.startsWith("~ row ")).map((line) => line.replace(/^~ row \d+ /, "").replace(/ \[[a-z_]+\] .*$/, ""));
    const notices = result.stdout.split("\n").filter((line) => line.startsWith("! ")).length;
    record.inbox = result.code === 0 ? { updates, notices } : { error: failure(result, "Inbox check") };
  }

  if (phases.has("apply")) {
    try {
      const capacity = await deps.hostCapacity();
      const listed = await deps.run("career-agent:queue", ["--list"], 2 * 60_000);
      const jobs = lastJson<{ jobs: QueueJob[] }>(listed.stdout, "jobs")?.jobs;
      if (!jobs) throw new Error(failure(listed, "Queue list"));
      const waiting = pickJobsToStart(jobs, Number.MAX_SAFE_INTEGER).length;
      if (!capacity) {
        record.apply = { started: [], waiting, skippedReason: "the browser host is not running" };
      } else {
        const free = Math.max(0, capacity.max - capacity.active);
        const slots = Math.min(free, options.maxStarts ?? free);
        const picked = pickJobsToStart(jobs, slots);
        const started: StartedApplication[] = [];
        const workerId = `daily-${now().toISOString().slice(0, 10)}`;
        for (const job of picked) {
          const result = await deps.run("career-agent:queue", ["--processor", "career-service", "--worker-id", workerId, "--job-id", job.jobId], options.jobTimeoutMs ?? 15 * 60_000);
          const tick = lastJson<{ queue: { status?: string; error?: string } }>(result.stdout, "queue")?.queue;
          started.push({
            jobId: job.jobId, company: job.company, role: job.role,
            status: tick?.status ?? (result.timedOut ? "Timed out" : "Failed"),
            ...(tick?.error ? { error: tick.error.slice(0, 200) } : !tick ? { error: failure(result, "Application") } : {}),
          });
        }
        record.apply = {
          started, waiting: Math.max(0, waiting - picked.length),
          ...(picked.length === 0 ? { skippedReason: free === 0 ? `all ${capacity.max} browser windows are still waiting on you` : slots === 0 ? "starting applications was turned off for this run" : "no ready jobs with a supported application form" } : {}),
        };
      }
    } catch (error) {
      record.apply = { error: error instanceof Error ? error.message.slice(0, 300) : "Applying failed." };
    }
  }

  record.finishedAt = now().toISOString();
  if (deps.notify) await deps.notify(formatDailySummary(record)).catch(() => undefined);
  return record;
}

const STATUS_WORDING: Record<string, string> = {
  "Needs Input": "waiting on your answers",
  "Ready to Submit": "ready for you to Submit",
  Submitted: "submitted",
  Confirmed: "submitted and confirmed",
  Skipped: "skipped",
};

export function formatDailySummary(record: DailyRunRecord): string {
  const lines = [`*Daily run* (${new Date(record.startedAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })})`];
  const d = record.discovered;
  if (d) lines.push("error" in d ? `• Job search failed: ${d.error}` : d.added === 0 ? "• No new jobs found." : `• Found ${d.added} new job${d.added === 1 ? "" : "s"}: ${d.jobs.join("; ")}`);
  if (record.links) {
    if ("error" in record.links) lines.push(`• ${record.links.error}`);
    else if (record.links.fixed > 0) lines.push(`• Found the employer's own posting for ${record.links.fixed} job${record.links.fixed === 1 ? "" : "s"} that only had a job-board link.`);
  }
  if (record.queueImport && "error" in record.queueImport) lines.push(`• ${record.queueImport.error}`);
  const i = record.inbox;
  if (i) lines.push("error" in i ? `• Inbox check failed: ${i.error}` : i.updates.length === 0 ? `• Inbox: no rejections or callbacks${i.notices ? ` (${i.notices} email${i.notices === 1 ? "" : "s"} sent to you above)` : ""}.` : `• Inbox: ${i.updates.join("; ")}`);
  const a = record.apply;
  if (a) {
    if ("error" in a) lines.push(`• Applying failed: ${a.error}`);
    else {
      for (const app of a.started) lines.push(`• ${app.company} — ${app.role}: ${STATUS_WORDING[app.status] ?? app.status}${app.error && (!STATUS_WORDING[app.status] || app.status === "Skipped") ? ` (${app.error})` : ""}`);
      if (a.skippedReason) lines.push(`• No applications started: ${a.skippedReason}.`);
      lines.push(`• ${a.waiting} more job${a.waiting === 1 ? "" : "s"} waiting in the queue.`);
    }
  }
  return lines.join("\n");
}

export function appendDailyRun(record: DailyRunRecord, file = DAILY_RUNS_FILE): void {
  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n");
}

/** Runs `npm run -s <script> -- <args>` in the repo, echoing its output. */
export function npmScriptRunner(cwd = process.cwd()) {
  return (script: string, args: readonly string[], timeoutMs: number): Promise<CommandResult> => new Promise((resolvePromise) => {
    const child = spawn("npm", ["run", "-s", script, "--", ...args], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); process.stdout.write(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { process.stderr.write(chunk); });
    child.on("close", (code) => { clearTimeout(timer); resolvePromise({ code: code ?? 1, stdout, timedOut }); });
  });
}
