import type {
  DiscoveryQueryMetrics,
  DiscoveryStatus,
  SearchCriteria,
} from "./campaignTypes";
import {
  BRAVE_SEARCH_DISCOVERY_ID,
  type DiscoveredJobReference,
  type JobDiscoveryBatch,
  type JobDiscoveryMetrics,
  type JobDiscoveryProvider,
} from "./jobDiscovery";
import { canonicalJobUrl, type DiscoveryContext } from "./scout";

export { BRAVE_SEARCH_DISCOVERY_ID } from "./jobDiscovery";
export const DEFAULT_BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface BraveSearchDiscoveryProviderOptions {
  /** Kept out of the browser bundle; the configured local host owns this value. */
  apiKey?: string;
  endpoint?: string;
  fetcher?: Fetcher;
  now?: () => string;
  maxQueries?: number;
  maxResultsPerQuery?: number;
  maxTotalReferences?: number;
  /** Short in-memory reuse window; set to 0 to disable caching. */
  cacheTtlMs?: number;
  timeoutMs?: number;
  country?: string;
  searchLanguage?: string;
  id?: string;
}

export interface BraveSearchWebResult {
  title?: string;
  url: string;
  description?: string;
}

export interface ParsedBraveSearchResponse {
  results: readonly BraveSearchWebResult[];
  rawResultCount: number;
  warnings: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
  return value;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const resolved = positiveInteger(value, fallback, label);
  if (resolved < minimum || resolved > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return resolved;
}

function normalizedEndpoint(value: string | undefined): string {
  const endpoint = value?.trim() || DEFAULT_BRAVE_SEARCH_ENDPOINT;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Brave Search endpoint must be a valid HTTPS URL.");
  }
  if (url.protocol !== "https:") throw new Error("Brave Search endpoint must use HTTPS.");
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function normalizedTerm(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function hasJobWord(value: string): boolean {
  return /\b(job|jobs|career|careers|hiring|opening|openings|position|role|roles)\b/i.test(value);
}

type SearchLaneBucket = "primary" | "secondary" | "adjacent" | "other";

function searchLaneBucket(value: string): SearchLaneBucket {
  if (/\b(frontend|front-end|react|typescript|full[- ]?stack)\b/i.test(value)) return "secondary";
  if (/\b(ai|agent|applied ai|machine learning|ml)\b/i.test(value)) return "adjacent";
  if (/\b(cloud|azure|devops|platform|infrastructure|ci\/cd|kubernetes)\b/i.test(value)) return "primary";
  return "other";
}

/**
 * Generate a small deterministic query set. Search criteria remain the source
 * of truth; this function only adds enough context for a web search result to
 * be job-oriented. Local hard filters still run downstream.
 */
export function buildBraveSearchQueries(criteria: SearchCriteria, maxQueries = 3): readonly string[] {
  const explicit = (criteria.searchQueries ?? []).map(normalizedTerm).filter(Boolean);
  const laneTerms = (criteria.roleLanes ?? []).map(normalizedTerm).filter(Boolean);
  const bases = explicit.length > 0 ? explicit : laneTerms;
  const fallback = bases.length > 0 ? bases : ["software engineering"];
  const buckets: Record<SearchLaneBucket, string[]> = { primary: [], secondary: [], adjacent: [], other: [] };
  for (const base of fallback) buckets[searchLaneBucket(base)].push(base);
  const orderedBases: string[] = [];
  while (orderedBases.length < fallback.length) {
    let added = false;
    for (const bucket of ["primary", "secondary", "adjacent", "other"] as const) {
      const next = buckets[bucket].shift();
      if (next) {
        orderedBases.push(next);
        added = true;
      }
    }
    if (!added) break;
  }
  const location = criteria.locations.map(normalizedTerm).find(Boolean);
  const seen = new Set<string>();
  const queries: string[] = [];

  for (const base of orderedBases) {
    const parts = [base];
    if (criteria.remoteOnly && !/\bremote\b/i.test(base)) parts.push("remote");
    if (location && !base.toLowerCase().includes(location.toLowerCase())) parts.push(location);
    if (!hasJobWord(base)) parts.push("jobs");
    const query = normalizedTerm(parts.join(" "));
    const key = query.toLowerCase();
    if (query && !seen.has(key)) {
      seen.add(key);
      queries.push(query);
    }
    if (queries.length >= maxQueries) break;
  }
  return queries;
}

function blockedHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^www\./, "");
  return normalized === "linkedin.com" ||
    normalized.endsWith(".linkedin.com") ||
    normalized === "facebook.com" ||
    normalized.endsWith(".facebook.com") ||
    normalized === "instagram.com" ||
    normalized.endsWith(".instagram.com") ||
    normalized === "youtube.com" ||
    normalized.endsWith(".youtube.com") ||
    normalized === "x.com" ||
    normalized === "twitter.com" ||
    normalized === "translate.google.com" ||
    normalized === "r.jina.ai";
}

function jobSignal(value: string): boolean {
  return /(?:job|career|opening|position|vacanc|opportun|apply|employment|join[-_ ]?us|work[-_ ]?with[-_ ]?us|hiring)/i.test(value);
}

/**
 * Small, explainable quality filter for web results. It rejects obvious
 * non-job/social/search artifacts while retaining employer career pages and
 * known ATS URLs for the classifier.
 */
export function isObviousNonJobReference(value: Pick<BraveSearchWebResult, "url" | "title">): boolean {
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    return true;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  if (blockedHost(url.hostname)) return true;

  const title = value.title ?? "";
  if (/\b(news|blog|press release|article|salary guide|career advice|resume tips|course|training|podcast|webinar)\b/i.test(title)) {
    return true;
  }

  const path = url.pathname.toLowerCase();
  const atsPath = /(?:^|\/)jobs?\/(?:[^/]+\/)?\d+|(?:^|\/)jobs?\/|(?:^|\/)apply(?:\/|$)/i.test(url.pathname);
  if (atsPath || jobSignal(`${title} ${path}`)) return false;

  // A root page is useful only when the result explicitly identifies a
  // careers/jobs destination in its title; otherwise it is not a candidate
  // job reference and would add noise to the coverage denominator.
  return url.pathname === "/" || url.pathname === "";
}

/** Parse only the documented `web.results` URL/title fields. */
export function parseBraveSearchResponse(payload: unknown): ParsedBraveSearchResponse {
  if (!isRecord(payload) || !isRecord(payload.web) || !Array.isArray(payload.web.results)) {
    throw new Error("Brave Search response did not contain a web.results array.");
  }

  const warnings: string[] = [];
  const results: BraveSearchWebResult[] = [];
  for (const [index, value] of payload.web.results.entries()) {
    if (!isRecord(value) || typeof value.url !== "string" || !value.url.trim()) {
      warnings.push(`Skipped malformed Brave Search result at index ${index}.`);
      continue;
    }
    results.push({
      url: value.url.trim(),
      ...(text(value.title) ? { title: text(value.title) } : {}),
      ...(text(value.description) ? { description: text(value.description) } : {}),
    });
  }
  return { results, rawResultCount: payload.web.results.length, warnings };
}

function queryMetric(
  query: string,
  providerResults: number,
  acceptedReferences: number,
  rejectedReferences: number,
  duplicateReferences: number,
  status: DiscoveryStatus,
): DiscoveryQueryMetrics {
  return { query, providerResults, acceptedReferences, rejectedReferences, duplicateReferences, status };
}

function errorForResponse(response: Response): Error {
  if (response.status === 401 || response.status === 403) {
    return new Error(`Brave Search authorization failed with HTTP ${response.status}.`);
  }
  if (response.status === 429) return new Error("Brave Search rate limit reached (HTTP 429).");
  return new Error(`Brave Search request failed with HTTP ${response.status}.`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Brave Search request failed.";
}

function zeroMetrics(): JobDiscoveryMetrics {
  return {
    providerResults: 0,
    acceptedReferences: 0,
    rejectedReferences: 0,
    duplicateReferences: 0,
    queriesExecuted: 0,
    queryMetrics: [],
  };
}

function cacheKey(criteria: SearchCriteria, maxTotalReferences: number): string {
  return JSON.stringify({
    roleLanes: [...(criteria.roleLanes ?? [])],
    searchQueries: [...(criteria.searchQueries ?? [])],
    locations: [...criteria.locations],
    remoteOnly: criteria.remoteOnly,
    employmentTypes: [...criteria.employmentTypes],
    minimumSalary: criteria.minimumSalary,
    excludedSeniorities: [...criteria.excludedSeniorities],
    excludedCompanies: [...criteria.excludedCompanies],
    maxTotalReferences,
  });
}

interface DiscoveryCacheEntry {
  batch: JobDiscoveryBatch;
  sourceFetchedAt: string;
  expiresAt: number;
}

function referenceFromResult(
  result: BraveSearchWebResult,
  providerId: string,
  query: string,
  discoveredAt: string,
): DiscoveredJobReference | null {
  const url = canonicalJobUrl(result.url);
  if (!url || isObviousNonJobReference(result)) return null;
  return {
    discoveredUrl: url,
    ...(result.title ? { titleHint: result.title } : {}),
    sourceProvider: providerId,
    discoveredAt,
    query,
    evidence: ["brave-search-web-result", `query:${query}`],
  };
}

export class BraveSearchDiscoveryProvider implements JobDiscoveryProvider {
  public readonly id: string;
  public readonly mode = "live" as const;
  private readonly apiKey?: string;
  private readonly endpoint: string;
  private readonly fetcher: Fetcher;
  private readonly now: () => string;
  private readonly maxQueries: number;
  private readonly maxResultsPerQuery: number;
  private readonly maxTotalReferences: number;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly country: string;
  private readonly searchLanguage: string;
  private readonly cache = new Map<string, DiscoveryCacheEntry>();

  constructor(options: BraveSearchDiscoveryProviderOptions = {}) {
    this.id = options.id?.trim() || BRAVE_SEARCH_DISCOVERY_ID;
    this.apiKey = options.apiKey?.trim() || undefined;
    this.endpoint = normalizedEndpoint(options.endpoint);
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxQueries = boundedInteger(options.maxQueries, 3, 1, 10, "Brave Search query cap");
    this.maxResultsPerQuery = boundedInteger(options.maxResultsPerQuery, 10, 1, 20, "Brave Search per-query result cap");
    this.maxTotalReferences = boundedInteger(options.maxTotalReferences, 30, 1, 200, "Brave Search cycle reference cap");
    this.cacheTtlMs = nonNegativeInteger(options.cacheTtlMs, 5 * 60 * 1_000, "Brave Search cache TTL");
    this.timeoutMs = positiveInteger(options.timeoutMs, 8_000, "Brave Search timeout");
    this.country = options.country?.trim().toUpperCase() || "US";
    this.searchLanguage = options.searchLanguage?.trim().toLowerCase() || "en";
  }

  private requestUrl(query: string): string {
    const url = new URL(this.endpoint);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(this.maxResultsPerQuery));
    url.searchParams.set("offset", "0");
    url.searchParams.set("country", this.country);
    url.searchParams.set("search_lang", this.searchLanguage);
    url.searchParams.set("safesearch", "moderate");
    return url.toString();
  }

  private async request(query: string): Promise<ParsedBraveSearchResponse> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error(`Brave Search request timed out after ${this.timeoutMs}ms.`));
      }, this.timeoutMs);
    });
    try {
      const response = await Promise.race([
        this.fetcher(this.requestUrl(query), {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": this.apiKey ?? "",
          },
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);
      if (!response.ok) throw errorForResponse(response);
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Brave Search returned invalid JSON.");
      }
      return parseBraveSearchResponse(payload);
    } finally {
      if (timeout) clearTimeout(timeout);
      controller.abort();
    }
  }

  async discover(criteria: SearchCriteria, context?: DiscoveryContext): Promise<JobDiscoveryBatch> {
    if (!this.apiKey) {
      return {
        status: "not_configured",
        reason: "Brave Search API key is not configured for the trusted discovery host.",
        references: [],
        metrics: zeroMetrics(),
      };
    }

    const discoveredAt = context?.now ?? this.now();
    const cycleCap = Math.min(this.maxTotalReferences, context?.maxResults ?? this.maxTotalReferences);
    const key = cacheKey(criteria, cycleCap);
    const currentTime = Date.parse(discoveredAt);
    const nowMs = Number.isNaN(currentTime) ? Date.now() : currentTime;
    const cached = this.cache.get(key);
    if (this.cacheTtlMs > 0 && cached && nowMs < cached.expiresAt) {
      return {
        ...cached.batch,
        references: [...cached.batch.references],
        cached: true,
        sourceFetchedAt: cached.sourceFetchedAt,
      };
    }
    if (cached) this.cache.delete(key);
    const queries = buildBraveSearchQueries(criteria, this.maxQueries);
    const references: DiscoveredJobReference[] = [];
    const seenUrls = new Set<string>();
    const queryMetrics: DiscoveryQueryMetrics[] = [];
    const warnings: string[] = [];
    let providerResults = 0;
    let acceptedReferences = 0;
    let rejectedReferences = 0;
    let duplicateReferences = 0;
    let failedQueries = 0;
    let successfulQueries = 0;

    for (const query of queries) {
      let queryProviderResults = 0;
      let queryAccepted = 0;
      let queryRejected = 0;
      let queryDuplicates = 0;
      try {
        const parsed = await this.request(query);
        successfulQueries += 1;
        queryProviderResults = parsed.rawResultCount;
        providerResults += parsed.rawResultCount;
        for (const warning of parsed.warnings) warnings.push(`${query}: ${warning}`);
        queryRejected += parsed.rawResultCount - parsed.results.length;
        rejectedReferences += parsed.rawResultCount - parsed.results.length;

        for (const result of parsed.results) {
          const reference = referenceFromResult(result, this.id, query, discoveredAt);
          if (!reference) {
            queryRejected += 1;
            rejectedReferences += 1;
            continue;
          }
          const canonical = canonicalJobUrl(reference.discoveredUrl) ?? reference.discoveredUrl;
          if (seenUrls.has(canonical)) {
            queryDuplicates += 1;
            duplicateReferences += 1;
            continue;
          }
          seenUrls.add(canonical);
          if (references.length >= cycleCap) {
            queryRejected += 1;
            rejectedReferences += 1;
            continue;
          }
          references.push(reference);
          queryAccepted += 1;
          acceptedReferences += 1;
        }
        if (parsed.warnings.length > 0 || queryRejected > 0) {
          queryMetrics.push(queryMetric(query, queryProviderResults, queryAccepted, queryRejected, queryDuplicates, "partial"));
        } else {
          queryMetrics.push(queryMetric(query, queryProviderResults, queryAccepted, queryRejected, queryDuplicates,
            queryProviderResults > 0 ? "success" : "empty"));
        }
      } catch (error) {
        failedQueries += 1;
        const reason = errorText(error);
        warnings.push(`${query}: ${reason}`);
        queryMetrics.push(queryMetric(query, queryProviderResults, queryAccepted, queryRejected, queryDuplicates, "failed"));
      }
      if (references.length >= cycleCap) {
        warnings.push(`Broad discovery cycle cap applied: retained at most ${cycleCap} references.`);
        break;
      }
    }

    const status: DiscoveryStatus = failedQueries > 0
      ? references.length > 0 || successfulQueries > 0 ? "partial" : "failed"
      : references.length > 0
        ? warnings.length > 0 ? "partial" : "success"
        : warnings.length > 0 ? "partial" : "empty";
    const metrics: JobDiscoveryMetrics = {
      providerResults,
      acceptedReferences,
      rejectedReferences,
      duplicateReferences,
      queriesExecuted: queryMetrics.length,
      queryMetrics,
    };
    const batch: JobDiscoveryBatch = {
      status,
      ...(status === "failed" ? { reason: "All bounded Brave Search queries failed." } : {}),
      references,
      ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
      metrics,
    };
    if (this.cacheTtlMs > 0 && status !== "failed") {
      this.cache.set(key, {
        batch,
        sourceFetchedAt: discoveredAt,
        expiresAt: nowMs + this.cacheTtlMs,
      });
    }
    return { ...batch, sourceFetchedAt: discoveredAt };
  }
}
