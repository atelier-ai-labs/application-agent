import type {
  ApplicationPolicy,
  CareerBlocker,
  CareerEvent,
  CareerJob,
  Campaign,
  DiscoverySourceSummary,
  DiscoverySummary,
  FitPolicy,
  JobActionability,
  JobSourceConfig,
  JobSourceObservation,
  JobSourceMode,
  ReviewConditions,
  ScoutReferenceMetrics,
  SearchCriteria,
  StopConditions,
  SubmissionPolicy,
  TrackerSyncState,
} from "../domain/campaignTypes";
import type { AnswerValue } from "../domain/types";
import type {
  BrowserExecutionBoundaryState,
  BrowserExecutionDiagnostic,
  BrowserNavigationDiagnostics,
} from "../domain/executor";
import {
  EXECUTION_RUN_HISTORY_LIMIT,
  isExecutionFailureReason,
  isHumanAttentionCategory,
  isExecutionRunTrace,
} from "../domain/executionTrace";
import {
  isFitAssessment,
  isJobPosting,
  isManualSubmissionConfirmation,
  isRecord,
  isSubmissionProof,
} from "../domain/validation";
import { browserStorage, type KeyValueStorage } from "./storage";

export const CAMPAIGNS_STORAGE_KEY = "atelier.application-agent.campaigns.v0";
export const CAREER_JOBS_STORAGE_KEY = "atelier.application-agent.career-jobs.v0";
export const CAREER_EVENTS_STORAGE_KEY = "atelier.application-agent.career-events.v0";

export interface CareerRepository {
  listCampaigns(): readonly Campaign[];
  getCampaign(id: string): Campaign | null;
  saveCampaign(campaign: Campaign): void;
  listJobs(campaignId?: string): readonly CareerJob[];
  getJob(id: string): CareerJob | null;
  saveJob(job: CareerJob): void;
  listEvents(campaignId: string): readonly CareerEvent[];
  appendEvent(event: CareerEvent): void;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function loadArray(storage: KeyValueStorage, key: string): unknown[] {
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function boundedHistory(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.runHistory)) return value;
  return {
    ...value,
    // A malformed historical item must not hide an otherwise valid campaign.
    runHistory: value.runHistory.filter(isExecutionRunTrace).slice(-EXECUTION_RUN_HISTORY_LIMIT),
  };
}

function boundedCampaign(campaign: Campaign): Campaign {
  return campaign.runHistory
    ? { ...campaign, runHistory: campaign.runHistory.slice(-EXECUTION_RUN_HISTORY_LIMIT) }
    : campaign;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function isAnswerValue(value: unknown): value is AnswerValue {
  return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
}

function isOptionalHttpUrl(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
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

function isBrowserExecutionTelemetry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [
    "preflightInspectionDurationMs",
    "executorInspectionDurationMs",
    "browserPreparationDurationMs",
    "domInspectionCount",
    "cancellationCount",
    "lateCompletionCount",
  ].every((key) => value[key] === undefined || (typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0)) &&
    (value.boundaries === undefined || isBrowserExecutionBoundaryState(value.boundaries)) &&
    (value.navigation === undefined || isBrowserNavigationDiagnostics(value.navigation)) &&
    (value.diagnostic === undefined || isBrowserExecutionDiagnostic(value.diagnostic));
}

function isSearchCriteria(value: unknown): value is SearchCriteria {
  if (!isRecord(value)) return false;
  return (
    isStringArray(value.roleLanes) &&
    (value.searchQueries === undefined || isStringArray(value.searchQueries)) &&
    isStringArray(value.locations) &&
    typeof value.remoteOnly === "boolean" &&
    isStringArray(value.employmentTypes) &&
    (value.minimumSalary === undefined || (typeof value.minimumSalary === "number" && Number.isFinite(value.minimumSalary) && value.minimumSalary >= 0)) &&
    isStringArray(value.excludedSeniorities) &&
    isStringArray(value.excludedCompanies)
  );
}

function isJobSourceMode(value: unknown): value is JobSourceMode {
  return value === "live" || value === "demo";
}

function isJobActionability(value: unknown): value is JobActionability {
  return value === "discoverable_only" || value === "actionable";
}

function isJobSourceConfig(value: unknown): value is JobSourceConfig {
  if (!isRecord(value)) return false;
  if (value.type === "lever") {
    return isNonEmptyString(value.site) && isOptionalNonEmptyString(value.id);
  }
  if (value.type === "greenhouse") {
    return isNonEmptyString(value.board) && isOptionalNonEmptyString(value.company) && isOptionalNonEmptyString(value.id);
  }
  if (value.type === "brave_search") return isOptionalNonEmptyString(value.id);
  return (value.type === "remotive" || value.type === "demo") && isOptionalNonEmptyString(value.id);
}

function isDiscoveryStatus(value: unknown): boolean {
  return value === "success" || value === "empty" || value === "partial" || value === "failed" || value === "not_configured";
}

function isDiscoveryQueryMetrics(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.query) &&
    isNonNegativeInteger(value.providerResults) &&
    isNonNegativeInteger(value.acceptedReferences) &&
    isNonNegativeInteger(value.rejectedReferences) &&
    isNonNegativeInteger(value.duplicateReferences) &&
    isDiscoveryStatus(value.status);
}

function isReferenceMetrics(value: unknown): value is ScoutReferenceMetrics {
  if (!isRecord(value)) return false;
  return (
    isNonNegativeInteger(value.referencesDiscovered) &&
    isNonNegativeInteger(value.knownAtsReferences) &&
    isNonNegativeInteger(value.leverReferences) &&
    isNonNegativeInteger(value.greenhouseReferences) &&
    isNonNegativeInteger(value.knownUnsupportedReferences) &&
    isNonNegativeInteger(value.unknownOrCustomReferences) &&
    isNonNegativeInteger(value.structuredJobsResolved) &&
    isNonNegativeInteger(value.duplicatesRemoved) &&
    isNonNegativeInteger(value.sourceFailures) &&
    (value.providerResults === undefined || isNonNegativeInteger(value.providerResults)) &&
    (value.acceptedReferences === undefined || isNonNegativeInteger(value.acceptedReferences)) &&
    (value.rejectedReferences === undefined || isNonNegativeInteger(value.rejectedReferences)) &&
    (value.duplicateReferences === undefined || isNonNegativeInteger(value.duplicateReferences)) &&
    (value.queriesExecuted === undefined || isNonNegativeInteger(value.queriesExecuted)) &&
    (value.queryMetrics === undefined || (Array.isArray(value.queryMetrics) && value.queryMetrics.every(isDiscoveryQueryMetrics))) &&
    (value.ashbyReferences === undefined || isNonNegativeInteger(value.ashbyReferences)) &&
    (value.workdayReferences === undefined || isNonNegativeInteger(value.workdayReferences)) &&
    (value.customReferences === undefined || isNonNegativeInteger(value.customReferences)) &&
    (value.unknownReferences === undefined || isNonNegativeInteger(value.unknownReferences)) &&
    (value.fallbackRequiredReferences === undefined || isNonNegativeInteger(value.fallbackRequiredReferences)) &&
    (value.invalidReferences === undefined || isNonNegativeInteger(value.invalidReferences)) &&
    (value.failedReferences === undefined || isNonNegativeInteger(value.failedReferences)) &&
    (value.uniqueLeverSites === undefined || isNonNegativeInteger(value.uniqueLeverSites)) &&
    (value.uniqueGreenhouseBoards === undefined || isNonNegativeInteger(value.uniqueGreenhouseBoards)) &&
    (value.leverSiteIdentities === undefined || isStringArray(value.leverSiteIdentities)) &&
    (value.greenhouseBoardIdentities === undefined || isStringArray(value.greenhouseBoardIdentities))
  );
}

function isJobSourceObservation(value: unknown): value is JobSourceObservation {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.sourceId) &&
    isJobSourceMode(value.mode) &&
    isJobActionability(value.actionability) &&
    isOptionalNonEmptyString(value.sourceRecordId) &&
    isOptionalHttpUrl(value.sourceUrl) &&
    isOptionalHttpUrl(value.applicationUrl) &&
    isTimestamp(value.observedAt)
  );
}

function isDiscoverySummary(value: unknown): value is DiscoverySummary {
  if (!isRecord(value)) return false;
  return (
    isDiscoveryStatus(value.status) &&
    isStringArray(value.sourceIds) &&
    Array.isArray(value.sourceModes) && value.sourceModes.every(isJobSourceMode) &&
    (value.sourceSummaries === undefined || (Array.isArray(value.sourceSummaries) && value.sourceSummaries.every(isDiscoverySourceSummary))) &&
    (value.referenceMetrics === undefined || isReferenceMetrics(value.referenceMetrics)) &&
    isTimestamp(value.startedAt) &&
    isTimestamp(value.completedAt) &&
    isNonNegativeInteger(value.receivedCount) &&
    isNonNegativeInteger(value.normalizedCount) &&
    isNonNegativeInteger(value.duplicateCount) &&
    isNonNegativeInteger(value.newCount) &&
    isNonNegativeInteger(value.failureCount) &&
    isNonNegativeInteger(value.warningCount)
  );
}

function isDiscoverySourceSummary(value: unknown): value is DiscoverySourceSummary {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.sourceId) &&
    isJobSourceMode(value.mode) &&
    isDiscoveryStatus(value.status) &&
    isNonNegativeInteger(value.receivedCount) &&
    isNonNegativeInteger(value.normalizedCount) &&
    isNonNegativeInteger(value.duplicateCount) &&
    isNonNegativeInteger(value.warningCount) &&
    isOptionalNonEmptyString(value.reason) &&
    (value.cached === undefined || typeof value.cached === "boolean") &&
    (value.sourceFetchedAt === undefined || isTimestamp(value.sourceFetchedAt))
  );
}

function isPursuitDecision(value: unknown): boolean {
  return value === "pursue" || value === "hold" || value === "reject";
}

function isFitPolicy(value: unknown): value is FitPolicy {
  if (!isRecord(value)) return false;
  return isPursuitDecision(value.strong) && isPursuitDecision(value.good) && isPursuitDecision(value.stretch) && isPursuitDecision(value.weak);
}

function isResumeFamilyId(value: unknown): boolean {
  return value === "cloud-platform" || value === "frontend-software" || value === "ai-platform-agentic";
}

function isApplicationPolicy(value: unknown): value is ApplicationPolicy {
  if (!isRecord(value)) return false;
  return (
    typeof value.autoPrepare === "boolean" &&
    typeof value.allowGroundedDrafts === "boolean" &&
    Array.isArray(value.approvedResumeFamilies) &&
    value.approvedResumeFamilies.every(isResumeFamilyId)
  );
}

function isSubmissionPolicy(value: unknown): value is SubmissionPolicy {
  if (!isRecord(value)) return false;
  return (
    (value.authority === "never" || value.authority === "approval_required" || value.authority === "simulated" || value.authority === "automatic") &&
    typeof value.requireExplicitApproval === "boolean" &&
    (value.allowedAts === undefined || isStringArray(value.allowedAts))
  );
}

function isReviewConditions(value: unknown): value is ReviewConditions {
  if (!isRecord(value)) return false;
  return (
    typeof value.unusualTerms === "boolean" &&
    typeof value.authenticationRequired === "boolean" &&
    typeof value.unknownFacts === "boolean" &&
    typeof value.subjectiveAnswers === "boolean"
  );
}

function isStopConditions(value: unknown): value is StopConditions {
  if (!isRecord(value)) return false;
  return (
    typeof value.stopOnAcceptedOffer === "boolean" &&
    (value.maxApplications === undefined || isPositiveInteger(value.maxApplications)) &&
    (value.maxDays === undefined || isPositiveInteger(value.maxDays)) &&
    isPositiveInteger(value.systemicFailureLimit)
  );
}

export function isCampaign(value: unknown): value is Campaign {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isOptionalNonEmptyString(value.ownerId) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.goal) &&
    (value.status === "draft" || value.status === "active" || value.status === "paused" || value.status === "completed" || value.status === "failed") &&
    isSearchCriteria(value.searchCriteria) &&
    isStringArray(value.searchSources) &&
    (value.sourceConfigs === undefined || (Array.isArray(value.sourceConfigs) && value.sourceConfigs.every(isJobSourceConfig))) &&
    isFitPolicy(value.fitPolicy) &&
    isApplicationPolicy(value.applicationPolicy) &&
    isSubmissionPolicy(value.submissionPolicy) &&
    isPositiveInteger(value.dailyApplicationLimit) &&
    (value.optionalWeeklyLimit === undefined || isPositiveInteger(value.optionalWeeklyLimit)) &&
    isReviewConditions(value.reviewConditions) &&
    isStopConditions(value.stopConditions) &&
    isNonNegativeInteger(value.consecutiveSystemicFailures) &&
    (value.lastDiscovery === undefined || isDiscoverySummary(value.lastDiscovery)) &&
    (value.lastRunTrace === undefined || isExecutionRunTrace(value.lastRunTrace)) &&
    (value.runHistory === undefined || (Array.isArray(value.runHistory) && value.runHistory.every(isExecutionRunTrace))) &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt)
  );
}

function isCareerBlockerKind(value: unknown): boolean {
  return value === "salary" || value === "sponsorship" || value === "relocation" || value === "travel" || value === "legal_attestation" || value === "demographic_disclosure" || value === "unknown_fact" || value === "subjective_answer" || value === "external_login" || value === "captcha" || value === "external_verification" || value === "unknown_form_field" || value === "unsupported_widget" || value === "resume_missing" || value === "required_file_missing" || value === "submission_approval" || value === "other";
}

function isCareerBlockerUnit(value: unknown): boolean {
  return value === "application_preparation" || value === "submission" || value === "external";
}

function isCareerBlocker(value: unknown): value is CareerBlocker {
  if (!isRecord(value)) return false;
  const context = value.context;
  if (!isRecord(context)) return false;
  return (
    isNonEmptyString(value.id) &&
    isCareerBlockerKind(value.kind) &&
    isCareerBlockerUnit(value.unit) &&
    isOptionalNonEmptyString(value.field) &&
    isNonEmptyString(value.question) &&
    isNonEmptyString(context.jobId) &&
    isOptionalNonEmptyString(context.applicationId) &&
    isNonEmptyString(context.company) &&
    isNonEmptyString(context.role) &&
    isOptionalNonEmptyString(context.sourceUrl) &&
    isOptionalNonEmptyString(context.applicationUrl) &&
    isNonEmptyString(value.reason) &&
    isStringArray(value.evidence) &&
    (value.status === "open" || value.status === "resolved") &&
    isTimestamp(value.createdAt) &&
    (value.resolvedAt === undefined || isTimestamp(value.resolvedAt)) &&
    (value.value === undefined || isAnswerValue(value.value)) &&
    (value.resumeAfterHuman === undefined || typeof value.resumeAfterHuman === "boolean")
  );
}

function isCareerExecutionStatus(value: unknown): boolean {
  return value === "not_started" || value === "starting" || value === "inspecting" || value === "executing" ||
    value === "needs_input" || value === "waiting_for_human" || value === "resuming" ||
    value === "ready_to_submit" || value === "failed" || value === "cancelled" || value === "closed";
}

function isCareerExecutionState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isCareerExecutionStatus(value.status) &&
    (value.mode === undefined || value.mode === "simulated" || value.mode === "real_local") &&
    isOptionalNonEmptyString(value.hostExecutionId) &&
    isStringArray(value.fieldsDetected) &&
    isStringArray(value.fieldsFilled) &&
    isStringArray(value.unresolvedFields) &&
    isOptionalNonEmptyString(value.resumeUsed) &&
    isStringArray(value.evidence) &&
    (value.attempt === undefined || isPositiveInteger(value.attempt)) &&
    (value.retryReasonCode === undefined || isExecutionFailureReason(value.retryReasonCode)) &&
    (value.failureReasonCode === undefined || isExecutionFailureReason(value.failureReasonCode)) &&
    (value.telemetry === undefined || isBrowserExecutionTelemetry(value.telemetry)) &&
    (value.boundaries === undefined || isBrowserExecutionBoundaryState(value.boundaries)) &&
    (value.navigation === undefined || isBrowserNavigationDiagnostics(value.navigation)) &&
    (value.diagnostic === undefined || isBrowserExecutionDiagnostic(value.diagnostic)) &&
    isTimestamp(value.startedAt) &&
    isTimestamp(value.updatedAt)
  );
}

function isTrackerSyncState(value: unknown): value is TrackerSyncState {
  if (!isRecord(value)) return false;
  return (
    (value.status === "not_required" || value.status === "pending" || value.status === "synced" || value.status === "failed") &&
    (value.attempt === undefined || isPositiveInteger(value.attempt)) &&
    (value.attemptedAt === undefined || isTimestamp(value.attemptedAt)) &&
    (value.updatedAt === undefined || isTimestamp(value.updatedAt)) &&
    isOptionalNonEmptyString(value.trackerRecordId) &&
    isOptionalNonEmptyString(value.failureReason) &&
    (value.durationMs === undefined || (typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0)) &&
    (value.requestCount === undefined || isNonNegativeInteger(value.requestCount)) &&
    (value.successCount === undefined || isNonNegativeInteger(value.successCount)) &&
    (value.failureCount === undefined || isNonNegativeInteger(value.failureCount)) &&
    (value.timeoutCount === undefined || isNonNegativeInteger(value.timeoutCount))
  );
}

export function isCareerJob(value: unknown): value is CareerJob {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.campaignId) &&
    typeof value.isExample === "boolean" &&
    (value.sourceMode === undefined || isJobSourceMode(value.sourceMode)) &&
    (value.actionability === undefined || isJobActionability(value.actionability)) &&
    isNonEmptyString(value.fingerprint) &&
    isNonEmptyString(value.sourceId) &&
    isOptionalNonEmptyString(value.sourceRecordId) &&
    (value.sourcePublishedAt === undefined || isTimestamp(value.sourcePublishedAt)) &&
    (value.dedupeKeys === undefined || isStringArray(value.dedupeKeys)) &&
    (value.sourceObservations === undefined || (Array.isArray(value.sourceObservations) && value.sourceObservations.every(isJobSourceObservation))) &&
    isJobPosting(value.job) &&
    isTimestamp(value.discoveredAt) &&
    (value.fit === null || isFitAssessment(value.fit)) &&
    isOptionalNonEmptyString(value.applicationId) &&
    isOptionalNonEmptyString(value.applicationStartedAt) &&
    (value.applicationResumeAttempt === undefined || isPositiveInteger(value.applicationResumeAttempt)) &&
    (value.status === "discovered" || value.status === "rejected" || value.status === "held" || value.status === "pursuing" || value.status === "preparing" || value.status === "needs_input" || value.status === "ready_to_submit" || value.status === "submitted" || value.status === "applied" || value.status === "failed") &&
    isOptionalNonEmptyString(value.decisionReason) &&
    Array.isArray(value.blockers) && value.blockers.every(isCareerBlocker) &&
    (value.execution === undefined || isCareerExecutionState(value.execution)) &&
    (value.submissionProof === undefined || isSubmissionProof(value.submissionProof)) &&
    (value.manualSubmissionConfirmation === undefined || isManualSubmissionConfirmation(value.manualSubmissionConfirmation)) &&
    (value.status !== "submitted" || isSubmissionProof(value.submissionProof)) &&
    (value.status !== "applied" || isSubmissionProof(value.submissionProof) || isManualSubmissionConfirmation(value.manualSubmissionConfirmation)) &&
    isOptionalNonEmptyString(value.trackerRecordId) &&
    isOptionalNonEmptyString(value.trackerFailureReason) &&
    (value.trackerSync === undefined || isTrackerSyncState(value.trackerSync)) &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt)
  );
}

const CAREER_EVENT_TYPES = new Set([
  "campaign.created",
  "campaign.started",
  "campaign.paused",
  "campaign.completed",
  "campaign.failed",
  "campaign.review_needed",
  "job.discovery_started",
  "job.discovery_completed",
  "job.discovery_partial",
  "job.discovery_failed",
  "job.discovered",
  "job.rejected",
  "job.held",
  "application.created",
  "application.evaluated",
  "application.prepared",
  "application.needs_input",
  "application.execution_started",
  "application.execution_host_started",
  "application.form_inspected",
  "application.field_filled",
  "application.execution_paused",
  "application.execution_resumed",
  "application.execution_cancelled",
  "application.execution_failed",
  "application.ready_for_review",
  "application.ready_to_submit",
  "application.submitted",
  "application.applied",
  "application.failed",
  "tracker.update_started",
  "tracker.updated",
  "tracker.failed",
  "tracker.retry_started",
]);

export function isCareerEvent(value: unknown): value is CareerEvent {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    CAREER_EVENT_TYPES.has(value.type as string) &&
    isNonEmptyString(value.campaignId) &&
    isOptionalNonEmptyString(value.jobId) &&
    isOptionalNonEmptyString(value.applicationId) &&
    isTimestamp(value.occurredAt) &&
    typeof value.attention === "boolean" &&
    (value.attentionCategory === undefined || isHumanAttentionCategory(value.attentionCategory)) &&
    (value.metadata === undefined || (isRecord(value.metadata) && Object.values(value.metadata).every((item) => typeof item === "string")))
  );
}

export class InMemoryCareerRepository implements CareerRepository {
  private campaigns: Campaign[] = [];
  private jobs: CareerJob[] = [];
  private events: CareerEvent[] = [];

  listCampaigns(): readonly Campaign[] {
    return this.campaigns.map(clone);
  }

  getCampaign(id: string): Campaign | null {
    const campaign = this.campaigns.find((candidate) => candidate.id === id);
    return campaign ? clone(campaign) : null;
  }

  saveCampaign(campaign: Campaign): void {
    campaign = boundedCampaign(campaign);
    const index = this.campaigns.findIndex((candidate) => candidate.id === campaign.id);
    if (index === -1) this.campaigns.push(clone(campaign));
    else this.campaigns[index] = clone(campaign);
  }

  listJobs(campaignId?: string): readonly CareerJob[] {
    return this.jobs
      .filter((job) => campaignId === undefined || job.campaignId === campaignId)
      .map(clone);
  }

  getJob(id: string): CareerJob | null {
    const job = this.jobs.find((candidate) => candidate.id === id);
    return job ? clone(job) : null;
  }

  saveJob(job: CareerJob): void {
    const index = this.jobs.findIndex((candidate) => candidate.id === job.id);
    if (index === -1) this.jobs.push(clone(job));
    else this.jobs[index] = clone(job);
  }

  listEvents(campaignId: string): readonly CareerEvent[] {
    return this.events.filter((event) => event.campaignId === campaignId).map(clone);
  }

  appendEvent(event: CareerEvent): void {
    this.events.push(clone(event));
  }
}

export class LocalStorageCareerRepository implements CareerRepository {
  constructor(private readonly storage: KeyValueStorage) {}

  listCampaigns(): readonly Campaign[] {
    return loadArray(this.storage, CAMPAIGNS_STORAGE_KEY).map(boundedHistory).filter(isCampaign);
  }

  getCampaign(id: string): Campaign | null {
    return this.listCampaigns().find((campaign) => campaign.id === id) ?? null;
  }

  saveCampaign(campaign: Campaign): void {
    campaign = boundedCampaign(campaign);
    const campaigns = [...this.listCampaigns()];
    const index = campaigns.findIndex((candidate) => candidate.id === campaign.id);
    if (index === -1) campaigns.push(clone(campaign));
    else campaigns[index] = clone(campaign);
    this.storage.setItem(CAMPAIGNS_STORAGE_KEY, JSON.stringify(campaigns));
  }

  listJobs(campaignId?: string): readonly CareerJob[] {
    return loadArray(this.storage, CAREER_JOBS_STORAGE_KEY)
      .filter(isCareerJob)
      .filter((job) => campaignId === undefined || job.campaignId === campaignId);
  }

  getJob(id: string): CareerJob | null {
    return this.listJobs().find((job) => job.id === id) ?? null;
  }

  saveJob(job: CareerJob): void {
    const jobs = [...this.listJobs()];
    const index = jobs.findIndex((candidate) => candidate.id === job.id);
    if (index === -1) jobs.push(clone(job));
    else jobs[index] = clone(job);
    this.storage.setItem(CAREER_JOBS_STORAGE_KEY, JSON.stringify(jobs));
  }

  listEvents(campaignId: string): readonly CareerEvent[] {
    return loadArray(this.storage, CAREER_EVENTS_STORAGE_KEY)
      .filter(isCareerEvent)
      .filter((event) => event.campaignId === campaignId);
  }

  appendEvent(event: CareerEvent): void {
    const events = [...loadArray(this.storage, CAREER_EVENTS_STORAGE_KEY).filter(isCareerEvent), clone(event)];
    this.storage.setItem(CAREER_EVENTS_STORAGE_KEY, JSON.stringify(events));
  }
}

let defaultCareerRepository: CareerRepository | null = null;

export function getDefaultCareerRepository(): CareerRepository {
  if (!defaultCareerRepository) {
    const storage = browserStorage();
    defaultCareerRepository = storage
      ? new LocalStorageCareerRepository(storage)
      : new InMemoryCareerRepository();
  }
  return defaultCareerRepository;
}

export function resetDefaultCareerRepository(): void {
  defaultCareerRepository = null;
}

export function clearCareerRepositoryStorage(storage: KeyValueStorage): void {
  storage.removeItem(CAMPAIGNS_STORAGE_KEY);
  storage.removeItem(CAREER_JOBS_STORAGE_KEY);
  storage.removeItem(CAREER_EVENTS_STORAGE_KEY);
}
