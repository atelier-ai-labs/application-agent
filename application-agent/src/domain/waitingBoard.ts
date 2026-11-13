import type { CareerBlocker, CareerJob } from "./campaignTypes";
import { isPostSubmitHumanCheck } from "./applicationReceipt";
import { isPostingUrl } from "./attention";

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
  /** Open questions: the ones its Slack message asks right now first, then the rest. */
  questions: readonly string[];
  /** How many of `questions` the open Slack message asks now (the rest come after). */
  askedCount?: number;
  /** Slack message the candidate replies to, when one was posted. */
  link?: string;
  /** The public job posting. */
  postingUrl?: string;
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
  /** The question (or numbered batch of questions) this message asks. */
  blockerId?: string;
  batchBlockerIds?: readonly string[];
}

export const WAITING_BOARD_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

const cleanQuestion = (question: string) => question.replace(/\s*\*+\s*$/, "").replace(/\s+/g, " ").trim().slice(0, 110);

/** A file to attach reads as an action, not as a question named "Résumé". */
const boardLine = (blocker: CareerBlocker) =>
  blocker.kind === "resume_missing" ? "Résumé upload didn't stick: attach it in the window, then reply DONE"
    : blocker.kind === "required_file_missing" ? "Résumé file not found: attach it in the window, then reply DONE"
      : cleanQuestion(blocker.question);

export function waitingBoardItems(
  jobs: readonly CareerJob[],
  events: readonly WaitingBoardEvent[],
  isAskable: (blocker: CareerBlocker, job: CareerJob) => boolean,
  now: Date,
  /** jobId → Slack ts of its "Application ready to submit" card. */
  reviewCards: ReadonlyMap<string, string> = new Map(),
): WaitingBoard {
  const cutoff = now.getTime() - WAITING_BOARD_RECENT_MS;
  const items: WaitingBoardItem[] = [];
  let olderCount = 0;
  for (const job of jobs) {
    if (job.status !== "needs_input" && job.status !== "ready_to_submit") continue;
    const open = job.blockers.filter((blocker) => blocker.status === "open");
    const verify = open.some(isPostSubmitHumanCheck);
    const askable = open.filter((blocker) => !isPostSubmitHumanCheck(blocker) && isAskable(blocker, job));
    // Questions the open Slack message asks now come first, in its numbering;
    // the rest are asked after (Samsara's board listed 6 while its message
    // asked 3, 2026-11-12).
    const openEvent = events.find((event) => event.jobId === job.id && event.status === "open" && event.providerDelivery?.messageTs);
    const askedIds = openEvent?.batchBlockerIds?.length ? openEvent.batchBlockerIds : openEvent?.blockerId ? [openEvent.blockerId] : [];
    const asked = askedIds.map((id) => askable.find((blocker) => blocker.id === id)).filter((blocker): blocker is CareerBlocker => Boolean(blocker));
    const questions = [...asked, ...askable.filter((blocker) => !asked.includes(blocker))].map(boardLine);
    const state: WaitingState | undefined = verify ? "verify" : job.status === "ready_to_submit" ? "submit" : questions.length > 0 ? "questions" : undefined;
    if (!state) continue;
    if (Date.parse(job.updatedAt) < cutoff) { olderCount += 1; continue; }
    const delivery = events.find((event) => event.jobId === job.id && event.status === "open" && event.providerDelivery?.messageTs)?.providerDelivery;
    const ts = state === "submit" ? reviewCards.get(job.id) ?? delivery?.threadTs ?? delivery?.messageTs : delivery?.threadTs ?? delivery?.messageTs;
    items.push({
      jobId: job.id, company: job.job.company, role: job.job.title, state, questions: state === "questions" ? questions : [],
      ...(state === "questions" && asked.length > 0 ? { askedCount: asked.length } : {}),
      ...(ts ? { link: ts } : {}),
      ...(isPostingUrl(job.job.sourceUrl ?? job.job.applicationUrl) ? { postingUrl: (job.job.sourceUrl ?? job.job.applicationUrl)! } : {}),
      since: job.updatedAt,
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
    // The job name links to the posting, so the job can be read before answering.
    const name = item.postingUrl ? `*<${item.postingUrl}|${item.company} — ${item.role}>*` : `*${item.company} — ${item.role}*`;
    const open = url ? ` · <${url}|open>` : "";
    if (item.state === "verify") return `• ${name}: submitted, needs your check (code or DONE)${open}`;
    if (item.state === "submit") return `• ${name}: ready, tap *Submit application* on its “Application ready to submit” card${open}`;
    const count = item.questions.length === 1 ? "1 question" : `${item.questions.length} questions`;
    const asked = item.askedCount ?? 0;
    if (!url || asked === 0) {
      const posted = url ? "" : " (posting it now)";
      return `• ${name}: ${count}${posted}${open}\n${item.questions.map((question) => `      – ${question}`).join("\n")}`;
    }
    // Say exactly where to reply and which questions that message asks.
    const here = asked === 1 ? "answer it here" : `answer 1–${asked} here`;
    const now = item.questions.slice(0, asked).map((question, index) => `      ${asked === 1 ? "–" : `${index + 1}.`} ${question}`).join("\n");
    const next = item.questions.slice(asked);
    return `• ${name}: ${count} · <${url}|${here}>\n${now}${next.length > 0 ? `\n      _Next:_ ${next.join(" · ")}` : ""}`;
  });
  const footer = board.olderCount > 0 ? `_${board.olderCount} older application${board.olderCount === 1 ? "" : "s"} stalled more than a week ago are not shown._` : "";
  const text = [header, ...lines, footer].filter(Boolean).join("\n");
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text: text.slice(0, 2900) } }] };
}
