/**
 * Deterministic graders that call pure domain functions.
 * Offline / CI-safe: no network, no Playwright, no live ATS.
 */

import { classifyJobUrl } from "../../application-agent/src/domain/jobUrlClassifier";
import { assessFit } from "../../application-agent/src/domain/fit";
import {
  buildDraftAnswer,
  prepareApplicationAnswers,
} from "../../application-agent/src/domain/answers";
import { verifyPreparedApplication } from "../../application-agent/src/domain/policies";
import { tailorResume } from "../../application-agent/src/domain/resume";
import type {
  Application,
  CandidateProfile,
  JobPosting,
} from "../../application-agent/src/domain/types";
import type {
  ApplicationPolicy,
  Campaign,
  SubmissionPolicy,
} from "../../application-agent/src/domain/campaignTypes";
import type {
  AssessFitTask,
  ClassifyUrlTask,
  FieldFillTask,
  GoldenTask,
  SubmitPolicyTask,
} from "../golden/schema";
import type { GraderResult } from "../types";

function scoreFromChecks(passed: number, total: number): number {
  if (total <= 0) return 0;
  return Number((passed / total).toFixed(3));
}

export function gradeClassifyUrl(task: ClassifyUrlTask): GraderResult {
  const actual = classifyJobUrl(task.input.url);
  const checks: Array<{ ok: boolean; label: string }> = [
    { ok: actual.kind === task.expected.kind, label: `kind=${actual.kind}` },
  ];
  if (task.expected.siteIdentifier !== undefined) {
    checks.push({
      ok: actual.siteIdentifier === task.expected.siteIdentifier,
      label: `siteIdentifier=${actual.siteIdentifier ?? "undefined"}`,
    });
  }
  if (task.expected.postingIdentifier !== undefined) {
    checks.push({
      ok: actual.postingIdentifier === task.expected.postingIdentifier,
      label: `postingIdentifier=${actual.postingIdentifier ?? "undefined"}`,
    });
  }
  const passedCount = checks.filter((c) => c.ok).length;
  const passed = passedCount === checks.length;
  return {
    grader: "deterministic",
    name: "classify_url",
    passed,
    score: scoreFromChecks(passedCount, checks.length),
    detail: checks.map((c) => `${c.ok ? "PASS" : "FAIL"}:${c.label}`).join("; "),
  };
}

export function gradeAssessFit(task: AssessFitTask): GraderResult {
  const fit = assessFit(task.input.job, task.input.profile);
  const checks: Array<{ ok: boolean; label: string }> = [
    {
      ok: fit.classification === task.expected.classification,
      label: `classification=${fit.classification}`,
    },
  ];

  for (const skill of task.expected.mustIncludeStrongMatches ?? []) {
    checks.push({
      ok: fit.strongMatches.includes(skill),
      label: `strongMatch:${skill}`,
    });
  }
  for (const skill of task.expected.mustIncludeUnsupportedRequired ?? []) {
    checks.push({
      ok: fit.unsupportedRequiredQualifications.includes(skill),
      label: `unsupportedRequired:${skill}`,
    });
  }
  if (task.expected.recommendedResumeFamily !== undefined) {
    checks.push({
      ok: fit.recommendedResumeFamily === task.expected.recommendedResumeFamily,
      label: `resumeFamily=${fit.recommendedResumeFamily}`,
    });
  }

  const passedCount = checks.filter((c) => c.ok).length;
  const passed = passedCount === checks.length;
  return {
    grader: "deterministic",
    name: "assess_fit",
    passed,
    score: scoreFromChecks(passedCount, checks.length),
    detail: checks.map((c) => `${c.ok ? "PASS" : "FAIL"}:${c.label}`).join("; "),
  };
}

export async function gradeFieldFill(task: FieldFillTask): Promise<GraderResult> {
  const { job, profile } = task.input;
  const fit = assessFit(job, profile);
  const resume = tailorResume(job, profile, fit, job.capturedAt);
  const answers = await prepareApplicationAnswers(
    job,
    profile,
    fit,
    resume,
    async (context) => buildDraftAnswer(context),
  );
  const byField = new Map(answers.map((answer) => [answer.field, answer]));
  const checks: Array<{ ok: boolean; label: string }> = [];

  for (const field of task.expected.autoFieldsResolved) {
    const answer = byField.get(field);
    checks.push({
      ok: answer?.status === "resolved",
      label: `autoResolved:${field}=${answer?.status ?? "missing"}`,
    });
  }
  for (const field of task.expected.neverAutoBlocked) {
    const answer = byField.get(field);
    checks.push({
      ok: answer?.policy === "never_auto" && answer.status === "blocked",
      label: `neverAutoBlocked:${field}=${answer?.status ?? "missing"}`,
    });
  }

  const passedCount = checks.filter((c) => c.ok).length;
  const passed = passedCount === checks.length;
  return {
    grader: "deterministic",
    name: "field_fill",
    passed,
    score: scoreFromChecks(passedCount, checks.length),
    detail: checks.map((c) => `${c.ok ? "PASS" : "FAIL"}:${c.label}`).join("; "),
  };
}

function stubCampaign(submissionPolicy: SubmissionPolicy): Campaign {
  const now = "2026-09-08T12:00:00.000Z";
  return {
    id: "evals-campaign",
    name: "Evals Campaign",
    goal: "Offline policy fixture",
    status: "active",
    searchCriteria: {
      roleLanes: [],
      locations: [],
      remoteOnly: false,
      employmentTypes: [],
      excludedSeniorities: [],
      excludedCompanies: [],
    },
    searchSources: [],
    fitPolicy: { strong: "pursue", good: "pursue", stretch: "hold", weak: "reject" },
    applicationPolicy: {
      autoPrepare: true,
      allowGroundedDrafts: true,
      approvedResumeFamilies: ["cloud-platform", "frontend-software", "ai-platform-agentic"],
    },
    submissionPolicy,
    dailyApplicationLimit: 5,
    reviewConditions: {
      unusualTerms: false,
      authenticationRequired: false,
      unknownFacts: false,
      subjectiveAnswers: false,
    },
    stopConditions: {
      stopOnAcceptedOffer: true,
      systemicFailureLimit: 3,
    },
    consecutiveSystemicFailures: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function stubReadyApplication(job: JobPosting, profile: CandidateProfile): Application {
  const fit = assessFit(job, profile);
  const resume = tailorResume(job, profile, fit, job.capturedAt);
  const now = job.capturedAt;
  return {
    id: "evals-application",
    isExample: true,
    job,
    fit,
    resume,
    answers: [],
    blockers: [],
    status: "ready_for_review",
    createdAt: now,
    updatedAt: now,
  };
}

const SUBMIT_POLICY_JOB: JobPosting = {
  company: "Example Cloud Systems",
  title: "Cloud Platform Engineer",
  description: "Platform role for evals submit-policy fixture.",
  requiredSkills: ["AWS", "Kubernetes", "Python"],
  preferredSkills: ["Terraform"],
  ats: "Lever",
  capturedAt: "2026-09-08T12:00:00.000Z",
};

const SUBMIT_POLICY_PROFILE: CandidateProfile = {
  schemaVersion: "0.1",
  id: "evals-alex-submit",
  profileKind: "example",
  identity: {
    fullName: "Alex Example",
    email: "alex.example@example.com",
    phone: "+1 555 0100",
    location: "Example City, US",
  },
  location: "Example City, US",
  employmentHistory: [
    {
      id: "emp-example-labs",
      employer: "Example Labs",
      title: "Platform Engineer",
      startDate: "2022-01",
      endDate: "2025-06",
      location: "Example City, US",
      bullets: ["Operated AWS and Kubernetes platforms."],
      verifiedSkills: ["AWS", "Kubernetes", "Python", "Terraform"],
      provenance: "evals-fixture",
    },
  ],
  education: [],
  skills: ["AWS", "Kubernetes", "Python", "Terraform"],
  projects: [],
  certifications: [],
  workPreferences: { remote: "Open to remote roles", relocation: null, travel: null },
  workAuthorization: { status: null, countries: [], sponsorshipRequired: null },
  resumeFamilies: [
    {
      id: "cloud-platform",
      label: "Cloud / Platform",
      summary: "Platform engineer focused on reliable cloud systems.",
      focusKeywords: ["cloud", "platform", "kubernetes", "aws"],
      experienceIds: ["emp-example-labs"],
      projectIds: [],
    },
    {
      id: "frontend-software",
      label: "Frontend / Software",
      summary: "Software engineer focused on clear product interfaces.",
      focusKeywords: ["frontend", "react", "typescript"],
      experienceIds: ["emp-example-labs"],
      projectIds: [],
    },
    {
      id: "ai-platform-agentic",
      label: "AI Platform / Agentic",
      summary: "Engineer focused on grounded AI workflows.",
      focusKeywords: ["ai", "agentic", "llm"],
      experienceIds: ["emp-example-labs"],
      projectIds: [],
    },
  ],
  answerPolicies: {},
  approvedReusableAnswers: {},
};

export function gradeSubmitPolicy(task: SubmitPolicyTask): GraderResult {
  const submissionPolicy: SubmissionPolicy = {
    authority: task.input.authority,
    requireExplicitApproval: task.input.requireExplicitApproval,
    allowedAts: ["Lever", "Greenhouse"],
  };
  const applicationPolicy: ApplicationPolicy = {
    autoPrepare: true,
    allowGroundedDrafts: true,
    approvedResumeFamilies: ["cloud-platform", "frontend-software", "ai-platform-agentic"],
  };
  const campaign = stubCampaign(submissionPolicy);
  const application = stubReadyApplication(SUBMIT_POLICY_JOB, SUBMIT_POLICY_PROFILE);
  const gate = verifyPreparedApplication(
    application,
    applicationPolicy,
    submissionPolicy,
    campaign,
  );

  const checks: Array<{ ok: boolean; label: string }> = [
    {
      ok: gate.allowed === task.expected.allowed,
      label: `allowed=${gate.allowed}`,
    },
  ];

  if (task.expected.mustBlockOnAuthorityNever) {
    const blockedByNever = gate.blockers.some(
      (blocker) =>
        blocker.field === "submission_authority" ||
        blocker.evidence.includes("authority:never") ||
        /forbids automatic submission/i.test(blocker.reason),
    );
    checks.push({
      ok: task.input.authority === "never" ? blockedByNever && !gate.allowed : true,
      label: blockedByNever
        ? "blocked:authority:never"
        : "missing-authority-never-blocker",
    });
  }

  const passedCount = checks.filter((c) => c.ok).length;
  const passed = passedCount === checks.length;
  return {
    grader: "deterministic",
    name: "submit_never_auto",
    passed,
    score: scoreFromChecks(passedCount, checks.length),
    detail: checks.map((c) => `${c.ok ? "PASS" : "FAIL"}:${c.label}`).join("; "),
  };
}

export async function runDeterministicGrader(task: GoldenTask): Promise<GraderResult | null> {
  if (!task.graders.includes("deterministic")) return null;
  switch (task.kind) {
    case "classify_url":
      return gradeClassifyUrl(task);
    case "assess_fit":
      return gradeAssessFit(task);
    case "field_fill":
      return gradeFieldFill(task);
    case "submit_policy":
      return gradeSubmitPolicy(task);
    case "groundedness":
      return null;
    default: {
      const _exhaustive: never = task;
      return _exhaustive;
    }
  }
}
