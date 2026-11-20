import { describe, expect, it } from "vitest";
import { classifyLeverApplicationField, isPostedLocationEligibilityQuestion, optionValue, sameProviderOrigin, withinPostedSalaryRangeValueForField } from "../application-agent/src/domain/leverBrowserExecutor";
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

  it("reads Figma's location wording as a location question", () => {
    expect(classifyLeverApplicationField({ id: "question_1", label: "From where do you intend to work? *", type: "text" })).toBe("location");
    expect(classifyLeverApplicationField({ id: "question_2", label: "Where do you plan to work?", type: "text" })).toBe("location");
    expect(classifyLeverApplicationField({ id: "question_3", label: "Where do you see yourself in five years?", type: "textarea" })).not.toBe("location");
  });

  it("picks 'not a protected veteran' over 'a veteran but not a protected veteran' (Twilio)", () => {
    const options = [
      "I am not a protected veteran",
      "I identify as one or more of the classifications of a protected veteran",
      "I identify as a veteran but not a protected veteran",
      "I don't wish to answer",
    ].map((label) => ({ label, value: label }));
    const field = { id: "75377", label: "Protected Veteran Status*", type: "select" as const, required: true, classification: "demographic" as const, options };
    expect(optionValue(field, "No, I am not a protected veteran")).toBe("I am not a protected veteran");
    expect(optionValue({ ...field, options: [{ label: "Yes", value: "Yes" }, { label: "No, I am not a veteran", value: "No, I am not a veteran" }] }, "No, I am not a protected veteran"))
      .toBe("No, I am not a veteran");
  });

  it("recognizes 'are you in the job's location?' Yes/No questions (CircleCI, 2026-11-18)", () => {
    const yesNo = [{ label: "Yes", value: "Yes" }, { label: "No", value: "No" }];
    const ask = (label: string, options = yesNo) => isPostedLocationEligibilityQuestion({ label, options });
    expect(ask("Are you located in and willing to work in the location where the job is posted (Remote, US/UK/CAN)?*")).toBe(true);
    expect(ask("Are you willing to work in the location where the role is based?")).toBe(true);
    expect(ask("Are you located in the location where the job is posted?", [{ label: "Pittsburgh", value: "Pittsburgh" }, { label: "Other", value: "Other" }])).toBe(false);
    expect(ask("Are you willing to relocate?")).toBe(false);
  });

  it("answers 'salary within the posted band?' with Yes, not the figure, and reads 'do not identify as a protected veteran' (CircleCI)", () => {
    const label = "Are your salary expectations for this role within the posted salary band (if applicable)?*";
    expect(classifyLeverApplicationField({ id: "q", label, type: "text" })).not.toBe("salary");
    expect(classifyLeverApplicationField({ id: "s", label: "What are your salary expectations?", type: "text" })).toBe("salary");
    const request = (compensation?: { minimum: number; maximum: number }) => ({
      profile: { workPreferences: { salaryStrategy: "posting_midpoint" } }, careerJob: { job: { ...(compensation ? { compensation } : {}) } },
    }) as never;
    const field = { id: "q", label, type: "text" as const, required: true, classification: "unknown" as const };
    expect(withinPostedSalaryRangeValueForField(field, request({ minimum: 130000, maximum: 175000 }))).toBe("Yes");
    expect(withinPostedSalaryRangeValueForField(field, request())).toBeUndefined();

    const veteran = { id: "v", label: "Are you a veteran?", type: "select" as const, required: false, classification: "demographic" as const,
      options: ["I identify as one or more of the classifications of a protected veteran", "I do not identify as a protected veteran", "Prefer not to answer"].map((option) => ({ label: option, value: option })) };
    expect(optionValue(veteran, "No, I am not a protected veteran")).toBe("I do not identify as a protected veteran");
  });
});
