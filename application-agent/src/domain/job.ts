import type { JobIntakeInput, JobPosting } from "./types";
import { isJobPosting } from "./validation";

export class JobIntakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobIntakeError";
  }
}

interface SkillDefinition {
  name: string;
  pattern: RegExp;
}

const SKILL_DEFINITIONS: readonly SkillDefinition[] = [
  { name: "AWS", pattern: /\b(?:aws|amazon web services)\b/i },
  { name: "Azure", pattern: /\b(?:azure|microsoft azure)\b/i },
  { name: "GCP", pattern: /\b(?:gcp|google cloud)\b/i },
  { name: "Kubernetes", pattern: /\bkubernetes\b/i },
  { name: "Terraform", pattern: /\bterraform\b/i },
  { name: "Docker", pattern: /\bdocker\b/i },
  { name: "Python", pattern: /\bpython\b/i },
  { name: "React", pattern: /\breact(?:\.js)?\b/i },
  { name: "TypeScript", pattern: /\btypescript\b/i },
  { name: "JavaScript", pattern: /\bjavascript\b/i },
  { name: "Node.js", pattern: /\bnode(?:\.js|js)\b/i },
  { name: "FastAPI", pattern: /\bfastapi\b/i },
  { name: "PostgreSQL", pattern: /\bpostgres(?:ql)?\b/i },
  { name: "SQL", pattern: /\bsql\b/i },
  { name: "C++", pattern: /\bc\+\+(?![a-z0-9_])/i },
  { name: "Rust", pattern: /\brust\b/i },
  { name: "GitHub Actions", pattern: /\bgithub actions\b/i },
  { name: "CI/CD", pattern: /\bci\/?cd\b|\bcontinuous integration\b/i },
  { name: "OpenAI", pattern: /\bopenai\b/i },
  { name: "LLM", pattern: /\b(?:llm|large language model)s?\b/i },
  { name: "Agentic systems", pattern: /\bagentic\b|\bai agents?\b/i },
  { name: "API design", pattern: /\bapi design\b|\bapi architecture\b/i },
  { name: "Observability", pattern: /\bobservability\b|\btelemetry\b/i },
];

type SkillMode = "required" | "preferred" | "other";

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function labelValue(lines: readonly string[], label: string): string | undefined {
  const pattern = new RegExp(`^${label}\\s*:\\s*(.+)$`, "i");
  const line = lines.find((candidate) => pattern.test(candidate));
  return line ? clean(line.replace(pattern, "$1")) : undefined;
}

function validOptionalUrl(value: string | undefined, field: string): string | undefined {
  const trimmed = clean(value);
  if (!trimmed) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new JobIntakeError(`${field} must be an http or https URL.`);
  }

  return trimmed;
}

function inferTitle(lines: readonly string[]): string | undefined {
  const titlePattern = /\b(?:engineer|developer|designer|manager|analyst|scientist|architect|researcher|director|lead|specialist|coordinator|consultant)\b/i;
  return lines.find((line) => titlePattern.test(line) && !/^location\s*:/i.test(line));
}

function inferCompany(lines: readonly string[], title: string): string | undefined {
  const titleIndex = lines.indexOf(title);
  const candidates = lines.filter(
    (line, index) =>
      index !== titleIndex &&
      !/^\w[\w\s-]*\s*:/i.test(line) &&
      !/^(?:about|overview|requirements|qualifications|responsibilities|preferred|benefits)\b/i.test(line),
  );

  return candidates[0];
}

function parseMoney(value: string): number | undefined {
  const normalized = value.replace(/[$,\s]/g, "").toLowerCase();
  if (!normalized) {
    return undefined;
  }

  const multiplier = normalized.endsWith("k") ? 1_000 : 1;
  const numeric = Number(normalized.replace(/k$/, ""));
  return Number.isFinite(numeric) ? numeric * multiplier : undefined;
}

function extractCompensation(text: string): JobPosting["compensation"] {
  const compensationText = text.split(/\r?\n/).find((line) => /^compensation\s*:/i.test(line)) ?? text;
  const currencySymbol = compensationText.match(/[€£$]/)?.[0];
  const currencyCode = compensationText.match(/\b[A-Z]{3}\b/)?.[0];
  const currency = currencyCode ?? (currencySymbol === "€" ? "EUR" : currencySymbol === "£" ? "GBP" : currencySymbol === "$" ? "USD" : undefined);
  const period = compensationText.match(/\b(hourly|hour|weekly|week|fortnightly|fortnight|monthly|month|annual|yearly|year|yr)\b/i)?.[1]?.toLowerCase();
  const normalizedPeriod = period === "hour" ? "hourly"
    : period === "week" ? "weekly"
      : period === "fortnight" ? "fortnightly"
        : period === "month" ? "monthly"
          : period === "yearly" || period === "year" || period === "yr" ? "annual"
            : period;
  const withMetadata = (minimum: number, maximum?: number): JobPosting["compensation"] => ({
    minimum,
    ...(maximum !== undefined ? { maximum } : {}),
    ...(currency ? { currency } : {}),
    ...(normalizedPeriod ? { period: normalizedPeriod } : {}),
  });

  const range = text.match(/\$\s?[\d,]+(?:\.\d+)?k?\s*(?:-|–|—|to)\s*\$?\s?[\d,]+(?:\.\d+)?k?/i);
  if (range) {
    const values = range[0].split(/-|–|—|to/i).map(parseMoney).filter((value): value is number => value !== undefined);
    if (values.length === 2) {
      return withMetadata(values[0], values[1]);
    }
  }

  const codeRange = compensationText.match(/\b[A-Z]{3}\s*[\d,]+(?:\.\d+)?k?\s*(?:-|–|—|to)\s*(?:[A-Z]{3}\s*)?[\d,]+(?:\.\d+)?k?/);
  if (codeRange) {
    const values = codeRange[0].match(/[\d,]+(?:\.\d+)?k?/gi)?.map(parseMoney).filter((value): value is number => value !== undefined) ?? [];
    if (values.length === 2) return withMetadata(values[0], values[1]);
  }

  const numericRange = compensationText.match(/[\d,]+(?:\.\d+)?k?\s*(?:-|–|—|to)\s*[\d,]+(?:\.\d+)?k?/i);
  if (numericRange) {
    const values = numericRange[0].split(/-|–|—|to/i).map(parseMoney).filter((value): value is number => value !== undefined);
    if (values.length === 2) return withMetadata(values[0], values[1]);
  }

  const single = compensationText.match(/(?:\$|€|£)\s?[\d,]+(?:\.\d+)?k?/i);
  const value = single ? parseMoney(single[0]) : undefined;
  return value === undefined ? undefined : withMetadata(value);
}

function extractSkills(lines: readonly string[]): {
  requiredSkills: readonly string[];
  preferredSkills: readonly string[];
} {
  let mode: SkillMode = "other";
  let sawExplicitSection = false;
  const required: string[] = [];
  const preferred: string[] = [];
  const unclassified: string[] = [];

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (/\b(?:preferred|nice to have|bonus|desired)\b/.test(lower)) {
      mode = "preferred";
      sawExplicitSection = true;
    } else if (/\b(?:required|requirements|qualifications|must have|you will need)\b/.test(lower)) {
      mode = "required";
      sawExplicitSection = true;
    }

    for (const definition of SKILL_DEFINITIONS) {
      if (!definition.pattern.test(line)) {
        continue;
      }

      const target = mode === "preferred" ? preferred : mode === "required" ? required : unclassified;
      if (!target.includes(definition.name)) {
        target.push(definition.name);
      }
    }
  }

  if (!sawExplicitSection) {
    return { requiredSkills: [...unclassified], preferredSkills: [] };
  }

  for (const skill of unclassified) {
    if (!required.includes(skill) && !preferred.includes(skill)) {
      required.push(skill);
    }
  }

  return { requiredSkills: required, preferredSkills: preferred };
}

function inferAts(sourceUrl: string | undefined, applicationUrl: string | undefined, text: string): string | undefined {
  const haystack = `${sourceUrl ?? ""} ${applicationUrl ?? ""} ${text}`.toLowerCase();
  if (haystack.includes("greenhouse")) return "Greenhouse";
  if (haystack.includes("rippling.com")) return "Rippling";
  if (haystack.includes("lever.co")) return "Lever";
  if (haystack.includes("ashby")) return "Ashby";
  if (haystack.includes("workday")) return "Workday";
  return undefined;
}

function inferRemoteStatus(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (lower.includes("hybrid")) return "hybrid";
  if (lower.includes("remote")) return "remote";
  if (lower.includes("on-site") || lower.includes("onsite")) return "on-site";
  return undefined;
}

function inferEmploymentType(text: string): string | undefined {
  const match = text.match(/\b(full[- ]time|part[- ]time|contract|internship|temporary)\b/i);
  return match?.[1]?.replace(/-/g, " ").toLowerCase();
}

function inferSeniority(text: string, lines: readonly string[] = []): string | undefined {
  const labeled = labelValue(lines, "seniority");
  if (labeled) return labeled;
  const match = text.match(/\b(entry[- ]level|junior|mid[- ]level|senior|staff|principal|lead|director|manager)\b/i);
  return match?.[1]?.replace(/-/g, " ").toLowerCase();
}

export function normalizeJobPosting(
  input: JobIntakeInput,
  capturedAt = new Date().toISOString(),
): JobPosting {
  const rawText = input.rawText.trim();
  if (rawText.length < 20) {
    throw new JobIntakeError("Paste the job posting text before preparing an application.");
  }

  const lines = rawText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const labeledTitle = labelValue(lines, "title");
  const labeledCompany = labelValue(lines, "company");
  const title = clean(input.titleHint) ?? labeledTitle ?? inferTitle(lines);
  const company = clean(input.companyHint) ?? labeledCompany ?? (title ? inferCompany(lines, title) : undefined);

  if (!title) {
    throw new JobIntakeError("Could not identify a job title. Add a title hint or include the title in the posting.");
  }

  if (!company) {
    throw new JobIntakeError("Could not identify a company. Add a company hint or include the company in the posting.");
  }

  const sourceUrl = validOptionalUrl(input.sourceUrl, "Source URL");
  const applicationUrl = validOptionalUrl(input.applicationUrl, "Application URL");
  const location = labelValue(lines, "location");
  const remoteStatus = inferRemoteStatus(rawText);
  const skills = extractSkills(lines);
  const posting: JobPosting = {
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(applicationUrl ? { applicationUrl } : {}),
    company,
    title,
    ...(location ? { location } : {}),
    ...(remoteStatus ? { remoteStatus } : {}),
    ...(inferEmploymentType(rawText) ? { employmentType: inferEmploymentType(rawText) } : {}),
    ...(extractCompensation(rawText) ? { compensation: extractCompensation(rawText) } : {}),
    description: rawText,
    requiredSkills: skills.requiredSkills,
    preferredSkills: skills.preferredSkills,
    // Seniority is a title signal. Looking through the full description would
    // misclassify ordinary prose such as "lead projects" as a Lead role.
    ...(inferSeniority(title, lines) ? { seniority: inferSeniority(title, lines) } : {}),
    ...(inferAts(sourceUrl, applicationUrl, rawText) ? { ats: inferAts(sourceUrl, applicationUrl, rawText) } : {}),
    capturedAt,
  };

  if (!isJobPosting(posting)) {
    throw new JobIntakeError("The job posting could not be normalized into the expected schema.");
  }

  return posting;
}

/**
 * Boundary for future URL or ATS-specific intake. V0 deliberately implements
 * only pasted-content intake; URLs are retained as provenance fields.
 */
export interface JobPostingIngestor {
  ingest(input: JobIntakeInput, capturedAt?: string): Promise<JobPosting>;
}

export const pastedJobPostingIngestor: JobPostingIngestor = {
  ingest: async (input, capturedAt) => normalizeJobPosting(input, capturedAt),
};
