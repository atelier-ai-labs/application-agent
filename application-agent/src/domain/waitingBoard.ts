import type { CareerBlocker, CareerJob } from "./campaignTypes";
import { isPostSubmitHumanCheck } from "./applicationReceipt";

/**
 * The "Waiting on you" board: one Slack message listing every recent
 * application that needs the candidate, built from job state (not from what
 * was posted), so a question that never reached Slack still shows up.
 */
export type WaitingState = "verify" | "submit" | "questions";

export interface WaitingBoardItem {
  jobId: string;
  company: string;
  role: string;
  state: WaitingState;
  /** Open questions, in the order the form asks them. */
  questions: readonly string[];
  /** Slack message the candidate replies to, when one was posted. */
  link?: string;
  since: string;
}

export interface WaitingBoard {
  items: readonly WaitingBoardItem[];
  /** Older waiting applications left off the board. */
  olderCount: number;
}

/** Open attention-event fields the board reads (a subset of the persisted record). */
export interface WaitingBoardEvent {
  jobId?: string;
  status: string;
  providerDelivery?: { channelId?: string; messageTs?: string; threadTs?: string };
}

export const WAITING_BOARD_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

const cleanQuestion = (question: string) => question.replace(/\s*\*+\s*$/, "").replace(/\s+/g, " ").trim().slice(0, 110);

export function waitingBoardItems(
  jobs: readonly CareerJob[],
  events: readonly WaitingBoardEvent[],
  isAskable: (blocker: CareerBlocker, job: CareerJob) => boolean,
  now: Date,
): WaitingBoard {
  const cutoff = now.getTime() - WAITING_BOARD_RECENT_MS;
  const items: WaitingBoardItem[] = [];
  let olderCount = 0;
  for (const job of jobs) {
    if (job.status !== "needs_input" && job.status !== "ready_to_submit") continue;
    const open = job.blockers.filter((blocker) => blocker.status === "open");
    const verify = open.some(isPostSubmitHumanCheck);
    const questions = open.filter((blocker) => !isPostSubmitHumanCheck(blocker) && isAskable(blocker, job)).map((blocker) => cleanQuestion(blocker.question));
    const state: WaitingState | undefined = verify ? "verify" : job.status === "ready_to_submit" ? "submit" : questions.length > 0 ? "questions" : undefined;
    if (!state) continue;
    if (Date.parse(job.updatedAt) < cutoff) { olderCount += 1; continue; }
    const delivery = events.find((event) => event.jobId === job.id && event.status === "open" && event.providerDelivery?.messageTs)?.providerDelivery;
    const ts = delivery?.threadTs ?? delivery?.messageTs;
    items.push({
      jobId: job.id, company: job.job.company, role: job.job.title, state, questions: state === "questions" ? questions : [],
      ...(ts ? { link: ts } : {}), since: job.updatedAt,
    });
  }
  const order: Record<WaitingState, number> = { verify: 0, submit: 1, questions: 2 };
  items.sort((left, right) => order[left.state] - order[right.state] || left.since.localeCompare(right.since));
  return { items, olderCount };
}

/** What changes the board's meaning; the "updated" time alone does not. */
export function waitingBoardSignature(board: WaitingBoard): string {
  return JSON.stringify([board.olderCount, board.items.map((item) => [item.jobId, item.state, item.questions, item.link ?? ""])]);
}

export function renderWaitingBoard(
  board: WaitingBoard,
  now: Date,
  permalink: (ts: string) => string | undefined,
  timeZone = "America/New_York",
): { text: string; blocks: unknown[] } {
  const time = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  const header = board.items.length === 0
    ? `*Waiting on you:* nothing right now · updated ${time}`
    : `*Waiting on you* (${board.items.length}) · updated ${time}`;
  const lines = board.items.map((item) => {
    const url = item.link ? permalink(item.link) : undefined;
    const name = `*${item.company} — ${item.role}*`;
    const open = url ? ` · <${url}|open>` : "";
    if (item.state === "verify") return `• ${name}: submitted, needs your check (code or DONE)${open}`;
    if (item.state === "submit") return `• ${name}: ready, tap Submit${open}`;
    const count = item.questions.length === 1 ? "1 question" : `${item.questions.length} questions`;
    const posted = url ? "" : " (posting it now)";
    return `• ${name}: ${count}${posted}${open}\n${item.questions.map((question) => `      – ${question}`).join("\n")}`;
  });
  const footer = board.olderCount > 0 ? `_${board.olderCount} older application${board.olderCount === 1 ? "" : "s"} stalled more than a week ago are not shown._` : "";
  const text = [header, ...lines, footer].filter(Boolean).join("\n");
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text: text.slice(0, 2900) } }] };
}
