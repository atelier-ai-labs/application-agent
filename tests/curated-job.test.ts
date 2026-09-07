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
});
