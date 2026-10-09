import {
  type DestinationResolution,
  type DestinationResolutionProvenance,
  type JobSourceObservation,
} from "./campaignTypes";
import { classifyJobUrl, type JobUrlClassification } from "./jobUrlClassifier";
import { canonicalJobUrl } from "./scout";

export type DestinationCandidateSource =
  | "existing_external"
  | "official_employer"
  | "recognized_ats"
  | "bounded_public_lookup";

/** Evidence returned by a bounded public lookup. It contains no page body. */
export interface DestinationCandidate {
  url: string;
  /** Final URL after any already-inspected redirect chain, when different. */
  finalUrl?: string;
  company: string;
  role: string;
  source: DestinationCandidateSource;
  pageKind: "application";
  employerVerified: boolean;
  roleVerified: boolean;
  current: boolean;
  officialDomain?: string;
  evidence: readonly string[];
}

/** Narrow admission predicate for an explicitly supplied official-employer application. */
export function isVerifiedOfficialEmployerCandidate(
  candidate: DestinationCandidate | undefined,
  input: { company: string; role: string; applicationUrl: string; knownListingUrl?: string },
): boolean {
  if (!candidate || candidate.source !== "official_employer" || candidate.pageKind !== "application" ||
    !candidate.employerVerified || !candidate.roleVerified || !candidate.current) return false;
  const candidateUrl = canonicalJobUrl(candidate.finalUrl ?? candidate.url);
  const applicationUrl = canonicalJobUrl(input.applicationUrl);
  if (!candidateUrl || !applicationUrl || candidateUrl !== applicationUrl || !isExternal(candidateUrl, input.knownListingUrl)) return false;
  if (!sameCompany(candidate.company, input.company) || !sameRole(candidate.role, input.role)) return false;
  const officialDomain = candidate.officialDomain?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!officialDomain || hostname(candidateUrl) !== officialDomain) return false;
  return classifyJobUrl(candidateUrl).kind === "custom";
}

export interface ApplicationDestinationResolutionInput {
  company: string;
  role: string;
  knownListingUrl?: string;
  existingApplicationUrl?: string;
  existingApplicationActionable?: boolean;
  sourceObservations: readonly JobSourceObservation[];
  /** Optional candidates from an explicitly bounded public/company lookup. */
  knownCandidates?: readonly DestinationCandidate[];
}

export interface ApplicationDestinationLookup {
  lookup(input: ApplicationDestinationResolutionInput): Promise<readonly DestinationCandidate[]>;
}

export interface ApplicationDestinationResolver {
  resolve(input: ApplicationDestinationResolutionInput): Promise<DestinationResolution>;
}

export interface DestinationResolutionRunResult {
  inspected: number;
  resolved: number;
  unresolved: number;
  ambiguous: number;
  skipped: number;
  jobs: readonly {
    jobId: string;
    company: string;
    role: string;
    resolution: DestinationResolution;
  }[];
}

export interface ApplicationDestinationResolverOptions {
  lookup?: ApplicationDestinationLookup;
  maxCandidates?: number;
}

const DEFAULT_MAX_CANDIDATES = 8;
const MAX_EVIDENCE_ITEMS = 12;
const MAX_EVIDENCE_LENGTH = 160;

function clean(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function normalizedLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(remote|hybrid|onsite|on-site)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sameCompany(left: string, right: string): boolean {
  return normalizedLabel(left) === normalizedLabel(right);
}

function sameRole(left: string, right: string): boolean {
  return normalizedLabel(left) === normalizedLabel(right);
}

function hostname(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return undefined;
  }
}

function safeEvidence(values: readonly string[]): readonly string[] {
  return [...new Set(values
    .filter((value) => typeof value === "string")
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((value) => value.slice(0, MAX_EVIDENCE_LENGTH)))].slice(0, MAX_EVIDENCE_ITEMS);
}

function provenanceFor(source: DestinationCandidateSource): DestinationResolutionProvenance {
  if (source === "existing_external") return "existing_external_application_url";
  if (source === "official_employer") return "official_employer_evidence";
  if (source === "recognized_ats") return "recognized_ats_evidence";
  return "bounded_public_lookup";
}

function atsFor(classification: JobUrlClassification): DestinationResolution["ats"] {
  switch (classification.kind) {
    case "lever": return "Lever";
    case "greenhouse": return "Greenhouse";
    case "rippling": return "Rippling";
    case "ashby": return "Ashby";
    case "workday": return "Workday";
    case "custom": return "Custom";
    default: return undefined;
  }
}

function isExternal(candidateUrl: string, listingUrl: string | undefined): boolean {
  const candidateHost = hostname(candidateUrl);
  const listingHost = hostname(listingUrl);
  return Boolean(candidateHost && (!listingHost || candidateHost !== listingHost));
}

function candidateKey(candidate: DestinationCandidate): string | undefined {
  return canonicalJobUrl(candidate.finalUrl ?? candidate.url);
}

function directCandidate(
  input: ApplicationDestinationResolutionInput,
  url: string,
): DestinationCandidate | undefined {
  const canonical = canonicalJobUrl(url);
  if (!canonical || !input.existingApplicationActionable || !isExternal(canonical, input.knownListingUrl)) return undefined;
  return {
    url: canonical,
    company: input.company,
    role: input.role,
    source: "existing_external",
    pageKind: "application",
    employerVerified: true,
    roleVerified: true,
    current: true,
    evidence: ["existing application URL was already source-verified", "external host differs from provider listing"],
  };
}

function validateCandidate(
  candidate: DestinationCandidate,
  input: ApplicationDestinationResolutionInput,
): { candidate?: DestinationCandidate; reason?: string } {
  const original = canonicalJobUrl(candidate.url);
  const finalUrl = canonicalJobUrl(candidate.finalUrl ?? candidate.url);
  if (!original || !finalUrl) return { reason: "candidate URL is not a valid HTTP(S) URL" };
  if (!isExternal(finalUrl, input.knownListingUrl)) return { reason: "candidate remains on the provider host" };
  if (candidate.pageKind !== "application") return { reason: "candidate is not an application page" };
  if (!candidate.current) return { reason: "candidate posting is not current or open" };
  if (!candidate.employerVerified || !sameCompany(candidate.company, input.company)) {
    return { reason: "candidate employer does not match the pursued job" };
  }
  if (!candidate.roleVerified || !sameRole(candidate.role, input.role)) {
    return { reason: "candidate role does not match the pursued job" };
  }

  const classification = classifyJobUrl(finalUrl);
  if (classification.kind === "unknown") return { reason: "candidate URL failed trust classification" };
  if ((candidate.source === "recognized_ats" || candidate.source === "existing_external") && !["lever", "greenhouse", "rippling", "ashby", "workday"].includes(classification.kind)) {
    return { reason: "candidate source claims a recognized ATS but URL is not a recognized ATS destination" };
  }
  if (candidate.source === "official_employer") {
    const officialDomain = candidate.officialDomain?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
    if (!officialDomain || hostname(finalUrl) !== officialDomain || classification.kind !== "custom") {
      return { reason: "official employer evidence does not match the final application host" };
    }
  }
  if (candidate.source === "bounded_public_lookup" && classification.kind === "custom") {
    const officialDomain = candidate.officialDomain?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
    if (!officialDomain || hostname(finalUrl) !== officialDomain) {
      return { reason: "public lookup custom destination lacks matching official-domain evidence" };
    }
  }

  return {
    candidate: {
      ...candidate,
      url: original,
      ...(finalUrl !== original ? { finalUrl } : {}),
      evidence: safeEvidence([
        ...candidate.evidence,
        `classification:${classification.kind}`,
        ...(finalUrl !== original ? ["redirect:verified"] : []),
      ]),
    },
  };
}

function resolutionFromCandidate(candidate: DestinationCandidate): DestinationResolution {
  const destinationUrl = canonicalJobUrl(candidate.finalUrl ?? candidate.url)!;
  const classification = classifyJobUrl(destinationUrl);
  return {
    status: "resolved",
    attemptedAt: new Date().toISOString(),
    destinationUrl,
    ...(atsFor(classification) ? { ats: atsFor(classification) } : {}),
    actionable: true,
    provenance: provenanceFor(candidate.source),
    evidence: safeEvidence(candidate.evidence),
  };
}

/**
 * One bounded destination-enrichment attempt. Lookup is intentionally an
 * injected port so the runtime can use an explicitly configured public source
 * without adding a crawler or paid search dependency.
 */
export class BoundedApplicationDestinationResolver implements ApplicationDestinationResolver {
  private readonly lookup?: ApplicationDestinationLookup;
  private readonly maxCandidates: number;

  constructor(options: ApplicationDestinationResolverOptions = {}) {
    this.lookup = options.lookup;
    this.maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
    if (!Number.isInteger(this.maxCandidates) || this.maxCandidates <= 0 || this.maxCandidates > DEFAULT_MAX_CANDIDATES) {
      throw new Error(`Destination candidate cap must be between 1 and ${DEFAULT_MAX_CANDIDATES}.`);
    }
  }

  async resolve(input: ApplicationDestinationResolutionInput): Promise<DestinationResolution> {
    const attemptedAt = new Date().toISOString();
    const existing = directCandidate(input, input.existingApplicationUrl ?? "");
    const known = [...(input.knownCandidates ?? [])];
    let lookedUp: readonly DestinationCandidate[] = [];
    let lookupFailure = false;
    if (!existing && this.lookup) {
      try {
        lookedUp = await this.lookup.lookup(input);
      } catch {
        lookupFailure = true;
      }
    }

    const candidates = [
      ...(existing ? [existing] : []),
      ...known,
      ...lookedUp,
    ].slice(0, this.maxCandidates);
    const evaluations = candidates.map((candidate) => validateCandidate(candidate, input));
    const valid = evaluations
      .map((evaluation) => evaluation.candidate)
      .filter((candidate): candidate is DestinationCandidate => Boolean(candidate));
    const rejected = evaluations
      .flatMap((evaluation) => evaluation.reason ? [`candidate-rejected:${evaluation.reason}`] : []);
    const unique = [...new Map(valid.map((candidate) => [candidateKey(candidate), candidate])).values()];
    if (unique.length === 1) {
      return { ...resolutionFromCandidate(unique[0]), attemptedAt };
    }
    if (unique.length > 1) {
      return {
        status: "ambiguous",
        attemptedAt,
        evidence: safeEvidence([
          "destination lookup was bounded",
          `candidate-count:${candidates.length}`,
          "multiple verified-looking destinations remained",
          ...unique.map((candidate) => `candidate-host:${hostname(candidate.finalUrl ?? candidate.url) ?? "unknown"}`),
        ]),
        reason: "More than one official-looking application destination matched; no destination was selected.",
      };
    }
    return {
      status: "unresolved",
      attemptedAt,
      evidence: safeEvidence([
        "destination lookup was bounded",
        `candidate-count:${candidates.length}`,
        ...rejected,
        ...(lookupFailure ? ["lookup:failed"] : []),
      ]),
      reason: lookupFailure
        ? "The bounded public destination lookup failed; the pursued job remains available for retry."
        : "No trustworthy official application destination was verified.",
    };
  }
}

/** Deterministic lookup used by the server's explicit public-evidence file and tests. */
export class StaticDestinationEvidenceLookup implements ApplicationDestinationLookup {
  public calls = 0;

  constructor(private readonly candidates: readonly DestinationCandidate[]) {}

  async lookup(): Promise<readonly DestinationCandidate[]> {
    this.calls += 1;
    return [...this.candidates];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Parse only the small explicit evidence list accepted by the background runtime. */
export function parseDestinationCandidates(value: unknown): readonly DestinationCandidate[] {
  const raw = Array.isArray(value) ? value : isRecord(value) ? value.candidates : undefined;
  if (!Array.isArray(raw) || raw.length > DEFAULT_MAX_CANDIDATES) {
    throw new Error(`Destination evidence must contain between 0 and ${DEFAULT_MAX_CANDIDATES} candidates.`);
  }
  return raw.map((item, index) => {
    if (!isRecord(item)) throw new Error(`Destination evidence candidate ${index + 1} is malformed.`);
    const url = stringValue(item.url);
    const finalUrl = stringValue(item.finalUrl);
    const company = stringValue(item.company);
    const role = stringValue(item.role);
    const source = item.source;
    const pageKind = item.pageKind;
    const officialDomain = stringValue(item.officialDomain);
    const evidence = item.evidence;
    if (!url || (finalUrl !== undefined && !finalUrl) || !company || !role ||
      (source !== "official_employer" && source !== "recognized_ats" && source !== "bounded_public_lookup") ||
      pageKind !== "application" || typeof item.employerVerified !== "boolean" ||
      typeof item.roleVerified !== "boolean" || typeof item.current !== "boolean" ||
      !Array.isArray(evidence) || !evidence.every((entry) => typeof entry === "string" && entry.trim())) {
      throw new Error(`Destination evidence candidate ${index + 1} is incomplete.`);
    }
    return {
      url,
      ...(finalUrl ? { finalUrl } : {}),
      company,
      role,
      source,
      pageKind,
      employerVerified: item.employerVerified,
      roleVerified: item.roleVerified,
      current: item.current,
      ...(officialDomain ? { officialDomain } : {}),
      evidence: evidence.map((entry) => entry.trim()),
    };
  });
}
