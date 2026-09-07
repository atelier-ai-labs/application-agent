// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyHardFilters,
  assessFit,
  buildHimalayasSearchRequests,
  createApplicationService,
  createLiveCampaignInput,
  exampleCandidateProfile,
  HimalayasJobSource,
  HIMALAYAS_SOURCE_ID,
  InMemoryApplicationRepository,
  InMemoryCareerRepository,
  JobScout,
  normalizeJobPosting,
  normalizeJobSearchIntent,
  parseHimalayasResponse,
  planSearchIntentQueries,
  type Campaign,
  type JobSourceListing,
  type JobSearchIntent,
  type SearchCriteria,
} from "../application-agent/src";
import { CareerAgentService } from "../application-agent/src/service/careerAgentService";

const capturedAt = "2026-09-03T12:00:00.000Z";
const endpoint = "https://himalayas.example/jobs/api/search";

const intent: JobSearchIntent = normalizeJobSearchIntent({
  primaryLanes: ["Platform Engineer", "Cloud Engineer"],
  adjacentLanes: ["AI Platform Engineer"],
  secondaryLanes: ["Software Engineer"],
  preferredSeniorities: ["junior", "associate", "mid-level"],
  excludedSeniorities: ["senior"],
  excludedTitleTerms: ["architect"],
  locations: ["United States", "US", "USA"],
  remotePreference: "remote_preferred",
  employmentTypes: ["full time"],
  breadth: "balanced",
});

const criteria: SearchCriteria = {
  roleLanes: ["Platform Engineer", "Cloud Engineer", "AI Platform Engineer", "Software Engineer"],
  searchQueries: ["Platform Engineer", "Cloud Engineer", "AI Platform Engineer", "Software Engineer"],
  locations: ["United States", "US", "USA"],
  remoteOnly: false,
  employmentTypes: ["full time"],
  excludedSeniorities: ["senior"],
  excludedTitleTerms: ["architect"],
  excludedCompanies: [],
};

function response(value: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => value } as Response;
}

function himalayasJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Platform Engineer",
    excerpt: "Build reliable cloud platform systems.",
    companyName: "Example Platform Co",
    companySlug: "example-platform-co",
    companyLogo: "https://cdn.example.com/logo.png",
    employmentType: "Full Time",
    seniority: ["Mid-level"],
    currency: "USD",
    salaryPeriod: "annual",
    minSalary: 120000,
    maxSalary: 150000,
    locationRestrictions: [{ alpha2: "US", name: "United States", slug: "united-states" }],
    timezoneRestrictions: ["UTC-5", "UTC-4"],
    categories: ["DevOps", "Infrastructure"],
    parentCategories: ["Engineering"],
    description: "<p>Build and operate reliable platform services.</p><p>Required qualifications: Kubernetes and Terraform.</p>",
    pubDate: Date.parse("2026-09-03T08:00:00.000Z"),
    expiryDate: Date.parse("2026-10-03T08:00:00.000Z"),
    applicationLink: "https://jobs.example.com/platform-engineer/apply",
    guid: "himalayas-guid-1",
    ...overrides,
  };
}

function payload(jobs: readonly Record<string, unknown>[]): unknown {
  return {
    updatedAt: Date.parse("2026-09-03T00:00:00.000Z"),
    limit: 20,
    totalCount: jobs.length,
    jobs,
  };
}

function activeCampaign(sourceIds: readonly string[], searchIntent?: JobSearchIntent): Campaign {
  return {
    id: "himalayas-campaign",
    name: "Himalayas source test",
    goal: "Test bounded discovery only.",
    status: "active",
    ...(searchIntent ? { searchIntent } : {}),
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

describe("Himalayas live JobSource", () => {
  it("normalizes official fields, preserves GUID/provenance, and remains discovery-only", async () => {
    const source = new HimalayasJobSource({
      endpoint,
      maxQueries: 1,
      fetcher: async () => response(payload([himalayasJob()])),
    });
    const result = await source.discover(criteria, {
      now: capturedAt,
      maxResults: 20,
      searchIntent: intent,
      searchPlan: [{ lane: "primary", term: "Platform Engineer" }],
    });
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]).toMatchObject({
      sourceRecordId: "himalayas-guid-1",
      sourceMode: "live",
      sourcePublishedAt: "2026-09-03T08:00:00.000Z",
      sourceExpiresAt: "2026-10-03T08:00:00.000Z",
      searchQueries: ["Platform Engineer"],
      input: {
        sourceUrl: "https://jobs.example.com/platform-engineer/apply",
        applicationUrl: "https://jobs.example.com/platform-engineer/apply",
        isExample: false,
      },
    });
    expect(result.listings[0].input.rawText).not.toContain("<p>");

    const scouted = await new JobScout({ [source.id]: source }, () => capturedAt)
      .discover(activeCampaign([HIMALAYAS_SOURCE_ID], intent));
    expect(scouted.jobs[0]).toMatchObject({
      sourceId: HIMALAYAS_SOURCE_ID,
      sourceRecordId: "himalayas-guid-1",
      sourceExpiresAt: "2026-10-03T08:00:00.000Z",
      actionability: "discoverable_only",
      job: {
        company: "Example Platform Co",
        title: "Platform Engineer",
        location: "United States",
        remoteStatus: "remote",
        employmentType: "full time",
        seniority: "Mid-level",
        compensation: { minimum: 120000, maximum: 150000, currency: "USD", period: "annual" },
        applicationUrl: "https://jobs.example.com/platform-engineer/apply",
      },
    });
    expect(scouted.jobs[0].sourceObservations[0]).toMatchObject({
      sourceId: HIMALAYAS_SOURCE_ID,
      sourceRecordId: "himalayas-guid-1",
      sourcePublishedAt: "2026-09-03T08:00:00.000Z",
      sourceExpiresAt: "2026-10-03T08:00:00.000Z",
    });
  });

  it("accepts the observed official production variants for locations, timezones, and Unix-second dates", () => {
    const result = parseHimalayasResponse(payload([himalayasJob({
      locationRestrictions: ["United States"],
      timezoneRestrictions: [-5, -4, 14],
      pubDate: 1788439415,
      expiryDate: 1793623414,
    })]), capturedAt);
    expect(result.warnings).toBeUndefined();
    const listing = result.listings[0];
    expect(listing).toMatchObject({
      sourcePublishedAt: "2026-09-03T12:43:35.000Z",
      sourceExpiresAt: "2026-11-02T12:43:34.000Z",
    });
    const job = normalizeJobPosting(listing.input, capturedAt);
    expect(job.location).toBe("United States");
    expect(job.description).toContain("Timezone: UTC-5, UTC-4, UTC+14");
  });

  it("translates bounded SearchIntent lanes, US aliases, preferred seniority, and employment type", () => {
    const requests = buildHimalayasSearchRequests(
      endpoint,
      criteria,
      planSearchIntentQueries(intent),
      intent,
    );
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.term)).toEqual([
      "Platform Engineer",
      "AI Platform Engineer",
      "Software Engineer",
    ]);
    for (const request of requests) {
      const url = new URL(request.url);
      expect(url.searchParams.get("q")).toBe(request.term);
      expect(url.searchParams.get("country")).toBe("US");
      expect(url.searchParams.get("seniority")).toBe("Entry-level,Mid-level");
      expect(url.searchParams.get("employment_type")).toBe("Full Time");
      expect(url.searchParams.get("sort")).toBe("recent");
      expect(url.searchParams.get("page")).toBe("1");
      expect(url.searchParams.has("worldwide")).toBe(false);
    }
  });

  it("translates explicit worldwide eligibility without inventing a country", () => {
    const requests = buildHimalayasSearchRequests(endpoint, {
      ...criteria,
      locations: ["Worldwide"],
    }, [{ lane: "primary", term: "Platform Engineer" }], intent, 1);
    const url = new URL(requests[0].url);
    expect(url.searchParams.has("country")).toBe(false);
    expect(url.searchParams.get("worldwide")).toBe("true");
  });

  it("keeps seniority filtering local after provider translation, including multi-level records", () => {
    const listing = parseHimalayasResponse(payload([himalayasJob({ seniority: ["Mid-level", "Senior"] })]), capturedAt).listings[0];
    const job = normalizeJobPosting(listing.input, capturedAt);
    expect(job.seniority).toBe("Mid-level, Senior");
    expect(applyHardFilters(job, { ...criteria, excludedSeniorities: ["senior"] })).toMatchObject({ decision: "reject" });
  });

  it("preserves usable records when optional fields or the application link are absent", () => {
    const result = parseHimalayasResponse(payload([himalayasJob({
      excerpt: undefined,
      employmentType: undefined,
      seniority: undefined,
      minSalary: null,
      maxSalary: null,
      currency: undefined,
      salaryPeriod: undefined,
      locationRestrictions: undefined,
      timezoneRestrictions: undefined,
      categories: undefined,
      parentCategories: undefined,
      pubDate: undefined,
      expiryDate: undefined,
      applicationLink: undefined,
    })]), capturedAt);
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0].sourceRecordId).toBe("himalayas-guid-1");
    expect(result.listings[0].input.sourceUrl).toBeUndefined();
    expect(result.listings[0].input.applicationUrl).toBeUndefined();
    const job = normalizeJobPosting(result.listings[0].input, capturedAt);
    expect(job.remoteStatus).toBe("remote");
    expect(job.location).toBeUndefined();
    expect(job.employmentType).toBeUndefined();
    expect(job.compensation).toBeUndefined();
    expect(job.seniority).toBeUndefined();
  });

  it("skips invalid optional URLs with a warning and retains the discovery record", () => {
    const result = parseHimalayasResponse(payload([himalayasJob({ applicationLink: "javascript:alert(1)" })]), capturedAt);
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0].input.applicationUrl).toBeUndefined();
    expect(result.warnings?.some((warning) => warning.includes("applicationLink"))).toBe(true);
  });

  it("reports malformed payloads, HTTP errors, 429, invalid JSON, and timeout deterministically", async () => {
    const malformed = new HimalayasJobSource({ endpoint, maxQueries: 1, fetcher: async () => response({ jobs: {} }) });
    await expect(malformed.discover(criteria, { now: capturedAt, maxResults: 20 })).rejects.toThrow("jobs array");

    const invalidJson = new HimalayasJobSource({
      endpoint,
      maxQueries: 1,
      fetcher: async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } } as unknown as Response),
    });
    await expect(invalidJson.discover(criteria, { now: capturedAt, maxResults: 20 })).rejects.toThrow("invalid JSON");

    const rateLimited = new HimalayasJobSource({ endpoint, maxQueries: 1, fetcher: async () => response({}, false, 429) });
    await expect(rateLimited.discover(criteria, { now: capturedAt, maxResults: 20 })).rejects.toThrow("60 seconds");

    const serverError = new HimalayasJobSource({ endpoint, maxQueries: 1, fetcher: async () => response({}, false, 503) });
    await expect(serverError.discover(criteria, { now: capturedAt, maxResults: 20 })).rejects.toThrow("HTTP 503");

    const timeout = new HimalayasJobSource({
      endpoint,
      maxQueries: 1,
      timeoutMs: 1,
      fetcher: async () => new Promise<Response>(() => undefined),
    });
    await expect(timeout.discover(criteria, { now: capturedAt, maxResults: 20 })).rejects.toThrow("timed out");
  });

  it("returns empty results without turning a normal zero-result search into a failure", async () => {
    const source = new HimalayasJobSource({ endpoint, maxQueries: 1, fetcher: async () => response(payload([])) });
    const result = await new JobScout({ [source.id]: source }, () => capturedAt)
      .discover(activeCampaign([source.id]));
    expect(result.jobs).toHaveLength(0);
    expect(result.failures).toHaveLength(0);
    expect(result.sourceSummaries[0].status).toBe("empty");
  });

  it("deduplicates repeated GUIDs across lane requests and retains query provenance", async () => {
    let calls = 0;
    const source = new HimalayasJobSource({
      endpoint,
      fetcher: async () => {
        calls += 1;
        return response(payload([himalayasJob()]));
      },
    });
    const result = await new JobScout({ [source.id]: source }, () => capturedAt)
      .discover(activeCampaign([source.id], intent));
    expect(calls).toBe(3);
    expect(result.receivedCount).toBe(3);
    expect(result.normalizedCount).toBe(3);
    expect(result.duplicateCount).toBe(2);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].sourceObservations[0].searchQueries).toEqual([
      "Platform Engineer",
      "AI Platform Engineer",
      "Software Engineer",
    ]);
  });

  it("cross-deduplicates a canonical Himalayas application URL with another live provider", async () => {
    const sharedUrl = "https://jobs.example.com/shared/apply";
    const himalayas = new HimalayasJobSource({
      endpoint,
      maxQueries: 1,
      fetcher: async () => response(payload([himalayasJob({ applicationLink: sharedUrl })])),
    });
    const remotive: JobSourceListing = {
      sourceRecordId: "remotive-shared",
      sourceMode: "live",
      input: {
        rawText: "Company: Example Platform Co\nTitle: Platform Engineer\nLocation: United States\nRemote status: remote\nEmployment type: Full-time\nBuild and operate reliable platform services.",
        sourceUrl: "https://remotive.com/remote-jobs/platform-engineer-shared",
        applicationUrl: sharedUrl,
        companyHint: "Example Platform Co",
        titleHint: "Platform Engineer",
      },
    };
    const remotiveSource = {
      id: "remotive-live",
      mode: "live" as const,
      discover: async () => [remotive],
    };
    const result = await new JobScout({
      [remotiveSource.id]: remotiveSource,
      [himalayas.id]: himalayas,
    }, () => capturedAt).discover(activeCampaign([remotiveSource.id, himalayas.id]));
    expect(result.jobs).toHaveLength(1);
    expect(result.duplicateCount).toBe(1);
    expect(result.jobs[0].sourceObservations.map((observation) => observation.sourceId)).toEqual([
      "remotive-live",
      HIMALAYAS_SOURCE_ID,
    ]);
  });

  it("does not change fit thresholds or application authority", () => {
    const campaignInput = createLiveCampaignInput([], [], false, intent, true);
    expect(campaignInput.searchSources).toEqual(["remotive-live", HIMALAYAS_SOURCE_ID]);
    expect(campaignInput.sourceConfigs).toEqual([
      { type: "remotive", id: "remotive-live" },
      { type: "himalayas", id: HIMALAYAS_SOURCE_ID },
    ]);
    expect(campaignInput.submissionPolicy).toEqual({ authority: "never", requireExplicitApproval: false });

    const job = normalizeJobPosting({
      companyHint: "Example Platform Co",
      titleHint: "Platform Engineer",
      sourceUrl: "https://jobs.example.com/platform",
      rawText: "Example Platform Co\nPlatform Engineer\nLocation: United States\nRemote status: remote\nBuild reliable platform systems with Kubernetes.",
    }, capturedAt);
    const before = assessFit(job, exampleCandidateProfile);
    const after = assessFit(job, exampleCandidateProfile);
    expect(after).toEqual(before);
  });

  it("keeps the Himalayas request path out of browser/client code", () => {
    const clientFiles = [
      "application-agent/src/ui/useCareerAgentWorkspace.ts",
      "application-agent/src/ui/CareerAgentPage.tsx",
    ];
    for (const file of clientFiles) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/himalayas\.app\/jobs\/api|HimalayasJobSource|createHimalayasJobSource/);
    }
    const runtime = readFileSync("application-agent/automation/runtime/careerAgentRuntime.ts", "utf8");
    expect(runtime).toContain("createHimalayasJobSource");
  });
});
