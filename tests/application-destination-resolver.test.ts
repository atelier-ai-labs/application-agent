import { describe, expect, it } from "vitest";
import {
  ApplicationService,
  BoundedApplicationDestinationResolver,
  exampleCandidateProfile,
  InMemoryApplicationRepository,
  InMemoryCareerRepository,
  JobScout,
  normalizeJobPosting,
  StaticDestinationEvidenceLookup,
  type CandidateProfile,
  type DestinationCandidate,
  type JobSourceListing,
} from "../application-agent/src";
import { CareerAgentService } from "../application-agent/src/service/careerAgentService";

const now = "2026-09-04T12:00:00.000Z";
const listingUrl = "https://himalayas.app/companies/example/jobs/platform-engineer";

function candidate(overrides: Partial<DestinationCandidate> = {}): DestinationCandidate {
  return {
    url: "https://boards.greenhouse.io/example/jobs/123456",
    company: "Example Cloud Systems",
    role: "Cloud Platform Engineer",
    source: "recognized_ats",
    pageKind: "application",
    employerVerified: true,
    roleVerified: true,
    current: true,
    evidence: ["official company board lists the matching open role"],
    ...overrides,
  };
}

function input(overrides: Partial<Parameters<BoundedApplicationDestinationResolver["resolve"]>[0]> = {}) {
  return {
    company: "Example Cloud Systems",
    role: "Cloud Platform Engineer",
    knownListingUrl: listingUrl,
    existingApplicationUrl: listingUrl,
    existingApplicationActionable: false,
    sourceObservations: [],
    ...overrides,
  };
}

describe("bounded application destination resolution", () => {
  it("bypasses enrichment for an already actionable external application URL", async () => {
    const lookup = new StaticDestinationEvidenceLookup([candidate({ url: "https://boards.greenhouse.io/example/jobs/999" })]);
    const resolver = new BoundedApplicationDestinationResolver({ lookup });
    const result = await resolver.resolve(input({
      existingApplicationUrl: "https://boards.greenhouse.io/example/jobs/123456",
      existingApplicationActionable: true,
    }));
    expect(result.status).toBe("resolved");
    expect(result.provenance).toBe("existing_external_application_url");
    expect(lookup.calls).toBe(0);
  });

  it("enters one bounded lookup for a provider-gated URL", async () => {
    const lookup = new StaticDestinationEvidenceLookup([]);
    const result = await new BoundedApplicationDestinationResolver({ lookup }).resolve(input());
    expect(result.status).toBe("unresolved");
    expect(lookup.calls).toBe(1);
    expect(result.reason).toContain("No trustworthy");
  });

  it("resolves a verified official employer application page", async () => {
    const result = await new BoundedApplicationDestinationResolver({
      lookup: new StaticDestinationEvidenceLookup([candidate({
        url: "https://careers.example.com/jobs/cloud-platform-engineer/apply",
        source: "official_employer",
        officialDomain: "careers.example.com",
      })]),
    }).resolve(input());
    expect(result).toMatchObject({
      status: "resolved",
      destinationUrl: "https://careers.example.com/jobs/cloud-platform-engineer/apply",
      ats: "Custom",
      actionable: true,
      provenance: "official_employer_evidence",
    });
  });

  it("resolves a verified recognized ATS destination and preserves redirect evidence", async () => {
    const result = await new BoundedApplicationDestinationResolver({
      lookup: new StaticDestinationEvidenceLookup([candidate({
        url: "https://example.com/apply/cloud-platform-engineer",
        finalUrl: "https://boards.greenhouse.io/example/jobs/123456",
        source: "bounded_public_lookup",
        officialDomain: "example.com",
      })]),
    }).resolve(input());
    expect(result).toMatchObject({
      status: "resolved",
      destinationUrl: "https://boards.greenhouse.io/example/jobs/123456",
      ats: "Greenhouse",
      provenance: "bounded_public_lookup",
    });
    expect(result.evidence).toContain("redirect:verified");
  });

  it.each([
    ["company mismatch", { company: "Other Company" }, "employer"],
    ["role mismatch", { role: "Frontend Engineer" }, "role"],
  ])("rejects a %s", async (_label, mismatch, reason) => {
    const result = await new BoundedApplicationDestinationResolver({
      lookup: new StaticDestinationEvidenceLookup([candidate()]),
    }).resolve(input(mismatch));
    expect(result.status).toBe("unresolved");
    expect(result.evidence.some((item) => item.includes(reason))).toBe(true);
  });

  it("keeps multiple verified candidates ambiguous and never chooses one", async () => {
    const result = await new BoundedApplicationDestinationResolver({
      lookup: new StaticDestinationEvidenceLookup([
        candidate(),
        candidate({ url: "https://jobs.ashbyhq.com/example/cloud-platform-engineer" }),
      ]),
    }).resolve(input());
    expect(result.status).toBe("ambiguous");
    expect(result.destinationUrl).toBeUndefined();
    expect(result.actionable).toBeUndefined();
  });

  it("enforces the candidate bound", async () => {
    const lookup = new StaticDestinationEvidenceLookup(Array.from({ length: 10 }, (_, index) => candidate({
      url: `https://boards.greenhouse.io/example/jobs/${123456 + index}`,
    })));
    const result = await new BoundedApplicationDestinationResolver({ lookup, maxCandidates: 8 }).resolve(input());
    expect(result.status).toBe("ambiguous");
    expect(result.evidence).toContain("candidate-count:8");
  });
});

describe("destination state stays separate from quality and pursuit", () => {
  it("preserves an unresolved strong job as pursuing without creating a false application", async () => {
    const profile = JSON.parse(JSON.stringify(exampleCandidateProfile)) as CandidateProfile;
    const applicationRepository = new InMemoryApplicationRepository();
    const careerRepository = new InMemoryCareerRepository();
    const source = {
      id: "himalayas-live",
      mode: "live" as const,
      discover: async (): Promise<readonly JobSourceListing[]> => [{
        sourceRecordId: "himalayas-example-1",
        input: {
          rawText: "Example Cloud Systems\nCloud Platform Engineer\nLocation: Remote - United States\nEmployment type: Full-time\n\nBuild dependable cloud infrastructure for an example team with AWS and Kubernetes.\n",
          sourceUrl: listingUrl,
          applicationUrl: listingUrl,
          companyHint: "Example Cloud Systems",
          titleHint: "Cloud Platform Engineer",
        },
      }],
    };
    const service = new CareerAgentService(profile, {
      applicationService: new ApplicationService(applicationRepository, profile),
      careerRepository,
      scout: new JobScout({ [source.id]: source }, () => now),
      destinationResolver: new BoundedApplicationDestinationResolver({
        lookup: new StaticDestinationEvidenceLookup([]),
      }),
    }, { now: () => now, createId: (prefix) => `${prefix}-test` });
    const campaign = service.createCampaign({
      name: "Destination test",
      goal: "Keep unresolved pursued jobs durable.",
      searchSources: [source.id],
      searchCriteria: { roleLanes: ["cloud"], remoteOnly: true, employmentTypes: ["full time"] },
      submissionPolicy: { authority: "never", requireExplicitApproval: false },
    });
    service.activateCampaign(campaign.id);
    await service.runCampaign(campaign.id);
    const job = service.listJobs(campaign.id)[0];
    expect(job.fit?.classification).toBe("strong");
    expect(job.status).toBe("pursuing");
    expect(job.destinationResolution?.status).toBe("unresolved");
    expect(job.job.sourceUrl).toBe(listingUrl);
    expect(job.job.applicationUrl).toBe(listingUrl);
    expect(job.applicationId).toBeUndefined();
    expect(applicationRepository.listApplications()).toHaveLength(0);
  });

  it("retains source provenance while applying a verified destination to an existing packet", async () => {
    const posting = normalizeJobPosting({
      rawText: "Example Cloud Systems\nCloud Platform Engineer\nLocation: Remote - United States\nBuild dependable cloud infrastructure for an example team.",
      sourceUrl: listingUrl,
      applicationUrl: listingUrl,
      companyHint: "Example Cloud Systems",
      titleHint: "Cloud Platform Engineer",
    }, now);
    const applicationRepository = new InMemoryApplicationRepository();
    const applicationService = new ApplicationService(applicationRepository, exampleCandidateProfile);
    const application = await applicationService.createApplicationFromJob(posting);
    const updated = applicationService.updateApplicationJob(application.id, {
      ...posting,
      applicationUrl: "https://boards.greenhouse.io/example/jobs/123456",
    });
    expect(updated.job.sourceUrl).toBe(listingUrl);
    expect(updated.job.applicationUrl).toBe("https://boards.greenhouse.io/example/jobs/123456");
  });
});
