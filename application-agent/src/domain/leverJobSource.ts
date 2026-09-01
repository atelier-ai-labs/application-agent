import type {
  CreateCampaignInput,
  JobSourceConfig,
  SearchCriteria,
} from "./campaignTypes";
import { jobSourceConfigId } from "./campaignTypes";
import { BRAVE_SEARCH_DISCOVERY_ID } from "./jobDiscovery";
import {
  greenhouseConfigsForBoards,
  parseGreenhouseBoards,
  type GreenhouseBoardConfig,
} from "./greenhouseJobSource";
import { normalizeJobPosting } from "./job";
import type { JobPosting } from "./types";
import type {
  DiscoveryContext,
  JobSource,
  JobSourceBatch,
  JobSourceListing,
} from "./scout";

export const LEVER_SOURCE_PREFIX = "lever:";
export const DEFAULT_LEVER_POSTINGS_BASE_URL = "https://api.lever.co/v0/postings";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface LeverSiteConfig {
  site: string;
  id?: string;
  endpoint?: string;
  maxResults?: number;
}

export interface LeverJobSourceOptions extends LeverSiteConfig {
  fetcher?: Fetcher;
  now?: () => string;
}

interface LeverCategories {
  location?: string;
  allLocations?: readonly string[];
  commitment?: string;
  team?: string;
  department?: string;
}

interface LeverSalaryRange {
  currency?: string;
  interval?: string;
  min?: number;
  max?: number;
}

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  categories: LeverCategories;
  workplaceType?: string;
  descriptionPlain?: string;
  openingPlain?: string;
  descriptionBodyPlain?: string;
  additionalPlain?: string;
  description?: string;
  lists?: readonly { text?: string; content?: string; contentPlain?: string }[];
  salaryRange?: LeverSalaryRange;
  salaryDescriptionPlain?: string;
  createdAt?: string | number;
  publishedAt?: string;
}

interface LeverRecordResult {
  record: LeverPosting | null;
  warning?: string;
}

class LeverResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeverResponseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizedSite(value: string): string {
  const site = value.trim();
  if (!site) throw new Error("Lever source site is required.");
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(site)) {
    throw new Error("Lever source site must be a simple public SITE identifier.");
  }
  return site;
}

export function leverSourceId(site: string): string {
  return `${LEVER_SOURCE_PREFIX}${normalizedSite(site).toLowerCase()}`;
}

function validBaseUrl(value: string | undefined): { url: string } | { error: string } {
  const candidate = value?.trim() || DEFAULT_LEVER_POSTINGS_BASE_URL;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { error: "Lever postings endpoint must use http or https." };
    }
    return { url: url.toString().replace(/\/$/, "") };
  } catch {
    return { error: "Lever postings endpoint is not a valid URL." };
  }
}

function providerPath(value: string): string[] | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return undefined;
    if (url.hostname.toLowerCase() !== "jobs.lever.co" && url.hostname.toLowerCase() !== "jobs.eu.lever.co") {
      return undefined;
    }
    return url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  } catch {
    return undefined;
  }
}

export function isVerifiedLeverHostedUrl(value: string | undefined, site: string, postingId: string): boolean {
  const path = value ? providerPath(value) : undefined;
  return Boolean(path && path.length === 2 && path[0].toLowerCase() === normalizedSite(site).toLowerCase() && path[1] === postingId);
}

export function isVerifiedLeverApplicationUrl(value: string | undefined, site: string, postingId: string): boolean {
  const path = value ? providerPath(value) : undefined;
  return Boolean(
    path &&
      path.length === 3 &&
      path[0].toLowerCase() === normalizedSite(site).toLowerCase() &&
      path[1] === postingId &&
      path[2].toLowerCase() === "apply",
  );
}

function stripHtml(value: string): string {
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

function textField(value: unknown): string | undefined {
  return nonEmptyString(value);
}

function safePlainText(value: unknown): string | undefined {
  const text = textField(value);
  if (!text) return undefined;
  return /<[^>]+>/.test(text) ? stripHtml(text) : text;
}

function categories(value: unknown): LeverCategories {
  if (!isRecord(value)) return {};
  const allLocations = Array.isArray(value.allLocations)
    ? value.allLocations.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
    : undefined;
  return {
    ...(textField(value.location) ? { location: textField(value.location) } : {}),
    ...(allLocations && allLocations.length > 0 ? { allLocations: [...new Set(allLocations)] } : {}),
    ...(textField(value.commitment) ? { commitment: textField(value.commitment) } : {}),
    ...(textField(value.team) ? { team: textField(value.team) } : {}),
    ...(textField(value.department) ? { department: textField(value.department) } : {}),
  };
}

function salaryRange(value: unknown): LeverSalaryRange | undefined {
  if (!isRecord(value)) return undefined;
  const min = typeof value.min === "number" && Number.isFinite(value.min) && value.min >= 0 ? value.min : undefined;
  const max = typeof value.max === "number" && Number.isFinite(value.max) && value.max >= 0 ? value.max : undefined;
  if (min === undefined && max === undefined) return undefined;
  if (min !== undefined && max !== undefined && max < min) return undefined;
  const currency = textField(value.currency);
  const interval = textField(value.interval);
  return {
    ...(currency ? { currency } : {}),
    ...(interval ? { interval } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
  };
}

function validPublishedAt(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return value;
  return undefined;
}

function workplaceType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const lower = value.toLowerCase().replace(/_/g, "-");
  if (lower === "remote") return "remote";
  if (lower === "hybrid") return "hybrid";
  if (lower === "on-site" || lower === "onsite") return "on-site";
  return undefined;
}

function employmentType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const lower = value.toLowerCase().replace(/[_-]/g, " ").trim();
  if (lower === "full time" || lower === "part time" || lower === "contract" || lower === "temporary" || lower === "internship") {
    return lower;
  }
  return undefined;
}

function descriptionFrom(record: LeverPosting): string | undefined {
  const direct = safePlainText(record.descriptionPlain);
  if (direct) return direct;
  const plainParts = [record.openingPlain, record.descriptionBodyPlain, record.additionalPlain]
    .map(safePlainText)
    .filter((part): part is string => Boolean(part));
  const listParts = (record.lists ?? []).flatMap((list) => {
    const heading = textField(list.text);
    const content = safePlainText(list.contentPlain) ?? (textField(list.content) ? stripHtml(list.content!) : undefined);
    return [heading, content].filter((part): part is string => Boolean(part));
  });
  const plaintext = [...plainParts, ...listParts].join("\n\n").trim();
  if (plaintext) return plaintext;
  return textField(record.description) ? stripHtml(record.description!) : undefined;
}

function recordFrom(value: unknown, site: string): LeverRecordResult {
  if (!isRecord(value)) return { record: null, warning: "posting was not an object." };
  const id = textField(value.id);
  const title = textField(value.text);
  const hostedUrl = textField(value.hostedUrl);
  if (!id || !title || !hostedUrl) {
    return { record: null, warning: "required id, text, or hostedUrl was missing." };
  }
  if (!isVerifiedLeverHostedUrl(hostedUrl, site, id)) {
    return { record: null, warning: `posting ${id} did not contain a verified Lever hostedUrl.` };
  }

  const rawApplyUrl = textField(value.applyUrl);
  const applyUrl = rawApplyUrl && isVerifiedLeverApplicationUrl(rawApplyUrl, site, id) ? rawApplyUrl : undefined;
  return {
    record: {
      id,
      text: title,
      hostedUrl,
      ...(applyUrl ? { applyUrl } : {}),
      categories: categories(value.categories),
      ...(textField(value.workplaceType) ? { workplaceType: textField(value.workplaceType) } : {}),
      ...(textField(value.descriptionPlain) ? { descriptionPlain: textField(value.descriptionPlain) } : {}),
      ...(textField(value.openingPlain) ? { openingPlain: textField(value.openingPlain) } : {}),
      ...(textField(value.descriptionBodyPlain) ? { descriptionBodyPlain: textField(value.descriptionBodyPlain) } : {}),
      ...(textField(value.additionalPlain) ? { additionalPlain: textField(value.additionalPlain) } : {}),
      ...(textField(value.description) ? { description: textField(value.description) } : {}),
      ...(Array.isArray(value.lists)
        ? {
            lists: value.lists.filter(isRecord).map((list) => ({
              ...(textField(list.text) ? { text: textField(list.text) } : {}),
              ...(textField(list.content) ? { content: textField(list.content) } : {}),
              ...(textField(list.contentPlain) ? { contentPlain: textField(list.contentPlain) } : {}),
            })),
          }
        : {}),
      ...(salaryRange(value.salaryRange) ? { salaryRange: salaryRange(value.salaryRange) } : {}),
      ...(textField(value.salaryDescriptionPlain) ? { salaryDescriptionPlain: textField(value.salaryDescriptionPlain) } : {}),
      ...(validPublishedAt(value.createdAt) ? { createdAt: validPublishedAt(value.createdAt) } : {}),
      ...(validPublishedAt(value.publishedAt) ? { publishedAt: validPublishedAt(value.publishedAt) } : {}),
    },
    ...(rawApplyUrl && !applyUrl ? { warning: `posting ${id} had no verified Lever application URL; retained as discovery-only.` } : {}),
  };
}

function normalizedSearchText(record: LeverPosting, description: string, site: string): string {
  return [
    site,
    record.text,
    record.categories.location,
    ...(record.categories.allLocations ?? []),
    record.categories.commitment,
    record.categories.team,
    record.categories.department,
    record.workplaceType,
    description,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function searchQueryMatches(query: string, text: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  if (text.includes(normalized)) return true;
  const tokens = normalized
    .split(/[^a-z0-9+#/.]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
  return tokens.length > 0 && tokens.every((token) => text.includes(token));
}

function searchQueries(criteria: SearchCriteria): readonly string[] {
  return (criteria.searchQueries ?? []).map((query) => query.trim()).filter(Boolean);
}

function salaryDescription(range: LeverSalaryRange): string | undefined {
  const currency = range.currency ?? "";
  const interval = range.interval ? ` ${range.interval}` : "";
  if (range.min !== undefined && range.max !== undefined) return `${currency} ${range.min}-${range.max}${interval}`.trim();
  if (range.min !== undefined) return `${currency} ${range.min}${interval}`.trim();
  if (range.max !== undefined) return `${currency} ${range.max}${interval}`.trim();
  return undefined;
}

function normalizeLeverJob(record: LeverPosting, site: string, capturedAt: string): { job: JobPosting; rawText: string; sourcePublishedAt?: string } {
  const description = descriptionFrom(record);
  if (!description || description.length < 20) {
    throw new LeverResponseError(`posting ${record.id} did not contain enough plaintext description.`);
  }
  const location = record.categories.allLocations?.length
    ? record.categories.allLocations.join(", ")
    : record.categories.location;
  const workplace = workplaceType(record.workplaceType);
  const commitment = employmentType(record.categories.commitment);
  const compensation = record.salaryRange;
  const rawText = [
    `Company: ${site}`,
    `Title: ${record.text}`,
    location ? `Location: ${location}` : undefined,
    workplace ? `Workplace: ${workplace}` : undefined,
    commitment ? `Employment type: ${commitment}` : undefined,
    record.categories.team ? `Team: ${record.categories.team}` : undefined,
    record.categories.department ? `Department: ${record.categories.department}` : undefined,
    compensation ? `Compensation: ${salaryDescription(compensation)}` : undefined,
    record.salaryDescriptionPlain ? `Compensation details: ${stripHtml(record.salaryDescriptionPlain)}` : undefined,
    "",
    description,
  ].filter((line): line is string => line !== undefined).join("\n");

  const normalized = normalizeJobPosting({
    rawText,
    sourceUrl: record.hostedUrl,
    ...(record.applyUrl ? { applicationUrl: record.applyUrl } : {}),
    companyHint: site,
    titleHint: record.text,
  }, capturedAt);
  const {
    compensation: _inferredCompensation,
    remoteStatus: _inferredRemoteStatus,
    employmentType: _inferredEmploymentType,
    ...withoutInferredProviderFields
  } = normalized;
  return {
    job: {
      ...withoutInferredProviderFields,
      ...(workplace ? { remoteStatus: workplace } : {}),
      ...(commitment ? { employmentType: commitment } : {}),
      ...(compensation && salaryDescription(compensation) ? {
        compensation: {
          ...(compensation.min !== undefined ? { minimum: compensation.min } : {}),
          ...(compensation.max !== undefined ? { maximum: compensation.max } : {}),
          ...(compensation.currency ? { currency: compensation.currency } : {}),
        },
      } : {}),
    },
    rawText,
    ...(record.createdAt ?? record.publishedAt ? { sourcePublishedAt: (record.createdAt ?? record.publishedAt) as string } : {}),
  };
}

function parseArguments(
  first: string | SearchCriteria,
  second: SearchCriteria | string,
  third: string | number,
  fourth: number | string,
): { site: string; criteria: SearchCriteria; capturedAt: string; maxResults: number } {
  if (typeof first === "string") {
    return { site: normalizedSite(first), criteria: second as SearchCriteria, capturedAt: third as string, maxResults: fourth as number };
  }
  return { site: normalizedSite(fourth as string), criteria: first, capturedAt: second as string, maxResults: third as number };
}

export function parseLeverResponse(
  payload: unknown,
  site: string,
  criteria: SearchCriteria,
  capturedAt: string,
  maxResults: number,
): JobSourceBatch;
export function parseLeverResponse(
  payload: unknown,
  criteria: SearchCriteria,
  capturedAt: string,
  maxResults: number,
  site: string,
): JobSourceBatch;
export function parseLeverResponse(
  payload: unknown,
  first: string | SearchCriteria,
  second: SearchCriteria | string,
  third: string | number,
  fourth: number | string,
): JobSourceBatch {
  const { site, criteria, capturedAt, maxResults } = parseArguments(first, second, third, fourth);
  if (!Array.isArray(payload)) throw new LeverResponseError("response did not contain a postings array.");
  if (!Number.isInteger(maxResults) || maxResults <= 0) throw new LeverResponseError("Lever result cap must be a positive integer.");

  const queries = searchQueries(criteria);
  const warnings: string[] = [];
  const candidates: Array<{ record: LeverPosting; job: JobPosting; rawText: string; sourcePublishedAt?: string; warning?: string }> = [];
  for (const [index, value] of payload.entries()) {
    const result = recordFrom(value, site);
    if (!result.record) {
      warnings.push(`Skipped Lever posting at index ${index}: ${result.warning ?? "required fields were malformed."}`);
      continue;
    }
    try {
      const normalized = normalizeLeverJob(result.record, site, capturedAt);
      if (result.warning) warnings.push(`Lever posting ${result.record.id}: ${result.warning}`);
      const searchText = normalizedSearchText(result.record, normalized.job.description, site);
      if (queries.length > 0 && !queries.some((query) => searchQueryMatches(query, searchText))) continue;
      candidates.push({ record: result.record, ...normalized });
    } catch (error) {
      warnings.push(`Skipped Lever posting ${result.record.id}: ${error instanceof Error ? error.message : "normalization failed."}`);
    }
  }

  candidates.sort((left, right) => {
    const leftTime = left.sourcePublishedAt ? Date.parse(left.sourcePublishedAt) : 0;
    const rightTime = right.sourcePublishedAt ? Date.parse(right.sourcePublishedAt) : 0;
    return rightTime - leftTime || left.record.id.localeCompare(right.record.id);
  });

  return {
    listings: candidates.slice(0, maxResults).map(({ record, rawText, sourcePublishedAt }) => ({
      input: {
        rawText,
        sourceUrl: record.hostedUrl,
        ...(record.applyUrl ? { applicationUrl: record.applyUrl } : {}),
        companyHint: site,
        titleHint: record.text,
        isExample: false,
      },
      sourceRecordId: record.id,
      ...(sourcePublishedAt ? { sourcePublishedAt } : {}),
      discoveredAt: capturedAt,
      sourceMode: "live",
    })),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function requestUrl(endpoint: string, site: string, maxResults: number): string {
  const url = new URL(`${encodeURIComponent(site)}`, `${endpoint.replace(/\/$/, "")}/`);
  url.searchParams.set("mode", "json");
  url.searchParams.set("limit", String(maxResults));
  return url.toString();
}

export class LeverJobSource implements JobSource {
  public readonly id: string;
  public readonly mode = "live" as const;
  public readonly site: string;
  private readonly fetcher: Fetcher;
  private readonly now: () => string;
  private readonly maxResults: number;
  private readonly endpoint: string | null;
  private readonly configurationError: string | null;

  constructor(options: LeverJobSourceOptions) {
    this.site = normalizedSite(options.site);
    this.id = options.id?.trim() || leverSourceId(this.site);
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxResults = options.maxResults ?? 50;
    if (!Number.isInteger(this.maxResults) || this.maxResults <= 0) {
      throw new Error("Lever source result cap must be a positive integer.");
    }
    const configured = validBaseUrl(options.endpoint);
    this.endpoint = "url" in configured ? configured.url : null;
    this.configurationError = "error" in configured ? configured.error : null;
  }

  classifyActionability(job: JobPosting, listing: JobSourceListing): "actionable" | "discoverable_only" {
    return (listing.sourceMode ?? this.mode) === "live" &&
      !listing.input.isExample &&
      Boolean(listing.sourceRecordId) &&
      isVerifiedLeverHostedUrl(job.sourceUrl, this.site, listing.sourceRecordId ?? "") &&
      isVerifiedLeverApplicationUrl(job.applicationUrl, this.site, listing.sourceRecordId ?? "")
      ? "actionable"
      : "discoverable_only";
  }

  async discover(criteria: SearchCriteria, context?: DiscoveryContext): Promise<JobSourceBatch> {
    if (this.configurationError || !this.endpoint) {
      throw new Error(this.configurationError ?? "Lever postings endpoint is not configured.");
    }
    const maxResults = Math.min(context?.maxResults ?? this.maxResults, this.maxResults);
    const response = await this.fetcher(requestUrl(this.endpoint, this.site, maxResults), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      const suffix = response.status === 429 ? " (rate limited)" : "";
      throw new Error(`Lever request for ${this.site} failed with HTTP ${response.status}${suffix}.`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Lever returned invalid JSON for ${this.site}.`);
    }
    return parseLeverResponse(payload, this.site, criteria, context?.now ?? this.now(), maxResults);
  }
}

export function createLeverJobSource(
  siteOrConfig: string | LeverSiteConfig,
  endpoint = import.meta.env.VITE_LEVER_API_BASE_URL,
): LeverJobSource {
  const config = typeof siteOrConfig === "string" ? { site: siteOrConfig } : siteOrConfig;
  return new LeverJobSource({
    ...config,
    endpoint: config.endpoint ?? endpoint,
  });
}

export function parseLeverSites(value = import.meta.env.VITE_LEVER_SITES): readonly string[] {
  const sites = new Map<string, string>();
  for (const candidate of (value ?? "").split(",")) {
    const site = candidate.trim();
    if (!site || !/^[a-z0-9][a-z0-9._-]*$/i.test(site)) continue;
    const key = site.toLowerCase();
    if (!sites.has(key)) sites.set(key, site);
  }
  return [...sites.values()];
}

export function createLeverJobSources(
  sites: readonly (string | LeverSiteConfig)[],
  endpoint = import.meta.env.VITE_LEVER_API_BASE_URL,
): readonly LeverJobSource[] {
  return sites.map((site) => createLeverJobSource(site, endpoint));
}

const REMOTE_ENGINEERING_SEARCH_QUERIES = [
  "cloud engineering",
  "Azure DevOps",
  "platform engineering",
  "infrastructure",
  "CI/CD",
  "frontend",
  "React",
  "TypeScript",
  "AI platform",
  "agent engineering",
  "AI infrastructure",
  "applied AI",
] as const;

export function parseBroadDiscoveryEnabled(value = import.meta.env.VITE_BROAD_DISCOVERY_ENABLED): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function createLiveCampaignInput(
  leverSites: readonly string[] = parseLeverSites(),
  greenhouseBoards: readonly (string | GreenhouseBoardConfig)[] = parseGreenhouseBoards(),
  broadDiscoveryEnabled = parseBroadDiscoveryEnabled(),
): CreateCampaignInput {
  const configuredLeverSites = parseLeverSites(leverSites.join(","));
  const configuredGreenhouseBoards = greenhouseConfigsForBoards(greenhouseBoards);
  const configs: JobSourceConfig[] = [
    { type: "remotive", id: "remotive-live" },
    ...configuredLeverSites.map((site): JobSourceConfig => ({ type: "lever", site, id: leverSourceId(site) })),
    ...configuredGreenhouseBoards,
    ...(broadDiscoveryEnabled ? [{ type: "brave_search", id: `references:${BRAVE_SEARCH_DISCOVERY_ID}` } satisfies JobSourceConfig] : []),
  ];
  return {
    name: broadDiscoveryEnabled
      ? "Live broad + targeted ATS search"
      : configuredLeverSites.length > 0 || configuredGreenhouseBoards.length > 0
        ? "Live remote + targeted ATS search"
        : "Live remote engineering search",
    goal: "Discover current remote engineering roles across broad and targeted employer feeds.",
    searchSources: configs.map(jobSourceConfigId),
    sourceConfigs: configs,
    searchCriteria: {
      roleLanes: ["engineer", "developer", "architect"],
      searchQueries: REMOTE_ENGINEERING_SEARCH_QUERIES,
      remoteOnly: true,
      employmentTypes: ["full time"],
    },
    applicationPolicy: {
      autoPrepare: true,
      allowGroundedDrafts: true,
      approvedResumeFamilies: [],
    },
    submissionPolicy: {
      authority: "never",
      requireExplicitApproval: false,
    },
    dailyApplicationLimit: 3,
    stopConditions: {
      stopOnAcceptedOffer: true,
      systemicFailureLimit: 3,
    },
  };
}

export function createLeverCampaignInput(
  leverSites: readonly string[] = parseLeverSites(),
  greenhouseBoards: readonly (string | GreenhouseBoardConfig)[] = parseGreenhouseBoards(),
  broadDiscoveryEnabled = parseBroadDiscoveryEnabled(),
): CreateCampaignInput {
  return createLiveCampaignInput(leverSites, greenhouseBoards, broadDiscoveryEnabled);
}

export const leverCampaignInput: CreateCampaignInput = createLeverCampaignInput();
