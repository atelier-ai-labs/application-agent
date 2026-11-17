/**
 * Where the Career Agent looks for jobs. What it looks for (role lanes,
 * seniority, locations, employment types, breadth) stays in the search
 * intent; this file only chooses sources and employer boards, so a user can
 * search broadly (every feed) or narrowly (a few companies' boards).
 */
export interface DiscoverySources {
  /** Remotive remote-jobs feed (no key). */
  remotive: boolean;
  /** Himalayas remote-jobs search (no key). */
  himalayas: boolean;
  /** The Muse public jobs API, searched per configured city and remote (no key). */
  themuse: boolean;
  /** Brave web search; also requires ATELIER_BRAVE_SEARCH_API_KEY (Brave asks for a card). */
  brave: boolean;
}

export interface DiscoveryConfig {
  sources: DiscoverySources;
  /** Employer job boards, by ATS, searched directly; links are already application-ready. */
  employerBoards: { greenhouse: string[]; lever: string[]; ashby: string[] };
}

export const DEFAULT_DISCOVERY_CONFIG: DiscoveryConfig = {
  sources: { remotive: true, himalayas: true, themuse: true, brave: false },
  employerBoards: { greenhouse: [], lever: [], ashby: [] },
};

const BOARD = /^[a-z0-9][a-z0-9._-]{0,80}$/i;
const MAX_BOARDS_PER_ATS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boards(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`discovery employerBoards.${label} must be a list of board names.`);
  const seen = new Map<string, string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !BOARD.test(entry.trim())) {
      throw new Error(`discovery employerBoards.${label} has an invalid board name: ${JSON.stringify(entry)}.`);
    }
    const board = entry.trim();
    if (!seen.has(board.toLowerCase())) seen.set(board.toLowerCase(), board);
  }
  if (seen.size > MAX_BOARDS_PER_ATS) throw new Error(`discovery employerBoards.${label} lists more than ${MAX_BOARDS_PER_ATS} boards.`);
  return [...seen.values()];
}

/** Validates a discovery config; missing fields take the defaults. */
export function parseDiscoveryConfig(value: unknown): DiscoveryConfig {
  if (!isRecord(value)) throw new Error("The discovery config must be a JSON object.");
  const sourcesValue = value.sources === undefined ? {} : value.sources;
  if (!isRecord(sourcesValue)) throw new Error("discovery sources must be an object of true/false switches.");
  const sources = { ...DEFAULT_DISCOVERY_CONFIG.sources };
  for (const [name, enabled] of Object.entries(sourcesValue)) {
    if (!(name in sources)) throw new Error(`Unknown discovery source "${name}"; use ${Object.keys(sources).join(", ")}.`);
    if (typeof enabled !== "boolean") throw new Error(`discovery sources.${name} must be true or false.`);
    sources[name as keyof DiscoverySources] = enabled;
  }
  const boardsValue = value.employerBoards === undefined ? {} : value.employerBoards;
  if (!isRecord(boardsValue)) throw new Error("discovery employerBoards must be an object with greenhouse, lever, and ashby lists.");
  for (const name of Object.keys(boardsValue)) {
    if (!["greenhouse", "lever", "ashby"].includes(name)) throw new Error(`Unknown employer board platform "${name}"; use greenhouse, lever, or ashby.`);
  }
  return {
    sources,
    employerBoards: {
      greenhouse: boards(boardsValue.greenhouse, "greenhouse"),
      lever: boards(boardsValue.lever, "lever"),
      ashby: boards(boardsValue.ashby, "ashby"),
    },
  };
}
