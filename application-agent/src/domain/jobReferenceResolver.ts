import { normalizeJobPosting } from "./job";
import type { JobActionability, JobSourceMode, ScoutReferenceMetrics, SearchCriteria } from "./campaignTypes";
import {
  type DiscoveredJobReference,
  type JobDiscoveryProvider,
  type JobDiscoveryMetrics,
  parseJobDiscoveryResponse,
} from "./jobDiscovery";
import { classifyJobUrl, type AtsClassificationKind, type JobUrlClassification } from "./jobUrlClassifier";
import {
  canonicalJobUrl,
  type DiscoveryContext,
  type JobSource,
  type JobSourceBatch,
  type JobSourceListing,
  type JobSourceResponse,
} from "./scout";
import { mapWithConcurrencyLimit } from "./concurrency";
import { createExecutionNodeTrace, monotonicNow } from "./executionTrace";

export type ReferenceResolutionStatus = "resolved" | "known_unsupported" | "fallback_required" | "invalid";

export interface JobReferenceResolution {
  status: ReferenceResolutionStatus;
  reference: DiscoveredJobReference;
  classification: JobUrlClassification;
  sourceId?: string;
  listing?: JobSourceListing;
  reason: string;
  /** True when a configured structured source failed rather than simply finding no match. */
  sourceFailure?: boolean;
  /** Internal source handle used only to apply source-owned actionability rules. */
  source?: JobSource;
}

export interface JobReferenceResolverOptions {
  /**
   * Optional factory for live references whose board/site was discovered at
   * runtime. The factory receives only deterministic classifier evidence; it
   * must return a provider-specific structured source or undefined.
   */
  createSource?: (classification: JobUrlClassification) => JobSource | undefined;
  /** Bounds independent reference resolutions while preserving input order. */
  maxConcurrentReferences?: number;
}

function sourceKind(value: JobSource): AtsClassificationKind | undefined {
  const id = value.id.toLowerCase();
  if (id.startsWith("lever:")) return "lever";
  if (id.startsWith("greenhouse:")) return "greenhouse";
  if (typeof (value as JobSource & { site?: unknown }).site === "string") return "lever";
  if (typeof (value as JobSource & { board?: unknown }).board === "string") return "greenhouse";
  return undefined;
}

function sourceConfiguredIdentifier(source: JobSource, kind: AtsClassificationKind): string | undefined {
  const configured = kind === "lever"
    ? (source as JobSource & { site?: unknown }).site
    : kind === "greenhouse"
      ? (source as JobSource & { board?: unknown }).board
      : undefined;
  if (typeof configured === "string" && configured.trim()) return configured.trim().toLowerCase();
  const prefix = `${kind}:`;
  return source.id.toLowerCase().startsWith(prefix)
    ? source.id.slice(prefix.length).trim().toLowerCase()
    : undefined;
}

function sourceMatches(source: JobSource, classification: JobUrlClassification): boolean {
  const kind = sourceKind(source);
  if (!kind || kind !== classification.kind || !classification.siteIdentifier) return false;
  return sourceConfiguredIdentifier(source, kind) === classification.siteIdentifier.toLowerCase();
}

function isBatch(value: readonly JobSourceListing[] | JobSourceBatch): value is JobSourceBatch {
  return !Array.isArray(value);
}

function listingMatches(
  listing: JobSourceListing,
  reference: DiscoveredJobReference,
  classification: JobUrlClassification,
): boolean {
  if (classification.postingIdentifier && listing.sourceRecordId === classification.postingIdentifier) return true;
  const referenceUrl = canonicalJobUrl(reference.discoveredUrl);
  if (!referenceUrl) return false;
  return [listing.input.sourceUrl, listing.input.applicationUrl]
    .map(canonicalJobUrl)
    .some((url) => url === referenceUrl);
}

export class JobReferenceResolver {
  private readonly sources: readonly JobSource[];
  private readonly createSource?: JobReferenceResolverOptions["createSource"];
  private readonly maxConcurrentReferences: number;

  constructor(
    sources: readonly JobSource[] | Readonly<Record<string, JobSource>>,
    options: JobReferenceResolverOptions = {},
  ) {
    this.sources = Array.isArray(sources) ? sources : Object.values(sources);
    this.createSource = options.createSource;
    this.maxConcurrentReferences = options.maxConcurrentReferences ?? 4;
    if (!Number.isInteger(this.maxConcurrentReferences) || this.maxConcurrentReferences <= 0) {
      throw new Error("Reference resolver concurrency limit must be a positive integer.");
    }
  }

  async resolve(
    reference: DiscoveredJobReference,
    criteria: SearchCriteria,
    context: DiscoveryContext,
    responseCache: Map<string, Promise<JobSourceResponse>> = new Map(),
  ): Promise<JobReferenceResolution> {
    const classification = classifyJobUrl(reference.discoveredUrl);
    if (classification.kind === "unknown") {
      return {
        status: "invalid",
        reference,
        classification,
        reason: "The discovered reference is not a valid URL that can be resolved.",
      };
    }
    if (classification.kind === "ashby" || classification.kind === "workday") {
      return {
        status: "known_unsupported",
        reference,
        classification,
        reason: `${classification.kind} was recognized, but no structured adapter is implemented yet.`,
      };
    }
    if (classification.kind === "custom") {
      return {
        status: "fallback_required",
        reference,
        classification,
        reason: "The reference is a custom career page; a future targeted extractor is required.",
      };
    }

    const candidates = this.sources.filter((source) => sourceMatches(source, classification));
    if (candidates.length === 0 && this.createSource) {
      const discoveredSource = this.createSource(classification);
      if (discoveredSource && sourceMatches(discoveredSource, classification)) candidates.push(discoveredSource);
    }
    if (candidates.length === 0) {
      return {
        status: "fallback_required",
        reference,
        classification,
        reason: `No configured ${classification.kind} board matched the discovered reference.`,
      };
    }

    for (const source of candidates) {
      try {
        let responsePromise = responseCache.get(source.id);
        if (!responsePromise) {
          responsePromise = Promise.resolve().then(() => source.discover(criteria, context));
          responseCache.set(source.id, responsePromise);
        }
        const response = await responsePromise;
        const listings = isBatch(response) ? response.listings : response;
        const listing = listings.find((candidate) => listingMatches(candidate, reference, classification));
        if (listing) {
          return {
            status: "resolved",
            reference,
            classification,
            sourceId: source.id,
            listing,
            source,
            reason: `Resolved through the configured ${classification.kind} structured source.`,
          };
        }
      } catch (error) {
        return {
          status: "fallback_required",
          reference,
          classification,
          sourceId: source.id,
          reason: error instanceof Error
            ? `${source.id} failed while resolving the reference: ${error.message}`
            : `${source.id} failed while resolving the reference.`,
          sourceFailure: true,
        };
      }
    }

    return {
      status: "fallback_required",
      reference,
      classification,
      reason: `The configured ${classification.kind} source did not return the referenced posting.`,
    };
  }

  async resolveMany(
    references: readonly DiscoveredJobReference[],
    criteria: SearchCriteria,
    context: DiscoveryContext,
  ): Promise<readonly JobReferenceResolution[]> {
    const responseCache = new Map<string, Promise<JobSourceResponse>>();
    return mapWithConcurrencyLimit(
      references,
      this.maxConcurrentReferences,
      (reference) => this.resolve(reference, criteria, context, responseCache),
    );
  }
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

function classificationMetrics(classification: JobUrlClassification): Partial<ScoutReferenceMetrics> {
  switch (classification.kind) {
    case "lever": return { knownAtsReferences: 1, leverReferences: 1 };
    case "greenhouse": return { knownAtsReferences: 1, greenhouseReferences: 1 };
    case "ashby": return { knownAtsReferences: 1, knownUnsupportedReferences: 1, ashbyReferences: 1 };
    case "workday": return { knownAtsReferences: 1, knownUnsupportedReferences: 1, workdayReferences: 1 };
    case "custom": return { unknownOrCustomReferences: 1, customReferences: 1 };
    default: return { unknownOrCustomReferences: 1, unknownReferences: 1 };
  }
}

function incrementMetrics(
  metrics: ScoutReferenceMetrics,
  changes: Partial<ScoutReferenceMetrics>,
): ScoutReferenceMetrics {
  const next = { ...metrics };
  for (const [key, value] of Object.entries(changes) as Array<[keyof ScoutReferenceMetrics, number | undefined]>) {
    if (value === undefined) continue;
    const current = next[key];
    (next as Record<keyof ScoutReferenceMetrics, number | readonly unknown[] | undefined>)[key] =
      typeof current === "number" ? current + value : value;
  }
  return next;
}

function discoveryMetricsAsReferenceMetrics(metrics: JobDiscoveryMetrics): Partial<ScoutReferenceMetrics> {
  return {
    providerResults: metrics.providerResults,
    acceptedReferences: metrics.acceptedReferences,
    rejectedReferences: metrics.rejectedReferences,
    duplicateReferences: metrics.duplicateReferences,
    queriesExecuted: metrics.queriesExecuted,
    queryMetrics: metrics.queryMetrics,
  };
}

/**
 * Bridges URL discovery to the existing JobSource/JobScout pipeline. It keeps
 * provider-specific records inside the resolver and returns only generic
 * intake listings with the structured adapter's source identity attached.
 */
export class JobReferenceSource implements JobSource {
  public readonly id: string;
  public readonly mode: JobSourceMode;

  constructor(
    private readonly provider: JobDiscoveryProvider,
    private readonly resolver: JobReferenceResolver,
  ) {
    this.id = `references:${provider.id}`;
    this.mode = provider.mode ?? "live";
  }

  async discover(criteria: SearchCriteria, context?: DiscoveryContext): Promise<JobSourceBatch> {
    const now = context?.now ?? new Date().toISOString();
    const maxResults = context?.maxResults ?? 50;
    const response = await this.provider.discover(criteria, context);
    const normalized = parseJobDiscoveryResponse(response, this.provider.id, now, maxResults);
    const warnings = [...(normalized.warnings ?? [])];
    let metrics = emptyReferenceMetrics();
    if (normalized.metrics) {
      metrics = {
        ...metrics,
        ...discoveryMetricsAsReferenceMetrics(normalized.metrics),
      };
    }
    metrics = incrementMetrics(metrics, { referencesDiscovered: normalized.references.length });
    const listings: JobSourceListing[] = [];
    const seenUrls = new Set<string>();

    const uniqueReferences: DiscoveredJobReference[] = [];
    for (const reference of normalized.references) {
      const classification = classifyJobUrl(reference.discoveredUrl);
      const canonical = classification.canonicalUrl ?? canonicalJobUrl(reference.discoveredUrl);
      if (canonical && seenUrls.has(canonical)) {
        metrics = incrementMetrics(metrics, { duplicatesRemoved: 1 });
        continue;
      }
      if (canonical) seenUrls.add(canonical);
      uniqueReferences.push(reference);
    }

    const resolutionStartedAt = now;
    const resolutionMonotonicStartedAt = monotonicNow();
    const resolutions = await this.resolver.resolveMany(uniqueReferences, criteria, {
      now,
      maxResults,
      ...(context?.searchIntent ? { searchIntent: context.searchIntent } : {}),
      ...(context?.searchPlan ? { searchPlan: context.searchPlan } : {}),
    });
    const resolutionNode = createExecutionNodeTrace({
      nodeId: `scout.reference-resolution.${this.id}`,
      nodeKind: "external_io",
      startedAt: resolutionStartedAt,
      completedAt: new Date().toISOString(),
      durationMs: monotonicNow() - resolutionMonotonicStartedAt,
      outcome: resolutions.some((resolution) => resolution.sourceFailure)
        ? resolutions.some((resolution) => resolution.status === "resolved") ? "partial" : "failed"
        : "success",
      parentNodeId: `scout.source.${this.id}`,
      inputCount: uniqueReferences.length,
      outputCount: resolutions.filter((resolution) => resolution.status === "resolved").length,
      metadata: {
        stage: "scout.reference-resolution",
        sourceId: this.id,
        referenceCount: String(uniqueReferences.length),
      },
    });

    const leverSites = new Set<string>();
    const greenhouseBoards = new Set<string>();
    for (const [index, reference] of uniqueReferences.entries()) {
      const classification = classifyJobUrl(reference.discoveredUrl);
      metrics = incrementMetrics(metrics, classificationMetrics(classification));
      if (classification.kind === "lever" && classification.siteIdentifier) leverSites.add(classification.siteIdentifier.toLowerCase());
      if (classification.kind === "greenhouse" && classification.siteIdentifier) greenhouseBoards.add(classification.siteIdentifier.toLowerCase());

      const resolution = resolutions[index];
      if (resolution.status !== "resolved" || !resolution.listing || !resolution.sourceId) {
        warnings.push(`${reference.discoveredUrl}: ${resolution.reason}`);
        if (resolution.status === "fallback_required") {
          metrics = incrementMetrics(metrics, { fallbackRequiredReferences: 1 });
        } else if (resolution.status === "invalid") {
          metrics = incrementMetrics(metrics, { invalidReferences: 1 });
        }
        if (resolution.sourceFailure) {
          metrics = incrementMetrics(metrics, { sourceFailures: 1, failedReferences: 1 });
        }
        continue;
      }

      const listing: JobSourceListing = {
        ...resolution.listing,
        sourceId: resolution.sourceId,
        sourceMode: this.mode,
        ...(reference.query
          ? { searchQueries: [...new Set([...(resolution.listing.searchQueries ?? []), reference.query])] }
          : {}),
      };
      if (resolution.source?.classifyActionability) {
        try {
          const normalizedJob = normalizeJobPosting(listing.input, listing.discoveredAt ?? now);
          const actionability = resolution.source.classifyActionability(normalizedJob, listing);
          if (actionability !== "actionable" && actionability !== "discoverable_only") {
            warnings.push(`${reference.discoveredUrl}: structured source returned an invalid actionability state.`);
            continue;
          }
          listing.actionability = actionability as JobActionability;
        } catch (error) {
          warnings.push(`${reference.discoveredUrl}: could not validate the resolved posting before routing (${error instanceof Error ? error.message : "invalid posting"}).`);
          continue;
        }
      }
      listings.push(listing);
      metrics = incrementMetrics(metrics, { structuredJobsResolved: 1 });
    }

    metrics = {
      ...metrics,
      ...(normalized.metrics?.queryMetrics ? { queryMetrics: normalized.metrics.queryMetrics } : {}),
      uniqueLeverSites: leverSites.size,
      uniqueGreenhouseBoards: greenhouseBoards.size,
      leverSiteIdentities: [...leverSites],
      greenhouseBoardIdentities: [...greenhouseBoards],
    };
    const failedQueries = normalized.metrics?.queryMetrics.filter((metric) => metric.status === "failed").length ?? 0;
    if (failedQueries > 0) {
      metrics = incrementMetrics(metrics, { sourceFailures: failedQueries });
    } else if (normalized.status === "failed" || normalized.status === "not_configured") {
      metrics = incrementMetrics(metrics, { sourceFailures: 1 });
    }

    return {
      listings,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(normalized.status ? { status: normalized.status } : {}),
      ...(normalized.reason ? { reason: normalized.reason } : {}),
      ...(normalized.cached !== undefined ? { cached: normalized.cached } : {}),
      ...(normalized.sourceFetchedAt ? { sourceFetchedAt: normalized.sourceFetchedAt } : {}),
      executionNodes: [resolutionNode],
      referenceMetrics: metrics,
    };
  }
}

export const ReferenceResolvingJobSource = JobReferenceSource;
