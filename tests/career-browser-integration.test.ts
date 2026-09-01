import { describe, expect, it } from "vitest";
import {
  ApplicationService,
  CareerAgentService,
  DeterministicModelClient,
  InMemoryApplicationRepository,
  InMemoryCareerRepository,
  InMemoryJobTracker,
  JobScout,
  exampleCandidateProfile,
  isCareerJob,
  normalizeJobPosting,
  type ApplicationExecutor,
  type ApplicationExecutorResult,
  type CandidateProfile,
  type CreateCampaignInput,
  type ExecutionInspection,
} from "../application-agent/src";

const capturedAt = "2026-08-30T12:00:00.000Z";

function profile(): CandidateProfile {
  const value = JSON.parse(JSON.stringify(exampleCandidateProfile)) as CandidateProfile;
  value.profileKind = "private";
  value.answerPolicies = Object.fromEntries(
    Object.keys(value.answerPolicies).map((field) => [field, "auto"]),
  ) as CandidateProfile["answerPolicies"];
  value.approvedReusableAnswers = {
    salary_expectations: "USD 150000",
    relocation: "No relocation needed",
    travel: "Up to 10%",
    sponsorship: "No",
    demographic_disclosure: "Explicit test-policy value",
    legal_attestations: "Reviewed by candidate",
    why_company: "Approved test answer",
    cover_letter: "Approved test letter",
  };
  return value;
}

function runtime() {
  let ticks = 0;
  let ids = 0;
  return {
    now: () => new Date(Date.parse(capturedAt) + ticks++ * 1_000).toISOString(),
    createId: (prefix: string) => `${prefix}-test-${++ids}`,
  };
}

function inspection(now = capturedAt): ExecutionInspection {
  return {
    status: "inspected",
    fields: [],
    fieldsFilled: [],
    unresolvedFields: [],
    blockers: [],
    evidence: ["executor:test", "submit:not-clicked", "submission:manual-only"],
    startedAt: now,
    updatedAt: now,
  };
}

class ReadyToSubmitExecutor implements ApplicationExecutor {
  readonly id = "ready-to-submit-test-executor";

  executionMode() {
    return "preparation_only" as const;
  }

  async inspect(): Promise<ExecutionInspection> {
    return inspection();
  }

  async execute(): Promise<ApplicationExecutorResult> {
    return {
      state: "ready_to_submit",
      inspection: inspection(),
    };
  }
}

const campaignInput: CreateCampaignInput = {
  name: "Browser boundary test",
  goal: "Prepare a real-looking packet without submitting it.",
  searchSources: ["lever:h1"],
  searchCriteria: {
    roleLanes: ["engineer"],
    remoteOnly: false,
    employmentTypes: [],
  },
  applicationPolicy: {
    autoPrepare: true,
    allowGroundedDrafts: true,
    approvedResumeFamilies: [],
  },
  submissionPolicy: {
    authority: "never",
    requireExplicitApproval: false,
  },
  dailyApplicationLimit: 3,
};

describe("Career Agent browser execution boundary", () => {
  it("persists ready_to_submit from an inspectable executor without applied, submitted, or tracker state", async () => {
    const candidate = profile();
    const clock = runtime();
    const job = normalizeJobPosting({
      companyHint: "H1",
      titleHint: "Cloud Platform Engineer",
      sourceUrl: "https://jobs.lever.co/h1/post-1",
      applicationUrl: "https://jobs.lever.co/h1/post-1/apply",
      rawText: `H1
Cloud Platform Engineer
Location: Remote

Build dependable platform systems for a technical team.

Required qualifications
- AWS
- Kubernetes
`,
    }, capturedAt);
    const source = {
      id: "lever:h1",
      mode: "live" as const,
      discover: async () => [{
        sourceRecordId: "post-1",
        sourceMode: "live" as const,
        input: { rawText: job.description, companyHint: job.company, titleHint: job.title, sourceUrl: job.sourceUrl, applicationUrl: job.applicationUrl },
      }],
    };
    const tracker = new InMemoryJobTracker();
    const service = new CareerAgentService(candidate, {
      applicationService: new ApplicationService(new InMemoryApplicationRepository(), candidate, new DeterministicModelClient(), clock),
      careerRepository: new InMemoryCareerRepository(),
      scout: new JobScout({ [source.id]: source }, clock.now),
      executor: new ReadyToSubmitExecutor(),
      tracker,
    }, clock);
    const campaign = service.createCampaign(campaignInput);
    service.activateCampaign(campaign.id);

    const result = await service.runCampaign(campaign.id);
    const careerJob = service.listJobs(campaign.id)[0];
    const eventTypes = service.listEvents(campaign.id).map((event) => event.type);

    expect(result.applied).toBe(0);
    expect(careerJob.status).toBe("ready_to_submit");
    expect(careerJob.execution?.status).toBe("ready_to_submit");
    expect(careerJob.execution?.evidence).toContain("submit:not-clicked");
    expect(isCareerJob(careerJob)).toBe(true);
    expect(eventTypes).toContain("application.execution_started");
    expect(eventTypes).toContain("application.form_inspected");
    expect(eventTypes).toContain("application.ready_to_submit");
    expect(eventTypes).not.toContain("application.submitted");
    expect(eventTypes).not.toContain("application.applied");
    expect(tracker.listUpdates()).toHaveLength(0);
  });
});
