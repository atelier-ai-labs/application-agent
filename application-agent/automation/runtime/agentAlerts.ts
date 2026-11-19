import type { KeyValueStorage } from "../../src/persistence/storage";

/**
 * Alerts for things that need Nate's attention, so a stall or a broken login
 * doesn't sit unnoticed (2026-11-18). On 11-16 the Google login expired and the
 * whole daily run failed with a summary line that only said "Job search exited
 * 1"; on 11-18 a CircleCI fill sat stuck for ten minutes and only a
 * conversation noticed.
 *
 * Every alert says what happened, what the agent already did, and what (if
 * anything) to do. Each one has a key, and the same key is posted at most
 * once per `repeatAfterMs` (a day by default), so a problem that lasts doesn't
 * flood the channel. A quiet day posts nothing.
 */
export interface AgentAlert {
  /** Stable identity for de-duplication, e.g. "daily:google-login". */
  key: string;
  title: string;
  detail: string;
  /** What Nate should do; omitted when nothing is needed. */
  action?: string;
  repeatAfterMs?: number;
}

export interface AlertSink {
  publishInfoNotice(text: string): Promise<void>;
}

const SENT_KEY = "atelier.application-agent.alerts-sent.v0";
const DAY_MS = 24 * 60 * 60 * 1_000;

export function formatAlerts(alerts: readonly AgentAlert[]): string {
  const blocks = alerts.map((alert) => [
    `⚠️ *${alert.title}*`,
    alert.detail,
    ...(alert.action ? [`_What to do:_ ${alert.action}`] : []),
  ].join("\n"));
  return [`*The application agent needs your attention*`, ...blocks].join("\n\n");
}

export class AgentAlerts {
  constructor(
    private readonly sink: AlertSink | undefined,
    private readonly storage?: KeyValueStorage,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Posts the alerts not already posted recently; returns the ones posted. */
  async raise(alerts: readonly AgentAlert[]): Promise<AgentAlert[]> {
    if (!this.sink || alerts.length === 0) return [];
    const sent = this.readSent();
    const nowMs = this.now().getTime();
    const fresh = alerts.filter((alert) => {
      const last = sent[alert.key];
      return last === undefined || nowMs - Date.parse(last) >= (alert.repeatAfterMs ?? DAY_MS);
    });
    if (fresh.length === 0) return [];
    await this.sink.publishInfoNotice(formatAlerts(fresh));
    const stamp = this.now().toISOString();
    for (const alert of fresh) sent[alert.key] = stamp;
    // Forget keys older than a week so the record stays small.
    for (const [key, at] of Object.entries(sent)) if (nowMs - Date.parse(at) > 7 * DAY_MS) delete sent[key];
    this.storage?.setItem(SENT_KEY, JSON.stringify(sent));
    return fresh;
  }

  private readSent(): Record<string, string> {
    try {
      const raw = this.storage?.getItem(SENT_KEY);
      const parsed = raw ? JSON.parse(raw) as unknown : {};
      return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
    } catch {
      return {};
    }
  }
}

/** One phase of the daily run, as its record stores it. */
export interface DailyPhaseOutcome { phase: string; label: string; error: string }

const GOOGLE_LOGIN = /google sheets authorization expired or was revoked|invalid_grant|career-agent:google-auth/i;

/** Alerts for a daily run: a broken phase (named plainly) and dead job sources. */
export function dailyRunAlerts(failed: readonly DailyPhaseOutcome[], sourceProblems: readonly string[]): AgentAlert[] {
  const alerts: AgentAlert[] = [];
  const googlePhases = failed.filter((outcome) => GOOGLE_LOGIN.test(outcome.error));
  if (googlePhases.length > 0) {
    alerts.push({
      key: "daily:google-login",
      title: "The Google login expired",
      detail: `Nothing that reads your Sheet or Gmail could run tonight (${googlePhases.map((outcome) => outcome.label).join(", ")}).`,
      action: "Run `npm run career-agent:google-auth` and approve the Google screen. Tomorrow's run picks up from there.",
    });
  }
  for (const outcome of failed.filter((candidate) => !GOOGLE_LOGIN.test(candidate.error))) {
    alerts.push({
      key: `daily:${outcome.phase}`,
      title: `Tonight's ${outcome.label.toLowerCase()} failed`,
      detail: outcome.error.slice(0, 300),
      action: "The rest of the run still went ahead. If this repeats tomorrow, ask Claude to look at it.",
    });
  }
  for (const problem of sourceProblems) {
    const source = problem.split(":")[0]?.trim() || problem.slice(0, 40);
    alerts.push({
      key: `source:${source}`,
      title: `A job source isn't working: ${source}`,
      detail: problem.slice(0, 300),
      action: "Nothing is broken on your side; the search just covers fewer jobs until it's fixed. Ask Claude when convenient.",
      repeatAfterMs: 7 * DAY_MS,
    });
  }
  return alerts;
}

/** A browser run that failed for a reason other than the normal 4-hour window close. */
export function failedRunAlert(input: { executionId: string; company: string; role: string; reason: string }): AgentAlert | undefined {
  if (/timed out; no application was submitted/i.test(input.reason)) return undefined;
  return {
    key: `run:${input.executionId}`,
    title: `${input.company} — ${input.role} stopped`,
    detail: `${input.reason.slice(0, 300)}${/nothing was submitted|no application was submitted/i.test(input.reason) ? "" : " Nothing was submitted."}`,
    action: "Ask Claude to reopen it, or skip the job.",
  };
}

/** The Slack listener restarting over and over (systemd brings it back each time). */
export function crashLoopAlert(startTimes: readonly string[], now: Date, windowMs = 15 * 60 * 1_000, threshold = 3): AgentAlert | undefined {
  const recent = startTimes.filter((at) => now.getTime() - Date.parse(at) <= windowMs);
  if (recent.length < threshold) return undefined;
  return {
    key: "listener:crash-loop",
    title: "The Slack listener keeps restarting",
    detail: `It started ${recent.length} times in the last ${Math.round(windowMs / 60_000)} minutes, so something makes it crash on start. Slack questions and buttons may not respond.`,
    action: "Ask Claude to check `journalctl --user -u atelier-career-agent`.",
    repeatAfterMs: 6 * 60 * 60 * 1_000,
  };
}

/** The local model not answering: every recent call timed out or errored. */
export function modelHealthAlert(records: readonly { at: string; outcome: string }[], now: Date, windowMs = 60 * 60 * 1_000, minimumCalls = 3): AgentAlert | undefined {
  const recent = records.filter((record) => now.getTime() - Date.parse(record.at) <= windowMs);
  if (recent.length < minimumCalls) return undefined;
  const failing = recent.filter((record) => record.outcome === "timeout" || /^(?:error|http_)/.test(record.outcome));
  if (failing.length !== recent.length) return undefined;
  return {
    key: "model:not-answering",
    title: "The local model isn't answering",
    detail: `All ${recent.length} calls in the last hour timed out or failed. Until it's back, saved-answer matching and essay drafts don't work, so more questions come to you.`,
    action: "Check that Ollama is running (`systemctl status ollama`), or ask Claude.",
    repeatAfterMs: 6 * 60 * 60 * 1_000,
  };
}
