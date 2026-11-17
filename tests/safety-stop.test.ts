import { describe, expect, it } from "vitest";
import { sameProviderOrigin } from "../application-agent/src/domain/leverBrowserExecutor";
import { SlackNotificationAdapter } from "../application-agent/automation/slack/slackNotificationAdapter";
import type { AttentionEvent } from "../application-agent/src/domain/attention";

describe("form safety stops (Figma, 2026-11-17)", () => {
  it("treats Greenhouse's old and new board hosts as one provider", () => {
    expect(sameProviderOrigin("https://job-boards.greenhouse.io", "https://boards.greenhouse.io")).toBe(true);
    expect(sameProviderOrigin("https://boards.greenhouse.io", "https://boards.greenhouse.io")).toBe(true);
    expect(sameProviderOrigin("https://evil.example", "https://boards.greenhouse.io")).toBe(false);
    expect(sameProviderOrigin("https://greenhouse.io.evil.example", "https://boards.greenhouse.io")).toBe(false);
    expect(sameProviderOrigin("http://job-boards.greenhouse.io", "https://boards.greenhouse.io")).toBe(false);
    expect(sameProviderOrigin("https://jobs.lever.co", "https://jobs.ashbyhq.com")).toBe(false);
  });

  it("explains a safety stop in Slack instead of asking for an answer", async () => {
    const bodies: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config: { botToken: "bot", appToken: "app", channelId: "C123456", allowedUserId: "U123456", allowedTeamId: "T123456", apiBaseUrl: "https://slack.test/api" },
      fetcher: async (_input, init) => {
        bodies.push(typeof init?.body === "string" ? init.body : "");
        return { ok: true, status: 200, json: async () => ({ ok: true, ts: "1710000000.000002" }) } as Response;
      },
    });
    const stop: AttentionEvent = {
      id: "attention-stop", type: "needs_input", source: "career-agent", campaignId: "campaign-1", applicationId: "application-1",
      createdAt: "2026-11-17T12:00:00.000Z", status: "open", title: "Career Agent needs input",
      context: { company: "Figma", role: "Software Engineer" },
      questionProvenance: "POLICY", blockerType: "unknown_form_field",
      question: { prompt: "Stopped before filling anything: this form sends applications to forms.example.com, not boards.greenhouse.io, and the agent won't send your details to a site it can't verify.", kind: "free_text", options: [] },
    };
    await adapter.publishAttentionEvent(stop);
    expect(bodies[0]).toContain("Stopped before filling anything");
    expect(bodies[0]).toContain("Nothing to answer here");
    expect(bodies[0]).not.toContain("one grounded answer");
    expect(bodies[0]).not.toContain("needs your review before continuing");
  });
});
