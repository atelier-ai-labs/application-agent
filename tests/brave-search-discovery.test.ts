import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  BRAVE_SEARCH_DISCOVERY_ID,
  BraveSearchDiscoveryProvider,
  HttpJobDiscoveryProvider,
  JobReferenceResolver,
  JobReferenceSource,
  JobScout,
  StaticJobSource,
  buildBraveSearchQueries,
  discoveryCoverageRatios,
  isObviousNonJobReference,
  normalizeJobPosting,
  type ApplicationExecutor,
  type Campaign,
  type DiscoveredJobReference,
  type JobDiscoveryProvider,
  type JobSource,
  type JobSourceListing,
  type SearchCriteria,
} from "../application-agent/src";
import { createExecutionHostServer } from "../application-agent/automation/executionHost/server";

const now = "2026-08-31T12:00:00.000Z";

const criteria: SearchCriteria = {
  roleLanes: ["engineer"],
  searchQueries: ["cloud engineering", "React"],
  locations: [],
  remoteOnly: true,
  employmentTypes: [],
  excludedSeniorities: [],
  excludedCompanies: [],
};

function response(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

function bravePayload(results: readonly Record<string, unknown>[]) {
  return { type: "search", web: { type: "search", results } };
}

function campaign(sourceIds: readonly string[]): Campaign {
  return {
    id: "broad-discovery-campaign",
    name: "Broad discovery test",
    goal: "Measure structured ATS coverage without scraping.",
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

function listing(
  sourceId: string,
  sourceRecordId: string,
  sourceUrl: string,
  applicationUrl: string,
  company: string,
  title: string,
): JobSourceListing {
  return {
    sourceId,
    sourceRecordId,
    sourceMode: "live",
    actionability: "actionable",
    input: {
      rawText: `${company}\n${title}\nLocation: Remote\nBuild dependable platform systems.`,
      sourceUrl,
      applicationUrl,
      companyHint: company,
      titleHint: title,
      isExample: false,
    },
    discoveredAt: now,
  };
}

function fakeStructuredSource(
  id: string,
  siteOrBoard: "site" | "board",
  value: string,
  result: JobSourceListing,
): JobSource {
  return {
    id,
    mode: "live",
    ...(siteOrBoard === "site" ? { site: value } : { board: value }),
    discover: async () => [result],
    classifyActionability: () => "actionable",
  } as JobSource;
}

describe("bounded Brave broad discovery", () => {
  it("maps campaign criteria into a small deterministic query set", () => {
    expect(buildBraveSearchQueries(criteria, 2)).toEqual([
      "cloud engineering remote jobs",
      "React remote jobs",
    ]);
    expect(buildBraveSearchQueries({ ...criteria, searchQueries: [], roleLanes: ["platform"] }, 1)).toEqual([
      "platform remote jobs",
    ]);
  });

  it("normalizes URL-first results, removes obvious noise, and records query evidence", async () => {
    const requested: Array<{ url: string; headers: HeadersInit | undefined }> = [];
    const provider = new BraveSearchDiscoveryProvider({
      apiKey: "test-key",
      maxQueries: 2,
      maxResultsPerQuery: 3,
      maxTotalReferences: 20,
      now: () => now,
      fetcher: async (input, init) => {
        requested.push({ url: String(input), headers: init?.headers });
        return response(bravePayload([
          { title: "Cloud Platform Engineer", url: "https://jobs.lever.co/acme/cloud-1?utm_source=search" },
          { title: "Platform Engineer", url: "https://boards.greenhouse.io/acme/jobs/123" },
          { title: "Cloud engineering news", url: "https://news.example.test/cloud-engineering" },
        ]));
      },
    });

    const result = await provider.discover(criteria, { now, maxResults: 20 });
    expect(requested).toHaveLength(2);
    expect(new Headers(requested[0].headers).get("X-Subscription-Token")).toBe("test-key");
    expect(new URL(requested[0].url).searchParams.get("q")).toBe("cloud engineering remote jobs");
    expect(result.status).toBe("success");
    expect(result.references).toHaveLength(2);
    expect(result.references[0]).toMatchObject({
      discoveredUrl: "https://jobs.lever.co/acme/cloud-1",
      titleHint: "Cloud Platform Engineer",
      sourceProvider: BRAVE_SEARCH_DISCOVERY_ID,
      discoveredAt: now,
      query: "cloud engineering remote jobs",
    });
    expect(result.references[0].companyHint).toBeUndefined();
    expect(result.metrics).toMatchObject({
      providerResults: 6,
      acceptedReferences: 2,
      rejectedReferences: 2,
      duplicateReferences: 2,
      queriesExecuted: 2,
    });
    expect(result.metrics?.queryMetrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ query: "cloud engineering remote jobs", providerResults: 3, acceptedReferences: 2 }),
      expect.objectContaining({ query: "React remote jobs", providerResults: 3, acceptedReferences: 0, duplicateReferences: 2 }),
    ]));
  });

  it("isolates malformed results, applies the cycle cap, and never invents company hints", async () => {
    const provider = new BraveSearchDiscoveryProvider({
      apiKey: "test-key",
      maxQueries: 1,
      maxResultsPerQuery: 10,
      maxTotalReferences: 1,
      now: () => now,
      fetcher: async () => response(bravePayload([
        { url: "https://company.example.test/careers/platform-engineer" },
        { title: "Broken result" },
        { title: "Not a job", url: "not-a-url" },
        { title: "Company home", url: "https://company.example.test/" },
      ])),
    });
    const result = await provider.discover({ ...criteria, searchQueries: ["platform"] }, { now, maxResults: 10 });
    expect(result.references).toHaveLength(1);
    expect(result.references[0].titleHint).toBeUndefined();
    expect(result.warnings?.join(" ")).toContain("malformed");
    expect(result.warnings?.join(" ")).toContain("cycle cap");
    expect(result.metrics).toMatchObject({ providerResults: 4, acceptedReferences: 1, rejectedReferences: 3 });
  });

  it("reports missing credentials without making a network request", async () => {
    let calls = 0;
    const provider = new BraveSearchDiscoveryProvider({
      fetcher: async () => {
        calls += 1;
        return response({});
      },
    });
    const result = await provider.discover(criteria, { now, maxResults: 10 });
    expect(result.status).toBe("not_configured");
    expect(result.reason).toContain("API key");
    expect(result.references).toEqual([]);
    expect(result.metrics?.queriesExecuted).toBe(0);
    expect(calls).toBe(0);
  });

  it("reuses a fresh response without presenting it as newly fetched", async () => {
    let calls = 0;
    const provider = new BraveSearchDiscoveryProvider({
      apiKey: "test-key",
      maxQueries: 1,
      maxResultsPerQuery: 2,
      cacheTtlMs: 60_000,
      now: () => now,
      fetcher: async () => {
        calls += 1;
        return response(bravePayload([{ title: "Platform Engineer", url: "https://jobs.lever.co/acme/platform-1" }]));
      },
    });
    const first = await provider.discover({ ...criteria, searchQueries: ["platform"] }, { now, maxResults: 1 });
    const second = await provider.discover({ ...criteria, searchQueries: ["platform"] }, { now, maxResults: 1 });
    expect(calls).toBe(1);
    expect(first.cached).toBeUndefined();
    expect(first.sourceFetchedAt).toBe(now);
    expect(second.cached).toBe(true);
    expect(second.sourceFetchedAt).toBe(now);
    expect(second.references).toEqual(first.references);
  });

  it("handles zero results, malformed payloads, authorization, rate limits, and timeouts honestly", async () => {
    const empty = new BraveSearchDiscoveryProvider({
      apiKey: "test-key",
      now: () => now,
      fetcher: async () => response(bravePayload([])),
    });
    await expect(empty.discover(criteria, { now, maxResults: 10 })).resolves.toMatchObject({ status: "empty", references: [] });

    for (const status of [401, 403, 429]) {
      const provider = new BraveSearchDiscoveryProvider({
        apiKey: "test-key",
        now: () => now,
        fetcher: async () => response({}, status),
      });
      const result = await provider.discover(criteria, { now, maxResults: 10 });
      expect(result.status).toBe("failed");
      expect(result.warnings?.[0]).toContain(status === 429 ? "rate limit" : "authorization");
    }

    const malformed = new BraveSearchDiscoveryProvider({
      apiKey: "test-key",
      now: () => now,
      fetcher: async () => response({ web: {} }),
    });
    await expect(malformed.discover(criteria, { now, maxResults: 10 })).resolves.toMatchObject({ status: "failed" });

    const timeout = new BraveSearchDiscoveryProvider({
      apiKey: "test-key",
      timeoutMs: 5,
      now: () => now,
      fetcher: async () => new Promise<Response>(() => undefined),
    });
    const timedOut = await timeout.discover({ ...criteria, searchQueries: ["platform"] }, { now, maxResults: 10 });
    expect(timedOut.status).toBe("failed");
    expect(timedOut.warnings?.[0]).toContain("timed out");
  });

  it("reports a partial cycle when one bounded query fails and preserves the healthy query", async () => {
    const provider = new BraveSearchDiscoveryProvider({
      apiKey: "test-key",
      maxQueries: 2,
      now: () => now,
      fetcher: async (input) => {
        const query = new URL(String(input)).searchParams.get("q") ?? "";
        if (query.startsWith("React")) throw new Error("provider temporarily unavailable");
        return response(bravePayload([{ title: "Cloud Platform Engineer", url: "https://boards.greenhouse.io/acme/jobs/123" }]));
      },
    });
    const result = await provider.discover(criteria, { now, maxResults: 10 });
    expect(result.status).toBe("partial");
    expect(result.references).toHaveLength(1);
    expect(result.metrics?.queryMetrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "success", acceptedReferences: 1 }),
      expect.objectContaining({ status: "failed", acceptedReferences: 0 }),
    ]));
  });

  it("keeps the quality filter explainable and retains employer career pages", () => {
    expect(isObviousNonJobReference({ title: "Example Careers", url: "https://example.test/" })).toBe(false);
    expect(isObviousNonJobReference({ title: "Example engineering news", url: "https://example.test/careers/platform" })).toBe(true);
    expect(isObviousNonJobReference({ title: "Platform Engineer", url: "https://boards.greenhouse.io/acme/jobs/123" })).toBe(false);
    expect(isObviousNonJobReference({ title: "Social result", url: "https://www.linkedin.com/jobs/view/123" })).toBe(true);
  });
});

describe("broad reference routing and coverage metrics", () => {
  const lever = fakeStructuredSource(
    "lever:acme",
    "site",
    "acme",
    listing("lever:acme", "lever-1", "https://jobs.lever.co/acme/lever-1", "https://jobs.lever.co/acme/lever-1/apply", "Acme", "Cloud Platform Engineer"),
  );
  const greenhouse = fakeStructuredSource(
    "greenhouse:acme",
    "board",
    "acme",
    listing("greenhouse:acme", "123", "https://boards.greenhouse.io/acme/jobs/123", "https://boards.greenhouse.io/acme/jobs/123", "Acme", "Platform Engineer"),
  );

  it("routes Lever and Greenhouse while retaining unsupported/fallback classifications", async () => {
    const references: DiscoveredJobReference[] = [
      { discoveredUrl: "https://jobs.lever.co/acme/lever-1", sourceProvider: "fixture", discoveredAt: now },
      { discoveredUrl: "https://boards.greenhouse.io/acme/jobs/123", sourceProvider: "fixture", discoveredAt: now },
      { discoveredUrl: "https://jobs.ashbyhq.com/acme/platform", sourceProvider: "fixture", discoveredAt: now },
      { discoveredUrl: "https://acme.wd5.myworkdayjobs.com/en-US/acme/job/platform", sourceProvider: "fixture", discoveredAt: now },
      { discoveredUrl: "https://acme.example.test/careers/platform", sourceProvider: "fixture", discoveredAt: now },
    ];
    const provider: JobDiscoveryProvider = { id: "fixture", mode: "live", discover: async () => references };
    const resolver = new JobReferenceResolver([lever, greenhouse]);
    const source = new JobReferenceSource(provider, resolver);
    const result = await new JobScout({ [source.id]: source }, () => now).discover(campaign([source.id]));
    expect(result.jobs).toHaveLength(2);
    expect(result.jobs.map((job) => job.sourceId)).toEqual(expect.arrayContaining(["lever:acme", "greenhouse:acme"]));
    expect(result.referenceMetrics).toMatchObject({
      referencesDiscovered: 5,
      knownAtsReferences: 4,
      leverReferences: 1,
      greenhouseReferences: 1,
      ashbyReferences: 1,
      workdayReferences: 1,
      customReferences: 1,
      unknownOrCustomReferences: 1,
      knownUnsupportedReferences: 2,
      structuredJobsResolved: 2,
      fallbackRequiredReferences: 1,
      uniqueLeverSites: 1,
      uniqueGreenhouseBoards: 1,
      leverSiteIdentities: ["acme"],
      greenhouseBoardIdentities: ["acme"],
    });
    expect(result.sourceSummaries[0].status).toBe("partial");
  });

  it("derives observed-sample coverage ratios without inventing a denominator", () => {
    expect(discoveryCoverageRatios({
      referencesDiscovered: 10,
      knownAtsReferences: 6,
      leverReferences: 2,
      greenhouseReferences: 2,
      knownUnsupportedReferences: 2,
      unknownOrCustomReferences: 2,
      structuredJobsResolved: 4,
      duplicatesRemoved: 1,
      sourceFailures: 0,
      fallbackRequiredReferences: 2,
    })).toEqual({
      knownAtsClassificationRate: 0.75,
      structuredResolutionRate: 0.5,
      knownUnsupportedRate: 0.25,
      fallbackRequiredRate: 0.25,
    });
    expect(discoveryCoverageRatios({
      referencesDiscovered: 0,
      knownAtsReferences: 0,
      leverReferences: 0,
      greenhouseReferences: 0,
      knownUnsupportedReferences: 0,
      unknownOrCustomReferences: 0,
      structuredJobsResolved: 0,
      duplicatesRemoved: 0,
      sourceFailures: 0,
    })).toEqual({});
  });

  it("can instantiate a structured resolver for a discovered board/site without a hardcoded employer list", async () => {
    const dynamic = new JobReferenceResolver([], {
      createSource: (classification) => classification.kind === "lever" ? lever : greenhouse,
    });
    const resolved = await dynamic.resolve(
      { discoveredUrl: "https://jobs.lever.co/acme/lever-1", sourceProvider: "fixture", discoveredAt: now },
      criteria,
      { now, maxResults: 10 },
    );
    expect(resolved.status).toBe("resolved");
    expect(resolved.sourceId).toBe("lever:acme");
  });

  it("cross-deduplicates a resolved broad reference with a Remotive observation and keeps the richer record", async () => {
    const provider: JobDiscoveryProvider = {
      id: BRAVE_SEARCH_DISCOVERY_ID,
      mode: "live",
      discover: async () => [{
        discoveredUrl: "https://jobs.lever.co/acme/lever-1?utm_source=search",
        titleHint: "Cloud Platform Engineer",
        sourceProvider: BRAVE_SEARCH_DISCOVERY_ID,
        discoveredAt: now,
        query: "cloud engineering remote jobs",
      }],
    };
    const referenceSource = new JobReferenceSource(provider, new JobReferenceResolver([lever]));
    const remotive: JobSource = {
      id: "remotive-live",
      mode: "live",
      discover: async () => [{
        sourceRecordId: "remotive-1",
        sourceMode: "live",
        input: {
          rawText: "Acme\nCloud Platform Engineer\nLocation: Remote\nBuild dependable platform systems.",
          sourceUrl: "https://remotive.com/remote-jobs/acme-cloud-platform-engineer",
          companyHint: "Acme",
          titleHint: "Cloud Platform Engineer",
        },
        discoveredAt: now,
      }],
    };
    const result = await new JobScout(
      { [referenceSource.id]: referenceSource, [remotive.id]: remotive },
      () => now,
    ).discover(campaign([referenceSource.id, remotive.id]));
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].sourceId).toBe("lever:acme");
    expect(result.jobs[0].actionability).toBe("actionable");
    expect(result.jobs[0].sourceObservations).toHaveLength(2);
    expect(result.duplicateCount).toBe(1);
  });

  it("preserves a not-configured broad source as an auditable source failure", async () => {
    const provider: JobDiscoveryProvider = {
      id: BRAVE_SEARCH_DISCOVERY_ID,
      mode: "live",
      discover: async () => ({
        status: "not_configured",
        reason: "Brave Search API key is not configured.",
        references: [],
      }),
    };
    const source = new JobReferenceSource(provider, new JobReferenceResolver([]));
    const result = await new JobScout({ [source.id]: source }, () => now).discover(campaign([source.id]));
    expect(result.sourceSummaries[0]).toMatchObject({ status: "not_configured", reason: expect.stringContaining("API key") });
    expect(result.failures[0].kind).toBe("source");
  });

  it("keeps Remotive-like results when the broad source fails", async () => {
    const broad: JobSource = {
      id: "references:brave-search",
      mode: "live",
      discover: async () => { throw new Error("provider unavailable"); },
    };
    const remotiveLike = new StaticJobSource("remotive-live", [{
      input: {
        rawText: "Example Cloud\nCloud Engineer\nLocation: Remote\nBuild platform systems.",
        sourceUrl: "https://remote.example.test/jobs/cloud-1",
        companyHint: "Example Cloud",
        titleHint: "Cloud Engineer",
        isExample: false,
      },
      sourceMode: "live",
      discoveredAt: now,
    }]);
    const result = await new JobScout({ [broad.id]: broad, [remotiveLike.id]: remotiveLike }, () => now)
      .discover(campaign([broad.id, remotiveLike.id]));
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].sourceId).toBe("remotive-live");
    expect(result.sourceSummaries.find((summary) => summary.sourceId === broad.id)?.status).toBe("failed");
  });
});

describe("broad discovery loopback boundary", () => {
  const noopExecutor: ApplicationExecutor = {
    id: "noop",
    execute: async () => ({
      state: "failed",
      reason: "No execution requested in discovery boundary test.",
      retryable: false,
    }),
  };

  async function serverFor(discoveryProvider?: JobDiscoveryProvider) {
    const host = createExecutionHostServer({
      executor: noopExecutor,
      discoveryProvider,
      host: "127.0.0.1",
      port: 0,
      allowedOrigins: ["http://localhost:5173"],
    });
    await new Promise<void>((resolve) => host.server.listen(0, "127.0.0.1", resolve));
    const address = host.server.address() as AddressInfo;
    return { host, baseUrl: `http://127.0.0.1:${address.port}` };
  }

  it("accepts validated criteria through the allowed origin and rejects other origins", async () => {
    let receivedCriteria: SearchCriteria | undefined;
    const provider: JobDiscoveryProvider = {
      id: "brave-search-live",
      mode: "live",
      discover: async (received) => {
        receivedCriteria = received;
        return [{ discoveredUrl: "https://jobs.lever.co/acme/one", sourceProvider: "brave-search-live", discoveredAt: now }];
      },
    };
    const { host, baseUrl } = await serverFor(provider);
    try {
      const allowed = await fetch(`${baseUrl}/career-agent/discovery`, {
        method: "POST",
        headers: { Origin: "http://localhost:5173", "Content-Type": "application/json" },
        body: JSON.stringify({ criteria, now, maxResults: 5 }),
      });
      expect(allowed.status).toBe(200);
      expect((await allowed.json()) as unknown).toMatchObject({ references: [{ discoveredUrl: "https://jobs.lever.co/acme/one" }] });
      expect(receivedCriteria).toEqual(criteria);

      const denied = await fetch(`${baseUrl}/career-agent/discovery`, {
        method: "POST",
        headers: { Origin: "http://evil.invalid", "Content-Type": "application/json" },
        body: JSON.stringify({ criteria }),
      });
      expect(denied.status).toBe(403);

      const invalid = await fetch(`${baseUrl}/career-agent/discovery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ criteria: { ...criteria, remoteOnly: "yes" } }),
      });
      expect(invalid.status).toBe(400);
    } finally {
      await host.close();
    }
  });

  it("returns explicit not_configured state when the host has no provider", async () => {
    const { host, baseUrl } = await serverFor();
    try {
      const responseValue = await fetch(`${baseUrl}/career-agent/discovery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ criteria }),
      });
      expect(responseValue.status).toBe(200);
      expect(await responseValue.json()).toMatchObject({ status: "not_configured", references: [] });
    } finally {
      await host.close();
    }
  });

  it("uses the typed browser client and does not silently fall back when the host is unavailable", async () => {
    const client = new HttpJobDiscoveryProvider({
      fetcher: async () => { throw new Error("connection refused"); },
      timeoutMs: 20,
    });
    await expect(client.discover(criteria, { now, maxResults: 5 })).rejects.toMatchObject({ name: "JobDiscoveryHostUnavailableError" });
  });
});
