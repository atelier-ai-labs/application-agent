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
  attentionEventForConfiguration,
  attentionEventForCareerBlocker,
  isAttentionEvent,
  questionProvenanceForBlocker,
  normalizeJobPosting,
  type ApplicationExecutor,
  type ApplicationExecutorResult,
  type ApplicationExecutionRequest,
  type AttentionProviderDelivery,
  type CandidateProfile,
  type CareerBlocker,
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

function salaryAskProfile(): CandidateProfile {
  const value = profile();
  value.answerPolicies = {
    ...value.answerPolicies,
    salary_expectations: "ask",
  };
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

function listingFor(index: number): JobSourceListing {
  const base = listing();
  return {
    ...base,
    sourceRecordId: `attention-job-${index}`,
    input: {
      ...base.input,
      companyHint: `Example H${index}`,
      titleHint: `Data Platform Engineer ${index}`,
      sourceUrl: `https://jobs.example.invalid/attention-job-${index}`,
      applicationUrl: `https://jobs.example.invalid/attention-job-${index}/apply`,
      rawText: `Example H${index}\nData Platform Engineer ${index}\nLocation: Remote - United States\n\nBuild data systems.\n\nRequired qualifications\n- Python\n- AWS`,
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

function demographicBlocker(label: string, prompt: string): CareerBlockerDraft {
  return {
    kind: "demographic_disclosure",
    unit: "submission",
    field: label.toLowerCase().replace(/[^a-z]+/g, "-"),
    question: label,
    reason: "Demographic disclosure is never selected automatically.",
    evidence: [
      "executor:lever-browser",
      `field-label:${label}`,
      "field-type:select",
      "field-required:false",
      "classification:demographic",
      "options:Asian|Black or African American|White|Prefer not to answer",
      `question-prompt:${prompt}`,
      "question-section:Voluntary Self-Identification",
      "question-source:question_container",
      "question-confidence:high",
    ],
    resumeAfterHuman: true,
  };
}

function preparationBlocker(kind: CareerBlockerDraft["kind"]): CareerBlockerDraft {
  const question = kind === "subjective_answer"
    ? "Why do you want this role?"
    : kind === "salary"
      ? "What are your salary expectations?"
    : "Provide the missing candidate fact for this required field.";
  return {
    kind,
    unit: "application_preparation",
    field: kind === "salary" ? "salary_expectations" : `answer_${kind}`,
    question,
    reason: kind === "subjective_answer"
      ? "This personalized answer requires the candidate's judgment; no wording was fabricated."
      : "The required candidate fact is not present in the verified profile; no value was inferred.",
    evidence: ["synthetic-preparation-blocker"],
    resumeAfterHuman: true,
  };
}

function inspection(status: ExecutionInspection["status"]): ExecutionInspection {
  return {
    status,
    fields: [],
    fieldsFilled: [],
    unresolvedFields: [],
    blockers: [],
    evidence: ["attention-test", "submit:not-clicked", "submission:manual-only"],
    durationMs: 1,
    domInspectionCount: 1,
    startedAt: capturedAt,
    updatedAt: capturedAt,
  };
}

class PreparationBlockerExecutor implements ApplicationExecutor {
  readonly id = "preparation-blocker-test-executor";
  private calls = 0;

  constructor(private readonly kinds: readonly CareerBlockerDraft["kind"][]) {}

  executionMode(): "preparation_only" {
    return "preparation_only";
  }

  async execute(request: ApplicationExecutionRequest): Promise<ApplicationExecutorResult> {
    const nextKind = this.kinds[Math.min(Math.max(this.calls - 1, 0), this.kinds.length - 1)];
    this.calls += 1;
    if (!nextKind) return { state: "ready_to_submit", inspection: inspection("inspected") };
    const blocker = preparationBlocker(nextKind);
    return { state: "requires_human", blocker, blockers: [blocker] };
  }
}

function asCareerBlocker(draft: CareerBlockerDraft): CareerBlocker {
  return {
    id: "blocker-test-1",
    ...draft,
    context: {
      jobId: "job-1",
      applicationId: "application-1",
      company: "Example H1",
      role: "Data Platform Engineer",
    },
    status: "open",
    createdAt: capturedAt,
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

function continuationBlocker(): CareerBlockerDraft {
  return {
    kind: "unknown_form_field",
    unit: "submission",
    questionProvenance: "ATS_FORM",
    field: "privacy-policy",
    question: "GC AI Privacy Policy",
    reason: "The required privacy-policy control needs an explicit human choice.",
    evidence: [
      "executor:ashby-browser",
      "field-id:privacy-policy",
      "field-type:radio",
      "field-label:GC AI Privacy Policy",
      "field-required:true",
      "classification:unknown",
      "options:Continue",
      "question-prompt:GC AI Privacy Policy",
      "question-section:Personal Information",
      "question-source:question_container",
      "question-confidence:high",
    ],
    resumeAfterHuman: true,
  };
}

class GeneratedChoiceThenReadyExecutor implements ApplicationExecutor {
  readonly id = "generated-choice-test-executor";
  calls = 0;

  executionMode(): "preparation_only" {
    return "preparation_only";
  }

  async execute(request: ApplicationExecutionRequest): Promise<ApplicationExecutorResult> {
    this.calls += 1;
    const answered = request.careerJob.blockers.some((candidate) =>
      candidate.field === "privacy-policy" && candidate.status === "resolved" && candidate.value === "Continue",
    );
    if (!answered) {
      const current = continuationBlocker();
      return { state: "requires_human", blocker: current, blockers: [current] };
    }
    return { state: "ready_to_submit", inspection: inspection("inspected") };
  }
}

function setup(options: {
  candidate?: CandidateProfile;
  executor?: ApplicationExecutor;
  resumeAttention?: (campaignId: string, jobId: string) => Promise<void>;
  listingCount?: number;
} = {}) {
  const candidate = options.candidate ?? profile();
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
  const listings = options.listingCount === undefined || options.listingCount === 1
    ? [listing()]
    : Array.from({ length: options.listingCount }, (_, index) => listingFor(index + 1));
  const source = new StaticJobSource(
    "attention-source",
    listings,
  );
  const service = new CareerAgentService(candidate, {
    applicationService,
    careerRepository,
    scout: new JobScout({ [source.id]: source }, runtime.now),
    executor: options.executor ?? new UnknownQuestionExecutor(),
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
  return { candidate, service, campaign, careerRepository, applicationRepository, notificationAdapter, clock: runtime };
}

async function blockedRun(options: {
  candidate?: CandidateProfile;
  executor?: ApplicationExecutor;
  resumeAttention?: (campaignId: string, jobId: string) => Promise<void>;
  listingCount?: number;
} = {}) {
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
  it.each([
    "subjective_answer",
    "unknown_fact",
    "salary",
    "sponsorship",
    "relocation",
    "travel",
    "legal_attestation",
    "demographic_disclosure",
    "captcha",
    "external_login",
    "external_verification",
  ] as const)("creates an event for human-required %s blockers", (kind) => {
    const generated = attentionEventForCareerBlocker({
      campaignId: "campaign-1",
      jobId: "job-1",
      blocker: asCareerBlocker(preparationBlocker(kind)),
      createdAt: capturedAt,
      createId: (prefix) => `${prefix}-1`,
    });
    expect(generated?.event.blockerType).toBe(kind);
    expect(isAttentionEvent(generated?.event)).toBe(true);
  });

  it("distinguishes ATS, preparation, policy, and configuration question provenance", () => {
    const preparation = attentionEventForCareerBlocker({
      campaignId: "campaign-1",
      jobId: "job-1",
      blocker: asCareerBlocker(preparationBlocker("salary")),
      createdAt: capturedAt,
      createId: (prefix) => `${prefix}-preparation`,
    });
    expect(preparation?.event.questionProvenance).toBe("APPLICATION_PREPARATION");
    expect(questionProvenanceForBlocker(asCareerBlocker(preparationBlocker("salary")))).toBe("APPLICATION_PREPARATION");

    const ats = attentionEventForCareerBlocker({
      campaignId: "campaign-1",
      jobId: "job-1",
      blocker: asCareerBlocker({
        ...demographicBlocker("Race / Ethnicity", "What is your race or ethnicity?"),
        questionProvenance: "ATS_FORM",
      }),
      createdAt: capturedAt,
      createId: (prefix) => `${prefix}-ats`,
    });
    expect(ats?.event.questionProvenance).toBe("ATS_FORM");

    const policy = attentionEventForCareerBlocker({
      campaignId: "campaign-1",
      jobId: "job-1",
      blocker: asCareerBlocker({
        ...preparationBlocker("subjective_answer"),
        unit: "submission",
        questionProvenance: "POLICY",
      }),
      createdAt: capturedAt,
      createId: (prefix) => `${prefix}-policy`,
    });
    expect(policy?.event.questionProvenance).toBe("POLICY");

    expect(attentionEventForConfiguration({
      campaignId: "campaign-1",
      createdAt: capturedAt,
      createId: (prefix) => `${prefix}-configuration`,
      reasonCode: "missing_resume_family",
    }).event.questionProvenance).toBe("CONFIGURATION");
  });

  it("marks a post-click CAPTCHA handoff even when its blocker unit is external", () => {
    const generated = attentionEventForCareerBlocker({
      campaignId: "campaign-1",
      jobId: "job-1",
      blocker: asCareerBlocker({
        kind: "captcha",
        unit: "external",
        questionProvenance: "POLICY",
        field: "submission-confirmation",
        question: "Verify you are human",
        reason: "A verification challenge appeared after Submit.",
        evidence: ["executor:lever-browser", "submit:clicked", "captcha-state:active_challenge"],
        resumeAfterHuman: false,
      }),
      createdAt: capturedAt,
      createId: (prefix) => `${prefix}-post-click-captcha`,
    });
    expect(generated?.event.submissionAlreadyClicked).toBe(true);
    expect(isAttentionEvent(generated?.event)).toBe(true);
  });

  it("preserves a legitimate long ATS prompt for attention and dedupe", () => {
    const prompt = "Our priorities for this role are to continue scaling our AWS Control Tower environment with Terraform IaC, CI/CD via GitHub Actions, and AWS data warehousing solutions; how does your interests and experience align with these priorities?";
    const generated = attentionEventForCareerBlocker({
      campaignId: "campaign-1",
      jobId: "job-1",
      blocker: asCareerBlocker({
        kind: "subjective_answer",
        unit: "submission",
        questionProvenance: "ATS_FORM",
        field: "job_applicant_custom_form_response_attributes_answers_attributes_6_text",
        question: prompt,
        reason: "The exact ATS free-text question requires review.",
        evidence: [
          "executor:gusto-browser",
          "field-type:textarea",
          "field-required:true",
          `question-prompt:${prompt}`,
          "question-source:question_container",
          "question-confidence:high",
        ],
        resumeAfterHuman: true,
      }),
      createdAt: capturedAt,
      createId: (prefix) => `${prefix}-long-ats`,
    });

    expect(generated?.event.question).toMatchObject({ prompt, kind: "free_text", required: true });
    expect(generated?.record.descriptorSignature.length).toBeGreaterThan(512);
    expect(generated?.record.descriptorSignature.length).toBeLessThanOrEqual(1_024);
    expect(isAttentionEvent(generated?.event)).toBe(true);
  });

  it.each(["other", "submission_approval"] as const)("keeps %s out of the interactive attention queue", (kind) => {
    expect(attentionEventForCareerBlocker({
      campaignId: "campaign-1",
      jobId: "job-1",
      blocker: asCareerBlocker(preparationBlocker(kind)),
      createdAt: capturedAt,
      createId: (prefix) => `${prefix}-1`,
    })).toBeUndefined();
  });

  it.each([
    ["subjective_answer", "free_text"],
    ["unknown_fact", "free_text"],
  ] as const)("bridges %s preparation blockers into safe free-text attention", async (kind, questionKind) => {
    const state = await blockedRun({ executor: new PreparationBlockerExecutor([kind]) });
    const event = state.notificationAdapter.publishedEvents[0];
    expect(event).toMatchObject({
      type: "needs_input",
      blockerType: kind,
      questionProvenance: "APPLICATION_PREPARATION",
      question: { kind: questionKind, options: [] },
    });
    expect(event.question?.prompt).toBeDefined();
    expect(isAttentionEvent(event)).toBe(true);
    expect(JSON.stringify(event)).not.toContain("profile");
    expect(state.service.getJob(state.job.id).blockers.some((blocker) =>
      blocker.kind === kind && blocker.status === "open" && blocker.value === undefined,
    )).toBe(true);
  });

  it("persists a preparation attention event before attempting publication", async () => {
    const state = setup({ executor: new PreparationBlockerExecutor(["subjective_answer"]) });
    let persistedEventCount = 0;
    state.notificationAdapter.publishAttentionEvent = async () => {
      persistedEventCount = state.service.getCampaign(state.campaign.id).attentionEvents?.length ?? 0;
    };
    state.service.activateCampaign(state.campaign.id);
    await state.service.runCampaign(state.campaign.id);
    expect(persistedEventCount).toBe(1);
    expect(state.service.listAttentionEvents(state.campaign.id)).toHaveLength(1);
  });

  it("persists provider delivery metadata after successful publication and reloads it", async () => {
    class MapStorage implements KeyValueStorage {
      private readonly values = new Map<string, string>();
      getItem(key: string): string | null { return this.values.get(key) ?? null; }
      setItem(key: string, value: string): void { this.values.set(key, value); }
      removeItem(key: string): void { this.values.delete(key); }
    }

    const state = setup({ executor: new PreparationBlockerExecutor(["subjective_answer"]) });
    const delivery: AttentionProviderDelivery = {
      provider: "slack",
      messageTs: "1710000000.000041",
      channelId: "C123456",
    };
    state.notificationAdapter.publishAttentionEvent = async () => delivery;
    state.service.activateCampaign(state.campaign.id);
    await state.service.runCampaign(state.campaign.id);
    const persisted = state.service.getCampaign(state.campaign.id).attentionEvents?.[0];
    expect(persisted?.providerDelivery).toEqual(delivery);
    expect(persisted?.publishedAt).toBeDefined();

    const storage = new MapStorage();
    const firstRepository = new LocalStorageCareerRepository(storage);
    firstRepository.saveCampaign(state.service.getCampaign(state.campaign.id));
    const reloaded = new LocalStorageCareerRepository(storage);
    expect(reloaded.getCampaign(state.campaign.id)?.attentionEvents?.[0].providerDelivery).toEqual(delivery);
  });

  it("repairs an unthreaded Slack root through the existing attention repair seam", async () => {
    const state = await blockedRun({
      candidate: salaryAskProfile(),
      executor: new PreparationBlockerExecutor(["salary"]),
    });
    const campaign = state.service.getCampaign(state.campaign.id);
    const legacy = campaign.attentionEvents?.[0];
    if (!legacy) throw new Error("Expected an attention event.");
    const unthreaded: AttentionProviderDelivery = {
      provider: "slack",
      messageTs: "1710000000.000043",
      channelId: "C123456",
    };
    const canonical = {
      ...legacy,
      id: "attention-canonical-thread",
      status: "resolved" as const,
      resolvedAt: capturedAt,
      providerDelivery: { ...unthreaded, messageTs: "1710000000.000040", threadTs: "1710000000.000039" },
    };
    state.careerRepository.saveCampaign({
      ...campaign,
      attentionEvents: [
        ...(campaign.attentionEvents?.map((event) => event.id === legacy.id
          ? { ...event, providerDelivery: unthreaded }
          : event) ?? []),
        canonical,
      ],
    });
    const threaded: AttentionProviderDelivery = {
      ...unthreaded,
      messageTs: "1710000000.000044",
      threadTs: "1710000000.000040",
    };
    state.notificationAdapter.publishAttentionEvent = async () => threaded;

    const result = await state.service.repairLegacyAttentionEvents(state.campaign.id);
    expect(result).toMatchObject({ inspected: 1, eligible: 1, replaced: 1, deliveryMetadataPersisted: 1, newRootsPublished: 0 });
    const records = state.service.getCampaign(state.campaign.id).attentionEvents ?? [];
    expect(records.find((event) => event.id !== legacy.id && event.id !== canonical.id)?.providerDelivery?.threadTs).toBe(threaded.threadTs);
  });

  it("repairs one explicitly targeted unthreaded root when no canonical application thread exists", async () => {
    const state = await blockedRun({
      candidate: salaryAskProfile(),
      executor: new PreparationBlockerExecutor(["salary"]),
    });
    const campaign = state.service.getCampaign(state.campaign.id);
    const legacy = campaign.attentionEvents?.[0];
    if (!legacy) throw new Error("Expected an attention event.");
    const oldDelivery: AttentionProviderDelivery = {
      provider: "slack",
      messageTs: "1710000000.000050",
      channelId: "C123456",
    };
    state.careerRepository.saveCampaign({
      ...campaign,
      attentionEvents: campaign.attentionEvents?.map((event) => event.id === legacy.id
        ? { ...event, providerDelivery: oldDelivery }
        : event),
    });
    const freshDelivery: AttentionProviderDelivery = {
      provider: "slack",
      messageTs: "1710000000.000051",
      channelId: "C123456",
    };
    state.notificationAdapter.publishAttentionEvent = async () => freshDelivery;

    const result = await state.service.repairLegacyAttentionEvents(state.campaign.id, { jobId: state.job.id });
    const records = state.service.getCampaign(state.campaign.id).attentionEvents ?? [];
    const replacement = records.find((event) => event.id !== legacy.id);
    expect(result).toMatchObject({ inspected: 1, eligible: 1, replaced: 1, newRootsPublished: 1, deliveryMetadataPersisted: 1 });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      status: "cancelled",
      closureReason: "legacy_unreplyable_replaced",
      replacementEventId: replacement?.id,
    });
    expect(replacement?.providerDelivery).toEqual(freshDelivery);
  });

  it("restarts a stale sequential review with a fresh root and persists its reply correlation", async () => {
    const state = await blockedRun({
      candidate: salaryAskProfile(),
      executor: new PreparationBlockerExecutor(["salary"]),
    });
    let resetApplicationId: string | undefined;
    state.notificationAdapter.startFreshApplicationReview = (applicationId) => {
      resetApplicationId = applicationId;
    };
    state.notificationAdapter.publishAttentionEvent = async () => ({
      provider: "slack",
      messageTs: "1789936874.500000",
      channelId: "C123456",
    });

    await state.service.restartAttentionReview(state.campaign.id, state.job.id);

    const records = state.service.getCampaign(state.campaign.id).attentionEvents ?? [];
    expect(resetApplicationId).toBe(state.job.applicationId);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ status: "cancelled" });
    expect(records[1]).toMatchObject({
      status: "open",
      providerDelivery: {
        provider: "slack",
        messageTs: "1789936874.500000",
        channelId: "C123456",
      },
      publishedAt: expect.any(String),
    });
  });

  it("repairs an eligible legacy event through the normal lifecycle and persists delivery metadata", async () => {
    const state = await blockedRun({
      candidate: salaryAskProfile(),
      executor: new PreparationBlockerExecutor(["salary"]),
    });
    const legacy = state.service.getCampaign(state.campaign.id).attentionEvents?.[0];
    expect(legacy).toMatchObject({ status: "open", publishedAt: expect.any(String) });
    expect(legacy?.providerDelivery).toBeUndefined();

    const delivery: AttentionProviderDelivery = {
      provider: "slack",
      messageTs: "1710000000.000042",
      channelId: "C123456",
    };
    let publishCalls = 0;
    state.notificationAdapter.publishAttentionEvent = async () => {
      publishCalls += 1;
      return delivery;
    };

    const result = await state.service.repairLegacyAttentionEvents(state.campaign.id);
    const records = state.service.getCampaign(state.campaign.id).attentionEvents ?? [];
    const replacement = records.find((event) => event.id !== legacy?.id);
    expect(result).toEqual({
      inspected: 1,
      eligible: 1,
      replaced: 1,
      skipped: 0,
      newRootsPublished: 1,
      deliveryMetadataPersisted: 1,
    });
    expect(publishCalls).toBe(1);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      status: "cancelled",
      closureReason: "legacy_unreplyable_replaced",
      replacementEventId: replacement?.id,
    });
    expect(replacement).toMatchObject({
      status: "open",
      publishedAt: expect.any(String),
      providerDelivery: delivery,
    });
    expect(state.service.getJob(state.job.id).blockers.some((blocker) => blocker.status === "open")).toBe(true);
  });

  it("does not repair a legacy event after it is no longer open", async () => {
    const state = await blockedRun({
      candidate: salaryAskProfile(),
      executor: new PreparationBlockerExecutor(["salary"]),
    });
    const campaign = state.service.getCampaign(state.campaign.id);
    const old = campaign.attentionEvents?.[0];
    if (!old) throw new Error("Expected a legacy attention event.");
    state.careerRepository.saveCampaign({
      ...campaign,
      attentionEvents: campaign.attentionEvents?.map((event) => event.id === old.id
        ? { ...event, status: "resolved" as const, resolvedAt: capturedAt }
        : event),
    });
    const result = await state.service.repairLegacyAttentionEvents(state.campaign.id);
    expect(result).toMatchObject({ inspected: 0, eligible: 0, replaced: 0, skipped: 0 });
    expect(state.notificationAdapter.publishedEvents).toHaveLength(1);
  });

  it("skips a legacy event whose underlying blocker is no longer actionable", async () => {
    const state = await blockedRun({
      candidate: salaryAskProfile(),
      executor: new PreparationBlockerExecutor(["salary"]),
    });
    const campaign = state.service.getCampaign(state.campaign.id);
    const old = campaign.attentionEvents?.[0];
    if (!old) throw new Error("Expected a legacy attention event.");
    state.careerRepository.saveJob({
      ...state.service.getJob(state.job.id),
      blockers: state.service.getJob(state.job.id).blockers.map((blocker) => blocker.id === old.blockerId
        ? { ...blocker, status: "resolved" as const, value: "already answered" }
        : blocker),
    });
    const result = await state.service.repairLegacyAttentionEvents(state.campaign.id);
    expect(result).toMatchObject({ inspected: 1, eligible: 0, replaced: 0, skipped: 1 });
    expect(state.service.getCampaign(state.campaign.id).attentionEvents).toHaveLength(1);
    expect(state.notificationAdapter.publishedEvents).toHaveLength(1);
  });

  it("cancels a legacy event when a newer open application event already exists", async () => {
    const state = await blockedRun({
      candidate: salaryAskProfile(),
      executor: new PreparationBlockerExecutor(["salary"]),
    });
    const campaign = state.service.getCampaign(state.campaign.id);
    const old = campaign.attentionEvents?.[0];
    if (!old) throw new Error("Expected a legacy attention event.");
    const newer = {
      ...old,
      id: "attention-newer-event",
      createdAt: "2026-09-01T12:05:00.000Z",
      providerDelivery: {
        provider: "slack" as const,
        messageTs: "1710000000.000043",
        channelId: "C123456",
      },
    };
    state.careerRepository.saveCampaign({
      ...campaign,
      attentionEvents: [...(campaign.attentionEvents ?? []), newer],
    });
    const result = await state.service.repairLegacyAttentionEvents(state.campaign.id);
    const records = state.service.getCampaign(state.campaign.id).attentionEvents ?? [];
    expect(result).toMatchObject({ inspected: 1, eligible: 0, replaced: 0, skipped: 1 });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      status: "cancelled",
      closureReason: "legacy_unreplyable_superseded",
      replacementEventId: newer.id,
    });
    expect(state.notificationAdapter.publishedEvents).toHaveLength(1);
  });

  it("is idempotent after a repaired replacement has provider delivery metadata", async () => {
    const state = await blockedRun({
      candidate: salaryAskProfile(),
      executor: new PreparationBlockerExecutor(["salary"]),
    });
    const delivery: AttentionProviderDelivery = {
      provider: "slack",
      messageTs: "1710000000.000044",
      channelId: "C123456",
    };
    let publishCalls = 0;
    state.notificationAdapter.publishAttentionEvent = async () => {
      publishCalls += 1;
      return delivery;
    };
    const first = await state.service.repairLegacyAttentionEvents(state.campaign.id);
    const second = await state.service.repairLegacyAttentionEvents(state.campaign.id);
    expect(first.replaced).toBe(1);
    expect(second).toEqual({
      inspected: 0,
      eligible: 0,
      replaced: 0,
      skipped: 0,
      newRootsPublished: 0,
      deliveryMetadataPersisted: 0,
    });
    expect(publishCalls).toBe(1);
  });

  it("leaves a durable open preparation event when publication fails", async () => {
    const state = setup({ executor: new PreparationBlockerExecutor(["unknown_fact"]) });
    state.notificationAdapter.publishAttentionEvent = async () => { throw new Error("Slack unavailable"); };
    state.service.activateCampaign(state.campaign.id);
    await state.service.runCampaign(state.campaign.id);
    const record = state.service.getCampaign(state.campaign.id).attentionEvents?.[0];
    expect(record).toMatchObject({
      status: "open",
      deliveryFailureCount: 1,
      lastDeliveryFailureCode: "provider_error",
    });
    expect(record?.publishedAt).toBeUndefined();
    expect(state.notificationAdapter.publishedEvents).toHaveLength(0);
  });

  it("does not duplicate an unresolved preparation blocker and surfaces the next one after resolution", async () => {
    const state = await blockedRun({ executor: new PreparationBlockerExecutor(["subjective_answer", "unknown_fact"]) });
    expect(state.service.listAttentionEvents(state.campaign.id)).toHaveLength(1);
    expect(state.notificationAdapter.publishedEvents).toHaveLength(1);

    await state.service.runCampaign(state.campaign.id);
    expect(state.service.listAttentionEvents(state.campaign.id)).toHaveLength(1);
    expect(state.notificationAdapter.publishedEvents).toHaveLength(1);

    const first = state.service.listAttentionEvents(state.campaign.id)[0];
    const resolved = await state.service.resolveAttentionResponse({
      eventId: first.id,
      selectedOption: "I will write a grounded answer for this application.",
      actorIdentity: { provider: "test", userId: "human-1" },
      respondedAt: "2026-09-01T12:30:00.000Z",
    });
    expect(resolved.status).toBe("resolved");
    expect(state.service.listAttentionEvents(state.campaign.id)).toHaveLength(2);
    expect(state.service.listAttentionEvents(state.campaign.id).map((event) => event.status)).toEqual(["resolved", "open"]);
    expect(state.notificationAdapter.publishedEvents).toHaveLength(2);
    expect(state.service.listAttentionEvents(state.campaign.id)[1].blockerType).toBe("unknown_fact");
  });

  it("surfaces one bounded preparation attention event per pursued application", async () => {
    const state = await blockedRun({
      executor: new PreparationBlockerExecutor(["subjective_answer"]),
      listingCount: 3,
    });
    const events = state.service.listAttentionEvents(state.campaign.id);
    expect(events).toHaveLength(3);
    expect(new Set(events.map((event) => `${event.context.company}:${event.context.role}`)).size).toBe(3);
    expect(events.every((event) => event.status === "open" && event.question?.kind === "free_text")).toBe(true);
  });

  it("counts every newly selected application-preparation job as pursued", async () => {
    const state = setup({
      executor: new PreparationBlockerExecutor(["subjective_answer"]),
      listingCount: 3,
    });
    state.service.activateCampaign(state.campaign.id);
    const result = await state.service.runCampaign(state.campaign.id);
    expect(result.pursued).toBe(3);
    expect(result.prepared).toBe(3);
    expect(state.service.listEvents(state.campaign.id).filter((event) => event.type === "application.created")).toHaveLength(3);
  });

  it("does not infer consequential facts or fabricate subjective answers", async () => {
    const state = await blockedRun({ executor: new PreparationBlockerExecutor(["subjective_answer", "unknown_fact"]) });
    const application = state.applicationRepository.listApplications()[0];
    expect(application.answers.some((answer) => answer.status === "needs_input" || answer.status === "blocked")).toBe(false);
    const event = state.notificationAdapter.publishedEvents[0];
    expect(event.question?.prompt).toBe("Why do you want this role?");
    expect(event.question?.options).toEqual([]);
    expect(state.service.getJob(state.job.id).blockers[0]?.value).toBeUndefined();
  });

  it("keeps a salary response scoped to the exact blocker without mutating the profile", async () => {
    const state = await blockedRun({ executor: new PreparationBlockerExecutor(["salary"]) });
    const beforeProfile = JSON.stringify(state.candidate);
    const event = state.service.listAttentionEvents(state.campaign.id)[0];
    const record = state.service.getCampaign(state.campaign.id).attentionEvents?.[0];
    state.service.pauseCampaign(state.campaign.id);

    const response = await state.service.resolveAttentionResponse({
      eventId: event.id,
      selectedOption: "$100,000 per year",
      actorIdentity: { provider: "test", userId: "human-1" },
      respondedAt: "2026-09-01T12:30:00.000Z",
    });

    expect(response.status).toBe("resolved");
    expect(JSON.stringify(state.candidate)).toBe(beforeProfile);
    expect(record?.blockerId).toBeDefined();
    expect(state.service.getJob(state.job.id).blockers.find((blocker) => blocker.id === record?.blockerId)).toMatchObject({
      status: "resolved",
      value: "$100,000 per year",
    });
    expect(JSON.stringify(state.candidate.approvedReusableAnswers)).toBe(
      JSON.stringify(JSON.parse(beforeProfile).approvedReusableAnswers),
    );
  });

  it("does not create interactive attention for recoverable source failures", async () => {
    const state = setup();
    const failingScout = new JobScout({
      "attention-source": {
        id: "attention-source",
        discover: async () => { throw new Error("temporary provider failure"); },
      },
    }, state.clock.now);
    const failingService = new CareerAgentService(state.candidate, {
      applicationService: new ApplicationService(state.applicationRepository, state.candidate, new DeterministicModelClient(), state.clock),
      careerRepository: state.careerRepository,
      scout: failingScout,
      executor: new PreparationBlockerExecutor(["subjective_answer"]),
      notificationAdapter: state.notificationAdapter,
    }, state.clock);
    const campaign = failingService.createCampaign({
      name: "Provider failure attention test",
      goal: "Keep recoverable provider failures quiet.",
      searchSources: ["attention-source"],
      searchCriteria: { roleLanes: [], remoteOnly: false, employmentTypes: [] },
      applicationPolicy: { autoPrepare: true, allowGroundedDrafts: true, approvedResumeFamilies: [] },
      submissionPolicy: { authority: "never", requireExplicitApproval: false },
    });
    failingService.activateCampaign(campaign.id);
    await failingService.runCampaign(campaign.id);
    expect(state.notificationAdapter.publishedEvents).toHaveLength(0);
    expect(failingService.listAttentionEvents(campaign.id)).toHaveLength(0);
  });

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
      questionProvenance: "ATS_FORM",
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

  it("maps a generated choice ID back to the inspected option before resuming", async () => {
    const executor = new GeneratedChoiceThenReadyExecutor();
    const state = await blockedRun({ executor });
    const event = state.service.listAttentionEvents(state.campaign.id)[0];
    expect(event.question?.options).toEqual([{ id: "continue-1", label: "Continue" }]);

    const resolved = await state.service.resolveAttentionResponse({
      eventId: event.id,
      selectedOption: "continue-1",
      actorIdentity: { provider: "test", userId: "human-1" },
      respondedAt: "2026-09-01T12:30:00.000Z",
    });

    expect(resolved.status).toBe("resolved");
    expect(executor.calls).toBe(2);
    expect(state.service.getJob(state.job.id).status).toBe("ready_to_submit");
    expect(state.service.getJob(state.job.id).blockers.find((candidate) => candidate.field === "privacy-policy")).toMatchObject({
      status: "resolved",
      value: "Continue",
    });
    expect(state.service.listAttentionEvents(state.campaign.id)).toHaveLength(1);
  });

  it("preserves exact demographic question context, options, section, and optionality", () => {
    const generated = attentionEventForCareerBlocker({
      campaignId: "campaign-1",
      jobId: "job-1",
      blocker: asCareerBlocker(demographicBlocker("Race / Ethnicity", "What is your race or ethnicity?")),
      createdAt: capturedAt,
      createId: (prefix) => `${prefix}-demographic`,
    });
    expect(generated?.event).toMatchObject({
      blockerType: "demographic_disclosure",
      context: { section: "Voluntary Self-Identification" },
      question: {
        prompt: "What is your race or ethnicity?",
        fieldLabel: "Race / Ethnicity",
        kind: "single_choice",
        required: false,
        options: [
          { label: "Asian" },
          { label: "Black or African American" },
          { label: "White" },
          { label: "Prefer not to answer" },
        ],
      },
    });
    expect(isAttentionEvent(generated?.event)).toBe(true);

    const gender = attentionEventForCareerBlocker({
      campaignId: "campaign-1",
      jobId: "job-1",
      blocker: asCareerBlocker(demographicBlocker("Gender", "What is your gender?")),
      createdAt: capturedAt,
      createId: (prefix) => `${prefix}-gender`,
    });
    expect(gender?.event.question?.prompt).toBe("What is your gender?");
    expect(gender?.event.question?.fieldLabel).toBe("Gender");
    expect(gender?.record.descriptorSignature).not.toBe(generated?.record.descriptorSignature);
  });

  it("keeps question metadata out of candidate answers and transport delivery fields", () => {
    const generated = attentionEventForCareerBlocker({
      campaignId: "campaign-1",
      jobId: "job-1",
      blocker: asCareerBlocker(demographicBlocker("Veteran Status", "Please select your veteran status.")),
      createdAt: capturedAt,
      createId: (prefix) => `${prefix}-veteran`,
    });
    expect(generated?.record.response).toBeUndefined();
    expect(generated?.record.providerDelivery).toBeUndefined();
    expect(JSON.stringify(generated?.event)).not.toContain("candidate");
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

  it("does not resume a non-resumable submission-verification boundary", async () => {
    let resumeCalls = 0;
    const state = await blockedRun({
      resumeAttention: async () => {
        resumeCalls += 1;
      },
    });
    const original = state.job.blockers[0];
    const blocker: CareerBlocker = {
      ...original,
      kind: "external_verification",
      unit: "submission",
      questionProvenance: "POLICY",
      field: "submission-confirmation",
      question: "Verify whether the application was submitted",
      reason: "The Submit control was activated but deterministic confirmation was unavailable.",
      evidence: ["submit:clicked", "submit:confirmation-missing"],
      resumeAfterHuman: false,
    };
    state.careerRepository.saveJob({
      ...makeResumable(state.job),
      blockers: [blocker],
    });
    const generated = attentionEventForCareerBlocker({
      campaignId: state.campaign.id,
      jobId: state.job.id,
      blocker,
      createdAt: capturedAt,
      createId: (prefix) => `${prefix}-submission-verification`,
    });
    if (!generated) throw new Error("The submission verification fixture did not create an attention event.");
    state.careerRepository.saveCampaign({
      ...state.campaign,
      attentionEvents: [generated.record],
    });

    const response = await state.service.resolveAttentionResponse({
      eventId: generated.event.id,
      selectedOption: "The page did not show a confirmation.",
      actorIdentity: { provider: "test", userId: "human-1" },
      respondedAt: "2026-09-01T12:30:00.000Z",
    });

    expect(response.status).toBe("resolved");
    expect(resumeCalls).toBe(0);
    expect(state.service.getJob(state.job.id).blockers[0]).toMatchObject({ status: "resolved", resumeAfterHuman: false });
    expect(state.service.getJob(state.job.id).status).toBe("needs_input");
    expect(state.service.getApplication(state.job.applicationId!).status).not.toBe("applied");
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

  it("revises one exact resolved answer without resuming or submitting", async () => {
    const state = await blockedRun({ executor: new PreparationBlockerExecutor(["subjective_answer"]) });
    const job = state.service.getJob(state.job.id);
    const blocker = job.blockers[0];
    const event = state.service.listAttentionEvents(state.campaign.id)[0];
    if (!blocker || !event) throw new Error("revision fixture is incomplete");
    state.careerRepository.saveJob({
      ...job,
      status: "failed",
      execution: {
        ...(job.execution ?? {
          status: "failed" as const,
          fieldsDetected: [],
          fieldsFilled: [],
          unresolvedFields: [],
          startedAt: capturedAt,
          updatedAt: capturedAt,
        }),
        status: "failed" as const,
        evidence: ["submit:not-clicked"],
      },
      blockers: [{ ...blocker, status: "resolved", value: "internet", resolvedAt: capturedAt }],
    });
    state.careerRepository.saveCampaign({
      ...state.service.getCampaign(state.campaign.id),
      attentionEvents: [{
        ...event,
        jobId: job.id,
        blockerId: blocker.id,
        descriptorSignature: "revision-test",
        status: "resolved",
        answerUsed: "internet",
        response: {
          eventId: event.id,
          selectedOption: "internet",
          actorIdentity: { provider: "test", userId: "human-1" },
          respondedAt: capturedAt,
        },
      }],
    });

    const revised = state.service.reviseResolvedCareerAnswer({
      campaignId: state.campaign.id,
      jobId: job.id,
      blockerId: blocker.id,
      attentionEventId: event.id,
      expectedCurrentValue: "internet",
      replacementValue: "MeridianLink Career Site",
    });
    expect(revised.careerJob.status).toBe("failed");
    expect(revised.careerJob.blockers[0]?.value).toBe("MeridianLink Career Site");
    expect(revised.attentionEvent.answerUsed).toBe("MeridianLink Career Site");
    expect(revised.attentionEvent.response?.selectedOption).toBe("MeridianLink Career Site");
  });

  it("rejects a resolved-answer revision without positive pre-submit evidence", async () => {
    const state = await blockedRun({ executor: new PreparationBlockerExecutor(["subjective_answer"]) });
    const job = state.service.getJob(state.job.id);
    const blocker = job.blockers[0];
    const event = state.service.listAttentionEvents(state.campaign.id)[0];
    if (!blocker || !event) throw new Error("revision fixture is incomplete");
    state.careerRepository.saveJob({
      ...job,
      status: "failed",
      execution: {
        ...(job.execution ?? {
          status: "failed" as const,
          fieldsDetected: [],
          fieldsFilled: [],
          unresolvedFields: [],
          startedAt: capturedAt,
          updatedAt: capturedAt,
        }),
        status: "failed" as const,
        evidence: [],
      },
      blockers: [{ ...blocker, status: "resolved", value: "internet", resolvedAt: capturedAt }],
    });
    state.careerRepository.saveCampaign({
      ...state.service.getCampaign(state.campaign.id),
      attentionEvents: [{
        ...event,
        jobId: job.id,
        blockerId: blocker.id,
        descriptorSignature: "revision-test",
        status: "resolved",
        answerUsed: "internet",
        response: {
          eventId: event.id,
          selectedOption: "internet",
          actorIdentity: { provider: "test", userId: "human-1" },
          respondedAt: capturedAt,
        },
      }],
    });
    expect(() => state.service.reviseResolvedCareerAnswer({
      campaignId: state.campaign.id,
      jobId: job.id,
      blockerId: blocker.id,
      attentionEventId: event.id,
      expectedCurrentValue: "internet",
      replacementValue: "MeridianLink Career Site",
    })).toThrow("pre-submit evidence fence");
  });
});
