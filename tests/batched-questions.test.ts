import { describe, expect, it } from "vitest";
import {
  ApplicationService, CareerAgentService, DEFAULT_ANSWER_POLICIES, DeterministicModelClient, InMemoryApplicationRepository, InMemoryCareerRepository,
  InMemoryNotificationAdapter, JobScout, StaticJobSource, exampleCandidateProfile,
  type ApplicationExecutionRequest, type ApplicationExecutor, type ApplicationExecutorResult, type CandidateProfile,
  type CareerBlockerDraft, type ExecutionInspection,
} from "../application-agent/src";
import { optionIdForTypedAnswer, parseNumberedReply } from "../application-agent/src/domain/attention";

const capturedAt = "2026-11-05T12:00:00.000Z";
const inspection = (): ExecutionInspection => ({ status: "inspected", fields: [], fieldsFilled: [], unresolvedFields: [], blockers: [], evidence: ["submit:not-clicked", "submission:manual-only"], durationMs: 1, domInspectionCount: 1, startedAt: capturedAt, updatedAt: capturedAt });

class NoticeAdapter extends InMemoryNotificationAdapter {
  readonly notices: string[] = [];
  async publishInfoNotice(text: string): Promise<void> { this.notices.push(text); }
}

type Question = { field: string; label: string; options?: string[]; required?: boolean; kind?: CareerBlockerDraft["kind"] };

/** A form with several questions; it reports every one still unanswered, and records what it is resumed with. */
class FormExecutor implements ApplicationExecutor {
  readonly id = "batch-executor";
  runs = 0;
  readonly received: Record<string, string> = {};
  constructor(private readonly questions: Question[]) {}
  executionMode(): "preparation_only" { return "preparation_only"; }
  async execute(request: ApplicationExecutionRequest): Promise<ApplicationExecutorResult> {
    this.runs += 1;
    const answered = (field: string) => request.careerJob.blockers.find((blocker) => blocker.field === field && blocker.status === "resolved");
    for (const question of this.questions) { const value = answered(question.field)?.value; if (value !== undefined) this.received[question.field] = String(value); }
    const open = this.questions.filter((question) => answered(question.field)?.value === undefined);
    if (open.length === 0) return { state: "ready_to_submit", inspection: inspection() };
    const drafts: CareerBlockerDraft[] = open.map((question) => ({
      kind: question.kind ?? "unknown_form_field", unit: "submission", questionProvenance: "ATS_FORM", field: question.field, question: question.label,
      reason: "The field could not be classified safely; no value was guessed.",
      evidence: ["executor:test", `field-id:${question.field}`, `field-type:${question.options ? "select" : "text"}`, `field-required:${question.required === false ? "false" : "true"}`,
        ...(question.options ? [`options:${question.options.join("|")}`] : []), `question-prompt:${question.label}`],
      resumeAfterHuman: true,
    }));
    return { state: "requires_human", blocker: drafts[0]!, blockers: drafts };
  }
}

function setup(executor: ApplicationExecutor, resumeAttention?: (campaignId: string, jobId: string) => Promise<void>) {
  const profile = JSON.parse(JSON.stringify(exampleCandidateProfile)) as CandidateProfile;
  profile.profileKind = "private";
  profile.answerPolicies = Object.fromEntries(Object.keys(DEFAULT_ANSWER_POLICIES).map((field) => [field, "auto"])) as CandidateProfile["answerPolicies"];
  profile.approvedReusableAnswers = Object.fromEntries(Object.keys(DEFAULT_ANSWER_POLICIES).map((field) => [field, `approved ${field} answer`]));
  const notifications = new NoticeAdapter();
  const careerRepository = new InMemoryCareerRepository();
  const source = new StaticJobSource("batch-source", [{ sourceRecordId: "acme", input: { isExample: true, companyHint: "Acme", titleHint: "Platform Engineer",
    sourceUrl: "https://jobs.example.invalid/acme", applicationUrl: "https://jobs.example.invalid/acme/apply", rawText: "Acme\nPlatform Engineer\nLocation: Remote - United States\n\nRequired qualifications\n- AWS" } }]);
  let id = 0;
  const createId = (prefix: string) => `${prefix}-batch-${(id += 1)}`;
  const service = new CareerAgentService(profile, {
    applicationService: new ApplicationService(new InMemoryApplicationRepository(), profile, new DeterministicModelClient(), { now: () => capturedAt, createId }),
    careerRepository, scout: new JobScout({ [source.id]: source }, () => capturedAt), executor, notificationAdapter: notifications,
    ...(resumeAttention ? { resumeAttention } : {}),
  }, { now: () => capturedAt, createId });
  const campaign = service.createCampaign({
    name: "Batch", goal: "One message per application.", searchSources: [source.id], searchCriteria: { roleLanes: [], remoteOnly: false, employmentTypes: [] },
    fitPolicy: { strong: "pursue", good: "pursue", stretch: "pursue", weak: "pursue" },
    applicationPolicy: { autoPrepare: true, allowGroundedDrafts: false, approvedResumeFamilies: [] },
    submissionPolicy: { authority: "simulated", requireExplicitApproval: false }, dailyApplicationLimit: 1,
  });
  service.activateCampaign(campaign.id);
  return { service, campaign, notifications, careerRepository };
}

const reply = (eventId: string, text: string) => ({ eventId, selectedOption: text, actorIdentity: { provider: "slack", userId: "nate" }, respondedAt: capturedAt });
// Typed questions are batched; a choice question gets its own message with buttons (2026-11-12).
const CLEARANCE: Question = { field: "clearance", label: "Do you hold an active security clearance?", options: ["Yes", "No"] };
const QUESTIONS: Question[] = [
  { field: "notice", label: "What is your notice period?" },
  { field: "city", label: "Which city will you work from?" },
  { field: "pronouns", label: "Pronouns", required: false },
];

describe("one Slack message per application", () => {
  it("lists every open question in one message, and one numbered reply answers them all", async () => {
    const executor = new FormExecutor(QUESTIONS);
    const { service, campaign, notifications } = setup(executor);
    await service.runCampaign(campaign.id);
    expect(notifications.publishedEvents).toHaveLength(1);
    const event = notifications.publishedEvents[0]!;
    expect(event.batch?.map((item) => item.prompt)).toEqual(QUESTIONS.map((question) => question.label));
    expect(event.batch?.[2]).toMatchObject({ required: false });

    const result = await service.resolveAttentionResponse(reply(event.id, "1. two weeks\n2. Pittsburgh, PA\n3. SKIP"));
    expect(result.status).toBe("resolved");
    // No second or third Slack question; every answer reached the form.
    expect(notifications.publishedEvents).toHaveLength(1);
    expect(executor.received).toMatchObject({ notice: "two weeks", city: "Pittsburgh, PA" });
    expect(service.listJobs(campaign.id)[0]!.status).toBe("ready_to_submit");
  });

  it("keeps a choice question out of the batch and asks it on its own, with its choices", async () => {
    const executor = new FormExecutor([QUESTIONS[1]!, CLEARANCE, QUESTIONS[0]!]);
    const { service, campaign, notifications } = setup(executor);
    await service.runCampaign(campaign.id);
    const event = notifications.publishedEvents[0]!;
    expect(event.batch?.map((item) => item.prompt)).toEqual([QUESTIONS[1]!.label, QUESTIONS[0]!.label]);
    await service.resolveAttentionResponse(reply(event.id, "1. Pittsburgh, PA 2. two weeks"));
    const asked = notifications.publishedEvents.at(-1)!;
    expect(asked.question?.prompt).toBe("Do you hold an active security clearance?");
    expect(asked.question?.options.map((option) => option.label)).toEqual(["Yes", "No"]);
    expect(asked.batch).toBeUndefined();
    expect(service.listJobs(campaign.id)[0]!.status).toBe("needs_input");
  });

  it("saves later answers when question 1 is left out, and uses them once it is answered", async () => {
    const executor = new FormExecutor(QUESTIONS.slice(0, 2));
    const { service, campaign, notifications } = setup(executor);
    await service.runCampaign(campaign.id);
    const event = notifications.publishedEvents[0]!;
    expect((await service.resolveAttentionResponse(reply(event.id, "2. Pittsburgh, PA"))).status).toBe("partial");
    expect(notifications.notices.at(-1)).toMatch(/Question 1 still needs one/);
    await service.resolveAttentionResponse(reply(event.id, "1. two weeks"));
    expect(executor.received).toMatchObject({ notice: "two weeks", city: "Pittsburgh, PA" });
    expect(notifications.publishedEvents).toHaveLength(1);
  });

  it("with a live browser waiting, answers every question and resumes the browser once, at the end", async () => {
    let resumes = 0;
    const { service, campaign, notifications, careerRepository } = setup(new FormExecutor(QUESTIONS), async () => { resumes += 1; });
    await service.runCampaign(campaign.id);
    const job = service.listJobs(campaign.id)[0]!;
    careerRepository.saveJob({ ...job, execution: { status: "waiting_for_human", mode: "real_local", hostExecutionId: "execution-batch-1",
      fieldsDetected: QUESTIONS.map((question) => question.field), fieldsFilled: [], unresolvedFields: QUESTIONS.map((question) => question.field),
      evidence: ["submit:not-clicked"], startedAt: capturedAt, updatedAt: capturedAt } } as never);
    const event = notifications.publishedEvents[0]!;
    await service.resolveAttentionResponse(reply(event.id, "1. two weeks 2. Pittsburgh, PA 3. SKIP"));
    expect(resumes).toBe(1);
    expect(notifications.publishedEvents).toHaveLength(1);
    const blockers = service.getJob(job.id).blockers;
    expect(blockers.map((blocker) => [blocker.field, blocker.status])).toEqual([["notice", "resolved"], ["city", "resolved"], ["pronouns", "resolved"]]);
    expect(service.listAttentionEvents(campaign.id).every((attention) => attention.status === "resolved")).toBe(true);
  });

  it("doesn't re-post a question answered while the browser is still filling it in", async () => {
    // Samsara (2026-11-12): the minute check re-posted a question during the run, so the tap looked ignored.
    const { service, campaign, notifications, careerRepository } = setup(new FormExecutor([CLEARANCE]), async () => undefined);
    await service.runCampaign(campaign.id);
    const event = notifications.publishedEvents[0]!;
    await service.resolveAttentionResponse(reply(event.id, "yes"));
    const job = service.listJobs(campaign.id)[0]!;
    const later = new Date(Date.parse(capturedAt) + 60_000).toISOString();
    const reopen = (status: string) => careerRepository.saveJob({ ...service.getJob(job.id), status: "needs_input",
      blockers: service.getJob(job.id).blockers.map((blocker) => ({ ...blocker, status: "open" as const })),
      execution: { status, mode: "real_local", hostExecutionId: "execution-race-1", fieldsDetected: [], fieldsFilled: [], unresolvedFields: [],
        evidence: ["submit:not-clicked"], startedAt: capturedAt, updatedAt: later } } as never);
    reopen("resuming");
    const before = notifications.publishedEvents.length;
    expect(await service.publishUnaskedAttention(capturedAt)).toBe(0);
    expect(notifications.publishedEvents.length).toBe(before);
    // Once the run has finished and still reports the question, it is asked again.
    reopen("waiting_for_human");
    expect(await service.publishUnaskedAttention(capturedAt)).toBe(1);
  });

  it("keeps the single-question message when only one question is open", async () => {
    const { service, campaign, notifications } = setup(new FormExecutor([QUESTIONS[1]!]));
    await service.runCampaign(campaign.id);
    expect(notifications.publishedEvents[0]!.batch).toBeUndefined();
    const result = await service.resolveAttentionResponse(reply(notifications.publishedEvents[0]!.id, "1. Pittsburgh"));
    expect(result.status).toBe("resolved");
  });
});

describe("numbered reply parsing", () => {
  it("splits by climbing numbers on one line or many, and ignores numbers inside answers", () => {
    expect([...parseNumberedReply("1. Yes\n2) 3-5 years\n3: SKIP", 3).answers]).toEqual([[1, "Yes"], [2, "3-5 years"], [3, "SKIP"]]);
    expect([...parseNumberedReply("1. I have 2. years? no 2. No", 2).answers]).toEqual([[1, "I have"], [2, "years? no 2. No"]]);
    expect(parseNumberedReply("No", 3)).toEqual({ numbered: false, answers: new Map() });
    expect(parseNumberedReply("I worked there 3. years", 3).numbered).toBe(false);
    expect([...parseNumberedReply("2. Remote", 3).answers]).toEqual([[2, "Remote"]]);
  });

  it("matches a typed choice by label or a lone yes/no", () => {
    const options = [{ id: "yes", label: "Yes, I am" }, { id: "no", label: "No, I am not" }];
    expect(optionIdForTypedAnswer(options, "no")).toBe("no");
    expect(optionIdForTypedAnswer(options, "Yes, I am.")).toBe("yes");
    expect(optionIdForTypedAnswer(options, "maybe")).toBeUndefined();
  });

  it("matches a reply that clearly names one choice, and never guesses between several", () => {
    // Samsara (2026-11-12): "1. Acknowledge" was rejected for "Acknowledge/Confirm".
    expect(optionIdForTypedAnswer([{ id: "ack", label: "Acknowledge/Confirm" }], "Acknowledge")).toBe("ack");
    expect(optionIdForTypedAnswer([{ id: "ack", label: "Acknowledge/Confirm" }], "acknowledge / confirm")).toBe("ack");
    const sources = ["Samsara Careers Site", "LinkedIn Jobs", "LinkedIn Post", "LinkedIn InMail / Message from a Recruiter", "Indeed / Glassdoor", "BuiltIn"]
      .map((label, index) => ({ id: `o${index}`, label }));
    expect(optionIdForTypedAnswer(sources, "Indeed")).toBe("o4");
    expect(optionIdForTypedAnswer(sources, "BuiltIn")).toBe("o5");
    expect(optionIdForTypedAnswer(sources, "LinkedIn")).toBeUndefined();
    expect(optionIdForTypedAnswer(sources, "Li")).toBeUndefined();
    // Slack's curly apostrophe (Samsara, 2026-11-12).
    expect(optionIdForTypedAnswer([{ id: "new", label: "I wasn't familiar with Samsara before applying" }], "I wasn’t familiar with Samsara before applying")).toBe("new");
  });
});
