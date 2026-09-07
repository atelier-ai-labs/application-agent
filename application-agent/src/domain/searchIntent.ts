import type { SearchCriteria } from "./campaignTypes";

/**
 * The breadth of a campaign's discovery intent. It only changes which role
 * lanes are sent to providers; fit and pursuit policy remain independent.
 */
export type SearchBreadth = "targeted" | "balanced" | "broad";

export type SearchIntentLane = "primary" | "adjacent" | "secondary" | "broad";

export type SearchRemotePreference = "remote_only" | "remote_preferred" | "any";

/**
 * Provider-neutral user intent. Provider syntax, watchlists, and credentials
 * stay outside this object.
 */
export interface JobSearchIntent {
  primaryLanes: readonly string[];
  adjacentLanes: readonly string[];
  secondaryLanes: readonly string[];
  /** Optional bounded neighboring lanes used only at `broad` breadth. */
  broadLanes?: readonly string[];
  preferredSeniorities: readonly string[];
  excludedSeniorities: readonly string[];
  excludedTitleTerms: readonly string[];
  locations: readonly string[];
  remotePreference: SearchRemotePreference;
  employmentTypes?: readonly string[];
  minimumSalary?: number;
  breadth: SearchBreadth;
}

/** A provider-neutral planned search with lane provenance. */
export interface SearchIntentQuery {
  lane: SearchIntentLane;
  term: string;
}

export const MAX_SEARCH_INTENT_QUERIES = 24;
const MAX_LANES_PER_BUCKET = 12;
const MAX_LIST_VALUES = 12;
const MAX_TERM_LENGTH = 120;

function cleanTerm(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must contain only strings.`);
  const term = value.trim().replace(/\s+/g, " ");
  if (!term) throw new Error(`${label} must not contain empty terms.`);
  if (term.length > MAX_TERM_LENGTH) throw new Error(`${label} contains a term longer than ${MAX_TERM_LENGTH} characters.`);
  return term;
}

function cleanList(
  value: unknown,
  label: string,
  maximum: number = MAX_LIST_VALUES,
): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  if (value.length > maximum) throw new Error(`${label} exceeds the bounded limit of ${maximum} values.`);
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of value) {
    const term = cleanTerm(item, label);
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(term);
  }
  return output;
}

function cleanLaneList(value: unknown, label: string): readonly string[] {
  return cleanList(value, label, MAX_LANES_PER_BUCKET);
}

function optionalLaneList(value: unknown, label: string): readonly string[] {
  return value === undefined ? [] : cleanLaneList(value, label);
}

function optionalSalary(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Search intent minimum salary must be a non-negative finite number.");
  }
  return value;
}

/** Normalize one user-authored intent without adding facts or provider syntax. */
export function normalizeJobSearchIntent(value: unknown): JobSearchIntent {
  if (!value || typeof value !== "object") throw new Error("Search intent must be an object.");
  const candidate = value as Record<string, unknown>;
  if (candidate.breadth !== "targeted" && candidate.breadth !== "balanced" && candidate.breadth !== "broad") {
    throw new Error("Search intent breadth must be targeted, balanced, or broad.");
  }
  if (candidate.remotePreference !== "remote_only" && candidate.remotePreference !== "remote_preferred" && candidate.remotePreference !== "any") {
    throw new Error("Search intent remote preference is unsupported.");
  }

  const minimumSalary = optionalSalary(candidate.minimumSalary);
  const normalized: JobSearchIntent = {
    primaryLanes: cleanLaneList(candidate.primaryLanes, "Search intent primary lanes"),
    adjacentLanes: cleanLaneList(candidate.adjacentLanes, "Search intent adjacent lanes"),
    secondaryLanes: cleanLaneList(candidate.secondaryLanes, "Search intent secondary lanes"),
    broadLanes: optionalLaneList(candidate.broadLanes, "Search intent broad lanes"),
    preferredSeniorities: cleanList(candidate.preferredSeniorities, "Search intent preferred seniorities"),
    excludedSeniorities: cleanList(candidate.excludedSeniorities, "Search intent excluded seniorities"),
    excludedTitleTerms: cleanList(candidate.excludedTitleTerms, "Search intent excluded title terms"),
    locations: cleanList(candidate.locations, "Search intent locations"),
    remotePreference: candidate.remotePreference as SearchRemotePreference,
    employmentTypes: candidate.employmentTypes === undefined
      ? []
      : cleanList(candidate.employmentTypes, "Search intent employment types"),
    ...(minimumSalary !== undefined ? { minimumSalary } : {}),
    breadth: candidate.breadth as SearchBreadth,
  };

  if (planSearchIntentQueries(normalized).length === 0) {
    throw new Error("Search intent must define at least one role lane.");
  }
  return normalized;
}

/** Safe persisted-state guard. It deliberately enforces the same bounds as normalization. */
export function isJobSearchIntent(value: unknown): value is JobSearchIntent {
  try {
    normalizeJobSearchIntent(value);
    return true;
  } catch {
    return false;
  }
}

function configuredLanes(intent: JobSearchIntent): readonly SearchIntentQuery[] {
  const lanes: SearchIntentQuery[] = [];
  const add = (bucket: SearchIntentLane, values: readonly string[]): void => {
    for (const term of values) lanes.push({ lane: bucket, term });
  };

  add("primary", intent.primaryLanes);
  if (intent.breadth === "targeted") return lanes;
  add("adjacent", intent.adjacentLanes);
  add("secondary", intent.secondaryLanes);
  if (intent.breadth === "broad") add("broad", intent.broadLanes ?? []);
  return lanes;
}

/**
 * Return a deterministic, deduplicated, globally bounded query plan. The
 * ordering keeps primary lanes first, then adjacent/secondary/broad lanes.
 */
export function planSearchIntentQueries(
  intent: JobSearchIntent,
  maximum = MAX_SEARCH_INTENT_QUERIES,
): readonly SearchIntentQuery[] {
  if (!Number.isInteger(maximum) || maximum <= 0 || maximum > MAX_SEARCH_INTENT_QUERIES) {
    throw new Error(`Search intent query cap must be between 1 and ${MAX_SEARCH_INTENT_QUERIES}.`);
  }
  const seen = new Set<string>();
  const output: SearchIntentQuery[] = [];
  for (const query of configuredLanes(intent)) {
    const key = query.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(query);
    if (output.length >= maximum) break;
  }
  return output;
}

/** Materialize the legacy criteria view used by existing sources and filters. */
export function searchCriteriaFromJobSearchIntent(
  intent: JobSearchIntent,
  excludedCompanies: readonly string[] = [],
): SearchCriteria {
  const normalized = normalizeJobSearchIntent(intent);
  const queries = planSearchIntentQueries(normalized);
  return {
    roleLanes: queries.map((query) => query.term),
    searchQueries: queries.map((query) => query.term),
    locations: [...normalized.locations],
    remoteOnly: normalized.remotePreference === "remote_only",
    employmentTypes: [...(normalized.employmentTypes ?? [])],
    ...(normalized.minimumSalary !== undefined ? { minimumSalary: normalized.minimumSalary } : {}),
    excludedSeniorities: [...normalized.excludedSeniorities],
    excludedTitleTerms: [...normalized.excludedTitleTerms],
    excludedCompanies: [...excludedCompanies],
  };
}
