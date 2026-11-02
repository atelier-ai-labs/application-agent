import type { SearchCriteria } from "./campaignTypes";
import type { JobSearchIntent } from "./searchIntent";
import type { DiscoveryContext, JobSource, JobSourceBatch, JobSourceListing } from "./scout";

/**
 * The Muse public jobs API: no key, no card, filterable by location (a city
 * or "Flexible / Remote"), level and category. Its links point at The Muse,
 * so listings are discoverable-only until a direct employer link is found.
 */
export const DEFAULT_MUSE_API_BASE_URL = "https://www.themuse.com/api/public/jobs";
export const MUSE_SOURCE_ID = "themuse-live";

type Fetcher = (input: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface MuseJobSourceOptions {
  endpoint?: string;
  fetcher?: Fetcher;
  now?: () => string;
  maxResults?: number;
  /** Pages fetched per location (20 postings each). */
  pagesPerLocation?: number;
  /** Postings published longer ago than this are skipped. */
  maxAgeDays?: number;
  categories?: readonly string[];
}

const MUSE_REMOTE_LOCATION = "Flexible / Remote";
const COUNTRY = /^(?:united states|us|usa|u\.s\.a?\.?|america)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function names(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => (isRecord(entry) ? text(entry.name) : undefined)).filter((entry): entry is string => Boolean(entry)) : [];
}

function stripHtml(value: string): string {
  return value.replace(/<(?:br|\/p|\/li|\/h\d)\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/&#39;|&rsquo;/g, "'").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

/** The Muse locations to search: each configured city, plus remote when the intent allows it. */
export function museLocations(intent: JobSearchIntent | undefined, criteria: SearchCriteria): string[] {
  const configured = (intent?.locations ?? criteria.locations ?? []).map((value) => value.trim()).filter(Boolean);
  const cities = configured.filter((value) => !COUNTRY.test(value));
  const remote = intent ? intent.remotePreference !== "any" || cities.length === 0 : true;
  return [...new Set([...cities, ...(remote ? [MUSE_REMOTE_LOCATION] : [])])];
}

/** The Muse levels for the intent's seniorities; empty means no level filter. */
export function museLevels(intent: JobSearchIntent | undefined): string[] {
  const wanted = (intent?.preferredSeniorities ?? []).map((value) => value.toLowerCase());
  const levels = new Set<string>();
  for (const value of wanted) {
    if (/junior|entry|associate|early|new grad|intern/.test(value)) levels.add("Entry Level");
    if (/mid/.test(value)) levels.add("Mid Level");
    if (/senior/.test(value)) levels.add("Senior Level");
  }
  return [...levels];
}

function titleMatches(query: string, title: string): boolean {
  const tokens = query.toLowerCase().split(/[^a-z0-9+#/.]+/).filter((token) => token.length > 1 && !["jobs", "remote", "engineer"].includes(token));
  const lower = title.toLowerCase();
  return tokens.length === 0 ? lower.includes(query.toLowerCase()) : tokens.every((token) => lower.includes(token));
}

/** Converts one Muse results page into listings; search terms must match the title. */
export function parseMuseResponse(
  payload: unknown,
  queries: readonly string[],
  capturedAt: string,
  maxAgeDays: number,
): { listings: JobSourceListing[]; pageCount: number } {
  if (!isRecord(payload) || !Array.isArray(payload.results)) throw new Error("The Muse did not return a results array.");
  const oldest = Date.parse(capturedAt) - maxAgeDays * 86_400_000;
  const listings: JobSourceListing[] = [];
  for (const value of payload.results) {
    if (!isRecord(value)) continue;
    const id = value.id === undefined ? undefined : String(value.id);
    const title = text(value.name);
    const company = isRecord(value.company) ? text(value.company.name) : undefined;
    const landing = isRecord(value.refs) ? text(value.refs.landing_page) : undefined;
    if (!id || !title || !company || !landing) continue;
    const published = text(value.publication_date);
    if (published && Date.parse(published) < oldest) continue;
    const matched = queries.filter((query) => titleMatches(query, title));
    if (queries.length > 0 && matched.length === 0) continue;
    const locations = names(value.locations);
    const levels = names(value.levels);
    const rawText = [
      company,
      title,
      locations.length > 0 ? `Location: ${locations.join("; ")}` : undefined,
      levels.length > 0 ? `Level: ${levels.join(", ")}` : undefined,
      "",
      stripHtml(text(value.contents) ?? ""),
    ].filter((line) => line !== undefined).join("\n");
    listings.push({
      input: { rawText, sourceUrl: landing, companyHint: company, titleHint: title, isExample: false },
      sourceRecordId: `themuse:${id}`,
      ...(matched.length > 0 ? { searchQueries: matched } : {}),
      ...(published && !Number.isNaN(Date.parse(published)) ? { sourcePublishedAt: new Date(published).toISOString() } : {}),
      discoveredAt: capturedAt,
      sourceMode: "live",
    });
  }
  return { listings, pageCount: typeof payload.page_count === "number" ? payload.page_count : 1 };
}

export class MuseJobSource implements JobSource {
  public readonly id = MUSE_SOURCE_ID;
  public readonly mode = "live" as const;
  private readonly endpoint: string;
  private readonly fetcher: Fetcher;
  private readonly now: () => string;
  private readonly maxResults: number;
  private readonly pagesPerLocation: number;
  private readonly maxAgeDays: number;
  private readonly categories: readonly string[];

  constructor(options: MuseJobSourceOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_MUSE_API_BASE_URL;
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxResults = options.maxResults ?? 50;
    this.pagesPerLocation = options.pagesPerLocation ?? 3;
    this.maxAgeDays = options.maxAgeDays ?? 60;
    this.categories = options.categories ?? ["Software Engineering", "Computer and IT", "Data and Analytics"];
  }

  /** The Muse links to its own page, not an application form. */
  classifyActionability(): "discoverable_only" {
    return "discoverable_only";
  }

  async discover(criteria: SearchCriteria, context?: DiscoveryContext): Promise<JobSourceBatch> {
    const capturedAt = context?.now ?? this.now();
    const maxResults = Math.min(context?.maxResults ?? this.maxResults, this.maxResults);
    const queries = [...(criteria.searchQueries ?? []), ...(context?.searchPlan ?? []).map((query) => query.term)].map((query) => query.trim()).filter(Boolean);
    const levels = museLevels(context?.searchIntent);
    const seen = new Set<string>();
    const listings: JobSourceListing[] = [];
    const warnings: string[] = [];
    for (const location of museLocations(context?.searchIntent, criteria)) {
      for (let page = 0; page < this.pagesPerLocation && listings.length < maxResults; page += 1) {
        const url = new URL(this.endpoint);
        url.searchParams.set("page", String(page));
        url.searchParams.append("location", location);
        for (const category of this.categories) url.searchParams.append("category", category);
        for (const level of levels) url.searchParams.append("level", level);
        // The Muse's CDN rejects requests without a browser-style user agent.
        const response = await this.fetcher(url.toString(), { method: "GET", headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (Atelier HQ job discovery)" } });
        if (!response.ok) {
          warnings.push(`The Muse request for ${location} page ${page} failed with HTTP ${response.status}.`);
          break;
        }
        const parsed = parseMuseResponse(await response.json(), queries, capturedAt, this.maxAgeDays);
        for (const listing of parsed.listings) {
          if (seen.has(listing.sourceRecordId!)) continue;
          seen.add(listing.sourceRecordId!);
          listings.push(listing);
        }
        if (page + 1 >= parsed.pageCount) break;
      }
    }
    return { listings: listings.slice(0, maxResults), ...(warnings.length > 0 ? { warnings } : {}) };
  }
}
