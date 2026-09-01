import type {
  AnswerPolicy,
  ApplicationAnswer,
  CandidateProfile,
  FitAssessment,
  HumanRequiredField,
  JobPosting,
  TailoredResume,
} from "./types";

export const DEFAULT_ANSWER_POLICIES: Readonly<Record<string, AnswerPolicy>> = {
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
};

export interface AnswerDraftContext {
  field: string;
  question: string;
  job: JobPosting;
  profile: CandidateProfile;
  fit: FitAssessment;
  resume: TailoredResume;
}

export type DraftAnswer = (context: AnswerDraftContext) => Promise<ApplicationAnswer>;

function policyFor(profile: CandidateProfile, field: string): AnswerPolicy {
  return profile.answerPolicies[field] ?? DEFAULT_ANSWER_POLICIES[field] ?? "ask";
}

function answerId(field: string): string {
  return `answer:${field}`;
}

function profileValue(profile: CandidateProfile, field: string): string | undefined {
  switch (field) {
    case "name":
      return profile.identity.fullName ?? undefined;
    case "email":
      return profile.identity.email ?? undefined;
    case "phone":
      return profile.identity.phone ?? undefined;
    case "location":
      return profile.identity.location ?? profile.location ?? undefined;
    case "employment_history":
      return profile.employmentHistory.length > 0
        ? profile.employmentHistory
            .map((record) => `${record.title} at ${record.employer} (${record.startDate}–${record.endDate ?? "present"})`)
            .join("; ")
        : undefined;
    case "verified_skills":
      return profile.skills.length > 0 ? profile.skills.join(", ") : undefined;
    default:
      return undefined;
  }
}

function resolvedOrMissingAnswer(
  field: string,
  question: string,
  policy: AnswerPolicy,
  value: string | undefined,
  provenance: readonly string[],
): ApplicationAnswer {
  return value
    ? {
        id: answerId(field),
        field,
        question,
        policy,
        value,
        status: "resolved",
        provenance,
      }
    : {
        id: answerId(field),
        field,
        question,
        policy,
        status: "needs_input",
        provenance,
      };
}

function unresolvedAnswer(
  field: string,
  question: string,
  policy: AnswerPolicy,
): ApplicationAnswer {
  return {
    id: answerId(field),
    field,
    question,
    policy,
    status: policy === "never_auto" ? "blocked" : "needs_input",
  };
}

function humanFieldFor(answer: ApplicationAnswer): HumanRequiredField {
  const neverAuto = answer.policy === "never_auto";
  return {
    id: `blocker:${answer.field}`,
    field: answer.field,
    label: answer.question ?? answer.field,
    reason: neverAuto
      ? "This field is intentionally outside automatic handling and must be completed manually."
      : "This field depends on a personal answer that is not present in the profile.",
    policy: answer.policy,
    answerId: answer.id,
    status: "open",
  };
}

export function buildDraftAnswer(context: AnswerDraftContext): ApplicationAnswer {
  const { field, question, job, fit, resume } = context;
  const focus = fit.strongMatches.length > 0
    ? fit.strongMatches.slice(0, 3).join(", ")
    : job.requiredSkills.slice(0, 3).join(", ") || "the role's stated priorities";
  const policy: AnswerPolicy = "draft_review";
  const provenance = [
    `job.company:${job.company}`,
    `job.title:${job.title}`,
    "job.requiredSkills",
    `fit.resume-family:${fit.recommendedResumeFamily}`,
  ];

  if (field === "why_company") {
    return {
      id: answerId(field),
      field,
      question,
      policy,
      value: `Draft for review: ${job.company}'s ${job.title} role focuses on ${focus}. Check this wording against your own reasons before using it.`,
      status: "drafted",
      provenance,
    };
  }

  return {
    id: answerId(field),
    field,
    question,
    policy,
    value: `Draft for review: ${resume.summary} The posting emphasizes ${focus}; keep only claims supported by the verified profile.`,
    status: "drafted",
    provenance: [...provenance, `resume.summary:${fit.recommendedResumeFamily}`],
  };
}

const FIELD_QUESTIONS: readonly { field: string; question: string }[] = [
  { field: "name", question: "Full name" },
  { field: "email", question: "Email address" },
  { field: "phone", question: "Phone number" },
  { field: "location", question: "Current location" },
  { field: "employment_history", question: "Employment history" },
  { field: "verified_skills", question: "Verified skills" },
  { field: "why_company", question: "Why this company?" },
  { field: "cover_letter", question: "Cover letter" },
  { field: "salary_expectations", question: "Expected compensation" },
  { field: "relocation", question: "Willingness to relocate" },
  { field: "travel", question: "Travel requirements" },
  { field: "sponsorship", question: "Work authorization / sponsorship" },
  { field: "demographic_disclosure", question: "Demographic disclosure" },
  { field: "legal_attestations", question: "Legal attestations" },
];

export async function prepareApplicationAnswers(
  job: JobPosting,
  profile: CandidateProfile,
  fit: FitAssessment,
  resume: TailoredResume,
  draftAnswer: DraftAnswer,
): Promise<readonly ApplicationAnswer[]> {
  const answers: ApplicationAnswer[] = [];

  for (const { field, question } of FIELD_QUESTIONS) {
    const policy = policyFor(profile, field);
    const approved = profile.approvedReusableAnswers[field];

    if (policy === "auto") {
      const value = profileValue(profile, field) ?? approved;
      answers.push(
        resolvedOrMissingAnswer(field, question, policy, value, [`profile:${field}`]),
      );
      continue;
    }

    if (policy === "draft_review" && (field === "why_company" || field === "cover_letter")) {
      if (approved) {
        answers.push({
          id: answerId(field),
          field,
          question,
          policy,
          value: approved,
          status: "drafted",
          provenance: [`profile.approved-answer:${field}`],
        });
      } else {
        answers.push(
          await draftAnswer({ field, question, job, profile, fit, resume }),
        );
      }
      continue;
    }

    answers.push(unresolvedAnswer(field, question, policy));
  }

  return answers;
}

export function blockersFromAnswers(
  answers: readonly ApplicationAnswer[],
): readonly HumanRequiredField[] {
  return answers
    .filter((answer) => answer.status === "needs_input" || answer.status === "blocked")
    .map(humanFieldFor);
}
