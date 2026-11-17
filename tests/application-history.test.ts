/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { buildApplicationHistory, renderApplicationHistoryHtml } from "../application-agent/automation/applicationHistory";

const meta = { company: "Upstart", role: "DevOps Engineer II" };
const event = (type: string, minute: number, metadata: Record<string, string> = {}, applicationId: string | undefined = "app-1") => ({
  id: `${type}-${minute}`, type, ...(applicationId ? { applicationId } : {}), jobId: "job-1", occurredAt: new Date(Date.UTC(2026, 10, 2, 15, minute)).toISOString(), metadata: { ...meta, ...metadata },
});

const values = {
  "atelier.application-agent.applications.v0": JSON.stringify([
    { id: "app-1", status: "applied", createdAt: "2026-11-02T15:00:00.000Z", updatedAt: "2026-11-02T15:30:00.000Z", job: { company: "Upstart", title: "DevOps Engineer II", ats: "Greenhouse", applicationUrl: "https://job-boards.greenhouse.io/upstart/jobs/1" }, fit: { classification: "good" }, resume: { familyLabel: "Cloud / Platform" }, answers: [{ field: "phone", value: "412-555-0100" }] },
    { id: "app-2", status: "failed", createdAt: "2026-11-02T15:00:00.000Z", updatedAt: "2026-11-02T15:05:00.000Z", job: { company: "Drivetrain", title: "Frontend <Engineer>" } },
    { id: "app-x", isExample: true, status: "applied", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", job: { company: "Example", title: "Example" } },
  ]),
  "atelier.application-agent.career-jobs.v0": JSON.stringify([{ id: "job-1", applicationId: "app-1", status: "applied" }]),
  "atelier.application-agent.career-events.v0": JSON.stringify([
    event("job.discovered", 0, {}, undefined),
    event("application.execution_started", 1),
    event("application.form_inspected", 2, { fieldsDetected: "18", fieldsFilled: "13" }),
    event("application.form_inspected", 3, { fieldsDetected: "18", fieldsFilled: "15" }),
    event("application.needs_input", 4, { reason: "unknown_form_field,unknown_form_field,salary" }),
    event("application.ready_to_submit", 13),
    event("application.applied", 14, { reason: "external" }),
    { ...event("application.failed", 5, { reason: "locator.evaluateAll: Target page, context or browser has been closed" }), applicationId: "app-2" },
    { ...event("application.execution_paused", 4, { blocker: "captcha" }), applicationId: "app-2" },
  ]),
  "atelier.application-agent.campaigns.v0": JSON.stringify([{ attentionEvents: [
    { applicationId: "app-1", createdAt: "2026-11-02T15:04:00.000Z", status: "resolved", blockerType: "salary", question: { prompt: "Expected compensation" } },
    { applicationId: "app-2", createdAt: "2026-11-02T15:04:00.000Z", status: "open", blockerType: "captcha", question: { prompt: "Complete the CAPTCHA" } },
  ] }]),
};

describe("application history", () => {
  const report = buildApplicationHistory(values, [{ at: "2026-11-02T20:13:30.000Z", action: "updated", kind: "rejection", company: "Upstart", role: "DevOps Engineer II", status: "Rejected", email: "Follow up from Upstart" }], [], new Date("2026-11-02T21:00:00Z"));
  const upstart = report.applications.find((app) => app.company === "Upstart")!;

  it("scores the agent from its own event log and the inbox outcome", () => {
    expect(report.score).toMatchObject({ applications: 2, started: 1, reachedSubmit: 1, submitted: 1, provenByPage: 1, fieldsFilled: 15, fieldsDetected: 18, questionsAsked: 1, captchas: 1, failed: 1, rejected: 1 });
    expect(upstart).toMatchObject({ outcome: "Rejected", submitProof: "page", minutesToReady: 12, questions: [{ prompt: "Expected compensation", kind: "salary", status: "resolved" }] });
    expect(report.failureReasons).toEqual([{ reason: "browser window closed", count: 1 }]);
  });

  it("collapses repeated form reads and words each step plainly", () => {
    expect(upstart.events.map((item) => [item.label, item.count])).toEqual([
      ["Job found", 1],
      ["Started filling the form", 1],
      ["Read the form: 15 of 18 fields filled", 2],
      ["Asked you 3 things (unknown form question, salary)", 1],
      ["Ready for your Submit tap", 1],
      ["Applied: confirmed on the page", 1],
    ]);
  });

  it("renders escaped HTML without answer values", () => {
    const html = renderApplicationHistoryHtml(report);
    expect(html).toContain("Frontend &lt;Engineer&gt;");
    expect(html).toContain("Expected compensation");
    expect(html).not.toContain("412-555-0100");
    expect(html).not.toContain("Example");
  });
});
