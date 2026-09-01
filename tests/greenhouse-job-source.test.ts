import { describe, expect, it } from "vitest";
import {
  createGreenhouseJobSources,
  createLiveCampaignInput,
  GreenhouseJobSource,
  greenhouseSourceId,
  JobScout,
  parseGreenhouseBoards,
  parseGreenhouseResponse,
  type Campaign,
  type JobSourceListing,
  type SearchCriteria,
} from "../application-agent/src";

const capturedAt = "2026-08-31T12:00:00.000Z";
const board = "acme";
const postingId = "123456";

const criteria: SearchCriteria = {
  roleLanes: ["engineer"],
  searchQueries: ["platform"],
  locations: [],
  remoteOnly: false,
  employmentTypes: [],
  excludedSeniorities: [],
  excludedCompanies: [],
};

function greenhousePosting(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: Number(postingId),
    title: "Platform Engineer",
    updated_at: "2026-08-30T15:00:00Z",
    absolute_url: `https://boards.greenhouse.io/${board}/jobs/${postingId}`,
    location: { name: "Remote - United States" },
    content: "<p>Build dependable platform systems for product engineering teams.</p><p>Required qualifications: Azure and CI/CD.</p>",
    departments: [{ id: 1, name: "Engineering" }],
    offices: [{ id: 2, name: "Remote", location: "United States" }],
    ...overrides,
  };
}

function payload(jobs: readonly Record<string, unknown>[]): unknown {
  return { jobs, meta: { total: jobs.length } };
}

function response(value: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => value } as Response;
}

function activeCampaign(sourceIds: readonly string[]): Campaign {
  return {
    id: "campaign-greenhouse-test",
    name: "Greenhouse test",
    goal: "Test the structured Greenhouse source.",
    status: "active",
    searchCriteria: criteria,
    searchSources: sourceIds,
    fitPolicy: { strong: "pursue", good: "pursue", stretch: "hold", weak: "reject" },
    applicationPolicy: { autoPrepare: false, allowGroundedDrafts: false, approvedResumeFamilies: [] },
    submissionPolicy: { authority: "never", requireExplicitApproval: false },
    dailyApplicationLimit: 3,
    reviewConditions: { unusualTerms: true, authenticationRequired: true, unknownFacts: true, subjectiveAnswers: true },
    stopConditions: { stopOnAcceptedOffer: true, systemicFailureLimit: 3 },
    consecutiveSystemicFailures: 0,
    createdAt: capturedAt,
    updatedAt: capturedAt,
  };
}

describe("Greenhouse public Job Board source", () => {
  it("normalizes published jobs, preserves provider identity, maps URLs, and marks hosted forms actionable", async () => {
    const urls: string[] = [];
    const source = new GreenhouseJobSource({
      board,
      company: "Acme Corp",
      fetcher: async (input) => {
        urls.push(String(input));
        return response(payload([greenhousePosting()]));
      },
    });
    const result = await source.discover(criteria, { now: capturedAt, maxResults: 10 });
    expect(new URL(urls[0]).pathname).toBe(`/v1/boards/${board}/jobs`);
    expect(new URL(urls[0]).searchParams.get("content")).toBe("true");
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]).toMatchObject({ sourceRecordId: postingId, sourceMode: "live" });
    expect(result.listings[0].input).toMatchObject({
      sourceUrl: `https://boards.greenhouse.io/${board}/jobs/${postingId}`,
      applicationUrl: `https://boards.greenhouse.io/${board}/jobs/${postingId}`,
      companyHint: "Acme Corp",
      titleHint: "Platform Engineer",
    });
    expect(result.listings[0].input.rawText).not.toContain("<p>");

    const scouted = await new JobScout({ [source.id]: source }, () => capturedAt).discover(activeCampaign([source.id]));
    expect(scouted.jobs[0].sourceId).toBe(greenhouseSourceId(board));
    expect(scouted.jobs[0].actionability).toBe("actionable");
    expect(scouted.jobs[0].job).toMatchObject({
      company: "Acme Corp",
      title: "Platform Engineer",
      location: "Remote - United States",
      remoteStatus: "remote",
      ats: "Greenhouse",
      applicationUrl: `https://boards.greenhouse.io/${board}/jobs/${postingId}`,
    });
    expect(scouted.jobs[0].job.description).toContain("Build dependable platform systems");
    expect(scouted.jobs[0].sourceObservations[0]).toMatchObject({ sourceRecordId: postingId, actionability: "actionable" });
  });

  it("reads the public board name when no company label is configured", async () => {
    const requested: string[] = [];
    const source = new GreenhouseJobSource({
      board,
      fetcher: async (input) => {
        requested.push(String(input));
        return requested.length === 1
          ? response({ name: "Acme Corp" })
          : response(payload([greenhousePosting({ location: undefined, departments: undefined, offices: undefined })]));
      },
    });
    const result = await source.discover({ ...criteria, searchQueries: [] }, { now: capturedAt, maxResults: 10 });
    expect(requested).toHaveLength(2);
    expect(result.listings[0].input.companyHint).toBe("Acme Corp");
    const normalized = parseGreenhouseResponse(payload([greenhousePosting({ location: undefined, departments: undefined, offices: undefined })]), board, { ...criteria, searchQueries: [] }, capturedAt, 10, "Acme Corp").listings[0].input;
    expect(normalized.rawText).not.toContain("Department:");
    expect(normalized.rawText).not.toContain("Office:");
  });

  it("uses plaintext-safe content and never forwards provider HTML", () => {
    const result = parseGreenhouseResponse(payload([greenhousePosting({
      content: "&amp;lt;p&amp;gt;Plain platform description with Azure and CI/CD.&amp;lt;/p&amp;gt;<script>alert('x')</script>",
    })]), board, criteria, capturedAt, 10, "Acme Corp");
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0].input.rawText).toContain("Plain platform description");
    expect(result.listings[0].input.rawText).not.toContain("<script>");
    expect(result.listings[0].input.rawText).not.toContain("&amp;");
  });

  it("isolates malformed postings and preserves optional fields as absent", () => {
    const result = parseGreenhouseResponse(payload([
      greenhousePosting(),
      greenhousePosting({ id: undefined }),
      greenhousePosting({ absolute_url: "not-a-url" }),
      greenhousePosting({ id: 123457, content: "too short" }),
    ]), board, criteria, capturedAt, 10, "Acme Corp");
    expect(result.listings).toHaveLength(1);
    expect(result.warnings).toHaveLength(3);

    const optional = parseGreenhouseResponse(payload([greenhousePosting({
      id: 123458,
      title: "Frontend Engineer",
      location: undefined,
      departments: undefined,
      offices: undefined,
      updated_at: undefined,
      content: "Build accessible product interfaces with reliable frontend systems.",
    })]), board, { ...criteria, searchQueries: [] }, capturedAt, 10, "Acme Corp").listings[0].input;
    expect(optional.companyHint).toBe("Acme Corp");
    expect(optional.rawText).not.toContain("Location:");
  });

  it("keeps a non-hosted absolute URL discoverable but not actionable", async () => {
    const source = new GreenhouseJobSource({
      board,
      company: "Acme Corp",
      fetcher: async () => response(payload([greenhousePosting({ absolute_url: "https://careers.acme.example/jobs/123456" })])),
    });
    const result = await new JobScout({ [source.id]: source }, () => capturedAt).discover(activeCampaign([source.id]));
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].job.applicationUrl).toBeUndefined();
    expect(result.jobs[0].actionability).toBe("discoverable_only");
  });

  it("applies lane matching locally, sorts by provider timestamp, and caps results", () => {
    const result = parseGreenhouseResponse(payload([
      greenhousePosting({ id: 123459, title: "Frontend Engineer", updated_at: "2026-08-20T00:00:00Z", content: "Build platform-adjacent frontend systems." }),
      greenhousePosting({ id: 123460, title: "Platform Engineer", updated_at: "2026-08-29T00:00:00Z" }),
      greenhousePosting({ id: 123461, title: "Finance Analyst", updated_at: "2026-08-31T00:00:00Z", content: "Prepare financial reports and business summaries." }),
    ]), board, { ...criteria, searchQueries: ["platform"] }, capturedAt, 1, "Acme Corp");
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0].sourceRecordId).toBe("123460");
  });

  it("supports multiple boards and reports HTTP, rate-limit, JSON, and timeout failures", async () => {
    expect(parseGreenhouseBoards("stripe, Stripe, invalid board!, ramp")).toEqual(["stripe", "ramp"]);
    const sources = createGreenhouseJobSources(["stripe", "ramp"]);
    expect(sources.map((source) => source.id)).toEqual(["greenhouse:stripe", "greenhouse:ramp"]);

    const failingCases: Array<{ result: Response; expected: string }> = [
      { result: response({}, false, 503), expected: "HTTP 503" },
      { result: response({}, false, 429), expected: "rate limited" },
      { result: { ok: true, status: 200, json: async () => { throw new Error("bad json"); } } as unknown as Response, expected: "invalid" },
    ];
    for (const testCase of failingCases) {
      const source = new GreenhouseJobSource({ board, company: "Acme Corp", fetcher: async () => testCase.result });
      await expect(source.discover(criteria, { now: capturedAt, maxResults: 5 })).rejects.toThrow(testCase.expected);
    }
    const malformed = new GreenhouseJobSource({ board, company: "Acme Corp", fetcher: async () => response({ postings: [] }) });
    await expect(malformed.discover(criteria, { now: capturedAt, maxResults: 5 })).rejects.toThrow("jobs array");

    const slow = new GreenhouseJobSource({ board, company: "Acme Corp", fetcher: async () => new Promise<Response>(() => undefined) });
    const result = await new JobScout({ [slow.id]: slow }, () => capturedAt, { timeoutMs: 1 }).discover(activeCampaign([slow.id]));
    expect(result.sourceSummaries[0].status).toBe("failed");
  });

  it("exposes multiple Greenhouse boards as declarative campaign watchlist entries", () => {
    const campaign = createLiveCampaignInput([], [
      "anthropic",
      { board: "stripe", company: "Stripe" },
    ]);
    expect(campaign.name).toBe("Live remote + targeted ATS search");
    expect(campaign.searchSources).toEqual(["remotive-live", "greenhouse:anthropic", "greenhouse:stripe"]);
    expect(campaign.sourceConfigs).toEqual([
      { type: "remotive", id: "remotive-live" },
      { type: "greenhouse", board: "anthropic", id: "greenhouse:anthropic" },
      { type: "greenhouse", board: "stripe", company: "Stripe", id: "greenhouse:stripe" },
    ]);
  });

  it("isolates one failing board while preserving healthy source results", async () => {
    const healthy = new GreenhouseJobSource({
      board: "healthy",
      company: "Healthy Corp",
      fetcher: async () => response(payload([greenhousePosting({ absolute_url: "https://boards.greenhouse.io/healthy/jobs/123456" })])),
    });
    const broken = new GreenhouseJobSource({ board: "broken", company: "Broken Corp", fetcher: async () => response({}, false, 503) });
    const result = await new JobScout({ [healthy.id]: healthy, [broken.id]: broken }, () => capturedAt).discover(activeCampaign([healthy.id, broken.id]));
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].sourceId).toBe(healthy.id);
    expect(result.sourceSummaries).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: broken.id, status: "failed" })]));
  });

  it("isolates a failing Greenhouse board while preserving a healthy Remotive result", async () => {
    const remotive = {
      id: "remotive-live",
      mode: "live" as const,
      discover: async (): Promise<readonly JobSourceListing[]> => [{
        sourceRecordId: "remotive-healthy",
        sourceMode: "live",
        input: {
          rawText: "Company: Example Remote\nTitle: Platform Engineer\nLocation: Remote - United States\nBuild dependable platform infrastructure for an engineering team.",
          sourceUrl: "https://remotive.com/remote-jobs/platform-engineer-healthy",
          companyHint: "Example Remote",
          titleHint: "Platform Engineer",
        },
      }],
    };
    const broken = new GreenhouseJobSource({
      board: "broken",
      company: "Broken Corp",
      fetcher: async () => response({}, false, 503),
    });
    const result = await new JobScout({ [remotive.id]: remotive, [broken.id]: broken }, () => capturedAt)
      .discover(activeCampaign([remotive.id, broken.id]));
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].sourceId).toBe(remotive.id);
    expect(result.sourceSummaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: broken.id, status: "failed" }),
    ]));
  });

  it("cross-deduplicates a Greenhouse posting with a live Remotive observation", async () => {
    const greenhouse = new GreenhouseJobSource({
      board,
      company: "Acme Corp",
      fetcher: async () => response(payload([greenhousePosting()])),
    });
    const remotive = {
      id: "remotive-live",
      mode: "live" as const,
      discover: async (): Promise<readonly JobSourceListing[]> => [{
        sourceRecordId: "remotive-123",
        sourceMode: "live",
        input: {
          rawText: "Acme Corp\nPlatform Engineer\nLocation: Remote - United States\nBuild dependable platform systems for product engineering teams.",
          sourceUrl: "https://remotive.com/remote-jobs/acme-platform-engineer",
          companyHint: "Acme Corp",
          titleHint: "Platform Engineer",
        },
      }],
    };
    const result = await new JobScout({ [remotive.id]: remotive, [greenhouse.id]: greenhouse }, () => capturedAt).discover(activeCampaign([remotive.id, greenhouse.id]));
    expect(result.jobs).toHaveLength(1);
    expect(result.duplicateCount).toBe(1);
    expect(result.jobs[0].actionability).toBe("actionable");
    expect(result.jobs[0].sourceObservations).toHaveLength(2);
  });
});
