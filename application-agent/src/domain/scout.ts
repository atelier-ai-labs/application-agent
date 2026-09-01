import { normalizeJobPosting } from "./job";
import type {
  Campaign,
  DiscoveryStatus,
  JobActionability,
  JobSourceMode,
  JobSourceObservation,
  ScoutReferenceMetrics,
  SearchCriteria,
} from "./campaignTypes";
import type { JobIntakeInput, JobPosting } from "./types";
import { mapWithConcurrencyLimit } from "./concurrency";
import {
  createExecutionNodeTrace,
  monotonicNow,
  type ExecutionNodeOutcome,
  type ExecutionNodeTrace,
} from "./executionTrace";

export interface DiscoveryContext {
  /** One timestamp for a source request and all of its returned postings. */
  now: string;
  /** Hard upper bound for listings passed into the normalization pipeline. */
  maxResults: number;
}

export interface JobSourceListing {
  input: JobIntakeInput;
  /** When a discovery provider resolves multiple ATS sources in one batch. */
  sourceId?: string;
  /** A resolver may carry source-owned classification into the shared Scout. */
  actionability?: JobActionability;
  sourceRecordId?: string;
  /** Provider publication time, when the source supplies a valid timestamp. */
  sourcePublishedAt?: string;
  discoveredAt?: string;
  sourceMode?: JobSourceMode;
}

export interface JobSourceBatch {
  listings: readonly JobSourceListing[];
  /** Non-fatal source/entry issues. They make discovery partial, not silently successful. */
  warnings?: readonly string[];
  /** A source may explicitly report empty, partial, failed, or not-configured state. */
  status?: DiscoveryStatus;
  reason?: string;
  /** Optional metrics emitted by a URL/reference discovery source. */
  referenceMetrics?: ScoutReferenceMetrics;
  /** True when a source reused a still-fresh provider response. */
  cached?: boolean;
  /** When the provider response was fetched from the external source. */
  sourceFetchedAt?: string;
  /** Safe stage traces emitted by a source-owned sub-boundary. */
  executionNodes?: readonly ExecutionNodeTrace[];
}

export type JobSourceResponse = readonly JobSourceListing[] | JobSourceBatch;

export interface JobSource {
  id: string;
  mode?: JobSourceMode;
  discover(criteria: SearchCriteria, context?: DiscoveryContext): Promise<JobSourceResponse>;
  /** A source owns the provider-specific proof needed to call a posting actionable. */
  classifyActionability?(job: JobPosting, listing: JobSourceListing): JobActionability;
}

export type JobSourceRegistry = Readonly<Record<string, JobSource>>;

export interface JobScoutOptions {
  timeoutMs?: number;
  maxResultsPerSource?: number;
  /** Bounds independent source requests; results remain in campaign source order. */
  maxConcurrentSources?: number;
}

interface SourceDiscoveryResult {
  sourceId: string;
  source?: JobSource;
  listings: readonly JobSourceListing[];
  warnings: readonly string[];
  status?: DiscoveryStatus;
  reason?: string;
  referenceMetrics?: ScoutReferenceMetrics;
  cached?: boolean;
  sourceFetchedAt?: string;
  failure?: string;
  executionNode?: ExecutionNodeTrace;
  executionNodes?: readonly ExecutionNodeTrace[];
}

export interface ScoutedJob {
  sourceId: string;
  sourceMode: JobSourceMode;
  actionability: JobActionability;
  sourceRecordId?: string;
  sourcePublishedAt?: string;
  isExample: boolean;
  job: JobPosting;
  discoveredAt: string;
  fingerprint: string;
  /** Primary identity plus safe URL/content aliases used for cross-source history checks. */
  dedupeKeys: readonly string[];
  sourceObservations: readonly JobSourceObservation[];
}

export interface ScoutFailure {
  sourceId: string;
  reason: string;
  kind?: "source" | "listing";
}

export interface ScoutSourceSummary {
  sourceId: string;
  mode: JobSourceMode;
  status: DiscoveryStatus;
  receivedCount: number;
  normalizedCount: number;
  duplicateCount: number;
  warningCount: number;
  reason?: string;
  cached?: boolean;
  sourceFetchedAt?: string;
}

export interface ScoutResult {
  jobs: readonly ScoutedJob[];
  failures: readonly ScoutFailure[];
  sourceSummaries: readonly ScoutSourceSummary[];
  startedAt: string;
  completedAt: string;
  receivedCount: number;
  normalizedCount: number;
  duplicateCount: number;
  /** Flat operational traces for source fetches and deterministic reduction. */
  executionNodes?: readonly ExecutionNodeTrace[];
  referenceMetrics?: ScoutReferenceMetrics;
}

function normalizeKey(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Canonicalize only URL noise that is conventionally tracking metadata. Other
 * query parameters are retained because they may identify a real posting.
 */
export function canonicalJobUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (
        lower.startsWith("utm_") ||
        lower === "fbclid" ||
        lower === "gclid" ||
        lower === "dclid" ||
        lower === "msclkid" ||
        lower === "ref" ||
        lower === "source" ||
        lower === "src"
      ) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function contentFingerprint(job: JobPosting): string {
  return [
    normalizeKey(job.company),
    normalizeKey(job.title),
    normalizeKey(job.location),
    normalizeKey(job.employmentType),
  ].join("|");
}

function crossSourceContentFingerprint(job: JobPosting): string | undefined {
  const company = normalizeKey(job.company);
  const title = normalizeKey(job.title);
  const location = normalizeKey(job.location);
  if (!company || !title || !location) return undefined;
  return [company, title, location].join("|");
}

export function crossSourceDedupeKey(job: JobPosting): string | undefined {
  const content = crossSourceContentFingerprint(job);
  return content ? `cross:${content}` : undefined;
}

/**
 * Prefer a provider identity when available, then canonical URLs, then a
 * conservative normalized company/title/location fallback.
 */
export function jobFingerprint(
  job: JobPosting,
  sourceRecordId?: string,
  sourceId?: string,
): string {
  const recordId = normalizeKey(sourceRecordId);
  if (recordId) {
    return `source:${normalizeKey(sourceId) || "unknown"}:id:${recordId}`;
  }

  const url = canonicalJobUrl(job.applicationUrl) ?? canonicalJobUrl(job.sourceUrl);
  if (url) {
    return `url:${url}`;
  }

  return `job:${contentFingerprint(job)}`;
}

export function jobDedupeKeys(
  job: JobPosting,
  sourceRecordId?: string,
  sourceId?: string,
): readonly string[] {
  const recordId = normalizeKey(sourceRecordId);
  const keys = [jobFingerprint(job, sourceRecordId, sourceId)];
  const applicationUrl = canonicalJobUrl(job.applicationUrl);
  const sourceUrl = canonicalJobUrl(job.sourceUrl);
  if (applicationUrl) keys.push(`url:${applicationUrl}`);
  if (sourceUrl && sourceUrl !== applicationUrl) keys.push(`url:${sourceUrl}`);
  const crossKey = crossSourceDedupeKey(job);
  if (crossKey) keys.push(crossKey);
  if (!recordId && !applicationUrl && !sourceUrl) keys.push(`job:${contentFingerprint(job)}`);
  return [...new Set(keys)];
}

/**
 * Provider IDs and canonical URLs are exact identities. The content alias is
 * only allowed to bridge distinct live source records; two postings from the
 * same source remain distinct when their provider IDs differ.
 */
export function jobKeysMatch(
  leftSourceId: string,
  leftKeys: readonly string[],
  leftMode: JobSourceMode,
  rightSourceId: string,
  rightKeys: readonly string[],
  rightMode: JobSourceMode,
): boolean {
  const right = new Set(rightKeys);
  if (leftKeys.some((key) => !key.startsWith("cross:") && right.has(key))) return true;
  return leftMode === "live" && rightMode === "live" && leftSourceId !== rightSourceId &&
    leftKeys.some((key) => key.startsWith("cross:") && right.has(key));
}

function actionabilityRank(value: JobActionability): number {
  return value === "actionable" ? 2 : 1;
}

function observationKey(observation: JobSourceObservation): string {
  return [
    observation.sourceId,
    observation.sourceRecordId ?? "",
    observation.sourceUrl ?? "",
    observation.applicationUrl ?? "",
  ].join("|");
}

function mergeScoutedJobs(current: ScoutedJob, incoming: ScoutedJob): ScoutedJob {
  const preferred = actionabilityRank(incoming.actionability) > actionabilityRank(current.actionability) ||
    (incoming.actionability === current.actionability &&
      Boolean(incoming.job.applicationUrl) && !current.job.applicationUrl) ||
    (incoming.actionability === current.actionability && incoming.job.description.length > current.job.description.length)
    ? incoming
    : current;
  const observations = new Map<string, JobSourceObservation>();
  for (const observation of [...current.sourceObservations, ...incoming.sourceObservations]) {
    observations.set(observationKey(observation), observation);
  }
  return {
    ...preferred,
    dedupeKeys: [...new Set([...current.dedupeKeys, ...incoming.dedupeKeys])],
    sourceObservations: [...observations.values()],
  };
}

function emptyReferenceMetrics(): ScoutReferenceMetrics {
  return {
    referencesDiscovered: 0,
    knownAtsReferences: 0,
    leverReferences: 0,
    greenhouseReferences: 0,
    knownUnsupportedReferences: 0,
    unknownOrCustomReferences: 0,
    structuredJobsResolved: 0,
    duplicatesRemoved: 0,
    sourceFailures: 0,
  };
}

function addReferenceMetrics(
  current: ScoutReferenceMetrics | undefined,
  incoming: ScoutReferenceMetrics | undefined,
): ScoutReferenceMetrics | undefined {
  if (!current && !incoming) return undefined;
  const left = current ?? emptyReferenceMetrics();
  const right = incoming ?? emptyReferenceMetrics();
  const optionalNumberKeys: readonly (keyof ScoutReferenceMetrics)[] = [
    "providerResults",
    "acceptedReferences",
    "rejectedReferences",
    "duplicateReferences",
    "queriesExecuted",
    "ashbyReferences",
    "workdayReferences",
    "customReferences",
    "unknownReferences",
    "fallbackRequiredReferences",
    "invalidReferences",
    "failedReferences",
  ];
  const optionalNumbers = Object.fromEntries(optionalNumberKeys.flatMap((key) => {
    const leftValue = left[key];
    const rightValue = right[key];
    if (typeof leftValue !== "number" && typeof rightValue !== "number") return [];
    return [[key, (typeof leftValue === "number" ? leftValue : 0) + (typeof rightValue === "number" ? rightValue : 0)]];
  })) as Partial<ScoutReferenceMetrics>;
  const queryMetrics = left.queryMetrics || right.queryMetrics
    ? [...(left.queryMetrics ?? []), ...(right.queryMetrics ?? [])]
    : undefined;
  const leverSiteIdentities = left.leverSiteIdentities || right.leverSiteIdentities
    ? [...new Set([...(left.leverSiteIdentities ?? []), ...(right.leverSiteIdentities ?? [])])]
    : undefined;
  const greenhouseBoardIdentities = left.greenhouseBoardIdentities || right.greenhouseBoardIdentities
    ? [...new Set([...(left.greenhouseBoardIdentities ?? []), ...(right.greenhouseBoardIdentities ?? [])])]
    : undefined;
  const uniqueLeverSites = leverSiteIdentities
    ? leverSiteIdentities.length
    : typeof left.uniqueLeverSites === "number" || typeof right.uniqueLeverSites === "number"
      ? (left.uniqueLeverSites ?? 0) + (right.uniqueLeverSites ?? 0)
      : undefined;
  const uniqueGreenhouseBoards = greenhouseBoardIdentities
    ? greenhouseBoardIdentities.length
    : typeof left.uniqueGreenhouseBoards === "number" || typeof right.uniqueGreenhouseBoards === "number"
      ? (left.uniqueGreenhouseBoards ?? 0) + (right.uniqueGreenhouseBoards ?? 0)
      : undefined;
  return {
    referencesDiscovered: left.referencesDiscovered + right.referencesDiscovered,
    knownAtsReferences: left.knownAtsReferences + right.knownAtsReferences,
    leverReferences: left.leverReferences + right.leverReferences,
    greenhouseReferences: left.greenhouseReferences + right.greenhouseReferences,
    knownUnsupportedReferences: left.knownUnsupportedReferences + right.knownUnsupportedReferences,
    unknownOrCustomReferences: left.unknownOrCustomReferences + right.unknownOrCustomReferences,
    structuredJobsResolved: left.structuredJobsResolved + right.structuredJobsResolved,
    duplicatesRemoved: left.duplicatesRemoved + right.duplicatesRemoved,
    sourceFailures: left.sourceFailures + right.sourceFailures,
    ...optionalNumbers,
    ...(uniqueLeverSites !== undefined ? { uniqueLeverSites } : {}),
    ...(uniqueGreenhouseBoards !== undefined ? { uniqueGreenhouseBoards } : {}),
    ...(leverSiteIdentities ? { leverSiteIdentities } : {}),
    ...(greenhouseBoardIdentities ? { greenhouseBoardIdentities } : {}),
    ...(queryMetrics ? { queryMetrics } : {}),
  };
}

function isJobSourceBatch(value: JobSourceResponse): value is JobSourceBatch {
  return !Array.isArray(value) && typeof value === "object" && value !== null && Array.isArray((value as JobSourceBatch).listings);
}

function sourceModeFor(
  source: Pick<JobSource, "mode">,
  listing: JobSourceListing | undefined,
): JobSourceMode {
  return source.mode ?? listing?.sourceMode ?? (listing?.input.isExample ? "demo" : "live");
}

function sourceTraceOutcome(result: SourceDiscoveryResult): ExecutionNodeOutcome {
  if (result.failure || result.status === "failed") return "failed";
  if (result.status === "not_configured") return "skipped";
  if (result.status === "partial" || result.warnings.length > 0) return "partial";
  return "success";
}

function sourceFailureReason(result: SourceDiscoveryResult): "timeout" | "provider_error" | "provider_configuration" | undefined {
  if (result.status === "not_configured" || `${result.failure ?? ""} ${result.reason ?? ""}`.toLowerCase().includes("not configured")) {
    return "provider_configuration";
  }
  if (result.failure || result.status === "failed") {
    return `${result.failure ?? result.reason ?? ""}`.toLowerCase().includes("timeout") ||
      `${result.failure ?? result.reason ?? ""}`.toLowerCase().includes("timed out")
      ? "timeout"
      : "provider_error";
  }
  return undefined;
}

function sourceExternalMetrics(result: SourceDiscoveryResult): {
  requestCount: number;
  successCount: number;
  failureCount: number;
  timeoutCount: number;
} {
  const isLive = Boolean(result.source) && (result.source?.mode ?? "live") !== "demo";
  const requestCount = result.cached === true || result.status === "not_configured" || !isLive
    ? 0
    : result.referenceMetrics?.queriesExecuted ?? 1;
  const failedQueryCount = result.referenceMetrics?.queryMetrics?.filter((metric) => metric.status === "failed").length ?? 0;
  const failureCount = requestCount === 0
    ? 0
    : Math.min(requestCount, Math.max(failedQueryCount, result.failure || result.status === "failed" ? requestCount : 0));
  const timeoutCount = requestCount > 0 && (`${result.failure ?? result.reason ?? ""}`.toLowerCase().includes("timeout") ||
    `${result.failure ?? result.reason ?? ""}`.toLowerCase().includes("timed out")) ? 1 : 0;
  return {
    requestCount,
    successCount: Math.max(0, requestCount - failureCount),
    failureCount,
    timeoutCount,
  };
}

export class JobScout {
  private readonly timeoutMs: number;
  private readonly maxResultsPerSource: number;
  private readonly maxConcurrentSources: number;

  constructor(
    private readonly sources: JobSourceRegistry,
    private readonly now: () => string = () => new Date().toISOString(),
    options: JobScoutOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.maxResultsPerSource = options.maxResultsPerSource ?? 50;
    this.maxConcurrentSources = options.maxConcurrentSources ?? 4;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Job scout timeout must be a positive number.");
    }
    if (!Number.isInteger(this.maxResultsPerSource) || this.maxResultsPerSource <= 0) {
      throw new Error("Job scout source cap must be a positive integer.");
    }
    if (!Number.isInteger(this.maxConcurrentSources) || this.maxConcurrentSources <= 0) {
      throw new Error("Job scout concurrency limit must be a positive integer.");
    }
  }

  async discover(campaign: Campaign): Promise<ScoutResult> {
    const startedAt = this.now();
    const jobs: ScoutedJob[] = [];
    const failures: ScoutFailure[] = [];
    const sourceSummaries: ScoutSourceSummary[] = [];
    let receivedCount = 0;
    let normalizedCount = 0;
    let duplicateCount = 0;
    let referenceMetrics: ScoutReferenceMetrics | undefined;

    if (campaign.searchSources.length === 0) {
      return {
        jobs,
        failures: [{ sourceId: "none", reason: "No job sources are configured for this campaign.", kind: "source" }],
        sourceSummaries: [{
          sourceId: "none",
          mode: "live",
          status: "failed",
          receivedCount: 0,
          normalizedCount: 0,
          duplicateCount: 0,
          warningCount: 0,
          reason: "No job sources are configured for this campaign.",
        }],
        startedAt,
        completedAt: this.now(),
        receivedCount: 0,
        normalizedCount: 0,
        duplicateCount: 0,
      };
    }

    const fanoutStartedAt = this.now();
    const fanoutMonotonicStartedAt = monotonicNow();
    const sourceResults: SourceDiscoveryResult[] = await mapWithConcurrencyLimit(
      campaign.searchSources,
      this.maxConcurrentSources,
      async (sourceId): Promise<SourceDiscoveryResult> => {
        const sourceStartedAt = this.now();
        const monotonicStartedAt = monotonicNow();
        const finish = (result: SourceDiscoveryResult): SourceDiscoveryResult => ({
          ...result,
          executionNode: createExecutionNodeTrace({
            nodeId: `scout.source.${sourceId}`,
            nodeKind: "external_io",
            startedAt: sourceStartedAt,
            completedAt: this.now(),
            durationMs: monotonicNow() - monotonicStartedAt,
            outcome: sourceTraceOutcome(result),
            inputCount: 1,
            outputCount: result.listings.length,
            ...(result.cached !== undefined ? { cacheHit: result.cached } : {}),
            ...(sourceFailureReason(result) ? { failureReason: sourceFailureReason(result) } : {}),
            ...sourceExternalMetrics(result),
            parentNodeId: "scout.source-fanout",
            metadata: {
              sourceId,
              stage: `scout.source.${sourceId}`,
              status: result.status ?? (result.failure ? "failed" : "success"),
              warningCount: String(result.warnings.length),
            },
          }),
        });

        const source = this.sources[sourceId];
        if (!source) {
          return finish({
            sourceId,
            source: undefined,
            listings: [] as readonly JobSourceListing[],
            warnings: [] as readonly string[],
            referenceMetrics: undefined,
            failure: `Job source ${sourceId} is not configured.`,
          });
        }

        try {
          const response = await withTimeout(
            source.discover(campaign.searchCriteria, {
              now: startedAt,
              maxResults: this.maxResultsPerSource,
            }),
            this.timeoutMs,
            `Job source ${sourceId} timed out after ${this.timeoutMs}ms.`,
          );
          const listings = isJobSourceBatch(response) ? response.listings : response;
          const warnings = isJobSourceBatch(response)
            ? (response.warnings ?? []).filter((warning): warning is string => typeof warning === "string" && warning.trim().length > 0)
            : [];
          const status = isJobSourceBatch(response) ? response.status : undefined;
          const reason = isJobSourceBatch(response) && typeof response.reason === "string" ? response.reason : undefined;
          const sourceReferenceMetrics = isJobSourceBatch(response) ? response.referenceMetrics : undefined;
          const cached = isJobSourceBatch(response) ? response.cached : undefined;
          const sourceFetchedAt = isJobSourceBatch(response) ? response.sourceFetchedAt : undefined;
          if (!Array.isArray(listings)) {
            return finish({
              sourceId,
              source,
              listings: [] as readonly JobSourceListing[],
              warnings,
              status,
              reason,
              ...(cached !== undefined ? { cached } : {}),
              ...(sourceFetchedAt ? { sourceFetchedAt } : {}),
              referenceMetrics: sourceReferenceMetrics,
              ...(isJobSourceBatch(response) && response.executionNodes ? { executionNodes: response.executionNodes } : {}),
              failure: "Job source returned a malformed listing collection.",
            });
          }
          return finish({
            sourceId,
            source,
            listings: listings.slice(0, this.maxResultsPerSource),
            warnings,
            status,
            reason,
            referenceMetrics: sourceReferenceMetrics,
            ...(isJobSourceBatch(response) && response.executionNodes ? { executionNodes: response.executionNodes } : {}),
            ...(cached !== undefined ? { cached } : {}),
            ...(sourceFetchedAt ? { sourceFetchedAt } : {}),
          });
        } catch (error) {
          return finish({
            sourceId,
            source,
            listings: [] as readonly JobSourceListing[],
            warnings: [] as readonly string[],
            referenceMetrics: undefined,
            failure: error instanceof Error ? error.message : "Job source failed.",
          });
        }
      },
    );

    const fanoutNode = createExecutionNodeTrace({
      nodeId: "scout.source-fanout",
      nodeKind: "external_io",
      startedAt: fanoutStartedAt,
      completedAt: this.now(),
      durationMs: monotonicNow() - fanoutMonotonicStartedAt,
      outcome: sourceResults.some((result) => sourceTraceOutcome(result) === "failed") ||
        sourceResults.some((result) => sourceTraceOutcome(result) === "partial") ? "partial" : "success",
      inputCount: campaign.searchSources.length,
      outputCount: sourceResults.length,
      parentNodeId: "scout.fetch-and-reduce",
      metadata: {
        stage: "scout.source-fanout",
        sourceCount: String(sourceResults.length),
      },
    });

    const reductionStartedAt = this.now();
    const reductionMonotonicStartedAt = monotonicNow();

    for (const result of sourceResults) {
      const mode = sourceModeFor(result.source ?? { mode: undefined }, result.listings[0]);
      referenceMetrics = addReferenceMetrics(referenceMetrics, result.referenceMetrics);
      if (result.failure || result.status === "failed" || result.status === "not_configured") {
        const reason = result.failure ?? result.reason ?? `Job source ${result.sourceId} is ${result.status ?? "failed"}.`;
        failures.push({ sourceId: result.sourceId, reason, kind: "source" });
        sourceSummaries.push({
          sourceId: result.sourceId,
          mode,
          status: result.status === "not_configured" ? "not_configured" : "failed",
          receivedCount: 0,
          normalizedCount: 0,
          duplicateCount: 0,
          warningCount: result.warnings.length,
          reason,
        });
        continue;
      }

      if (result.status === "partial") {
        failures.push({
          sourceId: result.sourceId,
          reason: result.reason ?? `Job source ${result.sourceId} returned a partial discovery result.`,
          kind: "source",
        });
      }

      receivedCount += result.listings.length;
      let sourceNormalizedCount = 0;
      let sourceDuplicateCount = 0;
      let sourceWarningCount = result.warnings.length;
      for (const warning of result.warnings) {
        failures.push({ sourceId: result.sourceId, reason: warning, kind: "listing" });
      }

      for (const listing of result.listings) {
        try {
          if (!listing || typeof listing !== "object" || !listing.input || typeof listing.input !== "object") {
            throw new Error("Listing does not contain a valid intake payload.");
          }
          const discoveredAt = listing.discoveredAt ?? startedAt;
          const job = normalizeJobPosting(listing.input, discoveredAt);
          const sourceMode = sourceModeFor(result.source ?? { mode: undefined }, listing);
          const sourceId = listing.sourceId?.trim() || result.sourceId;
          const dedupeKeys = jobDedupeKeys(job, listing.sourceRecordId, sourceId);
          let actionability: JobActionability = listing.actionability ?? "discoverable_only";
          if (listing.actionability === undefined && result.source?.classifyActionability) {
            const classified = result.source.classifyActionability(job, listing);
            if (classified !== "actionable" && classified !== "discoverable_only") {
              throw new Error("Source returned an invalid actionability state.");
            }
            actionability = classified;
          }
          sourceNormalizedCount += 1;
          const candidate: ScoutedJob = {
            sourceId,
            sourceMode,
            actionability,
            ...(listing.sourceRecordId ? { sourceRecordId: listing.sourceRecordId } : {}),
            ...(listing.sourcePublishedAt ? { sourcePublishedAt: listing.sourcePublishedAt } : {}),
            isExample: listing.input.isExample === true,
            job,
            discoveredAt,
            fingerprint: jobFingerprint(job, listing.sourceRecordId, sourceId),
            dedupeKeys,
            sourceObservations: [{
              sourceId,
              mode: sourceMode,
              actionability,
              ...(listing.sourceRecordId ? { sourceRecordId: listing.sourceRecordId } : {}),
              ...(job.sourceUrl ? { sourceUrl: job.sourceUrl } : {}),
              ...(job.applicationUrl ? { applicationUrl: job.applicationUrl } : {}),
              observedAt: discoveredAt,
            }],
          };
          const duplicateIndex = jobs.findIndex((existing) => jobKeysMatch(
            candidate.sourceId,
            candidate.dedupeKeys,
            candidate.sourceMode,
            existing.sourceId,
            existing.dedupeKeys,
            existing.sourceMode,
          ));
          if (duplicateIndex !== -1) {
            duplicateCount += 1;
            sourceDuplicateCount += 1;
            jobs[duplicateIndex] = mergeScoutedJobs(jobs[duplicateIndex], candidate);
            continue;
          }
          jobs.push(candidate);
        } catch (error) {
          sourceWarningCount += 1;
          failures.push({
            sourceId: result.sourceId,
            reason: error instanceof Error ? `Malformed listing: ${error.message}` : "Malformed listing.",
            kind: "listing",
          });
        }
      }

      const status: DiscoveryStatus = result.status === "partial" || sourceWarningCount > 0
        ? "partial"
        : result.status ?? (result.listings.length > 0 ? "success" : "empty");
      sourceSummaries.push({
        sourceId: result.sourceId,
        mode,
        status,
        receivedCount: result.listings.length,
        normalizedCount: sourceNormalizedCount,
        duplicateCount: sourceDuplicateCount,
        warningCount: sourceWarningCount,
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.cached !== undefined ? { cached: result.cached } : {}),
          ...(result.sourceFetchedAt ? { sourceFetchedAt: result.sourceFetchedAt } : {}),
        });
      normalizedCount += sourceNormalizedCount;
    }

    const completedAt = this.now();
    const reductionNode = createExecutionNodeTrace({
      nodeId: "scout.reduce",
      nodeKind: "deterministic",
      startedAt: reductionStartedAt,
      completedAt,
      durationMs: monotonicNow() - reductionMonotonicStartedAt,
      outcome: failures.length > 0 ? (jobs.length > 0 ? "partial" : "failed") : "success",
      inputCount: sourceResults.reduce((total, result) => total + result.listings.length, 0),
      outputCount: jobs.length,
      parentNodeId: "scout.fetch-and-reduce",
      metadata: {
        stage: "scout.reduce",
        sourceCount: String(sourceResults.length),
        failureCount: String(failures.length),
        duplicateCount: String(duplicateCount),
      },
    });

    return {
      jobs,
      failures,
      sourceSummaries,
      startedAt,
      completedAt,
      receivedCount,
      normalizedCount,
      duplicateCount,
      executionNodes: [
        fanoutNode,
        ...sourceResults.flatMap((result) => result.executionNodes ?? []),
        ...sourceResults.flatMap((result) => result.executionNode ? [result.executionNode] : []),
        reductionNode,
      ],
      ...(referenceMetrics ? { referenceMetrics } : {}),
    };
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Explicitly local/demo source. It must never be described as live discovery. */
export class StaticJobSource implements JobSource {
  public readonly mode = "demo" as const;

  constructor(
    public readonly id: string,
    private readonly listings: readonly JobSourceListing[],
  ) {}

  async discover(_criteria: SearchCriteria): Promise<readonly JobSourceListing[]> {
    return this.listings.map((listing) => ({ ...listing, input: { ...listing.input }, sourceMode: "demo" }));
  }
}
