import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveDirectPostingLink, type DirectLinkProvider } from "./directLinkResolver";
import type { ScoutedJob } from "../src/domain/scout";

/**
 * The job search only reads the employer boards it knows, so it saw the same
 * few hundred postings every night. Every company a feed (Remotive,
 * Himalayas, The Muse) mentions is a lead: when that company has a public
 * Greenhouse, Lever or Ashby board that lists the same role the feed showed,
 * the board is learned and searched directly from then on.
 *
 * Learned boards live in their own file so the user's discovery.json stays
 * theirs; the runtime reads both.
 */
export const DEFAULT_LEARNED_BOARDS_FILE = ".local/career-agent/learned-boards.json";
export const MAX_LEARNED_BOARDS_PER_ATS = 150;
/** A company whose board was not found is not looked up again for this long. */
const RECHECK_DAYS = 30;

export interface LearnedBoards {
  greenhouse: string[];
  lever: string[];
  ashby: string[];
  /** Company key → ISO date it was last looked up (found or not). */
  checked: Record<string, string>;
}

const empty = (): LearnedBoards => ({ greenhouse: [], lever: [], ashby: [], checked: {} });
const companyKey = (company: string) => company.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function loadLearnedBoards(file = DEFAULT_LEARNED_BOARDS_FILE): LearnedBoards {
  const path = resolve(file);
  if (!existsSync(path)) return empty();
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LearnedBoards>;
    const list = (entries: unknown) => (Array.isArray(entries) ? entries.filter((entry): entry is string => typeof entry === "string" && /^[a-z0-9][a-z0-9._-]{0,80}$/i.test(entry)) : []);
    return {
      greenhouse: list(value.greenhouse).slice(0, MAX_LEARNED_BOARDS_PER_ATS),
      lever: list(value.lever).slice(0, MAX_LEARNED_BOARDS_PER_ATS),
      ashby: list(value.ashby).slice(0, MAX_LEARNED_BOARDS_PER_ATS),
      checked: value.checked && typeof value.checked === "object" ? Object.fromEntries(Object.entries(value.checked).filter(([, date]) => typeof date === "string")) as Record<string, string> : {},
    };
  } catch {
    return empty();
  }
}

export function saveLearnedBoards(boards: LearnedBoards, file = DEFAULT_LEARNED_BOARDS_FILE): void {
  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(boards, null, 2)}\n`);
}

/** Board source ids look like "greenhouse:arizeai", "lever:drivetrain", "ashby:span.app". */
function boardOf(sourceId: string): { provider: DirectLinkProvider; slug: string } | undefined {
  const match = /^(greenhouse|lever|ashby):(.+)$/.exec(sourceId);
  return match ? { provider: match[1] as DirectLinkProvider, slug: match[2]!.toLowerCase() } : undefined;
}

export interface BoardLearningResult {
  learned: { company: string; provider: DirectLinkProvider; slug: string }[];
  probed: number;
}

/**
 * Looks up the boards of up to `maxProbes` feed companies that are not known
 * yet and were not checked in the last 30 days, and adds the ones whose board
 * lists the role the feed showed. The `learned` object is updated in place.
 */
export async function learnBoardsFromFeeds(options: {
  jobs: readonly ScoutedJob[];
  /** Boards already searched (discovery.json plus learned), as "provider:slug". */
  known: ReadonlySet<string>;
  learned: LearnedBoards;
  resolve?: typeof resolveDirectPostingLink;
  maxProbes?: number;
  now?: Date;
}): Promise<BoardLearningResult> {
  const resolveLink = options.resolve ?? resolveDirectPostingLink;
  const now = options.now ?? new Date();
  const maxProbes = options.maxProbes ?? 25;
  const knownBoards = new Set([...options.known].map((entry) => entry.toLowerCase()));
  // Companies already covered by a board source need no lookup.
  const coveredCompanies = new Set(options.jobs.filter((job) => boardOf(job.sourceId)).map((job) => companyKey(job.job.company)));
  const leads = new Map<string, { company: string; role: string; listingUrl?: string }>();
  for (const scouted of options.jobs) {
    if (boardOf(scouted.sourceId)) continue;
    const company = scouted.job.company.trim();
    const key = companyKey(company);
    if (!key || coveredCompanies.has(key) || leads.has(key)) continue;
    const last = options.learned.checked[key];
    if (last && now.getTime() - new Date(last).getTime() < RECHECK_DAYS * 86_400_000) continue;
    leads.set(key, { company, role: scouted.job.title.trim(), ...(scouted.job.sourceUrl ? { listingUrl: scouted.job.sourceUrl } : {}) });
  }
  const result: BoardLearningResult = { learned: [], probed: 0 };
  for (const [key, lead] of [...leads].slice(0, maxProbes)) {
    result.probed += 1;
    options.learned.checked[key] = now.toISOString();
    const found = await resolveLink(lead).catch(() => undefined);
    if (found?.status !== "resolved") continue;
    const slug = found.board.toLowerCase();
    if (knownBoards.has(`${found.provider}:${slug}`)) continue;
    const list = options.learned[found.provider];
    if (list.length >= MAX_LEARNED_BOARDS_PER_ATS) continue;
    list.push(found.board);
    knownBoards.add(`${found.provider}:${slug}`);
    result.learned.push({ company: lead.company, provider: found.provider, slug: found.board });
  }
  return result;
}
