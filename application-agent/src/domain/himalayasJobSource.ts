/**
 * Server/background-only source: Himalayas intentionally sends no CORS header
 * on its public API, so the browser workspace must never instantiate this
 * adapter. The background runtime owns its registration.
 */
import { HIMALAYAS_SOURCE_ID, type JobSourceConfig, type SearchCriteria } from "./campaignTypes";
import { normalizeJobPosting } from "./job";
import type { JobPosting } from "./types";
import type {
  DiscoveryContext,
  JobSource,
  JobSourceBatch,
  JobSourceListing,
} from "./scout";
import type { JobSearchIntent, SearchIntentLane, SearchIntentQuery } from "./searchIntent";

export const DEFAULT_HIMALAYAS_API_BASE_URL = "https://himalayas.app/jobs/api/search";
export const HIMALAYAS_MAX_JOBS_PER_REQUEST = 20;
export const HIMALAYAS_MAX_QUERIES_PER_CYCLE = 3;

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface HimalayasJobSourceOptions {
  endpoint?: string;
  fetcher?: Fetcher;
  now?: () => string;
  maxResults?: number;
  maxQueries?: number;
  timeoutMs?: number;
}

interface HimalayasLocation {
  alpha2?: string;
  name?: string;
  slug?: string;
}

interface HimalayasJobRecord {
  title: string;
  excerpt?: string;
  companyName: string;
  employmentType?: string;
  seniority: readonly string[];
  currency?: string;
  salaryPeriod?: string;
  minSalary?: number;
  maxSalary?: number;
  locationRestrictions?: readonly HimalayasLocation[];
  timezoneRestrictions: readonly string[];
  categories: readonly string[];
  parentCategories: readonly string[];
  description: string;
  pubDate?: string;
  expiryDate?: string;
  applicationLink?: string;
  guid: string;
}

interface ParsedHimalayasRecord {
  record: HimalayasJobRecord | null;
  warnings: readonly string[];
}

class HimalayasResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HimalayasResponseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function providerId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return String(value);
  return nonEmptyString(value);
}

function validHttpUrl(value: unknown): string | undefined {
  const candidate = nonEmptyString(value);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function validTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    // The current production feed has returned Unix seconds, while the
    // published schema specifies milliseconds. Accept both without guessing
    // for ordinary ISO strings.
    const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
    const parsed = new Date(milliseconds);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  const candidate = nonEmptyString(value);
  return candidate && !Number.isNaN(Date.parse(candidate)) ? new Date(candidate).toISOString() : undefined;
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function arrayOfStrings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function parseLocations(value: unknown): { locations?: readonly HimalayasLocation[]; malformed: boolean } {
  if (value === undefined) return { malformed: false };
  if (!Array.isArray(value)) return { malformed: true };
  let malformed = false;
  const locations = value.flatMap((item) => {
    // The documented schema uses objects, but the current production feed has
    // also returned country names directly. Preserve either representation.
    if (typeof item === "string") {
      const name = nonEmptyString(item);
      if (name) return [{ name }];
      malformed = true;
      return [];
    }
    if (!isRecord(item)) {
      malformed = true;
      return [];
    }
    const alpha2 = nonEmptyString(item.alpha2);
    const name = nonEmptyString(item.name);
    const slug = nonEmptyString(item.slug);
    if (!alpha2 && !name && !slug) {
      malformed = true;
      return [];
    }
    return [{ ...(alpha2 ? { alpha2 } : {}), ...(name ? { name } : {}), ...(slug ? { slug } : {}) }];
  });
  return { locations, malformed };
}

function parseStringArray(value: unknown): { values: readonly string[]; malformed: boolean } {
  if (value === undefined) return { values: [], malformed: false };
  if (!Array.isArray(value)) return { values: [], malformed: true };
  const values = arrayOfStrings(value);
  return { values, malformed: values.length !== value.length };
}

function parseTimezoneArray(value: unknown): { values: readonly string[]; malformed: boolean } {
  if (value === undefined) return { values: [], malformed: false };
  if (!Array.isArray(value)) return { values: [], malformed: true };
  let malformed = false;
  const values = value.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [item.trim()];
    if (typeof item === "number" && Number.isFinite(item)) return [`UTC${item >= 0 ? "+" : ""}${item}`];
    malformed = true;
    return [];
  });
  return { values: [...new Set(values)], malformed };
}

function recordFrom(value: unknown): ParsedHimalayasRecord {
  if (!isRecord(value)) return { record: null, warnings: ["posting was not an object."] };
  const warnings: string[] = [];
  const title = nonEmptyString(value.title);
  const companyName = nonEmptyString(value.companyName);
  const guid = providerId(value.guid);
  const description = nonEmptyString(value.description);
  if (!title || !companyName || !guid || !description) {
    return {
      record: null,
      warnings: ["required title, companyName, description, or guid was missing or malformed."],
    };
  }

  const parsedLocations = parseLocations(value.locationRestrictions);
  if (parsedLocations.malformed) warnings.push("locationRestrictions contained malformed values and was partially omitted.");
  const timezoneRestrictions = parseTimezoneArray(value.timezoneRestrictions);
  if (timezoneRestrictions.malformed) warnings.push("timezoneRestrictions contained malformed values and was partially omitted.");
  const categories = parseStringArray(value.categories);
  if (categories.malformed) warnings.push("categories contained malformed values and was partially omitted.");
  const parentCategories = parseStringArray(value.parentCategories);
  if (parentCategories.malformed) warnings.push("parentCategories contained malformed values and was partially omitted.");
  const seniority = parseStringArray(value.seniority);
  if (seniority.malformed) warnings.push("seniority contained malformed values and was partially omitted.");

  const pubDate = value.pubDate === undefined ? undefined : validTimestamp(value.pubDate);
  const expiryDate = value.expiryDate === undefined ? undefined : validTimestamp(value.expiryDate);
  if (value.pubDate !== undefined && !pubDate) warnings.push("pubDate was malformed and was omitted.");
  if (value.expiryDate !== undefined && !expiryDate) warnings.push("expiryDate was malformed and was omitted.");

  const applicationLink = value.applicationLink === undefined ? undefined : validHttpUrl(value.applicationLink);
  if (value.applicationLink !== undefined && !applicationLink) {
    warnings.push("applicationLink was missing or malformed and was omitted.");
  }

  const minSalary = value.minSalary === null || value.minSalary === undefined
    ? undefined
    : finiteNonNegativeNumber(value.minSalary);
  const maxSalary = value.maxSalary === null || value.maxSalary === undefined
    ? undefined
    : finiteNonNegativeNumber(value.maxSalary);
  if (value.minSalary !== null && value.minSalary !== undefined && minSalary === undefined) {
    warnings.push("minSalary was malformed and was omitted.");
  }
  if (value.maxSalary !== null && value.maxSalary !== undefined && maxSalary === undefined) {
    warnings.push("maxSalary was malformed and was omitted.");
  }
  const salaryPeriod = nonEmptyString(value.salaryPeriod);
  const supportedSalaryPeriods = new Set(["hourly", "weekly", "fortnightly", "monthly", "annual"]);
  const normalizedSalaryPeriod = salaryPeriod && supportedSalaryPeriods.has(salaryPeriod) ? salaryPeriod : undefined;
  if (salaryPeriod && !normalizedSalaryPeriod) warnings.push("salaryPeriod was unsupported and was omitted.");
  const currency = nonEmptyString(value.currency);
  const employmentType = nonEmptyString(value.employmentType);
  const excerpt = nonEmptyString(value.excerpt);

  return {
    record: {
      title,
      ...(excerpt ? { excerpt } : {}),
      companyName,
      ...(employmentType ? { employmentType } : {}),
      seniority: seniority.values,
      ...(currency ? { currency } : {}),
      ...(normalizedSalaryPeriod ? { salaryPeriod: normalizedSalaryPeriod } : {}),
      ...(minSalary !== undefined ? { minSalary } : {}),
      ...(maxSalary !== undefined ? { maxSalary } : {}),
      ...(parsedLocations.locations ? { locationRestrictions: parsedLocations.locations } : {}),
      timezoneRestrictions: timezoneRestrictions.values,
      categories: categories.values,
      parentCategories: parentCategories.values,
      description,
      ...(pubDate ? { pubDate } : {}),
      ...(expiryDate ? { expiryDate } : {}),
      ...(applicationLink ? { applicationLink } : {}),
      guid,
    },
    warnings,
  };
}

/** Convert provider HTML/entities to plain text before it enters the domain. */
export function stripHimalayasHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(?:p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(x?[0-9a-f]+);/gi, (_match, code: string) => {
      const parsed = code.toLowerCase().startsWith("x")
        ? Number.parseInt(code.slice(1), 16)
        : Number.parseInt(code, 10);
      return Number.isFinite(parsed) && parsed >= 0 && parsed <= 0x10ffff ? String.fromCodePoint(parsed) : " ";
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizedLocation(value: string): string {
  return value.trim().toLowerCase().replace(/[._-]+/g, " ").replace(/\s+/g, " ");
}

function countryFor(criteria: SearchCriteria): string | undefined {
  const locations = criteria.locations.map(normalizedLocation).filter(Boolean);
  if (locations.length === 0) return undefined;
  if (explicitWorldwide(criteria)) return undefined;
  const usAliases = new Set(["us", "usa", "united states", "united states of america"]);
  if (locations.every((location) => usAliases.has(location))) return "US";
  if (locations.length === 1) return criteria.locations[0].trim();
  return undefined;
}

function explicitWorldwide(criteria: SearchCriteria): boolean {
  return criteria.locations.some((location) => ["worldwide", "global", "anywhere", "any country"].includes(normalizedLocation(location)));
}

function normalizedHimalayasSeniority(value: string): string | undefined {
  const key = normalizedLocation(value);
  const values: Readonly<Record<string, string>> = {
    entry: "Entry-level",
    "entry level": "Entry-level",
    junior: "Entry-level",
    associate: "Entry-level",
    mid: "Mid-level",
    "mid level": "Mid-level",
    senior: "Senior",
    manager: "Manager",
    director: "Director",
    executive: "Executive",
  };
  return values[key];
}

function normalizedEmploymentType(value: string): string | undefined {
  const key = normalizedLocation(value);
  const values: Readonly<Record<string, string>> = {
    "full time": "Full Time",
    "part time": "Part Time",
    contractor: "Contractor",
    contract: "Contractor",
    temporary: "Temporary",
    intern: "Intern",
    internship: "Intern",
    volunteer: "Volunteer",
    other: "Other",
  };
  return values[key];
}

function plannedQueries(
  criteria: SearchCriteria,
  searchPlan: readonly SearchIntentQuery[] | undefined,
): readonly SearchIntentQuery[] {
  if (searchPlan && searchPlan.length > 0) return searchPlan;
  const terms = (criteria.searchQueries?.length ? criteria.searchQueries : criteria.roleLanes)
    .map((term) => term.trim())
    .filter(Boolean);
  return terms.map((term) => ({ lane: "primary" as const, term }));
}

function roundRobinQueries(
  plan: readonly SearchIntentQuery[],
  maximum: number,
): readonly SearchIntentQuery[] {
  const lanes: readonly SearchIntentLane[] = ["primary", "adjacent", "secondary", "broad"];
  const byLane = new Map<SearchIntentLane, SearchIntentQuery[]>();
  for (const query of plan) {
    const values = byLane.get(query.lane) ?? [];
    if (!values.some((candidate) => candidate.term.toLowerCase() === query.term.toLowerCase())) values.push(query);
    byLane.set(query.lane, values);
  }
  const cursors = new Map<SearchIntentLane, number>();
  const selected: SearchIntentQuery[] = [];
  while (selected.length < maximum) {
    let added = false;
    for (const lane of lanes) {
      const values = byLane.get(lane) ?? [];
      const cursor = cursors.get(lane) ?? 0;
      if (cursor >= values.length) continue;
      selected.push(values[cursor]);
      cursors.set(lane, cursor + 1);
      added = true;
      if (selected.length >= maximum) break;
    }
    if (!added) break;
  }
  return selected;
}

export interface HimalayasSearchRequest {
  lane: SearchIntentLane;
  term?: string;
  url: string;
}

export function buildHimalayasSearchRequests(
  endpoint: string,
  criteria: SearchCriteria,
  searchPlan?: readonly SearchIntentQuery[],
  searchIntent?: JobSearchIntent,
  maximum = HIMALAYAS_MAX_QUERIES_PER_CYCLE,
): readonly HimalayasSearchRequest[] {
  if (!Number.isInteger(maximum) || maximum <= 0 || maximum > HIMALAYAS_MAX_QUERIES_PER_CYCLE) {
    throw new Error(`Himalayas query cap must be between 1 and ${HIMALAYAS_MAX_QUERIES_PER_CYCLE}.`);
  }
  const urlBase = new URL(endpoint);
  const country = countryFor(criteria);
  const seniorities = [...new Set((searchIntent?.preferredSeniorities ?? [])
    .map(normalizedHimalayasSeniority)
    .filter((value): value is string => Boolean(value)))];
  const employmentTypes = [...new Set(criteria.employmentTypes
    .map(normalizedEmploymentType)
    .filter((value): value is string => Boolean(value)))];
  const queries = roundRobinQueries(plannedQueries(criteria, searchPlan), maximum);
  const selected: readonly SearchIntentQuery[] = queries.length > 0
    ? queries
    : [{ lane: "primary" as const, term: "" }];

  return selected.map((query) => {
    const url = new URL(urlBase.toString());
    if (query.term) url.searchParams.set("q", query.term);
    if (country) url.searchParams.set("country", country);
    if (explicitWorldwide(criteria)) url.searchParams.set("worldwide", "true");
    if (seniorities.length > 0) url.searchParams.set("seniority", seniorities.join(","));
    if (employmentTypes.length > 0) url.searchParams.set("employment_type", employmentTypes.join(","));
    url.searchParams.set("sort", "recent");
    url.searchParams.set("page", "1");
    return { lane: query.lane, ...(query.term ? { term: query.term } : {}), url: url.toString() };
  });
}

function locationText(record: HimalayasJobRecord): string | undefined {
  if (!record.locationRestrictions) return undefined;
  if (record.locationRestrictions.length === 0) return "Worldwide";
  const labels = record.locationRestrictions
    .map((location) => location.name ?? location.alpha2 ?? location.slug)
    .filter((value): value is string => Boolean(value));
  return labels.length > 0 ? [...new Set(labels)].join(", ") : undefined;
}

function compensationFor(record: HimalayasJobRecord): JobPosting["compensation"] | undefined {
  if (record.minSalary === undefined && record.maxSalary === undefined) return undefined;
  return {
    ...(record.minSalary !== undefined ? { minimum: record.minSalary } : {}),
    ...(record.maxSalary !== undefined ? { maximum: record.maxSalary } : {}),
    ...(record.currency ? { currency: record.currency } : {}),
    ...(record.salaryPeriod ? { period: record.salaryPeriod } : {}),
  };
}

function normalizeHimalayasJob(
  record: HimalayasJobRecord,
  capturedAt: string,
): { job: JobPosting; rawText: string } {
  const description = stripHimalayasHtml(record.description);
  if (description.length < 20) throw new HimalayasResponseError("description is too short to form a job posting.");
  const location = locationText(record);
  const seniority = record.seniority.length > 0 ? record.seniority.join(", ") : undefined;
  const categories = [...new Set([...record.parentCategories, ...record.categories])];
  const compensation = compensationFor(record);
  const rawText = [
    `Company: ${record.companyName}`,
    `Title: ${record.title}`,
    location ? `Location: ${location}` : undefined,
    "Remote status: remote",
    record.employmentType ? `Employment type: ${record.employmentType}` : undefined,
    seniority ? `Seniority: ${seniority}` : undefined,
    categories.length > 0 ? `Categories: ${categories.join(", ")}` : undefined,
    record.timezoneRestrictions.length > 0 ? `Timezone: ${record.timezoneRestrictions.join(", ")}` : undefined,
    compensation ? `Compensation: ${record.currency ?? ""} ${record.minSalary ?? ""}-${record.maxSalary ?? ""} ${record.salaryPeriod ?? ""}`.trim() : undefined,
    record.pubDate ? `Published: ${record.pubDate}` : undefined,
    record.expiryDate ? `Expires: ${record.expiryDate}` : undefined,
    "",
    description,
  ].filter((line): line is string => line !== undefined).join("\n");

  const normalized = normalizeJobPosting({
    rawText,
    ...(record.applicationLink ? { sourceUrl: record.applicationLink, applicationUrl: record.applicationLink } : {}),
    companyHint: record.companyName,
    titleHint: record.title,
  }, capturedAt);
  const {
    compensation: _inferredCompensation,
    remoteStatus: _inferredRemoteStatus,
    employmentType: _inferredEmploymentType,
    seniority: _inferredSeniority,
    location: _inferredLocation,
    ...withoutInferredProviderFields
  } = normalized;
  return {
    rawText,
    job: {
      ...withoutInferredProviderFields,
      ...(location ? { location } : {}),
      remoteStatus: "remote",
      ...(record.employmentType ? { employmentType: record.employmentType } : {}),
      ...(seniority ? { seniority } : {}),
      ...(compensation ? { compensation } : {}),
    },
  };
}

export function parseHimalayasResponse(
  payload: unknown,
  capturedAt: string,
  maxResults = HIMALAYAS_MAX_JOBS_PER_REQUEST,
  query?: string,
): JobSourceBatch {
  if (!isRecord(payload) || !Array.isArray(payload.jobs)) {
    throw new HimalayasResponseError("response did not contain a jobs array.");
  }
  if (!Number.isInteger(maxResults) || maxResults <= 0 || maxResults > HIMALAYAS_MAX_JOBS_PER_REQUEST) {
    throw new HimalayasResponseError(`Himalayas per-request result cap must be between 1 and ${HIMALAYAS_MAX_JOBS_PER_REQUEST}.`);
  }

  const warnings: string[] = [];
  const candidates: Array<{ listing: JobSourceListing; publishedAt?: string }> = [];
  for (const [index, value] of payload.jobs.entries()) {
    const parsed = recordFrom(value);
    for (const warning of parsed.warnings) warnings.push(`Skipped Himalayas job at index ${index}: ${warning}`);
    if (!parsed.record) continue;
    try {
      const normalized = normalizeHimalayasJob(parsed.record, capturedAt);
      candidates.push({
        publishedAt: parsed.record.pubDate,
        listing: {
          input: {
            rawText: normalized.rawText,
            ...(parsed.record.applicationLink
              ? { sourceUrl: parsed.record.applicationLink, applicationUrl: parsed.record.applicationLink }
              : {}),
            companyHint: parsed.record.companyName,
            titleHint: parsed.record.title,
            isExample: false,
          },
          sourceRecordId: parsed.record.guid,
          ...(query ? { searchQueries: [query] } : {}),
          ...(parsed.record.pubDate ? { sourcePublishedAt: parsed.record.pubDate } : {}),
          ...(parsed.record.expiryDate ? { sourceExpiresAt: parsed.record.expiryDate } : {}),
          discoveredAt: capturedAt,
          sourceMode: "live",
        },
      });
    } catch (error) {
      warnings.push(`Skipped Himalayas job ${parsed.record.guid}: ${error instanceof Error ? error.message : "normalization failed."}`);
    }
  }

  candidates.sort((left, right) => {
    const leftTime = left.publishedAt ? Date.parse(left.publishedAt) : 0;
    const rightTime = right.publishedAt ? Date.parse(right.publishedAt) : 0;
    return rightTime - leftTime || String(left.listing.sourceRecordId).localeCompare(String(right.listing.sourceRecordId));
  });
  return {
    listings: candidates.slice(0, maxResults).map(({ listing }) => listing),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(candidates.length === 0 ? { status: "empty" as const } : {}),
  };
}

function endpointUrl(value: string | undefined): { url: string } | { error: string } {
  const candidate = value?.trim() || DEFAULT_HIMALAYAS_API_BASE_URL;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { error: "Himalayas endpoint must use http or https." };
    }
    return { url: url.toString() };
  } catch {
    return { error: "Himalayas endpoint is not a valid URL." };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Himalayas request failed.";
}

export class HimalayasJobSource implements JobSource {
  public readonly id: string;
  public readonly mode = "live" as const;
  private readonly fetcher: Fetcher;
  private readonly now: () => string;
  private readonly maxResults: number;
  private readonly maxQueries: number;
  private readonly timeoutMs: number;
  private readonly endpoint: string | null;
  private readonly configurationError: string | null;

  constructor(options: HimalayasJobSourceOptions = {}) {
    this.id = HIMALAYAS_SOURCE_ID;
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxResults = options.maxResults ?? 50;
    this.maxQueries = options.maxQueries ?? HIMALAYAS_MAX_QUERIES_PER_CYCLE;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    if (!Number.isInteger(this.maxResults) || this.maxResults <= 0) throw new Error("Himalayas source result cap must be a positive integer.");
    if (!Number.isInteger(this.maxQueries) || this.maxQueries <= 0 || this.maxQueries > HIMALAYAS_MAX_QUERIES_PER_CYCLE) {
      throw new Error(`Himalayas query cap must be between 1 and ${HIMALAYAS_MAX_QUERIES_PER_CYCLE}.`);
    }
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("Himalayas request timeout must be a positive integer.");
    const configured = endpointUrl(options.endpoint);
    this.endpoint = "url" in configured ? configured.url : null;
    this.configurationError = "error" in configured ? configured.error : null;
  }

  classifyActionability(): "discoverable_only" {
    return "discoverable_only";
  }

  private async request(url: string): Promise<Response> {
    const controller = typeof AbortController === "undefined" ? undefined : new AbortController();
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        controller?.abort();
        reject(new HimalayasResponseError(`Himalayas request timed out after ${this.timeoutMs}ms.`));
      }, this.timeoutMs);
      let pending: Promise<Response>;
      try {
        pending = Promise.resolve(this.fetcher(url, {
          method: "GET",
          headers: { Accept: "application/json" },
          ...(controller ? { signal: controller.signal } : {}),
        }));
      } catch (error) {
        clearTimeout(timer);
        reject(error);
        return;
      }
      pending.then(
        (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async discover(criteria: SearchCriteria, context?: DiscoveryContext): Promise<JobSourceBatch> {
    if (this.configurationError || !this.endpoint) throw new HimalayasResponseError(this.configurationError ?? "Himalayas endpoint is not configured.");
    const capturedAt = context?.now ?? this.now();
    const maxResults = Math.min(context?.maxResults ?? this.maxResults, this.maxResults);
    const requests = buildHimalayasSearchRequests(this.endpoint, criteria, context?.searchPlan, context?.searchIntent, this.maxQueries);
    const listings: JobSourceListing[] = [];
    const warnings: string[] = [];
    const failures: string[] = [];
    let successfulRequests = 0;

    for (const request of requests) {
      try {
        const response = await this.request(request.url);
        if (!response.ok) {
          const suffix = response.status === 429
            ? " (rate limited; wait at least 60 seconds before retrying)"
            : "";
          throw new HimalayasResponseError(`Himalayas request failed with HTTP ${response.status}${suffix}.`);
        }
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new HimalayasResponseError("Himalayas returned invalid JSON.");
        }
        const parsed = parseHimalayasResponse(payload, capturedAt, HIMALAYAS_MAX_JOBS_PER_REQUEST, request.term);
        successfulRequests += 1;
        listings.push(...parsed.listings);
        warnings.push(...(parsed.warnings ?? []));
      } catch (error) {
        const message = `Himalayas query${request.term ? ` \"${request.term}\"` : ""} failed: ${errorMessage(error)}`;
        failures.push(message);
        if (error instanceof HimalayasResponseError && /HTTP 429/.test(error.message)) break;
      }
    }

    if (successfulRequests === 0 && failures.length > 0) {
      throw new HimalayasResponseError(`All bounded Himalayas queries failed. ${failures.join(" ")}`);
    }

    const status = failures.length > 0 ? "partial" as const : listings.length === 0 ? "empty" as const : undefined;
    return {
      listings: listings.slice(0, maxResults),
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(failures.length > 0 ? { status, reason: failures.join(" ") } : status ? { status } : {}),
      sourceFetchedAt: capturedAt,
    };
  }
}

export function createHimalayasJobSource(endpoint = DEFAULT_HIMALAYAS_API_BASE_URL): HimalayasJobSource {
  return new HimalayasJobSource({ endpoint });
}

export function himalayasSourceConfig(): JobSourceConfig {
  return { type: "himalayas", id: HIMALAYAS_SOURCE_ID };
}
