import type {
  CandidateProfile,
  FitAssessment,
  JobPosting,
  ResumeFamily,
  ResumeFamilyId,
} from "./types";

const SKILL_ALIASES: Readonly<Record<string, string>> = {
  "amazon web services": "aws",
  aws: "aws",
  "microsoft azure": "azure",
  azure: "azure",
  "google cloud": "gcp",
  gcp: "gcp",
  "react.js": "react",
  react: "react",
  "node.js": "node.js",
  nodejs: "node.js",
  postgres: "postgresql",
  postgresql: "postgresql",
  "continuous integration": "ci/cd",
  "github actions": "github actions",
  "api architecture": "api design",
};

const RELATED_SKILLS: Readonly<Record<string, readonly string[]>> = {
  aws: ["azure", "gcp", "cloud"],
  azure: ["aws", "gcp", "cloud"],
  gcp: ["aws", "azure", "cloud"],
  cloud: ["aws", "azure", "gcp"],
  typescript: ["javascript", "react"],
  javascript: ["typescript", "react"],
  react: ["typescript", "javascript", "frontend"],
  "api design": ["fastapi", "node.js"],
  fastapi: ["api design", "python"],
  kubernetes: ["docker", "terraform", "infrastructure"],
  terraform: ["kubernetes", "aws", "azure", "gcp"],
  llm: ["openai", "agentic systems"],
  "agentic systems": ["llm", "openai"],
};

function normalizedSkill(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return SKILL_ALIASES[normalized] ?? normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsKeyword(text: string, keyword: string): boolean {
  const expression = normalizedSkill(keyword)
    .split(" ")
    .map(escapeRegExp)
    .join("\\s+");
  return new RegExp(`(?:^|[^a-z0-9])${expression}(?:$|[^a-z0-9])`, "i").test(text);
}

function compoundSkillVariants(value: string): readonly string[] {
  const variants = new Set<string>();
  const add = (candidate: string): void => {
    const cleaned = candidate.trim().replace(/\s+/g, " ");
    if (cleaned) variants.add(cleaned);
  };
  const split = (candidate: string): void => {
    for (const part of candidate.split(/\s*(?:\/|,|\||;)\s*/)) add(part);
  };

  add(value);
  split(value);
  for (const match of value.matchAll(/\(([^()]*)\)/g)) {
    add(match[1]);
    split(match[1]);
  }
  const withoutParenthetical = value.replace(/\s*\([^()]*\)/g, " ");
  add(withoutParenthetical);
  split(withoutParenthetical);
  return [...variants];
}

function profileSkillKeys(profile: CandidateProfile): Set<string> {
  const keys = new Set<string>();
  const addSkill = (skill: string): void => {
    for (const variant of compoundSkillVariants(skill)) keys.add(normalizedSkill(variant));
  };
  for (const skill of profile.skills) addSkill(skill);
  for (const employment of profile.employmentHistory) {
    for (const skill of employment.verifiedSkills) addSkill(skill);
  }
  for (const project of profile.projects) {
    for (const skill of project.verifiedSkills) addSkill(skill);
  }
  return keys;
}

function isPartialMatch(jobSkill: string, candidateKeys: ReadonlySet<string>): boolean {
  const normalized = normalizedSkill(jobSkill);
  return (RELATED_SKILLS[normalized] ?? []).some((related) => candidateKeys.has(related));
}

function selectResumeFamily(job: JobPosting, profile: CandidateProfile): {
  family: ResumeFamily;
  reason: string;
} {
  if (profile.resumeFamilies.length === 0) {
    throw new Error("Candidate profile must define at least one resume family.");
  }

  const jobText = `${job.title} ${job.description} ${job.requiredSkills.join(" ")} ${job.preferredSkills.join(" ")}`.toLowerCase();
  const ranked = profile.resumeFamilies.map((family, index) => ({
    family,
    index,
    matches: family.focusKeywords.filter((keyword) => containsKeyword(jobText, keyword)),
  }));

  ranked.sort((a, b) => b.matches.length - a.matches.length || a.index - b.index);
  const selected = ranked[0];
  const signals = selected.matches.slice(0, 3);
  const reason = signals.length > 0
    ? `${selected.family.label} matches the posting's configured focus signals: ${signals.join(", ")}.`
    : `${selected.family.label} is the first configured family because the posting has no matching family focus signal.`;

  return { family: selected.family, reason };
}

export function assessFit(job: JobPosting, profile: CandidateProfile): FitAssessment {
  const candidateKeys = profileSkillKeys(profile);
  const strongMatches: string[] = [];
  const partialMatches: string[] = [];
  const unsupportedRequiredQualifications: string[] = [];
  const meaningfulGaps: string[] = [];
  let strongRequiredCount = 0;

  for (const skill of job.requiredSkills) {
    const normalized = normalizedSkill(skill);
    if (candidateKeys.has(normalized)) {
      strongMatches.push(skill);
      strongRequiredCount += 1;
    } else if (isPartialMatch(skill, candidateKeys)) {
      partialMatches.push(skill);
      unsupportedRequiredQualifications.push(skill);
      meaningfulGaps.push(`Required: ${skill}`);
    } else {
      unsupportedRequiredQualifications.push(skill);
      meaningfulGaps.push(`Required: ${skill}`);
    }
  }

  for (const skill of job.preferredSkills) {
    const normalized = normalizedSkill(skill);
    if (candidateKeys.has(normalized)) {
      strongMatches.push(skill);
    } else if (isPartialMatch(skill, candidateKeys)) {
      partialMatches.push(skill);
      meaningfulGaps.push(`Preferred: ${skill}`);
    } else {
      meaningfulGaps.push(`Preferred: ${skill}`);
    }
  }

  const requiredCount = job.requiredSkills.length;
  let classification: FitAssessment["classification"];
  if (requiredCount === 0) {
    classification = strongMatches.length > 0 ? "good" : "stretch";
  } else if (unsupportedRequiredQualifications.length === 0) {
    classification = strongRequiredCount === requiredCount ? "strong" : "good";
  } else if (strongRequiredCount > 0 || partialMatches.length > 0) {
    classification = "stretch";
  } else {
    classification = "weak";
  }

  const { family, reason } = selectResumeFamily(job, profile);
  const applicationRecommendation = classification === "strong" || classification === "good"
    ? "proceed"
    : classification === "stretch"
      ? "proceed_with_review"
      : "hold";

  return {
    classification,
    strongMatches,
    partialMatches,
    meaningfulGaps,
    unsupportedRequiredQualifications,
    recommendedResumeFamily: family.id as ResumeFamilyId,
    resumeFamilyReason: reason,
    applicationRecommendation,
    methodology:
      "Deterministic comparison of normalized required and preferred skill names against verified profile skills. Related skills are marked partial and do not erase required gaps; no numeric score is displayed.",
  };
}

export function normalizeSkillForComparison(value: string): string {
  return normalizedSkill(value);
}
