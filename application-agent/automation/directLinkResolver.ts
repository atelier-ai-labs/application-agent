import { queueDestinationPreflightReason } from "./standaloneJobQueueWorker";

/**
 * Upgrades an aggregator/listing tracker link to the employer's own posting on
 * a supported ATS. It reads only the public, unauthenticated job-board APIs of
 * Greenhouse, Lever, and Ashby, and returns a link only when exactly one
 * posting on a board that plausibly belongs to the company matches the role.
 * It never guesses: no match, several matches, or a link the queue would not
 * accept all resolve to "not resolved".
 */

export type DirectLinkProvider = "greenhouse" | "lever" | "ashby";

export type DirectLinkResolution =
  | { status: "resolved"; url: string; provider: DirectLinkProvider; board: string; postingTitle: string; postingLocation?: string }
  | { status: "not_found" | "ambiguous"; reason: string };

export type DirectLinkFetcher = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface BoardPosting {
  id: string;
  title: string;
  location?: string;
}

const LEGAL_SUFFIX = /\b(?:inc|incorporated|llc|l l c|corp|corporation|co|company|ltd|limited|plc|gmbh)\b/g;
const SENIORITY = ["senior", "sr", "staff", "principal", "lead", "manager", "director", "head", "chief", "vp", "intern"];

function key(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

function companyKey(company: string): string {
  return key(company).replace(LEGAL_SUFFIX, " ").replace(/\s+/g, " ").trim();
}

/** A few deterministic board-slug spellings of a company name; never fuzzy. */
export function companySlugCandidates(company: string): string[] {
  const words = companyKey(company).split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const withoutAi = words.at(-1) === "ai" && words.length > 1 ? words.slice(0, -1) : undefined;
  const candidates = [words.join(""), words.join("-"), ...(withoutAi ? [withoutAi.join(""), withoutAi.join("-"), `${withoutAi.join("")}ai`] : [])];
  return [...new Set(candidates)].filter((slug) => /^[a-z0-9][a-z0-9-]{1,60}$/.test(slug));
}

function roleTokens(value: string): string[] {
  return key(value).replace(/\bsr\b/g, "senior").replace(/\bjr\b/g, "junior").split(" ").filter(Boolean);
}

/**
 * True when the posting title is the tracker role: identical after
 * normalization, or containing every role word without adding a seniority
 * level the role did not ask for.
 */
export function titleMatchesRole(postingTitle: string, role: string): boolean {
  const posting = roleTokens(postingTitle);
  const wanted = roleTokens(role);
  if (posting.length === 0 || wanted.length === 0) return false;
  if (posting.join(" ") === wanted.join(" ")) return true;
  const postingSet = new Set(posting);
  if (!wanted.every((token) => postingSet.has(token))) return false;
  const wantedSet = new Set(wanted);
  return !posting.some((token) => SENIORITY.includes(token) && !wantedSet.has(token));
}

async function fetchJson(fetcher: DirectLinkFetcher, url: string): Promise<unknown | undefined> {
  try {
    const response = await fetcher(url);
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const GENERIC_COMPANY_WORDS = new Set(["technologies", "technology", "tech", "labs", "software", "group", "systems", "ai", "hq", "io", "the"]);

/** Same employer, allowing only one generic extra word ("Torc" / "Torc Robotics" is not enough; "Acme" / "Acme Labs" is). */
export function sameCompany(boardName: string, company: string): boolean {
  const a = companyKey(boardName).split(" ").filter(Boolean);
  const b = companyKey(company).split(" ").filter(Boolean);
  if (a.length === 0 || b.length === 0) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.join(" ") === longer.join(" ")) return true;
  const extra = longer.slice(shorter.length);
  return longer.slice(0, shorter.length).join(" ") === shorter.join(" ") && extra.length === 1 && GENERIC_COMPANY_WORDS.has(extra[0]!);
}

async function greenhouseBoard(fetcher: DirectLinkFetcher, slug: string, company: string): Promise<BoardPosting[] | undefined> {
  // Greenhouse exposes the board's company name; require it to match so a
  // slug that happens to exist for another employer is not trusted.
  const board = record(await fetchJson(fetcher, `https://boards-api.greenhouse.io/v1/boards/${slug}`));
  if (!sameCompany(text(board?.name) ?? "", company)) return undefined;
  const jobs = record(await fetchJson(fetcher, `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`))?.jobs;
  if (!Array.isArray(jobs)) return undefined;
  return jobs.flatMap((job) => {
    const item = record(job);
    const id = item?.id;
    const title = text(item?.title);
    return (typeof id === "number" || typeof id === "string") && title
      ? [{ id: String(id), title, location: text(record(item?.location)?.name) }]
      : [];
  });
}

async function leverBoard(fetcher: DirectLinkFetcher, slug: string): Promise<BoardPosting[] | undefined> {
  const postings = await fetchJson(fetcher, `https://api.lever.co/v0/postings/${slug}?mode=json`);
  if (!Array.isArray(postings)) return undefined;
  return postings.flatMap((posting) => {
    const item = record(posting);
    const id = text(item?.id);
    const title = text(item?.text);
    return id && title ? [{ id, title, location: text(record(item?.categories)?.location) }] : [];
  });
}

async function ashbyBoard(fetcher: DirectLinkFetcher, slug: string): Promise<BoardPosting[] | undefined> {
  const jobs = record(await fetchJson(fetcher, `https://api.ashbyhq.com/posting-api/job-board/${slug}`))?.jobs;
  if (!Array.isArray(jobs)) return undefined;
  return jobs.flatMap((job) => {
    const item = record(job);
    const id = text(item?.id);
    const title = text(item?.title);
    return id && title && item?.isListed !== false ? [{ id, title, location: text(item?.location) }] : [];
  });
}

function postingUrl(provider: DirectLinkProvider, slug: string, id: string): string {
  if (provider === "greenhouse") return `https://job-boards.greenhouse.io/${slug}/jobs/${id}`;
  if (provider === "lever") return `https://jobs.lever.co/${slug}/${id}`;
  return `https://jobs.ashbyhq.com/${slug}/${id}`;
}

function prefersUsRemote(location: string | undefined): boolean {
  return /\bremote\b/i.test(location ?? "") && !/\b(?:canada|uk|united kingdom|europe|emea|apac|india|germany|mexico|brazil)\b/i.test(location ?? "");
}

export async function resolveDirectPostingLink(
  input: { company: string; role: string },
  fetcher: DirectLinkFetcher = (url) => fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) }),
): Promise<DirectLinkResolution> {
  const slugs = companySlugCandidates(input.company);
  if (slugs.length === 0) return { status: "not_found", reason: "The company name has no usable job-board identifier." };
  const found: { provider: DirectLinkProvider; slug: string; posting: BoardPosting }[] = [];
  let boardsSeen = 0;
  for (const slug of slugs) {
    for (const provider of ["greenhouse", "lever", "ashby"] as const) {
      const postings = provider === "greenhouse" ? await greenhouseBoard(fetcher, slug, input.company)
        : provider === "lever" ? await leverBoard(fetcher, slug)
          : await ashbyBoard(fetcher, slug);
      if (!postings) continue;
      boardsSeen += 1;
      for (const posting of postings) if (titleMatchesRole(posting.title, input.role)) found.push({ provider, slug, posting });
    }
    if (found.length > 0) break;
  }
  if (found.length === 0) {
    return { status: "not_found", reason: boardsSeen > 0
      ? "The company's public job board does not list this role (it may be closed)."
      : "No public Greenhouse, Lever, or Ashby board was found for this company." };
  }
  // An exact title beats variants such as "Platform Engineer (FedD145)".
  // Several exact listings usually differ only by location; keep a single
  // US-remote listing when that is unique, otherwise ask the human.
  const exact = found.filter(({ posting }) => roleTokens(posting.title).join(" ") === roleTokens(input.role).join(" "));
  const pool = exact.length > 0 ? exact : found;
  const usRemote = pool.filter(({ posting }) => prefersUsRemote(posting.location));
  const chosen = pool.length === 1 ? pool[0] : usRemote.length === 1 ? usRemote[0] : undefined;
  if (!chosen) return { status: "ambiguous", reason: `${pool.length} postings on the company's board match this role; pick the right one manually.` };
  const url = postingUrl(chosen.provider, chosen.slug, chosen.posting.id);
  if (queueDestinationPreflightReason({ jobLink: url })) {
    return { status: "not_found", reason: "The matching posting's link is not a route the queue can open." };
  }
  return {
    status: "resolved",
    url,
    provider: chosen.provider,
    board: chosen.slug,
    postingTitle: chosen.posting.title,
    ...(chosen.posting.location ? { postingLocation: chosen.posting.location } : {}),
  };
}
