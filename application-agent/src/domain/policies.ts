import type { Application } from "./types";
import type {
  ApplicationPolicy,
  CareerBlockerDraft,
  Campaign,
  FitPolicy,
  PursuitDecision,
  SearchCriteria,
  SubmissionPolicy,
} from "./campaignTypes";
import type { FitAssessment, JobPosting } from "./types";

export interface HardFilterResult {
  decision: "pass" | "review" | "reject";
  reason: string;
  evidence: readonly string[];
}

export interface PursuitResult {
  decision: PursuitDecision;
  reason: string;
}

export interface SubmissionGateResult {
  allowed: boolean;
  reason: string;
  blockers: readonly CareerBlockerDraft[];
}

export function careerBlockerKey(
  value: Pick<CareerBlockerDraft, "kind" | "unit" | "field" | "question">,
): string {
  return `${value.unit}|${value.kind}|${value.field ?? value.question}`;
}

function normalized(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function matchesPhrase(value: string | undefined, phrase: string): boolean {
  const haystack = normalized(value);
  const needle = normalized(phrase);
  if (!haystack || !needle) return false;
  return haystack.includes(needle);
}

function matchingAny(value: string | undefined, choices: readonly string[]): boolean {
  return choices.some((choice) => matchesPhrase(value, choice));
}

export function applyHardFilters(job: JobPosting, criteria: SearchCriteria): HardFilterResult {
  const company = normalized(job.company);
  const excludedCompany = criteria.excludedCompanies.find((candidate) => company === normalized(candidate));
  if (excludedCompany) {
    return {
      decision: "reject",
      reason: `Company is excluded by campaign policy: ${excludedCompany}.`,
      evidence: [`company:${job.company}`, `excluded-company:${excludedCompany}`],
    };
  }

  const seniority = normalized(job.seniority);
  const excludedSeniority = criteria.excludedSeniorities.find((candidate) => seniority === normalized(candidate));
  if (excludedSeniority) {
    return {
      decision: "reject",
      reason: `Seniority is excluded by campaign policy: ${excludedSeniority}.`,
      evidence: [`seniority:${job.seniority}`, `excluded-seniority:${excludedSeniority}`],
    };
  }

  if (criteria.roleLanes.length > 0 && !matchingAny(job.title, criteria.roleLanes)) {
    return {
      decision: "reject",
      reason: "Role title does not match any configured campaign role lane.",
      evidence: [`title:${job.title}`, `role-lanes:${criteria.roleLanes.join(", ")}`],
    };
  }

  if (criteria.remoteOnly) {
    if (!job.remoteStatus) {
      return {
        decision: "review",
        reason: "Remote-only campaign requires confirmation because the posting does not state a remote status.",
        evidence: ["remote-status:missing"],
      };
    }
    if (normalized(job.remoteStatus) !== "remote") {
      return {
        decision: "reject",
        reason: `Posting is ${job.remoteStatus}, not remote-only under campaign policy.`,
        evidence: [`remote-status:${job.remoteStatus}`],
      };
    }
  }

  if (criteria.locations.length > 0) {
    if (!job.location) {
      return {
        decision: "review",
        reason: "Campaign location preference cannot be checked because the posting has no location.",
        evidence: ["location:missing"],
      };
    }
    if (!matchingAny(job.location, criteria.locations)) {
      return {
        decision: "reject",
        reason: "Posting location does not match the campaign location preference.",
        evidence: [`location:${job.location}`, `locations:${criteria.locations.join(", ")}`],
      };
    }
  }

  if (criteria.employmentTypes.length > 0) {
    if (!job.employmentType) {
      return {
        decision: "review",
        reason: "Employment type is not stated and cannot be safely inferred for this campaign.",
        evidence: ["employment-type:missing"],
      };
    }
    if (!matchingAny(job.employmentType, criteria.employmentTypes)) {
      return {
        decision: "reject",
        reason: "Employment type does not match the campaign preference.",
        evidence: [`employment-type:${job.employmentType}`, `employment-types:${criteria.employmentTypes.join(", ")}`],
      };
    }
  }

  if (criteria.minimumSalary !== undefined) {
    const maximum = job.compensation?.maximum;
    if (maximum === undefined) {
      return {
        decision: "review",
        reason: "Campaign salary floor cannot be checked because the posting does not expose a maximum salary.",
        evidence: [`minimum-salary:${criteria.minimumSalary}`, "salary-maximum:missing"],
      };
    }
    if (maximum < criteria.minimumSalary) {
      return {
        decision: "reject",
        reason: "Published compensation is below the campaign salary floor.",
        evidence: [`salary-maximum:${maximum}`, `minimum-salary:${criteria.minimumSalary}`],
      };
    }
  }

  return { decision: "pass", reason: "Posting passed deterministic campaign hard filters.", evidence: [] };
}

export function decidePursuit(
  fit: FitAssessment,
  policy: FitPolicy,
): PursuitResult {
  const decision = policy[fit.classification];
  const labels: Record<PursuitDecision, string> = {
    pursue: "pursued",
    hold: "held",
    reject: "rejected",
  };
  return {
    decision,
    reason: `${fit.classification} fit is ${labels[decision]} by the configured fit policy.`,
  };
}

function blocker(
  kind: CareerBlockerDraft["kind"],
  question: string,
  reason: string,
  evidence: readonly string[],
  field?: string,
): CareerBlockerDraft {
  return {
    kind,
    unit: "submission",
    ...(field ? { field } : {}),
    question,
    reason,
    evidence,
  };
}

export function careerBlockerDraftsForApplication(application: Application): CareerBlockerDraft[] {
  return application.blockers
    .filter((candidate) => candidate.status === "open")
    .map((candidate) => {
      const kind = candidate.field.includes("salary")
        ? "salary"
        : candidate.field.includes("sponsorship")
          ? "sponsorship"
          : candidate.field.includes("relocation")
            ? "relocation"
            : candidate.field.includes("travel")
              ? "travel"
              : candidate.field.includes("demographic")
                ? "demographic_disclosure"
                : candidate.field.includes("legal")
                  ? "legal_attestation"
                  : "other";
      return {
        kind,
        unit: "application_preparation",
        field: candidate.field,
        question: candidate.label,
        reason: candidate.reason,
        evidence: [],
      } satisfies CareerBlockerDraft;
    });
}

function hasUnusualTerms(job: JobPosting): boolean {
  return /non[- ]compete|mandatory arbitration|unlimited liability|waive.{0,20}claim|repayment obligation/i.test(job.description);
}

export function verifyPreparedApplication(
  application: Application,
  policy: ApplicationPolicy,
  submissionPolicy: SubmissionPolicy,
  campaign: Campaign,
  resolvedBlockerKeys: ReadonlySet<string> = new Set(),
  /** A preparation-only browser may prepare a form under `never` authority; it cannot produce proof. */
  allowPreparationOnly = false,
): SubmissionGateResult {
  const blockers: CareerBlockerDraft[] = [];
  const pushIfOpen = (draft: CareerBlockerDraft): void => {
    if (!resolvedBlockerKeys.has(careerBlockerKey(draft))) blockers.push(draft);
  };
  const fit = application.fit;

  if (application.status !== "ready_for_review") {
    blockers.push(blocker(
      "unknown_fact",
      "Application preparation status",
      "The preparation core has not reached a reviewable state.",
      [`application-status:${application.status}`],
    ));
  }

  if (!fit || !application.resume) {
    blockers.push(blocker(
      "unknown_fact",
      "Grounded application packet",
      "Fit and resume outputs are required before any execution decision.",
      [fit ? "fit:present" : "fit:missing", application.resume ? "resume:present" : "resume:missing"],
    ));
  }

  if (fit?.unsupportedRequiredQualifications.length) {
    blockers.push(blocker(
      "unknown_fact",
      "Unsupported required qualifications",
      "The posting contains required qualifications not supported by the verified profile.",
      fit.unsupportedRequiredQualifications,
    ));
  }

  blockers.push(...careerBlockerDraftsForApplication(application));

  const draftedAnswers = application.answers.filter((answer) => answer.status === "drafted");
  if (draftedAnswers.length > 0 && !policy.allowGroundedDrafts) {
    pushIfOpen(blocker(
      "subjective_answer",
      "Review drafted application answers",
      "The campaign does not authorize automatic use of draft-review answers.",
      draftedAnswers.map((answer) => `field:${answer.field}`),
      "drafted_answers",
    ));
  } else if (draftedAnswers.some((answer) => !answer.provenance || answer.provenance.length === 0)) {
    blockers.push(blocker(
      "unknown_fact",
      "Draft answer provenance",
      "A drafted answer is missing provenance and cannot be treated as grounded.",
      draftedAnswers.filter((answer) => !answer.provenance || answer.provenance.length === 0).map((answer) => `field:${answer.field}`),
    ));
  }

  if (application.resume && application.fit && policy.approvedResumeFamilies.length > 0 && !policy.approvedResumeFamilies.includes(application.resume.familyId)) {
    pushIfOpen(blocker(
      "submission_approval",
      "Approved resume family",
      "The selected resume family is outside the campaign’s approved execution list.",
      [`selected:${application.resume.familyId}`, `approved:${policy.approvedResumeFamilies.join(", ")}`],
      "resume_family",
    ));
  }

  if (campaign.reviewConditions.unusualTerms && hasUnusualTerms(application.job)) {
    pushIfOpen(blocker(
      "legal_attestation",
      "Review unusual application terms",
      "The posting contains terms that require human judgment before execution.",
      ["unusual-terms:detected"],
      "unusual_terms",
    ));
  }

  if (submissionPolicy.allowedAts && submissionPolicy.allowedAts.length > 0) {
    if (!application.job.ats) {
      pushIfOpen(blocker(
        "external_verification",
        "Verify application system",
        "The campaign only permits known ATS systems, but this posting does not identify one.",
        [`allowed-ats:${submissionPolicy.allowedAts.join(", ")}`],
        "ats",
      ));
    } else if (!matchingAny(application.job.ats, submissionPolicy.allowedAts)) {
      pushIfOpen(blocker(
        "external_verification",
        "Verify application system",
        "The detected ATS is outside the campaign’s allowed execution list.",
        [`ats:${application.job.ats}`, `allowed-ats:${submissionPolicy.allowedAts.join(", ")}`],
        "ats",
      ));
    }
  }

  if (submissionPolicy.authority === "never" && !allowPreparationOnly) {
    blockers.push(blocker(
      "submission_approval",
      "Submission policy",
      "This campaign explicitly forbids automatic submission.",
      ["authority:never"],
      "submission_authority",
    ));
  } else if (
    (submissionPolicy.authority === "approval_required" || submissionPolicy.requireExplicitApproval) &&
    !resolvedBlockerKeys.has(careerBlockerKey(blocker(
      "submission_approval",
      "Approve application execution",
      "Campaign policy requires explicit approval before a consequential application action.",
      [`authority:${submissionPolicy.authority}`],
      "submission_approval",
    )))
  ) {
    blockers.push(blocker(
      "submission_approval",
      "Approve application execution",
      "Campaign policy requires explicit approval before a consequential application action.",
      [`authority:${submissionPolicy.authority}`],
      "submission_approval",
    ));
  }

  if (blockers.length > 0) {
    return {
      allowed: false,
      reason: "Execution is paused until every policy blocker is resolved.",
      blockers,
    };
  }

  return {
    allowed: true,
    reason: `Application passed deterministic execution policy under ${submissionPolicy.authority} authority.`,
    blockers: [],
  };
}
