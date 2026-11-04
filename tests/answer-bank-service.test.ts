import { describe, expect, it } from "vitest";
import {
  ApplicationService, CareerAgentService, DEFAULT_ANSWER_POLICIES, DeterministicModelClient, InMemoryApplicationRepository, InMemoryCareerRepository,
  InMemoryNotificationAdapter, JobScout, StaticJobSource, exampleCandidateProfile,
  type ApplicationExecutionRequest, type ApplicationExecutor, type ApplicationExecutorResult, type CandidateProfile,
  type CareerBlockerDraft, type ExecutionInspection, type JobSourceListing,
} from "../application-agent/src";
import { InMemoryAnswerBankStore, answerBankKey, type AnswerBankEntry } from "../application-agent/src/domain/answerBank";

const capturedAt = "2026-11-03T12:00:00.000Z";

function listing(company: string): JobSourceListing {
  const slug = company.toLowerCase();
  return {
    sourceRecordId: `bank-${slug}`,
    input: {
      isExample: true, companyHint: company, titleHint: "Platform Engineer",
      sourceUrl: `https://jobs.example.invalid/${slug}`, applicationUrl: `https://jobs.example.invalid/${slug}/apply`,
      rawText: `${company}\nPlatform Engineer\nLocation: Remote - United States\n\nRequired qualifications\n- AWS\n- Kubernetes`,
    },
  };
}

function inspection(): ExecutionInspection {
  return { status: "inspected", fields: [], fieldsFilled: [], unresolvedFields: [], blockers: [], evidence: ["submit:not-clicked", "submission:manual-only"], durationMs: 1, domInspectionCount: 1, startedAt: capturedAt, updatedAt: capturedAt };
}

class NoticeCapturingAdapter extends InMemoryNotificationAdapter {
  readonly notices: string[] = [];
  async publishInfoNotice(text: string): Promise<void> { this.notices.push(text); }
}

/** One form question per job, worded with the employer's name. */
class QuestionExecutor implements ApplicationExecutor {
  readonly id = "answer-bank-executor";
  readonly received: Record<string, string> = {};
  constructor(private readonly question: (company: string) => { label: string; options: string[]; kind?: CareerBlockerDraft["kind"] }) {}
  executionMode(): "preparation_only" { return "preparation_only"; }
  async execute(request: ApplicationExecutionRequest): Promise<ApplicationExecutorResult> {
    const company = request.careerJob.job.company;
    const answered = request.careerJob.blockers.find((blocker) => blocker.field === "source" && blocker.status === "resolved");
    if (answered?.value !== undefined) {
      this.received[company] = String(answered.value);
      return { state: "ready_to_submit", inspection: inspection() };
    }
    const { label, options, kind } = this.question(company);
    return {
      state: "requires_human",
      blocker: {
        kind: kind ?? "unknown_form_field", unit: "submission", questionProvenance: "ATS_FORM", field: "source", question: label,
        reason: "The field could not be classified safely; no value was guessed.",
        evidence: ["executor:test", "field-id:source", "field-type:select", "field-required:true", `options:${options.join("|")}`, `question-prompt:${label}`],
        resumeAfterHuman: true,
      },
    };
  }
}

function setup(companies: string[], executor: ApplicationExecutor, bank: InMemoryAnswerBankStore, listings?: JobSourceListing[]) {
  const profile = JSON.parse(JSON.stringify(exampleCandidateProfile)) as CandidateProfile;
  profile.profileKind = "private";
  profile.answerPolicies = Object.fromEntries(Object.keys(DEFAULT_ANSWER_POLICIES).map((field) => [field, "auto"])) as CandidateProfile["answerPolicies"];
  profile.approvedReusableAnswers = Object.fromEntries(Object.keys(DEFAULT_ANSWER_POLICIES).map((field) => [field, `approved ${field} answer`]));
  const notifications = new NoticeCapturingAdapter();
  const source = new StaticJobSource("bank-source", listings ?? companies.map(listing));
  let id = 0;
  const createId = (prefix: string) => `${prefix}-bank-${(id += 1)}`;
  const service = new CareerAgentService(profile, {
    applicationService: new ApplicationService(new InMemoryApplicationRepository(), profile, new DeterministicModelClient(), { now: () => capturedAt, createId }),
    careerRepository: new InMemoryCareerRepository(),
    scout: new JobScout({ [source.id]: source }, () => capturedAt),
    executor, notificationAdapter: notifications, answerBank: bank,
  }, { now: () => capturedAt, createId });
  const campaign = service.createCampaign({
    name: "Answer bank", goal: "Reuse answers.", searchSources: [source.id],
    searchCriteria: { roleLanes: [], remoteOnly: false, employmentTypes: [] },
    fitPolicy: { strong: "pursue", good: "pursue", stretch: "pursue", weak: "pursue" },
    applicationPolicy: { autoPrepare: true, allowGroundedDrafts: false, approvedResumeFamilies: [] },
    submissionPolicy: { authority: "simulated", requireExplicitApproval: false },
    dailyApplicationLimit: listings?.length ?? companies.length,
  });
  service.activateCampaign(campaign.id);
  return { service, campaign, notifications };
}

/** Slack sends the option's id for a single-choice question. */
function optionId(event: { question?: { options: readonly { id: string; label: string }[] } }, label: string): string {
  const option = event.question?.options.find((candidate) => candidate.label === label);
  if (!option) throw new Error(`No option ${label}`);
  return option.id;
}

const hearAbout = (company: string) => ({ label: `How did you hear about ${company}?`, options: [`${company} Employee`, "LinkedIn", "Other"] });

describe("answer bank in the career service", () => {
  it("saves a Slack answer, then fills the same question at the next company without asking", async () => {
    const bank = new InMemoryAnswerBankStore();
    const executor = new QuestionExecutor(hearAbout);
    const first = setup(["Phantom"], executor, bank);
    await first.service.runCampaign(first.campaign.id);
    const event = first.service.listAttentionEvents(first.campaign.id)[0];
    await first.service.resolveAttentionResponse({ eventId: event.id, selectedOption: optionId(event, "Other"), actorIdentity: { provider: "test", userId: "nate" }, respondedAt: capturedAt });
    expect(executor.received.Phantom).toBe("Other");
    expect(bank.entries()).toMatchObject([{ key: "how did you hear about {company}", value: "Other", tier: "low", source: "slack", company: "Phantom" }]);

    const second = setup(["Sparksoft"], executor, bank);
    await second.service.runCampaign(second.campaign.id);
    expect(executor.received.Sparksoft).toBe("Other");
    expect(second.notifications.publishedEvents).toHaveLength(0);
    const blocker = second.service.listJobs(second.campaign.id)[0].blockers.find((candidate) => candidate.field === "source");
    expect(blocker?.evidence).toEqual(expect.arrayContaining(["answer-provider:answer-bank", "answer-bank-match:exact", "answer-bank-tier:low"]));
    expect(bank.entries()[0].usedCount).toBe(1);
  });

  it("still asks when the saved answer is not one of this form's options", async () => {
    const bank = new InMemoryAnswerBankStore([{ id: "e1", key: answerBankKey("How did you hear about Phantom?", "Phantom"), question: "How did you hear about Phantom?", value: "Another job site", tier: "low", source: "history", recordedAt: capturedAt }]);
    const executor = new QuestionExecutor(hearAbout);
    const { service, campaign, notifications } = setup(["Sparksoft"], executor, bank);
    await service.runCampaign(campaign.id);
    expect(executor.received.Sparksoft).toBeUndefined();
    expect(notifications.publishedEvents.map((event) => event.question?.prompt)).toEqual(["How did you hear about Sparksoft?"]);
  });

  it("never saves or reuses an answer to a high-risk question", async () => {
    const saved: AnswerBankEntry = { id: "e1", key: answerBankKey("Have you previously worked for Phantom?", "Phantom"), question: "Have you previously worked for Phantom?", value: "No", tier: "medium", source: "manual", recordedAt: capturedAt };
    const bank = new InMemoryAnswerBankStore([saved]);
    const executor = new QuestionExecutor((company) => ({ label: `Have you previously worked for ${company}?`, options: ["Yes", "No"] }));
    const { service, campaign, notifications } = setup(["Sparksoft"], executor, bank);
    await service.runCampaign(campaign.id);
    expect(notifications.publishedEvents.map((event) => event.question?.prompt)).toEqual(["Have you previously worked for Sparksoft?"]);
    const event = service.listAttentionEvents(campaign.id)[0];
    await service.resolveAttentionResponse({ eventId: event.id, selectedOption: optionId(event, "No"), actorIdentity: { provider: "test", userId: "nate" }, respondedAt: capturedAt });
    expect(executor.received.Sparksoft?.toLowerCase()).toBe("no");
    expect(bank.entries()).toEqual([saved]);
  });

  describe("carrying one answer to other waiting applications", () => {
    const role = (title: string): JobSourceListing => {
      const slug = title.toLowerCase().replace(/[^a-z]+/g, "-");
      return { sourceRecordId: `sparksoft-${slug}`, input: { isExample: true, companyHint: "Sparksoft", titleHint: title,
        sourceUrl: `https://jobs.example.invalid/sparksoft/${slug}`, applicationUrl: `https://jobs.example.invalid/sparksoft/${slug}/apply`,
        rawText: `Sparksoft\n${title}\nLocation: Remote - United States\n\nRequired qualifications\n- AWS` } };
    };

    /** Each form asks one text question; it records the answer it is resumed with. */
    class TextQuestionExecutor implements ApplicationExecutor {
      readonly id = "carry-over-executor";
      readonly received: Record<string, string> = {};
      constructor(private readonly label: string, private readonly kind: CareerBlockerDraft["kind"] = "unknown_form_field") {}
      executionMode(): "preparation_only" { return "preparation_only"; }
      async execute(request: ApplicationExecutionRequest): Promise<ApplicationExecutorResult> {
        const answered = request.careerJob.blockers.find((blocker) => blocker.field === "question_1" && blocker.status === "resolved");
        if (answered?.value !== undefined) {
          this.received[request.careerJob.job.title] = String(answered.value);
          return { state: "ready_to_submit", inspection: inspection() };
        }
        return { state: "requires_human", blocker: {
          kind: this.kind, unit: "submission", questionProvenance: "ATS_FORM", field: "question_1", question: this.label,
          reason: "The field could not be classified safely; no value was guessed.",
          evidence: ["executor:test", "field-id:question_1", "field-type:text", "field-required:true", `field-label:${this.label}`, "question-source:unavailable"],
          resumeAfterHuman: true,
        } };
      }
    }

    it("answers the same employer's identical question on the other waiting job and resumes it", async () => {
      const executor = new TextQuestionExecutor("Do you currently hold an active security clearance? If yes, please provide details. *");
      const { service, campaign, notifications } = setup([], executor, new InMemoryAnswerBankStore(), [role("Jr. Full Stack Developer"), role("Full Stack Developer - Mid-Level")]);
      await service.runCampaign(campaign.id);
      const events = service.listAttentionEvents(campaign.id).filter((event) => event.status === "open");
      expect(events).toHaveLength(2);
      await service.resolveAttentionResponse({ eventId: events[0]!.id, selectedOption: "No", actorIdentity: { provider: "test", userId: "nate" }, respondedAt: capturedAt });

      expect(Object.values(executor.received)).toEqual(["No", "No"]);
      const carried = service.listJobs(campaign.id).filter((job) => job.blockers.some((blocker) => blocker.evidence.includes("answer-provider:carry-over")));
      expect(carried).toHaveLength(1);
      expect(service.listJobs(campaign.id).map((job) => job.status)).toEqual(["ready_to_submit", "ready_to_submit"]);
      expect(notifications.notices.join("\n")).toMatch(/other waiting applications[\s\S]*security clearance/);
    });

    it("never carries a salary answer to another role, even at the same employer", async () => {
      const executor = new TextQuestionExecutor("What is your target salary range for this role? *", "salary");
      const { service, campaign, notifications } = setup([], executor, new InMemoryAnswerBankStore(), [role("Jr. Full Stack Developer"), role("Full Stack Developer - Mid-Level")]);
      await service.runCampaign(campaign.id);
      const events = service.listAttentionEvents(campaign.id).filter((event) => event.status === "open");
      await service.resolveAttentionResponse({ eventId: events[0]!.id, selectedOption: "75000", actorIdentity: { provider: "test", userId: "nate" }, respondedAt: capturedAt });
      expect(Object.keys(executor.received)).toHaveLength(1);
      expect(service.listJobs(campaign.id).filter((job) => job.status === "needs_input")).toHaveLength(1);
      expect(notifications.notices).toEqual([]);
    });
  });
});
