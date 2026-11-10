import { describe, expect, it } from "vitest";
import type { CareerJob } from "../application-agent/src/domain/campaignTypes";
import { renderWaitingBoard, waitingBoardItems, waitingBoardSignature } from "../application-agent/src/domain/waitingBoard";

const now = new Date("2026-11-04T23:55:00.000Z");
const question = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  id, kind: "unknown_form_field", unit: "submission", field: id, question: text, evidence: ["field-type:text"], status: "open",
  resumeAfterHuman: true, context: {}, reason: "", createdAt: "2026-11-04T23:00:00.000Z", ...extra,
});
function job(id: string, company: string, title: string, status: string, blockers: unknown[], updatedAt = "2026-11-04T23:30:00.000Z"): CareerJob {
  return { id, campaignId: "c", applicationId: `app-${id}`, status, blockers, updatedAt, job: { company, title } } as unknown as CareerJob;
}
const askable = () => true;

describe("Waiting on you board", () => {
  it("shows a dropped résumé as something to attach, not a question called Résumé", () => {
    const board = waitingBoardItems([job("mission", "Mission Underwriting Services", "Applied AI Engineer", "needs_input", [question("field-1", "Résumé", { kind: "resume_missing" })])], [], askable, now);
    expect(board.items[0]!.questions).toEqual(["Résumé upload didn't stick: attach it in the window, then reply DONE"]);
  });

  it("lists recent waiting applications from job state, verify and Submit first, with every open question", () => {
    const jobs = [
      job("mid", "Sparksoft Corporation", "Full Stack Developer - Mid-Level", "needs_input", [
        question("salary", "What is your target salary range for this role?*"),
        question("done", "Clearance?", { status: "resolved" }),
      ]),
      job("arize", "Arize AI", "DevOps Engineer", "needs_input", [
        question("code", "Authenticate the application session in the browser", { kind: "external_login", evidence: ["submit:clicked"], resumeAfterHuman: false }),
      ]),
      job("ready", "Phantom", "AI Engineer", "ready_to_submit", []),
      job("old", "Tebra", "Software Engineer I", "needs_input", [question("q", "Anything?")], "2026-09-23T00:00:00.000Z"),
      job("applied", "Kapitus", "Software Engineer II", "applied", []),
    ];
    const events = [{ jobId: "mid", status: "open", providerDelivery: { channelId: "C1", messageTs: "111.1", threadTs: "100.1" } }];
    const board = waitingBoardItems(jobs, events, askable, now);
    expect(board.items.map((item) => [item.company, item.state])).toEqual([
      ["Arize AI", "verify"], ["Phantom", "submit"], ["Sparksoft Corporation", "questions"],
    ]);
    expect(board.items[2]).toMatchObject({ questions: ["What is your target salary range for this role?"], link: "100.1" });
    expect(board.olderCount).toBe(1);

    const text = renderWaitingBoard(board, now, (ts) => ts === "100.1" ? "https://example.slack.com/archives/C1/p1001" : undefined).text;
    expect(text).toContain("*Waiting on you* (3)");
    expect(text).toContain("*Sparksoft Corporation — Full Stack Developer - Mid-Level*: 1 question · <https://example.slack.com/archives/C1/p1001|open>");
    expect(text).toContain("– What is your target salary range for this role?");
    expect(text).toContain("*Phantom — AI Engineer*: ready, click Submit on the form in its browser window");
    expect(text).toContain("submitted, needs your check");
    expect(text).toContain("1 older application stalled");
  });

  it("marks a question that never reached Slack, and says when nothing is waiting", () => {
    const board = waitingBoardItems([job("mid", "Sparksoft", "Mid", "needs_input", [question("salary", "Salary?")])], [], askable, now);
    expect(renderWaitingBoard(board, now, () => undefined).text).toContain("1 question (posting it now)");
    expect(renderWaitingBoard(waitingBoardItems([], [], askable, now), now, () => undefined).text).toMatch(/^\*Waiting on you:\* nothing right now/);
  });

  it("changes signature only when what is waiting changes, not with the clock", () => {
    const jobs = [job("mid", "Sparksoft", "Mid", "needs_input", [question("salary", "Salary?")])];
    const first = waitingBoardSignature(waitingBoardItems(jobs, [], askable, now));
    expect(waitingBoardSignature(waitingBoardItems(jobs, [], askable, new Date(now.getTime() + 60_000)))).toBe(first);
    expect(waitingBoardSignature(waitingBoardItems([job("mid", "Sparksoft", "Mid", "ready_to_submit", [])], [], askable, now))).not.toBe(first);
  });
});
