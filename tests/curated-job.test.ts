import { describe, expect, it } from "vitest";
import {
  CareerAgentService,
  DeterministicModelClient,
  InMemoryApplicationRepository,
  InMemoryCareerRepository,
  UnavailableApplicationExecutor,
  createApplicationService,
  exampleCandidateProfile,
  type CreateCampaignInput,
  type JobIntakeInput,
} from "../application-agent/src";

const capturedAt = "2026-09-07T12:00:00.000Z";
const selectedPosting: JobIntakeInput = {
  companyHint: "FullThrottle.ai",
  titleHint: "AI Platform Engineer",
  sourceUrl: "https://ats.rippling.com/fullthrottle1/jobs/rippling-posting-123",
  applicationUrl: "https://ats.rippling.com/fullthrottle1/jobs/rippling-posting-123",
  rawText: `FullThrottle.ai
AI Platform Engineer
Location: Remote - United States
Employment type: Full-time

Build platform systems for an AI engineering team.

Required qualifications
- Python
- Kubernetes
`,
};

const selectedLeverPosting: JobIntakeInput = {
  companyHint: "Patrick J. McGovern Foundation",
  titleHint: "Jr DevOps Engineer",
  sourceUrl: "https://jobs.lever.co/mcgovern/885d7a1a-16f6-4326-9d7c-da7404dfd1f5",
  applicationUrl: "https://jobs.lever.co/mcgovern/885d7a1a-16f6-4326-9d7c-da7404dfd1f5/apply",
  rawText: `Patrick J. McGovern Foundation
Jr DevOps Engineer
Location: Remote
Employment type: Full-time

Support cloud infrastructure, automation, CI/CD, containers, and observability
for AI and data products.

Required qualifications
- AWS
- Python
- Terraform
- Docker
`,
};

const selectedAshbyPosting: JobIntakeInput = {
  companyHint: "Mastra",
  titleHint: "Platform Engineer",
  sourceUrl: "https://jobs.ashbyhq.com/Mastra/3b06208b-34fe-4dda-b409-ee3fd9305cc3",
  applicationUrl: "https://jobs.ashbyhq.com/mastra/3b06208b-34fe-4dda-b409-ee3fd9305cc3/application",
  rawText: `Mastra
Platform Engineer
Location: Remote - AMER time zones
Employment type: Full-time

Build and operate production platform systems using TypeScript, Node.js,
Postgres, Redis, ClickHouse, Google Cloud, and Railway.

Required qualifications
- Production platform engineering experience
- TypeScript and Node.js
`,
};

const selectedYouHiredPosting: JobIntakeInput = {
  companyHint: "Confidential",
  titleHint: "Platform Engineer",
  sourceUrl: "https://youhired.me/job/1932919574/platform-engineer-remote",
  applicationUrl: "https://youhired.me/job/1932919574/platform-engineer-remote",
  rawText: `Confidential
Platform Engineer
Location: Remote - United States
Employment type: Full-time
Salary: $150,000-$250,000 per year

Build and operate reliable platform infrastructure for AI products.

Required qualifications
- Python
- Kubernetes
- Terraform
`,
};

const selectedMatlenPosting: JobIntakeInput = {
  companyHint: "Matlen Silver",
  titleHint: "Cloud Engineer",
  sourceUrl: "https://matlensilver.com/job/azure-engineer-60869931",
  applicationUrl: "https://matlensilver.com/job/azure-engineer-60869931/?utm_source=daily-hunt",
  rawText: `Matlen Silver
Cloud Engineer
Location: Remote - United States
Employment type: Contract
Compensation: $65-$80/hr

Design and support Azure infrastructure, Terraform automation, monitoring, and CI/CD.

Required qualifications
- Azure
- Terraform
`,
};

const selectedProtagonaPosting: JobIntakeInput = {
  companyHint: "Protagona",
  titleHint: "AWS Cloud Engineer",
  sourceUrl: "https://protagona.applytojob.com/apply/YDO63zlPbH/AWS-Cloud-Engineer",
  applicationUrl: "https://protagona.applytojob.com/apply/YDO63zlPbH/AWS-Cloud-Engineer?utm_source=daily-hunt",
  rawText: `Protagona
AWS Cloud Engineer
Location: Remote - United States
Employment type: Full-time
Compensation: $105,000-$120,000 per year

Build and operate AWS infrastructure with Terraform, Kubernetes, CI/CD, and cloud automation.

Required qualifications
- AWS
- Terraform
- Kubernetes
`,
};

const selectedGustoPosting: JobIntakeInput = {
  companyHint: "Sidekick Solutions LLC",
  titleHint: "Cloud Engineer",
  sourceUrl: "https://jobs.gusto.com/postings/sidekick-solutions-llc-cloud-engineer-ac0d6b2b-36c5-4bad-a8d2-91b69546d4ad",
  applicationUrl: "https://jobs.gusto.com/postings/sidekick-solutions-llc-cloud-engineer-ac0d6b2b-36c5-4bad-a8d2-91b69546d4ad/applicants/new",
  rawText: `Sidekick Solutions LLC
Cloud Engineer
Location: Remote - United States
Employment type: Full-time
Compensation: $100,000-$126,000 per year

Build and operate cloud infrastructure with AWS, Terraform, and GitHub Actions.

Required qualifications
- AWS
- Terraform
- Kubernetes
`,
};

const selectedGreenhousePosting: JobIntakeInput = {
  companyHint: "Reddit",
  titleHint: "Senior Software Engineer, Infrastructure",
  sourceUrl: "https://job-boards.greenhouse.io/reddit/jobs/8194576",
  applicationUrl: "https://job-boards.greenhouse.io/reddit/jobs/8194576",
  rawText: `Reddit
Senior Software Engineer, Infrastructure
Location: Remote - United States
Employment type: Full-time

Build and operate reliable infrastructure for a large-scale platform.

Required qualifications
- Cloud infrastructure
- Kubernetes
`,
};

const selectedWorkdayPosting: JobIntakeInput = {
  companyHint: "The Home Depot",
  titleHint: "Software Engineer II",
  sourceUrl: "https://homedepot.wd5.myworkdayjobs.com/en-US/CareerDepot/job/TEXAS---VIRTUAL---TX01/Software-Engineer-II--REMOTE-_Req191434",
  applicationUrl: "https://homedepot.wd5.myworkdayjobs.com/en-US/CareerDepot/job/TEXAS---VIRTUAL---TX01/Software-Engineer-II--REMOTE-_Req191434/apply",
  rawText: `The Home Depot
Software Engineer II
Location: Remote - United States
Employment type: Full-time

Build and operate reliable cloud infrastructure and developer tooling.

Required qualifications
- AWS
- Kubernetes
- Terraform
`,
};

const campaignInput: CreateCampaignInput = {
  name: "Synthetic selected-posting campaign",
  goal: "Evaluate one public posting with the existing policy.",
  searchSources: [],
  searchCriteria: {
    roleLanes: [],
    locations: [],
    remoteOnly: false,
    employmentTypes: [],
    excludedSeniorities: [],
    excludedCompanies: [],
  },
  applicationPolicy: {
    autoPrepare: true,
    allowGroundedDrafts: true,
    approvedResumeFamilies: [],
  },
  submissionPolicy: { authority: "never", requireExplicitApproval: false },
  dailyApplicationLimit: 3,
};

class FailOnceDuringRecoveryRepository extends InMemoryCareerRepository {
  failRecoveryWrite = false;
  override saveJob(job: import("../application-agent/src").CareerJob): void {
    if (this.failRecoveryWrite && job.status === "preparing") {
      this.failRecoveryWrite = false;
      throw new Error("synthetic restart between application and career-job recovery writes");
    }
    super.saveJob(job);
  }
}

describe("curated selected-posting intake", () => {
  it("processes a bounded daily-hunt message through the existing curated path", async () => {
    const applicationRepository = new InMemoryApplicationRepository();
    const careerRepository = new InMemoryCareerRepository();
    const service = new CareerAgentService(exampleCandidateProfile, {
      applicationService: createApplicationService(
        exampleCandidateProfile,
        applicationRepository,
        new DeterministicModelClient(),
      ),
      careerRepository,
      executor: new UnavailableApplicationExecutor(),
    }, {
      now: () => capturedAt,
      createId: (prefix) => `${prefix}-daily-hunt-synthetic`,
    });
    const campaign = service.createCampaign(campaignInput);
    service.activateCampaign(campaign.id);

    const result = await service.processDailyHuntMessage(campaign.id, `
**[Northstar Cloud](https://jobs.lever.co/northstar/abc123) — Cloud Engineer — Remote US.**
Build production cloud infrastructure with Terraform and Kubernetes.

[Apply directly — Northstar Cloud](https://jobs.lever.co/northstar/abc123/apply)
`);

    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.items[0]).toMatchObject({
      status: "processed",
      company: "Northstar Cloud",
      title: "Cloud Engineer",
    });
    expect(service.listJobs(campaign.id)).toHaveLength(1);
  });

  it("reports unsupported daily-hunt destinations without forcing them into the campaign", async () => {
    const applicationRepository = new InMemoryApplicationRepository();
    const careerRepository = new InMemoryCareerRepository();
    const service = new CareerAgentService(exampleCandidateProfile, {
      applicationService: createApplicationService(
        exampleCandidateProfile,
        applicationRepository,
        new DeterministicModelClient(),
      ),
      careerRepository,
      executor: new UnavailableApplicationExecutor(),
    }, {
      now: () => capturedAt,
      createId: (prefix) => `${prefix}-daily-hunt-unsupported`,
    });
    const campaign = service.createCampaign(campaignInput);
    service.activateCampaign(campaign.id);

    const result = await service.processDailyHuntMessage(campaign.id, `
**[Example Company](https://example.com/) — Platform Engineer — Remote US.**
Build production platform systems with Terraform and Kubernetes.

[Apply — Platform Engineer](https://example.com/jobs/platform-engineer)
`);

    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.items[0]?.reason).toContain("verified Lever, Rippling, Ashby, Workday, YouHired, Matlen Silver, Protagona, or the selected Gusto");
    expect(service.listJobs(campaign.id)).toHaveLength(0);
  });

  it("does not infer an employer from a title-only daily-hunt heading", async () => {
    const applicationRepository = new InMemoryApplicationRepository();
    const careerRepository = new InMemoryCareerRepository();
    const service = new CareerAgentService(exampleCandidateProfile, {
      applicationService: createApplicationService(
        exampleCandidateProfile,
        applicationRepository,
        new DeterministicModelClient(),
      ),
      careerRepository,
      executor: new UnavailableApplicationExecutor(),
    }, {
      now: () => capturedAt,
      createId: (prefix) => `${prefix}-daily-hunt-missing-company`,
    });
    const campaign = service.createCampaign(campaignInput);
    service.activateCampaign(campaign.id);

    const result = await service.processDailyHuntMessage(campaign.id, `
**Platform Engineer — AI/ML Infrastructure — Remote US.**
Operate production cloud infrastructure for AI/ML systems using Terraform,
Kubernetes, containers, networking, and observability.

[Apply — Platform Engineer, AI/ML Infrastructure](https://youhired.me/job/1932919574/platform-engineer-remote)
`);

    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.items[0]?.reason).toContain("unambiguous public employer");
    expect(service.listJobs(campaign.id)).toHaveLength(0);
  });

  it("uses the existing campaign path, persists Rippling provenance, and deduplicates repeat intake", async () => {
    const applicationRepository = new InMemoryApplicationRepository();
    const careerRepository = new InMemoryCareerRepository();
    const service = new CareerAgentService(exampleCandidateProfile, {
      applicationService: createApplicationService(
        exampleCandidateProfile,
        applicationRepository,
        new DeterministicModelClient(),
      ),
      careerRepository,
      executor: new UnavailableApplicationExecutor(),
    }, {
      now: () => capturedAt,
      createId: (prefix) => `${prefix}-synthetic`,
    });
    const campaign = service.createCampaign(campaignInput);
    service.activateCampaign(campaign.id);

    const first = await service.processCuratedJob(campaign.id, selectedPosting);
    const second = await service.processCuratedJob(campaign.id, selectedPosting);

    expect(first.sourceId).toBe("curated-live");
    expect(first.sourceRecordId).toBe("fullthrottle1:rippling-posting-123");
    expect(first.job.sourceUrl).toBe(selectedPosting.sourceUrl);
    expect(first.job.applicationUrl).toBe(selectedPosting.applicationUrl);
    expect(first.destinationResolution).toMatchObject({
      status: "resolved",
      destinationUrl: selectedPosting.applicationUrl,
      ats: "Rippling",
      actionable: true,
    });
    expect(second.id).toBe(first.id);
    expect(second.destinationResolution).toEqual(first.destinationResolution);
    expect(service.listJobs(campaign.id)).toHaveLength(1);
  });

  it("retries a queue-selected pre-submit failure with the same durable job and application", async () => {
    const applicationRepository = new InMemoryApplicationRepository();
    const careerRepository = new InMemoryCareerRepository();
    const applicationService = createApplicationService(exampleCandidateProfile, applicationRepository, new DeterministicModelClient());
    const service = new CareerAgentService(exampleCandidateProfile, {
      applicationService,
      careerRepository,
      executor: new UnavailableApplicationExecutor(),
    }, { now: () => capturedAt, createId: (prefix) => `${prefix}-retryable` });
    const campaign = service.createCampaign(campaignInput);
    service.activateCampaign(campaign.id);
    const first = await service.processCuratedJob(campaign.id, selectedPosting);
    const application = service.getApplication(first.applicationId!);
    applicationService.failApplication(application.id, "Browser select verification failed before submission.");
    const failedApplication = service.getApplication(application.id);
    applicationRepository.saveApplication({
      ...failedApplication,
      blockers: failedApplication.blockers.map((blocker) => ({ ...blocker, status: "resolved" as const, resolvedAt: capturedAt })),
    });
    careerRepository.saveJob({
      ...first,
      status: "failed",
      execution: { status: "failed", fieldsDetected: [], fieldsFilled: [], unresolvedFields: [], evidence: ["submit:not-clicked"], startedAt: capturedAt, updatedAt: capturedAt },
    });

    const retried = await service.processCuratedJob(campaign.id, { ...selectedPosting, queueSelected: true, resumeFamily: "agentic-ai" });
    expect(retried.id).toBe(first.id);
    expect(retried.applicationId).toBe(first.applicationId);
    expect(retried.status).toBe("preparing");
    expect(service.getApplication(first.applicationId!).status).toBe("ready_for_review");
  });

  it("does not retry a queue-selected failure with proof or ambiguous post-click evidence", async () => {
    const applicationRepository = new InMemoryApplicationRepository();
    const careerRepository = new InMemoryCareerRepository();
    const applicationService = createApplicationService(exampleCandidateProfile, applicationRepository, new DeterministicModelClient());
    const service = new CareerAgentService(exampleCandidateProfile, {
      applicationService,
      careerRepository,
      executor: new UnavailableApplicationExecutor(),
    }, { now: () => capturedAt, createId: (prefix) => `${prefix}-no-retry` });
    const campaign = service.createCampaign(campaignInput);
    service.activateCampaign(campaign.id);
    const first = await service.processCuratedJob(campaign.id, selectedPosting);
    const application = service.getApplication(first.applicationId!);
    applicationService.failApplication(application.id, "Synthetic failure.");
    careerRepository.saveJob({
      ...first,
      status: "failed",
      submissionProof: { mode: "external", provider: "rippling", externalApplicationId: "already-submitted", submittedAt: capturedAt, evidence: "synthetic proof" },
      execution: { status: "failed", fieldsDetected: [], fieldsFilled: [], unresolvedFields: [], startedAt: capturedAt, updatedAt: capturedAt, evidence: ["submit:clicked"] },
    });
    const unchanged = await service.processCuratedJob(campaign.id, { ...selectedPosting, queueSelected: true, resumeFamily: "agentic-ai" });
    expect(unchanged.id).toBe(first.id);
    expect(unchanged.status).toBe("failed");
    expect(service.getApplication(first.applicationId!).status).toBe("failed");
    careerRepository.saveJob({
      ...unchanged,
      submissionProof: undefined,
      blockers: [{ id: "submission-boundary", kind: "external_verification", unit: "submission", field: "provider-check", question: "Verify provider state", context: { jobId: first.id, applicationId: first.applicationId, company: first.job.company, role: first.job.title }, reason: "Provider state is not known.", evidence: ["submit:not-clicked"], status: "open", createdAt: capturedAt, resumeAfterHuman: false }],
    });
    const fenced = await service.processCuratedJob(campaign.id, { ...selectedPosting, queueSelected: true, resumeFamily: "agentic-ai" });
    expect(fenced.status).toBe("failed");
  });

  it("converges after a restart between application reopen and career-job recovery write", async () => {
    const applicationRepository = new InMemoryApplicationRepository();
    const careerRepository = new FailOnceDuringRecoveryRepository();
    const applicationService = createApplicationService(exampleCandidateProfile, applicationRepository, new DeterministicModelClient());
    const service = new CareerAgentService(exampleCandidateProfile, { applicationService, careerRepository, executor: new UnavailableApplicationExecutor() }, { now: () => capturedAt, createId: (prefix) => `${prefix}-restart-safe` });
    const campaign = service.createCampaign(campaignInput);
    service.activateCampaign(campaign.id);
    const first = await service.processCuratedJob(campaign.id, selectedPosting);
    const application = service.getApplication(first.applicationId!);
    applicationService.failApplication(application.id, "Synthetic pre-submit failure.");
    const failedApplication = service.getApplication(application.id);
    applicationRepository.saveApplication({ ...failedApplication, blockers: failedApplication.blockers.map((blocker) => ({ ...blocker, status: "resolved" as const, resolvedAt: capturedAt })) });
    careerRepository.saveJob({ ...first, status: "failed", execution: { status: "failed", fieldsDetected: [], fieldsFilled: [], unresolvedFields: [], evidence: ["submit:not-clicked"], startedAt: capturedAt, updatedAt: capturedAt } });
    careerRepository.failRecoveryWrite = true;

    await expect(service.processCuratedJob(campaign.id, { ...selectedPosting, queueSelected: true, resumeFamily: "agentic-ai" })).rejects.toThrow(/restart between/);
    expect(service.getApplication(first.applicationId!).status).toBe("ready_for_review");
    const converged = await service.processCuratedJob(campaign.id, { ...selectedPosting, queueSelected: true, resumeFamily: "agentic-ai" });
    expect(converged.id).toBe(first.id);
    expect(converged.applicationId).toBe(first.applicationId);
    expect(converged.status).toBe("preparing");
  });

  it("accepts a verified Lever posting from the daily hunt through the same curated path", async () => {
    const applicationRepository = new InMemoryApplicationRepository();
    const careerRepository = new InMemoryCareerRepository();
    const service = new CareerAgentService(exampleCandidateProfile, {
      applicationService: createApplicationService(
        exampleCandidateProfile,
        applicationRepository,
        new DeterministicModelClient(),
      ),
      careerRepository,
      executor: new UnavailableApplicationExecutor(),
    }, {
      now: () => capturedAt,
      createId: (prefix) => `${prefix}-lever-synthetic`,
    });
    const campaign = service.createCampaign(campaignInput);
    service.activateCampaign(campaign.id);

    const job = await service.processCuratedJob(campaign.id, selectedLeverPosting);

    expect(job.sourceId).toBe("curated-live");
    expect(job.sourceRecordId).toBe("885d7a1a-16f6-4326-9d7c-da7404dfd1f5");
    expect(job.job.ats).toBe("Lever");
    expect(job.destinationResolution).toMatchObject({
      status: "resolved",
      destinationUrl: selectedLeverPosting.applicationUrl,
      ats: "Lever",
      actionable: true,
    });
  });

  it("accepts a verified Ashby posting from the daily hunt through the same curated path", async () => {
    const applicationRepository = new InMemoryApplicationRepository();
    const careerRepository = new InMemoryCareerRepository();
    const service = new CareerAgentService(exampleCandidateProfile, {
      applicationService: createApplicationService(
        exampleCandidateProfile,
        applicationRepository,
        new DeterministicModelClient(),
      ),
      careerRepository,
      executor: new UnavailableApplicationExecutor(),
    }, {
      now: () => capturedAt,
      createId: (prefix) => `${prefix}-ashby-synthetic`,
    });
    const campaign = service.createCampaign(campaignInput);
    service.activateCampaign(campaign.id);

    const job = await service.processCuratedJob(campaign.id, selectedAshbyPosting);

    expect(job.sourceId).toBe("curated-live");
    expect(job.sourceRecordId).toBe("mastra:3b06208b-34fe-4dda-b409-ee3fd9305cc3");
    expect(job.job.ats).toBe("Ashby");
    expect(job.destinationResolution).toMatchObject({
      status: "resolved",
      destinationUrl: selectedAshbyPosting.applicationUrl,
      ats: "Ashby",
      actionable: true,
    });
  });

  it("accepts the narrowly verified YouHired job route without treating arbitrary custom pages as actionable", async () => {
    const applicationRepository = new InMemoryApplicationRepository();
    const careerRepository = new InMemoryCareerRepository();
    const service = new CareerAgentService(exampleCandidateProfile, {
      applicationService: createApplicationService(
        exampleCandidateProfile,
        applicationRepository,
        new DeterministicModelClient(),
      ),
      careerRepository,
      executor: new UnavailableApplicationExecutor(),
    }, {
      now: () => capturedAt,
      createId: (prefix) => `${prefix}-youhired`,
    });
    const campaign = service.createCampaign(campaignInput);
    service.activateCampaign(campaign.id);

    const job = await service.processCuratedJob(campaign.id, selectedYouHiredPosting);

    expect(job.sourceId).toBe("curated-live");
    expect(job.sourceRecordId).toBe("youhired:1932919574");
    expect(job.job.ats).toBe("Custom");
    expect(job.actionability).toBe("actionable");
    expect(job.destinationResolution).toMatchObject({
      status: "resolved",
      actionable: true,
      ats: "Custom",
      destinationUrl: selectedYouHiredPosting.applicationUrl,
    });
  });

  it("accepts the narrowly verified Matlen Silver form route without opening arbitrary custom pages", async () => {
    const applicationRepository = new InMemoryApplicationRepository();
    const careerRepository = new InMemoryCareerRepository();
    const service = new CareerAgentService(exampleCandidateProfile, {
      applicationService: createApplicationService(
        exampleCandidateProfile,
        applicationRepository,
        new DeterministicModelClient(),
      ),
      careerRepository,
      executor: new UnavailableApplicationExecutor(),
    }, {
      now: () => capturedAt,
      createId: (prefix) => `${prefix}-matlen`,
    });
    const campaign = service.createCampaign(campaignInput);
    service.activateCampaign(campaign.id);

    const job = await service.processCuratedJob(campaign.id, selectedMatlenPosting);

    expect(job.sourceId).toBe("curated-live");
    expect(job.sourceRecordId).toBe("matlensilver:60869931");
    expect(job.job.ats).toBe("Custom");
    expect(job.actionability).toBe("actionable");
    expect(job.destinationResolution).toMatchObject({
      status: "resolved",
      actionable: true,
      ats: "Custom",
      destinationUrl: "https://matlensilver.com/job/azure-engineer-60869931",
    });
  });

  it("accepts the exact current Protagona route through the curated path", async () => {
    const applicationRepository = new InMemoryApplicationRepository();
    const careerRepository = new InMemoryCareerRepository();
    const service = new CareerAgentService(exampleCandidateProfile, {
      applicationService: createApplicationService(
        exampleCandidateProfile,
        applicationRepository,
        new DeterministicModelClient(),
      ),
      careerRepository,
      executor: new UnavailableApplicationExecutor(),
    }, {
      now: () => capturedAt,
      createId: (prefix) => `${prefix}-protagona`,
    });
    const campaign = service.createCampaign(campaignInput);
    service.activateCampaign(campaign.id);

    const job = await service.processCuratedJob(campaign.id, selectedProtagonaPosting);

    expect(job.sourceId).toBe("curated-live");
    expect(job.sourceRecordId).toBe("protagona:YDO63zlPbH");
    expect(job.job.ats).toBe("Custom");
    expect(job.actionability).toBe("actionable");
    expect(job.destinationResolution).toMatchObject({
      status: "resolved",
      actionable: true,
      ats: "Custom",
      destinationUrl: selectedProtagonaPosting.applicationUrl?.replace("?utm_source=daily-hunt", ""),
    });
  });

  it("accepts the exact Sidekick Gusto posting/form pair through the curated path", async () => {
    const applicationRepository = new InMemoryApplicationRepository();
    const careerRepository = new InMemoryCareerRepository();
    const service = new CareerAgentService(exampleCandidateProfile, {
      applicationService: createApplicationService(
        exampleCandidateProfile,
        applicationRepository,
        new DeterministicModelClient(),
      ),
      careerRepository,
      executor: new UnavailableApplicationExecutor(),
    }, {
      now: () => capturedAt,
      createId: (prefix) => `${prefix}-gusto`,
    });
    const campaign = service.createCampaign(campaignInput);
    service.activateCampaign(campaign.id);

    const job = await service.processCuratedJob(campaign.id, selectedGustoPosting);

    expect(job.sourceId).toBe("curated-live");
    expect(job.sourceRecordId).toBe("gusto:sidekick-solutions-llc-cloud-engineer:ac0d6b2b-36c5-4bad-a8d2-91b69546d4ad");
    expect(job.job.ats).toBe("Custom");
    expect(job.job.sourceUrl).toBe(selectedGustoPosting.sourceUrl);
    expect(job.job.applicationUrl).toBe(selectedGustoPosting.applicationUrl);
    expect(job.actionability).toBe("actionable");
    expect(job.destinationResolution).toMatchObject({
      status: "resolved",
      actionable: true,
      ats: "Custom",
      destinationUrl: selectedGustoPosting.applicationUrl,
    });
  });

  it("accepts a verified Greenhouse posting/application pair through the curated path", async () => {
    const applicationRepository = new InMemoryApplicationRepository();
    const careerRepository = new InMemoryCareerRepository();
    const service = new CareerAgentService(exampleCandidateProfile, {
      applicationService: createApplicationService(exampleCandidateProfile, applicationRepository, new DeterministicModelClient()),
      careerRepository,
      executor: new UnavailableApplicationExecutor(),
    }, { now: () => capturedAt, createId: (prefix) => `${prefix}-greenhouse` });
    const campaign = service.createCampaign(campaignInput);
    service.activateCampaign(campaign.id);

    const job = await service.processCuratedJob(campaign.id, selectedGreenhousePosting);

    expect(job.sourceId).toBe("curated-live");
    expect(job.sourceRecordId).toBe("greenhouse:reddit:8194576");
    expect(job.job.ats).toBe("Greenhouse");
    expect(job.job.sourceUrl).toBe(selectedGreenhousePosting.sourceUrl);
    expect(job.job.applicationUrl).toBe(selectedGreenhousePosting.applicationUrl);
    expect(job.destinationResolution).toMatchObject({
      status: "resolved",
      actionable: true,
      ats: "Greenhouse",
      destinationUrl: selectedGreenhousePosting.applicationUrl,
    });
  });

  it("rejects a curated Greenhouse pair when board or posting identity differs", async () => {
    const service = new CareerAgentService(exampleCandidateProfile, {
      applicationService: createApplicationService(exampleCandidateProfile, new InMemoryApplicationRepository(), new DeterministicModelClient()),
      careerRepository: new InMemoryCareerRepository(),
      executor: new UnavailableApplicationExecutor(),
    }, { now: () => capturedAt, createId: (prefix) => `${prefix}-greenhouse-mismatch` });
    const campaign = service.createCampaign(campaignInput);
    service.activateCampaign(campaign.id);

    await expect(service.processCuratedJob(campaign.id, {
      ...selectedGreenhousePosting,
      applicationUrl: "https://job-boards.greenhouse.io/other-board/jobs/8194576",
    })).rejects.toThrow("same verified posting");
  });

  it("accepts a verified Workday posting/application pair with matching tenant and posting identity", async () => {
    const applicationRepository = new InMemoryApplicationRepository();
    const careerRepository = new InMemoryCareerRepository();
    const service = new CareerAgentService(exampleCandidateProfile, {
      applicationService: createApplicationService(exampleCandidateProfile, applicationRepository, new DeterministicModelClient()),
      careerRepository,
      executor: new UnavailableApplicationExecutor(),
    }, { now: () => capturedAt, createId: (prefix) => `${prefix}-workday` });
    const campaign = service.createCampaign(campaignInput);
    service.activateCampaign(campaign.id);

    const job = await service.processCuratedJob(campaign.id, selectedWorkdayPosting);

    expect(job.sourceRecordId).toMatch(/^workday:homedepot\.wd5:/);
    expect(job.job.ats).toBe("Workday");
    expect(job.destinationResolution).toMatchObject({
      status: "resolved",
      ats: "Workday",
      actionable: true,
      destinationUrl: selectedWorkdayPosting.applicationUrl,
    });
  });

  it("rejects Workday application routes without the matching public posting route", async () => {
    const applicationRepository = new InMemoryApplicationRepository();
    const careerRepository = new InMemoryCareerRepository();
    const service = new CareerAgentService(exampleCandidateProfile, {
      applicationService: createApplicationService(exampleCandidateProfile, applicationRepository, new DeterministicModelClient()),
      careerRepository,
      executor: new UnavailableApplicationExecutor(),
    }, { now: () => capturedAt, createId: (prefix) => `${prefix}-workday-mismatch` });
    const campaign = service.createCampaign(campaignInput);
    service.activateCampaign(campaign.id);

    await expect(service.processCuratedJob(campaign.id, {
      ...selectedWorkdayPosting,
      sourceUrl: "https://homedepot.wd5.myworkdayjobs.com/en-US/CareerDepot/job/TEXAS---VIRTUAL---TX01/Other-Role_Req999999",
    })).rejects.toThrow("same verified posting");
  });

  it("re-evaluates a previously rejected curated posting after an explicit profile correction", async () => {
    const applicationRepository = new InMemoryApplicationRepository();
    const careerRepository = new InMemoryCareerRepository();
    const profileWithoutCloudSkills = {
      ...exampleCandidateProfile,
      skills: exampleCandidateProfile.skills.filter((skill) => !["AWS", "Kubernetes", "Terraform", "Docker"].includes(skill)),
      employmentHistory: exampleCandidateProfile.employmentHistory.map((employment) => ({
        ...employment,
        verifiedSkills: employment.verifiedSkills.filter((skill) => !["AWS", "Kubernetes", "Terraform", "Docker"].includes(skill)),
      })),
    };
    const initial = new CareerAgentService(profileWithoutCloudSkills, {
      applicationService: createApplicationService(
        profileWithoutCloudSkills,
        applicationRepository,
        new DeterministicModelClient(),
      ),
      careerRepository,
      executor: new UnavailableApplicationExecutor(),
    }, {
      now: () => capturedAt,
      createId: (prefix) => `${prefix}-protagona-reconsideration`,
    });
    const campaign = initial.createCampaign(campaignInput);
    initial.activateCampaign(campaign.id);

    const rejected = await initial.processCuratedJob(campaign.id, selectedProtagonaPosting);
    expect(rejected.status).toBe("rejected");
    expect(rejected.applicationId).toBeUndefined();

    const correctedProfile = {
      ...profileWithoutCloudSkills,
      skills: [...profileWithoutCloudSkills.skills, "Terraform"],
    };
    const corrected = new CareerAgentService(correctedProfile, {
      applicationService: createApplicationService(
        correctedProfile,
        applicationRepository,
        new DeterministicModelClient(),
      ),
      careerRepository,
      executor: new UnavailableApplicationExecutor(),
    }, {
      now: () => capturedAt,
      createId: (prefix) => `${prefix}-protagona-reconsideration-corrected`,
    });

    const reconsidered = await corrected.processCuratedJob(campaign.id, selectedProtagonaPosting);

    expect(reconsidered.id).toBe(rejected.id);
    expect(reconsidered.fit?.classification).toBe("stretch");
    expect(reconsidered.status).toBe("needs_input");
    expect(reconsidered.applicationId).toBeDefined();
    expect(corrected.listJobs(campaign.id)).toHaveLength(1);
  });

  it("prepares a curated actionable posting even when destination enrichment is configured", async () => {
    const applicationRepository = new InMemoryApplicationRepository();
    const careerRepository = new InMemoryCareerRepository();
    const service = new CareerAgentService(exampleCandidateProfile, {
      applicationService: createApplicationService(
        exampleCandidateProfile,
        applicationRepository,
        new DeterministicModelClient(),
      ),
      careerRepository,
      executor: new UnavailableApplicationExecutor(),
      destinationResolver: {
        resolve: async () => ({
          status: "unresolved" as const,
          attemptedAt: capturedAt,
          evidence: ["test-destination-enrichment"],
          reason: "This resolver must not gate an already actionable curated posting.",
        }),
      },
    }, {
      now: () => capturedAt,
      createId: (prefix) => `${prefix}-ashby-enrichment-synthetic`,
    });
    const campaign = service.createCampaign(campaignInput);
    service.activateCampaign(campaign.id);

    const job = await service.processCuratedJob(campaign.id, selectedAshbyPosting);

    expect(job.actionability).toBe("actionable");
    expect(job.applicationId).toBeDefined();
    expect(job.status).toBe("needs_input");
  });
});
