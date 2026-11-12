import type { JobSearchIntent } from "./searchIntent";
import type { JobPosting } from "./types";
import { requiredYearsOfExperience } from "./experienceYears";
import { companyKey } from "./companyLimit";

/**
 * Decides whether a discovered posting belongs in the user's tracker, using
 * only their search intent: role lanes, excluded seniorities and title terms,
 * employment type, and locations. Every decision carries a short reason so a
 * dry run can explain what was dropped.
 */
export type DiscoveryScreen = { keep: true } | { keep: false; reason: "seniority" | "employment" | "role" | "location" | "experience" | "company" };

const ROLE_WORD = /\b(?:engineer|engineering|developer|programmer|sre|devops|architect|scientist)\b/;
const GENERIC_LANE_WORDS = new Set([
  "engineer", "engineers", "engineering", "developer", "developers", "role", "roles", "production", "systems", "and", "or", "the", "of", "with",
]);
const NOT_FULL_TIME = /\b(?:contract(?:or|s)?|contract[- ]to[- ]hire|1099|temporary|temp[- ]to[- ]hire|part[- ]time|freelance|hourly|seasonal)\b/;
const COUNTRY_ALIASES: Record<string, readonly string[]> = {
  "united states": ["united states", "usa", "us", "u.s.", "u.s.a."],
  canada: ["canada", "ontario", "british columbia", "quebec", "alberta", "manitoba", "nova scotia", "toronto", "vancouver", "montreal", "ottawa", "calgary"],
};
const US_STATES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho",
  "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota",
  "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico", "new york", "north carolina",
  "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee", "texas",
  "utah", "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming", "district of columbia",
];
/** Uppercase only: "Portland, OR" is Oregon, "BC, or NS Only" (Instacart, Canada-only) is not. */
const US_STATE_CODES = /,\s*(?:A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b/;
const US_CITIES = [
  "san francisco", "bay area", "new york city", "nyc", "seattle", "austin", "boston", "chicago", "los angeles", "denver", "atlanta",
  "miami", "dallas", "houston", "philadelphia", "pittsburgh", "portland", "san diego", "san jose", "washington dc", "arlington", "raleigh",
  "nashville", "detroit", "minneapolis", "salt lake city", "phoenix", "columbus", "baltimore", "charlotte",
];
/** Words that describe a remote arrangement rather than a place. */
const REMOTE_WORDS = /\b(?:remote|fully|flexible|anywhere|worldwide|distributed|global|work from home|wfh|hybrid|on site|onsite|in office|or|and|first)\b/g;

function words(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9+#./]+/g, " ").replace(/\s+/g, " ").trim();
}

function hasPhrase(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`).test(text);
}

/** Significant words of each lane alternative ("React / TypeScript" is two alternatives). */
export function laneKeywordSets(intent: JobSearchIntent): string[][] {
  const lanes = [...intent.primaryLanes, ...intent.adjacentLanes, ...intent.secondaryLanes, ...(intent.breadth === "broad" ? intent.broadLanes ?? [] : [])];
  const sets: string[][] = [];
  for (const lane of lanes) {
    for (const alternative of lane.split("/")) {
      const tokens = words(alternative).split(" ").map((token) => token.replace(/-/g, " ")).flatMap((token) => token.split(" "))
        .filter((token) => token.length > 1 && !GENERIC_LANE_WORDS.has(token));
      if (tokens.length > 0) sets.push([...new Set(tokens)]);
    }
  }
  return sets;
}

function roleMatches(title: string, intent: JobSearchIntent): boolean {
  const text = words(title);
  const isRole = ROLE_WORD.test(text) || /\b(?:full[- ]?stack|front[- ]?end|back[- ]?end)\b/.test(text);
  if (!isRole) return false;
  return laneKeywordSets(intent).some((set) => set.every((token) => hasPhrase(text, token) || hasPhrase(text.replace(/[- ]/g, ""), token.replace(/[- ]/g, ""))));
}

function allowedPlaces(intent: Pick<JobSearchIntent, "locations">): { countries: string[]; cities: string[] } {
  const countries: string[] = [];
  const cities: string[] = [];
  for (const location of intent.locations) {
    const normalized = words(location);
    const country = Object.entries(COUNTRY_ALIASES).find(([, aliases]) => aliases.includes(normalized))?.[0];
    if (country) countries.push(country);
    else cities.push(normalized.split(/[,]/)[0]!.trim().replace(/\s+[a-z]{2}$/, ""));
  }
  return { countries: countries.length > 0 ? countries : ["united states"], cities };
}

/**
 * Remote jobs must be open to an allowed country ("Remote, US", "US/Canada",
 * plain "Remote"); a named city in the intent is allowed on-site or hybrid.
 * A posting that names only other countries or provinces is dropped unless
 * the user listed that country in `locations`.
 */
export function locationAllowed(job: Pick<JobPosting, "location" | "remoteStatus">, intent: Pick<JobSearchIntent, "locations" | "remotePreference">): boolean {
  const location = words(job.location ?? "");
  const { countries, cities } = allowedPlaces(intent);
  if (cities.some((city) => city && hasPhrase(location, city))) return true;
  if (intent.remotePreference === "any" && !location) return true;
  const remote = job.remoteStatus === "remote" || /\b(?:remote|anywhere|worldwide|distributed)\b/.test(location);
  if (!remote) return false;
  const namesAllowed = countries.some((country) => COUNTRY_ALIASES[country]!.some((alias) => hasPhrase(location, words(alias))));
  if (namesAllowed) return true;
  // Allow-list, not a block-list: a remote posting must name a place in an
  // allowed country or name no place at all ("Remote", "Flexible / Remote").
  const namesUsPlace = US_STATES.some((state) => hasPhrase(location, state)) || US_CITIES.some((city) => hasPhrase(location, city)) ||
    US_STATE_CODES.test(job.location ?? "");
  if (countries.includes("united states") && namesUsPlace) return true;
  return location.replace(REMOTE_WORDS, " ").replace(/[^a-z]+/g, "").length === 0;
}

export function screenDiscoveredJob(job: Pick<JobPosting, "title" | "location" | "remoteStatus" | "description" | "employmentType"> & { company?: string }, intent: JobSearchIntent): DiscoveryScreen {
  const company = companyKey(job.company);
  if (company && (intent.excludedCompanies ?? []).some((name) => company === companyKey(name) ||
    (companyKey(name).length >= 4 && company.startsWith(`${companyKey(name)} `)))) return { keep: false, reason: "company" };
  const title = words(job.title);
  const excluded = [...intent.excludedTitleTerms, ...intent.excludedSeniorities, "sr", "staff", "intern", "internship", "head of", "manager"].map(words);
  if (excluded.some((term) => term && hasPhrase(title, term))) {
    return { keep: false, reason: NOT_FULL_TIME.test(title) ? "employment" : "seniority" };
  }
  const wantsFullTime = (intent.employmentTypes ?? []).some((type) => /full/.test(type.toLowerCase()));
  if (wantsFullTime && NOT_FULL_TIME.test(`${title} ${words(job.employmentType ?? "")} ${words((job.description ?? "").slice(0, 4_000))}`)) {
    return { keep: false, reason: "employment" };
  }
  if (intent.maxYearsExperience !== undefined) {
    const required = requiredYearsOfExperience(job.description);
    if (required !== undefined && required > intent.maxYearsExperience) return { keep: false, reason: "experience" };
  }
  if (!roleMatches(job.title, intent)) return { keep: false, reason: "role" };
  if (!locationAllowed(job, intent)) return { keep: false, reason: "location" };
  return { keep: true };
}
