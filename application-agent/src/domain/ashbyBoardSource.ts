import type { SearchCriteria } from "./campaignTypes";
import { isVerifiedAshbyApplicationUrl, isVerifiedAshbyHostedUrl } from "./jobUrlClassifier";
import type { JobPosting } from "./types";
import type { DiscoveryContext, JobSource, JobSourceBatch, JobSourceListing } from "./scout";

/** Ashby's public, unauthenticated job-board API. */
export const DEFAULT_ASHBY_POSTING_API_BASE_URL = "https://api.ashbyhq.com/posting-api/job-board";

type Fetcher = (input: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface AshbyBoardSourceOptions {
  board: string;
  /** Display name; Ashby's board API does not return one. */
  company?: string;
  endpoint?: string;
  fetcher?: Fetcher;
  now?: () => string;
  maxResults?: number;
}

export function ashbyBoardSourceId(board: string): string {
  return `ashby:${board.trim().toLowerCase()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function searchQueryMatches(query: string, haystack: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  if (haystack.includes(normalized)) return true;
  const tokens = normalized.split(/[^a-z0-9+#/.]+/).map((token) => token.trim()).filter((token) => token.length > 1);
  return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}

function titleCase(board: string): string {
  return board.split(/[-_.]+/).filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
}

/** All locations of one Ashby posting, primary first. */
function locationsOf(job: Record<string, unknown>): string[] {
  const secondary = Array.isArray(job.secondaryLocations)
    ? job.secondaryLocations.map((entry) => (isRecord(entry) ? text(entry.location) : undefined)).filter((value): value is string => Boolean(value))
    : [];
  return [...new Set([text(job.location), ...secondary].filter((value): value is string => Boolean(value)))];
}

/**
 * Turns an Ashby job-board payload into Scout listings. Unlisted postings are
 * skipped; search terms (when given) must match the title, team, location or
 * description, the same way the Greenhouse and Lever board sources filter.
 */
export function parseAshbyBoardResponse(
  payload: unknown,
  board: string,
  criteria: SearchCriteria,
  capturedAt: string,
  maxResults: number,
  company = titleCase(board),
): JobSourceBatch {
  if (!isRecord(payload) || !Array.isArray(payload.jobs)) throw new Error(`Ashby board ${board} did not return a jobs array.`);
  const queries = (criteria.searchQueries ?? []).map((query) => query.trim()).filter(Boolean);
  const listings: JobSourceListing[] = [];
  const warnings: string[] = [];
  for (const value of payload.jobs) {
    if (!isRecord(value) || value.isListed === false) continue;
    const id = text(value.id);
    const title = text(value.title);
    if (!id || !title) {
      warnings.push("Skipped an Ashby posting without an id or title.");
      continue;
    }
    const sourceUrl = text(value.jobUrl) ?? `https://jobs.ashbyhq.com/${board}/${id}`;
    const applicationUrl = text(value.applyUrl) ?? `${sourceUrl.replace(/\/$/, "")}/application`;
    const locations = locationsOf(value);
    // Ashby sets isRemote on hybrid jobs too (Notion, Replit: "Hybrid", office
    // only). A job is remote when its workplace type is Remote or one of its
    // listed locations is a remote one ("Remote (US)" beside an HQ).
    const workplace = text(value.workplaceType)?.toLowerCase() ?? "";
    const remote = /\bremote\b/.test(workplace) || locations.some((location) => /\bremote\b/i.test(location)) ||
      (!workplace && value.isRemote === true);
    const hybrid = !remote && /\bhybrid\b/.test(workplace);
    const employmentType = text(value.employmentType);
    const description = text(value.descriptionPlain) ?? "";
    const matched = queries.filter((query) => searchQueryMatches(query, [title, text(value.department), text(value.team), locations.join(" "), description].filter(Boolean).join(" ").toLowerCase()));
    if (queries.length > 0 && matched.length === 0) continue;
    const rawText = [
      company,
      title,
      locations.length > 0 ? `Location: ${locations.join("; ")}${remote ? " (Remote)" : hybrid ? " (Hybrid)" : workplace === "onsite" ? " (On-site)" : ""}` : remote ? "Location: Remote" : undefined,
      employmentType ? `Employment type: ${employmentType}` : undefined,
      "",
      description,
    ].filter((line) => line !== undefined).join("\n");
    const publishedAt = text(value.publishedAt);
    listings.push({
      input: { rawText, sourceUrl, applicationUrl, companyHint: company, titleHint: title, isExample: false },
      sourceRecordId: id,
      ...(matched.length > 0 ? { searchQueries: matched } : {}),
      ...(publishedAt && !Number.isNaN(Date.parse(publishedAt)) ? { sourcePublishedAt: new Date(publishedAt).toISOString() } : {}),
      discoveredAt: capturedAt,
      sourceMode: "live",
    });
  }
  listings.sort((left, right) => Date.parse(right.sourcePublishedAt ?? "0") - Date.parse(left.sourcePublishedAt ?? "0"));
  return { listings: listings.slice(0, maxResults), ...(warnings.length > 0 ? { warnings } : {}) };
}

/** Discovers one employer's Ashby board through the public posting API. */
export class AshbyBoardSource implements JobSource {
  public readonly id: string;
  public readonly mode = "live" as const;
  public readonly board: string;
  private readonly company?: string;
  private readonly endpoint: string;
  private readonly fetcher: Fetcher;
  private readonly now: () => string;
  private readonly maxResults: number;

  constructor(options: AshbyBoardSourceOptions) {
    this.board = options.board.trim();
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(this.board)) throw new Error(`Invalid Ashby board name: ${options.board}`);
    this.id = ashbyBoardSourceId(this.board);
    this.company = options.company?.trim() || undefined;
    this.endpoint = (options.endpoint ?? DEFAULT_ASHBY_POSTING_API_BASE_URL).replace(/\/$/, "");
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxResults = options.maxResults ?? 50;
  }

  classifyActionability(job: JobPosting, listing: JobSourceListing): "actionable" | "discoverable_only" {
    const id = listing.sourceRecordId ?? "";
    return !listing.input.isExample && Boolean(id) &&
      isVerifiedAshbyHostedUrl(job.sourceUrl, this.board, id) &&
      isVerifiedAshbyApplicationUrl(job.applicationUrl, this.board, id)
      ? "actionable"
      : "discoverable_only";
  }

  async discover(criteria: SearchCriteria, context?: DiscoveryContext): Promise<JobSourceBatch> {
    const response = await this.fetcher(`${this.endpoint}/${encodeURIComponent(this.board)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Ashby board request for ${this.board} failed with HTTP ${response.status}${response.status === 429 ? " (rate limited)" : ""}.`);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Ashby returned invalid JSON for ${this.board}.`);
    }
    return parseAshbyBoardResponse(
      payload,
      this.board,
      criteria,
      context?.now ?? this.now(),
      Math.min(context?.maxResults ?? this.maxResults, this.maxResults),
      this.company,
    );
  }
}
