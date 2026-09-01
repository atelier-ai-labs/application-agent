import type { CandidateProfile } from "./types";
import { isCandidateProfile } from "./validation";
import { browserStorage, type KeyValueStorage } from "../persistence/storage";

export const PROFILE_STORAGE_KEY = "atelier.application-agent.profile.v0";

export const exampleCandidateProfile: CandidateProfile = {
  schemaVersion: "0.1",
  id: "example-candidate-profile",
  profileKind: "example",
  identity: {
    fullName: "Example Candidate",
    email: "candidate@example.invalid",
    phone: "+1 555 0100",
    location: "Example City, US",
  },
  location: "Example City, US",
  employmentHistory: [
    {
      id: "example-employment-atelier",
      employer: "Example Labs",
      title: "Platform Engineer",
      startDate: "2022-01",
      endDate: "2025-06",
      location: "Example City, US",
      bullets: [
        "Built documented deployment workflows for internal services.",
        "Improved service observability with runbooks and operational checks.",
      ],
      verifiedSkills: ["AWS", "Kubernetes", "Python", "Terraform", "Docker"],
      provenance: "example-profile",
    },
  ],
  education: [
    {
      id: "example-education-1",
      institution: "Example University",
      degree: "B.S.",
      field: "Computer Science",
      completionDate: "2021",
      provenance: "example-profile",
    },
  ],
  skills: [
    "AWS",
    "Kubernetes",
    "Python",
    "Terraform",
    "Docker",
    "React",
    "TypeScript",
    "FastAPI",
    "PostgreSQL",
  ],
  projects: [
    {
      id: "example-project-atelier-hq",
      name: "Example Operations Platform",
      description: "A read-only internal operations surface for research systems.",
      bullets: [
        "Designed a typed boundary between project APIs and a shared operations interface.",
        "Added resilient loading, stale-data, and provenance states.",
      ],
      verifiedSkills: ["React", "TypeScript", "API design", "PostgreSQL"],
      provenance: "example-profile",
    },
  ],
  certifications: [],
  workPreferences: {
    remote: "Open to remote roles",
    relocation: null,
    travel: null,
  },
  workAuthorization: {
    status: null,
    countries: [],
    sponsorshipRequired: null,
  },
  resumeFamilies: [
    {
      id: "cloud-platform",
      label: "Cloud / Platform",
      summary: "Platform engineer focused on reliable cloud systems and developer workflows.",
      focusKeywords: ["cloud", "platform", "infrastructure", "devops", "kubernetes", "aws"],
      experienceIds: ["example-employment-atelier"],
      projectIds: ["example-project-atelier-hq"],
    },
    {
      id: "frontend-software",
      label: "Frontend / Software",
      summary: "Software engineer focused on clear interfaces and dependable product systems.",
      focusKeywords: ["frontend", "react", "typescript", "javascript", "web", "software"],
      experienceIds: ["example-employment-atelier"],
      projectIds: ["example-project-atelier-hq"],
    },
    {
      id: "ai-platform-agentic",
      label: "AI Platform / Agentic",
      summary: "Engineer focused on grounded AI workflows, typed systems, and operational reliability.",
      focusKeywords: ["ai", "agent", "agentic", "llm", "model", "automation", "grounded"],
      experienceIds: ["example-employment-atelier"],
      projectIds: ["example-project-atelier-hq"],
    },
  ],
  answerPolicies: {
    name: "auto",
    email: "auto",
    phone: "auto",
    location: "auto",
    employment_history: "auto",
    verified_skills: "auto",
    why_company: "draft_review",
    cover_letter: "draft_review",
    salary_expectations: "ask",
    relocation: "ask",
    travel: "ask",
    sponsorship: "ask",
    demographic_disclosure: "never_auto",
    legal_attestations: "never_auto",
  },
  approvedReusableAnswers: {},
};

export function parseCandidateProfile(value: unknown): CandidateProfile {
  if (!isCandidateProfile(value)) {
    throw new Error("Profile JSON does not match the Application Agent profile schema.");
  }

  return value;
}

export function loadCandidateProfile(
  storage: KeyValueStorage | null = browserStorage(),
): CandidateProfile {
  if (!storage) {
    return exampleCandidateProfile;
  }

  try {
    const raw = storage.getItem(PROFILE_STORAGE_KEY);
    if (!raw) {
      return exampleCandidateProfile;
    }

    return parseCandidateProfile(JSON.parse(raw));
  } catch {
    return exampleCandidateProfile;
  }
}

export function saveCandidateProfile(
  profile: CandidateProfile,
  storage: KeyValueStorage | null = browserStorage(),
): void {
  if (!storage) {
    return;
  }

  storage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
}

export function clearCandidateProfile(
  storage: KeyValueStorage | null = browserStorage(),
): void {
  storage?.removeItem(PROFILE_STORAGE_KEY);
}
