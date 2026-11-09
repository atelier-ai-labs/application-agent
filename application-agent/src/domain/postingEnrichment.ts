import type { JobIntakeInput } from "./types";
import { containsPostingContent, enrichAshbyJobIntake } from "./ashbyJobSource";
import { stripGreenhouseHtml } from "./greenhouseJobSource";

type Fetch = (input: string, init?: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown>; text(): Promise<string> }>;

export interface PostingEnrichmentOptions {
  fetchImpl?: Fetch;
  timeoutMs?: number;
}

/** "job-boards.greenhouse.io/mercury/jobs/6101145004", "boards.greenhouse.io/x/jobs/1", or the embed form. */
export function greenhousePostingRef(url: string | undefined): { board: string; id: string } | undefined {
  if (!url) return undefined;
  const hosted = /^https:\/\/(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\/([a-z0-9_-]+)\/jobs\/(\d+)/i.exec(url);
  if (hosted) return { board: hosted[1]!.toLowerCase(), id: hosted[2]! };
  const embed = /^https:\/\/(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\/embed\/job_app\?(?=.*\bfor=([a-z0-9_-]+))(?=.*\btoken=(\d+))/i.exec(url);
  return embed ? { board: embed[1]!.toLowerCase(), id: embed[2]! } : undefined;
}

/** "jobs.lever.co/drivetrain/<uuid>[/apply]". */
export function leverPostingRef(url: string | undefined): { site: string; id: string } | undefined {
  const match = url ? /^https:\/\/jobs(?:\.eu)?\.lever\.co\/([a-z0-9._-]+)\/([0-9a-f-]{36})/i.exec(url) : null;
  return match ? { site: match[1]!.toLowerCase(), id: match[2]!.toLowerCase() } : undefined;
}

async function fetchJson(fetchImpl: Fetch, url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  mdash: "—", ndash: "–", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", bull: "•", middot: "·", trade: "™", reg: "®", copy: "©",
};

/** Greenhouse content can keep named entities the HTML cleaner doesn't know ("$122,400 &mdash; $158,400"), which hides pay ranges. */
function decodeNamedEntities(text: string): string {
  return text.replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function withDescription(input: JobIntakeInput, description: string | undefined): JobIntakeInput {
  const text = description ? decodeNamedEntities(description).trim() : undefined;
  if (!text || text.length < 80) return input;
  return { ...input, rawText: `${text}\n\nQueue context:\n${input.rawText.trim()}` };
}

/**
 * Queue rows found by the nightly search carry only a link and a note, so the
 * fit check and the essay drafter had nothing to read for Greenhouse and Lever
 * postings (Mercury, 2026-11-09). Fetch the posting from the board's public
 * API, as Ashby postings already are. A failure keeps the original input.
 */
export async function enrichJobIntake(input: JobIntakeInput, options: PostingEnrichmentOptions = {}): Promise<JobIntakeInput> {
  if (containsPostingContent(input.rawText)) return input;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as Fetch | undefined);
  if (!fetchImpl) return input;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const urls = [input.sourceUrl, input.applicationUrl];

  const greenhouse = urls.map(greenhousePostingRef).find(Boolean);
  if (greenhouse) {
    const posting = await fetchJson(fetchImpl, `https://boards-api.greenhouse.io/v1/boards/${greenhouse.board}/jobs/${greenhouse.id}`, timeoutMs) as
      { title?: string; content?: string; location?: { name?: string } } | undefined;
    if (!posting?.content) return input;
    const header = [posting.title, posting.location?.name ? `Location: ${posting.location.name}` : undefined].filter(Boolean).join("\n");
    return withDescription(input, `${header}\n\n${stripGreenhouseHtml(posting.content)}`);
  }

  const lever = urls.map(leverPostingRef).find(Boolean);
  if (lever) {
    const posting = await fetchJson(fetchImpl, `https://api.lever.co/v0/postings/${lever.site}/${lever.id}?mode=json`, timeoutMs) as
      { text?: string; categories?: { location?: string }; descriptionPlain?: string; lists?: { text?: string; content?: string }[]; additionalPlain?: string } | undefined;
    if (!posting?.descriptionPlain) return input;
    const lists = (posting.lists ?? []).map((list) => `${list.text ?? ""}\n${stripGreenhouseHtml(list.content ?? "")}`).join("\n\n");
    const header = [posting.text, posting.categories?.location ? `Location: ${posting.categories.location}` : undefined].filter(Boolean).join("\n");
    return withDescription(input, [header, posting.descriptionPlain, lists, posting.additionalPlain].filter(Boolean).join("\n\n"));
  }

  return enrichAshbyJobIntake(input, { ...(options.fetchImpl ? { fetchImpl: options.fetchImpl as never } : {}), timeoutMs });
}
