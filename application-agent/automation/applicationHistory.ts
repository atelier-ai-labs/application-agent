import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DAILY_RUNS_FILE, type DailyRunRecord } from "./dailyCycle";
import { INBOX_LOG_FILE } from "./inboxMonitor";

/**
 * Builds the application history report from the agent's own durable event
 * log, so the numbers describe what actually happened: how much of each form
 * the agent filled, what it had to ask, where it failed, and whether a submit
 * was proven by the page or only confirmed by the user. Answer values are
 * never rendered; the report shows questions and counts only.
 */
export const HISTORY_REPORT_FILE = ".local/career-agent/history.html";
const STATE_FILE = ".local/career-agent/state.json";

type Tone = "ok" | "warn" | "bad" | "info";

interface CareerEvent {
  type: string;
  applicationId?: string;
  jobId?: string;
  occurredAt: string;
  metadata?: Record<string, string | undefined>;
}

interface AttentionEvent {
  applicationId?: string;
  createdAt: string;
  status: string;
  blockerType?: string;
  question?: { prompt?: string };
}

export interface InboxLogEntry { at: string; action: string; kind: string; company?: string; role?: string; status?: string; email: string }

export interface HistoryEvent { at: string; until?: string; label: string; tone: Tone; count: number }

export interface ApplicationHistory {
  id: string;
  company: string;
  role: string;
  ats: string;
  fit: string;
  resume: string;
  link: string;
  startedAt: string;
  lastActivityAt: string;
  outcome: string;
  outcomeTone: Tone;
  submitProof?: "page" | "you";
  fields?: { filled: number; detected: number };
  questions: { prompt: string; kind: string; status: string }[];
  captcha: boolean;
  failures: string[];
  minutesToReady?: number;
  email?: { status: string; at: string };
  events: HistoryEvent[];
}

export interface HistoryScore {
  applications: number;
  started: number;
  reachedSubmit: number;
  submitted: number;
  provenByPage: number;
  fieldsFilled: number;
  fieldsDetected: number;
  questionsAsked: number;
  captchas: number;
  failed: number;
  rejected: number;
  interviewing: number;
}

export interface HistoryReport {
  generatedAt: string;
  score: HistoryScore;
  failureReasons: { reason: string; count: number }[];
  applications: ApplicationHistory[];
  dailyRuns: DailyRunRecord[];
}

function parseList<T>(raw: string | undefined): T[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as T[] | Record<string, T>;
  return Array.isArray(parsed) ? parsed : Object.values(parsed);
}

const BLOCKER_WORDING: Record<string, string> = {
  captcha: "CAPTCHA", unknown_form_field: "unknown form question", subjective_answer: "written answer",
  salary: "salary", unknown_fact: "missing fact", external_verification: "email or security code",
  legal_attestation: "legal statement", relocation: "relocation", travel: "travel", sponsorship: "sponsorship",
  demographic_disclosure: "demographic question", manual_submission: "Submit approval", submission_approval: "Submit approval",
  resume_missing: "resume upload", external_login: "account sign-in", unsupported_widget: "unsupported form control",
};

/** `needs_input` reasons are a count, a blocker type, or a comma list of them. */
function askedLabel(reason: string | undefined): string {
  if (!reason) return "Asked you";
  if (/^\d+$/.test(reason)) return `Waiting on ${reason} open item${reason === "1" ? "" : "s"}`;
  const kinds = reason.split(",").map((kind) => kind.trim()).filter(Boolean);
  if (kinds.length === 1 && kinds[0] === "submission_approval") return "Waiting for your Submit tap";
  const distinct = [...new Set(kinds.map((kind) => BLOCKER_WORDING[kind] ?? kind.replace(/_/g, " ")))];
  return kinds.length === 1 ? `Asked you: ${distinct[0]}` : `Asked you ${kinds.length} things (${distinct.join(", ")})`;
}

function shortReason(reason: string | undefined): string {
  if (!reason) return "unknown reason";
  const text = reason.replace(/\s+/g, " ").trim();
  if (/target page, context or browser has been closed|browser (?:session )?(?:expired|closed)/i.test(text)) return "browser window closed";
  if (/timed out|timeout/i.test(text)) return "timed out";
  if (/oauth|token endpoint/i.test(text)) return "Google sign-in expired";
  return text.length > 90 ? `${text.slice(0, 87)}…` : text;
}

/** Plain wording for one logged step; undefined drops noise from the timeline. */
function describe(event: CareerEvent): { label: string; tone: Tone } | undefined {
  const m = event.metadata ?? {};
  switch (event.type) {
    case "job.discovered": return { label: "Job found", tone: "info" };
    case "job.held": return { label: `Held: ${shortReason(m.reason)}`, tone: "warn" };
    case "job.rejected": return { label: `Removed: ${shortReason(m.reason)}`, tone: "info" };
    case "application.created": return { label: "Application created", tone: "info" };
    case "application.evaluated": return { label: `Fit checked: ${m.fit ?? "?"}`, tone: "info" };
    case "application.prepared": return { label: "Answers prepared from profile", tone: "info" };
    case "application.execution_host_started": return { label: `Browser opened${m.attempt && m.attempt !== "1" ? ` (attempt ${m.attempt})` : ""}`, tone: "info" };
    case "application.execution_started": return { label: "Started filling the form", tone: "info" };
    case "application.form_inspected": return { label: `Read the form: ${m.fieldsFilled ?? "?"} of ${m.fieldsDetected ?? "?"} fields filled`, tone: "info" };
    case "application.execution_paused": return { label: `Paused for ${BLOCKER_WORDING[m.blocker ?? ""] ?? m.blocker ?? "input"}`, tone: "warn" };
    case "application.needs_input": return { label: askedLabel(m.reason), tone: "warn" };
    case "application.execution_resumed": return { label: "Resumed with your answer", tone: "info" };
    case "application.ready_to_submit": return { label: "Ready for your Submit tap", tone: "ok" };
    case "application.submitted": return { label: "Submit clicked", tone: "ok" };
    case "application.applied": return { label: m.reason === "external" ? "Applied: confirmed on the page" : "Applied: confirmed by you", tone: "ok" };
    case "application.receipt_confirmed": return { label: "Confirmation email arrived (counted as your DONE)", tone: "ok" };
    case "application.execution_failed": return { label: "Browser run failed", tone: "bad" };
    case "application.failed": return { label: `Failed: ${shortReason(m.reason)}`, tone: "bad" };
    case "application.execution_cancelled": return { label: "Browser run cancelled", tone: "info" };
    case "tracker.updated": return { label: "Tracker updated", tone: "ok" };
    case "tracker.failed": return { label: `Tracker update failed: ${shortReason(m.reason)}`, tone: "bad" };
    default: return undefined;
  }
}

/** Collapses runs of the same step (the form is re-read many times per pass). */
function timeline(events: readonly CareerEvent[]): HistoryEvent[] {
  const out: (HistoryEvent & { type: string })[] = [];
  for (const event of events) {
    const described = describe(event);
    if (!described) continue;
    const last = out[out.length - 1];
    if (last && last.type === event.type) {
      last.count += 1;
      last.until = event.occurredAt;
      last.label = described.label;
      continue;
    }
    out.push({ type: event.type, at: event.occurredAt, label: described.label, tone: described.tone, count: 1 });
  }
  return out.map(({ type: _type, ...rest }) => rest);
}

const normalizeCompany = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

export function buildApplicationHistory(
  values: Record<string, string>,
  inboxLog: readonly InboxLogEntry[] = [],
  dailyRuns: readonly DailyRunRecord[] = [],
  now = new Date(),
): HistoryReport {
  const applications = parseList<{ id: string; isExample?: boolean; status: string; createdAt: string; updatedAt: string; job: { company: string; title: string; ats?: string; applicationUrl?: string; sourceUrl?: string }; fit?: { classification?: string }; resume?: { familyLabel?: string; familyId?: string } }>(values["atelier.application-agent.applications.v0"]).filter((app) => !app.isExample);
  const jobs = parseList<{ id: string; applicationId?: string; status: string }>(values["atelier.application-agent.career-jobs.v0"]);
  const events = parseList<CareerEvent>(values["atelier.application-agent.career-events.v0"]).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const attention = parseList<{ attentionEvents?: AttentionEvent[] }>(values["atelier.application-agent.campaigns.v0"]).flatMap((campaign) => campaign.attentionEvents ?? []);

  const jobByApplication = new Map(jobs.filter((job) => job.applicationId).map((job) => [job.applicationId!, job]));
  const eventsByApplication = new Map<string, CareerEvent[]>();
  const jobEvents = new Map<string, CareerEvent[]>();
  for (const event of events) {
    if (event.applicationId) (eventsByApplication.get(event.applicationId) ?? eventsByApplication.set(event.applicationId, []).get(event.applicationId)!).push(event);
    else if (event.jobId) (jobEvents.get(event.jobId) ?? jobEvents.set(event.jobId, []).get(event.jobId)!).push(event);
  }
  const latestEmail = new Map<string, InboxLogEntry>();
  for (const entry of inboxLog) if (entry.action === "updated" && entry.company && entry.status !== "Applied") latestEmail.set(normalizeCompany(entry.company), entry);

  const failureCounts = new Map<string, number>();
  const histories = applications.map((app): ApplicationHistory => {
    const job = jobByApplication.get(app.id);
    const own = eventsByApplication.get(app.id) ?? [];
    const all = [...(job ? jobEvents.get(job.id) ?? [] : []), ...own].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const has = (type: string) => own.some((event) => event.type === type);
    const inspected = [...own].reverse().find((event) => event.type === "application.form_inspected");
    const applied = own.find((event) => event.type === "application.applied");
    const firstStart = own.find((event) => event.type === "application.execution_started");
    const firstReady = own.find((event) => event.type === "application.ready_to_submit");
    const failures = [...new Set(own.filter((event) => event.type === "application.failed").map((event) => shortReason(event.metadata?.reason)))];
    for (const reason of failures) failureCounts.set(reason, (failureCounts.get(reason) ?? 0) + 1);
    const questions = attention
      .filter((item) => item.applicationId === app.id && item.blockerType && item.blockerType !== "captcha")
      .map((item) => ({ prompt: item.question?.prompt ?? "(no wording saved)", kind: BLOCKER_WORDING[item.blockerType!] ?? item.blockerType!, status: item.status }));
    const email = latestEmail.get(normalizeCompany(app.job.company));
    const submitProof = applied ? (applied.metadata?.reason === "external" ? "page" as const : "you" as const) : undefined;
    let outcome: string; let outcomeTone: Tone;
    if (email?.status === "Interviewing") { outcome = "Interviewing"; outcomeTone = "ok"; }
    else if (email?.status === "Rejected") { outcome = "Rejected"; outcomeTone = "bad"; }
    else if (app.status === "applied") { outcome = "Applied"; outcomeTone = "ok"; }
    else if (job?.status === "rejected") { outcome = "Removed"; outcomeTone = "info"; }
    else if (job?.status === "held") { outcome = "Held"; outcomeTone = "warn"; }
    else if (app.status === "failed") { outcome = "Failed"; outcomeTone = "bad"; }
    else if (app.status === "needs_input") { outcome = has("application.ready_to_submit") ? "Waiting for Submit" : "Waiting on you"; outcomeTone = "warn"; }
    else { outcome = "Prepared"; outcomeTone = "info"; }
    return {
      id: app.id,
      company: app.job.company,
      role: app.job.title,
      ats: app.job.ats ?? "Unknown",
      fit: app.fit?.classification ?? "?",
      resume: app.resume?.familyLabel ?? app.resume?.familyId ?? "",
      link: app.job.applicationUrl ?? app.job.sourceUrl ?? "",
      startedAt: app.createdAt,
      lastActivityAt: all[all.length - 1]?.occurredAt ?? app.updatedAt,
      outcome, outcomeTone,
      ...(submitProof ? { submitProof } : {}),
      ...(inspected ? { fields: { filled: Number(inspected.metadata?.fieldsFilled ?? 0), detected: Number(inspected.metadata?.fieldsDetected ?? 0) } } : {}),
      questions,
      captcha: own.some((event) => event.type === "application.execution_paused" && event.metadata?.blocker === "captcha"),
      failures,
      ...(firstStart && firstReady ? { minutesToReady: Math.max(0, Math.round((Date.parse(firstReady.occurredAt) - Date.parse(firstStart.occurredAt)) / 60_000)) } : {}),
      ...(email ? { email: { status: email.status!, at: email.at } } : {}),
      events: timeline(all),
    };
  }).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));

  const started = histories.filter((app) => app.events.some((event) => event.label === "Started filling the form"));
  const score: HistoryScore = {
    applications: histories.length,
    started: started.length,
    reachedSubmit: histories.filter((app) => app.submitProof || app.events.some((event) => event.label === "Ready for your Submit tap")).length,
    submitted: histories.filter((app) => app.submitProof).length,
    provenByPage: histories.filter((app) => app.submitProof === "page").length,
    fieldsFilled: started.reduce((sum, app) => sum + (app.fields?.filled ?? 0), 0),
    fieldsDetected: started.reduce((sum, app) => sum + (app.fields?.detected ?? 0), 0),
    questionsAsked: started.reduce((sum, app) => sum + app.questions.length, 0),
    captchas: histories.filter((app) => app.captcha).length,
    failed: histories.filter((app) => app.outcome === "Failed").length,
    rejected: histories.filter((app) => app.outcome === "Rejected").length,
    interviewing: histories.filter((app) => app.outcome === "Interviewing").length,
  };
  return {
    generatedAt: now.toISOString(),
    score,
    failureReasons: [...failureCounts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 6),
    applications: histories,
    dailyRuns: [...dailyRuns].reverse().slice(0, 14),
  };
}

const QUESTION_STATUS: Record<string, string> = { open: "still open", resolved: "answered", cancelled: "closed: the form moved on" };
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const pct = (part: number, whole: number) => (whole === 0 ? "–" : `${Math.round((part / whole) * 100)}%`);
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function dailyRunSummary(run: DailyRunRecord): string {
  const parts: string[] = [];
  if (run.discovered) parts.push("error" in run.discovered ? "search failed" : `${run.discovered.added} found`);
  if (run.inbox) parts.push("error" in run.inbox ? "inbox failed" : `${run.inbox.updates.length} inbox update${run.inbox.updates.length === 1 ? "" : "s"}`);
  if (run.apply) parts.push("error" in run.apply ? "applying failed" : `${run.apply.started.length} started${run.apply.skippedReason ? ` (${run.apply.skippedReason})` : ""}`);
  return parts.join(" · ");
}

export function renderApplicationHistoryHtml(report: HistoryReport): string {
  const s = report.score;
  const tiles = [
    ["Reached Submit", pct(s.reachedSubmit, s.started), `${s.reachedSubmit} of ${s.started} started`],
    ["Fields filled by agent", pct(s.fieldsFilled, s.fieldsDetected), `${s.fieldsFilled} of ${s.fieldsDetected} fields`],
    ["Questions per application", s.started ? (s.questionsAsked / s.started).toFixed(1) : "–", `${s.questionsAsked} sent to Slack`],
    ["Submitted", String(s.submitted), `${s.provenByPage} proven by the page`],
    ["CAPTCHAs", String(s.captchas), "applications blocked by one"],
    ["Outcomes", `${s.interviewing} / ${s.rejected}`, "interviewing / rejected"],
  ];
  const rows = report.applications.map((app) => {
    const fields = app.fields ? `${app.fields.filled}/${app.fields.detected}` : "–";
    const facts = [
      `${escapeHtml(app.ats)} · fit ${escapeHtml(app.fit)}${app.resume ? ` · ${escapeHtml(app.resume)} resume` : ""}`,
      app.minutesToReady !== undefined ? `${app.minutesToReady} min from start to Submit-ready` : "",
      app.submitProof ? (app.submitProof === "page" ? "Submit proven by the page" : "Submit confirmed by you (no page proof)") : "",
      app.email ? `${escapeHtml(app.email.status)} by email ${when(app.email.at)}` : "",
    ].filter(Boolean).map((fact) => `<li>${fact}</li>`).join("");
    const questions = app.questions.length === 0 ? "" : `<h4>Asked you (${app.questions.length})</h4><ul class="q">${app.questions.map((q) => `<li><span class="kind">${escapeHtml(q.kind)}</span> ${escapeHtml(q.prompt)}${QUESTION_STATUS[q.status] ? ` <em>(${QUESTION_STATUS[q.status]})</em>` : ""}</li>`).join("")}</ul>`;
    const failures = app.failures.length === 0 ? "" : `<h4>Failures</h4><ul class="q">${app.failures.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>`;
    const steps = app.events.map((event) => `<li class="t-${event.tone}"><time>${when(event.at)}</time><span>${escapeHtml(event.label)}${event.count > 1 ? ` <b>×${event.count}</b>` : ""}</span></li>`).join("");
    return `<details><summary><span class="who"><strong>${escapeHtml(app.company)}</strong><small>${escapeHtml(app.role)}</small></span><span class="meta"><span class="badge b-${app.outcomeTone}">${escapeHtml(app.outcome)}</span><span class="nums" title="fields filled / found · questions asked">${fields} · ${app.questions.length}q${app.captcha ? " · CAPTCHA" : ""}</span><time>${when(app.lastActivityAt)}</time></span></summary>
<div class="body"><ul class="facts">${facts}</ul>${app.link ? `<p><a href="${escapeHtml(app.link)}" target="_blank" rel="noopener">Job posting</a></p>` : ""}${questions}${failures}<h4>Timeline</h4><ol class="tl">${steps}</ol></div></details>`;
  }).join("\n");
  const failures = report.failureReasons.length === 0 ? "<p class=\"muted\">No failures recorded.</p>" : `<ul class="q">${report.failureReasons.map((item) => `<li><b>${item.count}×</b> ${escapeHtml(item.reason)}</li>`).join("")}</ul>`;
  const runs = report.dailyRuns.length === 0 ? "<p class=\"muted\">No scheduled runs yet.</p>" : `<ul class="q">${report.dailyRuns.map((run) => `<li><time>${when(run.startedAt)}</time> ${escapeHtml(dailyRunSummary(run))}</li>`).join("")}</ul>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Application History</title>
<style>
:root{--bg:#f7f7f5;--panel:#fff;--text:#1d1d1b;--muted:#6b6b66;--line:#e3e2dd;--ok:#1f7a4d;--ok-bg:#e3f3ea;--warn:#8a5a00;--warn-bg:#fbefd5;--bad:#b3261e;--bad-bg:#fbe4e2;--info:#3d5a80;--info-bg:#e6edf5}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151514;--panel:#1f1f1d;--text:#ecebe6;--muted:#a3a29b;--line:#34332f;--ok:#6fcf9c;--ok-bg:#183326;--warn:#f0c062;--warn-bg:#3a2e12;--bad:#f2a199;--bad-bg:#3d1c19;--info:#9db8dc;--info-bg:#1c2836}}
:root[data-theme="dark"]{--bg:#151514;--panel:#1f1f1d;--text:#ecebe6;--muted:#a3a29b;--line:#34332f;--ok:#6fcf9c;--ok-bg:#183326;--warn:#f0c062;--warn-bg:#3a2e12;--bad:#f2a199;--bad-bg:#3d1c19;--info:#9db8dc;--info-bg:#1c2836}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}h4{margin:14px 0 6px;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.muted,small,time{color:var(--muted)}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:16px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px}.tile b{display:block;font-size:24px}.tile span{font-size:13px}.tile small{display:block;font-size:12px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media (max-width:640px){.cols{grid-template-columns:1fr}}
details{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-bottom:8px}summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;gap:12px;padding:10px 12px;flex-wrap:wrap}
summary::-webkit-details-marker{display:none}.who{display:flex;flex-direction:column;min-width:0}.who small{overflow-wrap:anywhere}.meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px}
.badge{padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600}.b-ok{background:var(--ok-bg);color:var(--ok)}.b-warn{background:var(--warn-bg);color:var(--warn)}.b-bad{background:var(--bad-bg);color:var(--bad)}.b-info{background:var(--info-bg);color:var(--info)}
.body{padding:0 12px 12px;border-top:1px solid var(--line)}ul.facts,ul.q{margin:8px 0;padding-left:18px}.kind{font-size:12px;color:var(--muted)}a{color:var(--info)}
ol.tl{list-style:none;margin:0;padding:0}ol.tl li{display:grid;grid-template-columns:120px 1fr;gap:10px;padding:3px 0 3px 10px;border-left:3px solid var(--line);font-size:14px}
ol.tl li.t-ok{border-color:var(--ok)}ol.tl li.t-warn{border-color:var(--warn)}ol.tl li.t-bad{border-color:var(--bad)}@media (max-width:480px){ol.tl li{grid-template-columns:1fr;gap:0}}
</style></head><body><main>
<h1>Application history</h1><p class="muted">${s.applications} applications · updated ${when(report.generatedAt)} · regenerate with <code>npm run career-agent:history</code></p>
<section class="tiles">${tiles.map(([label, value, note]) => `<div class="tile"><span>${label}</span><b>${value}</b><small>${note}</small></div>`).join("")}</section>
<div class="cols"><section><h2>Why applications failed</h2>${failures}</section><section><h2>Daily runs</h2>${runs}</section></div>
<h2>Applications</h2>
${rows}
</main></body></html>
`;
}

function readJsonLines<T>(file: string): T[] {
  const path = resolve(file);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as T]; } catch { return []; } });
}

/** Reads local state and writes the report; used by the CLI and the daily run. */
export function writeApplicationHistoryReport(env: Record<string, string | undefined> = process.env): { path: string; report: HistoryReport } {
  const statePath = resolve(env.ATELIER_CAREER_AGENT_STATE_FILE?.trim() || STATE_FILE);
  const values = (JSON.parse(readFileSync(statePath, "utf8")) as { values: Record<string, string> }).values;
  const report = buildApplicationHistory(values, readJsonLines<InboxLogEntry>(INBOX_LOG_FILE), readJsonLines<DailyRunRecord>(DAILY_RUNS_FILE));
  const path = resolve(HISTORY_REPORT_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderApplicationHistoryHtml(report));
  return { path, report };
}
