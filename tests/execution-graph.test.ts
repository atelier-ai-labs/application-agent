import { describe, expect, it } from "vitest";
import {
  ExecutionTraceBuilder,
  createExecutionNodeTrace,
  InMemoryApplicationRepository,
  InMemoryCareerRepository,
  InMemoryJobTracker,
  JobReferenceResolver,
  JobScout,
  SimulatedApplicationExecutor,
  StaticJobSource,
  createApplicationService,
  exampleCandidateProfile,
  isCampaign,
  isExecutionRunTrace,
  mapWithConcurrencyLimit,
  normalizeJobPosting,
  type Campaign,
  type DiscoveredJobReference,
  type JobSource,
  type JobSourceListing,
  type SearchCriteria,
} from "../application-agent/src";
import { CareerAgentService } from "../application-agent/src/service/careerAgentService";

const now = "2026-08-31T12:00:00.000Z";
const criteria: SearchCriteria = {
  roleLanes: ["platform"],
  searchQueries: ["platform"],
  locations: [],
  remoteOnly: false,
  employmentTypes: [],
  excludedSeniorities: [],
  excludedCompanies: [],
};

function campaign(sourceIds: readonly string[]): Campaign {
  return {
    id: "trace-campaign",
    name: "Trace campaign",
    goal: "Measure bounded independent work.",
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

function listing(slug: string): JobSourceListing {
  return {
    sourceRecordId: slug,
    input: {
      isExample: true,
      companyHint: `Example ${slug}`,
      titleHint: "Platform Engineer",
      sourceUrl: `https://jobs.example.invalid/${slug}`,
      rawText: `Example ${slug}\nPlatform Engineer\nLocation: Remote\nEmployment type: Full-time\n\nBuild platform systems for an example team.\n\nRequired qualifications\n- Platform\n`,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushWork(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("execution graph audit seams", () => {
  it("bounds independent work, starts the next unit as soon as capacity frees, and fans in in input order", async () => {
    const started: number[] = [];
    const completed: number[] = [];
    const releases = new Map<number, (value: number) => void>();
    let active = 0;
    let maximumActive = 0;

    const run = mapWithConcurrencyLimit([0, 1, 2, 3], 2, async (value) => {
      started.push(value);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const gate = deferred<number>();
      releases.set(value, gate.resolve);
      const result = await gate.promise;
      completed.push(value);
      active -= 1;
      return result;
    });

    expect(started).toEqual([0, 1]);
    releases.get(1)!(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    releases.get(0)!(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2, 3]);
    releases.get(2)!(2);
    releases.get(3)!(3);

    await expect(run).resolves.toEqual([0, 1, 2, 3]);
    expect(completed).toEqual([1, 0, 2, 3]);
    expect(maximumActive).toBe(2);
  });

  it("bounds source fetches and keeps deterministic source ordering despite completion order", async () => {
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const sources: Record<string, JobSource> = {};
    for (const sourceId of ["source-a", "source-b", "source-c"]) {
      sources[sourceId] = {
        id: sourceId,
        mode: "live",
        discover: async () => {
          started.push(sourceId);
          const gate = deferred<void>();
          releases.set(sourceId, gate.resolve);
          await gate.promise;
          return [listing(sourceId)];
        },
      };
    }

    const run = new JobScout(sources, () => now, { maxConcurrentSources: 2 }).discover(campaign(Object.keys(sources)));
    expect(started).toEqual(["source-a", "source-b"]);
    releases.get("source-b")!();
    await flushWork();
    expect(started).toEqual(["source-a", "source-b", "source-c"]);
    releases.get("source-a")!();
    releases.get("source-c")!();

    const result = await run;
    expect(result.jobs.map((job) => job.sourceId)).toEqual(["source-a", "source-b", "source-c"]);
    expect(result.executionNodes?.map((node) => node.nodeId)).toEqual([
      "scout.source-fanout",
      "scout.source.source-a",
      "scout.source.source-b",
      "scout.source.source-c",
      "scout.reduce",
    ]);
  });

  it("records partial, failed, and skipped source outcomes without losing healthy listings", async () => {
    const sources: Record<string, JobSource> = {
      partial: {
        id: "partial",
        mode: "live",
        discover: async () => ({ listings: [listing("partial")], warnings: ["one entry was skipped"], status: "partial" as const }),
      },
      failed: {
        id: "failed",
        mode: "live",
        discover: async () => { throw new Error("provider unavailable"); },
      },
      skipped: {
        id: "skipped",
        mode: "live",
        discover: async () => ({ listings: [], status: "not_configured" as const, reason: "source disabled" }),
      },
    };

    const result = await new JobScout(sources, () => now).discover(campaign(["partial", "failed", "skipped"]));
    expect(result.jobs).toHaveLength(1);
    expect(result.failures.map((failure) => failure.sourceId)).toEqual(["partial", "partial", "failed", "skipped"]);
    expect(result.executionNodes?.map((node) => node.outcome)).toEqual(["partial", "partial", "failed", "skipped", "partial"]);
  });

  it("bounds independent reference resolution while preserving resolver order", async () => {
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const resolver = new JobReferenceResolver([], {
      maxConcurrentReferences: 2,
      createSource: (classification) => {
        const site = classification.siteIdentifier!;
        return {
          id: `lever:${site}`,
          mode: "live",
          site,
          discover: async () => {
            started.push(site);
            const gate = deferred<void>();
            releases.set(site, gate.resolve);
            await gate.promise;
            return [{
              sourceRecordId: classification.postingIdentifier,
              sourceMode: "live",
              input: {
                rawText: `Company ${site}\nPlatform Engineer\nLocation: Remote\nBuild platform systems for ${site}.`,
                sourceUrl: `https://jobs.lever.co/${site}/${classification.postingIdentifier}`,
                applicationUrl: `https://jobs.lever.co/${site}/${classification.postingIdentifier}/apply`,
                companyHint: `Company ${site}`,
                titleHint: "Platform Engineer",
              },
            }];
          },
        };
      },
    });
    const references: DiscoveredJobReference[] = ["a", "b", "c"].map((site) => ({
      discoveredUrl: `https://jobs.lever.co/${site}/posting-${site}`,
      sourceProvider: "fixture",
      discoveredAt: now,
    }));

    const run = resolver.resolveMany(references, criteria, { now, maxResults: 10 });
    await flushWork();
    expect(started).toEqual(["a", "b"]);
    releases.get("b")!();
    await flushWork();
    expect(started).toEqual(["a", "b", "c"]);
    releases.get("a")!();
    releases.get("c")!();

    const results = await run;
    expect(results.map((result) => result.classification.siteIdentifier)).toEqual(["a", "b", "c"]);
    expect(results.every((result) => result.status === "resolved")).toBe(true);
  });

  it("records run nodes and attention events without storing private payloads", async () => {
    const applicationRepository = new InMemoryApplicationRepository();
    const careerRepository = new InMemoryCareerRepository();
    const applicationService = createApplicationService(exampleCandidateProfile, applicationRepository);
    const source = new StaticJobSource("trace-demo", [listing("trace")]);
    let sequence = 0;
    const service = new CareerAgentService(
      exampleCandidateProfile,
      {
        applicationService,
        careerRepository,
        scout: new JobScout({ [source.id]: source }, () => now),
        executor: new SimulatedApplicationExecutor(),
        tracker: new InMemoryJobTracker(),
      },
      {
        now: () => now,
        createId: (prefix) => `${prefix}-trace-${++sequence}`,
      },
    );
    const campaignRecord = service.createCampaign({
      name: "Trace persistence",
      goal: "Record bounded operational telemetry.",
      searchSources: [source.id],
      searchCriteria: criteria,
      applicationPolicy: { autoPrepare: false, allowGroundedDrafts: false, approvedResumeFamilies: [] },
      submissionPolicy: { authority: "never", requireExplicitApproval: false },
    });
    service.activateCampaign(campaignRecord.id);

    const result = await service.runCampaign(campaignRecord.id);
    const trace = result.trace;
    expect(trace).toBeDefined();
    expect(isExecutionRunTrace(trace)).toBe(true);
    expect(isCampaign(result.snapshot.campaign)).toBe(true);
    expect(result.snapshot.campaign.lastRunTrace).toEqual(trace);
    expect(trace?.nodes.map((node) => node.nodeId)).toEqual(expect.arrayContaining([
      "scout.fetch-and-reduce",
      "scout.source.trace-demo",
      "scout.reduce",
      "scout.history-dedupe",
      "job.process.1",
    ]));
    expect(trace?.humanAttentionEvents).toBeGreaterThan(0);
    expect(JSON.stringify(trace)).not.toContain("phone");
    expect(JSON.stringify(trace)).not.toContain("password");
    expect(JSON.stringify(trace)).not.toContain("resume");
  });

  it("accepts deterministic trace measurements and derives retry counts from attempts", async () => {
    const trace = new ExecutionTraceBuilder("run-1", "campaign_run", () => now, now);
    await trace.measure("cache.read", "external_io", async () => ["a", "b"], {
      attempt: 2,
      inputCount: 1,
      outputCount: (items) => items.length,
      cacheHit: () => true,
      metadata: { provider: "fixture", resultCount: "2" },
    });
    const result = trace.finish(now);
    expect(result.retryCount).toBe(1);
    expect(result.nodes[0]).toMatchObject({
      nodeId: "cache.read",
      outcome: "success",
      attempt: 2,
      inputCount: 1,
      outputCount: 2,
      cacheHit: true,
    });
    expect(isExecutionRunTrace(result)).toBe(true);
  });

  it("derives nested self time without treating inclusive parent and child time as additive", () => {
    const trace = new ExecutionTraceBuilder("nested-run", "campaign_run", () => now, now);
    trace.add(createExecutionNodeTrace({
      nodeId: "scout.fetch-and-reduce",
      nodeKind: "external_io",
      startedAt: "2026-08-31T12:00:00.000Z",
      completedAt: "2026-08-31T12:00:03.000Z",
      durationMs: 3_000,
      outcome: "success",
      metadata: { stage: "scout.total" },
    }));
    trace.add(createExecutionNodeTrace({
      nodeId: "scout.source-a",
      nodeKind: "external_io",
      startedAt: "2026-08-31T12:00:00.000Z",
      completedAt: "2026-08-31T12:00:01.000Z",
      durationMs: 1_000,
      outcome: "success",
      parentNodeId: "scout.fetch-and-reduce",
      metadata: { stage: "scout.source.source-a" },
    }));
    trace.add(createExecutionNodeTrace({
      nodeId: "scout.reduce",
      nodeKind: "deterministic",
      startedAt: "2026-08-31T12:00:00.500Z",
      completedAt: "2026-08-31T12:00:02.000Z",
      durationMs: 1_500,
      outcome: "success",
      parentNodeId: "scout.fetch-and-reduce",
      metadata: { stage: "scout.reduce" },
    }));

    const result = trace.finish(now);
    expect(result.nodes.find((node) => node.nodeId === "scout.fetch-and-reduce")?.exclusiveDurationMs).toBe(1_000);
    expect(result.summary?.stageSummaries.find((stage) => stage.stage === "scout.total")).toMatchObject({
      inclusiveDurationMs: 3_000,
      exclusiveDurationMs: 1_000,
      wallClockDurationMs: 3_000,
    });
    expect(result.summary?.stageSummaries.find((stage) => stage.stage === "scout.source.source-a")?.wallClockDurationMs).toBe(1_000);
  });

  it("records typed safe failures, external counters, attention categories, and no fake model usage", async () => {
    const trace = new ExecutionTraceBuilder("safe-run", "campaign_run", () => now, now);
    await expect(trace.measure(
      "provider.request",
      "external_io",
      async () => { throw new Error("provider failed for private.person@example.test"); },
      { externalMetricsOnError: { requestCount: 1, failureCount: 1 }, metadata: { stage: "scout.source.fixture" } },
    )).rejects.toThrow("private.person@example.test");
    trace.setHumanAttentionEvents(2, { captcha: 1, manual_submission: 1 });
    trace.setHumanWaitDuration(1_234);
    const result = trace.finish(now);
    expect(result.nodes[0]).toMatchObject({
      failureReason: "provider_error",
      externalRequestCount: 1,
      externalFailureCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain("private.person@example.test");
    expect(result.summary).toMatchObject({
      humanWaitDurationMs: 1_234,
      externalRequestCount: 1,
      failureCount: 1,
      attentionByCategory: { captcha: 1, manual_submission: 1 },
    });
    expect(JSON.stringify(result)).not.toContain("inputTokens");
    expect(JSON.stringify(result)).not.toContain("estimatedCost");
    expect(isExecutionRunTrace(result)).toBe(true);
  });

  it("records resume, answer, and blocker-evaluation preparation boundaries", async () => {
    const repository = new InMemoryApplicationRepository();
    const applicationService = createApplicationService(exampleCandidateProfile, repository);
    const job = normalizeJobPosting({
      companyHint: "Trace Company",
      titleHint: "Platform Engineer",
      sourceUrl: "https://jobs.example.invalid/trace-preparation",
      rawText: "Trace Company\nPlatform Engineer\nLocation: Remote\n\nBuild platform systems.\n\nRequired qualifications\n- Platform",
    }, now);
    const created = await applicationService.createApplicationFromJob(job, true);
    const fit = await applicationService.assessJob(job);
    const evaluated = await applicationService.evaluateApplication(created.id, fit);
    const trace = new ExecutionTraceBuilder("preparation-run", "campaign_run", () => now, now);
    await trace.measure("preparation.total.app", "judgment", () => applicationService.prepareApplication(evaluated.id, {
      trace,
      parentNodeId: "preparation.total.app",
    }), {
      metadata: { stage: "preparation.total" },
    });
    const result = trace.finish(now);
    expect(result.nodes.map((node) => node.metadata?.stage)).toEqual(expect.arrayContaining([
      "preparation.total",
      "preparation.resume",
      "preparation.answers",
      "preparation.blocker-evaluation",
    ]));
    expect(result.nodes.find((node) => node.metadata?.stage === "preparation.resume")?.parentNodeId).toBe("preparation.total.app");
  });
});
