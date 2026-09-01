import type { CreateCampaignInput, SearchCriteria } from "./campaignTypes";
import { normalizeJobPosting } from "./job";
import type { JobPosting } from "./types";
import type {
  DiscoveryContext,
  JobSource,
  JobSourceBatch,
} from "./scout";

export const REMOTIVE_SOURCE_ID = "remotive-live";
export const DEFAULT_REMOTIVE_API_BASE_URL = "https://remotive.com/api/remote-jobs";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface RemotiveJobSourceOptions {
  endpoint?: string;
  fetcher?: Fetcher;
  now?: () => string;
  maxResults?: number;
}

interface RemotiveJobRecord {
  id: number | string;
  url: string;
  title: string;
  company_name: string;
  category?: string;
  tags?: string[];
  job_type?: string;
  publication_date?: string;
  candidate_required_location?: string;
  salary?: string;
  description: string;
}

class RemotiveResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemotiveResponseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function providerId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
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

function stripAndDecodeHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*(?:p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(x?[0-9a-f]+);/gi, (_match, code: string) => {
      const parsed = code.toLowerCase().startsWith("x")
        ? Number.parseInt(code.slice(1), 16)
        : Number.parseInt(code, 10);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : " ";
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

function normalizedSearchText(record: RemotiveJobRecord, description: string): string {
  return [
    record.title,
    record.company_name,
    record.category,
    ...(record.tags ?? []),
    record.candidate_required_location,
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
  return (criteria.searchQueries?.length ? criteria.searchQueries : [])
    .map((query) => query.trim())
    .filter(Boolean);
}

function remotiveJobType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const labels: Readonly<Record<string, string>> = {
    full_time: "full time",
    part_time: "part time",
    contract: "contract",
    freelance: "freelance",
    internship: "internship",
    temporary: "temporary",
  };
  return labels[value.toLowerCase()] ?? (value.replace(/[_-]/g, " ").trim().toLowerCase() || undefined);
}

function safeCompensation(salary: string | undefined): JobPosting["compensation"] | undefined {
  if (!salary || !/(?:annual|year|yr|k\b)/i.test(salary)) return undefined;
  const values = [...salary.matchAll(/\$\s*([\d,]+(?:\.\d+)?)\s*k?/gi)]
    .map((match) => {
      const amount = Number(match[1].replace(/,/g, ""));
      const usesK = /k/i.test(match[0]);
      return Number.isFinite(amount) ? amount * (usesK ? 1_000 : 1) : undefined;
    })
    .filter((value): value is number => value !== undefined);
  if (values.length === 0) return undefined;
  return {
    minimum: values[0],
    ...(values[1] !== undefined ? { maximum: values[1] } : {}),
    currency: "USD",
  };
}

function validPublishedAt(value: string | undefined): string | undefined {
  return value && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function asRemotiveRecord(value: unknown): RemotiveJobRecord | null {
  if (!isRecord(value)) return null;
  const id = providerId(value.id);
  const url = validHttpUrl(value.url);
  const title = nonEmptyString(value.title);
  const company = nonEmptyString(value.company_name);
  const description = nonEmptyString(value.description);
  if (!id || !url || !title || !company || !description) return null;

  const tags = Array.isArray(value.tags)
    ? value.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0).map((tag) => tag.trim())
    : undefined;
  return {
    id,
    url,
    title,
    company_name: company,
    ...(nonEmptyString(value.category) ? { category: nonEmptyString(value.category) } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(nonEmptyString(value.job_type) ? { job_type: nonEmptyString(value.job_type) } : {}),
    ...(nonEmptyString(value.publication_date) ? { publication_date: nonEmptyString(value.publication_date) } : {}),
    ...(nonEmptyString(value.candidate_required_location)
      ? { candidate_required_location: nonEmptyString(value.candidate_required_location) }
      : {}),
    ...(typeof value.salary === "string" ? { salary: value.salary.trim() } : {}),
    description,
  };
}

function normalizeRemotiveJob(
  record: RemotiveJobRecord,
  capturedAt: string,
): { job: JobPosting; rawText: string; sourcePublishedAt?: string } {
  const description = stripAndDecodeHtml(record.description);
  if (description.length < 20) {
    throw new RemotiveResponseError("description is too short to form a job posting.");
  }

  const rawText = [
    record.company_name,
    record.title,
    record.candidate_required_location ? `Location: ${record.candidate_required_location}` : undefined,
    "Remote status: remote",
    remotiveJobType(record.job_type) ? `Employment type: ${remotiveJobType(record.job_type)}` : undefined,
    record.salary ? `Compensation: ${record.salary}` : undefined,
    record.category ? `Category: ${record.category}` : undefined,
    "",
    description,
  ].filter((line): line is string => line !== undefined).join("\n");

  const normalized = normalizeJobPosting({
    rawText,
    sourceUrl: record.url,
    companyHint: record.company_name,
    titleHint: record.title,
  }, capturedAt);
  const compensation = safeCompensation(record.salary);
  const { compensation: _inferredCompensation, ...withoutInferredCompensation } = normalized;
  return {
    job: {
      ...withoutInferredCompensation,
      ...(compensation ? { compensation } : {}),
    },
    rawText,
    ...(validPublishedAt(record.publication_date) ? { sourcePublishedAt: validPublishedAt(record.publication_date) } : {}),
  };
}

export function parseRemotiveResponse(
  payload: unknown,
  criteria: SearchCriteria,
  capturedAt: string,
  maxResults: number,
): JobSourceBatch {
  if (!isRecord(payload) || !Array.isArray(payload.jobs)) {
    throw new RemotiveResponseError("response did not contain a jobs array.");
  }

  const queries = searchQueries(criteria);
  const warnings: string[] = [];
  const candidates: Array<{ record: RemotiveJobRecord; job: JobPosting; rawText: string; sourcePublishedAt?: string }> = [];
  for (const [index, value] of payload.jobs.entries()) {
    const record = asRemotiveRecord(value);
    if (!record) {
      warnings.push(`Skipped Remotive job at index ${index}: required fields were missing or malformed.`);
      continue;
    }

    const plainDescription = stripAndDecodeHtml(record.description);
    const text = normalizedSearchText(record, plainDescription);
    if (queries.length > 0 && !queries.some((query) => searchQueryMatches(query, text))) {
      continue;
    }

    try {
      const normalized = normalizeRemotiveJob(record, capturedAt);
      candidates.push({ record, ...normalized });
    } catch (error) {
      warnings.push(
        `Skipped Remotive job ${record.id}: ${error instanceof Error ? error.message : "normalization failed."}`,
      );
    }
  }

  candidates.sort((left, right) => {
    const leftTime = left.sourcePublishedAt ? Date.parse(left.sourcePublishedAt) : 0;
    const rightTime = right.sourcePublishedAt ? Date.parse(right.sourcePublishedAt) : 0;
    return rightTime - leftTime || String(left.record.id).localeCompare(String(right.record.id));
  });

  return {
    listings: candidates.slice(0, maxResults).map(({ record, rawText, sourcePublishedAt }) => ({
      input: {
        rawText,
        sourceUrl: record.url,
        companyHint: record.company_name,
        titleHint: record.title,
        isExample: false,
      },
      sourceRecordId: String(record.id),
      ...(sourcePublishedAt ? { sourcePublishedAt } : {}),
      discoveredAt: capturedAt,
      sourceMode: "live",
    })),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function endpointUrl(value: string | undefined): { url: string } | { error: string } {
  const candidate = value?.trim() || DEFAULT_REMOTIVE_API_BASE_URL;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { error: "Remotive endpoint must use http or https." };
    }
    return { url: url.toString() };
  } catch {
    return { error: "Remotive endpoint is not a valid URL." };
  }
}

function requestUrl(endpoint: string, criteria: SearchCriteria, maxResults: number): string {
  const url = new URL(endpoint);
  const queries = searchQueries(criteria);
  // The provider documents one `search` term. Multiple campaign lanes are
  // matched locally so one source request cannot silently privilege one lane.
  if (queries.length === 1) url.searchParams.set("search", queries[0]);
  url.searchParams.set("limit", String(maxResults));
  return url.toString();
}

export class RemotiveJobSource implements JobSource {
  public readonly id = REMOTIVE_SOURCE_ID;
  public readonly mode = "live" as const;
  private readonly fetcher: Fetcher;
  private readonly now: () => string;
  private readonly maxResults: number;
  private readonly endpoint: string | null;
  private readonly configurationError: string | null;

  constructor(options: RemotiveJobSourceOptions = {}) {
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxResults = options.maxResults ?? 50;
    if (!Number.isInteger(this.maxResults) || this.maxResults <= 0) {
      throw new Error("Remotive source result cap must be a positive integer.");
    }
    const configured = endpointUrl(options.endpoint);
    this.endpoint = "url" in configured ? configured.url : null;
    this.configurationError = "error" in configured ? configured.error : null;
  }

  classifyActionability(): "discoverable_only" {
    return "discoverable_only";
  }

  async discover(criteria: SearchCriteria, context?: DiscoveryContext): Promise<JobSourceBatch> {
    if (this.configurationError || !this.endpoint) {
      throw new Error(this.configurationError ?? "Remotive endpoint is not configured.");
    }

    const maxResults = Math.min(context?.maxResults ?? this.maxResults, this.maxResults);
    const response = await this.fetcher(requestUrl(this.endpoint, criteria, maxResults), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      const suffix = response.status === 429 ? " (rate limited)" : "";
      throw new Error(`Remotive request failed with HTTP ${response.status}${suffix}.`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Remotive returned invalid JSON.");
    }
    return parseRemotiveResponse(payload, criteria, context?.now ?? this.now(), maxResults);
  }
}

export function createRemotiveJobSource(endpoint = import.meta.env.VITE_REMOTIVE_API_BASE_URL): RemotiveJobSource {
  return new RemotiveJobSource({ endpoint });
}

/** A generic multi-lane starting point; it contains no private candidate facts. */
export const remotiveCampaignInput: CreateCampaignInput = {
  name: "Live remote engineering search",
  goal: "Discover current remote engineering roles across cloud, frontend, and applied AI lanes.",
  searchSources: [REMOTIVE_SOURCE_ID],
  sourceConfigs: [{ type: "remotive", id: REMOTIVE_SOURCE_ID }],
  searchCriteria: {
    roleLanes: ["engineer", "developer", "architect"],
    searchQueries: [
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
    ],
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
