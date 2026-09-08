import { canonicalJobUrl } from "./scout";

export type AtsClassificationKind = "lever" | "greenhouse" | "rippling" | "ashby" | "workday" | "custom" | "unknown";

export interface JobUrlClassification {
  kind: AtsClassificationKind;
  canonicalUrl?: string;
  siteIdentifier?: string;
  postingIdentifier?: string;
  evidence: readonly string[];
}

const LEVER_HOSTS = new Set(["jobs.lever.co", "jobs.eu.lever.co"]);
const GREENHOUSE_HOSTS = new Set(["boards.greenhouse.io", "job-boards.greenhouse.io"]);
const RIPPLING_HOSTS = new Set(["ats.rippling.com"]);
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

/** Rippling (and some other hosts) may prefix paths with a locale like en-US or es-419. */
const LOCALE_PATH_PREFIX = /^[a-z]{2}(?:-[A-Za-z0-9]{2,8})?$/;

function stripLocalePrefix(segments: string[]): string[] {
  if (segments.length === 0) return segments;
  return LOCALE_PATH_PREFIX.test(segments[0]) ? segments.slice(1) : segments;
}

function isRipplingRoute(segments: readonly string[]): boolean {
  return (segments.length === 3 || (segments.length === 4 && segments[3].toLowerCase() === "apply")) &&
    segments[0].length > 0 &&
    segments[1].toLowerCase() === "jobs" &&
    segments[2].length > 0;
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

  // Prefer the unstripped route when it is already valid. This avoids treating
  // a legitimate two-letter organization slug such as /us/jobs/<id> as a locale.
  const ripplingSegments = isRipplingRoute(segments) ? segments : stripLocalePrefix(segments);
  if (RIPPLING_HOSTS.has(host) && isRipplingRoute(ripplingSegments)) {
    const localeStripped = ripplingSegments.length !== segments.length;
    return {
      kind: "rippling",
      canonicalUrl,
      siteIdentifier: ripplingSegments[0],
      postingIdentifier: ripplingSegments[2],
      evidence: [
        `hostname:${host}`,
        "path:<organization>/jobs/<posting-id>[/apply]",
        ...(localeStripped ? ["locale-prefix-stripped"] : []),
      ],
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

/** Rippling exposes the public posting and form as adjacent routes. */
export function ripplingApplicationUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const classification = classifyJobUrl(value);
  if (classification.kind !== "rippling" || !classification.canonicalUrl) return undefined;
  return classification.canonicalUrl.endsWith("/apply")
    ? classification.canonicalUrl
    : `${classification.canonicalUrl}/apply`;
}

export function isVerifiedRipplingHostedUrl(
  value: string | undefined,
  organization: string,
  postingId: string,
): boolean {
  if (!value || !organization.trim() || !postingId.trim()) return false;
  const classification = classifyJobUrl(value);
  if (classification.kind !== "rippling" ||
    classification.siteIdentifier?.toLowerCase() !== organization.trim().toLowerCase() ||
    classification.postingIdentifier !== postingId.trim()) return false;
  try {
    const url = new URL(classification.canonicalUrl ?? value);
    const segments = pathSegments(url);
    const normalizedSegments = segments && (isRipplingRoute(segments) ? segments : stripLocalePrefix(segments));
    return Boolean(normalizedSegments && normalizedSegments.length === 3 && isRipplingRoute(normalizedSegments));
  } catch {
    return false;
  }
}

export function isVerifiedRipplingApplicationUrl(
  value: string | undefined,
  organization?: string,
  postingId?: string,
): boolean {
  const classification = classifyJobUrl(value ?? "");
  if (classification.kind !== "rippling" || !ripplingApplicationUrl(value)) return false;
  return organization === undefined || postingId === undefined
    ? true
    : classification.siteIdentifier?.toLowerCase() === organization.trim().toLowerCase() &&
      classification.postingIdentifier === postingId.trim();
}

function isAshbyPath(value: string | undefined, suffix?: "application"): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    const classification = classifyJobUrl(url.toString());
    if (classification.kind !== "ashby") return false;
    const segments = pathSegments(url);
    return Boolean(segments && (suffix === undefined
      ? segments.length === 2
      : segments.length === 3 && segments[2]?.toLowerCase() === suffix));
  } catch {
    return false;
  }
}

export function isVerifiedAshbyHostedUrl(
  value: string | undefined,
  organization: string,
  postingId: string,
): boolean {
  if (!value || !organization.trim() || !postingId.trim()) return false;
  const classification = classifyJobUrl(value);
  return classification.kind === "ashby" &&
    classification.siteIdentifier?.toLowerCase() === organization.trim().toLowerCase() &&
    classification.postingIdentifier === postingId.trim() &&
    isAshbyPath(classification.canonicalUrl ?? value);
}

export function isVerifiedAshbyApplicationUrl(
  value: string | undefined,
  organization?: string,
  postingId?: string,
): boolean {
  const classification = classifyJobUrl(value ?? "");
  if (classification.kind !== "ashby" || !isAshbyPath(value, "application")) return false;
  return (organization === undefined || classification.siteIdentifier?.toLowerCase() === organization.trim().toLowerCase()) &&
    (postingId === undefined || classification.postingIdentifier === postingId.trim());
}

/**
 * Workday application flows keep the tenant hostname while adding one or more
 * interactive steps below the public job route. Accept only a job route that
 * reaches an explicit `/apply` segment; a tenant homepage or public posting
 * is not an application destination.
 */
export function isVerifiedWorkdayApplicationUrl(value: string | undefined, tenant?: string): boolean {
  const classification = classifyJobUrl(value ?? "");
  if (classification.kind !== "workday" || !classification.canonicalUrl) return false;
  if (tenant && classification.siteIdentifier?.toLowerCase() !== tenant.trim().toLowerCase()) return false;
  try {
    const url = new URL(classification.canonicalUrl);
    const segments = pathSegments(url)?.map((segment) => segment.toLowerCase());
    if (!segments) return false;
    const jobIndex = segments.indexOf("job");
    const applyIndex = segments.indexOf("apply");
    return jobIndex >= 0 && applyIndex > jobIndex;
  } catch {
    return false;
  }
}
