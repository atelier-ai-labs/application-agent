import { describe, expect, it } from "vitest";
import {
  canonicalJobUrl,
  createApplicationService,
  InMemoryApplicationRepository,
  InMemoryCareerRepository,
  JobScout,
  jobDedupeKeys,
  jobFingerprint,
  normalizeJobPosting,
  parseRemotiveResponse,
  RemotiveJobSource,
  type CandidateProfile,
  type Campaign,
  type JobPosting,
  type SearchCriteria,
} from "../application-agent/src";
import { exampleCandidateProfile } from "../application-agent/src/domain/profile";
import { CareerAgentService } from "../application-agent/src/service/careerAgentService";

const capturedAt = "2026-08-30T12:00:00.000Z";

const criteria: SearchCriteria = {
  roleLanes: ["engineer"],
  searchQueries: ["cloud"],
  locations: [],
  remoteOnly: true,
  employmentTypes: ["full time"],
  excludedSeniorities: [],
  excludedCompanies: [],
};

function remotiveJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 101,
    url: "https://remotive.com/remote-jobs/software-development/cloud-platform-engineer-101?utm_source=feed#details",
    title: "Cloud Platform Engineer",
    company_name: "Example Cloud Systems",
    category: "Software Development",
    tags: ["AWS", "Kubernetes"],
    job_type: "full_time",
    publication_date: "2026-08-30T10:00:00Z",
    candidate_required_location: "USA",
    salary: "$120k-$150k",
    description: "<p>Build dependable cloud systems.</p><p>Required qualifications: AWS and Kubernetes.</p>",
    ...overrides,
  };
}

function payload(jobs: readonly Record<string, unknown>[]): unknown {
  return { "job-count": jobs.length, "total-job-count": jobs.length, jobs };
}

function response(value: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => value,
  } as Response;
}

function activeCampaign(service: CareerAgentService, sourceId = "remotive-live"): Campaign {
  const campaign = service.createCampaign({
    name: "Live source test",
    goal: "Exercise normalized live discovery.",
    searchSources: [sourceId],
    searchCriteria: criteria,
  });
  return { ...campaign, status: "active" };
}

describe("Remotive live JobSource", () => {
  it("parses a valid provider response into normalized postings and preserves provenance", () => {
    const result = parseRemotiveResponse(payload([remotiveJob()]), criteria, capturedAt, 10);
    expect(result.listings).toHaveLength(1);
    const listing = result.listings[0];
    expect(listing.sourceRecordId).toBe("101");
    expect(listing.sourceMode).toBe("live");
    expect(listing.sourcePublishedAt).toBe("2026-08-30T10:00:00Z");
    expect(listing.input.isExample).toBe(false);
    expect(listing.input.sourceUrl).toContain("remotive.com");
    expect(listing.input.applicationUrl).toBeUndefined();
    expect(listing.input.rawText).not.toContain("<p>");

    const source = new RemotiveJobSource({
      fetcher: async () => response(payload([remotiveJob()])),
    });
    return expect(source.discover(criteria, { now: capturedAt, maxResults: 10 })).resolves.toMatchObject({
      listings: [expect.objectContaining({ sourceRecordId: "101", sourceMode: "live" })],
    });
  });

  it("keeps optional provider fields absent instead of inventing them", () => {
    const result = parseRemotiveResponse(payload([remotiveJob({
      category: undefined,
      tags: undefined,
      job_type: undefined,
      publication_date: undefined,
      candidate_required_location: undefined,
      salary: undefined,
    })]), criteria, capturedAt, 10);
    const listing = result.listings[0];
    expect(listing).toBeDefined();
    const normalized = normalizeJobPosting(listing.input, capturedAt);
    expect(normalized.company).toBe("Example Cloud Systems");
    expect(normalized.title).toBe("Cloud Platform Engineer");
    expect(normalized.remoteStatus).toBe("remote");
    expect(normalized.employmentType).toBeUndefined();
    expect(normalized.location).toBeUndefined();
  });

  it("skips malformed required records and reports a partial batch", () => {
    const result = parseRemotiveResponse(payload([
      remotiveJob(),
      remotiveJob({ id: 102, title: "" }),
      remotiveJob({ id: 103, url: "not-a-url" }),
    ]), criteria, capturedAt, 10);
    expect(result.listings).toHaveLength(1);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings?.every((warning) => warning.includes("Skipped Remotive job"))).toBe(true);
  });

  it("uses one provider query for one lane, local OR matching for multiple lanes, and a hard cap", async () => {
    const jobs = [
      remotiveJob({ id: 101, title: "Cloud Platform Engineer", publication_date: "2026-08-30T10:00:00Z" }),
      remotiveJob({ id: 102, title: "Frontend React Engineer", company_name: "Example Web Studio", description: "Build dependable React interfaces. Required qualifications: React and TypeScript.", publication_date: "2026-08-30T11:00:00Z" }),
      remotiveJob({ id: 103, title: "Unrelated Analyst", company_name: "Example Finance", description: "Analyze financial reports and prepare business summaries.", publication_date: "2026-08-30T12:00:00Z" }),
    ];
    const urls: string[] = [];
    const source = new RemotiveJobSource({
      maxResults: 2,
      fetcher: async (input) => {
        urls.push(String(input));
        return response(payload(jobs));
      },
    });

    const oneLane = await source.discover({ ...criteria, searchQueries: ["cloud"] }, { now: capturedAt, maxResults: 2 });
    const oneLaneUrl = new URL(urls[0]);
    expect(oneLaneUrl.searchParams.get("search")).toBe("cloud");
    expect(oneLaneUrl.searchParams.get("limit")).toBe("2");
    expect(oneLane.listings).toHaveLength(1);

    const twoLanes = await source.discover({ ...criteria, searchQueries: ["cloud", "react"] }, { now: capturedAt, maxResults: 2 });
    const twoLaneUrl = new URL(urls[1]);
    expect(twoLaneUrl.searchParams.has("search")).toBe(false);
    expect(twoLanes.listings).toHaveLength(2);
    expect(twoLanes.listings.map((listing) => listing.sourceRecordId)).toEqual(["102", "101"]);
  });

  it("surfaces HTTP, rate-limit, invalid JSON, and malformed payload failures through JobScout", async () => {
    const cases: Array<{ response: Response; expected: string }> = [
      { response: response({}, false, 503), expected: "HTTP 503" },
      { response: response({}, false, 429), expected: "rate limited" },
      { response: { ok: true, status: 200, json: async () => { throw new Error("bad json"); } } as unknown as Response, expected: "invalid JSON" },
      { response: response({ jobs: {} }), expected: "jobs array" },
    ];

    for (const testCase of cases) {
      const source = new RemotiveJobSource({ fetcher: async () => testCase.response });
      const repository = new InMemoryCareerRepository();
      const applicationRepository = new InMemoryApplicationRepository();
      const service = new CareerAgentService(exampleCandidateProfile as CandidateProfile, {
        careerRepository: repository,
        applicationService: createApplicationService(exampleCandidateProfile, applicationRepository),
        scout: new JobScout({ "remotive-live": source }, () => capturedAt),
      });
      const campaign = activeCampaign(service);
      const result = await new JobScout({ "remotive-live": source }, () => capturedAt).discover(campaign);
      expect(result.jobs).toHaveLength(0);
      expect(result.failures[0].reason.toLowerCase()).toContain(testCase.expected.toLowerCase());
      expect(result.sourceSummaries[0].status).toBe("failed");
    }
  });

  it("retains explicit live provenance and safely handles a partial malformed batch", async () => {
    const source = new RemotiveJobSource({
      fetcher: async () => response(payload([remotiveJob(), remotiveJob({ id: 102, title: "" })])),
    });
    const result = await new JobScout({ "remotive-live": source }, () => capturedAt, { maxResultsPerSource: 10 }).discover({
      ...activeCampaign(new CareerAgentService(exampleCandidateProfile, { scout: new JobScout({}) })),
      status: "active",
      searchSources: ["remotive-live"],
    });
    expect(result.jobs[0].sourceMode).toBe("live");
    expect(result.jobs[0].isExample).toBe(false);
    expect(result.sourceSummaries[0]).toMatchObject({ status: "partial", normalizedCount: 1, warningCount: 1 });
  });
});

describe("Job identity and discovery deduplication", () => {
  const job: JobPosting = normalizeJobPosting({
    rawText: "Example Cloud Systems\nCloud Platform Engineer\nLocation: Remote\nA real posting description with enough detail.",
    sourceUrl: "https://jobs.example.com/cloud-platform-engineer/?utm_source=feed#role",
  }, capturedAt);

  it("removes tracking URL noise and prefers provider IDs while retaining aliases", () => {
    expect(canonicalJobUrl("https://jobs.example.com/cloud-platform-engineer/?b=2&utm_source=feed&a=1#role"))
      .toBe("https://jobs.example.com/cloud-platform-engineer?a=1&b=2");
    expect(jobFingerprint(job, "101", "remotive-live")).toBe("source:remotive-live:id:101");
    expect(jobDedupeKeys(job, "101", "remotive-live")).toContain("url:https://jobs.example.com/cloud-platform-engineer");
  });

  it("deduplicates equivalent URLs inside a source result", async () => {
    const source = {
      id: "url-source",
      mode: "live" as const,
      discover: async () => [
        { input: { rawText: job.description, sourceUrl: "https://jobs.example.com/cloud-platform-engineer?utm_medium=email" } },
        { input: { rawText: job.description, sourceUrl: "https://jobs.example.com/cloud-platform-engineer/#top" } },
      ],
    };
    const campaign = {
      id: "campaign-url-test",
      name: "URL test",
      goal: "URL test",
      status: "active" as const,
      searchCriteria: { roleLanes: [], locations: [], remoteOnly: false, employmentTypes: [], excludedSeniorities: [], excludedCompanies: [] },
      searchSources: [source.id],
      fitPolicy: { strong: "pursue" as const, good: "pursue" as const, stretch: "hold" as const, weak: "reject" as const },
      applicationPolicy: { autoPrepare: false, allowGroundedDrafts: false, approvedResumeFamilies: [] },
      submissionPolicy: { authority: "never" as const, requireExplicitApproval: false },
      dailyApplicationLimit: 1,
      reviewConditions: { unusualTerms: true, authenticationRequired: true, unknownFacts: true, subjectiveAnswers: true },
      stopConditions: { stopOnAcceptedOffer: true, systemicFailureLimit: 3 },
      consecutiveSystemicFailures: 0,
      createdAt: capturedAt,
      updatedAt: capturedAt,
    } satisfies Campaign;
    const result = await new JobScout({ [source.id]: source }, () => capturedAt).discover(campaign);
    expect(result.jobs).toHaveLength(1);
    expect(result.duplicateCount).toBe(1);
  });
});
