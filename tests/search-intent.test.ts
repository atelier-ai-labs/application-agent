import { describe, expect, it } from "vitest";
import {
  applyHardFilters,
  buildBraveSearchQueries,
  createApplicationService,
  InMemoryApplicationRepository,
  InMemoryCareerRepository,
  isCampaign,
  JobScout,
  normalizeJobPosting,
  normalizeJobSearchIntent,
  planSearchIntentQueries,
  RemotiveJobSource,
  searchCriteriaFromJobSearchIntent,
  type Campaign,
  type DiscoveryContext,
  type JobSearchIntent,
  type JobSourceListing,
  type SearchCriteria,
} from "../application-agent/src";
import { CareerAgentService } from "../application-agent/src/service/careerAgentService";
import { exampleCandidateProfile } from "../application-agent/src/domain/profile";

const capturedAt = "2026-09-02T12:00:00.000Z";

const intent: JobSearchIntent = {
  primaryLanes: ["Platform Engineer", "Cloud Engineer"],
  adjacentLanes: ["AI Platform Engineer"],
  secondaryLanes: ["Software Engineer"],
  broadLanes: ["Production Engineer"],
  preferredSeniorities: ["mid-level"],
  excludedSeniorities: ["principal"],
  excludedTitleTerms: ["lead", "architect"],
  locations: ["United States"],
  remotePreference: "remote_preferred",
  employmentTypes: ["full time"],
  breadth: "balanced",
};

function response(value: unknown): Response {
  return { ok: true, status: 200, json: async () => value } as Response;
}

function remotiveJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 901,
    url: "https://remotive.com/remote-jobs/platform-engineer-901",
    title: "Platform Engineer",
    company_name: "Example Platform Co",
    category: "Software Development",
    tags: ["Kubernetes"],
    job_type: "full_time",
    publication_date: capturedAt,
    candidate_required_location: "USA",
    description: "Build platform services for an example engineering team.",
    ...overrides,
  };
}

function criteriaFor(value: JobSearchIntent = intent): SearchCriteria {
  return searchCriteriaFromJobSearchIntent(value);
}

function campaignFor(sourceId: string, value: JobSearchIntent = intent): Campaign {
  const criteria = criteriaFor(value);
  return {
    id: "search-intent-campaign",
    name: "Search intent test",
    goal: "Test provider-neutral discovery intent.",
    status: "active",
    searchIntent: normalizeJobSearchIntent(value),
    searchCriteria: criteria,
    searchSources: [sourceId],
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

function listing(query: string): JobSourceListing {
  return {
    sourceRecordId: "same-posting",
    searchQueries: [query],
    input: {
      isExample: true,
      companyHint: "Example Platform Co",
      titleHint: "Platform Engineer",
      sourceUrl: "https://jobs.example.invalid/platform-engineer",
      rawText: "Example Platform Co\nPlatform Engineer\nLocation: Remote\n\nBuild platform services for an example team.",
    },
  };
}

describe("typed job search intent", () => {
  it("selects only primary lanes at targeted breadth", () => {
    const targeted = normalizeJobSearchIntent({ ...intent, breadth: "targeted" });
    expect(planSearchIntentQueries(targeted)).toEqual([
      { lane: "primary", term: "Platform Engineer" },
      { lane: "primary", term: "Cloud Engineer" },
    ]);
  });

  it("includes primary, adjacent, and secondary lanes at balanced breadth", () => {
    const balanced = planSearchIntentQueries(normalizeJobSearchIntent(intent));
    expect(balanced.map((query) => query.term)).toEqual([
      "Platform Engineer",
      "Cloud Engineer",
      "AI Platform Engineer",
      "Software Engineer",
    ]);
    expect(balanced.map((query) => query.lane)).toEqual(["primary", "primary", "adjacent", "secondary"]);
  });

  it("spreads a bounded Brave plan across balanced lanes", () => {
    const balanced = normalizeJobSearchIntent(intent);
    const queries = buildBraveSearchQueries(
      criteriaFor(balanced),
      3,
      planSearchIntentQueries(balanced),
      balanced,
    );

    expect(queries).toEqual([
      "Platform Engineer remote United States jobs",
      "AI Platform Engineer remote United States jobs",
      "Software Engineer remote United States jobs",
    ]);
  });

  it("adds only configured neighboring lanes at broad breadth and remains bounded", () => {
    const broad = normalizeJobSearchIntent({
      ...intent,
      breadth: "broad",
      primaryLanes: ["Primary One", "Primary Two"],
      adjacentLanes: ["Adjacent One", "Adjacent Two"],
      secondaryLanes: ["Software Engineer"],
      broadLanes: ["Production Engineer", "Platform Developer"],
    });
    const queries = planSearchIntentQueries(broad);
    expect(queries).toHaveLength(7);
    expect(queries.some((query) => query.lane === "broad")).toBe(true);

    const bounded = normalizeJobSearchIntent({
      ...broad,
      primaryLanes: Array.from({ length: 12 }, (_, index) => `Primary ${index}`),
      adjacentLanes: Array.from({ length: 12 }, (_, index) => `Adjacent ${index}`),
      secondaryLanes: ["Software Engineer"],
    });
    expect(planSearchIntentQueries(bounded)).toHaveLength(24);
  });

  it("materializes intent into legacy source criteria without changing fit or submission policy", () => {
    const service = new CareerAgentService(exampleCandidateProfile, {
      careerRepository: new InMemoryCareerRepository(),
      applicationService: createApplicationService(exampleCandidateProfile, new InMemoryApplicationRepository()),
    });
    const targeted = service.createCampaign({
      name: "Targeted",
      goal: "Test targeted discovery",
      searchSources: ["synthetic"],
      searchIntent: normalizeJobSearchIntent({ ...intent, breadth: "targeted" }),
      submissionPolicy: { authority: "never", requireExplicitApproval: false },
    });
    const broad = service.createCampaign({
      name: "Broad",
      goal: "Test broad discovery",
      searchSources: ["synthetic"],
      searchIntent: normalizeJobSearchIntent({ ...intent, breadth: "broad" }),
      submissionPolicy: { authority: "never", requireExplicitApproval: false },
    });
    expect(targeted.searchCriteria.roleLanes).toEqual(["Platform Engineer", "Cloud Engineer"]);
    expect(broad.searchCriteria.roleLanes).toContain("Production Engineer");
    expect(targeted.submissionPolicy).toEqual(broad.submissionPolicy);

    expect(targeted.fitPolicy).toEqual(broad.fitPolicy);
    expect(isCampaign(targeted)).toBe(true);
  });

  it("uses whole title terms for hard exclusions and does not reject title verbs", () => {
    const criteria = criteriaFor({ ...intent, excludedSeniorities: ["lead"], excludedTitleTerms: ["lead"] });
    const excluded = normalizeJobPosting({
      isExample: true,
      companyHint: "Example Platform Co",
      titleHint: "Lead Platform Engineer",
      sourceUrl: "https://jobs.example.invalid/lead",
      rawText: "Example Platform Co\nLead Platform Engineer\nLocation: United States\nEmployment type: Full-time\n\nBuild platform services.",
    }, capturedAt);
    const allowed = normalizeJobPosting({
      isExample: true,
      companyHint: "Example Platform Co",
      titleHint: "Platform Engineer",
      sourceUrl: "https://jobs.example.invalid/platform",
      rawText: "Example Platform Co\nPlatform Engineer\nLocation: United States\nEmployment type: Full-time\n\nLead projects for an example team.",
    }, capturedAt);
    expect(applyHardFilters(excluded, criteria)).toMatchObject({ decision: "reject" });
    expect(applyHardFilters(allowed, criteria)).toMatchObject({ decision: "pass" });
  });

  it("keeps provider-specific limitations local while retaining matching query provenance", async () => {
    const urls: string[] = [];
    const source = new RemotiveJobSource({
      fetcher: async (input) => {
        urls.push(String(input));
        return response({ jobs: [remotiveJob()] });
      },
    });
    const searchIntent = normalizeJobSearchIntent({ ...intent, secondaryLanes: ["Frontend Engineer"] });
    const result = await source.discover(criteriaFor(searchIntent), {
      now: capturedAt,
      maxResults: 10,
      searchIntent,
      searchPlan: planSearchIntentQueries(searchIntent),
    });
    expect(new URL(urls[0]).searchParams.has("search")).toBe(false);
    expect(result.listings[0].searchQueries).toContain("Platform Engineer");
    expect(result.listings[0].searchQueries).not.toContain("Frontend Engineer");
  });

  it("deduplicates jobs from multiple searches and preserves query provenance", async () => {
    let receivedIntent: JobSearchIntent | undefined;
    let receivedPlan: readonly { lane: string; term: string }[] | undefined;
    const source = {
      id: "synthetic-search-source",
      mode: "demo" as const,
      discover: async (_criteria: SearchCriteria, context?: DiscoveryContext): Promise<readonly JobSourceListing[]> => {
        receivedIntent = context?.searchIntent;
        receivedPlan = context?.searchPlan;
        return [listing("Platform Engineer"), listing("Cloud Engineer")];
      },
    };
    const result = await new JobScout({ [source.id]: source }, () => capturedAt).discover(campaignFor(source.id));
    expect(result.jobs).toHaveLength(1);
    expect(result.duplicateCount).toBe(1);
    expect(result.jobs[0].sourceObservations[0].searchQueries).toEqual(["Platform Engineer", "Cloud Engineer"]);
    expect(receivedIntent?.breadth).toBe("balanced");
    expect(receivedPlan?.map((query) => query.term)).toEqual([
      "Platform Engineer",
      "Cloud Engineer",
      "AI Platform Engineer",
      "Software Engineer",
    ]);
  });

  it("builds bounded Brave searches from the intent plan and carries remote/location context", () => {
    const normalized = normalizeJobSearchIntent(intent);
    const queries = buildBraveSearchQueries(
      criteriaFor(normalized),
      3,
      planSearchIntentQueries(normalized),
      normalized,
    );
    expect(queries).toHaveLength(3);
    expect(queries.every((query) => /remote/i.test(query))).toBe(true);
    expect(queries.every((query) => /United States/i.test(query))).toBe(true);
  });

  it("accepts portable synthetic configuration without provider-specific syntax", () => {
    const normalized = normalizeJobSearchIntent({
      primaryLanes: ["Example Platform Engineer"],
      adjacentLanes: ["Example AI Engineer"],
      secondaryLanes: ["Example Software Engineer"],
      preferredSeniorities: ["associate"],
      excludedSeniorities: ["principal"],
      excludedTitleTerms: ["director"],
      locations: ["Example Country"],
      remotePreference: "any",
      employmentTypes: [],
      breadth: "balanced",
    });
    expect(normalized.primaryLanes).toEqual(["Example Platform Engineer"]);
    expect(planSearchIntentQueries(normalized)).toHaveLength(3);
  });
});
