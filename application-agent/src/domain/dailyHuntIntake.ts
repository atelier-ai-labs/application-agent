import { canonicalJobUrl } from "./scout";
import { classifyJobUrl } from "./jobUrlClassifier";
import type { JobIntakeInput } from "./types";

const DEFAULT_MAX_CANDIDATES = 8;
const MAX_MESSAGE_CHARS = 200_000;
const MAX_BLOCK_CHARS = 12_000;
const MAX_CONTEXT_LINES = 18;

export interface DailyHuntLink {
  label: string;
  url: string;
}

export interface DailyHuntPostingCandidate {
  input: JobIntakeInput;
  applicationLink: DailyHuntLink;
  /** The nearby employer/posting link when it is unambiguously job-like. */
  sourceLink?: DailyHuntLink;
  companyHint?: string;
  titleHint?: string;
}

export interface DailyHuntSkippedLink {
  label: string;
  url: string;
  reason: string;
}

export interface DailyHuntParseResult {
  candidates: readonly DailyHuntPostingCandidate[];
  skipped: readonly DailyHuntSkippedLink[];
}

export interface ParseDailyHuntOptions {
  maxCandidates?: number;
}

interface MarkdownLink extends DailyHuntLink {
  start: number;
  end: number;
}

interface Descriptor {
  lineIndex: number;
  companyHint?: string;
  titleHint?: string;
  links: readonly MarkdownLink[];
}

function clean(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function canonical(value: string): string | undefined {
  return canonicalJobUrl(value);
}

function stripMarkdown(value: string): string {
  return value
    .replace(/[^]*/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/^\s*#{1,6}\s*/, "")
    .replace(/^\s*(?:🥇|🥈|🥉|#\d+)\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "")
    .trim();
}

function lineForIndex(lines: readonly string[], index: number): number {
  let offset = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineEnd = offset + lines[lineIndex].length;
    if (index <= lineEnd) return lineIndex;
    offset = lineEnd + 1;
  }
  return Math.max(0, lines.length - 1);
}

function linksInLine(line: string, offset: number): readonly MarkdownLink[] {
  const links: MarkdownLink[] = [];
  const pattern = /\[([^\]]{1,240})\]\((https?:\/\/[^\s)]+)\)/gi;
  for (const match of line.matchAll(pattern)) {
    const label = clean(match[1]);
    const url = match[2] ? canonical(match[2]) : undefined;
    if (!label || !url || match.index === undefined) continue;
    links.push({ label, url, start: offset + match.index, end: offset + match.index + match[0].length });
  }
  return links;
}

function isApplyLink(link: DailyHuntLink): boolean {
  return /\bapply(?:\s+directly)?\b|application\s+(?:link|route|page)/i.test(link.label);
}

function looksLikeJobUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /(?:\/job(?:s)?(?:\/|$)|\/application(?:\/|$)|\/apply(?:\/|$)|\/careers?(?:\/|$)|\/positions?(?:\/|$))/i.test(url.pathname) ||
      /(?:ashbyhq|lever\.co|greenhouse|rippling|workday)/i.test(url.hostname);
  } catch {
    return false;
  }
}

function postingUrlForApplication(value: string): string | undefined {
  const classification = classifyJobUrl(value);
  if (!classification.canonicalUrl) return undefined;
  if (classification.kind !== "lever" && classification.kind !== "rippling" && classification.kind !== "ashby") {
    return classification.canonicalUrl;
  }
  try {
    const url = new URL(classification.canonicalUrl);
    url.pathname = url.pathname.replace(/\/(?:apply|application)\/?$/i, "");
    return canonical(url.toString());
  } catch {
    return undefined;
  }
}

function descriptorFromLine(line: string, lineIndex: number, links: readonly MarkdownLink[]): Descriptor | undefined {
  if (links.some(isApplyLink)) return undefined;
  const cleaned = stripMarkdown(line);
  if (!cleaned || !/[—–]/.test(cleaned)) return undefined;

  const parts = cleaned.split(/\s+[—–]\s+/).map(clean).filter((part): part is string => Boolean(part));
  if (parts.length < 2) return undefined;

  const companyLink = links.find((link) => !isApplyLink(link));
  if (companyLink) {
    return {
      lineIndex,
      companyHint: companyLink.label,
      titleHint: parts[0]?.includes(companyLink.label) ? parts[1] : parts[0],
      links,
    };
  }

  // A report may omit the company in a title line. Keep the title hint, but
  // leave the company unresolved for the normal posting normalizer to reject
  // unless the surrounding public text contains it explicitly.
  return { lineIndex, titleHint: parts[0], links };
}

function descriptors(lines: readonly string[], offsets: readonly number[]): readonly Descriptor[] {
  const result: Descriptor[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const descriptor = descriptorFromLine(lines[index], index, linksInLine(lines[index], offsets[index]));
    if (descriptor) result.push(descriptor);
  }
  return result;
}

function nearestDescriptor(all: readonly Descriptor[], lineIndex: number): Descriptor | undefined {
  return [...all]
    .reverse()
    .find((descriptor) => descriptor.lineIndex <= lineIndex && lineIndex - descriptor.lineIndex <= MAX_CONTEXT_LINES);
}

function blockText(lines: readonly string[], descriptor: Descriptor | undefined, applyLine: number): string {
  const start = descriptor?.lineIndex ?? Math.max(0, applyLine - 8);
  const end = Math.min(lines.length, Math.max(applyLine + 1, start + MAX_CONTEXT_LINES));
  return lines.slice(start, end).join("\n").slice(0, MAX_BLOCK_CHARS).trim();
}

function offsetsFor(lines: readonly string[]): readonly number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  return offsets;
}

/**
 * Parse only explicit Markdown Apply links from a daily hunt report. This is
 * intentionally not a page scraper: it never invents an application URL from
 * a company homepage, and it leaves missing company/title/source evidence for
 * the existing intake validation to handle.
 */
export function parseDailyHuntMessage(
  message: string,
  options: ParseDailyHuntOptions = {},
): DailyHuntParseResult {
  if (typeof message !== "string" || message.trim().length === 0) {
    return { candidates: [], skipped: [] };
  }
  const boundedMessage = message.slice(0, MAX_MESSAGE_CHARS);
  const lines = boundedMessage.split(/\r?\n/);
  const offsets = offsetsFor(lines);
  const allLinks = lines.flatMap((line, index) => linksInLine(line, offsets[index]));
  const descriptorsFound = descriptors(lines, offsets);
  const applyLinks = allLinks.filter(isApplyLink);
  const candidates: DailyHuntPostingCandidate[] = [];
  const skipped: DailyHuntSkippedLink[] = [];
  const seen = new Set<string>();
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  if (!Number.isInteger(maxCandidates) || maxCandidates <= 0) {
    throw new Error("Daily hunt candidate cap must be a positive integer.");
  }

  for (const applyLink of applyLinks) {
    if (candidates.length >= maxCandidates) {
      skipped.push({ label: applyLink.label, url: applyLink.url, reason: "Daily hunt candidate cap reached." });
      continue;
    }
    if (seen.has(applyLink.url)) {
      skipped.push({ label: applyLink.label, url: applyLink.url, reason: "Duplicate application link." });
      continue;
    }
    seen.add(applyLink.url);
    const lineIndex = lineForIndex(lines, applyLink.start);
    const descriptor = nearestDescriptor(descriptorsFound, lineIndex);
    const sourceLink = descriptor?.links.find((link) => !isApplyLink(link) && looksLikeJobUrl(link.url));
    const sourceUrl = sourceLink?.url ?? (looksLikeJobUrl(applyLink.url) ? postingUrlForApplication(applyLink.url) : undefined);
    const rawText = blockText(lines, descriptor, lineIndex);
    if (rawText.length < 20) {
      skipped.push({ label: applyLink.label, url: applyLink.url, reason: "The Apply link has insufficient public posting context." });
      continue;
    }

    candidates.push({
      input: {
        rawText,
        applicationUrl: applyLink.url,
        ...(sourceUrl ? { sourceUrl } : {}),
        ...(descriptor?.companyHint ? { companyHint: descriptor.companyHint } : {}),
        ...(descriptor?.titleHint ? { titleHint: descriptor.titleHint } : {}),
      },
      applicationLink: { label: applyLink.label, url: applyLink.url },
      ...(sourceLink ? { sourceLink: { label: sourceLink.label, url: sourceLink.url } } : {}),
      ...(descriptor?.companyHint ? { companyHint: descriptor.companyHint } : {}),
      ...(descriptor?.titleHint ? { titleHint: descriptor.titleHint } : {}),
    });
  }

  return { candidates, skipped };
}
