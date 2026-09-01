import type {
  CandidateProfile,
  EmploymentRecord,
  FitAssessment,
  JobPosting,
  ResumeFamily,
  TailoredResume,
  TailoredResumeSection,
} from "./types";
import { normalizeSkillForComparison } from "./fit";

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = normalizeSkillForComparison(value);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

function orderRelevant<T>(
  values: readonly T[],
  textFor: (value: T) => string,
  relevantSkills: ReadonlySet<string>,
): T[] {
  return [...values].sort((left, right) => {
    const leftRelevant = [...relevantSkills].some((skill) => textFor(left).toLowerCase().includes(skill));
    const rightRelevant = [...relevantSkills].some((skill) => textFor(right).toLowerCase().includes(skill));
    return Number(rightRelevant) - Number(leftRelevant);
  });
}

function familyFor(profile: CandidateProfile, familyId: FitAssessment["recommendedResumeFamily"]): ResumeFamily {
  const family = profile.resumeFamilies.find((candidate) => candidate.id === familyId);
  if (!family) {
    throw new Error(`Resume family ${familyId} is not defined by the candidate profile.`);
  }
  return family;
}

function familyEmployment(profile: CandidateProfile, family: ResumeFamily): EmploymentRecord[] {
  return family.experienceIds
    .map((id) => profile.employmentHistory.find((record) => record.id === id))
    .filter((record): record is EmploymentRecord => record !== undefined);
}

export function tailorResume(
  _job: JobPosting,
  profile: CandidateProfile,
  fit: FitAssessment,
  generatedAt: string,
): TailoredResume {
  const family = familyFor(profile, fit.recommendedResumeFamily);
  const employment = familyEmployment(profile, family);
  const projects = family.projectIds
    .map((id) => profile.projects.find((project) => project.id === id))
    .filter((project): project is CandidateProfile["projects"][number] => project !== undefined);
  const relevantSkills = new Set(
    [...fit.strongMatches, ...fit.partialMatches].map(normalizeSkillForComparison),
  );
  const verifiedSkills = unique([
    ...profile.skills,
    ...employment.flatMap((record) => record.verifiedSkills),
    ...projects.flatMap((project) => project.verifiedSkills),
  ]);
  const orderedSkills = orderRelevant(
    verifiedSkills,
    (skill) => normalizeSkillForComparison(skill),
    relevantSkills,
  );
  const orderedEmployment = orderRelevant(
    employment,
    (record) => `${record.title} ${record.employer} ${record.bullets.join(" ")}`.toLowerCase(),
    relevantSkills,
  );
  const orderedProjects = orderRelevant(
    projects,
    (project) => `${project.name} ${project.description} ${project.bullets.join(" ")}`.toLowerCase(),
    relevantSkills,
  );

  const sections: TailoredResumeSection[] = [
    {
      kind: "summary",
      title: "Summary",
      content: family.summary,
      provenance: [`resume-family:${family.id}`],
    },
    {
      kind: "skills",
      title: "Verified skills",
      content: orderedSkills,
      provenance: [
        "profile.skills",
        ...orderedEmployment.map((record) => `employment:${record.id}`),
        ...orderedProjects.map((project) => `project:${project.id}`),
      ],
    },
  ];

  for (const record of orderedEmployment) {
    sections.push({
      kind: "experience",
      title: `${record.title} · ${record.employer}`,
      content: record.bullets,
      provenance: [`employment:${record.id}`, record.provenance],
    });
  }

  for (const project of orderedProjects) {
    sections.push({
      kind: "projects",
      title: project.name,
      content: [project.description, ...project.bullets],
      provenance: [`project:${project.id}`, project.provenance],
    });
  }

  return {
    familyId: family.id,
    familyLabel: family.label,
    summary: family.summary,
    sections,
    generatedAt,
  };
}
