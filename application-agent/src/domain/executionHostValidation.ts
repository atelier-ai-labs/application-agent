import type {
  ApplicationFieldDescriptor,
  ApplicationFieldOption,
  ExecutionInspection,
} from "./executor";
import type {
  CareerBlockerDraft,
  CareerBlockerKind,
  CareerBlockerUnit,
} from "./campaignTypes";
import type {
  ExecutionHostRequest,
  ExecutionHostResult,
  ExecutionHostSnapshot,
} from "./executionHostTypes";
import { isExecutionHostStatus } from "./executionHostTypes";
import {
  isApplication,
  isCandidateProfile,
  isJobPosting,
  isRecord,
} from "./validation";
import { isExecutionFailureReason } from "./executionTrace";
import { isCampaign, isCareerJob } from "../persistence/careerRepository";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value > 0;
}

function isBrowserExecutionTelemetry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (value.preflightInspectionDurationMs === undefined || isNonNegativeNumber(value.preflightInspectionDurationMs)) &&
    (value.executorInspectionDurationMs === undefined || isNonNegativeNumber(value.executorInspectionDurationMs)) &&
    (value.browserPreparationDurationMs === undefined || isNonNegativeNumber(value.browserPreparationDurationMs)) &&
    (value.domInspectionCount === undefined || isNonNegativeInteger(value.domInspectionCount)) &&
    (value.cancellationCount === undefined || isNonNegativeInteger(value.cancellationCount)) &&
    (value.lateCompletionCount === undefined || isNonNegativeInteger(value.lateCompletionCount));
}

function isFieldType(value: unknown): boolean {
  return value === "text" || value === "email" || value === "tel" || value === "textarea" ||
    value === "select" || value === "radio" || value === "checkbox" || value === "file" || value === "unknown";
}

function isFieldClassification(value: unknown): boolean {
  return value === "contact" || value === "resume_upload" || value === "location" ||
    value === "employment_history" || value === "education" || value === "work_authorization" ||
    value === "sponsorship" || value === "salary" || value === "relocation" || value === "travel" ||
    value === "free_text" || value === "demographic" || value === "legal_attestation" || value === "unknown";
}

function isApplicationFieldOption(value: unknown): value is ApplicationFieldOption {
  return isRecord(value) && isNonEmptyString(value.label) && isNonEmptyString(value.value);
}

function isApplicationFieldDescriptor(value: unknown): value is ApplicationFieldDescriptor {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.id) &&
    isNonEmptyString(value.label) &&
    isFieldType(value.type) &&
    typeof value.required === "boolean" &&
    (value.options === undefined || (Array.isArray(value.options) && value.options.every(isApplicationFieldOption))) &&
    (value.section === undefined || isNonEmptyString(value.section)) &&
    (value.sourceSelector === undefined || isNonEmptyString(value.sourceSelector)) &&
    isFieldClassification(value.classification);
}

function isCareerBlockerKind(value: unknown): value is CareerBlockerKind {
  return value === "salary" || value === "sponsorship" || value === "relocation" || value === "travel" ||
    value === "legal_attestation" || value === "demographic_disclosure" || value === "unknown_fact" ||
    value === "subjective_answer" || value === "external_login" || value === "captcha" ||
    value === "external_verification" || value === "unknown_form_field" || value === "unsupported_widget" ||
    value === "resume_missing" || value === "required_file_missing" || value === "submission_approval" || value === "other";
}

function isCareerBlockerUnit(value: unknown): value is CareerBlockerUnit {
  return value === "application_preparation" || value === "submission" || value === "external";
}

export function isCareerBlockerDraft(value: unknown): value is CareerBlockerDraft {
  if (!isRecord(value)) return false;
  return isCareerBlockerKind(value.kind) &&
    isCareerBlockerUnit(value.unit) &&
    (value.field === undefined || isNonEmptyString(value.field)) &&
    isNonEmptyString(value.question) &&
    isNonEmptyString(value.reason) &&
    isStringArray(value.evidence) &&
    (value.resumeAfterHuman === undefined || typeof value.resumeAfterHuman === "boolean");
}

export function isExecutionInspection(value: unknown): value is ExecutionInspection {
  if (!isRecord(value)) return false;
  return (value.status === "inspected" || value.status === "needs_input" || value.status === "unsupported" || value.status === "failed") &&
    Array.isArray(value.fields) && value.fields.every(isApplicationFieldDescriptor) &&
    isStringArray(value.fieldsFilled) &&
    isStringArray(value.unresolvedFields) &&
    Array.isArray(value.blockers) && value.blockers.every(isCareerBlockerDraft) &&
    (value.resumeUsed === undefined || isNonEmptyString(value.resumeUsed)) &&
    isStringArray(value.evidence) &&
    (value.durationMs === undefined || isNonNegativeNumber(value.durationMs)) &&
    (value.domInspectionCount === undefined || isNonNegativeInteger(value.domInspectionCount)) &&
    isTimestamp(value.startedAt) &&
    isTimestamp(value.updatedAt);
}

export function isExecutionHostResult(value: unknown): value is ExecutionHostResult {
  if (!isRecord(value)) return false;
  if (value.state === "requires_human") {
    return isCareerBlockerDraft(value.blocker) &&
      (value.blockers === undefined || (Array.isArray(value.blockers) && value.blockers.every(isCareerBlockerDraft))) &&
      (value.inspection === undefined || isExecutionInspection(value.inspection));
  }
  if (value.state === "ready_to_submit") {
    return isExecutionInspection(value.inspection) &&
      (value.note === undefined || typeof value.note === "string");
  }
  if (value.state === "unsupported") {
    return isNonEmptyString(value.reason) &&
      (value.blocker === undefined || isCareerBlockerDraft(value.blocker)) &&
      (value.inspection === undefined || isExecutionInspection(value.inspection));
  }
  if (value.state === "failed") {
    return isNonEmptyString(value.reason) &&
      typeof value.retryable === "boolean" &&
      (value.inspection === undefined || isExecutionInspection(value.inspection));
  }
  // In particular, a submitted result is not part of the host response.
  return false;
}

export function isExecutionHostSnapshot(value: unknown): value is ExecutionHostSnapshot {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.id) &&
    value.mode === "real_local" &&
    isNonEmptyString(value.applicationId) &&
    isNonEmptyString(value.jobId) &&
    isNonEmptyString(value.campaignId) &&
    isExecutionHostStatus(value.status) &&
    isTimestamp(value.startedAt) &&
    isTimestamp(value.updatedAt) &&
    (value.attempt === undefined || isPositiveInteger(value.attempt)) &&
    (value.retryReasonCode === undefined || isExecutionFailureReason(value.retryReasonCode)) &&
    (value.failureReasonCode === undefined || isExecutionFailureReason(value.failureReasonCode)) &&
    (value.telemetry === undefined || isBrowserExecutionTelemetry(value.telemetry)) &&
    (value.inspection === undefined || isExecutionInspection(value.inspection)) &&
    (value.result === undefined || isExecutionHostResult(value.result)) &&
    (value.error === undefined || isNonEmptyString(value.error));
}

/**
 * Lightweight shape validation before the more specific trust checks. This
 * is intentionally kept separate from trusted URL/profile validation so the
 * HTTP boundary can return a safe 400 instead of throwing deep in Playwright.
 */
export function isExecutionHostRequest(value: unknown): value is ExecutionHostRequest {
  if (!isRecord(value)) return false;
  return value.mode === "real_local" &&
    isCampaign(value.campaign) &&
    isCareerJob(value.careerJob) &&
    isApplication(value.application) &&
    isCandidateProfile(value.profile) &&
    isJobPosting(value.careerJob.job);
}
