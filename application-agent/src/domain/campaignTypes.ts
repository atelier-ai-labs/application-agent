import type {
  AnswerValue,
  Application,
  FitAssessment,
  JobPosting,
  ManualSubmissionConfirmation,
  ResumeFamilyId,
  SubmissionProof,
} from "./types";
import type { ExecutionRunTrace } from "./executionTrace";

export type CampaignStatus = "draft" | "active" | "paused" | "completed" | "failed";

export type PursuitDecision = "pursue" | "hold" | "reject";

export type SubmissionAuthority =
  | "never"
  | "approval_required"
  | "simulated"
  | "automatic";

export type JobSourceMode = "live" | "demo";

export type JobActionability = "discoverable_only" | "actionable";

export type JobSourceConfig =
  | { type: "remotive"; id?: string }
  | { type: "lever"; site: string; id?: string }
  | { type: "greenhouse"; board: string; company?: string; id?: string }
  | { type: "brave_search"; id?: string }
  | { type: "demo"; id?: string };

/**
 * Stable registry keys for persisted source configuration. Provider endpoints
 * remain runtime configuration; this value only identifies the source.
 */
export function jobSourceConfigId(config: JobSourceConfig): string {
  if (config.id?.trim()) return config.id.trim();
  if (config.type === "lever") return `lever:${config.site.trim().toLowerCase()}`;
  if (config.type === "greenhouse") return `greenhouse:${config.board.trim().toLowerCase()}`;
  if (config.type === "remotive") return "remotive-live";
  if (config.type === "brave_search") return config.id?.trim() || "references:brave-search";
  return "demo-local";
}

export type DiscoveryStatus = "success" | "empty" | "partial" | "failed" | "not_configured";

/** Per-query evidence retained for bounded broad-discovery experiments. */
export interface DiscoveryQueryMetrics {
  query: string;
  providerResults: number;
  acceptedReferences: number;
  rejectedReferences: number;
  duplicateReferences: number;
  status: DiscoveryStatus;
}

export interface SearchCriteria {
  roleLanes: readonly string[];
  /** Optional provider-search terms. `roleLanes` remains the local hard filter. */
  searchQueries?: readonly string[];
  locations: readonly string[];
  remoteOnly: boolean;
  employmentTypes: readonly string[];
  minimumSalary?: number;
  excludedSeniorities: readonly string[];
  excludedCompanies: readonly string[];
}

export interface FitPolicy {
  strong: PursuitDecision;
  good: PursuitDecision;
  stretch: PursuitDecision;
  weak: PursuitDecision;
}

export interface ApplicationPolicy {
  autoPrepare: boolean;
  allowGroundedDrafts: boolean;
  approvedResumeFamilies: readonly ResumeFamilyId[];
}

export interface SubmissionPolicy {
  authority: SubmissionAuthority;
  requireExplicitApproval: boolean;
  allowedAts?: readonly string[];
}

export interface ReviewConditions {
  unusualTerms: boolean;
  authenticationRequired: boolean;
  unknownFacts: boolean;
  subjectiveAnswers: boolean;
}

export interface StopConditions {
  stopOnAcceptedOffer: boolean;
  maxApplications?: number;
  maxDays?: number;
  systemicFailureLimit: number;
}

export interface DiscoverySourceSummary {
  sourceId: string;
  mode: JobSourceMode;
  status: DiscoveryStatus;
  receivedCount: number;
  normalizedCount: number;
  duplicateCount: number;
  warningCount: number;
  reason?: string;
  /** True when the source reused a still-fresh provider response. */
  cached?: boolean;
  /** When the provider response was fetched from the external source. */
  sourceFetchedAt?: string;
}

/** Low-noise evidence about URL/reference resolution in a Scout cycle. */
export interface ScoutReferenceMetrics {
  referencesDiscovered: number;
  knownAtsReferences: number;
  leverReferences: number;
  greenhouseReferences: number;
  knownUnsupportedReferences: number;
  unknownOrCustomReferences: number;
  structuredJobsResolved: number;
  duplicatesRemoved: number;
  sourceFailures: number;
  /** Optional broad-provider totals. Older persisted summaries omit these. */
  providerResults?: number;
  acceptedReferences?: number;
  rejectedReferences?: number;
  duplicateReferences?: number;
  queriesExecuted?: number;
  queryMetrics?: readonly DiscoveryQueryMetrics[];
  ashbyReferences?: number;
  workdayReferences?: number;
  customReferences?: number;
  unknownReferences?: number;
  fallbackRequiredReferences?: number;
  invalidReferences?: number;
  failedReferences?: number;
  uniqueLeverSites?: number;
  uniqueGreenhouseBoards?: number;
  /** Exact reusable identities observed in this sample, when available. */
  leverSiteIdentities?: readonly string[];
  greenhouseBoardIdentities?: readonly string[];
}

export interface DiscoverySummary {
  status: DiscoveryStatus;
  sourceIds: readonly string[];
  sourceModes: readonly JobSourceMode[];
  sourceSummaries?: readonly DiscoverySourceSummary[];
  startedAt: string;
  completedAt: string;
  receivedCount: number;
  normalizedCount: number;
  duplicateCount: number;
  newCount: number;
  failureCount: number;
  warningCount: number;
  /** Optional reference-discovery metrics; older persisted summaries omit this. */
  referenceMetrics?: ScoutReferenceMetrics;
}

export interface Campaign {
  id: string;
  /** Reserved for future per-user ownership; V0 does not implement accounts. */
  ownerId?: string;
  name: string;
  goal: string;
  status: CampaignStatus;
  searchCriteria: SearchCriteria;
  searchSources: readonly string[];
  /** Optional declarative source metadata; searchSources remains the lookup key for compatibility. */
  sourceConfigs?: readonly JobSourceConfig[];
  fitPolicy: FitPolicy;
  applicationPolicy: ApplicationPolicy;
  submissionPolicy: SubmissionPolicy;
  dailyApplicationLimit: number;
  optionalWeeklyLimit?: number;
  reviewConditions: ReviewConditions;
  stopConditions: StopConditions;
  consecutiveSystemicFailures: number;
  lastDiscovery?: DiscoverySummary;
  /** Latest campaign-run telemetry; operational metadata only. */
  lastRunTrace?: ExecutionRunTrace;
  createdAt: string;
  updatedAt: string;
}

/**
 * Input used to create a campaign. The service fills only operational defaults;
 * it never fills candidate facts or posting data.
 */
export interface CreateCampaignInput {
  ownerId?: string;
  name: string;
  goal: string;
  searchCriteria?: Partial<SearchCriteria>;
  searchSources: readonly string[];
  sourceConfigs?: readonly JobSourceConfig[];
  fitPolicy?: Partial<FitPolicy>;
  applicationPolicy?: Partial<ApplicationPolicy>;
  submissionPolicy?: Partial<SubmissionPolicy>;
  dailyApplicationLimit?: number;
  optionalWeeklyLimit?: number;
  reviewConditions?: Partial<ReviewConditions>;
  stopConditions?: Partial<StopConditions>;
}

export type CareerJobStatus =
  | "discovered"
  | "rejected"
  | "held"
  | "pursuing"
  | "preparing"
  | "needs_input"
  | "ready_to_submit"
  | "submitted"
  | "applied"
  | "failed";

export type CareerBlockerKind =
  | "salary"
  | "sponsorship"
  | "relocation"
  | "travel"
  | "legal_attestation"
  | "demographic_disclosure"
  | "unknown_fact"
  | "subjective_answer"
  | "external_login"
  | "captcha"
  | "external_verification"
  | "unknown_form_field"
  | "unsupported_widget"
  | "resume_missing"
  | "required_file_missing"
  | "submission_approval"
  | "other";

export type CareerBlockerUnit = "application_preparation" | "submission" | "external";
export type CareerBlockerStatus = "open" | "resolved";

export interface CareerBlockerContext {
  jobId: string;
  applicationId?: string;
  company: string;
  role: string;
  sourceUrl?: string;
  applicationUrl?: string;
}

export interface CareerBlockerDraft {
  kind: CareerBlockerKind;
  unit: CareerBlockerUnit;
  field?: string;
  question: string;
  reason: string;
  evidence: readonly string[];
  /** True when the same browser/session may continue after the user responds. */
  resumeAfterHuman?: boolean;
}

export interface CareerBlocker {
  id: string;
  kind: CareerBlockerKind;
  unit: CareerBlockerUnit;
  field?: string;
  question: string;
  context: CareerBlockerContext;
  reason: string;
  evidence: readonly string[];
  status: CareerBlockerStatus;
  createdAt: string;
  resolvedAt?: string;
  value?: AnswerValue;
  /** True when the same browser/session may continue after the user responds. */
  resumeAfterHuman?: boolean;
}

export type CareerExecutionStatus =
  | "not_started"
  | "starting"
  | "inspecting"
  | "executing"
  | "needs_input"
  | "waiting_for_human"
  | "resuming"
  | "ready_to_submit"
  | "failed"
  | "cancelled"
  | "closed";

export type CareerExecutionMode = "simulated" | "real_local";

/** Serializable browser-execution state. Cookies, passwords, and page content are never stored here. */
export interface CareerExecutionState {
  status: CareerExecutionStatus;
  mode?: CareerExecutionMode;
  /** Opaque ID owned by the local execution host; no browser handle is stored. */
  hostExecutionId?: string;
  fieldsDetected: readonly string[];
  fieldsFilled: readonly string[];
  unresolvedFields: readonly string[];
  resumeUsed?: string;
  evidence: readonly string[];
  startedAt: string;
  updatedAt: string;
}

export type TrackerSyncStatus = "not_required" | "pending" | "synced" | "failed";

export interface TrackerSyncState {
  status: TrackerSyncStatus;
  attemptedAt?: string;
  updatedAt?: string;
  trackerRecordId?: string;
  failureReason?: string;
}

export interface CareerJob {
  id: string;
  campaignId: string;
  isExample: boolean;
  sourceMode?: JobSourceMode;
  actionability?: JobActionability;
  fingerprint: string;
  sourceId: string;
  sourceRecordId?: string;
  sourcePublishedAt?: string;
  dedupeKeys?: readonly string[];
  sourceObservations?: readonly JobSourceObservation[];
  job: JobPosting;
  discoveredAt: string;
  fit: FitAssessment | null;
  applicationId?: string;
  applicationStartedAt?: string;
  status: CareerJobStatus;
  decisionReason?: string;
  blockers: readonly CareerBlocker[];
  execution?: CareerExecutionState;
  submissionProof?: SubmissionProof;
  manualSubmissionConfirmation?: ManualSubmissionConfirmation;
  trackerRecordId?: string;
  trackerFailureReason?: string;
  trackerSync?: TrackerSyncState;
  createdAt: string;
  updatedAt: string;
}

export interface JobSourceObservation {
  sourceId: string;
  mode: JobSourceMode;
  actionability: JobActionability;
  sourceRecordId?: string;
  sourceUrl?: string;
  applicationUrl?: string;
  observedAt: string;
}

export type CareerEventType =
  | "campaign.created"
  | "campaign.started"
  | "campaign.paused"
  | "campaign.completed"
  | "campaign.failed"
  | "campaign.review_needed"
  | "job.discovery_started"
  | "job.discovery_completed"
  | "job.discovery_partial"
  | "job.discovery_failed"
  | "job.discovered"
  | "job.rejected"
  | "job.held"
  | "application.created"
  | "application.evaluated"
  | "application.prepared"
  | "application.needs_input"
  | "application.execution_started"
  | "application.execution_host_started"
  | "application.form_inspected"
  | "application.field_filled"
  | "application.execution_paused"
  | "application.execution_resumed"
  | "application.execution_cancelled"
  | "application.execution_failed"
  | "application.ready_for_review"
  | "application.ready_to_submit"
  | "application.submitted"
  | "application.applied"
  | "application.failed"
  | "tracker.update_started"
  | "tracker.updated"
  | "tracker.failed"
  | "tracker.retry_started";

export interface CareerEvent {
  id: string;
  type: CareerEventType;
  campaignId: string;
  jobId?: string;
  applicationId?: string;
  occurredAt: string;
  attention: boolean;
  metadata?: Readonly<Record<string, string>>;
}

export interface CampaignCounts {
  discovered: number;
  worthPursuing: number;
  prepared: number;
  applied: number;
  needsYou: number;
  rejected: number;
  held: number;
  failed: number;
}

export interface CampaignSnapshot {
  campaign: Campaign;
  counts: CampaignCounts;
  jobs: readonly CareerJob[];
  attentionJobs: readonly CareerJob[];
  recentEvents: readonly CareerEvent[];
}

export interface CampaignRunResult {
  snapshot: CampaignSnapshot;
  discovered: number;
  alreadySeen: number;
  alreadyApplied: number;
  pursued: number;
  rejected: number;
  held: number;
  prepared: number;
  applied: number;
  failures: number;
  attentionRequired: number;
  trace?: ExecutionRunTrace;
}

export interface PreparedApplicationContext {
  careerJob: CareerJob;
  application: Application;
}
