import type {
  DiscoveryQueryMetrics,
  DiscoveryStatus,
  JobSourceMode,
  ScoutReferenceMetrics,
  SearchCriteria,
} from "./campaignTypes";
import type { DiscoveryContext } from "./scout";
import { canonicalJobUrl } from "./scout";

export const BRAVE_SEARCH_DISCOVERY_ID = "brave-search-live";

/** A source-neutral pointer discovered before a full posting is resolved. */
export interface DiscoveredJobReference {
  discoveredUrl: string;
  titleHint?: string;
  companyHint?: string;
  sourceProvider: string;
  discoveredAt: string;
  /** The bounded provider query that produced this reference, when available. */
  query?: string;
  evidence?: readonly string[];
}

/** Provider-level evidence; provider-specific response records do not cross this boundary. */
export interface JobDiscoveryMetrics {
  providerResults: number;
  acceptedReferences: number;
  rejectedReferences: number;
  duplicateReferences: number;
  queriesExecuted: number;
  queryMetrics: readonly DiscoveryQueryMetrics[];
}

/**
 * Ratios derived from one observed reference sample. They intentionally stay
 * separate from persisted counters so older summaries remain compatible and
 * callers cannot mistake them for labor-market-wide statistics.
 */
export interface DiscoveryCoverageRatios {
  knownAtsClassificationRate?: number;
  structuredResolutionRate?: number;
  knownUnsupportedRate?: number;
  fallbackRequiredRate?: number;
}

export function discoveryCoverageRatios(metrics: ScoutReferenceMetrics): DiscoveryCoverageRatios {
  // Classifications are counted after malformed references and duplicate
  // URLs are removed. Use that observed classified sample as the denominator
  // so rejected input cannot make coverage look artificially worse.
  const classifiedReferences = metrics.knownAtsReferences + metrics.unknownOrCustomReferences;
  const denominator = classifiedReferences > 0 ? classifiedReferences : metrics.referencesDiscovered;
  if (denominator <= 0) return {};
  const fallbackRequired = metrics.fallbackRequiredReferences ?? metrics.unknownOrCustomReferences;
  return {
    knownAtsClassificationRate: metrics.knownAtsReferences / denominator,
    structuredResolutionRate: metrics.structuredJobsResolved / denominator,
    knownUnsupportedRate: metrics.knownUnsupportedReferences / denominator,
    fallbackRequiredRate: fallbackRequired / denominator,
  };
}

/** Narrow request accepted by the local server-side broad-discovery boundary. */
export interface JobDiscoveryHostRequest {
  criteria: SearchCriteria;
  maxResults?: number;
  now?: string;
}

export interface JobDiscoveryBatch {
  references: readonly DiscoveredJobReference[];
  warnings?: readonly string[];
  status?: DiscoveryStatus;
  reason?: string;
  metrics?: JobDiscoveryMetrics;
  cached?: boolean;
  sourceFetchedAt?: string;
}

export type JobDiscoveryResponse = readonly DiscoveredJobReference[] | JobDiscoveryBatch;

export interface JobDiscoveryProvider {
  id: string;
  mode?: JobSourceMode;
  discover(criteria: SearchCriteria, context?: DiscoveryContext): Promise<JobDiscoveryResponse>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function validTimestamp(value: unknown): string | undefined {
  const timestamp = nonEmptyString(value);
  return timestamp && !Number.isNaN(Date.parse(timestamp)) ? timestamp : undefined;
}

function isDiscoveryStatus(value: unknown): value is DiscoveryStatus {
  return value === "success" || value === "empty" || value === "partial" || value === "failed" || value === "not_configured";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isSearchCriteria(value: unknown): value is SearchCriteria {
  if (!isRecord(value)) return false;
  return isStringArray(value.roleLanes) &&
    (value.searchQueries === undefined || isStringArray(value.searchQueries)) &&
    isStringArray(value.locations) &&
    typeof value.remoteOnly === "boolean" &&
    isStringArray(value.employmentTypes) &&
    (value.minimumSalary === undefined || (typeof value.minimumSalary === "number" && Number.isFinite(value.minimumSalary) && value.minimumSalary >= 0)) &&
    isStringArray(value.excludedSeniorities) &&
    (value.excludedTitleTerms === undefined || isStringArray(value.excludedTitleTerms)) &&
    isStringArray(value.excludedCompanies);
}

export function isJobDiscoveryHostRequest(value: unknown): value is JobDiscoveryHostRequest {
  if (!isRecord(value) || !isSearchCriteria(value.criteria)) return false;
  const validMaxResults = value.maxResults === undefined ||
    (typeof value.maxResults === "number" && Number.isInteger(value.maxResults) && value.maxResults > 0 && value.maxResults <= 200);
  const validNow = value.now === undefined || validTimestamp(value.now) !== undefined;
  return validMaxResults && validNow;
}

function isDiscoveryQueryMetrics(value: unknown): value is DiscoveryQueryMetrics {
  if (!isRecord(value)) return false;
  return nonEmptyString(value.query) !== undefined &&
    isNonNegativeInteger(value.providerResults) &&
    isNonNegativeInteger(value.acceptedReferences) &&
    isNonNegativeInteger(value.rejectedReferences) &&
    isNonNegativeInteger(value.duplicateReferences) &&
    isDiscoveryStatus(value.status);
}

function normalizeDiscoveryMetrics(value: unknown): JobDiscoveryMetrics | undefined {
  if (!isRecord(value) ||
    !isNonNegativeInteger(value.providerResults) ||
    !isNonNegativeInteger(value.acceptedReferences) ||
    !isNonNegativeInteger(value.rejectedReferences) ||
    !isNonNegativeInteger(value.duplicateReferences) ||
    !isNonNegativeInteger(value.queriesExecuted) ||
    !Array.isArray(value.queryMetrics) ||
    !value.queryMetrics.every(isDiscoveryQueryMetrics)) {
    return undefined;
  }
  return {
    providerResults: value.providerResults,
    acceptedReferences: value.acceptedReferences,
    rejectedReferences: value.rejectedReferences,
    duplicateReferences: value.duplicateReferences,
    queriesExecuted: value.queriesExecuted,
    queryMetrics: value.queryMetrics.map((metric) => ({ ...metric, query: metric.query.trim() })),
  };
}

/** Validate one untrusted discovery reference without filling missing posting facts. */
export function validateDiscoveredJobReference(value: unknown): DiscoveredJobReference | null {
  if (!isRecord(value)) return null;
  const discoveredUrl = nonEmptyString(value.discoveredUrl);
  const sourceProvider = nonEmptyString(value.sourceProvider);
  const discoveredAt = validTimestamp(value.discoveredAt);
  if (!discoveredUrl || !sourceProvider || !discoveredAt || !canonicalJobUrl(discoveredUrl)) return null;

  const evidence = Array.isArray(value.evidence)
    ? value.evidence.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : undefined;
  return {
    discoveredUrl,
    ...(nonEmptyString(value.titleHint) ? { titleHint: nonEmptyString(value.titleHint) } : {}),
    ...(nonEmptyString(value.companyHint) ? { companyHint: nonEmptyString(value.companyHint) } : {}),
    sourceProvider,
    discoveredAt,
    ...(nonEmptyString(value.query) ? { query: nonEmptyString(value.query) } : {}),
    ...(evidence && evidence.length > 0 ? { evidence: [...new Set(evidence)] } : {}),
  };
}

/** Normalize a provider response and isolate malformed references as warnings. */
export function parseJobDiscoveryResponse(
  payload: unknown,
  providerId: string,
  fallbackDiscoveredAt: string,
  maxResults: number,
): JobDiscoveryBatch {
  if (!Number.isInteger(maxResults) || maxResults <= 0) {
    throw new Error("Job discovery result cap must be a positive integer.");
  }
  if (!isRecord(payload) && !Array.isArray(payload)) {
    throw new Error("Job discovery provider returned a malformed reference collection.");
  }

  const rawReferences = Array.isArray(payload) ? payload : payload.references;
  if (!Array.isArray(rawReferences)) {
    throw new Error("Job discovery provider did not return a references array.");
  }

  const provider = nonEmptyString(providerId);
  if (!provider) throw new Error("Job discovery provider id is required.");
  const fallback = validTimestamp(fallbackDiscoveredAt);
  if (!fallback) throw new Error("Job discovery timestamp is invalid.");

  const warnings: string[] = [];
  const references: DiscoveredJobReference[] = [];
  for (const [index, raw] of rawReferences.entries()) {
    const normalized = validateDiscoveredJobReference({
      ...(isRecord(raw) ? raw : {}),
      sourceProvider: isRecord(raw) && nonEmptyString(raw.sourceProvider) ? raw.sourceProvider : provider,
      discoveredAt: isRecord(raw) && validTimestamp(raw.discoveredAt) ? raw.discoveredAt : fallback,
    });
    if (!normalized) {
      warnings.push(`Skipped discovered job reference at index ${index}: required URL or metadata was malformed.`);
      continue;
    }
    references.push(normalized);
  }

  const capped = references.slice(0, maxResults);
  if (references.length > capped.length) {
    warnings.push(`Discovery provider result cap applied: retained ${capped.length} of ${references.length} references.`);
  }
  const metrics = isRecord(payload) ? normalizeDiscoveryMetrics(payload.metrics) : undefined;
  if (isRecord(payload) && payload.metrics !== undefined && !metrics) {
    warnings.push("Discovery provider metrics were malformed and were omitted.");
  }
  const status = isRecord(payload) && isDiscoveryStatus(payload.status) ? payload.status : undefined;
  if (isRecord(payload) && payload.status !== undefined && !status) {
    warnings.push("Discovery provider status was malformed and was omitted.");
  }
  const reason = isRecord(payload) ? nonEmptyString(payload.reason) : undefined;
  const cached = isRecord(payload) && typeof payload.cached === "boolean" ? payload.cached : undefined;
  const sourceFetchedAt = isRecord(payload) ? validTimestamp(payload.sourceFetchedAt) : undefined;
  if (isRecord(payload) && payload.cached !== undefined && cached === undefined) {
    warnings.push("Discovery cache metadata was malformed and was omitted.");
  }
  if (isRecord(payload) && payload.sourceFetchedAt !== undefined && sourceFetchedAt === undefined) {
    warnings.push("Discovery source freshness metadata was malformed and was omitted.");
  }
  return {
    references: capped,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(status ? { status } : {}),
    ...(reason ? { reason } : {}),
    ...(metrics ? { metrics } : {}),
    ...(cached !== undefined ? { cached } : {}),
    ...(sourceFetchedAt ? { sourceFetchedAt } : {}),
  };
}

/** Explicit deterministic provider for offline demos and resolver tests. */
export class StaticJobDiscoveryProvider implements JobDiscoveryProvider {
  public readonly mode = "demo" as const;

  constructor(
    public readonly id: string,
    private readonly references: readonly DiscoveredJobReference[],
  ) {}

  async discover(_criteria: SearchCriteria, context?: DiscoveryContext): Promise<JobDiscoveryBatch> {
    const now = context?.now ?? new Date().toISOString();
    const maxResults = context?.maxResults ?? (this.references.length || 1);
    return parseJobDiscoveryResponse(
      this.references.map((reference) => ({ ...reference })),
      this.id,
      now,
      maxResults,
    );
  }
}
