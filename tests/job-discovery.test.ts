import { describe, expect, it } from "vitest";
import {
  GreenhouseJobSource,
  JobReferenceResolver,
  JobReferenceSource,
  JobScout,
  normalizeJobPosting,
  isVerifiedGreenhouseApplicationUrl,
  StaticJobDiscoveryProvider,
  type Campaign,
  type DiscoveredJobReference,
  type JobDiscoveryProvider,
  type JobSourceListing,
  type SearchCriteria,
} from "../application-agent/src";

const now = "2026-08-31T12:00:00.000Z";
const criteria: SearchCriteria = {
  roleLanes: ["engineer"],
  searchQueries: ["platform"],
  locations: [],
  remoteOnly: false,
  employmentTypes: [],
  excludedSeniorities: [],
  excludedCompanies: [],
};

function campaign(sourceIds: readonly string[]): Campaign {
  return {
    id: "reference-campaign",
    name: "Reference campaign",
    goal: "Resolve discovered references through structured sources.",
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
    createdAt: now,
    updatedAt: now,
  };
}

const reference: DiscoveredJobReference = {
  discoveredUrl: "https://boards.greenhouse.io/acme/jobs/123456",
  titleHint: "Platform Engineer",
  companyHint: "Acme Corp",
  sourceProvider: "fixture-discovery",
  discoveredAt: now,
  evidence: ["fixture"],
};

function greenhouseResponse() {
  return {
    jobs: [{
      id: 123456,
      title: "Platform Engineer",
      absolute_url: reference.discoveredUrl,
      location: { name: "Remote - United States" },
      content: "Build dependable platform systems for product engineering teams.",
      updated_at: now,
    }],
  };
}

function greenhouseSource(options: { id?: string; onFetch?: () => void } = {}) {
  return new GreenhouseJobSource({
    board: "acme",
    company: "Acme Corp",
    ...(options.id ? { id: options.id } : {}),
    fetcher: async () => {
      options.onFetch?.();
      return { ok: true, status: 200, json: async () => greenhouseResponse() } as Response;
    },
  });
}

function liveReferenceProvider(references: readonly DiscoveredJobReference[]): JobDiscoveryProvider {
  return {
    id: "live-reference-fixture",
    mode: "live",
    discover: async () => references,
  };
}

describe("bounded discovery references and ATS routing", () => {
  it("validates discovery references, isolates malformed entries, and applies a cap", async () => {
    const provider = new StaticJobDiscoveryProvider("fixture-discovery", [
      reference,
      { ...reference, discoveredUrl: "not-a-url" },
      { ...reference, discoveredUrl: "https://boards.greenhouse.io/acme/jobs/999999" },
    ]);
    const result = await provider.discover(criteria, { now, maxResults: 1 });
    expect(result.references).toHaveLength(1);
    expect(result.references[0].sourceProvider).toBe("fixture-discovery");
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("malformed"),
      expect.stringContaining("result cap"),
    ]));
  });

  it("routes a Greenhouse reference through the configured structured adapter", async () => {
    const source = greenhouseSource({ id: "watch:acme" });
    const resolver = new JobReferenceResolver({ [source.id]: source });
    const resolved = await resolver.resolve(reference, criteria, { now, maxResults: 10 });
    expect(resolved.status).toBe("resolved");
    expect(resolved.sourceId).toBe("watch:acme");
    expect(resolved.listing?.sourceRecordId).toBe("123456");
    expect(resolved.listing?.input.applicationUrl).toBe(reference.discoveredUrl);
    expect(isVerifiedGreenhouseApplicationUrl(resolved.listing?.input.applicationUrl, "acme", "123456")).toBe(true);
    expect(source.classifyActionability(
      normalizeJobPosting(resolved.listing!.input, now),
      { ...resolved.listing!, sourceMode: "live" },
    )).toBe("actionable");

    const referenceSource = new JobReferenceSource(
      liveReferenceProvider([reference]),
      resolver,
    );
    const result = await new JobScout({ [referenceSource.id]: referenceSource }, () => now)
      .discover(campaign([referenceSource.id]));
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].sourceId).toBe("watch:acme");
    expect(result.jobs[0].actionability).toBe("actionable");
    expect(result.referenceMetrics).toMatchObject({
      referencesDiscovered: 1,
      knownAtsReferences: 1,
      greenhouseReferences: 1,
      structuredJobsResolved: 1,
    });
  });

  it("routes a Lever reference through the existing structured adapter boundary", async () => {
    const leverUrl = "https://jobs.lever.co/acme/lever-123/apply";
    const source = {
      id: "lever:acme",
      mode: "live" as const,
      site: "acme",
      discover: async (): Promise<readonly JobSourceListing[]> => [{
        sourceRecordId: "lever-123",
        sourceMode: "live",
        input: {
          rawText: "Company: Acme Corp\nTitle: Platform Engineer\nLocation: Remote - United States\nBuild dependable platform infrastructure for an engineering team.",
          sourceUrl: "https://jobs.lever.co/acme/lever-123",
          applicationUrl: leverUrl,
          companyHint: "Acme Corp",
          titleHint: "Platform Engineer",
        },
      }],
      classifyActionability: () => "actionable" as const,
    };
    const resolved = await new JobReferenceResolver({ [source.id]: source }).resolve(
      { ...reference, discoveredUrl: leverUrl },
      criteria,
      { now, maxResults: 10 },
    );
    expect(resolved).toMatchObject({
      status: "resolved",
      sourceId: "lever:acme",
      classification: { kind: "lever", siteIdentifier: "acme", postingIdentifier: "lever-123" },
      listing: { sourceRecordId: "lever-123" },
    });
  });

  it("returns explicit resolution states for unsupported, custom, and invalid references", async () => {
    const resolver = new JobReferenceResolver([]);
    const cases: Array<{ url: string; status: string }> = [
      { url: "https://jobs.ashbyhq.com/acme/platform-engineer", status: "known_unsupported" },
      { url: "https://acme.wd5.myworkdayjobs.com/en-US/acme/job/platform", status: "known_unsupported" },
      { url: "https://acme.example/careers/platform", status: "fallback_required" },
      { url: "not-a-url", status: "invalid" },
    ];
    for (const testCase of cases) {
      const value: DiscoveredJobReference = { ...reference, discoveredUrl: testCase.url };
      const result = await resolver.resolve(value, criteria, { now, maxResults: 10 });
      expect(result.status).toBe(testCase.status);
      expect(result.reason).toBeTruthy();
    }
  });

  it("keeps duplicate references out of the resolved source and retains source metrics", async () => {
    let fetchCount = 0;
    const source = greenhouseSource({ onFetch: () => { fetchCount += 1; } });
    const resolver = new JobReferenceResolver({ [source.id]: source });
    const provider = new StaticJobDiscoveryProvider("fixture-discovery", [
      reference,
      { ...reference, discoveredUrl: `${reference.discoveredUrl}?utm_source=search` },
    ]);
    const liveProvider = liveReferenceProvider(await provider.discover(criteria, { now, maxResults: 10 }).then((result) => result.references));
    const referenceSource = new JobReferenceSource(liveProvider, resolver);
    const result = await new JobScout({ [referenceSource.id]: referenceSource }, () => now)
      .discover(campaign([referenceSource.id]));
    expect(result.jobs).toHaveLength(1);
    expect(result.referenceMetrics?.duplicatesRemoved).toBe(1);
    expect(fetchCount).toBe(1);
  });
});
