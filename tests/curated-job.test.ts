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
  applicationUrl: "https://jobs.ashbyhq.com/Mastra/3b06208b-34fe-4dda-b409-ee3fd9305cc3/application",
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

describe("curated selected-posting intake", () => {
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
    expect(job.sourceRecordId).toBe("Mastra:3b06208b-34fe-4dda-b409-ee3fd9305cc3");
    expect(job.job.ats).toBe("Ashby");
    expect(job.destinationResolution).toMatchObject({
      status: "resolved",
      destinationUrl: selectedAshbyPosting.applicationUrl,
      ats: "Ashby",
      actionable: true,
    });
  });
});
