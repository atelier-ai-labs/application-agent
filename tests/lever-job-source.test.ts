import { describe, expect, it } from "vitest";
import {
  createLeverJobSources,
  createLiveCampaignInput,
  isVerifiedLeverApplicationUrl,
  isVerifiedLeverHostedUrl,
  leverSourceId,
  LeverJobSource,
  normalizeJobPosting,
  parseLeverResponse,
  parseLeverSites,
  JobScout,
  type Campaign,
  type JobSourceListing,
  type SearchCriteria,
} from "../application-agent/src";

const capturedAt = "2026-08-30T12:00:00.000Z";
const site = "acme";
const postingId = "11111111-1111-4111-8111-111111111111";

const criteria: SearchCriteria = {
  roleLanes: ["engineer"],
  searchQueries: ["platform"],
  locations: [],
  remoteOnly: false,
  employmentTypes: [],
  excludedSeniorities: [],
  excludedCompanies: [],
};

function leverPosting(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: postingId,
    text: "Platform Engineer",
    categories: {
      location: "New York",
      allLocations: ["New York"],
      commitment: "Full time",
      team: "Engineering",
      department: "Platform",
    },
    workplaceType: "hybrid",
    descriptionPlain: "Build and operate reliable platform services for product engineering teams.",
    description: "<p>Unsafe HTML fallback should never reach the normalized posting.</p>",
    hostedUrl: `https://jobs.lever.co/${site}/${postingId}`,
    applyUrl: `https://jobs.lever.co/${site}/${postingId}/apply?lever-source=feed`,
    salaryRange: { currency: "USD", interval: "per-year-salary", min: 120000, max: 160000 },
    salaryDescriptionPlain: "$120,000 - $160,000 USD per year",
    createdAt: "2026-08-29T15:00:00.000Z",
    ...overrides,
  };
}

function response(value: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => value } as Response;
}

function activeCampaign(sourceIds: readonly string[]): Campaign {
  return {
    id: "campaign-lever-test",
    name: "Lever test",
    goal: "Test targeted source behavior.",
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

describe("Lever live JobSource", () => {
  it("normalizes a valid posting, maps URLs and fields, and marks it actionable", async () => {
    const source = new LeverJobSource({
      site,
      fetcher: async () => response([leverPosting()]),
    });
    const result = await source.discover(criteria, { now: capturedAt, maxResults: 10 });
    expect(result.listings).toHaveLength(1);
    const listing = result.listings[0];
    expect(listing.sourceRecordId).toBe(postingId);
    expect(listing.sourceMode).toBe("live");
    expect(listing.input.sourceUrl).toBe(`https://jobs.lever.co/${site}/${postingId}`);
    expect(listing.input.applicationUrl).toContain(`/jobs.lever.co/${site}/${postingId}/apply`);
    expect(listing.input.rawText).not.toContain("<p>");

    const scout = new JobScout({ [source.id]: source }, () => capturedAt);
    const scouted = await scout.discover(activeCampaign([source.id]));
    expect(scouted.jobs).toHaveLength(1);
    expect(scouted.normalizedCount).toBe(1);
    expect(scouted.sourceSummaries[0]).toMatchObject({ normalizedCount: 1, duplicateCount: 0 });
    expect(scouted.jobs[0].sourceId).toBe(leverSourceId(site));
    expect(scouted.jobs[0].actionability).toBe("actionable");
    expect(scouted.jobs[0].job).toMatchObject({
      company: site,
      title: "Platform Engineer",
      location: "New York",
      remoteStatus: "hybrid",
      employmentType: "full time",
      applicationUrl: `https://jobs.lever.co/${site}/${postingId}/apply?lever-source=feed`,
      compensation: { minimum: 120000, maximum: 160000, currency: "USD" },
      ats: "Lever",
    });
    expect(scouted.jobs[0].job.description).toContain("Build and operate reliable platform services");
    expect(scouted.jobs[0].job.description).not.toContain("<p>");
    expect(scouted.jobs[0].sourceObservations[0]).toMatchObject({
      sourceId: leverSourceId(site),
      sourceRecordId: postingId,
      actionability: "actionable",
    });
  });

  it("keeps optional workplace, location, commitment, and salary fields absent", () => {
    const result = parseLeverResponse(payload([leverPosting({
      categories: { team: "Engineering" },
      workplaceType: "unspecified",
      salaryRange: undefined,
      salaryDescriptionPlain: undefined,
    })]), site, criteria, capturedAt, 10);
    const normalized = normalizeJobPosting(result.listings[0].input, capturedAt);
    expect(normalized.location).toBeUndefined();
    expect(normalized.remoteStatus).toBeUndefined();
    expect(normalized.employmentType).toBeUndefined();
    expect(normalized.compensation).toBeUndefined();
  });

  it("uses plaintext fields before HTML and strips HTML fallback content", () => {
    const result = parseLeverResponse(payload([leverPosting({
      descriptionPlain: undefined,
      openingPlain: "Plain opening with enough detail for a normalized posting.",
      descriptionBodyPlain: "Plain body content.",
      description: "<script>alert('x')</script><p>HTML body</p>",
    })]), site, criteria, capturedAt, 10);
    const text = result.listings[0].input.rawText;
    expect(text).toContain("Plain opening");
    expect(text).toContain("Plain body content");
    expect(text).not.toContain("<script>");
    expect(text).not.toContain("<p>");
  });

  it("isolates malformed postings and invalid hosted URLs", () => {
    const result = parseLeverResponse(payload([
      leverPosting(),
      leverPosting({ id: "bad", hostedUrl: "https://example.com/not-lever" }),
      leverPosting({ id: "bad-2", text: "" }),
      leverPosting({ id: "bad-3", descriptionPlain: "short" }),
    ]), site, criteria, capturedAt, 10);
    expect(result.listings).toHaveLength(1);
    expect(result.warnings).toHaveLength(3);
  });

  it("keeps an invalid application URL discoverable but not actionable", async () => {
    const source = new LeverJobSource({
      site,
      fetcher: async () => response([leverPosting({ applyUrl: "https://evil.example/apply" })]),
    });
    const result = await new JobScout({ [source.id]: source }, () => capturedAt).discover(activeCampaign([source.id]));
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].job.applicationUrl).toBeUndefined();
    expect(result.jobs[0].actionability).toBe("discoverable_only");
    expect(result.sourceSummaries[0].status).toBe("partial");
    expect(isVerifiedLeverHostedUrl(result.jobs[0].job.sourceUrl, site, postingId)).toBe(true);
    expect(isVerifiedLeverApplicationUrl(result.jobs[0].job.applicationUrl, site, postingId)).toBe(false);
  });

  it("maps local search lanes, sends no pretend provider search, sorts, and caps results", async () => {
    const urls: string[] = [];
    const source = new LeverJobSource({
      site,
      maxResults: 1,
      fetcher: async (input) => {
        urls.push(String(input));
        return response([
          leverPosting({
            id: "older",
            text: "Platform Engineer",
            hostedUrl: `https://jobs.lever.co/${site}/older`,
            applyUrl: `https://jobs.lever.co/${site}/older/apply`,
            createdAt: "2026-08-20T00:00:00Z",
          }),
          leverPosting({
            id: "newer",
            text: "Frontend Engineer",
            hostedUrl: `https://jobs.lever.co/${site}/newer`,
            applyUrl: `https://jobs.lever.co/${site}/newer/apply`,
            createdAt: "2026-08-29T00:00:00Z",
          }),
        ]);
      },
    });
    const result = await source.discover({ ...criteria, searchQueries: ["frontend"] }, { now: capturedAt, maxResults: 1 });
    const request = new URL(urls[0]);
    expect(request.pathname).toBe(`/v0/postings/${site}`);
    expect(request.searchParams.get("mode")).toBe("json");
    expect(request.searchParams.get("limit")).toBe("1");
    expect(request.searchParams.has("search")).toBe(false);
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0].sourceRecordId).toBe("newer");
  });

  it("supports multiple configured sites without company-specific adapters", () => {
    expect(parseLeverSites("h1, H1, invalid site, other-company")).toEqual(["h1", "other-company"]);
    const sources = createLeverJobSources(["acme", "other-company"]);
    expect(sources.map((source) => source.id)).toEqual(["lever:acme", "lever:other-company"]);
    const campaign = createLiveCampaignInput(["acme", "other-company"]);
    expect(campaign.searchSources).toEqual(["remotive-live", "lever:acme", "lever:other-company"]);
    expect(campaign.sourceConfigs).toMatchObject([
      { type: "remotive", id: "remotive-live" },
      { type: "lever", site: "acme", id: "lever:acme" },
      { type: "lever", site: "other-company", id: "lever:other-company" },
    ]);
  });

  it("adds bounded broad discovery only when explicitly enabled", () => {
    const campaign = createLiveCampaignInput(["acme"], [], true);
    expect(campaign.searchSources).toEqual(["remotive-live", "lever:acme", "references:brave-search-live"]);
    expect(campaign.sourceConfigs).toContainEqual({ type: "brave_search", id: "references:brave-search-live" });
    expect(createLiveCampaignInput(["acme"], [], false).searchSources).not.toContain("references:brave-search-live");
  });

  it("keeps Remotive results when one configured Lever site fails", async () => {
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
    const broken = new LeverJobSource({
      site: "broken-company",
      fetcher: async () => response({}, false, 503),
    });
    const result = await new JobScout({
      [remotive.id]: remotive,
      [broken.id]: broken,
    }, () => capturedAt).discover(activeCampaign([remotive.id, broken.id]));
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].sourceId).toBe(remotive.id);
    expect(result.sourceSummaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: broken.id, status: "failed" }),
    ]));
    expect(result.failures[0].sourceId).toBe(broken.id);
  });

  it("surfaces HTTP, rate-limit, invalid JSON, malformed payload, and timeout failures", async () => {
    const cases: Array<{ result: Response; expected: string }> = [
      { result: response({}, false, 503), expected: "HTTP 503" },
      { result: response({}, false, 429), expected: "rate limited" },
      { result: { ok: true, status: 200, json: async () => { throw new Error("bad json"); } } as unknown as Response, expected: "invalid JSON" },
    ];
    for (const testCase of cases) {
      const source = new LeverJobSource({ site, fetcher: async () => testCase.result });
      await expect(source.discover(criteria, { now: capturedAt, maxResults: 5 })).rejects.toThrow(testCase.expected);
    }

    const malformed = new LeverJobSource({ site, fetcher: async () => response({ postings: [] }) });
    await expect(malformed.discover(criteria, { now: capturedAt, maxResults: 5 })).rejects.toThrow("postings array");

    const slow = new LeverJobSource({ site, fetcher: async () => new Promise<Response>(() => undefined) });
    const result = await new JobScout({ [slow.id]: slow }, () => capturedAt, { timeoutMs: 1 }).discover(activeCampaign([slow.id]));
    expect(result.sourceSummaries[0].status).toBe("failed");
    expect(result.failures[0].reason).toContain("timed out");
  });

  it("returns a successful empty result without fabricating postings", async () => {
    const source = new LeverJobSource({ site, fetcher: async () => response([]) });
    const result = await new JobScout({ [source.id]: source }, () => capturedAt).discover(activeCampaign([source.id]));
    expect(result.jobs).toHaveLength(0);
    expect(result.failures).toHaveLength(0);
    expect(result.sourceSummaries[0].status).toBe("empty");
  });

  it("keeps Remotive and Lever results isolated while preferring the actionable duplicate", async () => {
    const lever = new LeverJobSource({
      site,
      fetcher: async () => response([leverPosting({
        categories: { location: "Remote - United States", allLocations: ["Remote - United States"], commitment: "Full time" },
        workplaceType: "remote",
      })]),
    });
    const remotive = {
      id: "remotive-live",
      mode: "live" as const,
      discover: async (): Promise<readonly JobSourceListing[]> => [{
        sourceRecordId: "remotive-1",
        sourceMode: "live",
        input: {
          rawText: "Company: acme\nTitle: Platform Engineer\nLocation: Remote - United States\nRemote status: remote\nEmployment type: Full-time\nBuild and operate reliable platform services for product engineering teams.",
          sourceUrl: "https://remotive.com/remote-jobs/platform-engineer-1",
          companyHint: site,
          titleHint: "Platform Engineer",
        },
      }],
    };
    const result = await new JobScout({ [remotive.id]: remotive, [lever.id]: lever }, () => capturedAt).discover(activeCampaign([remotive.id, lever.id]));
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].sourceId).toBe(lever.id);
    expect(result.jobs[0].actionability).toBe("actionable");
    expect(result.jobs[0].sourceObservations).toHaveLength(2);
    expect(result.normalizedCount).toBe(2);
    expect(result.duplicateCount).toBe(1);
  });
});

function payload(postings: readonly Record<string, unknown>[]): unknown {
  return postings;
}
