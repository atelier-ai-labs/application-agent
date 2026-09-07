import type { JobSourceConfig, SearchCriteria } from "./campaignTypes";
import { normalizeJobPosting } from "./job";
import type { JobPosting } from "./types";
import type {
  DiscoveryContext,
  JobSource,
  JobSourceBatch,
  JobSourceListing,
} from "./scout";

export const GREENHOUSE_SOURCE_PREFIX = "greenhouse:";
export const DEFAULT_GREENHOUSE_API_BASE_URL = "https://boards-api.greenhouse.io/v1/boards";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface GreenhouseBoardConfig {
  board: string;
  /** Optional explicit organization label; otherwise the public board metadata is read. */
  company?: string;
  id?: string;
  endpoint?: string;
  maxResults?: number;
  /** Safety cap because the public jobs endpoint returns a board collection. */
  retrievalCap?: number;
}

export interface GreenhouseJobSourceOptions extends GreenhouseBoardConfig {
  fetcher?: Fetcher;
  now?: () => string;
}

interface GreenhouseOffice {
  name?: string;
  location?: string;
}

interface GreenhouseDepartment {
  name?: string;
}

interface GreenhouseJobRecord {
  id: string;
  title: string;
  absoluteUrl: string;
  companyName?: string;
  location?: string;
  content?: string;
  departments: readonly GreenhouseDepartment[];
  offices: readonly GreenhouseOffice[];
  firstPublished?: string;
  updatedAt?: string;
}

class GreenhouseResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GreenhouseResponseError";
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
  const candidate = nonEmptyString(value);
  return candidate && !Number.isNaN(Date.parse(candidate)) ? candidate : undefined;
}

function normalizedBoard(value: string): string {
  const board = value.trim();
  if (!board) throw new Error("Greenhouse board is required.");
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(board)) {
    throw new Error("Greenhouse board must be a simple public board token.");
  }
  return board;
}

export function greenhouseSourceId(board: string): string {
  return `${GREENHOUSE_SOURCE_PREFIX}${normalizedBoard(board).toLowerCase()}`;
}

function validBaseUrl(value: string | undefined): { url: string } | { error: string } {
  const candidate = value?.trim() || DEFAULT_GREENHOUSE_API_BASE_URL;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { error: "Greenhouse API endpoint must use http or https." };
    }
    return { url: url.toString().replace(/\/$/, "") };
  } catch {
    return { error: "Greenhouse API endpoint is not a valid URL." };
  }
}

function decodeEntities(value: string): string {
  let current = value;
  for (let pass = 0; pass < 3; pass += 1) {
    const decoded = current
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
      .replace(/&#39;|&apos;/gi, "'");
    if (decoded === current) break;
    current = decoded;
  }
  return current;
}

/** Convert provider HTML/entities to plain text before it enters the domain. */
export function stripGreenhouseHtml(value: string): string {
  let current = value;
  for (let pass = 0; pass < 3; pass += 1) {
    current = current
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<\s*br\s*\/?\s*>/gi, "\n")
      .replace(/<\s*\/\s*(?:p|div|li|h[1-6])\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " ");
    const decoded = decodeEntities(current);
    if (decoded === current) break;
    current = decoded;
  }
  return current
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function listOfRecords(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function recordFrom(value: unknown): { record: GreenhouseJobRecord | null; warning?: string } {
  if (!isRecord(value)) return { record: null, warning: "posting was not an object." };
  const id = providerId(value.id);
  const title = nonEmptyString(value.title);
  const absoluteUrl = validHttpUrl(value.absolute_url);
  if (!id || !title || !absoluteUrl) {
    return { record: null, warning: "required id, title, or absolute_url was missing or malformed." };
  }

  const location = isRecord(value.location) ? nonEmptyString(value.location.name) : undefined;
  const departments = listOfRecords(value.departments)
    .map((department) => nonEmptyString(department.name))
    .filter((name): name is string => Boolean(name))
    .map((name) => ({ name }));
  const offices = listOfRecords(value.offices).map((office) => ({
    ...(nonEmptyString(office.name) ? { name: nonEmptyString(office.name) } : {}),
    ...(nonEmptyString(office.location) ? { location: nonEmptyString(office.location) } : {}),
  }));

  return {
    record: {
      id,
      title,
      absoluteUrl,
      ...(nonEmptyString(value.company_name) ? { companyName: nonEmptyString(value.company_name) } : {}),
      ...(location ? { location } : {}),
      ...(typeof value.content === "string" ? { content: value.content } : {}),
      departments,
      offices,
      ...(validTimestamp(value.first_published) ? { firstPublished: validTimestamp(value.first_published) } : {}),
      ...(validTimestamp(value.updated_at) ? { updatedAt: validTimestamp(value.updated_at) } : {}),
    },
  };
}

function officeText(offices: readonly GreenhouseOffice[]): string | undefined {
  const values = offices.flatMap((office) => [office.name, office.location].filter((value): value is string => Boolean(value)));
  return values.length > 0 ? [...new Set(values)].join(", ") : undefined;
}

function locationFor(record: GreenhouseJobRecord): string | undefined {
  return record.location ?? officeText(record.offices);
}

function remoteStatusFor(location: string | undefined): string | undefined {
  if (!location) return undefined;
  const lower = location.toLowerCase();
  if (/\bhybrid\b/.test(lower)) return "hybrid";
  if (/\bremote\b/.test(lower)) return "remote";
  if (/\bon[- ]?site\b/.test(lower)) return "on-site";
  return undefined;
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

function normalizeGreenhouseJob(
  record: GreenhouseJobRecord,
  board: string,
  companyName: string | undefined,
  capturedAt: string,
): { job: JobPosting; rawText: string; sourcePublishedAt?: string } {
  const description = record.content === undefined ? "" : stripGreenhouseHtml(record.content);
  if (description.length < 20) {
    throw new GreenhouseResponseError(`posting ${record.id} did not contain enough plaintext description.`);
  }
  const company = record.companyName ?? companyName;
  if (!company) {
    throw new GreenhouseResponseError(`posting ${record.id} did not include a company name and no board company was configured.`);
  }
  const location = locationFor(record);
  const remoteStatus = remoteStatusFor(location);
  const departments = record.departments.map((department) => department.name).filter((name): name is string => Boolean(name));
  const offices = officeText(record.offices);
  const rawText = [
    `Company: ${company}`,
    `Title: ${record.title}`,
    location ? `Location: ${location}` : undefined,
    departments.length > 0 ? `Department: ${departments.join(", ")}` : undefined,
    offices ? `Office: ${offices}` : undefined,
    "",
    description,
  ].filter((line): line is string => line !== undefined).join("\n");

  const normalized = normalizeJobPosting({
    rawText,
    sourceUrl: record.absoluteUrl,
    ...(isVerifiedGreenhouseApplicationUrl(record.absoluteUrl, board, record.id) ? { applicationUrl: record.absoluteUrl } : {}),
    companyHint: company,
    titleHint: record.title,
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
      ...(location ? { location } : {}),
      ...(remoteStatus ? { remoteStatus } : {}),
      ats: "Greenhouse",
    },
    rawText,
    ...(record.firstPublished ?? record.updatedAt ? { sourcePublishedAt: (record.firstPublished ?? record.updatedAt) as string } : {}),
  };
}

export function isVerifiedGreenhouseHostedUrl(value: string | undefined, board: string, postingId: string): boolean {
  if (!value) return false;
  if (!/^\d+$/.test(postingId)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    if (url.hostname.toLowerCase() !== "boards.greenhouse.io" && url.hostname.toLowerCase() !== "job-boards.greenhouse.io") return false;
    const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
    return segments.length === 3 &&
      segments[0].toLowerCase() === normalizedBoard(board).toLowerCase() &&
      segments[1].toLowerCase() === "jobs" &&
      /^\d+$/.test(segments[2]) &&
      segments[2] === postingId;
  } catch {
    return false;
  }
}

/** Greenhouse-hosted job URLs are the public application-form URL. */
export function isVerifiedGreenhouseApplicationUrl(value: string | undefined, board: string, postingId: string): boolean {
  return isVerifiedGreenhouseHostedUrl(value, board, postingId);
}

export function parseGreenhouseResponse(
  payload: unknown,
  board: string,
  criteria: SearchCriteria,
  capturedAt: string,
  maxResults: number,
  companyName?: string,
  retrievalCap = 200,
): JobSourceBatch {
  const normalizedBoardName = normalizedBoard(board);
  if (!isRecord(payload) || !Array.isArray(payload.jobs)) {
    throw new GreenhouseResponseError("response did not contain a jobs array.");
  }
  if (!Number.isInteger(maxResults) || maxResults <= 0) {
    throw new GreenhouseResponseError("Greenhouse result cap must be a positive integer.");
  }
  if (!Number.isInteger(retrievalCap) || retrievalCap <= 0) {
    throw new GreenhouseResponseError("Greenhouse retrieval cap must be a positive integer.");
  }

  const warnings: string[] = [];
  const queries = searchQueries(criteria);
  const candidates: Array<{
    record: GreenhouseJobRecord;
    rawText: string;
    job: JobPosting;
    sourcePublishedAt?: string;
    searchQueries: readonly string[];
  }> = [];
  const rawJobs = payload.jobs.slice(0, retrievalCap);
  if (payload.jobs.length > rawJobs.length) {
    warnings.push(`Greenhouse retrieval cap applied: inspected ${rawJobs.length} of ${payload.jobs.length} published postings.`);
  }

  for (const [index, value] of rawJobs.entries()) {
    const parsed = recordFrom(value);
    if (!parsed.record) {
      warnings.push(`Skipped Greenhouse posting at index ${index}: ${parsed.warning ?? "required fields were malformed."}`);
      continue;
    }
    try {
      const normalized = normalizeGreenhouseJob(parsed.record, normalizedBoardName, companyName, capturedAt);
      const searchText = [
        parsed.record.title,
        parsed.record.companyName,
        companyName,
        parsed.record.location,
        officeText(parsed.record.offices),
        parsed.record.departments.map((department) => department.name).join(" "),
        normalized.job.description,
      ].filter(Boolean).join(" ").toLowerCase();
      const matchedQueries = queries.filter((query) => searchQueryMatches(query, searchText));
      if (queries.length > 0 && matchedQueries.length === 0) continue;
      candidates.push({ record: parsed.record, ...normalized, searchQueries: matchedQueries });
    } catch (error) {
      warnings.push(`Skipped Greenhouse posting ${parsed.record.id}: ${error instanceof Error ? error.message : "normalization failed."}`);
    }
  }

  candidates.sort((left, right) => {
    const leftTime = left.sourcePublishedAt ? Date.parse(left.sourcePublishedAt) : 0;
    const rightTime = right.sourcePublishedAt ? Date.parse(right.sourcePublishedAt) : 0;
    return rightTime - leftTime || left.record.id.localeCompare(right.record.id);
  });

  return {
    listings: candidates.slice(0, maxResults).map(({ record, rawText, job, sourcePublishedAt, searchQueries: matchedQueries }) => ({
      input: {
        rawText,
        sourceUrl: record.absoluteUrl,
        ...(job.applicationUrl ? { applicationUrl: job.applicationUrl } : {}),
        companyHint: record.companyName ?? companyName,
        titleHint: record.title,
        isExample: false,
      },
      sourceRecordId: record.id,
      ...(matchedQueries.length > 0 ? { searchQueries: matchedQueries } : {}),
      ...(sourcePublishedAt ? { sourcePublishedAt } : {}),
      discoveredAt: capturedAt,
      sourceMode: "live",
    })),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function jobsUrl(endpoint: string, board: string): string {
  return new URL(`${encodeURIComponent(board)}/jobs`, `${endpoint.replace(/\/$/, "")}/`).toString() + "?content=true";
}

function boardUrl(endpoint: string, board: string): string {
  return new URL(encodeURIComponent(board), `${endpoint.replace(/\/$/, "")}/`).toString();
}

export class GreenhouseJobSource implements JobSource {
  public readonly id: string;
  public readonly mode = "live" as const;
  public readonly board: string;
  private readonly company?: string;
  private readonly fetcher: Fetcher;
  private readonly now: () => string;
  private readonly maxResults: number;
  private readonly retrievalCap: number;
  private readonly endpoint: string | null;
  private readonly configurationError: string | null;

  constructor(options: GreenhouseJobSourceOptions) {
    this.board = normalizedBoard(options.board);
    this.id = options.id?.trim() || greenhouseSourceId(this.board);
    this.company = options.company?.trim() || undefined;
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxResults = options.maxResults ?? 50;
    if (!Number.isInteger(this.maxResults) || this.maxResults <= 0) {
      throw new Error("Greenhouse source result cap must be a positive integer.");
    }
    this.retrievalCap = options.retrievalCap ?? Math.max(200, this.maxResults);
    if (!Number.isInteger(this.retrievalCap) || this.retrievalCap <= 0) {
      throw new Error("Greenhouse retrieval cap must be a positive integer.");
    }
    const configured = validBaseUrl(options.endpoint);
    this.endpoint = "url" in configured ? configured.url : null;
    this.configurationError = "error" in configured ? configured.error : null;
  }

  classifyActionability(job: JobPosting, listing: JobSourceListing): "actionable" | "discoverable_only" {
    return (listing.sourceMode ?? this.mode) === "live" &&
      !listing.input.isExample &&
      Boolean(listing.sourceRecordId) &&
      isVerifiedGreenhouseHostedUrl(job.sourceUrl, this.board, listing.sourceRecordId ?? "") &&
      isVerifiedGreenhouseApplicationUrl(job.applicationUrl, this.board, listing.sourceRecordId ?? "")
      ? "actionable"
      : "discoverable_only";
  }

  private async boardName(): Promise<string> {
    if (this.company) return this.company;
    if (!this.endpoint) throw new Error(this.configurationError ?? "Greenhouse API endpoint is not configured.");
    const response = await this.fetcher(boardUrl(this.endpoint, this.board), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      const suffix = response.status === 429 ? " (rate limited)" : "";
      throw new Error(`Greenhouse board metadata request for ${this.board} failed with HTTP ${response.status}${suffix}.`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Greenhouse returned invalid board metadata JSON for ${this.board}.`);
    }
    const name = isRecord(payload) ? nonEmptyString(payload.name) : undefined;
    if (!name) throw new GreenhouseResponseError(`Greenhouse board metadata for ${this.board} did not contain a name.`);
    return name;
  }

  async discover(criteria: SearchCriteria, context?: DiscoveryContext): Promise<JobSourceBatch> {
    if (this.configurationError || !this.endpoint) {
      throw new Error(this.configurationError ?? "Greenhouse API endpoint is not configured.");
    }
    const maxResults = Math.min(context?.maxResults ?? this.maxResults, this.maxResults);
    const companyName = await this.boardName();
    const response = await this.fetcher(jobsUrl(this.endpoint, this.board), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      const suffix = response.status === 429 ? " (rate limited)" : "";
      throw new Error(`Greenhouse request for ${this.board} failed with HTTP ${response.status}${suffix}.`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Greenhouse returned invalid JSON for ${this.board}.`);
    }
    return parseGreenhouseResponse(
      payload,
      this.board,
      criteria,
      context?.now ?? this.now(),
      maxResults,
      companyName,
      this.retrievalCap,
    );
  }
}

export function createGreenhouseJobSource(
  boardOrConfig: string | GreenhouseBoardConfig,
  endpoint = import.meta.env.VITE_GREENHOUSE_API_BASE_URL,
): GreenhouseJobSource {
  const config = typeof boardOrConfig === "string" ? { board: boardOrConfig } : boardOrConfig;
  return new GreenhouseJobSource({
    ...config,
    endpoint: config.endpoint ?? endpoint,
  });
}

export function parseGreenhouseBoards(value = import.meta.env.VITE_GREENHOUSE_BOARDS): readonly string[] {
  const boards = new Map<string, string>();
  for (const candidate of (value ?? "").split(",")) {
    const board = candidate.trim();
    if (!board || !/^[a-z0-9][a-z0-9._-]*$/i.test(board)) continue;
    const key = board.toLowerCase();
    if (!boards.has(key)) boards.set(key, board);
  }
  return [...boards.values()];
}

export function createGreenhouseJobSources(
  boards: readonly (string | GreenhouseBoardConfig)[],
  endpoint = import.meta.env.VITE_GREENHOUSE_API_BASE_URL,
): readonly GreenhouseJobSource[] {
  return boards.map((board) => createGreenhouseJobSource(board, endpoint));
}

export function greenhouseConfigsForBoards(
  boards: readonly (string | GreenhouseBoardConfig)[],
): readonly JobSourceConfig[] {
  return boards.map((board): JobSourceConfig => {
    const config = typeof board === "string" ? { board } : board;
    return {
      type: "greenhouse",
      board: normalizedBoard(config.board),
      ...(config.company?.trim() ? { company: config.company.trim() } : {}),
      ...(config.id?.trim() ? { id: config.id.trim() } : { id: greenhouseSourceId(config.board) }),
    };
  });
}
