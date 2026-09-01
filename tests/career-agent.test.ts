import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANSWER_POLICIES,
  ApplicationService,
  DeterministicModelClient,
  InMemoryApplicationRepository,
  InMemoryCareerRepository,
  InMemoryJobTracker,
  JobScout,
  SimulatedApplicationExecutor,
  StaticJobSource,
  UnavailableApplicationExecutor,
  assessFit,
  clearCareerRepositoryStorage,
  createApplicationService,
  decidePursuit,
  exampleCandidateProfile,
  eventLabel,
  isAttentionWorthyEvent,
  isApplication,
  isCareerEvent,
  isCareerJob,
  isCampaign,
  isSubmissionProof,
  normalizeJobPosting,
  type ApplicationExecutor,
  type ApplicationExecutorResult,
  type CandidateProfile,
  type CareerEvent,
  type CareerJob,
  type CreateCampaignInput,
  type JobSourceListing,
  type KeyValueStorage,
  type ModelClient,
  type SubmissionProof,
} from "../application-agent/src";
import { applyHardFilters, verifyPreparedApplication } from "../application-agent/src/domain/policies";
import { CareerAgentService } from "../application-agent/src/service/careerAgentService";
import { LocalStorageCareerRepository } from "../application-agent/src/persistence/careerRepository";

const capturedAt = "2026-08-30T12:00:00.000Z";

function cloneProfile(): CandidateProfile {
  return JSON.parse(JSON.stringify(exampleCandidateProfile)) as CandidateProfile;
}

function fullyAuthorizedTestProfile(): CandidateProfile {
  const profile = cloneProfile();
  profile.profileKind = "private";
  profile.answerPolicies = Object.fromEntries(
    Object.keys(DEFAULT_ANSWER_POLICIES).map((field) => [field, "auto"]),
  ) as CandidateProfile["answerPolicies"];
  profile.approvedReusableAnswers = {
    salary_expectations: "USD 145000",
    relocation: "No relocation required for remote roles",
    travel: "Up to 10% travel",
    sponsorship: "No sponsorship answer provided by this synthetic test profile",
    demographic_disclosure: "Prefer not to answer",
    legal_attestations: "I will review legal attestations manually",
    why_company: "Approved synthetic answer",
    cover_letter: "Approved synthetic cover letter",
  };
  return profile;
}

function runtime(start = capturedAt) {
  let tick = 0;
  let sequence = 0;
  const base = Date.parse(start);
  return {
    now: () => new Date(base + tick++ * 1_000).toISOString(),
    createId: (prefix: string) => `${prefix}-test-${++sequence}`,
  };
}

function posting(
  company: string,
  title: string,
  requiredSkills: readonly string[],
  sourceSlug: string,
  extra = "",
) {
  return normalizeJobPosting({
    isExample: true,
    companyHint: company,
    titleHint: title,
    sourceUrl: `https://jobs.example.invalid/${sourceSlug}`,
    applicationUrl: `https://jobs.example.invalid/${sourceSlug}/apply`,
    rawText: `${company}
${title}
Location: Remote - United States
Employment type: Full-time

${extra || "Build useful systems for an example team."}

Required qualifications
${requiredSkills.map((skill) => `- ${skill}`).join("\n")}
`,
  }, capturedAt);
}

function listing(
  company: string,
  title: string,
  requiredSkills: readonly string[],
  sourceSlug: string,
): JobSourceListing {
  return {
    sourceRecordId: sourceSlug,
    input: {
      isExample: true,
      companyHint: company,
      titleHint: title,
      sourceUrl: `https://jobs.example.invalid/${sourceSlug}`,
      applicationUrl: `https://jobs.example.invalid/${sourceSlug}/apply`,
      rawText: `${company}
${title}
Location: Remote - United States
Employment type: Full-time

Build useful systems for an example team.

Required qualifications
${requiredSkills.map((skill) => `- ${skill}`).join("\n")}
`,
    },
  };
}

function campaignInput(overrides: Partial<CreateCampaignInput> = {}): CreateCampaignInput {
  return {
    name: "Synthetic engineering campaign",
    goal: "Test grounded autonomous preparation without external side effects.",
    searchSources: ["fake-source"],
    searchCriteria: {
      roleLanes: ["engineer"],
      remoteOnly: true,
      employmentTypes: ["full time"],
    },
    applicationPolicy: {
      autoPrepare: true,
      allowGroundedDrafts: true,
      approvedResumeFamilies: [],
    },
    submissionPolicy: {
      authority: "simulated",
      requireExplicitApproval: false,
    },
    dailyApplicationLimit: 3,
    ...overrides,
  };
}

function makeService(options: {
  profile?: CandidateProfile;
  listings?: readonly JobSourceListing[];
  executor?: ApplicationExecutor;
  tracker?: InMemoryJobTracker;
} = {}) {
  const profile = options.profile ?? fullyAuthorizedTestProfile();
  const applicationRepository = new InMemoryApplicationRepository();
  const careerRepository = new InMemoryCareerRepository();
  const clock = runtime();
  const model = new DeterministicModelClient();
  const applicationService = new ApplicationService(applicationRepository, profile, model, clock);
  const source = new StaticJobSource("fake-source", options.listings ?? [
    listing("Example Cloud Systems", "Cloud Platform Engineer", ["AWS", "Kubernetes", "Python"], "cloud-001"),
  ]);
  const scout = new JobScout({ [source.id]: source }, clock.now);
  const tracker = options.tracker ?? new InMemoryJobTracker();
  const service = new CareerAgentService(
    profile,
    {
      applicationService,
      careerRepository,
      scout,
      executor: options.executor ?? new SimulatedApplicationExecutor(),
      tracker,
    },
    clock,
  );
  return { service, applicationRepository, careerRepository, applicationService, tracker, clock };
}

function proof(at = capturedAt): SubmissionProof {
  return {
    mode: "external",
    provider: "test-provider",
    externalApplicationId: "external-test-1",
    submittedAt: at,
    evidence: "Test executor returned an explicit external proof.",
  };
}

class OneHumanThenSuccessExecutor implements ApplicationExecutor {
  readonly id = "one-human-then-success";
  private readonly humanSeen = new Set<string>();
  calls = 0;

  async execute(request: { careerJob: CareerJob; now: string }): Promise<ApplicationExecutorResult> {
    this.calls += 1;
    if (request.careerJob.job.company === "Example Product Studio" && !this.humanSeen.has(request.careerJob.id)) {
      this.humanSeen.add(request.careerJob.id);
      return {
        state: "requires_human",
        blocker: {
          kind: "external_login",
          unit: "external",
          question: "Authenticate the application session",
          reason: "A user-authenticated session is required before the executor can continue.",
          evidence: ["test-executor", "passwords-never-requested"],
        },
      };
    }
    return {
      state: "submitted",
      proof: {
        mode: "simulated",
        provider: this.id,
        externalApplicationId: `simulated-${request.careerJob.id}`,
        submittedAt: request.now,
        evidence: "Deterministic test proof; no external request was sent.",
      },
    };
  }
}

describe("Autonomous Career Agent domain seams", () => {
  it("creates, activates, pauses, completes, and persists campaigns", async () => {
    const { service, careerRepository } = makeService();
    const campaign = service.createCampaign(campaignInput());
    expect(campaign.status).toBe("draft");
    expect(isCampaign(careerRepository.getCampaign(campaign.id))).toBe(true);

    expect(service.activateCampaign(campaign.id).status).toBe("active");
    expect(service.pauseCampaign(campaign.id).status).toBe("paused");
    expect(service.activateCampaign(campaign.id).status).toBe("active");
    expect(service.markOfferAccepted(campaign.id).status).toBe("completed");

    const reloadedService = makeService({}).service;
    // The in-memory repository is intentionally replaceable; persistence round-trip is covered below.
    expect(reloadedService.listCampaigns()).toHaveLength(0);
    expect(service.listEvents(campaign.id).map((event) => event.type)).toEqual([
      "campaign.created",
      "campaign.started",
      "campaign.paused",
      "campaign.started",
      "campaign.completed",
    ]);
  });

  it("normalizes sources, deduplicates postings, and records malformed listings as source failures", async () => {
    const source = new StaticJobSource("source", [
      listing("Example Cloud Systems", "Cloud Platform Engineer", ["AWS"], "same"),
      { ...listing("Example Cloud Systems", "Cloud Platform Engineer", ["AWS"], "same"), sourceRecordId: "duplicate" },
      { input: { isExample: true, rawText: "not enough" } },
    ]);
    const campaign = {
      ...makeService().service.createCampaign(campaignInput({ searchSources: ["source"] })),
      status: "active" as const,
    };
    const result = await new JobScout({ source }, () => capturedAt).discover(campaign);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].fingerprint).toContain("source:source:id:same");
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].reason).toContain("Malformed listing");
  });

  it("bounds a slow job source instead of leaving a campaign run hanging", async () => {
    const campaign = makeService().service.createCampaign(campaignInput({ searchSources: ["slow-source"] }));
    const slowSource = {
      id: "slow-source",
      discover: async () => new Promise<readonly JobSourceListing[]>(() => undefined),
    };
    const result = await new JobScout({ "slow-source": slowSource }, () => capturedAt, { timeoutMs: 1 }).discover({
      ...campaign,
      status: "active",
    });
    expect(result.jobs).toHaveLength(0);
    expect(result.failures[0].reason).toContain("timed out");
  });

  it("applies deterministic hard filters and configurable qualitative pursuit policy", () => {
    const remoteJob = posting("Example Cloud Systems", "Cloud Platform Engineer", ["AWS"], "filter-1");
    const rejected = applyHardFilters(remoteJob, {
      roleLanes: ["frontend"],
      locations: [],
      remoteOnly: true,
      employmentTypes: [],
      excludedSeniorities: [],
      excludedCompanies: [],
    });
    expect(rejected.decision).toBe("reject");
    expect(rejected.reason).toContain("role lane");

    const fit = assessFit(remoteJob, fullyAuthorizedTestProfile());
    expect(fit.classification).toBe("strong");
    expect(decidePursuit(fit, { strong: "pursue", good: "pursue", stretch: "hold", weak: "reject" }).decision).toBe("pursue");
    expect(decidePursuit({ ...fit, classification: "good" }, { strong: "pursue", good: "pursue", stretch: "hold", weak: "reject" }).decision).toBe("pursue");
    expect(decidePursuit({ ...fit, classification: "stretch" }, { strong: "pursue", good: "pursue", stretch: "hold", weak: "reject" }).decision).toBe("hold");
    expect(decidePursuit({ ...fit, classification: "weak" }, { strong: "pursue", good: "pursue", stretch: "hold", weak: "reject" }).decision).toBe("reject");
  });

  it("preserves the submission gate and requires proof before applied state", async () => {
    const profile = fullyAuthorizedTestProfile();
    const repository = new InMemoryApplicationRepository();
    const applicationService = new ApplicationService(repository, profile, undefined, runtime());
    const application = await applicationService.prepareFromNormalizedJob(
      posting("Example Cloud Systems", "Cloud Platform Engineer", ["AWS"], "gate-1"),
      true,
    );
    expect(application.status).toBe("ready_for_review");
    expect(isApplication(application)).toBe(true);
    expect(isSubmissionProof(undefined)).toBe(false);

    const service = makeService({ profile }).service;
    const campaign = service.createCampaign(campaignInput({ submissionPolicy: { authority: "never", requireExplicitApproval: false } }));
    const gate = verifyPreparedApplication(
      application,
      campaign.applicationPolicy,
      campaign.submissionPolicy,
      campaign,
    );
    expect(gate.allowed).toBe(false);
    expect(gate.blockers.some((blocker) => blocker.kind === "submission_approval")).toBe(true);

    expect(() => applicationService.recordApplied(application.id, proof())).not.toThrow();
    expect(applicationService.getApplication(application.id).status).toBe("applied");
    expect(isApplication(applicationService.getApplication(application.id))).toBe(true);
    await expect(applicationService.submitApplication(application.id, { approved: true, approvedAt: capturedAt })).rejects.toThrow("submission is disabled");
  });

  it("handles application caps and keeps rejected or held jobs out of preparation", async () => {
    const { service, applicationRepository } = makeService({
      listings: [
        listing("Example Cloud Systems", "Cloud Platform Engineer", ["AWS"], "cap-1"),
        listing("Example Product Studio", "Frontend Software Engineer", ["React", "TypeScript"], "cap-2"),
      ],
    });
    const campaign = service.createCampaign(campaignInput({ dailyApplicationLimit: 1 }));
    service.activateCampaign(campaign.id);
    const result = await service.runCampaign(campaign.id);
    expect(result.applied).toBe(1);
    expect(result.held).toBe(1);
    expect(applicationRepository.listApplications()).toHaveLength(1);
    expect(service.listJobs(campaign.id).some((job) => job.status === "held" && job.decisionReason?.includes("cap"))).toBe(true);
  });

  it("creates structured blocker state, resolves it, and resumes without rebuilding the packet", async () => {
    const profile = cloneProfile();
    const { service, applicationService } = makeService({ profile });
    const campaign = service.createCampaign(campaignInput({
      applicationPolicy: { autoPrepare: true, allowGroundedDrafts: true, approvedResumeFamilies: [] },
      submissionPolicy: { authority: "never", requireExplicitApproval: false },
    }));
    service.activateCampaign(campaign.id);
    const result = await service.runCampaign(campaign.id);
    const job = service.listJobs(campaign.id)[0];
    expect(result.prepared).toBe(1);
    expect(job.status).toBe("needs_input");
    expect(job.blockers.some((blocker) => blocker.kind === "salary")).toBe(true);
    expect(job.blockers[0].context.applicationId).toBeDefined();

    const appId = job.applicationId!;
    const before = applicationService.getApplication(appId);
    const blocker = job.blockers.find((candidate) => candidate.kind === "salary")!;
    const resumed = await service.resolveCareerBlocker(campaign.id, job.id, blocker.id, "USD 150000");
    expect(resumed.status).toBe("needs_input");
    expect(applicationService.getApplication(appId).resume?.generatedAt).toBe(before.resume?.generatedAt);
    expect(applicationService.getApplication(appId).status).toBe("needs_input");
  });

  it("persists source-independent event attention classification and tracker behavior", async () => {
    const { service, tracker, careerRepository } = makeService();
    const campaign = service.createCampaign(campaignInput());
    service.activateCampaign(campaign.id);
    await service.runCampaign(campaign.id);
    const events = service.listEvents(campaign.id);
    expect(events.every(isCareerEvent)).toBe(true);
    expect(isAttentionWorthyEvent("application.needs_input")).toBe(true);
    expect(isAttentionWorthyEvent("application.applied")).toBe(false);
    expect(isAttentionWorthyEvent("tracker.failed")).toBe(true);
    expect(eventLabel("application.applied")).toContain("Applied");
    expect(careerRepository.listJobs(campaign.id).every(isCareerJob)).toBe(true);
    expect(tracker.listUpdates()).toHaveLength(1);
  });

  it("returns honest human-required state when no executor is configured", async () => {
    const { service } = makeService({ executor: new UnavailableApplicationExecutor() });
    const campaign = service.createCampaign(campaignInput());
    service.activateCampaign(campaign.id);
    await service.runCampaign(campaign.id);
    const job = service.listJobs(campaign.id)[0];
    expect(job.status).toBe("needs_input");
    expect(job.blockers[0].kind).toBe("external_verification");
    expect(job.blockers[0].reason).toContain("No real ATS or browser executor");
    expect(job.submissionProof).toBeUndefined();
  });

  it("keeps an applied result while surfacing tracker failure for intervention", async () => {
    const tracker = new InMemoryJobTracker({ fail: true });
    const { service } = makeService({ tracker });
    const campaign = service.createCampaign(campaignInput());
    service.activateCampaign(campaign.id);
    await service.runCampaign(campaign.id);
    const job = service.listJobs(campaign.id)[0];
    expect(job.status).toBe("applied");
    expect(job.trackerFailureReason).toContain("tracker failure");
    expect(service.snapshot(campaign.id).counts.needsYou).toBe(1);
    expect(service.listEvents(campaign.id).some((event) => event.type === "tracker.failed" && event.attention)).toBe(true);
  });

  it("records a successful zero-result discovery without fabricating a job or failing the campaign", async () => {
    const { service } = makeService({ listings: [] });
    const campaign = service.createCampaign(campaignInput());
    service.activateCampaign(campaign.id);

    const result = await service.runCampaign(campaign.id);
    expect(result.discovered).toBe(0);
    expect(result.snapshot.campaign.status).toBe("active");
    expect(result.snapshot.campaign.lastDiscovery).toMatchObject({
      status: "empty",
      receivedCount: 0,
      normalizedCount: 0,
      newCount: 0,
    });
    expect(result.snapshot.jobs).toHaveLength(0);
    expect(service.listEvents(campaign.id).some((event) => event.type === "job.discovery_completed")).toBe(true);
  });

  it("keeps a failed source visible and only fails the campaign after the configured systemic limit", async () => {
    const { service } = makeService();
    const campaign = service.createCampaign(campaignInput({ searchSources: [] }));
    service.activateCampaign(campaign.id);

    const first = await service.runCampaign(campaign.id);
    expect(first.snapshot.campaign.status).toBe("active");
    expect(first.snapshot.campaign.lastDiscovery?.status).toBe("failed");
    expect(first.snapshot.campaign.lastDiscovery?.failureCount).toBe(1);
    await service.runCampaign(campaign.id);
    const third = await service.runCampaign(campaign.id);
    expect(third.snapshot.campaign.status).toBe("failed");
    expect(service.listEvents(campaign.id).filter((event) => event.type === "job.discovery_failed")).toHaveLength(3);
    expect(service.listEvents(campaign.id).some((event) => event.type === "campaign.failed" && event.attention)).toBe(true);
  });

  it("records partial discovery when one independent source fails and still processes the healthy source", async () => {
    const healthy = new StaticJobSource("healthy-source", [
      listing("Example Cloud Systems", "Cloud Platform Engineer", ["AWS"], "partial-healthy"),
    ]);
    const failing = {
      id: "failing-source",
      mode: "live" as const,
      discover: async () => { throw new Error("provider unavailable"); },
    };
    const profile = fullyAuthorizedTestProfile();
    const applicationRepository = new InMemoryApplicationRepository();
    const careerRepository = new InMemoryCareerRepository();
    const clock = runtime();
    const sourceScout = new JobScout({
      [healthy.id]: healthy,
      [failing.id]: failing,
    }, clock.now);
    const service = new CareerAgentService(profile, {
      applicationService: new ApplicationService(applicationRepository, profile, new DeterministicModelClient(), clock),
      careerRepository,
      scout: sourceScout,
      executor: new SimulatedApplicationExecutor(),
      tracker: new InMemoryJobTracker(),
    }, clock);
    const campaign = service.createCampaign(campaignInput({ searchSources: [healthy.id, failing.id] }));
    service.activateCampaign(campaign.id);

    const result = await service.runCampaign(campaign.id);
    expect(result.discovered).toBe(1);
    expect(result.snapshot.campaign.lastDiscovery?.status).toBe("partial");
    expect(result.snapshot.campaign.lastDiscovery?.failureCount).toBe(1);
    expect(result.snapshot.campaign.lastDiscovery?.sourceSummaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: healthy.id, status: "success" }),
      expect.objectContaining({ sourceId: failing.id, status: "failed" }),
    ]));
    expect(result.snapshot.jobs).toHaveLength(1);
    expect(service.listEvents(campaign.id).some((event) =>
      event.type === "job.discovery_partial" && event.metadata?.sourceStatuses?.includes(`${healthy.id}:success`) && event.metadata.sourceStatuses.includes(`${failing.id}:failed`),
    )).toBe(true);
  });

  it("does not recreate an already-applied posting when a later source response only changes URL tracking noise", async () => {
    let runs = 0;
    const source = {
      id: "changing-url-source",
      mode: "live" as const,
      discover: async () => {
        runs += 1;
        return [{
          input: {
            rawText: "Example Cloud Systems\nCloud Platform Engineer\nLocation: Remote - United States\nEmployment type: Full-time\n\nBuild dependable cloud systems for an example team.\n\nRequired qualifications\n- AWS\n- Kubernetes",
            sourceUrl: runs === 1
              ? "https://jobs.example.com/cloud-platform-engineer?utm_source=first"
              : "https://jobs.example.com/cloud-platform-engineer?utm_source=second#role",
            isExample: false,
          },
        }];
      },
    };
    const profile = fullyAuthorizedTestProfile();
    const applicationRepository = new InMemoryApplicationRepository();
    const careerRepository = new InMemoryCareerRepository();
    const clock = runtime();
    const service = new CareerAgentService(profile, {
      applicationService: new ApplicationService(applicationRepository, profile, new DeterministicModelClient(), clock),
      careerRepository,
      scout: new JobScout({ [source.id]: source }, clock.now),
      executor: new SimulatedApplicationExecutor(),
      tracker: new InMemoryJobTracker(),
    }, clock);
    const campaign = service.createCampaign(campaignInput({ searchSources: [source.id] }));
    service.activateCampaign(campaign.id);

    const first = await service.runCampaign(campaign.id);
    const second = await service.runCampaign(campaign.id);
    expect(first.applied).toBe(1);
    expect(second.discovered).toBe(0);
    expect(second.alreadyApplied).toBe(1);
    expect(service.listJobs(campaign.id)).toHaveLength(1);
    expect(applicationRepository.listApplications()).toHaveLength(1);
  });
});

describe("Autonomous Career Agent deterministic acceptance workflow", () => {
  it("discovers, filters, prepares, pauses for one human unit, resumes, proves application, tracks, and deduplicates", async () => {
    const executor = new OneHumanThenSuccessExecutor();
    const resumeCalls = { count: 0 };
    const base = new DeterministicModelClient();
    const model: ModelClient = {
      analyzeJob: (input, at) => base.analyzeJob(input, at),
      assessFit: (job, profile) => base.assessFit(job, profile),
      draftAnswer: (context) => base.draftAnswer(context),
      draftResume: async (job, profile, fit, at) => {
        resumeCalls.count += 1;
        return base.draftResume(job, profile, fit, at);
      },
    };
    const profile = fullyAuthorizedTestProfile();
    const applicationRepository = new InMemoryApplicationRepository();
    const careerRepository = new InMemoryCareerRepository();
    const clock = runtime();
    const applicationService = new ApplicationService(applicationRepository, profile, model, clock);
    const source = new StaticJobSource("fake-source", [
      listing("Example Cloud Systems", "Cloud Platform Engineer", ["AWS", "Kubernetes"], "e2e-cloud"),
      listing("Example Systems Group", "C++ Backend Engineer", ["C++", "Rust"], "e2e-weak"),
      listing("Example Product Studio", "Frontend Software Engineer", ["React", "TypeScript"], "e2e-human"),
      listing("Example Cloud Systems", "Cloud Platform Engineer", ["AWS", "Kubernetes"], "e2e-cloud"),
    ]);
    const scout = new JobScout({ [source.id]: source }, clock.now);
    const tracker = new InMemoryJobTracker();
    const service = new CareerAgentService(profile, {
      applicationService,
      careerRepository,
      scout,
      executor,
      tracker,
    }, clock);
    const campaign = service.createCampaign(campaignInput());
    service.activateCampaign(campaign.id);

    const firstRun = await service.runCampaign(campaign.id);
    expect(firstRun.discovered).toBe(3);
    expect(firstRun.rejected).toBe(1);
    expect(firstRun.prepared).toBe(2);
    expect(firstRun.applied).toBe(1);
    expect(firstRun.attentionRequired).toBe(1);
    expect(resumeCalls.count).toBe(2);

    const waiting = service.listJobs(campaign.id).find((job) => job.job.company === "Example Product Studio")!;
    expect(waiting.status).toBe("needs_input");
    expect(waiting.blockers[0].kind).toBe("external_login");
    const waitingBlocker = waiting.blockers.find((blocker) => blocker.status === "open")!;
    const resumed = await service.resolveCareerBlocker(campaign.id, waiting.id, waitingBlocker.id, "authenticated test session");
    expect(resumed.status).toBe("applied");
    expect(resumeCalls.count).toBe(2);
    expect(tracker.listUpdates()).toHaveLength(2);
    expect(tracker.listUpdates()[0].notes).toContain("SIMULATED");

    const secondRun = await service.runCampaign(campaign.id);
    expect(secondRun.discovered).toBe(0);
    expect(secondRun.alreadyApplied).toBe(2);
    expect(secondRun.alreadySeen).toBe(1);
    expect(applicationRepository.listApplications()).toHaveLength(2);
    expect(service.listJobs(campaign.id).filter((job) => job.status === "applied")).toHaveLength(2);
    expect(service.listEvents(campaign.id).some((event) => event.type === "application.applied")).toBe(true);
    expect(service.listEvents(campaign.id).some((event) => event.type === "tracker.updated")).toBe(true);
    expect(service.listEvents(campaign.id).filter((event) => event.type === "application.ready_to_submit")).toHaveLength(3);
  });
});

describe("Career repository persistence", () => {
  it("round-trips campaigns, jobs, and events through replaceable storage", () => {
    class MapStorage implements KeyValueStorage {
      private readonly values = new Map<string, string>();
      getItem(key: string): string | null { return this.values.get(key) ?? null; }
      setItem(key: string, value: string): void { this.values.set(key, value); }
      removeItem(key: string): void { this.values.delete(key); }
    }

    const storage = new MapStorage();
    const first = new LocalStorageCareerRepository(storage);
    const profile = fullyAuthorizedTestProfile();
    const service = new CareerAgentService(profile, {
      careerRepository: first,
      applicationService: createApplicationService(profile, new InMemoryApplicationRepository()),
      scout: new JobScout({}),
    }, runtime());
    const campaign = service.createCampaign(campaignInput({ searchSources: [] }));
    const event: CareerEvent = {
      id: "event-round-trip",
      type: "campaign.created",
      campaignId: campaign.id,
      occurredAt: capturedAt,
      attention: false,
    };
    first.appendEvent(event);
    const second = new LocalStorageCareerRepository(storage);
    expect(second.getCampaign(campaign.id)).toEqual(campaign);
    expect(second.listEvents(campaign.id)).toEqual(expect.arrayContaining([expect.objectContaining({ id: event.id })]));
    expect(isCampaign(second.getCampaign(campaign.id))).toBe(true);
    clearCareerRepositoryStorage(storage);
    expect(second.listCampaigns()).toHaveLength(0);
  });
});
