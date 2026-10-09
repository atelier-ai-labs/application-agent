import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANSWER_POLICIES,
  ApplicationService,
  attentionEventForCareerBlocker,
  InMemoryJobTracker,
  InMemoryNotificationAdapter,
  JobScout,
  StaticJobSource,
  UnavailableApplicationExecutor,
  exampleCandidateProfile,
  isCandidateProfile,
  normalizeJobPosting,
  type ApplicationExecutionRequest,
  type ApplicationExecutor,
  type ApplicationExecutorResult,
  type AttentionProviderDelivery,
  type CandidateProfile,
  type CareerBlockerDraft,
  type CareerBlocker,
  type CareerJob,
  type ExecutionHostRequest,
  type ExecutionHostSnapshot,
  type ExecutionInspection,
  type JobSourceListing,
  type PersistedAttentionEvent,
} from "../application-agent/src";
import {
  BackgroundCareerAgentRuntimeImpl,
  shouldConfigureExecutionHost,
  type CareerAgentExecutionHostPort,
} from "../application-agent/automation/runtime/careerAgentRuntime";

describe("configured Career Agent execution host wiring", () => {
  it("keeps the handoff-capable host configured for a non-browser Slack listener", () => {
    expect(shouldConfigureExecutionHost(false, true)).toBe(true);
  });

  it("does not enable host wiring when both browser execution and handoff viewer are disabled", () => {
    expect(shouldConfigureExecutionHost(false, false)).toBe(false);
  });

  it("keeps browser execution wiring enabled independently of the viewer", () => {
    expect(shouldConfigureExecutionHost(true, false)).toBe(true);
  });
});
import { FileKeyValueStorage } from "../application-agent/automation/runtime/fileKeyValueStorage";
import { DurableSubmissionAuthority } from "../application-agent/automation/executionHost/submissionAuthority";
import { ExecutionHostResponseError } from "../application-agent/src/service/executionHostClient";
import { createCareerServiceQueueProcessor } from "../application-agent/automation/standaloneJobQueueWorker";

const capturedAt = "2026-09-01T12:00:00.000Z";
const fieldId = "cards_question__field0_";

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

function profileWithoutResumeFamily(): CandidateProfile {
  return { ...profile(), resumeFamilies: [] };
}

function listing(): JobSourceListing {
  return {
    sourceRecordId: "runtime-job-1",
    input: {
      isExample: true,
      companyHint: "Example H1",
      titleHint: "Data Platform Engineer",
      sourceUrl: "https://jobs.example.invalid/runtime-job-1",
      applicationUrl: "https://jobs.example.invalid/runtime-job-1/apply",
      rawText: "Example H1\nData Platform Engineer\nLocation: Remote - United States\n\nBuild data systems.\n\nRequired qualifications\n- Python\n- AWS",
    },
  };
}

function blocker(): CareerBlockerDraft {
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

function inspection(status: ExecutionInspection["status"], blockers: readonly CareerBlockerDraft[] = []): ExecutionInspection {
  return {
    status,
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
    fieldsFilled: blockers.length > 0 ? [] : [fieldId],
    unresolvedFields: blockers.length > 0 ? [fieldId] : [],
    blockers,
    evidence: ["runtime-test", "submit:not-clicked", "submission:manual-only"],
    durationMs: 1,
    domInspectionCount: 1,
    startedAt: capturedAt,
    updatedAt: capturedAt,
  };
}

class UnknownThenReadyExecutor implements ApplicationExecutor {
  readonly id = "runtime-test-executor";
  calls = 0;

  executionMode(): "preparation_only" {
    return "preparation_only";
  }

  async execute(request: ApplicationExecutionRequest): Promise<ApplicationExecutorResult> {
    this.calls += 1;
    const answered = request.careerJob.blockers.some((candidate) =>
      candidate.kind === "unknown_form_field" && candidate.status === "resolved" && candidate.value === "yes",
    );
    if (!answered) {
      const current = blocker();
      return { state: "requires_human", blocker: current, blockers: [current], inspection: inspection("needs_input", [current]) };
    }
    return { state: "ready_to_submit", inspection: inspection("inspected") };
  }
}

class ReadyExecutor implements ApplicationExecutor {
  readonly id = "runtime-ready-executor";

  executionMode(): "preparation_only" {
    return "preparation_only";
  }

  async execute(): Promise<ApplicationExecutorResult> {
    return { state: "ready_to_submit", inspection: inspection("inspected") };
  }
}

const ripplingSalaryPrompt = "What is your desired annual compensation?";

function ripplingSalaryBlocker(): CareerBlockerDraft {
  return {
    kind: "salary",
    unit: "submission",
    questionProvenance: "ATS_FORM",
    field: "field-59",
    question: ripplingSalaryPrompt,
    reason: "No verified profile fact or explicitly resolved answer is available.",
    evidence: [
      "executor:rippling-browser",
      "field-id:field-59",
      "field-type:text",
      `field-label:${ripplingSalaryPrompt}`,
      "field-required:true",
      "classification:salary",
      "field-source-selector:dom-id:field-59",
      `question-prompt:${ripplingSalaryPrompt}`,
      "question-source:question_container",
      "question-confidence:high",
    ],
    resumeAfterHuman: true,
  };
}

class RipplingSalaryExecutor implements ApplicationExecutor {
  readonly id = "rippling-browser";
  calls = 0;

  executionMode(): "preparation_only" {
    return "preparation_only";
  }

  async execute(): Promise<ApplicationExecutorResult> {
    this.calls += 1;
    const current = ripplingSalaryBlocker();
    return {
      state: "requires_human",
      blocker: current,
      blockers: [current],
      inspection: {
        ...inspection("needs_input", [current]),
        fields: [{
          id: "field-59",
          label: ripplingSalaryPrompt,
          type: "text",
          required: true,
          classification: "salary",
          questionDescriptor: {
            promptText: ripplingSalaryPrompt,
            sourceStrategy: "question_container",
            confidence: "high",
          },
        }],
        fieldsFilled: ["field-8", "field-12", "field-16", "field-34", "field-31", "field-42"],
        unresolvedFields: [ripplingSalaryPrompt],
        evidence: ["executor:rippling-browser", "submit:not-clicked", "submission:manual-only"],
      },
    };
  }
}

function sequentialSubjectiveBlocker(index: number): CareerBlockerDraft {
  return {
    kind: "subjective_answer",
    unit: "submission",
    questionProvenance: "ATS_FORM",
    field: `subjective-${index}`,
    question: `Describe your relevant experience (${index}).`,
    reason: "The employer question requires candidate review.",
    evidence: [
      "executor:sequential-test",
      `field-id:subjective-${index}`,
      "field-type:text",
      "field-required:true",
      "classification:subjective_answer",
      `question-prompt:Describe your relevant experience (${index}).`,
      "question-source:question_container",
      "question-confidence:high",
    ],
    resumeAfterHuman: true,
  };
}

class SequentialSubjectiveExecutor implements ApplicationExecutor {
  readonly id = "sequential-subjective-test-executor";
  executionMode(): "preparation_only" { return "preparation_only"; }

  async execute(request: ApplicationExecutionRequest): Promise<ApplicationExecutorResult> {
    const first = sequentialSubjectiveBlocker(1);
    const second = sequentialSubjectiveBlocker(2);
    const firstResolved = request.careerJob.blockers.some((candidate) => candidate.field === first.field && candidate.status === "resolved");
    const secondResolved = request.careerJob.blockers.some((candidate) => candidate.field === second.field && candidate.status === "resolved");
    if (!firstResolved) return { state: "requires_human", blocker: first, blockers: [first, second], inspection: inspection("needs_input", [first, second]) };
    if (!secondResolved) return { state: "requires_human", blocker: second, blockers: [second], inspection: inspection("needs_input", [second]) };
    return { state: "ready_to_submit", inspection: inspection("inspected") };
  }
}

function runtimeClock() {
  let tick = 0;
  let sequence = 0;
  const base = Date.parse(capturedAt);
  return {
    now: () => new Date(base + tick++ * 1_000).toISOString(),
    createId: (prefix: string) => `${prefix}-runtime-${++sequence}`,
  };
}

function runtimeOptions(stateFilePath: string, executor: ApplicationExecutor, adapter: InMemoryNotificationAdapter) {
  const clock = runtimeClock();
  const source = new StaticJobSource("runtime-source", [listing()]);
  return {
    profile: profile(),
    stateFilePath,
    scout: new JobScout({ [source.id]: source }, clock.now),
    executor,
    tracker: new InMemoryJobTracker(),
    notificationAdapter: adapter,
    now: clock.now,
    createId: clock.createId,
  } as const;
}

function campaignInput() {
  return {
    name: "Background runtime acceptance",
    goal: "Verify durable attention state without the browser UI.",
    searchSources: ["runtime-source"],
    searchCriteria: { roleLanes: [], remoteOnly: false, employmentTypes: [] },
    applicationPolicy: { autoPrepare: true, allowGroundedDrafts: true, approvedResumeFamilies: [] },
    submissionPolicy: { authority: "never" as const, requireExplicitApproval: false },
    dailyApplicationLimit: 3,
  };
}

function makeResumable(job: CareerJob): CareerJob {
  return {
    ...job,
    execution: {
      status: "waiting_for_human",
      mode: "real_local",
      hostExecutionId: "runtime-host-1",
      fieldsDetected: [fieldId],
      fieldsFilled: [],
      unresolvedFields: [fieldId],
      evidence: ["submit:not-clicked", "submission:manual-only"],
      startedAt: capturedAt,
      updatedAt: capturedAt,
    },
  };
}

class ReadyHost implements CareerAgentExecutionHostPort {
  resumeCalls = 0;

  async start(_request: ExecutionHostRequest): Promise<ExecutionHostSnapshot> {
    throw new Error("The restart acceptance should use resume, not start.");
  }

  async get(_executionId: string): Promise<ExecutionHostSnapshot> {
    throw new Error("The bounded host fixture does not poll.");
  }

  async resume(requestId: string, request?: ExecutionHostRequest): Promise<ExecutionHostSnapshot> {
    this.resumeCalls += 1;
    if (requestId !== "runtime-host-1" || !request) throw new Error("The host request was not reconstructed.");
    const resultInspection = inspection("inspected");
    return {
      id: requestId,
      mode: "real_local",
      applicationId: request.application.id,
      jobId: request.careerJob.id,
      campaignId: request.campaign.id,
      status: "ready_to_submit",
      startedAt: capturedAt,
      updatedAt: capturedAt,
      attempt: 2,
      result: { state: "ready_to_submit", inspection: resultInspection },
    };
  }
}

class RestartedHost implements CareerAgentExecutionHostPort {
  resumeCalls = 0;
  startCalls = 0;

  async start(request: ExecutionHostRequest): Promise<ExecutionHostSnapshot> {
    this.startCalls += 1;
    return {
      id: "runtime-host-2",
      mode: "real_local",
      applicationId: request.application.id,
      jobId: request.careerJob.id,
      campaignId: request.campaign.id,
      status: "ready_to_submit",
      startedAt: capturedAt,
      updatedAt: capturedAt,
      attempt: 1,
      result: { state: "ready_to_submit", inspection: inspection("inspected") },
    };
  }

  async get(_executionId: string): Promise<ExecutionHostSnapshot> {
    throw new Error("The restart fixture does not poll.");
  }

  async resume(executionId: string, request?: ExecutionHostRequest): Promise<ExecutionHostSnapshot> {
    this.resumeCalls += 1;
    if (executionId !== "runtime-host-1" || !request) throw new Error("The stale host request was not reconstructed.");
    throw new ExecutionHostResponseError("That execution session is closed and cannot be resumed.", 409);
  }
}

describe("background Career Agent runtime", () => {
  it("reconciles a durable submitted fence through the production consumer without restarting the host", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-career-reconcile-"));
    try {
      const statePath = join(directory, "state.json");
      const adapter = new InMemoryNotificationAdapter();
      let starts = 0;
      const authority = new DurableSubmissionAuthority("runtime-worker", { stateFile: join(directory, "submission.json") });
      const runtime = new BackgroundCareerAgentRuntimeImpl({
        ...runtimeOptions(statePath, new ReadyExecutor(), adapter),
        submissionAuthority: authority,
        executionHost: { start: async () => { starts += 1; throw new Error("host must not start during reconciliation"); }, get: async () => { throw new Error("unused"); }, resume: async () => { throw new Error("unused"); } },
      });
      const campaign = runtime.createCampaign({ ...campaignInput(), submissionPolicy: { authority: "automatic", requireExplicitApproval: false } });
      runtime.service.activateCampaign(campaign.id);
      const curatedInput = { ...listing().input, isExample: false, sourceUrl: "https://jobs.lever.co/acme/post-1", applicationUrl: "https://jobs.lever.co/acme/post-1/apply", rawText: "Acme\nData Platform Engineer\nRemote United States\n" };
      await runtime.service.processCuratedJob(campaign.id, curatedInput);
      const job = runtime.service.listJobs(campaign.id)[0]!;
      const applicationId = job.applicationId!;
      const fence = authority.claim(applicationId, job.id, capturedAt);
      authority.beforeClick(fence, capturedAt);
      authority.markSubmitted(fence, "external-recovered", capturedAt);
      const recovered = await runtime.processCuratedJobThroughHost(campaign.id, curatedInput);
      expect(starts).toBe(0);
      expect(recovered.status).toBe("applied");
      expect(runtime.service.getApplication(applicationId).submissionProof?.externalApplicationId).toBe("external-recovered");
      await runtime.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("reconciles clicking and unknown durable fences to Needs Input without starting the host", async () => {
    for (const fenceState of ["clicking", "unknown"] as const) {
      const directory = mkdtempSync(join(tmpdir(), `atelier-career-${fenceState}-`));
      try {
        const authority = new DurableSubmissionAuthority("runtime-worker", { stateFile: join(directory, "submission.json") });
        let starts = 0;
        const runtime = new BackgroundCareerAgentRuntimeImpl({
          ...runtimeOptions(join(directory, "state.json"), new ReadyExecutor(), new InMemoryNotificationAdapter()),
          submissionAuthority: authority,
          executionHost: { start: async () => { starts += 1; throw new Error("host must not start during fence recovery"); }, get: async () => { throw new Error("unused"); }, resume: async () => { throw new Error("unused"); } },
        });
        const campaign = runtime.createCampaign({ ...campaignInput(), submissionPolicy: { authority: "automatic", requireExplicitApproval: false } });
        runtime.service.activateCampaign(campaign.id);
        const input = { ...listing().input, isExample: false, sourceUrl: "https://jobs.lever.co/acme/post-1", applicationUrl: "https://jobs.lever.co/acme/post-1/apply", rawText: "Acme\nData Platform Engineer\nRemote United States\n" };
        await runtime.service.processCuratedJob(campaign.id, input);
        const job = runtime.service.listJobs(campaign.id)[0]!;
        const fence = authority.claim(job.applicationId!, job.id, capturedAt);
        authority.beforeClick(fence, capturedAt);
        if (fenceState === "unknown") authority.markUnknown(fence, capturedAt);
        const recovered = await runtime.processCuratedJobThroughHost(campaign.id, input);
        expect(starts).toBe(0);
        expect(recovered.status).toBe("needs_input");
        expect(recovered.execution?.status).toBe("needs_input");
        await runtime.stop();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it("exposes unknown-fence manual confirmation through the production runtime boundary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-career-manual-confirm-"));
    try {
      const authority = new DurableSubmissionAuthority("runtime-worker", { stateFile: join(directory, "submission.json") });
      const tracker = new InMemoryJobTracker();
      let starts = 0;
      const runtime = new BackgroundCareerAgentRuntimeImpl({
        ...runtimeOptions(join(directory, "state.json"), new ReadyExecutor(), new InMemoryNotificationAdapter()),
        tracker,
        submissionAuthority: authority,
        executionHost: { start: async () => { starts += 1; throw new Error("host must not start during manual confirmation"); }, get: async () => { throw new Error("unused"); }, resume: async () => { throw new Error("unused"); } },
      });
      const campaign = runtime.createCampaign({ ...campaignInput(), submissionPolicy: { authority: "automatic", requireExplicitApproval: false } });
      runtime.service.activateCampaign(campaign.id);
      const input = { ...listing().input, isExample: false, sourceUrl: "https://jobs.lever.co/acme/post-1", applicationUrl: "https://jobs.lever.co/acme/post-1/apply", rawText: "Acme\nData Platform Engineer\nRemote United States\n" };
      await runtime.service.processCuratedJob(campaign.id, input);
      const original = runtime.service.listJobs(campaign.id)[0]!;
      const blocker = { id: "submission-confirmation", kind: "external_verification" as const, unit: "submission" as const, field: "submission-confirmation", questionProvenance: "POLICY" as const, question: "Verify whether the application was submitted", context: { jobId: original.id, applicationId: original.applicationId, company: original.job.company, role: original.job.title }, reason: "Unknown result", evidence: ["submit:clicked"], status: "open" as const, createdAt: capturedAt, resumeAfterHuman: false };
      runtime.careerRepository.saveJob({ ...original, status: "needs_input", blockers: [blocker] });
      const fence = authority.claim(original.applicationId!, original.id, capturedAt);
      authority.beforeClick(fence, capturedAt);
      authority.markUnknown(fence, capturedAt);

      const applied = await runtime.confirmManualApplication(campaign.id, original.id);
      expect(applied.status).toBe("applied");
      expect(runtime.service.getApplication(original.applicationId!).status).toBe("applied");
      expect(runtime.service.getApplication(original.applicationId!).manualSubmissionConfirmation?.evidence).toBe("user_confirmed_successful_manual_submission");
      expect(tracker.listUpdates()).toHaveLength(1);
      expect(authority.reconcile(original.applicationId!, original.id)).toMatchObject({ state: "submitted", externalApplicationId: "user-confirmed:application received successfully" });
      expect(starts).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts the persisted Mastra queue identity with mixed-case Ashby URLs before host execution", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-career-ashby-queue-"));
    try {
      let starts = 0;
      const runtime = new BackgroundCareerAgentRuntimeImpl({
        ...runtimeOptions(join(directory, "state.json"), new ReadyExecutor(), new InMemoryNotificationAdapter()),
        executionHost: {
          start: async (request) => { starts += 1; return { id: "ashby-queue-host", mode: "real_local", applicationId: request.application.id, jobId: request.careerJob.id, campaignId: request.campaign.id, status: "ready_to_submit", startedAt: capturedAt, updatedAt: capturedAt, result: { state: "ready_to_submit", inspection: inspection("inspected") } }; },
          get: async () => { throw new Error("unused"); },
          resume: async () => { throw new Error("unused"); },
        },
      });
      const campaign = runtime.createCampaign(campaignInput());
      runtime.service.activateCampaign(campaign.id);
      const processor = createCareerServiceQueueProcessor(runtime, campaign.id);
      const result = await processor.process({
        jobId: "tracker-url:e3dec897",
        company: "Mastra",
        role: "Platform Engineer",
        jobLink: "https://jobs.ashbyhq.com/Mastra/3b06208b-34fe-4dda-b409-ee3fd9305cc3",
        status: "Ready",
        workerId: "queue-worker",
        leaseUntil: "2026-09-20T00:00:00.000Z",
        attemptId: "attempt-1",
        description: "Mastra\nPlatform Engineer\nLocation: Remote - United States\nEmployment Type: Full-time",
      });
      expect(result.status).toBe("Ready to Submit");
      expect(starts).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("processes a daily-hunt snapshot through the existing runtime without creating a campaign", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-career-daily-hunt-"));
    try {
      const adapter = new InMemoryNotificationAdapter();
      const runtime = new BackgroundCareerAgentRuntimeImpl({
        ...runtimeOptions(join(directory, "state.json"), new UnavailableApplicationExecutor(), adapter),
      });
      const campaign = runtime.createCampaign(campaignInput());
      runtime.service.activateCampaign(campaign.id);

      const before = runtime.service.listCampaigns();
      const result = await runtime.processDailyHuntMessage(campaign.id, `
**[Northstar Cloud](https://jobs.lever.co/northstar/abc123) — Cloud Engineer — Remote US.**
Build production cloud infrastructure with Terraform and Kubernetes.

[Apply directly — Northstar Cloud](https://jobs.lever.co/northstar/abc123/apply)
`);

      expect(result.processed).toBe(1);
      expect(runtime.service.listCampaigns()).toHaveLength(before.length);
      expect(runtime.service.listJobs(campaign.id)).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recovers the same failed packet and reconciles stale CAPTCHA attention before publishing the next form blocker", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-career-runtime-"));
    try {
      const statePath = join(directory, "state.json");
      const adapter = new InMemoryNotificationAdapter();
      const stableProfile = profile();
      const runtime = new BackgroundCareerAgentRuntimeImpl({
        ...runtimeOptions(statePath, new ReadyExecutor(), adapter),
        profile: stableProfile,
      });
      const campaign = runtime.createCampaign(campaignInput());
      runtime.service.activateCampaign(campaign.id);
      await runtime.runCampaign(campaign.id);

      const originalJob = runtime.service.listJobs(campaign.id)[0];
      const originalApplication = runtime.service.getApplication(originalJob.applicationId!);
      const applicationService = new ApplicationService(runtime.applicationRepository, stableProfile);
      applicationService.failApplication(originalApplication.id, "Synthetic retryable browser failure.");

      const staleCaptcha: CareerBlocker = {
        id: "captcha-stale",
        kind: "captcha",
        unit: "external",
        questionProvenance: "POLICY",
        question: "Complete the CAPTCHA in the browser",
        context: {
          jobId: originalJob.id,
          applicationId: originalApplication.id,
          company: originalJob.job.company,
          role: originalJob.job.title,
        },
        reason: "A previous browser attempt detected an active CAPTCHA.",
        evidence: ["captcha-state:active_challenge"],
        status: "open",
        createdAt: capturedAt,
        resumeAfterHuman: true,
      };
      const staleEvent = attentionEventForCareerBlocker({
        campaignId: campaign.id,
        jobId: originalJob.id,
        blocker: staleCaptcha,
        createdAt: capturedAt,
        createId: (prefix) => `${prefix}-stale-captcha`,
      });
      expect(staleEvent).toBeDefined();
      runtime.careerRepository.saveJob({
        ...originalJob,
        status: "failed",
        execution: undefined,
        blockers: [staleCaptcha],
      });
      runtime.careerRepository.saveCampaign({
        ...runtime.service.getCampaign(campaign.id),
        attentionEvents: [staleEvent!.record],
      });

      const recovered = runtime.service.recoverFailedApplicationForExecution(campaign.id, originalJob.id);
      expect(recovered.id).toBe(originalJob.id);
      expect(recovered.applicationId).toBe(originalApplication.id);
      expect(recovered.status).toBe("preparing");
      expect(recovered.execution?.hostExecutionId).toBeUndefined();
      expect(runtime.service.getApplication(originalApplication.id).status).toBe("ready_for_review");

      const atsBlocker: CareerBlockerDraft = {
        kind: "unknown_form_field",
        unit: "submission",
        questionProvenance: "ATS_FORM",
        field: "question_1",
        question: "What is your work authorization status?",
        reason: "The real Greenhouse field requires a human answer.",
        evidence: [
          "executor:greenhouse-browser",
          "field-id:question_1",
          "field-type:select",
          "field-required:true",
          "classification:unknown",
          "options:Yes|No",
          "question-prompt:What is your work authorization status?",
        ],
        resumeAfterHuman: true,
      };
      const atsInspection = {
        ...inspection("needs_input", [atsBlocker]),
        captcha: {
          state: "infrastructure_present" as const,
          markerCount: 3,
          visibleMarkerCount: 1,
          challengeIframeCount: 0,
          visibleChallengeIframeCount: 0,
          evidenceCategory: "passive_infrastructure" as const,
        },
      };
      await runtime.service.recordExecutionHostSnapshot(campaign.id, originalJob.id, {
        id: "recovered-host-1",
        mode: "real_local",
        applicationId: originalApplication.id,
        jobId: originalJob.id,
        campaignId: campaign.id,
        status: "needs_input",
        startedAt: capturedAt,
        updatedAt: capturedAt,
        attempt: 1,
        inspection: atsInspection,
        result: {
          state: "requires_human",
          blocker: atsBlocker,
          blockers: [atsBlocker],
          inspection: atsInspection,
        },
      });

      const events = runtime.service.getCampaign(campaign.id).attentionEvents ?? [];
      expect(events.find((event) => event.id === staleEvent!.record.id)).toMatchObject({
        status: "cancelled",
        closureReason: "reclassified_non_blocking",
      });
      expect(adapter.closedEventIds).toContain(staleEvent!.record.id);
      expect(adapter.publishedEvents).toHaveLength(1);
      expect(adapter.publishedEvents[0]).toMatchObject({
        applicationId: originalApplication.id,
        questionProvenance: "ATS_FORM",
        blockerType: "unknown_form_field",
      });
      expect(runtime.service.getJob(originalJob.id).blockers.some((blocker) => blocker.kind === "captcha" && blocker.status === "open")).toBe(false);
      expect(runtime.service.getApplication(originalApplication.id).status).not.toBe("applied");
      await runtime.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("closes a published attention event when its blocker is reclassified as non-blocking", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-career-runtime-"));
    try {
      const statePath = join(directory, "state.json");
      const adapter = new InMemoryNotificationAdapter();
      const runtime = new BackgroundCareerAgentRuntimeImpl(runtimeOptions(statePath, new ReadyExecutor(), adapter));
      const campaign = runtime.createCampaign(campaignInput());
      runtime.service.activateCampaign(campaign.id);
      await runtime.runCampaign(campaign.id);

      const job = runtime.service.listJobs(campaign.id)[0];
      const application = runtime.service.getApplication(job.applicationId!);
      const staleBlocker: CareerBlocker = {
        id: "unsupported-qualification-stale",
        kind: "unknown_fact",
        unit: "submission",
        questionProvenance: "POLICY",
        question: "Unsupported required qualifications",
        context: {
          jobId: job.id,
          applicationId: application.id,
          company: job.job.company,
          role: job.job.title,
        },
        reason: "The posting contains required qualifications not supported by the verified profile.",
        evidence: ["fit:unsupported-required-qualification"],
        status: "resolved",
        createdAt: capturedAt,
        resolvedAt: capturedAt,
      };
      const staleEvent = attentionEventForCareerBlocker({
        campaignId: campaign.id,
        jobId: job.id,
        blocker: staleBlocker,
        createdAt: capturedAt,
        createId: (prefix) => `${prefix}-unsupported-stale`,
      });
      expect(staleEvent).toBeDefined();

      runtime.careerRepository.saveJob({ ...job, blockers: [staleBlocker] });
      runtime.careerRepository.saveCampaign({
        ...runtime.service.getCampaign(campaign.id),
        attentionEvents: [staleEvent!.record],
      });

      await runtime.service.publishPendingAttentionEvents(campaign.id);

      const stored = runtime.service.getCampaign(campaign.id).attentionEvents ?? [];
      expect(stored.find((event) => event.id === staleEvent!.record.id)).toMatchObject({
        status: "cancelled",
        closureReason: "reclassified_non_blocking",
      });
      expect(adapter.closedEventIds).toContain(staleEvent!.record.id);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists a bounded key-value envelope and rehydrates it after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-career-runtime-"));
    try {
      const statePath = join(directory, "state.json");
      const first = new FileKeyValueStorage(statePath);
      first.setItem("campaigns", JSON.stringify([{ id: "campaign-1" }]));
      first.setItem("secret-like-field", "not a credential");

      const second = new FileKeyValueStorage(statePath);
      expect(second.getItem("campaigns")).toContain("campaign-1");
      expect(readFileSync(statePath, "utf8")).toContain('"version":1');
      expect(readFileSync(statePath, "utf8")).not.toContain("ATELIER_SLACK_BOT_TOKEN");

      writeFileSync(statePath, "not-json", "utf8");
      expect(() => new FileKeyValueStorage(statePath)).toThrow("not valid JSON");
      expect(readFileSync(statePath, "utf8")).toBe("not-json");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("blocks before job fan-out and publishes one actionable missing-resume setup event", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-career-runtime-"));
    try {
      const statePath = join(directory, "state.json");
      const adapter = new InMemoryNotificationAdapter();
      const incompleteProfile = profileWithoutResumeFamily();
      const executor = new UnknownThenReadyExecutor();
      const tracker = new InMemoryJobTracker();
      const runtime = new BackgroundCareerAgentRuntimeImpl({
        ...runtimeOptions(statePath, executor, adapter),
        profile: incompleteProfile,
        tracker,
      });
      expect(isCandidateProfile(incompleteProfile)).toBe(true);
      const profileBefore = JSON.stringify(incompleteProfile);
      const campaign = runtime.createCampaign(campaignInput());
      runtime.service.activateCampaign(campaign.id);
      await runtime.start();

      const first = await runtime.runCampaign(campaign.id);
      expect(first.failures).toBe(0);
      expect(first.attentionRequired).toBe(1);
      expect(first.trace?.nodes.some((node) => node.nodeId.startsWith("job.fit."))).toBe(false);
      expect(first.trace?.attentionByCategory).toMatchObject({ provider_configuration: 1 });
      expect(executor.calls).toBe(0);
      expect(runtime.service.listJobs(campaign.id)).toHaveLength(0);
      expect(adapter.publishedEvents).toHaveLength(1);
      expect(adapter.publishedEvents[0]).toMatchObject({
        type: "configuration_required",
        title: "⚠️ Career Agent needs setup",
        message: "I can't evaluate jobs because your private profile has no resume families.",
        remediation: "Add at least one resume family to your local Career Agent profile, then rerun the campaign.",
        reasonCode: "missing_resume_family",
      });
      expect(adapter.publishedEvents[0]).not.toHaveProperty("question");
      expect(runtime.service.getCampaign(campaign.id).attentionEvents).toHaveLength(1);
      expect(runtime.service.getCampaign(campaign.id).attentionEvents?.[0].status).toBe("open");
      expect(JSON.stringify(runtime.service.getCampaign(campaign.id).attentionEvents)).not.toContain(incompleteProfile.identity.email ?? "never");
      expect(JSON.stringify(incompleteProfile)).toBe(profileBefore);
      expect(runtime.service.listEvents(campaign.id).filter((event) => event.type === "application.applied")).toHaveLength(0);
      expect(tracker.listUpdates()).toHaveLength(0);

      const second = await runtime.runCampaign(campaign.id);
      expect(second.failures).toBe(0);
      expect(second.attentionRequired).toBe(1);
      expect(second.trace?.nodes.some((node) => node.nodeId.startsWith("job.fit."))).toBe(false);
      expect(adapter.publishedEvents).toHaveLength(1);
      expect(runtime.service.getCampaign(campaign.id).attentionEvents).toHaveLength(1);
      await runtime.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("blocks before job fan-out when the configured family has no usable local artifact", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-career-runtime-"));
    try {
      const statePath = join(directory, "state.json");
      const adapter = new InMemoryNotificationAdapter();
      const executor = new UnknownThenReadyExecutor();
      const runtime = new BackgroundCareerAgentRuntimeImpl({
        ...runtimeOptions(statePath, executor, adapter),
        resumeArtifactAvailable: () => false,
      });
      const campaign = runtime.createCampaign(campaignInput());
      runtime.service.activateCampaign(campaign.id);
      await runtime.start();

      const result = await runtime.runCampaign(campaign.id);
      expect(result.failures).toBe(0);
      expect(result.attentionRequired).toBe(1);
      expect(result.trace?.nodes.some((node) => node.nodeId.startsWith("job.fit."))).toBe(false);
      expect(executor.calls).toBe(0);
      expect(runtime.service.listJobs(campaign.id)).toHaveLength(0);
      expect(adapter.publishedEvents).toHaveLength(1);
      expect(adapter.publishedEvents[0]).toMatchObject({
        type: "configuration_required",
        reasonCode: "missing_resume_artifact",
        message: "I can't prepare applications because no usable local resume artifact is configured for your private profile.",
        remediation: "Place a PDF or DOCX under .local/career-agent/resumes/ and map it to a resume family, then rerun the campaign.",
      });
      expect(JSON.stringify(runtime.service.getCampaign(campaign.id).attentionEvents)).not.toContain("resumeText");
      await runtime.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("survives process recreation and applies one explicit response through the existing resume path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-career-runtime-"));
    try {
      const statePath = join(directory, "state.json");
      const firstAdapter = new InMemoryNotificationAdapter();
      const firstExecutor = new UnknownThenReadyExecutor();
      const stableProfile = profile();
      const tracker = new InMemoryJobTracker();
      const first = new BackgroundCareerAgentRuntimeImpl({
        ...runtimeOptions(statePath, firstExecutor, firstAdapter),
        profile: stableProfile,
        tracker,
      });
      const profileBeforeResponse = JSON.stringify(stableProfile);
      const campaign = first.createCampaign(campaignInput());
      first.service.activateCampaign(campaign.id);
      await first.runCampaign(campaign.id);

      const firstJob = first.service.listJobs(campaign.id)[0];
      const firstEvent = first.service.listAttentionEvents(campaign.id)[0];
      expect(firstJob.status).toBe("needs_input");
      expect(firstAdapter.publishedEvents).toHaveLength(1);
      expect(firstEvent.status).toBe("open");

      await first.stop();

      const secondAdapter = new InMemoryNotificationAdapter();
      const secondExecutor = new UnknownThenReadyExecutor();
      const second = new BackgroundCareerAgentRuntimeImpl(runtimeOptions(statePath, secondExecutor, secondAdapter));
      expect(second.service.listCampaigns()).toHaveLength(1);
      expect(second.service.listAttentionEvents(campaign.id)[0].status).toBe("open");

      const resolved = await second.service.resolveAttentionResponse({
        eventId: firstEvent.id,
        selectedOption: "yes",
        actorIdentity: { provider: "test", userId: "human-1" },
        respondedAt: "2026-09-01T12:30:00.000Z",
      });
      expect(resolved.status).toBe("resolved");
      expect(second.service.getJob(firstJob.id).status).toBe("ready_to_submit");
      expect(second.service.getJob(firstJob.id).blockers[0]).toMatchObject({ status: "resolved", value: "yes" });
      expect(secondExecutor.calls).toBe(1);
      expect(second.service.getApplication(firstJob.applicationId!).status).toBe("ready_for_review");
      expect(second.service.listEvents(campaign.id).some((event) => event.type === "application.applied")).toBe(false);
      expect(profileBeforeResponse).toBe(JSON.stringify(stableProfile));
      expect(tracker.listUpdates()).toHaveLength(0);
      expect(second.service.getCampaign(campaign.id).attentionEvents?.[0].status).toBe("resolved");

      const duplicate = await second.service.resolveAttentionResponse({
        eventId: firstEvent.id,
        selectedOption: "yes",
        actorIdentity: { provider: "test", userId: "human-1" },
        respondedAt: "2026-09-01T12:31:00.000Z",
      });
      expect(duplicate.status).toBe("duplicate");
      expect(secondExecutor.calls).toBe(1);
      await second.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reconciles a same-status host result when the next blocker has not been published yet", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-career-runtime-"));
    try {
      const statePath = join(directory, "state.json");
      const adapter = new InMemoryNotificationAdapter();
      const runtime = new BackgroundCareerAgentRuntimeImpl(runtimeOptions(statePath, new UnknownThenReadyExecutor(), adapter));
      const campaign = runtime.createCampaign(campaignInput());
      runtime.service.activateCampaign(campaign.id);
      await runtime.runCampaign(campaign.id);

      const originalJob = runtime.service.getJob(runtime.service.listJobs(campaign.id)[0].id);
      const currentBlocker = originalJob.blockers.find((candidate) => candidate.status === "open");
      expect(currentBlocker).toBeDefined();
      adapter.publishedEvents.length = 0;
      runtime.careerRepository.saveCampaign({
        ...runtime.service.getCampaign(campaign.id),
        attentionEvents: [],
      });
      runtime.careerRepository.saveJob(makeResumable(originalJob));

      const nextSnapshot: ExecutionHostSnapshot = {
        id: "runtime-host-1",
        mode: "real_local",
        applicationId: originalJob.applicationId!,
        jobId: originalJob.id,
        campaignId: campaign.id,
        status: "needs_input",
        startedAt: capturedAt,
        updatedAt: capturedAt,
        result: {
          state: "requires_human",
          blocker: blocker(),
          blockers: [blocker()],
          inspection: inspection("needs_input", [blocker()]),
        },
      };

      await runtime.service.recordExecutionHostSnapshot(campaign.id, originalJob.id, nextSnapshot);
      expect(runtime.service.listAttentionEvents(campaign.id)).toHaveLength(1);
      expect(adapter.publishedEvents).toHaveLength(1);

      await runtime.service.recordExecutionHostSnapshot(campaign.id, originalJob.id, nextSnapshot);
      expect(runtime.service.listAttentionEvents(campaign.id)).toHaveLength(1);
      expect(adapter.publishedEvents).toHaveLength(1);
      await runtime.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("starts prepared direct Greenhouse jobs through the host without destination-resolution metadata", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-career-runtime-"));
    const host = new ReadyHost();
    const started: ExecutionHostRequest[] = [];
    const runtime = new BackgroundCareerAgentRuntimeImpl({
      ...runtimeOptions(join(directory, "state.json"), new UnknownThenReadyExecutor(), new InMemoryNotificationAdapter()),
      scout: new JobScout({ "greenhouse:example": {
        id: "greenhouse:example",
        mode: "live",
        discover: async () => [{
          sourceRecordId: "123", sourceMode: "live", actionability: "actionable",
          input: { ...listing().input, isExample: false,
            sourceUrl: "https://job-boards.greenhouse.io/example/jobs/123",
            applicationUrl: "https://job-boards.greenhouse.io/example/jobs/123",
          },
        }],
      } }),
      autoStartHostExecutions: true,
      executionHost: {
        start: async (request) => { started.push(request); return host.resume("runtime-host-1", request); },
        get: (id) => host.get(id),
        resume: (id, request) => host.resume(id, request),
      },
    });
    try {
      const campaign = runtime.createCampaign({ ...campaignInput(), searchSources: ["greenhouse:example"] });
      runtime.service.activateCampaign(campaign.id);
      await runtime.runCampaign(campaign.id);
      const job = runtime.service.listJobs(campaign.id)[0];
      expect(started).toHaveLength(1);
      expect(started[0].careerJob.id).toBe(job.id);
      expect(runtime.service.getJob(job.id).status).toBe("ready_to_submit");
      expect(runtime.service.getApplication(job.applicationId!).status).toBe("ready_for_review");
    } finally {
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses the same durable event with the existing host resume port when a host session is present", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-career-runtime-"));
    try {
      const statePath = join(directory, "state.json");
      const firstAdapter = new InMemoryNotificationAdapter();
      const first = new BackgroundCareerAgentRuntimeImpl(runtimeOptions(statePath, new UnknownThenReadyExecutor(), firstAdapter));
      const campaign = first.createCampaign(campaignInput());
      first.service.activateCampaign(campaign.id);
      await first.runCampaign(campaign.id);
      const originalJob = first.service.listJobs(campaign.id)[0];
      first.careerRepository.saveJob(makeResumable(originalJob));
      const event = first.service.listAttentionEvents(campaign.id)[0];
      await first.stop();

      const host = new ReadyHost();
      const second = new BackgroundCareerAgentRuntimeImpl({
        ...runtimeOptions(statePath, new UnavailableApplicationExecutor(), new InMemoryNotificationAdapter()),
        executionHost: host,
      });
      await second.service.resolveAttentionResponse({
        eventId: event.id,
        selectedOption: "no",
        actorIdentity: { provider: "test", userId: "human-1" },
        respondedAt: "2026-09-01T12:40:00.000Z",
      });
      expect(host.resumeCalls).toBe(1);
      expect(second.service.getJob(originalJob.id).status).toBe("ready_to_submit");
      expect(second.service.getJob(originalJob.id).blockers[0]).toMatchObject({ status: "resolved", value: "no" });
      expect(second.service.getApplication(originalJob.applicationId!).status).toBe("ready_for_review");
      expect(second.service.listEvents(campaign.id).some((candidate) => candidate.type === "application.applied")).toBe(false);
      await second.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retries an exact proof-free pre-submit failure through the never-submit restart path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-career-runtime-"));
    try {
      const host = new RestartedHost();
      const runtime = new BackgroundCareerAgentRuntimeImpl({
        ...runtimeOptions(join(directory, "state.json"), new ReadyExecutor(), new InMemoryNotificationAdapter()),
        executionHost: host,
      });
      const campaign = runtime.createCampaign(campaignInput());
      runtime.service.activateCampaign(campaign.id);
      await runtime.runCampaign(campaign.id);
      const original = runtime.service.listJobs(campaign.id)[0]!;
      const application = runtime.service.getApplication(original.applicationId!);
      runtime.applicationRepository.saveApplication({
        ...application,
        status: "failed",
        failureReason: "Resume upload failed before submission.",
        updatedAt: capturedAt,
      });
      runtime.careerRepository.saveJob({
        ...original,
        status: "failed",
        execution: {
          status: "failed",
          fieldsDetected: ["input-resume"],
          fieldsFilled: [],
          unresolvedFields: ["Résumé"],
          evidence: ["submit:not-clicked", "submission:manual-only"],
          startedAt: capturedAt,
          updatedAt: capturedAt,
        },
      });

      const retried = await runtime.restartExistingApplication(campaign.id, original.id, original.applicationId!);
      expect(host.startCalls).toBe(1);
      expect(retried.id).toBe(original.id);
      expect(retried.applicationId).toBe(original.applicationId);
      expect(retried.status).toBe("ready_to_submit");
      expect(runtime.service.getApplication(original.applicationId!).status).toBe("ready_for_review");
      await runtime.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("sequences real-local attention blockers before resuming the browser host", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-career-runtime-"));
    try {
      const adapter = new InMemoryNotificationAdapter();
      const host = new ReadyHost();
      const runtime = new BackgroundCareerAgentRuntimeImpl({
        ...runtimeOptions(join(directory, "state.json"), new SequentialSubjectiveExecutor(), adapter),
        executionHost: host,
      });
      const campaign = runtime.createCampaign(campaignInput());
      runtime.service.activateCampaign(campaign.id);
      await runtime.runCampaign(campaign.id);

      const initial = runtime.service.getJob(runtime.service.listJobs(campaign.id)[0].id);
      runtime.careerRepository.saveJob(makeResumable(initial));
      const first = runtime.service.listAttentionEvents(campaign.id)[0];
      expect(first.question?.prompt).toContain("(1)");

      await runtime.service.resolveAttentionResponse({
        eventId: first.id,
        selectedOption: "first grounded answer",
        actorIdentity: { provider: "test", userId: "human-1" },
        respondedAt: "2026-09-01T12:30:00.000Z",
      });

      expect(host.resumeCalls).toBe(0);
      expect(adapter.publishedEvents).toHaveLength(2);
      const afterFirst = runtime.service.listAttentionEvents(campaign.id);
      expect(afterFirst.map((event) => event.status)).toEqual(["resolved", "open"]);
      expect(afterFirst[1].question?.prompt).toContain("(2)");

      await runtime.service.resolveAttentionResponse({
        eventId: afterFirst[1].id,
        selectedOption: "second grounded answer",
        actorIdentity: { provider: "test", userId: "human-1" },
        respondedAt: "2026-09-01T12:31:00.000Z",
      });

      expect(host.resumeCalls).toBe(1);
      expect(runtime.service.getJob(initial.id).execution?.status).toBe("ready_to_submit");
      expect(runtime.service.listEvents(campaign.id).some((event) => event.type === "application.applied")).toBe(false);
      await runtime.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reopens the same packet when a resolved answer points at a closed host session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-career-runtime-"));
    try {
      const statePath = join(directory, "state.json");
      const first = new BackgroundCareerAgentRuntimeImpl(runtimeOptions(
        statePath,
        new UnknownThenReadyExecutor(),
        new InMemoryNotificationAdapter(),
      ));
      const campaign = first.createCampaign(campaignInput());
      first.service.activateCampaign(campaign.id);
      await first.runCampaign(campaign.id);
      const originalJob = first.service.listJobs(campaign.id)[0];
      const originalApplicationId = originalJob.applicationId!;
      first.careerRepository.saveJob(makeResumable(originalJob));
      const event = first.service.listAttentionEvents(campaign.id)[0];
      await first.stop();

      const host = new RestartedHost();
      const second = new BackgroundCareerAgentRuntimeImpl({
        ...runtimeOptions(statePath, new UnavailableApplicationExecutor(), new InMemoryNotificationAdapter()),
        executionHost: host,
      });
      const result = await second.service.resolveAttentionResponse({
        eventId: event.id,
        selectedOption: "yes",
        actorIdentity: { provider: "test", userId: "human-1" },
        respondedAt: "2026-09-01T12:45:00.000Z",
      });
      expect(result.status).toBe("resolved");
      expect(host.resumeCalls).toBe(1);
      expect(host.startCalls).toBe(1);
      const recovered = second.service.getJob(originalJob.id);
      expect(recovered.applicationId).toBe(originalApplicationId);
      expect(recovered.status).toBe("ready_to_submit");
      expect(recovered.blockers.find((candidate) => candidate.field === fieldId)).toMatchObject({
        status: "resolved",
        value: "yes",
      });
      expect(second.service.getCampaign(campaign.id).attentionEvents?.find((candidate) => candidate.id === event.id)?.status).toBe("resolved");
      expect(second.service.listEvents(campaign.id).some((candidate) => candidate.type === "application.applied")).toBe(false);
      await second.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retries a resolved answer on listener restart only when no host progress was recorded", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-career-runtime-"));
    try {
      const statePath = join(directory, "state.json");
      const first = new BackgroundCareerAgentRuntimeImpl(runtimeOptions(
        statePath,
        new UnknownThenReadyExecutor(),
        new InMemoryNotificationAdapter(),
      ));
      const campaign = first.createCampaign(campaignInput());
      first.service.activateCampaign(campaign.id);
      await first.runCampaign(campaign.id);
      const originalJob = first.service.listJobs(campaign.id)[0];
      first.careerRepository.saveJob(makeResumable(originalJob));
      const event = first.service.listAttentionEvents(campaign.id)[0];
      await first.service.resolveAttentionResponse({
        eventId: event.id,
        selectedOption: "yes",
        actorIdentity: { provider: "test", userId: "human-1" },
        respondedAt: "2026-09-01T12:50:00.000Z",
      });
      await first.stop();

      const host = new ReadyHost();
      const second = new BackgroundCareerAgentRuntimeImpl({
        ...runtimeOptions(statePath, new UnavailableApplicationExecutor(), new InMemoryNotificationAdapter()),
        executionHost: host,
      });
      await second.start();
      expect(host.resumeCalls).toBe(1);
      expect(second.service.getJob(originalJob.id).status).toBe("ready_to_submit");
      expect(second.service.getJob(originalJob.id).blockers.find((candidate) => candidate.field === fieldId)).toMatchObject({
        status: "resolved",
        value: "yes",
      });
      await second.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps an open event when notification delivery fails and retries it after recreation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-career-runtime-"));
    try {
      const statePath = join(directory, "state.json");
      const failedAdapter = new InMemoryNotificationAdapter();
      failedAdapter.publishAttentionEvent = async () => { throw new Error("Slack unavailable"); };
      const first = new BackgroundCareerAgentRuntimeImpl(runtimeOptions(statePath, new UnknownThenReadyExecutor(), failedAdapter));
      const campaign = first.createCampaign(campaignInput());
      first.service.activateCampaign(campaign.id);
      await first.runCampaign(campaign.id);
      const failedDelivery = first.service.getCampaign(campaign.id).attentionEvents?.[0];
      expect(failedDelivery).toMatchObject({
        deliveryFailureCount: 1,
        lastDeliveryFailureCode: "provider_error",
      });
      expect(failedDelivery).not.toHaveProperty("publishedAt");
      expect(readFileSync(statePath, "utf8")).not.toContain("Slack unavailable");
      await first.stop();

      const recoveredAdapter = new InMemoryNotificationAdapter();
      const second = new BackgroundCareerAgentRuntimeImpl(runtimeOptions(statePath, new UnknownThenReadyExecutor(), recoveredAdapter));
      await second.start();
      expect(recoveredAdapter.publishedEvents).toHaveLength(1);
      expect(second.service.getCampaign(campaign.id).attentionEvents?.[0].publishedAt).toBeDefined();
      await second.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("hydrates persisted Slack correlation before listener start without republishing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-career-runtime-"));
    try {
      const statePath = join(directory, "state.json");
      const delivery: AttentionProviderDelivery = {
        provider: "slack",
        messageTs: "1710000000.000051",
        channelId: "C123456",
      };
      const firstAdapter = new InMemoryNotificationAdapter();
      firstAdapter.publishAttentionEvent = async () => delivery;
      const first = new BackgroundCareerAgentRuntimeImpl(runtimeOptions(statePath, new UnknownThenReadyExecutor(), firstAdapter));
      const campaign = first.createCampaign(campaignInput());
      first.service.activateCampaign(campaign.id);
      const firstRun = await first.runCampaign(campaign.id);
      expect(firstRun.pursued).toBe(1);
      expect(first.service.getCampaign(campaign.id).attentionEvents?.[0]).toMatchObject({
        publishedAt: expect.any(String),
        providerDelivery: delivery,
      });
      await first.stop();

      const secondAdapter = new InMemoryNotificationAdapter();
      secondAdapter.publishAttentionEvent = async () => {
        throw new Error("A previously published event must not be republished.");
      };
      const hydrationOrder: string[] = [];
      let hydrated: readonly PersistedAttentionEvent[] = [];
      const second = new BackgroundCareerAgentRuntimeImpl({
        ...runtimeOptions(statePath, new UnknownThenReadyExecutor(), secondAdapter),
        notification: {
          adapter: secondAdapter,
          hydrate: (events) => {
            hydrationOrder.push("hydrate");
            hydrated = events;
          },
          start: async () => {
            hydrationOrder.push("start");
            expect(hydrated).toHaveLength(1);
          },
        },
      });
      await second.start();
      expect(hydrationOrder).toEqual(["hydrate", "start"]);
      expect(hydrated[0].providerDelivery).toEqual(delivery);
      expect(secondAdapter.publishedEvents).toHaveLength(0);
      await second.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("publishes a Rippling salary ATS blocker as Slack needs_input attention without submitting", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-career-runtime-"));
    try {
      const statePath = join(directory, "state.json");
      const adapter = new InMemoryNotificationAdapter();
      const executor = new RipplingSalaryExecutor();
      const runtime = new BackgroundCareerAgentRuntimeImpl(runtimeOptions(statePath, executor, adapter));
      const campaign = runtime.createCampaign(campaignInput());
      runtime.service.activateCampaign(campaign.id);
      await runtime.runCampaign(campaign.id);

      const job = runtime.service.listJobs(campaign.id)[0];
      expect(executor.calls).toBe(1);
      expect(job.status).toBe("needs_input");
      expect(job.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "salary",
          status: "open",
          question: ripplingSalaryPrompt,
        }),
      ]));
      expect(adapter.publishedEvents).toHaveLength(1);
      expect(adapter.publishedEvents[0]).toMatchObject({
        type: "needs_input",
        blockerType: "salary",
        questionProvenance: "ATS_FORM",
        title: "Career Agent needs input",
        question: {
          prompt: ripplingSalaryPrompt,
          kind: "free_text",
        },
      });
      expect(runtime.service.listEvents(campaign.id).some((candidate) => candidate.type === "application.applied")).toBe(false);
      await runtime.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("publishes one canonical blocker and advances only after its response", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-career-runtime-"));
    try {
      const adapter = new InMemoryNotificationAdapter();
      const runtime = new BackgroundCareerAgentRuntimeImpl(runtimeOptions(join(directory, "state.json"), new SequentialSubjectiveExecutor(), adapter));
      const campaign = runtime.createCampaign(campaignInput());
      runtime.service.activateCampaign(campaign.id);
      await runtime.runCampaign(campaign.id);

      const job = runtime.service.listJobs(campaign.id)[0];
      await runtime.service.publishNextAttentionEvent(campaign.id, job.id);
      expect(adapter.publishedEvents).toHaveLength(1);
      expect(adapter.publishedEvents[0].question?.prompt).toContain("(1)");
      expect(runtime.service.listAttentionEvents(campaign.id).filter((event) => event.status === "open")).toHaveLength(1);

      const first = runtime.service.listAttentionEvents(campaign.id)[0];
      await runtime.service.resolveAttentionResponse({
        eventId: first.id,
        selectedOption: "first grounded answer",
        actorIdentity: { provider: "test", userId: "human-1" },
        respondedAt: "2026-09-01T12:30:00.000Z",
      });
      const afterResponse = runtime.service.getJob(job.id);
      const next = afterResponse.blockers.find((blocker) => blocker.field === "subjective-2");
      expect(next).toBeDefined();
      runtime.careerRepository.saveJob({
        ...afterResponse,
        status: "needs_input",
        blockers: afterResponse.blockers.map((blocker) => blocker.id === next!.id
          ? { ...blocker, status: "open" as const, resolvedAt: undefined, value: undefined }
          : blocker),
      });
      await runtime.service.publishNextAttentionEvent(campaign.id, job.id);
      expect(adapter.publishedEvents).toHaveLength(2);
      expect(adapter.publishedEvents[1].question?.prompt).toContain("(2)");
      expect(runtime.service.listAttentionEvents(campaign.id).filter((event) => event.status === "open")).toHaveLength(1);
      await runtime.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

});
