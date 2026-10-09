import type { JobIntakeInput } from "./types";

/** Small fetch surface so sparse queue rows can be tested without network access. */
export interface AshbyFetchResponse {
  ok: boolean;
  text(): Promise<string>;
}

export interface AshbyJobSourceOptions {
  fetchImpl?: (input: string, init?: RequestInit) => Promise<AshbyFetchResponse>;
  timeoutMs?: number;
}

function isAshbyUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return /^(?:jobs\.ashbyhq\.com|jobs\.ashby\.com)$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function readAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
  return match?.[2];
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripHtml(value: string): string {
  return decodeHtml(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p\s*>|<\/li\s*>|<\/h[1-6]\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** Read a JSON-encoded string property from Ashby's inline initial state. */
function readInlineJsonString(html: string, property: string): string | undefined {
  const marker = `"${property}":"`;
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const valueStart = markerIndex + marker.length - 1;
  let escaped = false;
  for (let index = valueStart + 1; index < html.length; index += 1) {
    const character = html[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      try {
        return JSON.parse(html.slice(valueStart, index + 1)) as string;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function readMetaDescription(html: string): string | undefined {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if (readAttribute(tag, "name")?.toLowerCase() !== "description") continue;
    return readAttribute(tag, "content");
  }
  return undefined;
}

function extractDescription(html: string): string | undefined {
  const inlineDescription = readInlineJsonString(html, "descriptionHtml");
  const description = inlineDescription ? stripHtml(inlineDescription) : stripHtml(readMetaDescription(html) ?? "");
  return description.length >= 80 ? description : undefined;
}

function containsPostingContent(rawText: string): boolean {
  const normalized = rawText.replace(/https?:\/\/\S+/gi, " ").trim();
  if (/\b(?:required qualifications?|responsibilities|what you(?:'|’)ll do|nice to have)\b/i.test(normalized) &&
    /\b(?:build|operate|own|design|develop|support)\b/i.test(normalized)) return true;
  if (normalized.length < 120) return false;
  return /\b(?:about (?:the )?role|what you(?:'|’)ll|responsibilit(?:y|ies)|qualifications?|requirements?|nice to have|experience|build|operate|infrastructure|skills?)\b/i.test(normalized);
}

/**
 * Queue rows intentionally carry short notes. When an Ashby row does not
 * include actual posting prose, enrich it from the public posting page before
 * normalization so fit and resume-family selection see the real requirements.
 * Network failure is non-fatal: the original queue input remains usable.
 */
export async function enrichAshbyJobIntake(
  input: JobIntakeInput,
  options: AshbyJobSourceOptions = {},
): Promise<JobIntakeInput> {
  if (containsPostingContent(input.rawText) || (!isAshbyUrl(input.sourceUrl) && !isAshbyUrl(input.applicationUrl))) return input;
  const sourceUrl = input.sourceUrl ?? input.applicationUrl;
  if (!sourceUrl) return input;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) return input;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await fetchImpl(sourceUrl, { signal: controller.signal });
    if (!response.ok) return input;
    const html = await response.text();
    const description = extractDescription(html);
    if (!description) return input;
    return {
      ...input,
      rawText: `${description}\n\nQueue context:\n${input.rawText.trim()}`,
    };
  } catch {
    return input;
  } finally {
    clearTimeout(timeout);
  }
}
