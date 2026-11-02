/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { formatDailySummary, pickJobsToStart, runDailyCycle, type CommandResult, type QueueJob } from "../application-agent/automation/dailyCycle";

const job = (jobId: string, overrides: Partial<QueueJob> = {}): QueueJob => ({
  jobId, company: `Co ${jobId}`, role: "Software Engineer", jobLink: `https://job-boards.greenhouse.io/co/jobs/${jobId.replace(/\D/g, "") || 1}`, status: "Ready", fit: "Good", priority: "Medium", ...overrides,
});

describe("daily cycle job selection", () => {
  it("starts only ready jobs with a supported form, best fit first, skipping part-time and contract roles", () => {
    const picked = pickJobsToStart([
      job("j1"),
      job("j2", { fit: "Excellent", priority: "High" }),
      job("j3", { status: "Needs Input", fit: "Excellent" }),
      job("j4", { jobLink: "https://www.linkedin.com/jobs/view/4" , fit: "Excellent" }),
      job("j5", { role: "Part-Time Frontend Engineer", fit: "Excellent" }),
      job("j6", { role: "Cloud Engineer (Contract)", fit: "Excellent" }),
      job("j7", { jobLink: "https://jobs.ashbyhq.com/co/7f1c2a9e-0000-4000-8000-000000000007", fit: "Stretch" }),
    ], 5);
    expect(picked.map((item) => item.jobId)).toEqual(["j2", "j1", "j7"]);
    expect(pickJobsToStart([job("j1")], 0)).toEqual([]);
  });
});

function fakeRunner(outputs: Record<string, CommandResult>) {
  const calls: string[] = [];
  return {
    calls,
    run: async (script: string, args: readonly string[]): Promise<CommandResult> => {
      const key = `${script} ${args.join(" ")}`;
      calls.push(key);
      const match = Object.keys(outputs).find((prefix) => key.startsWith(prefix));
      return match ? outputs[match]! : { code: 0, stdout: "" };
    },
  };
}

describe("daily cycle", () => {
  const jobs = [job("j1", { company: "Sparksoft", role: "Jr. Full Stack Engineer", fit: "Excellent" }), job("j2", { company: "Thumbtack" }), job("j3", { company: "Arize AI" })];

  it("finds jobs, checks the inbox, and starts applications into the free browser windows", async () => {
    const runner = fakeRunner({
      "career-agent:discover": { code: 0, stdout: "+ Pinecone | Platform Engineer | Remote | Good | cloud | https://x\n[career-agent-discover] 9 jobs found; 1 new, 1 added to the tracker.\n" },
      "career-agent:queue --import-tracker": { code: 0, stdout: `${JSON.stringify({ mode: "tracker-import", promoted: 1 })}\n` },
      "career-agent:inbox": { code: 0, stdout: "~ row 70 Upstart — DevOps Engineer II: Rejected [rejection] Follow up from Upstart (2026-11-02)\n" },
      "career-agent:queue --list": { code: 0, stdout: `${JSON.stringify({ sheetTab: "Application Queue", jobs })}\n` },
      "career-agent:queue --processor": { code: 0, stdout: `${JSON.stringify({ queue: { claimed: "j1", status: "Needs Input", idle: false } })}\n` },
    });
    const notices: string[] = [];
    const record = await runDailyCycle({ run: runner.run, hostCapacity: async () => ({ active: 1, max: 3 }), notify: async (text) => { notices.push(text); }, now: () => new Date("2026-11-02T22:30:00Z") });

    expect(runner.calls.filter((call) => call.includes("--job-id"))).toEqual([
      "career-agent:queue --processor career-service --worker-id daily-2026-11-02 --job-id j1",
      "career-agent:queue --processor career-service --worker-id daily-2026-11-02 --job-id j2",
    ]);
    expect(record.discovered).toEqual({ added: 1, jobs: ["Pinecone — Platform Engineer"] });
    expect(record.inbox).toEqual({ updates: ["Upstart — DevOps Engineer II: Rejected"], notices: 0 });
    expect(notices[0]).toContain("Found 1 new job: Pinecone — Platform Engineer");
    expect(notices[0]).toContain("Inbox: Upstart — DevOps Engineer II: Rejected");
    expect(notices[0]).toContain("Sparksoft — Jr. Full Stack Engineer: waiting on your answers");
    expect(notices[0]).toContain("1 more job waiting in the queue.");
  });

  it("keeps going when one phase fails and starts nothing while the browser host is down", async () => {
    const runner = fakeRunner({
      "career-agent:discover": { code: 1, stdout: "[career-agent-discover] Remotive request failed\n" },
      "career-agent:queue --list": { code: 0, stdout: `${JSON.stringify({ jobs })}\n` },
    });
    const record = await runDailyCycle({ run: runner.run, hostCapacity: async () => undefined });
    expect(record.discovered).toEqual({ error: "Job search exited 1: [career-agent-discover] Remotive request failed" });
    expect(runner.calls.some((call) => call.startsWith("career-agent:inbox"))).toBe(true);
    expect(runner.calls.some((call) => call.includes("--job-id"))).toBe(false);
    expect(formatDailySummary(record)).toContain("No applications started: the browser host is not running.");
  });

  it("says so when every browser window is still waiting on the user", async () => {
    const runner = fakeRunner({ "career-agent:queue --list": { code: 0, stdout: `${JSON.stringify({ jobs })}\n` } });
    const record = await runDailyCycle({ run: runner.run, hostCapacity: async () => ({ active: 3, max: 3 }) }, { phases: ["apply"] });
    expect(record.apply).toMatchObject({ started: [], waiting: 3, skippedReason: "all 3 browser windows are still waiting on you" });
  });
});
