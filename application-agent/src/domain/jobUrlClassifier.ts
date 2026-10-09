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
const YOUHIRED_HOSTS = new Set(["youhired.me", "www.youhired.me"]);
const MATLEN_HOSTS = new Set(["matlensilver.com", "www.matlensilver.com"]);
const PROTAGONA_HOST = "protagona.applytojob.com";
const PROTAGONA_POSTING_ID = "YDO63zlPbH";
const PROTAGONA_POSTING_SLUG = "AWS-Cloud-Engineer";
const GUSTO_HOST = "jobs.gusto.com";
const GUSTO_POSTING_SLUG = "sidekick-solutions-llc-cloud-engineer";
const GUSTO_POSTING_ID = "ac0d6b2b-36c5-4bad-a8d2-91b69546d4ad";

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

/** Ashby organization slugs are host-owned identifiers, not case-sensitive names. */
function normalizedAshbyOrganization(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function sameAshbyOrganization(actual: string | undefined, expected: string): boolean {
  return normalizedAshbyOrganization(actual) === normalizedAshbyOrganization(expected);
}

function youHiredJobSegments(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const canonicalUrl = canonicalJobUrl(value);
  if (!canonicalUrl) return undefined;
  try {
    const url = new URL(canonicalUrl);
    if (!YOUHIRED_HOSTS.has(normalizedHost(url))) return undefined;
    const segments = pathSegments(url);
    if (!segments || segments.length !== 3 || segments[0].toLowerCase() !== "job" || !/^\d+$/.test(segments[1]) || !segments[2]) {
      return undefined;
    }
    return segments;
  } catch {
    return undefined;
  }
}

function matlenJobSegments(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const canonicalUrl = canonicalJobUrl(value);
  if (!canonicalUrl) return undefined;
  try {
    const url = new URL(canonicalUrl);
    if (!MATLEN_HOSTS.has(normalizedHost(url))) return undefined;
    const segments = pathSegments(url);
    if (!segments || segments.length !== 2 || segments[0].toLowerCase() !== "job") return undefined;
    const postingId = segments[1].match(/^(.*?)-(\d+)$/)?.[2];
    return postingId && postingId.length > 0 ? segments : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Protagona's current AWS Cloud Engineer posting exposes its public posting
 * and application form at one exact ApplyToJob route. ApplyToJob is shared by
 * many employers, so an arbitrary route on that host must not become trusted.
 */
function protagonaJobSegments(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const canonicalUrl = canonicalJobUrl(value);
  if (!canonicalUrl) return undefined;
  try {
    const url = new URL(canonicalUrl);
    if (normalizedHost(url) !== PROTAGONA_HOST) return undefined;
    const segments = pathSegments(url);
    if (!segments || segments.length !== 3 || segments[0].toLowerCase() !== "apply" ||
      segments[1] !== PROTAGONA_POSTING_ID || segments[2] !== PROTAGONA_POSTING_SLUG) {
      return undefined;
    }
    return segments;
  } catch {
    return undefined;
  }
}

/**
 * Sidekick's current Gusto posting exposes a public posting page and a
 * separate applicant form. Gusto hosts many unrelated postings, so this
 * first integration trusts only the exact tracker-selected public posting.
 */
function gustoJobSegments(value: string | undefined, application: boolean): string[] | undefined {
  if (!value) return undefined;
  const canonicalUrl = canonicalJobUrl(value);
  if (!canonicalUrl) return undefined;
  try {
    const url = new URL(canonicalUrl);
    if (normalizedHost(url) !== GUSTO_HOST) return undefined;
    const segments = pathSegments(url);
    const postingSegment = `${GUSTO_POSTING_SLUG}-${GUSTO_POSTING_ID}`;
    if (!segments || segments[0].toLowerCase() !== "postings" || segments[1] !== postingSegment) return undefined;
    if (application) {
      return segments.length === 4 && segments[2].toLowerCase() === "applicants" && segments[3].toLowerCase() === "new"
        ? segments
        : undefined;
    }
    return segments.length === 2 ? segments : undefined;
  } catch {
    return undefined;
  }
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

/**
 * YouHired exposes the public job page and its application form at the same
 * bounded route. Keep this host-specific check separate from the generic
 * `custom` classification so an arbitrary custom page cannot become trusted
 * browser input by accident.
 */
export function isVerifiedYouHiredApplicationUrl(value: string | undefined): boolean {
  return youHiredJobSegments(value) !== undefined;
}

export function youHiredPostingId(value: string | undefined): string | undefined {
  return youHiredJobSegments(value)?.[1];
}

/**
 * Matlen Silver exposes its public posting and multipart application form at
 * the same bounded `/job/<slug>-<numeric-id>` route. Keep this exact check
 * separate from generic `custom` classification so arbitrary employer pages
 * cannot become trusted browser destinations.
 */
export function isVerifiedMatlenApplicationUrl(value: string | undefined): boolean {
  return matlenJobSegments(value) !== undefined;
}

export function matlenPostingId(value: string | undefined): string | undefined {
  const slug = matlenJobSegments(value)?.[1];
  return slug?.match(/^(.*?)-(\d+)$/)?.[2];
}

/** The bounded Protagona route is both the curated source and application page. */
export function isVerifiedProtagonaApplicationUrl(value: string | undefined): boolean {
  return protagonaJobSegments(value) !== undefined;
}

export function protagonaPostingId(value: string | undefined): string | undefined {
  return protagonaJobSegments(value)?.[1];
}

export function isVerifiedGustoHostedUrl(value: string | undefined): boolean {
  return gustoJobSegments(value, false) !== undefined;
}

export function isVerifiedGustoApplicationUrl(value: string | undefined): boolean {
  return gustoJobSegments(value, true) !== undefined;
}

export function gustoPostingId(value: string | undefined): string | undefined {
  const segments = gustoJobSegments(value, true) ?? gustoJobSegments(value, false);
  return segments ? `${GUSTO_POSTING_SLUG}:${GUSTO_POSTING_ID}` : undefined;
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
    sameAshbyOrganization(classification.siteIdentifier, organization) &&
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
  return (organization === undefined || sameAshbyOrganization(classification.siteIdentifier, organization)) &&
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

/**
 * Return the stable Workday posting identity shared by the public posting and
 * its application flow. The identity includes the tenant and the complete
 * route through the job slug, while excluding interactive application steps.
 */
export function workdayPostingId(value: string | undefined): string | undefined {
  const classification = classifyJobUrl(value ?? "");
  if (classification.kind !== "workday" || !classification.canonicalUrl || !classification.siteIdentifier) return undefined;
  try {
    const segments = pathSegments(new URL(classification.canonicalUrl));
    if (!segments) return undefined;
    const jobIndex = segments.findIndex((segment) => segment.toLowerCase() === "job");
    if (jobIndex < 0 || jobIndex === segments.length - 1) return undefined;
    const applyIndex = segments.findIndex((segment, index) => index > jobIndex && segment.toLowerCase() === "apply");
    const postingSegments = segments.slice(0, applyIndex >= 0 ? applyIndex : segments.length);
    if (postingSegments.length <= jobIndex + 1) return undefined;
    return `${classification.siteIdentifier}:${postingSegments.join("/")}`;
  } catch {
    return undefined;
  }
}

/** A Workday public posting route, explicitly excluding application steps. */
export function isVerifiedWorkdayHostedUrl(value: string | undefined, tenant?: string): boolean {
  const classification = classifyJobUrl(value ?? "");
  if (classification.kind !== "workday" || !classification.canonicalUrl) return false;
  if (tenant && classification.siteIdentifier?.toLowerCase() !== tenant.trim().toLowerCase()) return false;
  try {
    const segments = pathSegments(new URL(classification.canonicalUrl));
    if (!segments) return false;
    const jobIndex = segments.findIndex((segment) => segment.toLowerCase() === "job");
    return jobIndex >= 0 && segments.length > jobIndex + 1 &&
      !segments.slice(jobIndex + 1).some((segment) => segment.toLowerCase().startsWith("apply"));
  } catch {
    return false;
  }
}
