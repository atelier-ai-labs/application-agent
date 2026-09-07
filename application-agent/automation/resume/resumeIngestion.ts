import { createHash } from "node:crypto";
import type {
  CandidateProfile,
  CandidateProject,
  CertificationRecord,
  EducationRecord,
  EmploymentRecord,
  ResumeFamily,
  ResumeFamilyId,
} from "../../src/domain/types";
import { isCandidateProfile } from "../../src/domain/validation";
import {
  readResumeArtifact,
  type ResumeArtifactMetadata,
} from "./resumeArtifact";

export type ResumeIngestionFailureCode =
  | "artifact_invalid"
  | "profile_invalid"
  | "no_grounded_facts";

export class ResumeIngestionError extends Error {
  constructor(
    public readonly code: ResumeIngestionFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "ResumeIngestionError";
  }
}

export interface ResumeIngestionCounts {
  skills: number;
  employment: number;
  education: number;
  projects: number;
  certifications: number;
}

export interface ResumeIngestionResult {
  profile: CandidateProfile;
  familyId: ResumeFamilyId;
  artifact: Pick<ResumeArtifactMetadata, "extension" | "mimeType" | "byteLength" | "fingerprint">;
  counts: ResumeIngestionCounts;
  warnings: readonly string[];
}

interface ParsedResume {
  skills: string[];
  employment: EmploymentRecord[];
  education: EducationRecord[];
  projects: CandidateProject[];
  certifications: CertificationRecord[];
  linkedinUrl?: string;
  websiteUrl?: string;
  preferredWorkLocation?: string;
  availabilityStartDate?: string;
  warnings: string[];
}

type SectionName = "skills" | "experience" | "education" | "projects" | "certifications" | "other";

const SECTION_NAMES: Readonly<Record<string, SectionName>> = {
  skills: "skills",
  "technical skills": "skills",
  "core skills": "skills",
  "key skills": "skills",
  competencies: "skills",
  "core competencies": "skills",
  "technical competencies": "skills",
  "areas of expertise": "skills",
  "technical expertise": "skills",
  "professional skills": "skills",
  technologies: "skills",
  tools: "skills",
  experience: "experience",
  "work experience": "experience",
  "professional experience": "experience",
  "work history": "experience",
  "career history": "experience",
  employment: "experience",
  education: "education",
  "academic background": "education",
  projects: "projects",
  "selected projects": "projects",
  "selected work": "projects",
  certifications: "certifications",
  "professional certifications": "certifications",
  certificates: "certifications",
  summary: "other",
  "professional summary": "other",
  profile: "other",
  "professional profile": "other",
  objective: "other",
  highlights: "other",
  achievements: "other",
  leadership: "other",
  volunteering: "other",
  awards: "other",
};

const TITLE_SIGNALS: readonly string[] = [
  "engineer",
  "developer",
  "manager",
  "director",
  "scientist",
  "analyst",
  "architect",
  "consultant",
  "designer",
  "lead",
  "intern",
  "specialist",
  "administrator",
  "coordinator",
  "officer",
  "researcher",
  "professor",
  "teacher",
  "writer",
  "technician",
  "operator",
  "founder",
  "owner",
  "strategist",
];

const CLOUD_SIGNALS: readonly string[] = [
  "AWS",
  "Azure",
  "GCP",
  "Google Cloud",
  "Kubernetes",
  "Docker",
  "Terraform",
  "Pulumi",
  "Ansible",
  "Helm",
  "Jenkins",
  "CI/CD",
  "DevOps",
  "SRE",
  "infrastructure",
  "platform",
  "cloud",
  "observability",
];

const DEGREE_PATTERN = /\b(?:B\.?\s?(?:S\.?|A\.?|Sc(?:\.|ience)?|Eng(?:\.|ineering)?)|M\.?\s?(?:S\.?|A\.?|Sc(?:\.|ience)?|Eng(?:\.|ineering)?)|Ph\.?\s?D\.?|MBA|Bachelor(?:'s)?(?: of [A-Za-z ]+)?|Master(?:'s)?(?: of [A-Za-z ]+)?|Doctor(?:ate)?(?: of [A-Za-z ]+)?|Associate(?:'s)?|Diploma)\b/i;
const DATE_TOKEN = "(?:[A-Za-z]{3,9}\\s+)?\\d{4}(?:[/-]\\d{1,2})?";
const DATE_RANGE_PATTERN = new RegExp(`(${DATE_TOKEN})\\s*(?:-|–|—|to)\\s*(Present|Current|${DATE_TOKEN})`, "i");
const YEAR_PATTERN = new RegExp(`\\b${DATE_TOKEN}\\b`, "i");

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizedKey(value: string): string {
  return normalizeWhitespace(value).toLowerCase().replace(/[^a-z0-9+#/]+/g, " ").trim();
}

function safeText(value: string, maximum: number): string | undefined {
  const normalized = normalizeWhitespace(value).replace(/[\u0000-\u001F\u007F]/g, "");
  if (!normalized || normalized.length > maximum || /(?:https?:\/\/|www\.|@)/i.test(normalized)) return undefined;
  return normalized;
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const safe = safeText(value, 160);
    if (!safe) continue;
    const key = normalizedKey(safe);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(safe);
  }
  return result;
}

const LABELED_PROFILE_URL_PATTERN = /\b(LinkedIn(?:\s+URL)?|Website|Portfolio|Personal\s+site)\s*(?::|[-|]|\s)\s*((?:https?:\/\/|www\.)[^\s<>()]+|(?:linkedin\.com|[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:\/[^\s<>()]*)?)/i;
const LABELED_WORK_LOCATION_PATTERN = /\b(?:Preferred\s+work\s+location|Desired\s+work\s+location|Location\s+preference)\s*(?::|[-|])\s*(.+)$/i;
const LABELED_AVAILABILITY_PATTERN = /\b(?:Available\s+to\s+start|Availability\s+start\s+date|Earliest\s+start\s+date)\s*(?::|[-|])\s*(.+)$/i;

function normalizedLabeledUrl(value: string): string | undefined {
  const withoutPunctuation = value.replace(/[.,;:)]+$/g, "");
  if (/^(?:www\.|linkedin\.com|[a-z0-9-]+(?:\.[a-z0-9-]+)+)/i.test(withoutPunctuation)) return `https://${withoutPunctuation}`;
  return /^https?:\/\//i.test(withoutPunctuation) ? withoutPunctuation : undefined;
}

function labeledProfileUrls(text: string): { linkedinUrl?: string; websiteUrl?: string } {
  let linkedinUrl: string | undefined;
  let websiteUrl: string | undefined;
  for (const line of text.split("\n")) {
    const match = LABELED_PROFILE_URL_PATTERN.exec(line);
    if (!match) continue;
    const url = normalizedLabeledUrl(match[2] ?? "");
    if (!url) continue;
    const label = normalizedKey(match[1] ?? "");
    if (label.startsWith("linkedin")) linkedinUrl ??= url;
    else websiteUrl ??= url;
  }
  return {
    ...(linkedinUrl ? { linkedinUrl } : {}),
    ...(websiteUrl ? { websiteUrl } : {}),
  };
}

function labeledProfileFacts(text: string): {
  preferredWorkLocation?: string;
  availabilityStartDate?: string;
} {
  let preferredWorkLocation: string | undefined;
  let availabilityStartDate: string | undefined;
  for (const line of text.split("\n")) {
    const normalizedLine = normalizeWhitespace(line);
    if (!preferredWorkLocation) {
      const location = normalizedLine.match(LABELED_WORK_LOCATION_PATTERN);
      const value = safeText(location?.[1]?.replace(/[.,;]+$/g, "") ?? "", 160);
      if (value) preferredWorkLocation = value;
    }
    if (!availabilityStartDate) {
      const availability = normalizedLine.match(LABELED_AVAILABILITY_PATTERN);
      const value = safeText(availability?.[1]?.replace(/[.,;]+$/g, "") ?? "", 160);
      if (value) availabilityStartDate = value;
    }
  }
  return {
    ...(preferredWorkLocation ? { preferredWorkLocation } : {}),
    ...(availabilityStartDate ? { availabilityStartDate } : {}),
  };
}

function sectionHeading(line: string): SectionName | undefined {
  const key = normalizeWhitespace(line)
    .replace(/[|:]+$/g, "")
    .toLowerCase();
  return SECTION_NAMES[key];
}

function likelyUnmappedSectionHeading(line: string): boolean {
  const normalized = normalizeWhitespace(line);
  const letters = normalized.replace(/[^A-Za-z]/g, "");
  return Boolean(letters)
    && letters === letters.toUpperCase()
    && normalized.length <= 64
    && normalized.split(/\s+/).length <= 6
    && !DATE_RANGE_PATTERN.test(normalized)
    && !/^[•▪◦*-]\s+/.test(normalized);
}

function sectionLines(text: string): Map<SectionName, string[]> {
  const sections = new Map<SectionName, string[]>();
  let current: SectionName | undefined;
  for (const rawLine of text.split("\n")) {
    const line = normalizeWhitespace(rawLine);
    if (!line) continue;
    const heading = sectionHeading(line) ?? (likelyUnmappedSectionHeading(line) ? "other" : undefined);
    if (heading) {
      current = heading;
      if (!sections.has(heading)) sections.set(heading, []);
      continue;
    }
    if (current) sections.get(current)?.push(line);
  }
  return sections;
}

function withoutBullet(line: string): { bullet: boolean; value: string } {
  const match = line.match(/^\s*(?:[-*•▪◦]|\d+[.)])\s+(.*)$/);
  return match ? { bullet: true, value: normalizeWhitespace(match[1] ?? "") } : { bullet: false, value: line };
}

function structuralParts(value: string): string[] {
  return value
    .replace(DATE_RANGE_PATTERN, " ")
    .split(/\s*(?:\||[–—])\s*/)
    .map((part) => safeText(part, 240))
    .filter((part): part is string => Boolean(part));
}

const SKILL_CATEGORY_PREFIX = /^(?:skills?|technical(?:\s+(?:skills?|competencies|expertise|proficiencies))?|core\s+skills?|key\s+skills?|professional\s+skills?|competenc(?:y|ies)|areas\s+of\s+expertise|programming\s+languages?|languages?(?:\s*(?:and|&)\s*(?:frameworks?|libraries))?|frameworks?|libraries|databases?|cloud(?:\s+platforms?|\s*(?:[/&]|and)\s*platforms?)?(?:\s+(?:technologies|services|tools))?|platforms?(?:\s+(?:technologies|services|tools))?|tools?(?:\s*(?:and|&)\s*technologies?)?|technologies|security(?:\s*(?:and|&)\s*(?:compliance|tools?|technologies?))?|operating\s+systems?|methodologies|development\s+tools?)\s*:\s*/i;

function splitFactLine(line: string): string[] {
  const withoutPrefix = withoutBullet(line).value.replace(SKILL_CATEGORY_PREFIX, "");
  return withoutPrefix
    .split(/\s*(?:,|;|\||•)\s*|\s+\/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function extractSkills(text: string, sections: Map<SectionName, string[]>): string[] {
  const explicitLines = [...(sections.get("skills") ?? [])];
  for (const line of text.split("\n")) {
    if (SKILL_CATEGORY_PREFIX.test(line.trim())) {
      explicitLines.push(normalizeWhitespace(line));
    }
  }
  return unique(explicitLines.flatMap(splitFactLine).filter((value) => {
    if (value.length > 80 || value.split(" ").length > 8) return false;
    if (DATE_RANGE_PATTERN.test(value)) return false;
    if (/^[\d\W]+$/.test(value) || /[.!?]$/.test(value)) return false;
    return true;
  }));
}

function normalizeDate(value: string): string | null {
  const normalized = normalizeWhitespace(value);
  if (/^(present|current)$/i.test(normalized)) return null;
  const monthMatch = normalized.match(/^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4})$/i);
  if (monthMatch) {
    const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
      .indexOf((monthMatch[1] ?? "").slice(0, 3).toLowerCase()) + 1;
    return `${monthMatch[2]}-${String(month).padStart(2, "0")}`;
  }
  const yearMonth = normalized.match(/^(\d{4})[/-](\d{1,2})$/);
  if (yearMonth) return `${yearMonth[1]}-${String(Number(yearMonth[2])).padStart(2, "0")}`;
  const year = normalized.match(/^\d{4}$/);
  return year ? year[0] : null;
}

function stableId(prefix: string, values: readonly string[]): string {
  const digest = createHash("sha256").update(values.join("\u001F")).digest("hex").slice(0, 16);
  return `resume-${prefix}-${digest}`;
}

function containsExplicit(text: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\//g, "\\/");
  return new RegExp(`(?:^|[^a-z0-9+#])${escaped.replace(/\s+/g, "\\s+")}(?:$|[^a-z0-9+#])`, "i").test(text);
}

function verifiedSkills(text: string, skills: readonly string[]): string[] {
  return skills.filter((skill) => containsExplicit(text, skill));
}

function hasTitleSignal(value: string): boolean {
  return TITLE_SIGNALS.some((signal) => containsExplicit(value, signal));
}

function isLocationPart(value: string): boolean {
  return /^(?:location\s*:\s*|based\s+in\s+)/i.test(value)
    || /^(?:remote|hybrid|on[- ]site)$/i.test(value);
}

function explicitLocation(value: string): string | null {
  const labelled = value.match(/\b(?:location|based\s+in)\s*:\s*(.+)$/i);
  if (labelled) return safeText(labelled[1] ?? "", 160) ?? null;
  return null;
}

function plausibleEmploymentField(value: string, maximumLength: number, maximumWords: number): string | undefined {
  const safe = safeText(value, maximumLength);
  return safe && safe.split(/\s+/).length <= maximumWords ? safe : undefined;
}

interface EmploymentHeader {
  title: string;
  employer: string;
  location: string | null;
}

function employmentHeader(value: string): EmploymentHeader | undefined {
  const safe = safeText(value, 720);
  if (!safe) return undefined;
  const cleaned = safe.replace(DATE_RANGE_PATTERN, " ").replace(/\s{2,}/g, " ").trim();
  const labelledLocation = explicitLocation(cleaned);
  const withoutLabelledLocation = cleaned.replace(/\b(?:location|based\s+in)\s*:\s*.+$/i, " ").trim();
  const at = withoutLabelledLocation.match(/^(.+?)\s+at\s+(.+)$/i);
  if (at) {
    const title = plausibleEmploymentField(at[1] ?? "", 80, 8);
    const employer = plausibleEmploymentField(at[2] ?? "", 120, 10);
    if (title && employer) return { title, employer, location: labelledLocation };
  }

  const separated = structuralParts(withoutLabelledLocation);
  const commaSeparated = separated.length > 1
    ? separated
    : withoutLabelledLocation.split(/\s*,\s*/).map((part) => safeText(part, 240)).filter((part): part is string => Boolean(part));
  const parts = commaSeparated.filter((part) => !isLocationPart(part));
  const location = labelledLocation ?? commaSeparated.find(isLocationPart)?.replace(/^(?:location\s*:\s*|based\s+in\s+)/i, "") ?? null;
  if (parts.length < 2) return undefined;
  const titleIndexes = parts.map((part, index) => hasTitleSignal(part) ? index : -1).filter((index) => index >= 0);
  if (titleIndexes.length !== 1) return undefined;
  const titleIndex = titleIndexes[0] ?? -1;
  const title = plausibleEmploymentField(parts[titleIndex] ?? "", 80, 8);
  const employerCandidates = parts.filter((_part, index) => index !== titleIndex);
  const employer = employerCandidates.length === 1
    ? plausibleEmploymentField(employerCandidates[0] ?? "", 120, 10)
    : employerCandidates
      .map((part) => plausibleEmploymentField(part, 120, 10))
      .find((part): part is string => {
        if (!part) return false;
        return !hasTitleSignal(part);
      });
  if (!title || !employer || hasTitleSignal(employer)) return undefined;
  return { title, employer, location: safeText(location ?? "", 160) ?? null };
}

interface EmploymentParseResult {
  records: EmploymentRecord[];
  skipped: number;
}

function employmentFromSection(lines: readonly string[], skills: readonly string[], provenance: string): EmploymentParseResult {
  const dates = lines
    .map((line, index) => ({ line, index, match: DATE_RANGE_PATTERN.exec(line) }))
    .filter((entry): entry is { line: string; index: number; match: RegExpExecArray } => Boolean(entry.match));
  const records: EmploymentRecord[] = [];
  let skipped = 0;
  for (const [datePosition, date] of dates.entries()) {
    const before: string[] = [];
    for (let index = date.index - 1; index >= 0 && before.length < 3; index -= 1) {
      const parsed = withoutBullet(lines[index] ?? "");
      if (parsed.bullet || DATE_RANGE_PATTERN.test(lines[index] ?? "")) break;
      before.unshift(parsed.value);
    }
    const candidates = [
      date.line,
      before.slice(-2).join(" — "),
      before.join(" — "),
    ];
    const header = candidates.map(employmentHeader).find((candidate): candidate is EmploymentHeader => Boolean(candidate));
    if (!header) {
      if (safeText((date.line ?? "").replace(date.match[0], " "), 720)) skipped += 1;
      continue;
    }
    const endIndex = dates[datePosition + 1]?.index ?? lines.length;
    const bullets = lines
      .slice(date.index + 1, endIndex)
      .map(withoutBullet)
      .filter((entry) => entry.bullet && entry.value.length > 0)
      .map((entry) => safeText(entry.value, 320))
      .filter((value): value is string => Boolean(value));
    const startDate = normalizeDate(date.match[1] ?? "");
    if (!startDate) continue;
    const endDate = normalizeDate(date.match[2] ?? "");
    const body = `${header.title} ${header.employer} ${bullets.join(" ")}`;
    records.push({
      id: stableId("employment", [provenance, header.employer, header.title, startDate, endDate ?? "present"]),
      employer: header.employer,
      title: header.title,
      startDate,
      endDate,
      location: header.location,
      bullets,
      verifiedSkills: verifiedSkills(body, skills),
      provenance,
    });
  }
  return { records, skipped };
}

function degreeParts(line: string): { degree: string; field: string | null; institution: string } | undefined {
  const parts = structuralParts(line);
  const degreeIndex = parts.findIndex((part) => DEGREE_PATTERN.test(part));
  let degreePart = degreeIndex >= 0 ? parts[degreeIndex] : undefined;
  let institution = degreeIndex >= 0
    ? parts[degreeIndex - 1] ?? parts[degreeIndex + 1]
    : undefined;
  if (!degreePart || !institution) {
    const at = line.match(/^(.+?)\s+at\s+(.+)$/i);
    if (at && DEGREE_PATTERN.test(at[1] ?? "")) {
      degreePart = safeText(at[1] ?? "", 180);
      institution = safeText(at[2] ?? "", 180);
    }
  }
  if (!degreePart || !institution) return undefined;
  const degreeMatch = degreePart.match(DEGREE_PATTERN);
  if (!degreeMatch) return undefined;
  const rawDegree = degreeMatch[0];
  const compactDegree = rawDegree.replace(/\s+/g, "").toUpperCase();
  const degree = /^B\.?S\.?$/.test(compactDegree) ? "B.S."
    : /^B\.?A\.?$/.test(compactDegree) ? "B.A."
      : /^M\.?S\.?$/.test(compactDegree) ? "M.S."
        : /^M\.?A\.?$/.test(compactDegree) ? "M.A."
          : safeText(rawDegree, 100) ?? rawDegree;
  const field = safeText(degreePart.slice((degreeMatch.index ?? 0) + rawDegree.length).replace(/^\s*\.?\s*(?:in|,|[-:])?\s*/i, ""), 140) ?? null;
  return { degree, field, institution };
}

function educationFromSection(lines: readonly string[], provenance: string): EducationRecord[] {
  return lines.flatMap((line, index) => {
    const previous = lines[index - 1];
    const previousLine = previous && !DATE_RANGE_PATTERN.test(previous) && !withoutBullet(previous).bullet
      ? previous
      : undefined;
    const parsed = degreeParts(line) ?? (previousLine ? degreeParts(`${previousLine} — ${line}`) : undefined);
    if (!parsed) return [];
    return [{
      id: stableId("education", [provenance, parsed.institution, parsed.degree, parsed.field ?? ""]),
      institution: parsed.institution,
      degree: parsed.degree,
      field: parsed.field,
      completionDate: YEAR_PATTERN.exec(`${previousLine ?? ""} ${line}`)?.[0] ?? null,
      provenance,
    } satisfies EducationRecord];
  });
}

function projectsFromSection(lines: readonly string[], skills: readonly string[], provenance: string): CandidateProject[] {
  const projects: CandidateProject[] = [];
  let current: { name: string; inlineDescription?: string; bullets: string[] } | undefined;
  const flush = (): void => {
    if (!current) return;
    const description = current.inlineDescription ?? current.bullets[0];
    if (description) {
      const body = `${current.name} ${description} ${current.bullets.join(" ")}`;
      projects.push({
        id: stableId("project", [provenance, current.name, description]),
        name: current.name,
        description,
        bullets: current.bullets.length > 0 ? current.bullets : [description],
        verifiedSkills: verifiedSkills(body, skills),
        provenance,
      });
    }
    current = undefined;
  };
  for (const line of lines) {
    const parsed = withoutBullet(line);
    if (parsed.bullet) {
      if (current) {
        const bullet = safeText(parsed.value, 320);
        if (bullet) current.bullets.push(bullet);
      }
      continue;
    }
    flush();
    const parts = structuralParts(parsed.value);
    const name = parts[0];
    if (name) current = { name, ...(parts[1] ? { inlineDescription: parts.slice(1).join(" | ") } : {}), bullets: [] };
  }
  flush();
  return projects;
}

function certificationsFromSection(lines: readonly string[], provenance: string): CertificationRecord[] {
  return lines.flatMap((line) => {
    const parts = structuralParts(line);
    if (parts.length < 2) return [];
    return [{
      id: stableId("certification", [provenance, parts[0], parts[1]]),
      name: parts[0] ?? "",
      issuer: parts[1] ?? "",
      issuedDate: YEAR_PATTERN.exec(line)?.[0] ?? null,
      expiresDate: null,
      provenance,
    } satisfies CertificationRecord];
  });
}

function parseResume(text: string, fingerprint: string, familyId: ResumeFamilyId): ParsedResume {
  const sections = sectionLines(text);
  const provenance = `resume-import:${familyId}:${fingerprint}`;
  const listedSkills = extractSkills(text, sections);
  const employmentResult = employmentFromSection(sections.get("experience") ?? [], listedSkills, provenance);
  const projects = projectsFromSection(sections.get("projects") ?? [], listedSkills, provenance);
  const explicitBulletSkills = CLOUD_SIGNALS.filter((signal) => containsExplicit(
    [...employmentResult.records.flatMap((record) => record.bullets), ...projects.flatMap((record) => record.bullets)].join(" "),
    signal,
  ));
  const skills = unique([...listedSkills, ...explicitBulletSkills]);
  const employment = employmentResult.records.map((record) => ({
    ...record,
    verifiedSkills: verifiedSkills(`${record.title} ${record.employer} ${record.bullets.join(" ")}`, skills),
  }));
  const groundedProjects = projects.map((record) => ({
    ...record,
    verifiedSkills: verifiedSkills(`${record.name} ${record.description} ${record.bullets.join(" ")}`, skills),
  }));
  return {
    skills,
    employment,
    education: educationFromSection(sections.get("education") ?? [], provenance),
    projects: groundedProjects,
    certifications: certificationsFromSection(sections.get("certifications") ?? [], provenance),
    ...labeledProfileUrls(text),
    ...labeledProfileFacts(text),
    warnings: employmentResult.skipped > 0
      ? [`Skipped ${employmentResult.skipped} ambiguous employment block${employmentResult.skipped === 1 ? "" : "s"}.`]
      : [],
  };
}

function cloudSignals(text: string): string[] {
  return CLOUD_SIGNALS.filter((signal) => containsExplicit(text, signal));
}

const RESUME_FAMILY_LABELS: Readonly<Record<ResumeFamilyId, string>> = {
  "cloud-platform": "Cloud / Platform",
  "frontend-software": "Frontend / Software",
  "ai-platform-agentic": "AI Platform / Agentic",
};

interface ResumeFamilyAssignment {
  family: ResumeFamily;
  warnings: readonly string[];
}

function familyFor(
  familyId: ResumeFamilyId,
  parsed: ParsedResume,
): ResumeFamilyAssignment {
  const evidenceText = [
    ...parsed.skills,
    ...parsed.employment.flatMap((record) => [record.title, record.employer, ...record.bullets]),
    ...parsed.projects.flatMap((record) => [record.name, record.description, ...record.bullets]),
  ].join(" ");
  const signals = familyId === "cloud-platform" ? cloudSignals(evidenceText) : [];
  const experienceIds = parsed.employment
    .filter((record) => cloudSignals(`${record.title} ${record.employer} ${record.bullets.join(" ")}`).length > 0)
    .map((record) => record.id);
  const projectIds = parsed.projects
    .filter((record) => cloudSignals(`${record.name} ${record.description} ${record.bullets.join(" ")}`).length > 0)
    .map((record) => record.id);
  const skillSignals = parsed.skills.filter((skill) => signals.some((signal) => normalizedKey(skill) === normalizedKey(signal)));
  const focusKeywords = unique([...skillSignals, ...signals]);
  const evidence = focusKeywords.slice(0, 6).join(", ");
  const label = RESUME_FAMILY_LABELS[familyId];
  const hasFamilyEvidence = signals.length > 0;
  return {
    family: {
      id: familyId,
      label,
      summary: hasFamilyEvidence
        ? `Resume-grounded ${label.toLowerCase()} profile with explicit evidence: ${evidence}.`
        : `User-designated ${label} resume family.`,
      focusKeywords: hasFamilyEvidence ? focusKeywords : [],
      experienceIds: hasFamilyEvidence ? experienceIds : [],
      projectIds: hasFamilyEvidence ? projectIds : [],
    },
    warnings: familyId === "cloud-platform" && !hasFamilyEvidence
      ? ["Limited explicit cloud/platform terminology was detected; the artifact was imported because cloud-platform was explicitly selected."]
      : [],
  };
}

function mergeProfile(profile: CandidateProfile, parsed: ParsedResume, family: ResumeFamily): CandidateProfile {
  const provenancePrefix = `resume-import:${family.id}:`;
  const updated: CandidateProfile = {
    ...profile,
    identity: {
      ...profile.identity,
      ...(profile.identity.linkedinUrl == null && parsed.linkedinUrl ? { linkedinUrl: parsed.linkedinUrl } : {}),
      ...(profile.identity.websiteUrl == null && parsed.websiteUrl ? { websiteUrl: parsed.websiteUrl } : {}),
    },
    workPreferences: {
      ...profile.workPreferences,
      ...(profile.workPreferences.preferredWorkLocation == null && parsed.preferredWorkLocation
        ? { preferredWorkLocation: parsed.preferredWorkLocation }
        : {}),
      ...(profile.workPreferences.availabilityStartDate == null && parsed.availabilityStartDate
        ? { availabilityStartDate: parsed.availabilityStartDate }
        : {}),
    },
    skills: unique([...profile.skills, ...parsed.skills]),
    employmentHistory: [
      ...profile.employmentHistory.filter((record) => !record.provenance.startsWith(provenancePrefix)),
      ...parsed.employment,
    ],
    education: [
      ...profile.education.filter((record) => !record.provenance.startsWith(provenancePrefix)),
      ...parsed.education,
    ],
    projects: [
      ...profile.projects.filter((record) => !record.provenance.startsWith(provenancePrefix)),
      ...parsed.projects,
    ],
    certifications: [
      ...profile.certifications.filter((record) => !record.provenance.startsWith(provenancePrefix)),
      ...parsed.certifications,
    ],
    resumeFamilies: [
      ...profile.resumeFamilies.filter((candidate) => candidate.id !== family.id),
      family,
    ],
  };
  if (!isCandidateProfile(updated)) {
    throw new ResumeIngestionError("profile_invalid", "Resume ingestion did not produce a valid private profile.");
  }
  return updated;
}

export function ingestResumeIntoProfile(
  profile: CandidateProfile,
  input: { familyId: ResumeFamilyId; artifactPath: string },
): ResumeIngestionResult {
  if (!isCandidateProfile(profile)) {
    throw new ResumeIngestionError("profile_invalid", "The candidate profile does not match the supported profile schema.");
  }
  if (profile.profileKind !== "private") {
    throw new ResumeIngestionError("profile_invalid", "Resume ingestion requires a private candidate profile.");
  }
  let artifact: { path: string; metadata: ResumeArtifactMetadata; text: string };
  try {
    artifact = readResumeArtifact(input.artifactPath);
  } catch (error) {
    if (error instanceof ResumeIngestionError) throw error;
    const message = error instanceof Error ? error.message : "The resume artifact could not be read safely.";
    throw new ResumeIngestionError("artifact_invalid", message);
  }
  const parsed = parseResume(artifact.text, artifact.metadata.fingerprint, input.familyId);
  const groundedFactCount = parsed.skills.length
    + parsed.employment.length
    + parsed.education.length
    + parsed.projects.length
    + parsed.certifications.length
    + (parsed.linkedinUrl ? 1 : 0)
    + (parsed.websiteUrl ? 1 : 0)
    + (parsed.preferredWorkLocation ? 1 : 0)
    + (parsed.availabilityStartDate ? 1 : 0);
  if (groundedFactCount === 0) {
    throw new ResumeIngestionError("no_grounded_facts", "The resume did not contain usable grounded facts to import.");
  }
  const assignment = familyFor(input.familyId, parsed);
  const updatedProfile = mergeProfile(profile, parsed, assignment.family);
  return {
    profile: updatedProfile,
    familyId: input.familyId,
    artifact: artifact.metadata,
    counts: {
      skills: parsed.skills.length,
      employment: parsed.employment.length,
      education: parsed.education.length,
      projects: parsed.projects.length,
      certifications: parsed.certifications.length,
    },
    warnings: [
      ...assignment.warnings,
      ...parsed.warnings,
      ...(parsed.employment.length === 0 ? ["No unambiguous dated employment record was imported."] : []),
      ...(parsed.projects.length === 0 ? ["No explicitly structured project record was imported."] : []),
    ],
  };
}
