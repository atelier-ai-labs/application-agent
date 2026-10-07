import type {
  ApplicationFieldDescriptor,
  ApplicationFieldOption,
  ApplicationFieldQuestionDescriptor,
  BrowserCaptchaDiagnostics,
  BrowserExecutionBoundaryState,
  BrowserExecutionDiagnostic,
  BrowserNavigationDiagnostics,
  ExecutionInspection,
} from "./executor";
import type {
  CareerBlockerDraft,
  CareerBlockerKind,
  CareerBlockerUnit,
  QuestionProvenance,
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
  isSubmissionProof,
} from "./validation";
import { isExecutionFailureReason } from "./executionTrace";
import { isCampaign, isCareerBlocker, isCareerJob } from "../persistence/careerRepository";
import { MAX_REUSABLE_ANSWERS, isReusableAnswer } from "./answerBank";

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

function isBrowserExecutionBoundaryState(value: unknown): value is BrowserExecutionBoundaryState {
  if (!isRecord(value)) return false;
  return [
    "hostRequestAccepted",
    "browserLaunched",
    "contextCreated",
    "pageCreated",
    "navigationStarted",
    "navigationCompleted",
    "domReady",
    "preflightInspectionStarted",
    "preflightInspectionCompleted",
    "controlsInspectionStarted",
    "controlsInspectionCompleted",
    "executorStarted",
    "executorInspectionStarted",
    "executorInspectionCompleted",
    "browserClosed",
  ].every((key) => value[key] === undefined || typeof value[key] === "boolean");
}

function isBrowserHostname(value: unknown): boolean {
  return isNonEmptyString(value) && value.length <= 253 && !/[\s/?#]/.test(value);
}

function isBrowserNavigationDiagnostics(value: unknown): value is BrowserNavigationDiagnostics {
  if (!isRecord(value)) return false;
  return (value.targetHost === undefined || isBrowserHostname(value.targetHost)) &&
    (value.finalHostname === undefined || isBrowserHostname(value.finalHostname)) &&
    (value.outcome === undefined || value.outcome === "not_started" || value.outcome === "started" ||
      value.outcome === "completed" || value.outcome === "http_error" || value.outcome === "failed") &&
    (value.httpStatus === undefined || (isNonNegativeInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599)) &&
    (value.httpStatusCategory === undefined || value.httpStatusCategory === "1xx" || value.httpStatusCategory === "2xx" ||
      value.httpStatusCategory === "3xx" || value.httpStatusCategory === "4xx" || value.httpStatusCategory === "5xx") &&
    (value.redirectCount === undefined || isNonNegativeInteger(value.redirectCount)) &&
    (value.loadStateReached === undefined || value.loadStateReached === "domcontentloaded" || value.loadStateReached === "networkidle") &&
    (value.networkIdleTimedOut === undefined || typeof value.networkIdleTimedOut === "boolean");
}

function isSafeBrowserDiagnosticMessage(value: unknown): boolean {
  return typeof value === "string" && value.length <= 240 &&
    !/https?:\/\/|\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|client[_-]?secret|token|secret|password)\s*[:=]/i.test(value);
}

function isBrowserExecutionDiagnostic(value: unknown): value is BrowserExecutionDiagnostic {
  if (!isRecord(value)) return false;
  return (value.stage === "browser_launch" || value.stage === "context_create" || value.stage === "page_create" ||
    value.stage === "navigation" || value.stage === "page_load" || value.stage === "preflight_inspection" ||
    value.stage === "controls_inspection" || value.stage === "executor_inspection" ||
    value.stage === "executor_start" || value.stage === "browser_close") &&
    (value.reasonCode === "browser_launch_failed" || value.reasonCode === "context_create_failed" ||
      value.reasonCode === "page_create_failed" || value.reasonCode === "navigation_failed" ||
      value.reasonCode === "navigation_timeout" || value.reasonCode === "page_load_failed" ||
      value.reasonCode === "inspection_failed" || value.reasonCode === "unsupported_page" ||
      value.reasonCode === "browser_closed" || value.reasonCode === "cancelled" || value.reasonCode === "unknown") &&
    (value.message === undefined || isSafeBrowserDiagnosticMessage(value.message)) &&
    (value.boundaries === undefined || isBrowserExecutionBoundaryState(value.boundaries)) &&
    (value.navigation === undefined || isBrowserNavigationDiagnostics(value.navigation));
}

function isBrowserCaptchaDiagnostics(value: unknown): value is BrowserCaptchaDiagnostics {
  if (!isRecord(value)) return false;
  return (value.state === "none" || value.state === "infrastructure_present" ||
    value.state === "active_challenge" || value.state === "uncertain") &&
    isNonNegativeInteger(value.markerCount) &&
    isNonNegativeInteger(value.visibleMarkerCount) &&
    isNonNegativeInteger(value.challengeIframeCount) &&
    isNonNegativeInteger(value.visibleChallengeIframeCount) &&
    (value.evidenceCategory === "no_markers" || value.evidenceCategory === "hidden_infrastructure" || value.evidenceCategory === "passive_infrastructure" ||
      value.evidenceCategory === "visible_challenge_iframe" || value.evidenceCategory === "visible_challenge_control" ||
      value.evidenceCategory === "explicit_challenge_text" || value.evidenceCategory === "visible_marker_ambiguous");
}

function isBrowserExecutionTelemetry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (value.preflightInspectionDurationMs === undefined || isNonNegativeNumber(value.preflightInspectionDurationMs)) &&
    (value.executorInspectionDurationMs === undefined || isNonNegativeNumber(value.executorInspectionDurationMs)) &&
    (value.browserPreparationDurationMs === undefined || isNonNegativeNumber(value.browserPreparationDurationMs)) &&
    (value.domInspectionCount === undefined || isNonNegativeInteger(value.domInspectionCount)) &&
    (value.cancellationCount === undefined || isNonNegativeInteger(value.cancellationCount)) &&
    (value.lateCompletionCount === undefined || isNonNegativeInteger(value.lateCompletionCount)) &&
    (value.boundaries === undefined || isBrowserExecutionBoundaryState(value.boundaries)) &&
    (value.navigation === undefined || isBrowserNavigationDiagnostics(value.navigation)) &&
    (value.diagnostic === undefined || isBrowserExecutionDiagnostic(value.diagnostic)) &&
    (value.captcha === undefined || isBrowserCaptchaDiagnostics(value.captcha));
}

function isFieldType(value: unknown): boolean {
  return value === "text" || value === "email" || value === "tel" || value === "textarea" ||
    value === "select" || value === "radio" || value === "checkbox" || value === "file" || value === "unknown";
}

function isFieldClassification(value: unknown): boolean {
  return value === "contact" || value === "linkedin" || value === "website" || value === "resume_upload" || value === "location" ||
    value === "desired_work_location" || value === "start_availability" ||
    value === "employment_history" || value === "education" || value === "work_authorization" ||
    value === "sponsorship" || value === "salary" || value === "relocation" || value === "travel" ||
    value === "free_text" || value === "demographic" || value === "legal_attestation" || value === "unknown";
}

function isApplicationFieldOption(value: unknown): value is ApplicationFieldOption {
  return isRecord(value) && isNonEmptyString(value.label) && isNonEmptyString(value.value);
}

function isBoundedDescriptorText(value: unknown, maximum = 240): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum &&
    !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value);
}

function isApplicationFieldQuestionDescriptor(value: unknown): value is ApplicationFieldQuestionDescriptor {
  if (!isRecord(value)) return false;
  return (value.promptText === undefined || isBoundedDescriptorText(value.promptText)) &&
    (value.sectionTitle === undefined || isBoundedDescriptorText(value.sectionTitle, 160)) &&
    (value.accessibleName === undefined || isBoundedDescriptorText(value.accessibleName)) &&
    (value.nearbyInstructionText === undefined || isBoundedDescriptorText(value.nearbyInstructionText, 160)) &&
    (value.sourceStrategy === "fieldset_legend" || value.sourceStrategy === "aria_labelledby" ||
      value.sourceStrategy === "question_container" || value.sourceStrategy === "nearby_text" ||
      value.sourceStrategy === "unavailable") &&
    (value.confidence === "high" || value.confidence === "medium" || value.confidence === "uncertain");
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
    (value.questionDescriptor === undefined || isApplicationFieldQuestionDescriptor(value.questionDescriptor)) &&
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

function isQuestionProvenance(value: unknown): value is QuestionProvenance {
  return value === "ATS_FORM" || value === "APPLICATION_PREPARATION" || value === "POLICY" ||
    value === "CONFIGURATION" || value === "UNKNOWN";
}

export function isCareerBlockerDraft(value: unknown): value is CareerBlockerDraft {
  if (!isRecord(value)) return false;
  return isCareerBlockerKind(value.kind) &&
    isCareerBlockerUnit(value.unit) &&
    (value.questionProvenance === undefined || isQuestionProvenance(value.questionProvenance)) &&
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
    (value.boundaries === undefined || isBrowserExecutionBoundaryState(value.boundaries)) &&
    (value.navigation === undefined || isBrowserNavigationDiagnostics(value.navigation)) &&
    (value.diagnostic === undefined || isBrowserExecutionDiagnostic(value.diagnostic)) &&
    (value.captcha === undefined || isBrowserCaptchaDiagnostics(value.captcha)) &&
    isTimestamp(value.startedAt) &&
    isTimestamp(value.updatedAt);
}

export function isExecutionHostResult(value: unknown): value is ExecutionHostResult {
  if (!isRecord(value)) return false;
  if (value.state === "submitted") {
    return isSubmissionProof(value.proof) &&
      (value.note === undefined || typeof value.note === "string");
  }
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
    isJobPosting(value.careerJob.job) &&
    (value.priorAnswers === undefined || isPriorAnswers(value.priorAnswers));
}

/**
 * Prior answers are caller-supplied data that can fill an employer form, so the
 * host accepts only bounded, well-formed blockers that are still eligible for
 * reuse. A gated kind (salary, legal, demographic, ...) is rejected outright
 * instead of being filtered, so a bad caller fails loudly.
 */
function isPriorAnswers(value: unknown): boolean {
  return Array.isArray(value) &&
    value.length <= MAX_REUSABLE_ANSWERS &&
    value.every((entry) => isCareerBlocker(entry) && isReusableAnswer(entry));
}
