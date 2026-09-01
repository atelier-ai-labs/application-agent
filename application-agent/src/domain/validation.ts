import type {
  Application,
  ApplicationAnswer,
  ApplicationEvent,
  CandidateProfile,
  FitAssessment,
  HumanRequiredField,
  JobPosting,
  ManualSubmissionConfirmation,
  ResumeFamily,
  SubmissionProof,
  TailoredResume,
  TailoredResumeSection,
} from "./types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function isHttpUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isOptionalHttpUrl(value: unknown): boolean {
  return value === undefined || isHttpUrl(value);
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isCompensation(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.minimum === undefined || (typeof value.minimum === "number" && Number.isFinite(value.minimum))) &&
    (value.maximum === undefined || (typeof value.maximum === "number" && Number.isFinite(value.maximum))) &&
    (value.currency === undefined || isNonEmptyString(value.currency))
  );
}

export function isJobPosting(value: unknown): value is JobPosting {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isOptionalHttpUrl(value.sourceUrl) &&
    isOptionalHttpUrl(value.applicationUrl) &&
    isNonEmptyString(value.company) &&
    isNonEmptyString(value.title) &&
    (value.location === undefined || isNonEmptyString(value.location)) &&
    (value.remoteStatus === undefined || isNonEmptyString(value.remoteStatus)) &&
    (value.employmentType === undefined || isNonEmptyString(value.employmentType)) &&
    (value.compensation === undefined || isCompensation(value.compensation)) &&
    isNonEmptyString(value.description) &&
    isStringArray(value.requiredSkills) &&
    isStringArray(value.preferredSkills) &&
    (value.seniority === undefined || isNonEmptyString(value.seniority)) &&
    (value.ats === undefined || isNonEmptyString(value.ats)) &&
    isTimestamp(value.capturedAt)
  );
}

function isResumeFamilyId(value: unknown): value is ResumeFamily["id"] {
  return value === "cloud-platform" || value === "frontend-software" || value === "ai-platform-agentic";
}

function isAnswerPolicy(value: unknown): boolean {
  return value === "auto" || value === "draft_review" || value === "ask" || value === "never_auto";
}

function isAnswerValue(value: unknown): boolean {
  return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

export function isSubmissionProof(value: unknown): value is SubmissionProof {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.mode === "external" || value.mode === "simulated") &&
    isNonEmptyString(value.provider) &&
    isNonEmptyString(value.externalApplicationId) &&
    isTimestamp(value.submittedAt) &&
    isNonEmptyString(value.evidence)
  );
}

export function isManualSubmissionConfirmation(value: unknown): value is ManualSubmissionConfirmation {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.mode === "manual" &&
    isTimestamp(value.confirmedAt) &&
    value.evidence === "user_confirmed_successful_manual_submission"
  );
}

export function isAppliedEvidence(value: unknown): value is SubmissionProof | ManualSubmissionConfirmation {
  return isSubmissionProof(value) || isManualSubmissionConfirmation(value);
}

function isEmploymentRecord(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.employer) &&
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.startDate) &&
    isStringOrNull(value.endDate) &&
    isStringOrNull(value.location) &&
    isStringArray(value.bullets) &&
    isStringArray(value.verifiedSkills) &&
    isNonEmptyString(value.provenance)
  );
}

function isEducationRecord(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.institution) &&
    isNonEmptyString(value.degree) &&
    isStringOrNull(value.field) &&
    isStringOrNull(value.completionDate) &&
    isNonEmptyString(value.provenance)
  );
}

function isProjectRecord(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.description) &&
    isStringArray(value.bullets) &&
    isStringArray(value.verifiedSkills) &&
    isNonEmptyString(value.provenance)
  );
}

function isCertificationRecord(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.issuer) &&
    isStringOrNull(value.issuedDate) &&
    isStringOrNull(value.expiresDate) &&
    isNonEmptyString(value.provenance)
  );
}

function isResumeFamily(value: unknown): value is ResumeFamily {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isResumeFamilyId(value.id) &&
    isNonEmptyString(value.label) &&
    isNonEmptyString(value.summary) &&
    isStringArray(value.focusKeywords) &&
    isStringArray(value.experienceIds) &&
    isStringArray(value.projectIds)
  );
}

export function isCandidateProfile(value: unknown): value is CandidateProfile {
  if (!isRecord(value)) {
    return false;
  }

  const identity = value.identity;
  const preferences = value.workPreferences;
  const authorization = value.workAuthorization;
  const answerPolicies = value.answerPolicies;
  const reusableAnswers = value.approvedReusableAnswers;

  return (
    value.schemaVersion === "0.1" &&
    isNonEmptyString(value.id) &&
    (value.profileKind === "example" || value.profileKind === "private") &&
    isRecord(identity) &&
    isStringOrNull(identity.fullName) &&
    isStringOrNull(identity.email) &&
    isStringOrNull(identity.phone) &&
    isStringOrNull(identity.location) &&
    isStringOrNull(value.location) &&
    Array.isArray(value.employmentHistory) &&
    value.employmentHistory.every(isEmploymentRecord) &&
    Array.isArray(value.education) &&
    value.education.every(isEducationRecord) &&
    isStringArray(value.skills) &&
    Array.isArray(value.projects) &&
    value.projects.every(isProjectRecord) &&
    Array.isArray(value.certifications) &&
    value.certifications.every(isCertificationRecord) &&
    isRecord(preferences) &&
    isStringOrNull(preferences.remote) &&
    isStringOrNull(preferences.relocation) &&
    isStringOrNull(preferences.travel) &&
    isRecord(authorization) &&
    isStringOrNull(authorization.status) &&
    isStringArray(authorization.countries) &&
    (authorization.sponsorshipRequired === null || typeof authorization.sponsorshipRequired === "boolean") &&
    Array.isArray(value.resumeFamilies) &&
    value.resumeFamilies.every(isResumeFamily) &&
    isRecord(answerPolicies) &&
    Object.values(answerPolicies).every(isAnswerPolicy) &&
    isRecord(reusableAnswers) &&
    Object.values(reusableAnswers).every((answer) => typeof answer === "string")
  );
}

export function isFitAssessment(value: unknown): value is FitAssessment {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.classification === "strong" ||
      value.classification === "good" ||
      value.classification === "stretch" ||
      value.classification === "weak") &&
    isStringArray(value.strongMatches) &&
    isStringArray(value.partialMatches) &&
    isStringArray(value.meaningfulGaps) &&
    isStringArray(value.unsupportedRequiredQualifications) &&
    isResumeFamilyId(value.recommendedResumeFamily) &&
    isNonEmptyString(value.resumeFamilyReason) &&
    (value.applicationRecommendation === "proceed" ||
      value.applicationRecommendation === "proceed_with_review" ||
      value.applicationRecommendation === "hold") &&
    isNonEmptyString(value.methodology)
  );
}

function isTailoredResumeSection(value: unknown): value is TailoredResumeSection {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.kind === "summary" ||
      value.kind === "skills" ||
      value.kind === "experience" ||
      value.kind === "projects") &&
    isNonEmptyString(value.title) &&
    (isNonEmptyString(value.content) || isStringArray(value.content)) &&
    isStringArray(value.provenance)
  );
}

export function isTailoredResume(value: unknown): value is TailoredResume {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isResumeFamilyId(value.familyId) &&
    isNonEmptyString(value.familyLabel) &&
    isNonEmptyString(value.summary) &&
    Array.isArray(value.sections) &&
    value.sections.every(isTailoredResumeSection) &&
    isTimestamp(value.generatedAt)
  );
}

export function isApplicationAnswer(value: unknown): value is ApplicationAnswer {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.field) &&
    (value.question === undefined || typeof value.question === "string") &&
    isAnswerPolicy(value.policy) &&
    (value.value === undefined || isAnswerValue(value.value)) &&
    (value.status === "resolved" ||
      value.status === "drafted" ||
      value.status === "needs_input" ||
      value.status === "blocked") &&
    (value.provenance === undefined || isStringArray(value.provenance))
  );
}

function isHumanRequiredField(value: unknown): value is HumanRequiredField {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.field) &&
    isNonEmptyString(value.label) &&
    isNonEmptyString(value.reason) &&
    isAnswerPolicy(value.policy) &&
    isNonEmptyString(value.answerId) &&
    (value.status === "open" || value.status === "resolved") &&
    (value.value === undefined || isAnswerValue(value.value))
  );
}

function isApplicationStatus(value: unknown): boolean {
  return (
    value === "discovered" ||
    value === "evaluated" ||
    value === "preparing" ||
    value === "needs_input" ||
    value === "ready_for_review" ||
    value === "applied" ||
    value === "failed"
  );
}

export function isApplication(value: unknown): value is Application {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.id) &&
    typeof value.isExample === "boolean" &&
    isJobPosting(value.job) &&
    (value.fit === null || isFitAssessment(value.fit)) &&
    (value.resume === null || isTailoredResume(value.resume)) &&
    Array.isArray(value.answers) &&
    value.answers.every(isApplicationAnswer) &&
    Array.isArray(value.blockers) &&
    value.blockers.every(isHumanRequiredField) &&
    isApplicationStatus(value.status) &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt) &&
    (value.failureReason === undefined || typeof value.failureReason === "string") &&
    (value.submissionProof === undefined || isSubmissionProof(value.submissionProof)) &&
    (value.manualSubmissionConfirmation === undefined || isManualSubmissionConfirmation(value.manualSubmissionConfirmation)) &&
    (value.status !== "applied" || isAppliedEvidence(value.submissionProof ?? value.manualSubmissionConfirmation))
  );
}

export function isApplicationEvent(value: unknown): value is ApplicationEvent {
  if (!isRecord(value)) {
    return false;
  }

  const eventTypes = [
    "application.created",
    "application.evaluated",
    "application.prepared",
    "application.needs_input",
    "application.ready_for_review",
    "application.applied",
    "application.failed",
  ];

  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.applicationId) &&
    eventTypes.includes(value.type as string) &&
    isTimestamp(value.occurredAt) &&
    (value.metadata === undefined ||
      (isRecord(value.metadata) && Object.values(value.metadata).every((item) => typeof item === "string")))
  );
}
