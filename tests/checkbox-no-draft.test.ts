// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { classifyLeverApplicationField } from "../application-agent/src/domain/leverBrowserExecutor";
import { SlackNotificationAdapter, quickRepliesForEvent } from "../application-agent/automation/slack/slackNotificationAdapter";
import { SqliteKeyValueStorage } from "../application-agent/automation/runtime/sqliteKeyValueStorage";
import { CareerAgentService, exampleCandidateProfile } from "../application-agent/src";
import { LocalStorageCareerRepository } from "../application-agent/src/persistence/careerRepository";
import { attentionEventForCareerBlocker, type AttentionEvent } from "../application-agent/src/domain/attention";

const prompt = "By checking this box, I confirm I have read, reviewed and understood the guidelines outlined in the Candidate AI Responsible Use Policy.";
const draft = { answer: "Since June 2026, I've been building backend APIs for PuckPulse.", evidence: ["Project — PuckPulse"], generatedAt: "2026-11-13T22:37:19.163Z", provider: "local-model" } as never;
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("no essay drafts on a checkbox (Twilio, 2026-11-17)", () => {
  it("never classifies a checkbox as an essay, however long its text", () => {
    expect(classifyLeverApplicationField({ id: "ack", label: prompt, type: "checkbox" })).not.toBe("free_text");
    expect(classifyLeverApplicationField({ id: "why", label: "Tell us why you want to work here.", type: "textarea" })).toBe("free_text");
  });

  it("drops a stored draft from a choice question when it is read back", () => {
    const dir = mkdtempSync(join(tmpdir(), "no-draft-")); directories.push(dir);
    const repository = new LocalStorageCareerRepository(new SqliteKeyValueStorage(join(dir, "state.db")));
    const service = new CareerAgentService({ ...exampleCandidateProfile }, { careerRepository: repository }, { now: () => "2026-11-17T20:40:00.000Z", createId: (p) => `${p}-1` });
    const campaign = service.createCampaign({
      name: "Twilio", goal: "g", searchSources: [],
      searchCriteria: { roleLanes: [], searchQueries: [], locations: [], remoteOnly: false, employmentTypes: [], excludedSeniorities: [], excludedCompanies: [] },
      applicationPolicy: { autoPrepare: true, allowGroundedDrafts: true, approvedResumeFamilies: [] },
      submissionPolicy: { authority: "never", requireExplicitApproval: false }, dailyApplicationLimit: 3,
    });
    const record = attentionEventForCareerBlocker({
      campaignId: campaign.id, jobId: "career-job-twilio", createdAt: "2026-11-17T20:40:00.000Z", createId: () => "attention-ack2",
      blocker: {
        id: "career-blocker-ack2", kind: "subjective_answer", unit: "submission", questionProvenance: "ATS_FORM", field: "ack2", status: "open",
        createdAt: "2026-11-17T20:40:00.000Z", question: "Acknowledge", reason: "r", resumeAfterHuman: true,
        context: { jobId: "career-job-twilio", applicationId: "application-twilio", company: "Twilio", role: "Software Engineer L3" },
        evidence: ["field-id:ack2", "field-type:checkbox", "field-label:Acknowledge", `question-prompt:${prompt}`],
      },
    })!.record;
    expect(record.question?.kind).toBe("single_choice");
    repository.replaceCampaign({ ...campaign, attentionEvents: [{ ...record, draft }] });
    const read = repository.getCampaign(campaign.id)!.attentionEvents!.find((event) => event.id === "attention-ack2")!;
    expect(read.draft).toBeUndefined();
    expect(read.question?.options.map((option) => option.label)).toEqual(["Yes", "No"]);
  });

  it("never shows a draft or an Approve button on a choice question in Slack", async () => {
    const event: AttentionEvent = {
      id: "attention-ack2", type: "needs_input", source: "career-agent", campaignId: "c", applicationId: "a", createdAt: "2026-11-17T20:40:00.000Z",
      status: "open", title: "Career Agent needs input", context: { company: "Twilio", role: "Software Engineer L3" },
      questionProvenance: "ATS_FORM", blockerType: "subjective_answer", draft,
      question: { prompt, kind: "single_choice", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }], required: true },
    };
    expect(quickRepliesForEvent(event)).not.toContain("APPROVE");
    const bodies: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config: { botToken: "bot", appToken: "app", channelId: "C123456", allowedUserId: "U123456", allowedTeamId: "T123456", apiBaseUrl: "https://slack.test/api" },
      fetcher: async (_input, init) => { bodies.push(typeof init?.body === "string" ? init.body : ""); return { ok: true, status: 200, json: async () => ({ ok: true, ts: "1.2" }) } as Response; },
    });
    await adapter.publishAttentionEvent(event);
    expect(bodies[0]).not.toContain("PuckPulse");
    expect(bodies[0]).not.toContain("Approve draft");
    expect(bodies[0]).toContain("career_agent_attention_option_0");
  });
});
