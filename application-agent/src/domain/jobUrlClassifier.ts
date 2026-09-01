import { canonicalJobUrl } from "./scout";

export type AtsClassificationKind = "lever" | "greenhouse" | "ashby" | "workday" | "custom" | "unknown";

export interface JobUrlClassification {
  kind: AtsClassificationKind;
  canonicalUrl?: string;
  siteIdentifier?: string;
  postingIdentifier?: string;
  evidence: readonly string[];
}

const LEVER_HOSTS = new Set(["jobs.lever.co", "jobs.eu.lever.co"]);
const GREENHOUSE_HOSTS = new Set(["boards.greenhouse.io", "job-boards.greenhouse.io"]);
const ASHBY_HOSTS = new Set(["jobs.ashbyhq.com", "jobs.ashby.com"]);

function decodeSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function pathSegments(url: URL): string[] | undefined {
  const segments: string[] = [];
  for (const segment of url.pathname.split("/").filter(Boolean)) {
    const decoded = decodeSegment(segment);
    if (!decoded) return undefined;
    segments.push(decoded);
  }
  return segments;
}

function normalizedHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, "");
}

function invalidClassification(): JobUrlClassification {
  return { kind: "unknown", evidence: ["URL is not a valid HTTP(S) URL."] };
}

/**
 * Classify only deterministic hostname/path evidence. A word in a query string
 * or arbitrary page path is never enough to claim an ATS.
 */
export function classifyJobUrl(value: string): JobUrlClassification {
  const canonicalUrl = canonicalJobUrl(value);
  if (!canonicalUrl) return invalidClassification();

  let url: URL;
  try {
    url = new URL(canonicalUrl);
  } catch {
    return invalidClassification();
  }
  const host = normalizedHost(url);
  const segments = pathSegments(url);
  if (!segments) return { kind: "unknown", canonicalUrl, evidence: ["URL path contains an invalid encoded segment."] };

  if (LEVER_HOSTS.has(host) &&
    (segments.length === 2 || (segments.length === 3 && segments[2].toLowerCase() === "apply")) &&
    segments[0].length > 0 && segments[1].length > 0) {
    return {
      kind: "lever",
      canonicalUrl,
      siteIdentifier: segments[0],
      postingIdentifier: segments[1],
      evidence: [`hostname:${host}`, "path:<site>/<posting>"],
    };
  }

  if (GREENHOUSE_HOSTS.has(host) &&
    segments.length === 3 &&
    segments[1].toLowerCase() === "jobs" &&
    segments[0].length > 0 &&
    /^\d+$/.test(segments[2])) {
    return {
      kind: "greenhouse",
      canonicalUrl,
      siteIdentifier: segments[0],
      postingIdentifier: segments[2],
      evidence: [`hostname:${host}`, "path:<board>/jobs/<numeric-id>"],
    };
  }

  if (ASHBY_HOSTS.has(host) && segments.length >= 2 && segments[0].length > 0 && segments[1].length > 0) {
    return {
      kind: "ashby",
      canonicalUrl,
      siteIdentifier: segments[0],
      postingIdentifier: segments[1],
      evidence: [`hostname:${host}`, "path:<organization>/<posting>"],
    };
  }

  if (host.endsWith(".myworkdayjobs.com") && host.length > ".myworkdayjobs.com".length && segments.length > 0) {
    return {
      kind: "workday",
      canonicalUrl,
      siteIdentifier: host.slice(0, -".myworkdayjobs.com".length),
      evidence: [`hostname:${host}`, "known Workday tenant hostname"],
    };
  }

  return {
    kind: "custom",
    canonicalUrl,
    evidence: ["valid HTTP(S) URL did not match a supported ATS hostname/path."],
  };
}
