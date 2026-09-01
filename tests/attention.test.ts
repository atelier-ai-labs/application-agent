import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANSWER_POLICIES,
  ApplicationService,
  CareerAgentService,
  DeterministicModelClient,
  InMemoryApplicationRepository,
  InMemoryCareerRepository,
  InMemoryNotificationAdapter,
  JobScout,
  StaticJobSource,
  exampleCandidateProfile,
  normalizeJobPosting,
  type ApplicationExecutor,
  type ApplicationExecutorResult,
  type ApplicationExecutionRequest,
  type CandidateProfile,
  type CareerBlockerDraft,
  type CareerJob,
  type ExecutionInspection,
  type JobSourceListing,
  type KeyValueStorage,
} from "../application-agent/src";
import { LocalStorageCareerRepository } from "../application-agent/src/persistence/careerRepository";

const capturedAt = "2026-09-01T12:00:00.000Z";

function clock() {
  let tick = 0;
  let sequence = 0;
  const base = Date.parse(capturedAt);
  return {
    now: () => new Date(base + tick++ * 1_000).toISOString(),
    createId: (prefix: string) => `${prefix}-attention-${++sequence}`,
  };
}

function profile(): CandidateProfile {
  const value = JSON.parse(JSON.stringify(exampleCandidateProfile)) as CandidateProfile;
  value.profileKind = "private";
  value.answerPolicies = Object.fromEntries(
    Object.keys(DEFAULT_ANSWER_POLICIES).map((field) => [field, "auto"]),
  ) as CandidateProfile["answerPolicies"];
  value.approvedReusableAnswers = Object.fromEntries(
    Object.keys(DEFAULT_ANSWER_POLICIES).map((field) => [field, `approved ${field} answer`]),
  );
  return value;
}

function listing(): JobSourceListing {
  return {
    sourceRecordId: "attention-job-1",
    input: {
      isExample: true,
      companyHint: "Example H1",
      titleHint: "Data Platform Engineer",
      sourceUrl: "https://jobs.example.invalid/attention-job-1",
      applicationUrl: "https://jobs.example.invalid/attention-job-1/apply",
      rawText: "Example H1\nData Platform Engineer\nLocation: Remote - United States\n\nBuild data systems.\n\nRequired qualifications\n- Python\n- AWS",
    },
  };
}

const fieldId = "cards_question__field0_";

function unknownBlocker(): CareerBlockerDraft {
  return {
    kind: "unknown_form_field",
    unit: "submission",
    field: fieldId,
    question: 'Required question under "Work Authorization": "Are you legally eligible to work in the US?" — choose Yes or No.',
    reason: "The field could not be classified safely; no value was guessed.",
    evidence: [
      "executor:lever-browser",
      `field-id:${fieldId}`,
      "field-type:radio",
      "field-required:true",
      "classification:unknown",
      "options:Yes|No",
      "question-prompt:Are you legally eligible to work in the US?",
      "question-section:Work Authorization",
      "question-source:question_container",
      "question-confidence:high",
    ],
    resumeAfterHuman: true,
  };
}

class UnknownQuestionExecutor implements ApplicationExecutor {
  readonly id = "attention-test-executor";

  executionMode(): "preparation_only" {
    return "preparation_only";
  }

  async execute(_request: ApplicationExecutionRequest): Promise<ApplicationExecutorResult> {
    const blocker = unknownBlocker();
    const inspection: ExecutionInspection = {
      status: "needs_input",
      fields: [{
        id: fieldId,
        label: "Yes",
        type: "radio",
        required: true,
        options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
        questionDescriptor: {
          promptText: "Are you legally eligible to work in the US?",
          sectionTitle: "Work Authorization",
          sourceStrategy: "question_container",
          confidence: "high",
        },
        classification: "unknown",
      }],
      fieldsFilled: [],
      unresolvedFields: [fieldId],
      blockers: [blocker],
      evidence: ["attention-test", "submit:not-clicked"],
      durationMs: 1,
      domInspectionCount: 1,
      startedAt: capturedAt,
      updatedAt: capturedAt,
    };
    return { state: "requires_human", blocker, blockers: [blocker], inspection };
  }
}

function setup(options: { resumeAttention?: (campaignId: string, jobId: string) => Promise<void> } = {}) {
  const candidate = profile();
  const applicationRepository = new InMemoryApplicationRepository();
  const careerRepository = new InMemoryCareerRepository();
  const notificationAdapter = new InMemoryNotificationAdapter();
  const runtime = clock();
  const applicationService = new ApplicationService(
    applicationRepository,
    candidate,
    new DeterministicModelClient(),
    runtime,
  );
  const source = new StaticJobSource("attention-source", [listing()]);
  const service = new CareerAgentService(candidate, {
    applicationService,
    careerRepository,
    scout: new JobScout({ [source.id]: source }, runtime.now),
    executor: new UnknownQuestionExecutor(),
    notificationAdapter,
    ...(options.resumeAttention ? { resumeAttention: options.resumeAttention } : {}),
  }, runtime);
  const campaign = service.createCampaign({
    name: "Attention acceptance",
    goal: "Test explicit mobile human input.",
    searchSources: [source.id],
    searchCriteria: { roleLanes: [], remoteOnly: false, employmentTypes: [] },
    fitPolicy: { strong: "pursue", good: "pursue", stretch: "pursue", weak: "pursue" },
    applicationPolicy: { autoPrepare: true, allowGroundedDrafts: true, approvedResumeFamilies: [] },
    submissionPolicy: { authority: "simulated", requireExplicitApproval: false },
    dailyApplicationLimit: 3,
  });
  return { candidate, service, campaign, careerRepository, applicationRepository, notificationAdapter };
}

async function blockedRun(options: { resumeAttention?: (campaignId: string, jobId: string) => Promise<void> } = {}) {
  const state = setup(options);
  state.service.activateCampaign(state.campaign.id);
  await state.service.runCampaign(state.campaign.id);
  const job = state.service.listJobs(state.campaign.id)[0];
  if (!job) throw new Error("The attention fixture did not create a career job.");
  return { ...state, job };
}

function makeResumable(job: CareerJob): CareerJob {
  return {
    ...job,
    execution: {
      status: "waiting_for_human" as const,
      mode: "real_local" as const,
      hostExecutionId: "execution-attention-1",
      fieldsDetected: [fieldId],
      fieldsFilled: [],
      unresolvedFields: [fieldId],
      evidence: ["submit:not-clicked"],
      startedAt: capturedAt,
      updatedAt: capturedAt,
    },
  };
}

describe("Career Agent human attention seam", () => {
  it("creates one durable needs_input event with only safe question context", async () => {
    const state = await blockedRun();
    expect(state.job.status).toBe("needs_input");
    expect(state.job.blockers[0]?.kind).toBe("unknown_form_field");
    expect(state.notificationAdapter.publishedEvents).toHaveLength(1);
    const event = state.notificationAdapter.publishedEvents[0];
    expect(event).toMatchObject({
      type: "needs_input",
      source: "career-agent",
      context: { company: "Example H1", role: "Data Platform Engineer", section: "Work Authorization" },
      question: {
        prompt: "Are you legally eligible to work in the US?",
        kind: "single_choice",
        options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
      },
      blockerType: "unknown_form_field",
    });
    expect(JSON.stringify(event)).not.toContain(state.candidate.identity.email ?? "never");
    expect(state.service.listAttentionEvents(state.campaign.id)).toHaveLength(1);
    expect(state.service.getCampaign(state.campaign.id).attentionEvents?.[0].publishedAt).toBeDefined();
  });

  it("does not publish a duplicate open event on a later campaign cycle", async () => {
    const state = await blockedRun();
    await state.service.runCampaign(state.campaign.id);
    expect(state.notificationAdapter.publishedEvents).toHaveLength(1);
    expect(state.service.listAttentionEvents(state.campaign.id)).toHaveLength(1);
  });

  it("accepts one explicit choice, resolves the exact blocker, and invokes the existing resume port", async () => {
    let resumeCalls = 0;
    const state = await blockedRun({
      resumeAttention: async () => {
        resumeCalls += 1;
      },
    });
    const resumable = makeResumable(state.job);
    state.careerRepository.saveJob(resumable);
    const event = state.service.listAttentionEvents(state.campaign.id)[0];
    const response = await state.service.resolveAttentionResponse({
      eventId: event.id,
      selectedOption: "yes",
      actorIdentity: { provider: "test", userId: "human-1" },
      respondedAt: "2026-09-01T12:30:00.000Z",
    });

    expect(response.status).toBe("resolved");
    expect(resumeCalls).toBe(1);
    expect(state.service.getJob(state.job.id).blockers[0]).toMatchObject({ status: "resolved", value: "yes" });
    expect(state.service.listAttentionEvents(state.campaign.id)[0].status).toBe("resolved");
    expect(state.service.listEvents(state.campaign.id).some((event) => event.type === "application.applied")).toBe(false);
    expect(state.applicationRepository.listApplications().every((application) => application.status !== "applied")).toBe(true);
    expect(state.candidate.approvedReusableAnswers).toEqual(expect.objectContaining({ legal_attestations: "approved legal_attestations answer" }));
    expect(state.notificationAdapter.closedEventIds).toContain(event.id);

    const duplicate = await state.service.resolveAttentionResponse({
      eventId: event.id,
      selectedOption: "yes",
      actorIdentity: { provider: "test", userId: "human-1" },
      respondedAt: "2026-09-01T12:31:00.000Z",
    });
    expect(duplicate.status).toBe("duplicate");
    expect(resumeCalls).toBe(1);
  });

  it("does not apply overlapping duplicate responses twice", async () => {
    let resumeCalls = 0;
    const state = await blockedRun({
      resumeAttention: async () => {
        resumeCalls += 1;
        await Promise.resolve();
      },
    });
    state.careerRepository.saveJob(makeResumable(state.job));
    const event = state.service.listAttentionEvents(state.campaign.id)[0];
    const response = {
      eventId: event.id,
      selectedOption: "yes",
      actorIdentity: { provider: "test", userId: "human-1" },
      respondedAt: capturedAt,
    } as const;
    const results = await Promise.all([
      state.service.resolveAttentionResponse(response),
      state.service.resolveAttentionResponse(response),
    ]);
    expect(results.map((result) => result.status)).toEqual(["resolved", "resolved"]);
    expect(resumeCalls).toBe(1);
  });

  it("expires attention when the existing browser execution is interrupted", async () => {
    const state = await blockedRun();
    state.careerRepository.saveJob(makeResumable(state.job));
    state.service.recordExecutionHostInterrupted(state.campaign.id, state.job.id, "execution-attention-1");
    expect(state.service.listAttentionEvents(state.campaign.id)[0].status).toBe("expired");
    await expect(state.service.resolveAttentionResponse({
      eventId: state.service.listAttentionEvents(state.campaign.id)[0].id,
      selectedOption: "yes",
      actorIdentity: { provider: "test", userId: "human-1" },
      respondedAt: capturedAt,
    })).rejects.toThrow("no longer open");
  });

  it("rejects unknown, invalid, cancelled, and stale responses conservatively", async () => {
    const state = await blockedRun();
    const event = state.service.listAttentionEvents(state.campaign.id)[0];
    await expect(state.service.resolveAttentionResponse({
      eventId: "unknown-event",
      selectedOption: "yes",
      actorIdentity: { provider: "test", userId: "human-1" },
      respondedAt: capturedAt,
    })).rejects.toThrow("unknown");

    const invalid = await blockedRun();
    const invalidEvent = invalid.service.listAttentionEvents(invalid.campaign.id)[0];
    invalid.careerRepository.saveJob(makeResumable(invalid.job));
    await expect(invalid.service.resolveAttentionResponse({
      eventId: invalidEvent.id,
      selectedOption: "maybe",
      actorIdentity: { provider: "test", userId: "human-1" },
      respondedAt: capturedAt,
    })).rejects.toThrow("not valid");

    state.careerRepository.saveCampaign({
      ...state.service.getCampaign(state.campaign.id),
      attentionEvents: state.service.getCampaign(state.campaign.id).attentionEvents?.map((candidate) => ({
        ...candidate,
        status: "cancelled" as const,
      })),
    });
    await expect(state.service.resolveAttentionResponse({
      eventId: event.id,
      selectedOption: "yes",
      actorIdentity: { provider: "test", userId: "human-1" },
      respondedAt: capturedAt,
    })).rejects.toThrow("no longer open");

    const stale = await blockedRun();
    const staleEvent = stale.service.listAttentionEvents(stale.campaign.id)[0];
    const changed = makeResumable(stale.job);
    stale.careerRepository.saveJob({
      ...changed,
      blockers: changed.blockers.map((blocker) => ({
        ...blocker,
        evidence: blocker.evidence.map((item) => item.startsWith("question-prompt:")
          ? "question-prompt:A different question"
          : item),
      })),
    });
    await expect(stale.service.resolveAttentionResponse({
      eventId: staleEvent.id,
      selectedOption: "maybe",
      actorIdentity: { provider: "test", userId: "human-1" },
      respondedAt: capturedAt,
    })).rejects.toThrow("question changed");
    expect(stale.service.listAttentionEvents(stale.campaign.id).map((candidate) => candidate.status)).toEqual(["cancelled", "open"]);
    expect(stale.notificationAdapter.publishedEvents).toHaveLength(2);
  });

  it("rehydrates bounded attention history and isolates malformed records", async () => {
    class MapStorage implements KeyValueStorage {
      private readonly values = new Map<string, string>();
      getItem(key: string): string | null { return this.values.get(key) ?? null; }
      setItem(key: string, value: string): void { this.values.set(key, value); }
      removeItem(key: string): void { this.values.delete(key); }
    }

    const state = await blockedRun();
    const storage = new MapStorage();
    const first = new LocalStorageCareerRepository(storage);
    first.saveCampaign(state.service.getCampaign(state.campaign.id));
    const second = new LocalStorageCareerRepository(storage);
    expect(second.getCampaign(state.campaign.id)?.attentionEvents).toHaveLength(1);

    const rawCampaigns = JSON.parse(storage.getItem("atelier.application-agent.campaigns.v0") ?? "[]") as Array<Record<string, unknown>>;
    rawCampaigns[0].attentionEvents = [
      ...(rawCampaigns[0].attentionEvents as unknown[]),
      { malformed: true },
    ];
    storage.setItem("atelier.application-agent.campaigns.v0", JSON.stringify(rawCampaigns));
    expect(second.getCampaign(state.campaign.id)?.attentionEvents).toHaveLength(1);
  });
});
