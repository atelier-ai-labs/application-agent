// @vitest-environment node

import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  ApplicationService,
  DeterministicModelClient,
  InMemoryApplicationRepository,
  InMemoryCareerRepository,
  InMemoryJobTracker,
  JobScout,
  CareerAgentService,
  exampleCandidateProfile,
  jobDedupeKeys,
  normalizeJobPosting,
  isVerifiedMatlenApplicationUrl,
  isVerifiedProtagonaApplicationUrl,
  isVerifiedGustoHostedUrl,
  isVerifiedGustoApplicationUrl,
  gustoPostingId,
  trackerSyncContextForJob,
  trackerUpdateForJob,
  type Application,
  type ApplicationExecutionRequest,
  type ApplicationExecutor,
  type ApplicationExecutorResult,
  type CandidateProfile,
  type CareerJob,
  type Campaign,
  type ExecutionInspection,
  type ExecutionHostRequest,
  type ExecutionHostSnapshot,
  type JobTracker,
  type JobTrackerResult,
} from "../application-agent/src";
import { resolveExecutionHostConfig } from "../application-agent/automation/executionHost/config";
import { HttpExecutionHostClient, ExecutionHostUnavailableError } from "../application-agent/src/service/executionHostClient";
import { createExecutionHostServer } from "../application-agent/automation/executionHost/server";
import { ExecutionHostRegistryError, ExecutionSessionRegistry } from "../application-agent/automation/executionHost/sessionRegistry";
import { resolveResumePathsFromEnv } from "../application-agent/automation/executionHost/config";
import { trustedExecutionRequestReason } from "../application-agent/automation/executionHost/trustedRequest";
import { DurableSubmissionAuthority } from "../application-agent/automation/executionHost/submissionAuthority";

const capturedAt = "2026-08-30T12:00:00.000Z";

function profile(): CandidateProfile {
  const value = JSON.parse(JSON.stringify(exampleCandidateProfile)) as CandidateProfile;
  value.profileKind = "private";
  value.answerPolicies = Object.fromEntries(
    Object.keys(value.answerPolicies).map((field) => [field, "auto"]),
  ) as CandidateProfile["answerPolicies"];
  value.approvedReusableAnswers = {
    why_company: "Approved local test answer.",
    cover_letter: "Approved local test cover letter.",
    salary_expectations: "USD 150000",
    relocation: "No relocation needed",
    travel: "Up to 10%",
    sponsorship: "No sponsorship required",
    demographic_disclosure: "Explicit local test policy value",
    legal_attestations: "Reviewed by the candidate",
  };
  return value;
}

function inspection(
  status: ExecutionInspection["status"] = "inspected",
  blockers: ExecutionInspection["blockers"] = [],
): ExecutionInspection {
  return {
    status,
    fields: [],
    fieldsFilled: [],
    unresolvedFields: blockers.map((blocker) => blocker.question),
    blockers,
    evidence: ["executor:test", "submit:not-clicked", "submission:manual-only"],
    durationMs: 7,
    domInspectionCount: 1,
    startedAt: capturedAt,
    updatedAt: capturedAt,
  };
}

class BlockingPreparationExecutor implements ApplicationExecutor {
  readonly id = "blocking-preparation-executor";
  inspectCalls = 0;
  executeCalls = 0;
  closeCalls = 0;
  private blocked = true;

  constructor(private readonly exposesCaptchaDiagnostics = false) {}

  executionMode() {
    return "preparation_only" as const;
  }

  supports() {
    return true;
  }

  async inspect(): Promise<ExecutionInspection> {
    this.inspectCalls += 1;
    if (this.blocked) {
      const result = inspection("needs_input", [{
        kind: "captcha",
        unit: "external",
        field: "captcha",
        question: "Complete the CAPTCHA in the browser",
        reason: "The browser requires direct human verification.",
        evidence: ["captcha", "submit:not-clicked"],
        resumeAfterHuman: true,
      }]);
      return this.exposesCaptchaDiagnostics ? {
        ...result,
        captcha: {
          state: "active_challenge",
          markerCount: 2,
          visibleMarkerCount: 1,
          challengeIframeCount: 1,
          visibleChallengeIframeCount: 1,
          evidenceCategory: "visible_challenge_iframe",
        },
      } : result;
    }
    return inspection();
  }

  async execute(_request: ApplicationExecutionRequest): Promise<ApplicationExecutorResult> {
    this.executeCalls += 1;
    return { state: "ready_to_submit", inspection: inspection() };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  completeHumanStep(): void {
    this.blocked = false;
  }
}

class SubmittedProofExecutor extends BlockingPreparationExecutor {
  async execute(request: ApplicationExecutionRequest): Promise<ApplicationExecutorResult> {
    return {
      state: "submitted",
      proof: {
        mode: "external",
        provider: "test-provider",
        externalApplicationId: "must-not-leave-host",
        submittedAt: request.now,
        evidence: "The test intentionally tries to cross the closed lane.",
      },
    };
  }
}

class PreparationToggleExecutor implements ApplicationExecutor {
  readonly id = "preparation-toggle-executor";
  beforeCalls = 0;
  outcomeCalls = 0;
  submitCalls = 0;
  executionMode(request: ApplicationExecutionRequest) {
    return request.campaign.submissionPolicy.authority === "automatic" ? "submission_capable" as const : "preparation_only" as const;
  }
  supports() { return true; }
  async execute(request: ApplicationExecutionRequest): Promise<ApplicationExecutorResult> {
    if (this.executionMode(request) === "preparation_only") return { state: "ready_to_submit", inspection: inspection() };
    this.beforeCalls += 1;
    await request.beforeAutomaticSubmission?.();
    this.submitCalls += 1;
    this.outcomeCalls += 1;
    await request.recordAutomaticSubmissionOutcome?.({ clicked: true, confirmed: false, outcome: "ambiguous", reasonCode: "confirmation-missing", evidence: "test" });
    return { state: "requires_human", blocker: { kind: "external_verification", unit: "submission", field: "submission-confirmation", question: "Verify submission", reason: "test", evidence: ["test"], resumeAfterHuman: false }, inspection: inspection("needs_input") };
  }
}

class PreparedManualSubmissionExecutor implements ApplicationExecutor {
  readonly id = "prepared-manual-submission-executor";
  submitPreparedCalls = 0;
  executionMode() { return "preparation_only" as const; }
  supports() { return true; }
  async execute(): Promise<ApplicationExecutorResult> {
    return { state: "ready_to_submit", inspection: inspection() };
  }
  async submitPrepared(request: ApplicationExecutionRequest): Promise<ApplicationExecutorResult> {
    this.submitPreparedCalls += 1;
    return {
      state: "submitted",
      proof: {
        mode: "external",
        provider: "test-provider",
        externalApplicationId: "manual-test-confirmation",
        submittedAt: request.now,
        evidence: "test-confirmation",
      },
    };
  }
}

class RouteTracker implements JobTracker {
  readonly id = "route-tracker";
  calls = 0;

  async recordApplied(): Promise<JobTrackerResult> {
    this.calls += 1;
    return { ok: true, simulated: false, trackerRecordId: "route-row-2" };
  }
}

interface Fixture {
  request: ExecutionHostRequest;
  campaign: Campaign;
  careerJob: CareerJob;
  application: Application;
  service: CareerAgentService;
  tracker: InMemoryJobTracker;
  careerRepository: InMemoryCareerRepository;
}

async function fixture(
  suffix = "one",
  executor: ApplicationExecutor = new BlockingPreparationExecutor(),
): Promise<Fixture> {
  const candidate = profile();
  const applicationRepository = new InMemoryApplicationRepository();
  const careerRepository = new InMemoryCareerRepository();
  const tracker = new InMemoryJobTracker();
  const clock = {
    now: () => capturedAt,
    createId: (prefix: string) => `${prefix}-${suffix}`,
  };
  const applicationService = new ApplicationService(
    applicationRepository,
    candidate,
    new DeterministicModelClient(),
    clock,
  );
  const service = new CareerAgentService(
    candidate,
    {
      applicationService,
      careerRepository,
      scout: new JobScout({}, clock.now),
      executor,
      tracker,
    },
    clock,
  );
  const campaign = service.createCampaign({
    name: `Local host test ${suffix}`,
    goal: "Prepare without submitting.",
    searchSources: ["lever:h1"],
    searchCriteria: { roleLanes: ["engineer"], locations: [], remoteOnly: false, employmentTypes: [] },
    submissionPolicy: { authority: "never", requireExplicitApproval: false },
  });
  const posting = normalizeJobPosting({
    companyHint: "H1",
    titleHint: "Cloud Platform Engineer",
    sourceUrl: `https://jobs.lever.co/h1/post-${suffix}`,
    applicationUrl: `https://jobs.lever.co/h1/post-${suffix}/apply`,
    rawText: [
      "H1",
      "Cloud Platform Engineer",
      "Location: Remote",
      "",
      "Build dependable platform services for a technical team.",
      "",
      "Required qualifications",
      "- AWS",
      "- Kubernetes",
    ].join("\n"),
  }, capturedAt);
  const application = await applicationService.prepareFromNormalizedJob(posting, false);
  const careerJob: CareerJob = {
    id: `career-job-${suffix}`,
    campaignId: campaign.id,
    isExample: false,
    sourceMode: "live",
    actionability: "actionable",
    fingerprint: `source:lever:h1:id:post-${suffix}`,
    sourceId: "lever:h1",
    sourceRecordId: `post-${suffix}`,
    dedupeKeys: jobDedupeKeys(posting, `post-${suffix}`, "lever:h1"),
    job: posting,
    discoveredAt: capturedAt,
    fit: application.fit,
    applicationId: application.id,
    status: "ready_to_submit",
    blockers: [],
    createdAt: capturedAt,
    updatedAt: capturedAt,
  };
  careerRepository.saveJob(careerJob);
  return {
    request: { mode: "real_local", campaign, careerJob, application, profile: candidate },
    campaign,
    careerJob,
    application,
    service,
    tracker,
    careerRepository,
  };
}

async function runningServer(
  executor: ApplicationExecutor,
  options: { allowedOrigins?: readonly string[]; maxConcurrent?: number; tracker?: JobTracker } = {},
) {
  const host = createExecutionHostServer({
    executor,
    port: 0,
    allowedOrigins: options.allowedOrigins,
    maxConcurrent: options.maxConcurrent,
    tracker: options.tracker,
  });
  await new Promise<void>((resolve) => host.server.listen(0, "127.0.0.1", resolve));
  const address = host.server.address() as AddressInfo;
  return { host, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe("trusted local execution host", () => {
  it("parses and validates the exact automatic-submission target tuple", () => {
    const config = resolveExecutionHostConfig({
      ATELIER_EXECUTION_SUBMISSION_TARGET: "campaign-83493d54-f0c4-416d-92ec-3d78848ce38c|career-job-b2cca791-3181-498b-ac14-59732d799149|application-5682479b-a90f-4d73-8767-9b4034e2bc78",
    });
    expect(config.submissionTarget).toEqual({
      campaignId: "campaign-83493d54-f0c4-416d-92ec-3d78848ce38c",
      careerJobId: "career-job-b2cca791-3181-498b-ac14-59732d799149",
      applicationId: "application-5682479b-a90f-4d73-8767-9b4034e2bc78",
    });
    expect(() => resolveExecutionHostConfig({ ATELIER_EXECUTION_SUBMISSION_TARGET: "campaign-only" })).toThrow(/campaignId\|careerJobId\|applicationId/);
  });

  it("supports explicit preparation-only mode and defaults it off", () => {
    expect(resolveExecutionHostConfig({}).preparationOnly).toBe(false);
    expect(resolveExecutionHostConfig({ ATELIER_EXECUTION_PREPARATION_ONLY: "true" }).preparationOnly).toBe(true);
    expect(() => resolveExecutionHostConfig({ ATELIER_EXECUTION_PREPARATION_ONLY: "yes" })).toThrow(/PREPARATION_ONLY/);
  });

  it("lets an automatic campaign prepare visibly while withholding submit callbacks and fences", async () => {
    const executor = new PreparationToggleExecutor();
    const { request } = await fixture("preparation-only", executor);
    const registry = new ExecutionSessionRegistry({ executor, allowAutomaticSubmission: true, preparationOnly: true, submissionTarget: { campaignId: request.campaign.id, careerJobId: request.careerJob.id, applicationId: request.application.id } });
    const started = registry.start({ ...request, campaign: { ...request.campaign, submissionPolicy: { authority: "automatic", requireExplicitApproval: false } } });
    const ready = await registry.waitForStatus(started.id, ["ready_to_submit"]);
    expect(ready.result?.state).toBe("ready_to_submit");
    expect(executor.beforeCalls).toBe(0);
    expect(executor.outcomeCalls).toBe(0);
    expect(executor.submitCalls).toBe(0);
  });

  it("permits one exact manual submission in never/preparation-only mode", async () => {
    const executor = new PreparedManualSubmissionExecutor();
    const { request } = await fixture("manual-submit", executor);
    const authority = new DurableSubmissionAuthority("manual-test", {
      stateFile: `/tmp/atelier-manual-submit-${request.application.id}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    });
    const registry = new ExecutionSessionRegistry({
      executor,
      allowAutomaticSubmission: false,
      preparationOnly: true,
      submissionAuthority: authority,
    });
    const started = registry.start(request);
    const ready = await registry.waitForStatus(started.id, ["ready_to_submit"]);
    expect(ready.result?.state).toBe("ready_to_submit");

    const submitted = await registry.submitManually(started.id, {
      approval: "SUBMIT_APPLICATION",
      campaignId: request.campaign.id,
      careerJobId: request.careerJob.id,
      applicationId: request.application.id,
    });
    expect(submitted.status).toBe("submitted");
    expect(submitted.result?.state).toBe("submitted");
    expect(executor.submitPreparedCalls).toBe(1);
    expect(authority.reconcile(request.application.id, request.careerJob.id).state).toBe("submitted");
  });

  it("does not require an automatic target allowlist in preparation-only mode", async () => {
    for (const submissionTarget of [undefined, { campaignId: "wrong", careerJobId: "wrong", applicationId: "wrong" }]) {
      const executor = new PreparationToggleExecutor();
      const { request } = await fixture("preparation-only-target", executor);
      const registry = new ExecutionSessionRegistry({ executor, allowAutomaticSubmission: true, preparationOnly: true, ...(submissionTarget ? { submissionTarget } : {}) });
      const started = registry.start({ ...request, campaign: { ...request.campaign, submissionPolicy: { authority: "automatic", requireExplicitApproval: false } } });
      const ready = await registry.waitForStatus(started.id, ["ready_to_submit"]);
      expect(ready.result?.state).toBe("ready_to_submit");
      expect(executor.beforeCalls).toBe(0);
      expect(executor.outcomeCalls).toBe(0);
      expect(executor.submitCalls).toBe(0);
    }
  });

  it("keeps an automatic request outside the exact allowlist at human review without clicking", async () => {
    const executor = new SubmittedProofExecutor();
    executor.completeHumanStep();
    const { request } = await fixture("target-mismatch", executor);
    const registry = new ExecutionSessionRegistry({ executor, allowAutomaticSubmission: true, submissionTarget: { campaignId: "other", careerJobId: request.careerJob.id, applicationId: request.application.id } });
    const started = registry.start({ ...request, campaign: { ...request.campaign, submissionPolicy: { authority: "automatic", requireExplicitApproval: false } } });
    const blocked = await registry.waitForStatus(started.id, ["needs_input"]);
    expect(blocked.result?.state).toBe("requires_human");
    expect(executor.executeCalls).toBe(0);
  });

  it("requires an exact target allowlist before constructing submission callbacks or a fence", async () => {
    const executor = new SubmittedProofExecutor();
    executor.completeHumanStep();
    const { request } = await fixture("target-missing", executor);
    const registry = new ExecutionSessionRegistry({ executor, allowAutomaticSubmission: true });
    const started = registry.start({ ...request, campaign: { ...request.campaign, submissionPolicy: { authority: "automatic", requireExplicitApproval: false } } });
    const blocked = await registry.waitForStatus(started.id, ["needs_input"]);
    expect(blocked.result?.state).toBe("requires_human");
    expect(blocked.result?.state === "requires_human" ? blocked.result.blocker.evidence : []).toContain("submission-target:mismatch");
    expect(executor.executeCalls).toBe(0);
  });
  it("trusts a verified Greenhouse destination without confusing it with the discovery source", async () => {
    const fixtureValue = await fixture("greenhouse-destination");
    const greenhouseUrl = "https://job-boards.greenhouse.io/kapitus/jobs/4390052009";
    const greenhouseJob = {
      ...fixtureValue.careerJob,
      sourceId: "himalayas-live",
      sourceRecordId: "kapitus-himalayas-guid",
      destinationResolution: {
        status: "resolved" as const,
        attemptedAt: capturedAt,
        destinationUrl: greenhouseUrl,
        ats: "Greenhouse" as const,
        actionable: true,
        provenance: "recognized_ats_evidence" as const,
        evidence: ["bounded public destination evidence"],
      },
      job: {
        ...fixtureValue.careerJob.job,
        company: "Kapitus",
        title: "Software Engineer II - Engineering",
        sourceUrl: "https://himalayas.app/jobs/kapitus/software-engineer-ii-engineering",
        applicationUrl: greenhouseUrl,
      },
    };
    const request: ExecutionHostRequest = {
      ...fixtureValue.request,
      careerJob: greenhouseJob,
      application: { ...fixtureValue.application, job: greenhouseJob.job },
    };
    expect(trustedExecutionRequestReason(request)).toBeUndefined();
    const curatedRequest = {
      ...request,
      careerJob: {
        ...greenhouseJob,
        sourceId: "curated-live",
        sourceRecordId: "greenhouse:kapitus:4390052009",
        job: { ...greenhouseJob.job, sourceUrl: greenhouseUrl },
      },
    };
    expect(trustedExecutionRequestReason({
      ...curatedRequest,
      careerJob: {
        ...curatedRequest.careerJob,
        job: { ...curatedRequest.careerJob.job, sourceUrl: "https://job-boards.greenhouse.io/kapitus/jobs/4390052010" },
      },
      application: {
        ...curatedRequest.application,
        job: { ...curatedRequest.application.job, sourceUrl: "https://job-boards.greenhouse.io/kapitus/jobs/4390052010" },
      },
    })).toContain("same verified posting");
    expect(trustedExecutionRequestReason({
      ...curatedRequest,
      careerJob: {
        ...curatedRequest.careerJob,
        job: { ...curatedRequest.careerJob.job, sourceUrl: "https://job-boards.greenhouse.io/other-board/jobs/4390052009" },
      },
      application: {
        ...curatedRequest.application,
        job: { ...curatedRequest.application.job, sourceUrl: "https://job-boards.greenhouse.io/other-board/jobs/4390052009" },
      },
    })).toContain("same verified posting");

  });

  it("admits an unknown direct form only with official-employer resolution evidence", async () => {
    const fixtureValue = await fixture("official-direct");
    const directUrl = "https://careers.h1.example/jobs/cloud-platform/apply";
    const directJob = {
      ...fixtureValue.careerJob,
      sourceId: "curated-live",
      sourceRecordId: "curated:official-direct",
      destinationResolution: {
        status: "resolved" as const,
        attemptedAt: capturedAt,
        destinationUrl: directUrl,
        ats: "Custom" as const,
        actionable: true,
        provenance: "official_employer_evidence" as const,
        evidence: ["official employer application page", "company and role verified"],
      },
      job: { ...fixtureValue.careerJob.job, company: "H1", title: "Cloud Platform Engineer", sourceUrl: "https://listing.example/h1/cloud-platform", applicationUrl: directUrl },
    };
    const request: ExecutionHostRequest = {
      ...fixtureValue.request,
      careerJob: directJob,
      application: { ...fixtureValue.application, job: directJob.job },
    };
    expect(trustedExecutionRequestReason(request)).toBeUndefined();
    expect(trustedExecutionRequestReason({
      ...request,
      careerJob: { ...directJob, destinationResolution: { ...directJob.destinationResolution, provenance: "bounded_public_lookup" as const } },
    })).toContain("official-employer evidence");
  });

  it("trusts a verified Workday destination from bounded employer evidence", async () => {
    const fixtureValue = await fixture("workday-destination");
    const workdayPostingUrl = "https://homedepot.wd5.myworkdayjobs.com/en-US/CareerDepot/job/TEXAS---VIRTUAL---TX01/Software-Engineer-II--REMOTE-_Req191434";
    const workdayUrl = `${workdayPostingUrl}/apply`;
    const workdayJob = {
      ...fixtureValue.careerJob,
      sourceId: "himalayas-live",
      sourceRecordId: "home-depot-workday-guid",
      destinationResolution: {
        status: "resolved" as const,
        attemptedAt: capturedAt,
        destinationUrl: workdayUrl,
        ats: "Workday" as const,
        actionable: true,
        provenance: "official_employer_evidence" as const,
        evidence: ["official employer Workday destination"],
      },
      job: {
        ...fixtureValue.careerJob.job,
        company: "HOME DEPOT U.S.A., INC.",
        title: "Software Engineer II (REMOTE)",
        sourceUrl: workdayPostingUrl,
        applicationUrl: workdayUrl,
      },
    };
    const request: ExecutionHostRequest = {
      ...fixtureValue.request,
      careerJob: workdayJob,
      application: { ...fixtureValue.application, job: workdayJob.job },
    };

    expect(trustedExecutionRequestReason(request)).toBeUndefined();

    const differentJobUrl = "https://homedepot.wd5.myworkdayjobs.com/en-US/CareerDepot/job/TEXAS---VIRTUAL---TX01/Other-Role_Req999999/apply";
    const mismatchedRequest: ExecutionHostRequest = {
      ...request,
      careerJob: {
        ...workdayJob,
        job: { ...workdayJob.job, applicationUrl: differentJobUrl },
      },
      application: {
        ...request.application,
        job: { ...workdayJob.job, applicationUrl: differentJobUrl },
      },
    };
    expect(trustedExecutionRequestReason(mismatchedRequest)).toContain("same verified posting");
  });

  it("trusts a verified curated Rippling destination and keeps it on the supported path", async () => {
    const fixtureValue = await fixture("rippling-destination");
    const ripplingUrl = "https://ats.rippling.com/fullthrottle1/jobs/rippling-posting-123";
    const ripplingJob = {
      ...fixtureValue.careerJob,
      sourceId: "curated-live",
      sourceRecordId: "fullthrottle1:rippling-posting-123",
      destinationResolution: {
        status: "resolved" as const,
        attemptedAt: capturedAt,
        destinationUrl: ripplingUrl,
        ats: "Rippling" as const,
        actionable: true,
        provenance: "recognized_ats_evidence" as const,
        evidence: ["curated:explicit-public-posting"],
      },
      job: {
        ...fixtureValue.careerJob.job,
        company: "FullThrottle.ai",
        title: "AI Platform Engineer",
        sourceUrl: ripplingUrl,
        applicationUrl: ripplingUrl,
      },
    };
    const request: ExecutionHostRequest = {
      ...fixtureValue.request,
      careerJob: ripplingJob,
      application: { ...fixtureValue.application, job: ripplingJob.job },
    };
    expect(trustedExecutionRequestReason(request)).toBeUndefined();
  });

  it("trusts only the narrowly verified curated YouHired route", async () => {
    const fixtureValue = await fixture("youhired-destination");
    const youHiredUrl = "https://youhired.me/job/1932919574/platform-engineer-remote";
    const youHiredJob = {
      ...fixtureValue.careerJob,
      sourceId: "curated-live",
      sourceRecordId: "youhired:1932919574",
      destinationResolution: {
        status: "resolved" as const,
        attemptedAt: capturedAt,
        destinationUrl: youHiredUrl,
        ats: "Custom" as const,
        actionable: true,
        provenance: "existing_external_application_url" as const,
        evidence: ["curated:explicit-public-posting", "youhired:bounded-job-route"],
      },
      job: {
        ...fixtureValue.careerJob.job,
        company: "Confidential",
        title: "Platform Engineer",
        sourceUrl: youHiredUrl,
        applicationUrl: youHiredUrl,
        ats: "Custom",
      },
    };
    const request: ExecutionHostRequest = {
      ...fixtureValue.request,
      careerJob: youHiredJob,
      application: { ...fixtureValue.application, job: youHiredJob.job },
    };

    expect(trustedExecutionRequestReason(request)).toBeUndefined();
    expect(trustedExecutionRequestReason({
      ...request,
      careerJob: { ...youHiredJob, job: { ...youHiredJob.job, applicationUrl: "https://youhired.me/" } },
      application: {
        ...fixtureValue.application,
        job: { ...youHiredJob.job, applicationUrl: "https://youhired.me/" },
      },
    })).toContain("supported verified application destination");
  });

  it("trusts only the narrowly verified curated Matlen Silver route", async () => {
    const fixtureValue = await fixture("matlensilver-destination");
    const matlenUrl = "https://matlensilver.com/job/azure-engineer-60869931";
    const matlenJob = {
      ...fixtureValue.careerJob,
      sourceId: "curated-live",
      sourceRecordId: "matlensilver:60869931",
      destinationResolution: {
        status: "resolved" as const,
        attemptedAt: capturedAt,
        destinationUrl: matlenUrl,
        ats: "Custom" as const,
        actionable: true,
        provenance: "existing_external_application_url" as const,
        evidence: ["curated:explicit-public-posting", "matlensilver:bounded-job-route"],
      },
      job: {
        ...fixtureValue.careerJob.job,
        company: "Matlen Silver",
        title: "Cloud Engineer",
        sourceUrl: matlenUrl,
        applicationUrl: matlenUrl,
        ats: "Custom",
      },
    };
    const request: ExecutionHostRequest = {
      ...fixtureValue.request,
      careerJob: matlenJob,
      application: { ...fixtureValue.application, job: matlenJob.job },
    };

    expect(isVerifiedMatlenApplicationUrl(matlenUrl)).toBe(true);
    expect(trustedExecutionRequestReason(request)).toBeUndefined();
    expect(trustedExecutionRequestReason({
      ...request,
      // The direct source correlation is invalidated and the resolver no
      // longer points at this exact application URL.
      careerJob: {
        ...matlenJob,
        sourceRecordId: "matlensilver:wrong",
        destinationResolution: {
          ...matlenJob.destinationResolution,
          destinationUrl: "https://matlensilver.com/job/azure-engineer-00000000",
        },
      },
      application: {
        ...fixtureValue.application,
        job: matlenJob.job,
      },
    })).toContain("independently verified");
  });

  it("trusts only the exact current curated Protagona route", async () => {
    const fixtureValue = await fixture("matlensilver-destination");
    const protagonaUrl = "https://protagona.applytojob.com/apply/YDO63zlPbH/AWS-Cloud-Engineer";
    const protagonaJob = {
      ...fixtureValue.careerJob,
      sourceId: "curated-live",
      sourceRecordId: "protagona:YDO63zlPbH",
      destinationResolution: {
        status: "resolved" as const,
        attemptedAt: capturedAt,
        destinationUrl: protagonaUrl,
        ats: "Custom" as const,
        actionable: true,
        provenance: "existing_external_application_url" as const,
        evidence: ["curated:explicit-public-posting", "protagona:bounded-job-route"],
      },
      job: {
        ...fixtureValue.careerJob.job,
        company: "Protagona",
        title: "AWS Cloud Engineer",
        sourceUrl: protagonaUrl,
        applicationUrl: protagonaUrl,
        ats: "Custom",
      },
    };
    const request: ExecutionHostRequest = {
      ...fixtureValue.request,
      careerJob: protagonaJob,
      application: { ...fixtureValue.application, job: protagonaJob.job },
    };

    expect(isVerifiedProtagonaApplicationUrl(protagonaUrl)).toBe(true);
    expect(trustedExecutionRequestReason(request)).toBeUndefined();
    expect(trustedExecutionRequestReason({
      ...request,
      careerJob: {
        ...protagonaJob,
        sourceRecordId: "protagona:wrong",
        destinationResolution: {
          ...protagonaJob.destinationResolution,
          destinationUrl: "https://protagona.applytojob.com/apply/YDO63zlPbH/other-role",
        },
      },
    })).toContain("independently verified");
  });

  it("trusts only the exact Sidekick Gusto posting/form pair", async () => {
    const fixtureValue = await fixture("gusto-destination");
    const postingUrl = "https://jobs.gusto.com/postings/sidekick-solutions-llc-cloud-engineer-ac0d6b2b-36c5-4bad-a8d2-91b69546d4ad";
    const applicationUrl = `${postingUrl}/applicants/new`;
    const gustoJob = {
      ...fixtureValue.careerJob,
      sourceId: "curated-live",
      sourceRecordId: `gusto:${gustoPostingId(postingUrl)}`,
      destinationResolution: {
        status: "resolved" as const,
        attemptedAt: capturedAt,
        destinationUrl: applicationUrl,
        ats: "Custom" as const,
        actionable: true,
        provenance: "recognized_ats_evidence" as const,
        evidence: ["curated:explicit-public-posting", "gusto:bounded-posting-route"],
      },
      job: {
        ...fixtureValue.careerJob.job,
        company: "Sidekick Solutions LLC",
        title: "Cloud Engineer",
        sourceUrl: postingUrl,
        applicationUrl,
        ats: "Custom",
      },
    };
    const request: ExecutionHostRequest = {
      ...fixtureValue.request,
      careerJob: gustoJob,
      application: { ...fixtureValue.application, job: gustoJob.job },
    };

    expect(isVerifiedGustoHostedUrl(postingUrl)).toBe(true);
    expect(isVerifiedGustoApplicationUrl(applicationUrl)).toBe(true);
    expect(trustedExecutionRequestReason(request)).toBeUndefined();
    expect(trustedExecutionRequestReason({
      ...request,
      careerJob: {
        ...gustoJob,
        sourceRecordId: "gusto:wrong:posting",
        destinationResolution: {
          ...gustoJob.destinationResolution,
          destinationUrl: "https://jobs.gusto.com/postings/other-company-role-ac0d6b2b-36c5-4bad-a8d2-91b69546d4ad/applicants/new",
        },
      },
    })).toContain("independently verified");
  });

  it("trusts a directly correlated Rippling posting without destination resolution", async () => {
    const fixtureValue = await fixture("rippling-direct-source");
    const ripplingUrl = "https://ats.rippling.com/fullthrottle1/jobs/rippling-posting-123";
    const ripplingJob = {
      ...fixtureValue.careerJob,
      sourceId: "curated-live",
      sourceRecordId: "fullthrottle1:rippling-posting-123",
      destinationResolution: undefined,
      job: {
        ...fixtureValue.careerJob.job,
        company: "FullThrottle.ai",
        title: "AI Platform Engineer",
        sourceUrl: ripplingUrl,
        applicationUrl: ripplingUrl,
      },
    };
    const request: ExecutionHostRequest = {
      ...fixtureValue.request,
      careerJob: ripplingJob,
      application: { ...fixtureValue.application, job: ripplingJob.job },
    };

    expect(trustedExecutionRequestReason(request)).toBeUndefined();
  });

  it("trusts a directly correlated curated Lever posting through the existing host", async () => {
    const fixtureValue = await fixture("curated-lever");
    const postingId = "885d7a1a-16f6-4326-9d7c-da7404dfd1f5";
    const sourceUrl = `https://jobs.lever.co/mcgovern/${postingId}`;
    const applicationUrl = `${sourceUrl}/apply`;
    const leverJob = {
      ...fixtureValue.careerJob,
      sourceId: "curated-live",
      sourceRecordId: postingId,
      destinationResolution: {
        status: "resolved" as const,
        attemptedAt: capturedAt,
        destinationUrl: applicationUrl,
        ats: "Lever" as const,
        actionable: true,
        provenance: "recognized_ats_evidence" as const,
        evidence: ["curated:explicit-public-posting"],
      },
      job: {
        ...fixtureValue.careerJob.job,
        company: "Patrick J. McGovern Foundation",
        title: "Jr DevOps Engineer",
        sourceUrl,
        applicationUrl,
      },
    };
    const request: ExecutionHostRequest = {
      ...fixtureValue.request,
      careerJob: leverJob,
      application: { ...fixtureValue.application, job: leverJob.job },
    };

    expect(trustedExecutionRequestReason(request)).toBeUndefined();
  });

  it("trusts a directly correlated curated Ashby posting through the existing host", async () => {
    const fixtureValue = await fixture("curated-lever");
    const postingId = "3b06208b-34fe-4dda-b409-ee3fd9305cc3";
    const sourceUrl = `https://jobs.ashbyhq.com/Mastra/${postingId}`;
    const applicationUrl = `${sourceUrl}/application`;
    const ashbyJob = {
      ...fixtureValue.careerJob,
      sourceId: "curated-live",
      sourceRecordId: `Mastra:${postingId}`,
      destinationResolution: {
        status: "resolved" as const,
        attemptedAt: capturedAt,
        destinationUrl: applicationUrl,
        ats: "Ashby" as const,
        actionable: true,
        provenance: "recognized_ats_evidence" as const,
        evidence: ["curated:explicit-public-posting"],
      },
      job: {
        ...fixtureValue.careerJob.job,
        company: "Mastra",
        title: "Platform Engineer",
        sourceUrl,
        applicationUrl,
      },
    };
    const request: ExecutionHostRequest = {
      ...fixtureValue.request,
      careerJob: ashbyJob,
      application: { ...fixtureValue.application, job: ashbyJob.job },
    };

    expect(trustedExecutionRequestReason(request)).toBeUndefined();
  });

  it("rejects a valid Rippling URL without a correlated source posting", async () => {
    const fixtureValue = await fixture("rippling-unverified-direct");
    const ripplingJob = {
      ...fixtureValue.careerJob,
      sourceId: "curated-live",
      sourceRecordId: "different-org:different-posting",
      destinationResolution: undefined,
      job: {
        ...fixtureValue.careerJob.job,
        sourceUrl: "https://ats.rippling.com/fullthrottle1/jobs/rippling-posting-123",
        applicationUrl: "https://ats.rippling.com/fullthrottle1/jobs/rippling-posting-123",
      },
    };
    const request: ExecutionHostRequest = {
      ...fixtureValue.request,
      careerJob: ripplingJob,
      application: { ...fixtureValue.application, job: ripplingJob.job },
    };

    expect(trustedExecutionRequestReason(request)).toContain("not independently verified");
  });

  it("keeps the browser handle server-side and resumes the same session", async () => {
    const executor = new BlockingPreparationExecutor();
    const { request } = await fixture("same-session", executor);
    const registry = new ExecutionSessionRegistry({ executor, sessionTimeoutMs: 30_000 });

    const started = registry.start(request);
    const blocked = await registry.waitForStatus(started.id, ["waiting_for_human"]);
    expect(blocked.result?.state).toBe("requires_human");
    expect(blocked.result && blocked.result.state === "requires_human" ? blocked.result.blocker.kind : undefined).toBe("captcha");
    expect(blocked.attempt).toBe(1);
    expect(blocked.telemetry?.preflightInspectionDurationMs).toBeGreaterThanOrEqual(0);
    expect(blocked.telemetry?.browserPreparationDurationMs).toBeGreaterThanOrEqual(0);
    expect(blocked.telemetry?.domInspectionCount).toBe(1);
    expect(blocked.telemetry?.boundaries).toMatchObject({
      hostRequestAccepted: true,
      executorStarted: false,
      browserClosed: false,
    });
    expect(JSON.stringify(blocked)).not.toContain("browserSessionHandle");
    expect(JSON.stringify(blocked)).not.toContain("server-only");

    executor.completeHumanStep();
    registry.resume(started.id, request);
    const ready = await registry.waitForStatus(started.id, ["ready_to_submit"]);
    expect(ready.result?.state).toBe("ready_to_submit");
    expect(ready.attempt).toBe(2);
    expect(ready.retryReasonCode).toBe("human_gate");
    expect(ready.telemetry?.preflightInspectionDurationMs).toBeGreaterThanOrEqual(0);
    expect(ready.telemetry?.executorInspectionDurationMs).toBe(7);
    expect(ready.telemetry?.browserPreparationDurationMs).toBeGreaterThanOrEqual(0);
    expect(ready.telemetry?.domInspectionCount).toBe(3);
    expect(ready.telemetry?.boundaries).toMatchObject({
      hostRequestAccepted: true,
      executorStarted: true,
      browserClosed: false,
    });
    expect(executor.inspectCalls).toBe(2);
    expect(executor.executeCalls).toBe(1);
    expect(executor.closeCalls).toBe(0);

    const cancelled = await registry.cancel(started.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.telemetry?.cancellationCount).toBe(1);
    expect(cancelled.telemetry?.lateCompletionCount).toBe(0);
    expect(cancelled.telemetry?.boundaries?.browserClosed).toBe(true);
    expect(executor.closeCalls).toBe(1);
  });

  it("watches the retained session and resumes immediately after CAPTCHA clearance", async () => {
    const executor = new BlockingPreparationExecutor(true);
    const { request } = await fixture("captcha-watch", executor);
    const registry = new ExecutionSessionRegistry({
      executor,
      sessionTimeoutMs: 5_000,
      captchaPollIntervalMs: 5,
      captchaWaitTimeoutMs: 500,
    });

    const started = registry.start(request);
    const blocked = await registry.waitForStatus(started.id, ["waiting_for_human"]);
    expect(blocked.result?.state).toBe("requires_human");
    executor.completeHumanStep();

    const ready = await registry.waitForStatus(started.id, ["ready_to_submit"], 1_000);
    expect(ready.attempt).toBe(2);
    expect(ready.result?.state).toBe("ready_to_submit");
    expect(executor.inspectCalls).toBeGreaterThanOrEqual(3);
    expect(executor.executeCalls).toBe(1);
    await registry.closeAll();
  });

  it("rejects untrusted requests before an executor can open a browser", async () => {
    const executor = new BlockingPreparationExecutor();
    const { request } = await fixture("untrusted", executor);
    const registry = new ExecutionSessionRegistry({ executor });
    const exampleRequest = {
      ...request,
      profile: { ...request.profile, profileKind: "example" as const },
    };
    expect(() => registry.start(exampleRequest)).toThrow("private/local candidate profile");
    expect(executor.inspectCalls).toBe(0);
  });

  it("enforces one active local browser session", async () => {
    const firstExecutor = new BlockingPreparationExecutor();
    const first = await fixture("capacity-one", firstExecutor);
    const second = await fixture("capacity-two", new BlockingPreparationExecutor());
    const registry = new ExecutionSessionRegistry({ executor: firstExecutor, maxConcurrent: 1, sessionTimeoutMs: 30_000 });
    registry.start(first.request);
    expect(() => registry.start(second.request)).toThrow(ExecutionHostRegistryError);
    try {
      registry.start(second.request);
    } catch (error) {
      expect(error).toMatchObject({ code: "capacity" });
    }
    await registry.closeAll();
  });

  it("times out and cleans up an abandoned browser session", async () => {
    const executor = new BlockingPreparationExecutor();
    const { request } = await fixture("timeout", executor);
    const registry = new ExecutionSessionRegistry({ executor, sessionTimeoutMs: 5 });
    const started = registry.start(request);
    const timedOut = await registry.waitForStatus(started.id, ["failed"], 1_000);
    expect(timedOut.error).toContain("timed out");
    expect(timedOut.failureReasonCode).toBe("timeout");
    expect(executor.closeCalls).toBe(1);
    await registry.closeAll();
  });

  it("keeps profile values out of high-level host logs", async () => {
    const executor = new BlockingPreparationExecutor();
    const fixtureValue = await fixture("redacted-logs", executor);
    const secretEmail = "private.person@example.test";
    const secretPhone = "+1 212 555 0199";
    const request: ExecutionHostRequest = {
      ...fixtureValue.request,
      profile: {
        ...fixtureValue.request.profile,
        identity: {
          ...fixtureValue.request.profile.identity,
          email: secretEmail,
          phone: secretPhone,
        },
      },
    };
    const logs: unknown[] = [];
    const registry = new ExecutionSessionRegistry({
      executor,
      logger: (entry) => logs.push(entry),
    });
    const started = registry.start(request);
    await registry.waitForStatus(started.id, ["waiting_for_human"]);
    expect(JSON.stringify(logs)).not.toContain(secretEmail);
    expect(JSON.stringify(logs)).not.toContain(secretPhone);
    await registry.closeAll();
  });

  it("closes live sessions on host shutdown and exposes a recognizable closed state", async () => {
    const executor = new BlockingPreparationExecutor();
    const { request } = await fixture("shutdown", executor);
    const registry = new ExecutionSessionRegistry({ executor });
    const started = registry.start(request);
    await registry.closeAll();
    expect(registry.get(started.id).status).toBe("closed");
    expect(executor.closeCalls).toBe(1);
  });

  it("rejects an executor that tries to return submission proof", async () => {
    const executor = new SubmittedProofExecutor();
    executor.completeHumanStep();
    const { request } = await fixture("proof-rejection", executor);
    const registry = new ExecutionSessionRegistry({ executor });
    const started = registry.start(request);
    const failed = await registry.waitForStatus(started.id, ["failed"]);
    expect(failed.error).toContain("rejected submission proof");
    expect(failed.result?.state).toBe("failed");
    expect(failed.result && "reason" in failed.result ? failed.result.reason : undefined).toContain("no application was submitted");
  });

  it("forwards submission proof only when the campaign and host both authorize it", async () => {
    const executor = new SubmittedProofExecutor();
    executor.completeHumanStep();
    const { request } = await fixture("proof-accepted", executor);
    const automaticRequest = {
      ...request,
      campaign: {
        ...request.campaign,
        submissionPolicy: { authority: "automatic" as const, requireExplicitApproval: false },
      },
    };
    const registry = new ExecutionSessionRegistry({ executor, allowAutomaticSubmission: true, submissionTarget: { campaignId: automaticRequest.campaign.id, careerJobId: automaticRequest.careerJob.id, applicationId: automaticRequest.application.id } });
    const started = registry.start(automaticRequest);
    const submitted = await registry.waitForStatus(started.id, ["submitted"]);
    expect(submitted.status).toBe("submitted");
    expect(submitted.result?.state).toBe("submitted");
  });

  it("records applied state only after an authorized host submission proof", async () => {
    const executor = new SubmittedProofExecutor();
    executor.completeHumanStep();
    const { request, campaign, careerJob, service, tracker } = await fixture("proof-lifecycle", executor);
    const authorizedCampaign = service.authorizeAutomaticSubmission(campaign.id);
    const automaticRequest = {
      ...request,
      campaign: authorizedCampaign,
    };
    const registry = new ExecutionSessionRegistry({ executor, allowAutomaticSubmission: true, submissionTarget: { campaignId: automaticRequest.campaign.id, careerJobId: automaticRequest.careerJob.id, applicationId: automaticRequest.application.id } });
    const started = registry.start(automaticRequest);
    const submitted = await registry.waitForStatus(started.id, ["submitted"]);
    expect(service.getApplication(careerJob.applicationId!).status).toBe("ready_for_review");

    const applied = await service.recordExecutionHostSnapshot(campaign.id, careerJob.id, submitted);
    expect(applied.status).toBe("applied");
    expect(service.getApplication(careerJob.applicationId!).status).toBe("applied");
    expect(tracker.listUpdates()).toHaveLength(1);
  });

  it("persists a host result without applied state or tracker writes", async () => {
    const executor = new BlockingPreparationExecutor();
    const { request, service, campaign, careerJob, tracker } = await fixture("domain-result", executor);
    const registry = new ExecutionSessionRegistry({ executor });
    const started = registry.start(request);
    const blocked = await registry.waitForStatus(started.id, ["waiting_for_human"]);
    const persistedBlocked = await service.recordExecutionHostSnapshot(campaign.id, careerJob.id, blocked);
    expect(persistedBlocked.execution?.hostExecutionId).toBe(started.id);
    expect(persistedBlocked.execution?.status).toBe("waiting_for_human");
    expect(service.listEvents(campaign.id).map((event) => event.type)).not.toContain("application.applied");
    expect(tracker.listUpdates()).toHaveLength(0);
  });

  it("propagates ready_to_submit without opening the applied or tracker lanes", async () => {
    const executor = new BlockingPreparationExecutor();
    executor.completeHumanStep();
    const { request, service, campaign, careerJob, tracker } = await fixture("domain-ready", executor);
    const registry = new ExecutionSessionRegistry({ executor });
    const started = registry.start(request);
    const ready = await registry.waitForStatus(started.id, ["ready_to_submit"]);
    const persisted = await service.recordExecutionHostSnapshot(campaign.id, careerJob.id, ready);
    expect(persisted.status).toBe("ready_to_submit");
    expect(persisted.execution?.status).toBe("ready_to_submit");
    expect(persisted.execution?.mode).toBe("real_local");
    const eventTypes = service.listEvents(campaign.id).map((event) => event.type);
    expect(eventTypes).toContain("application.ready_to_submit");
    expect(eventTypes).not.toContain("application.submitted");
    expect(eventTypes).not.toContain("application.applied");
    expect(tracker.listUpdates()).toHaveLength(0);
    await registry.cancel(started.id);
  });

  it("isolates loopback HTTP routes and enforces exact CORS origins", async () => {
    const executor = new BlockingPreparationExecutor();
    const fixtureValue = await fixture("http-routes", executor);
    const { host, baseUrl } = await runningServer(executor, { allowedOrigins: ["http://localhost:5173"] });
    try {
      const allowed = await fetch(`${baseUrl}/health`, { headers: { Origin: "http://localhost:5173" } });
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");

      const denied = await fetch(`${baseUrl}/health`, { headers: { Origin: "http://evil.invalid" } });
      expect(denied.status).toBe(403);
      expect(denied.headers.get("access-control-allow-origin")).toBeNull();

      const preflight = await fetch(`${baseUrl}/career-agent/executions`, {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:5173",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");

      const startedResponse = await fetch(`${baseUrl}/career-agent/executions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
        body: JSON.stringify(fixtureValue.request),
      });
      expect(startedResponse.status).toBe(202);
      const started = await json(startedResponse);
      expect(started.mode).toBe("real_local");
      expect(typeof started.id).toBe("string");
      const executionId = started.id as string;
      const currentResponse = await fetch(`${baseUrl}/career-agent/executions/${encodeURIComponent(executionId)}`, {
        headers: { Origin: "http://localhost:5173" },
      });
      expect(currentResponse.status).toBe(200);
      expect((await json(currentResponse)).applicationId).toBe(fixtureValue.application.id);

      const invalid = await fetch(`${baseUrl}/career-agent/executions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
        body: JSON.stringify({ ...fixtureValue.request, mode: "simulated" }),
      });
      expect(invalid.status).toBe(400);

      const cancelled = await fetch(`${baseUrl}/career-agent/executions/${encodeURIComponent(executionId)}/cancel`, {
        method: "POST",
        headers: { Origin: "http://localhost:5173" },
      });
      expect(cancelled.status).toBe(200);
      expect((await json(cancelled)).status).toBe("cancelled");
    } finally {
      await host.close();
    }
  });

  it("propagates wrong packet associations as a safe HTTP rejection", async () => {
    const executor = new BlockingPreparationExecutor();
    const fixtureValue = await fixture("wrong-packet", executor);
    const { host, baseUrl } = await runningServer(executor);
    try {
      const body = {
        ...fixtureValue.request,
        application: {
          ...fixtureValue.application,
          job: {
            ...fixtureValue.application.job,
            sourceUrl: "https://jobs.lever.co/h1/another-posting",
            applicationUrl: "https://jobs.lever.co/h1/another-posting/apply",
          },
        },
      };
      const response = await fetch(`${baseUrl}/career-agent/executions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect((await json(response)).error).toContain("URL provenance");
      expect(executor.inspectCalls).toBe(0);
    } finally {
      await host.close();
    }
  });

  it("maps host status through the typed client and reports an unavailable host explicitly", async () => {
    const executor = new BlockingPreparationExecutor();
    const fixtureValue = await fixture("typed-client", executor);
    const { host, baseUrl } = await runningServer(executor);
    try {
      const client = new HttpExecutionHostClient({ baseUrl });
      const started = await client.start(fixtureValue.request);
      expect(started.mode).toBe("real_local");
      const blocked = await new Promise<ExecutionHostSnapshot>((resolve) => {
        const poll = async () => {
          const snapshot = await client.get(started.id);
          if (snapshot.status === "waiting_for_human") resolve(snapshot);
          else setTimeout(() => void poll(), 5);
        };
        void poll();
      });
      expect(blocked.result?.state).toBe("requires_human");
      executor.completeHumanStep();
      const resuming = await client.resume(started.id, fixtureValue.request);
      expect(resuming.status).toBe("resuming");
      const ready = await new Promise<ExecutionHostSnapshot>((resolve) => {
        const poll = async () => {
          const snapshot = await client.get(started.id);
          if (snapshot.status === "ready_to_submit") resolve(snapshot);
          else setTimeout(() => void poll(), 5);
        };
        void poll();
      });
      expect(ready.result?.state).toBe("ready_to_submit");
      await client.cancel(started.id);
    } finally {
      await host.close();
    }

    const unavailable = new HttpExecutionHostClient({
      fetcher: async () => { throw new Error("connection refused"); },
    });
    await expect(unavailable.get("missing")).rejects.toBeInstanceOf(ExecutionHostUnavailableError);
  });

  it("exposes only the applied tracker-sync route with exact CORS and no demo fallback", async () => {
    const executor = new BlockingPreparationExecutor();
    const fixtureValue = await fixture("tracker-route", executor);
    const appliedEvidence = {
      mode: "manual" as const,
      confirmedAt: capturedAt,
      evidence: "user_confirmed_successful_manual_submission" as const,
    };
    const appliedJob = {
      ...fixtureValue.careerJob,
      status: "applied" as const,
      manualSubmissionConfirmation: appliedEvidence,
    };
    const appliedApplication = {
      ...fixtureValue.application,
      status: "applied" as const,
      manualSubmissionConfirmation: appliedEvidence,
    };
    const context = trackerSyncContextForJob(fixtureValue.campaign, appliedJob, appliedApplication, appliedEvidence);
    const update = trackerUpdateForJob(appliedJob, appliedEvidence);
    const routeTracker = new RouteTracker();
    const { host, baseUrl } = await runningServer(executor, {
      allowedOrigins: ["http://localhost:5173"],
      tracker: routeTracker,
    });
    try {
      const preflight = await fetch(`${baseUrl}/career-agent/tracker-sync`, {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:5173",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      });
      expect(preflight.status).toBe(204);

      const allowed = await fetch(`${baseUrl}/career-agent/tracker-sync`, {
        method: "POST",
        headers: { Origin: "http://localhost:5173", "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "google_sheets", context, update }),
      });
      expect(allowed.status).toBe(200);
      expect(await json(allowed)).toMatchObject({ ok: true, simulated: false, trackerRecordId: "route-row-2" });
      expect(routeTracker.calls).toBe(1);

      const denied = await fetch(`${baseUrl}/career-agent/tracker-sync`, {
        method: "POST",
        headers: { Origin: "http://evil.invalid", "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "google_sheets", context, update }),
      });
      expect(denied.status).toBe(403);
      expect(routeTracker.calls).toBe(1);

      const notApplied = await fetch(`${baseUrl}/career-agent/tracker-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "google_sheets",
          context: { ...context, applicationStatus: "ready_for_review" },
          update,
        }),
      });
      expect(notApplied.status).toBe(400);
      expect(routeTracker.calls).toBe(1);
    } finally {
      await host.close();
    }
  });

  it("accepts only resume artifacts inside the explicitly configured local root", () => {
    expect(resolveResumePathsFromEnv({
      ATELIER_RESUME_ROOT: "/tmp/atelier-resumes",
      ATELIER_RESUME_CLOUD_PLATFORM_PATH: "/tmp/atelier-resumes/cloud.pdf",
    })).toEqual({ "cloud-platform": "/tmp/atelier-resumes/cloud.pdf" });
    expect(() => resolveResumePathsFromEnv({
      ATELIER_RESUME_ROOT: "/tmp/atelier-resumes",
      ATELIER_RESUME_CLOUD_PLATFORM_PATH: "/tmp/private/cloud.pdf",
    })).toThrow("inside ATELIER_RESUME_ROOT");
  });

  it("rejects a non-loopback host unless the explicit process opt-in is present", async () => {
    const executor = new BlockingPreparationExecutor();
    expect(() => createExecutionHostServer({ executor, host: "0.0.0.0", port: 0 })).toThrow("loopback");
  });
});
