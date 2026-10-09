import {
  applyHardFilters,
  canonicalQueueResumeFamily,
  criteriaForQueueSelection,
  careerBlockerDraftsForApplication,
  careerBlockerKey,
  decidePursuit,
  verifyPreparedApplication,
  type HardFilterResult,
} from "../domain/policies";
import { assertCampaignTransition } from "../domain/campaignLifecycle";
import { createApplicationService, type ApplicationService } from "./applicationService";
import type { DurableSubmissionAuthority } from "../../automation/executionHost/submissionAuthority";
import { attentionCategoryForEvent, isAttentionWorthyEvent } from "../domain/notifications";
import { isVerifiedOfficialEmployerCandidate, type ApplicationDestinationResolver, type DestinationCandidate, type DestinationResolutionRunResult } from "../domain/applicationDestinationResolver";
import {
  attentionDescriptorSignature,
  attentionEventForConfiguration,
  attentionEventForCareerBlocker,
  isAttentionResponse,
  publicAttentionEvent,
  questionProvenanceForBlocker,
  type AttentionClosureReason,
  type AttentionEvent,
  type AttentionResponse,
  type NotificationAdapter,
  type PersistedAttentionEvent,
} from "../domain/attention";
import type { ApplicationAnswerDraftGenerator } from "../domain/applicationAnswerDraft";
import {
  EXECUTION_RUN_HISTORY_LIMIT,
  ExecutionTraceBuilder,
  executionFailureReason,
  monotonicNow,
  type HumanAttentionCategory,
} from "../domain/executionTrace";
import type {
  AnswerValue,
  Application,
  CandidateProfile,
  FitAssessment,
  JobIntakeInput,
  JobPosting,
  ResumeFamilyId,
} from "../domain/types";
import type { ExecutionHostSnapshot } from "../domain/executionHostTypes";
import type {
  ApplicationPolicy,
  CareerBlocker,
  CareerBlockerDraft,
  CareerExecutionState,
  CareerEvent,
  CareerEventType,
  CareerJob,
  CareerJobStatus,
  Campaign,
  CampaignCounts,
  CampaignRunResult,
  DestinationResolution,
  CampaignSnapshot,
  CreateCampaignInput,
  DiscoverySourceSummary,
  DiscoverySummary,
  FitPolicy,
  JobSourceConfig,
  JobSourceObservation,
  PursuitDecision,
  ReviewConditions,
  SearchCriteria,
  StopConditions,
  SubmissionAuthority,
  SubmissionPolicy,
} from "../domain/campaignTypes";
import { CURATED_JOB_SOURCE_ID, jobSourceConfigId } from "../domain/campaignTypes";
import { parseDailyHuntMessage, type DailyHuntParseResult } from "../domain/dailyHuntIntake";
import {
  isVerifiedGreenhouseApplicationUrl,
  isVerifiedGreenhouseHostedUrl,
} from "../domain/greenhouseJobSource";
import { enrichAshbyJobIntake } from "../domain/ashbyJobSource";
import { getDefaultCareerRepository, type CareerRepository } from "../persistence/careerRepository";
import type { ApplicationExecutor, ExecutionInspection } from "../domain/executor";
import { UnavailableApplicationExecutor, type ApplicationExecutionRequest, type ApplicationExecutorResult } from "../domain/executor";
import { JobScout, canonicalJobUrl, jobDedupeKeys, jobKeysMatch, type ScoutedJob } from "../domain/scout";
import { normalizeJobSearchIntent, searchCriteriaFromJobSearchIntent } from "../domain/searchIntent";
import {
  UnavailableJobTracker,
  isJobTrackerResult,
  trackerSyncContextForJob,
  trackerUpdateForJob,
  type SubmissionEvidence,
  type JobTracker,
} from "../domain/tracker";
import { isAppliedEvidence, isSubmissionProof } from "../domain/validation";
import { normalizeJobPosting } from "../domain/job";
import {
  classifyJobUrl,
  isVerifiedMatlenApplicationUrl,
  isVerifiedProtagonaApplicationUrl,
  isVerifiedGustoApplicationUrl,
  isVerifiedGustoHostedUrl,
  gustoPostingId,
  isVerifiedWorkdayApplicationUrl,
  isVerifiedWorkdayHostedUrl,
  workdayPostingId,
  isVerifiedYouHiredApplicationUrl,
  matlenPostingId,
  protagonaPostingId,
  youHiredPostingId,
} from "../domain/jobUrlClassifier";
import { isVerifiedAshbyApplicationUrl, isVerifiedAshbyHostedUrl } from "../domain/jobUrlClassifier";
import { isVerifiedLeverApplicationUrl, isVerifiedLeverHostedUrl } from "../domain/leverJobSource";

let fallbackId = 0;

export interface CareerAgentServiceOptions {
  now?: () => string;
  createId?: (prefix: string) => string;
}

export interface CareerAgentDependencies {
  applicationService?: ApplicationService;
  careerRepository?: CareerRepository;
  scout?: JobScout;
  executor?: ApplicationExecutor;
  tracker?: JobTracker;
  notificationAdapter?: NotificationAdapter;
  /** Server-only availability check for the selected family's local artifact. */
  resumeArtifactAvailable?: (familyId: ResumeFamilyId) => boolean;
  /** Existing execution-host resume operation; no default submission path is added. */
  resumeAttention?: (campaignId: string, jobId: string, options?: { verificationHandoff?: boolean }) => Promise<void>;
  /** Server-side bounded destination enrichment; absent lookups remain unresolved. */
  destinationResolver?: ApplicationDestinationResolver;
  /** Server-configured official-employer candidates; never accepted from intake payloads. */
  officialDestinationCandidates?: readonly DestinationCandidate[];
  /** Optional server-only generator for reviewable answers to exact ATS free-text questions. */
  applicationAnswerDraftGenerator?: ApplicationAnswerDraftGenerator;
}

export interface LegacyAttentionRepairResult {
  inspected: number;
  eligible: number;
  replaced: number;
  skipped: number;
  newRootsPublished: number;
  deliveryMetadataPersisted: number;
}

export interface LegacyAttentionRepairOptions {
  /** Restrict a repair to one validated application job. */
  jobId?: string;
}

interface RunAccumulator {
  discovered: number;
  alreadySeen: number;
  alreadyApplied: number;
  rejected: number;
  held: number;
  prepared: number;
  applied: number;
  failures: number;
}

interface ProcessOutcome {
  applied?: boolean;
  prepared?: boolean;
  rejected?: boolean;
  held?: boolean;
  blocked?: boolean;
  failure?: boolean;
  resumeAttempt?: number;
}

interface PreparedExecutionOverride {
  result?: ApplicationExecutorResult;
  executionId?: string;
  hostStatus?: CareerExecutionState["status"];
  /** Trusted only for a host snapshot emitted by the exact manual-submit lane. */
  manualSubmission?: boolean;
}

interface CareerBlockerResolutionOptions {
  attentionResponse?: AttentionResponse;
  /** Internal batching hook for model-generated ATS answers. */
  deferResume?: boolean;
  answerEvidence?: readonly string[];
}

export type CareerAttentionResponseResult =
  | { status: "resolved"; event: AttentionEvent; careerJob: CareerJob }
  | { status: "duplicate"; event: AttentionEvent; careerJob: CareerJob };

/** A narrow, non-resuming correction for a response that was already persisted. */
export interface ResolvedCareerAnswerRevision {
  campaignId: string;
  jobId: string;
  blockerId: string;
  attentionEventId: string;
  expectedCurrentValue: string;
  replacementValue: string;
}

export interface CareerAnswerRevisionResult {
  careerJob: CareerJob;
  attentionEvent: PersistedAttentionEvent;
}

export class AttentionResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttentionResponseError";
  }
}

const DEFAULT_SEARCH_CRITERIA: SearchCriteria = {
  roleLanes: [],
  searchQueries: [],
  locations: [],
  remoteOnly: false,
  employmentTypes: [],
  excludedSeniorities: [],
  excludedCompanies: [],
};

const DEFAULT_FIT_POLICY: FitPolicy = {
  strong: "pursue",
  good: "pursue",
  stretch: "pursue",
  weak: "reject",
};

const DEFAULT_APPLICATION_POLICY: ApplicationPolicy = {
  autoPrepare: true,
  allowGroundedDrafts: false,
  approvedResumeFamilies: [],
};

const DEFAULT_SUBMISSION_POLICY: SubmissionPolicy = {
  authority: "approval_required",
  requireExplicitApproval: true,
};

const DEFAULT_REVIEW_CONDITIONS: ReviewConditions = {
  unusualTerms: true,
  authenticationRequired: true,
  unknownFacts: true,
  subjectiveAnswers: true,
};

const DEFAULT_STOP_CONDITIONS: StopConditions = {
  stopOnAcceptedOffer: true,
  systemicFailureLimit: 3,
};

const APPLICATION_CAP_HOLD_REASON = "The campaign application cap has been reached for this period.";
const STALE_PRE_SUBMIT_EXECUTION_MS = 15 * 60 * 1000;

export type StalePreSubmitHostUnavailable = "not_found" | "closed";

export function trustedQueueFitAssessment(
  fit: FitAssessment,
  queueSelected: boolean,
  queueFit: string | undefined,
  queuePriority: string | undefined,
  resumeFamily: string | undefined,
  profile: CandidateProfile,
): FitAssessment {
  const rating = queueFit?.trim().toLowerCase();
  const priority = queuePriority?.trim().toLowerCase();
  const classification = rating === "excellent" || rating === "strong" ? "strong" : rating === "good" ? "good" : undefined;
  const familyId: ResumeFamilyId | undefined = canonicalQueueResumeFamily(resumeFamily);
  const familyAvailable = !familyId || profile.resumeFamilies.some((family) => family.id === familyId);
  const acceptedPriority = !queuePriority || ["high", "medium", "low"].includes(priority ?? "");
  if (!queueSelected || !classification || !acceptedPriority || !familyAvailable) return fit;
  const postingSelectedFamily = fit.recommendedResumeFamily;
  const postingSelectionIsGrounded = !/first configured family because the posting has no matching family focus signal/i.test(
    fit.resumeFamilyReason,
  );
  // The sheet's resume column is useful as a hint, but a grounded posting
  // signal wins when the row is stale or was copied from another role. This
  // keeps resume choice tied to the job description rather than queue order.
  if (familyId && familyId !== postingSelectedFamily && postingSelectionIsGrounded) {
    return {
      ...fit,
      methodology: `${fit.methodology} Queue resume hint ${familyId} was not used because the posting selected ${postingSelectedFamily} from its description signals.`,
    };
  }
  const familySelection = familyId
    ? {
        recommendedResumeFamily: familyId,
        resumeFamilyReason: `Explicit queue-selected ${familyId} resume family was verified in the candidate profile.`,
      }
    : {};
  // Queue fit metadata can authorize the narrow Agentic-AI title aliases, but
  // it must not upgrade the deterministic classification for the other resume
  // lanes. Their explicit queue selection only chooses the resume artifact.
  if (familyId !== "ai-platform-agentic") {
    return {
      ...fit,
      ...familySelection,
      methodology: `${fit.methodology} Trusted queue resume metadata accepted: family=${familyId ?? "unspecified"}.`,
    };
  }
  return {
    ...fit,
    classification,
    ...familySelection,
    applicationRecommendation: "proceed",
    methodology: `${fit.methodology} Trusted queue metadata accepted: fit=${rating}; priority=${priority ?? "unspecified"}.`,
  };
}

export type CareerReadinessFailureReason = "missing_resume_family" | "missing_resume_artifact";

export type CareerReadinessResult =
  | { ok: true }
  | {
      ok: false;
      reasonCode: CareerReadinessFailureReason;
      failureReason: "provider_configuration";
      attentionCategory: "provider_configuration";
    };

/**
 * Checks only prerequisites already enforced by downstream Career Agent code.
 * The result is typed so a blocked campaign does not become an opaque fit
 * failure for every discovered job.
 */
export function validateCareerAgentReadiness(
  profile: Pick<CandidateProfile, "resumeFamilies">,
  resumeArtifactAvailable?: (familyId: ResumeFamilyId) => boolean,
): CareerReadinessResult {
  if (profile.resumeFamilies.length === 0) {
    return {
      ok: false,
      reasonCode: "missing_resume_family",
      failureReason: "provider_configuration",
      attentionCategory: "provider_configuration",
    };
  }
  if (resumeArtifactAvailable && !profile.resumeFamilies.some((family) => resumeArtifactAvailable(family.id))) {
    return {
      ok: false,
      reasonCode: "missing_resume_artifact",
      failureReason: "provider_configuration",
      attentionCategory: "provider_configuration",
    };
  }
  return { ok: true };
}

function defaultNow(): string {
  return new Date().toISOString();
}

function defaultCreateId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  fallbackId += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackId}`;
}

function cleanString(value: string | undefined, label: string): string {
  const cleaned = value?.trim() ?? "";
  if (!cleaned) {
    throw new Error(`${label} is required.`);
  }
  return cleaned;
}

function cleanList(value: readonly string[] | undefined): readonly string[] {
  return [...new Set((value ?? []).map((item) => item.trim()).filter(Boolean))];
}

function normalizeSourceConfigs(value: readonly JobSourceConfig[] | undefined): readonly JobSourceConfig[] | undefined {
  if (value === undefined) return undefined;
  return value.map((config) => {
    if (!config || typeof config !== "object") throw new Error("Job source configuration is invalid.");
    if (config.type === "lever") {
      if (typeof config.site !== "string") throw new Error("Lever source site is required.");
      const site = config.site.trim();
      if (!site) throw new Error("Lever source site is required.");
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(site)) {
        throw new Error("Lever source site must be a simple public SITE identifier.");
      }
      if (config.id !== undefined && typeof config.id !== "string") {
        throw new Error("Lever source id must be a string.");
      }
      const id = config.id?.trim();
      return { type: "lever", site, ...(id ? { id } : {}) };
    }
    if (config.type === "greenhouse") {
      if (typeof config.board !== "string") throw new Error("Greenhouse board is required.");
      const board = config.board.trim();
      if (!board) throw new Error("Greenhouse board is required.");
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(board)) {
        throw new Error("Greenhouse board must be a simple public board token.");
      }
      if (config.company !== undefined && typeof config.company !== "string") {
        throw new Error("Greenhouse company must be a string when provided.");
      }
      if (config.id !== undefined && typeof config.id !== "string") {
        throw new Error("Greenhouse source id must be a string.");
      }
      const company = config.company?.trim();
      const id = config.id?.trim();
      return {
        type: "greenhouse",
        board,
        ...(company ? { company } : {}),
        ...(id ? { id } : {}),
      };
    }
    if (config.type !== "remotive" && config.type !== "himalayas" && config.type !== "brave_search" && config.type !== "demo") {
      throw new Error("Job source configuration type is invalid.");
    }
    if (config.id !== undefined && typeof config.id !== "string") {
      throw new Error("Job source id must be a string.");
    }
    const id = config.id?.trim();
    return { type: config.type, ...(id ? { id } : {}) };
  });
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function optionalPositiveInteger(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  return positiveInteger(value, 1, label);
}

function isPursuitDecision(value: unknown): value is PursuitDecision {
  return value === "pursue" || value === "hold" || value === "reject";
}

function isSubmissionAuthority(value: unknown): value is SubmissionAuthority {
  return value === "never" || value === "approval_required" || value === "simulated" || value === "automatic";
}

function sameUtcDay(left: string, right: string): boolean {
  return left.slice(0, 10) === right.slice(0, 10);
}

function sameUtcWeek(left: string, right: string): boolean {
  const leftDate = new Date(left);
  const rightDate = new Date(right);
  if (Number.isNaN(leftDate.getTime()) || Number.isNaN(rightDate.getTime())) return false;
  const startOfWeek = (date: Date): number => {
    const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = copy.getUTCDay();
    copy.setUTCDate(copy.getUTCDate() - day);
    return copy.getTime();
  };
  return startOfWeek(leftDate) === startOfWeek(rightDate);
}

function emptyAccumulator(): RunAccumulator {
  return {
    discovered: 0,
    alreadySeen: 0,
    alreadyApplied: 0,
    rejected: 0,
    held: 0,
    prepared: 0,
    applied: 0,
    failures: 0,
  };
}

function isApplicationApplied(application: Application | null): boolean {
  return application?.status === "applied" && isAppliedEvidence(application.submissionProof ?? application.manualSubmissionConfirmation);
}

function answerIsMeaningful(value: AnswerValue): boolean {
  return typeof value !== "string" || value.trim().length > 0;
}

function isDraftApprovalCommand(value: string): boolean {
  return /^(?:approve|approved|use\s+draft)$/i.test(value.trim());
}

function isDraftRejectionCommand(value: string): boolean {
  return /^(?:reject|discard|cancel)\s*(?:draft)?$/i.test(value.trim());
}

function jobNeedsAttention(job: CareerJob): boolean {
  return (
    job.blockers.some((blocker) => blocker.status === "open") ||
    job.status === "held" ||
    job.status === "ready_to_submit" ||
    job.status === "failed" ||
    job.trackerSync?.status === "pending" ||
    Boolean(job.trackerFailureReason)
  );
}

function metadataFrom(entries: readonly [string, string][]): Readonly<Record<string, string>> {
  return Object.fromEntries(entries);
}

function isCareerBlockerDraft(value: unknown): value is CareerBlockerDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const kinds = new Set([
    "salary",
    "sponsorship",
    "relocation",
    "travel",
    "legal_attestation",
    "demographic_disclosure",
    "unknown_fact",
    "subjective_answer",
    "external_login",
    "captcha",
    "external_verification",
    "unknown_form_field",
    "unsupported_widget",
    "resume_missing",
    "required_file_missing",
    "submission_approval",
    "other",
  ]);
  const units = new Set(["application_preparation", "submission", "external"]);
  return (
    kinds.has(candidate.kind as string) &&
    units.has(candidate.unit as string) &&
    (candidate.field === undefined || (typeof candidate.field === "string" && candidate.field.trim().length > 0)) &&
    (candidate.questionProvenance === undefined ||
      candidate.questionProvenance === "ATS_FORM" ||
      candidate.questionProvenance === "APPLICATION_PREPARATION" ||
      candidate.questionProvenance === "POLICY" ||
      candidate.questionProvenance === "CONFIGURATION" ||
      candidate.questionProvenance === "UNKNOWN") &&
    typeof candidate.question === "string" &&
    candidate.question.trim().length > 0 &&
    typeof candidate.reason === "string" &&
    candidate.reason.trim().length > 0 &&
    Array.isArray(candidate.evidence) &&
    candidate.evidence.every((item) => typeof item === "string") &&
    (candidate.resumeAfterHuman === undefined || typeof candidate.resumeAfterHuman === "boolean")
  );
}

function humanAttentionCategoryForBlocker(
  blocker: { kind?: CareerBlockerDraft["kind"]; field?: string } | undefined,
): HumanAttentionCategory {
  const kind = blocker?.kind ?? blocker?.field?.toLowerCase();
  switch (kind) {
    case "captcha":
      return "captcha";
    case "external_login":
      return "login";
    case "external_verification":
      return "mfa";
    case "subjective_answer":
      return "subjective_answer";
    case "resume_missing":
    case "required_file_missing":
      return "resume_artifact_missing";
    case "unknown_form_field":
    case "unsupported_widget":
      return "unsupported_field";
    case "submission_approval":
      return "manual_submission";
    case "why_company":
    case "cover_letter":
      return "subjective_answer";
    default:
      return "candidate_fact_missing";
  }
}

function careerExecutionState(
  inspection: ExecutionInspection,
  status: CareerExecutionState["status"],
  updatedAt: string,
  metadata: Pick<CareerExecutionState, "mode" | "hostExecutionId"> = {},
): CareerExecutionState {
  return {
    status,
    ...(metadata.mode ? { mode: metadata.mode } : {}),
    ...(metadata.hostExecutionId ? { hostExecutionId: metadata.hostExecutionId } : {}),
    fieldsDetected: inspection.fields.map((field) => field.id),
    fieldsFilled: [...inspection.fieldsFilled],
    unresolvedFields: [...inspection.unresolvedFields],
    ...(inspection.resumeUsed ? { resumeUsed: inspection.resumeUsed } : {}),
    evidence: [...inspection.evidence],
    startedAt: inspection.startedAt,
    updatedAt,
  };
}

function emptyCareerExecutionState(now: string): CareerExecutionState {
  return {
    status: "not_started",
    fieldsDetected: [],
    fieldsFilled: [],
    unresolvedFields: [],
    evidence: ["submission:manual-only"],
    startedAt: now,
    updatedAt: now,
  };
}

function snapshotStatusToCareerStatus(status: ExecutionHostSnapshot["status"]): CareerExecutionState["status"] {
  return status;
}

function careerJobStatusForHostStatus(status: CareerExecutionState["status"], current: CareerJobStatus): CareerJobStatus {
  if (status === "needs_input" || status === "waiting_for_human") return "needs_input";
  if (status === "ready_to_submit") return "ready_to_submit";
  if (status === "submitted") return "submitted";
  if (status === "failed" || status === "cancelled" || status === "closed") return "failed";
  if (status === "starting" || status === "inspecting" || status === "executing" || status === "resuming") {
    return current === "applied" || current === "submitted" ? current : "preparing";
  }
  return current;
}

function executionStateFromHostSnapshot(
  snapshot: ExecutionHostSnapshot,
  previous: CareerExecutionState | undefined,
  status: CareerExecutionState["status"],
): CareerExecutionState {
  const inspection = snapshot.inspection;
  const evidence = [
    ...(previous?.evidence ?? []),
    ...(inspection?.evidence ?? []),
    "executor:lever-browser-executor",
    "execution-host:real_local",
    ...(status === "submitted" ? ["submit:confirmed", "submission:automatic"] : ["submit:not-clicked", "submission:manual-only"]),
  ];
  return {
    status,
    mode: "real_local",
    hostExecutionId: snapshot.id,
    fieldsDetected: inspection?.fields.map((field) => field.id) ?? previous?.fieldsDetected ?? [],
    fieldsFilled: inspection?.fieldsFilled ?? previous?.fieldsFilled ?? [],
    unresolvedFields: inspection?.unresolvedFields ?? previous?.unresolvedFields ?? [],
    ...(inspection?.resumeUsed ? { resumeUsed: inspection.resumeUsed } : previous?.resumeUsed ? { resumeUsed: previous.resumeUsed } : {}),
    evidence: [...new Set(evidence)],
    ...(snapshot.attempt !== undefined
      ? { attempt: snapshot.attempt }
      : previous?.attempt !== undefined
        ? { attempt: previous.attempt }
        : {}),
    ...(snapshot.retryReasonCode
      ? { retryReasonCode: snapshot.retryReasonCode }
      : previous?.retryReasonCode
        ? { retryReasonCode: previous.retryReasonCode }
        : {}),
    ...(snapshot.failureReasonCode
      ? { failureReasonCode: snapshot.failureReasonCode }
      : status === "ready_to_submit" || status === "submitted"
        ? {}
        : previous?.failureReasonCode
          ? { failureReasonCode: previous.failureReasonCode }
          : {}),
    ...(snapshot.telemetry ? { telemetry: snapshot.telemetry } : previous?.telemetry ? { telemetry: previous.telemetry } : {}),
    ...(snapshot.telemetry?.boundaries
      ? { boundaries: snapshot.telemetry.boundaries }
      : inspection?.boundaries
        ? { boundaries: inspection.boundaries }
        : previous?.boundaries
          ? { boundaries: previous.boundaries }
          : {}),
    ...(snapshot.telemetry?.navigation
      ? { navigation: snapshot.telemetry.navigation }
      : inspection?.navigation
        ? { navigation: inspection.navigation }
        : previous?.navigation
          ? { navigation: previous.navigation }
          : {}),
    ...(snapshot.telemetry?.diagnostic
      ? { diagnostic: snapshot.telemetry.diagnostic }
      : inspection?.diagnostic
        ? { diagnostic: inspection.diagnostic }
        : previous?.diagnostic
          ? { diagnostic: previous.diagnostic }
          : {}),
    startedAt: previous?.startedAt ?? snapshot.startedAt,
    updatedAt: snapshot.updatedAt,
  };
}

export class CampaignNotFoundError extends Error {
  constructor(campaignId: string) {
    super(`Campaign ${campaignId} was not found.`);
    this.name = "CampaignNotFoundError";
  }
}

export class CareerJobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`Career job ${jobId} was not found.`);
    this.name = "CareerJobNotFoundError";
  }
}

export interface DailyHuntProcessingItem {
  applicationUrl: string;
  label: string;
  status: "processed" | "skipped";
  company?: string;
  title?: string;
  jobId?: string;
  reason?: string;
}

export interface DailyHuntProcessingResult {
  parsed: DailyHuntParseResult;
  items: readonly DailyHuntProcessingItem[];
  processed: number;
  skipped: number;
}

export class CareerAgentService {
  private readonly now: () => string;
  private readonly createId: (prefix: string) => string;
  private readonly applicationService: ApplicationService;
  private readonly careerRepository: CareerRepository;
  private readonly scout: JobScout;
  private readonly executor: ApplicationExecutor;
  private readonly tracker: JobTracker;
  private readonly notificationAdapter?: NotificationAdapter;
  private readonly resumeArtifactAvailable?: (familyId: ResumeFamilyId) => boolean;
  private readonly resumeAttention?: (campaignId: string, jobId: string, options?: { verificationHandoff?: boolean }) => Promise<void>;
  private readonly destinationResolver?: ApplicationDestinationResolver;
  private readonly officialDestinationCandidates: readonly DestinationCandidate[];
  private readonly applicationAnswerDraftGenerator?: ApplicationAnswerDraftGenerator;
  private readonly attentionResponseInFlight = new Map<
    string,
    {
      selectedOption: string;
      promise: Promise<CareerAttentionResponseResult>;
    }
  >();

  constructor(
    private readonly profile: CandidateProfile,
    dependencies: CareerAgentDependencies = {},
    options: CareerAgentServiceOptions = {},
  ) {
    this.now = options.now ?? defaultNow;
    this.createId = options.createId ?? defaultCreateId;
    this.applicationService = dependencies.applicationService ?? createApplicationService(profile);
    this.careerRepository = dependencies.careerRepository ?? getDefaultCareerRepository();
    this.scout = dependencies.scout ?? new JobScout({});
    this.executor = dependencies.executor ?? new UnavailableApplicationExecutor();
    this.tracker = dependencies.tracker ?? new UnavailableJobTracker();
    this.notificationAdapter = dependencies.notificationAdapter;
    this.resumeArtifactAvailable = dependencies.resumeArtifactAvailable;
    this.resumeAttention = dependencies.resumeAttention;
    this.destinationResolver = dependencies.destinationResolver;
    this.officialDestinationCandidates = dependencies.officialDestinationCandidates ?? [];
    this.applicationAnswerDraftGenerator = dependencies.applicationAnswerDraftGenerator;
  }

  listCampaigns(): readonly Campaign[] {
    return [...this.careerRepository.listCampaigns()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  getCampaign(campaignId: string): Campaign {
    const campaign = this.careerRepository.getCampaign(campaignId);
    if (!campaign) throw new CampaignNotFoundError(campaignId);
    return campaign;
  }

  listJobs(campaignId?: string): readonly CareerJob[] {
    return [...this.careerRepository.listJobs(campaignId)].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  getJob(jobId: string): CareerJob {
    const job = this.careerRepository.getJob(jobId);
    if (!job) throw new CareerJobNotFoundError(jobId);
    return job;
  }

  getApplication(applicationId: string): Application {
    return this.applicationService.getApplication(applicationId);
  }

  deferGenericPreparationBlockersForInspection(applicationId: string): Application {
    return this.applicationService.deferGenericPreparationBlockersForInspection(applicationId);
  }

  /** Atomically defer generic preparation placeholders on both durable layers. */
  deferGenericPreparationBlockersForQueueInspection(campaignId: string, jobId: string): CareerJob {
    const campaign = this.getCampaign(campaignId);
    const job = this.getJob(jobId);
    if (job.campaignId !== campaign.id || !job.applicationId) return job;
    const application = this.applicationService.getApplication(job.applicationId);
    if (application.status === "needs_input") this.applicationService.deferGenericPreparationBlockersForInspection(application.id);
    const genericFields = new Set(["salary_expectations", "relocation", "travel", "demographic_disclosure", "legal_attestations"]);
    const blockers = job.blockers.filter((blocker) => blocker.status !== "open" || !genericFields.has(blocker.field ?? ""));
    const updated = this.saveJob({
      ...job,
      status: blockers.some((blocker) => blocker.status === "open") ? "needs_input" : "preparing",
      blockers,
      decisionReason: undefined,
      updatedAt: this.now(),
    });
    const now = this.now();
    const genericBlockerIds = new Set(job.blockers.filter((blocker) => genericFields.has(blocker.field ?? "")).map((blocker) => blocker.id));
    const cancelled = (campaign.attentionEvents ?? []).filter((event) => event.status === "open" && event.jobId === job.id && Boolean(event.blockerId && genericBlockerIds.has(event.blockerId)));
    if (cancelled.length) this.careerRepository.saveCampaign({ ...campaign, attentionEvents: (campaign.attentionEvents ?? []).map((event) => cancelled.some((candidate) => candidate.id === event.id) ? { ...event, status: "cancelled" as const, resolvedAt: now } : event), updatedAt: now });
    return updated;
  }

  /**
   * Attempts destination enrichment only for policy-pursued strong/good jobs
   * that are not already actionable. It never changes fit or pursuit state.
   */
  async resolveDestinations(campaignId: string, jobIds?: readonly string[]): Promise<DestinationResolutionRunResult> {
    this.getCampaign(campaignId);
    if (!this.destinationResolver) {
      return {
        inspected: 0,
        resolved: 0,
        unresolved: 0,
        ambiguous: 0,
        skipped: 0,
        jobs: [],
      };
    }
    const selectedJobIds = jobIds ? new Set(jobIds) : undefined;
    const eligible = this.listJobs(campaignId).filter(
      (job) =>
        (!selectedJobIds || selectedJobIds.has(job.id)) &&
        Boolean(job.fit && (job.fit.classification === "strong" || job.fit.classification === "good")) &&
        ["pursuing", "preparing", "needs_input", "ready_to_submit"].includes(job.status) &&
        job.actionability !== "actionable" &&
        job.destinationResolution?.status !== "resolved",
    );
    const results: Array<DestinationResolutionRunResult["jobs"][number]> = [];
    let resolved = 0;
    let unresolved = 0;
    let ambiguous = 0;
    let skipped = 0;
    for (const job of eligible) {
      try {
        const updated = await this.resolveDestinationForJob(job);
        const resolution = updated.destinationResolution;
        if (!resolution) {
          skipped += 1;
          continue;
        }
        if (resolution.status === "resolved") resolved += 1;
        else if (resolution.status === "ambiguous") ambiguous += 1;
        else unresolved += 1;
        results.push({
          jobId: job.id,
          company: job.job.company,
          role: job.job.title,
          resolution,
        });
      } catch {
        skipped += 1;
      }
    }
    return {
      inspected: eligible.length,
      resolved,
      unresolved,
      ambiguous,
      skipped,
      jobs: results,
    };
  }

  /**
   * Process one user-selected public posting through the same campaign path as
   * discovered work. This is intentionally bounded to verified Lever,
   * Rippling, Ashby, or a narrowly verified direct custom route so a
   * daily-hunt link can be evaluated without adding a crawler or mutating the
   * campaign's search intent.
   */
  async processCuratedJob(campaignId: string, input: JobIntakeInput): Promise<CareerJob> {
    const campaign = this.getCampaign(campaignId);
    if (campaign.status !== "active") throw new Error("Start the campaign before evaluating a selected posting.");

    const normalizedPosting = normalizeJobPosting(await enrichAshbyJobIntake(input), this.now());
    if (!normalizedPosting.sourceUrl || !normalizedPosting.applicationUrl) {
      throw new Error("A selected posting needs both its public source URL and application URL.");
    }
    const classification = classifyJobUrl(normalizedPosting.applicationUrl);
    const applicationUrl = classification.canonicalUrl;
    const officialCandidate = this.officialDestinationCandidates.find((candidate) =>
      isVerifiedOfficialEmployerCandidate(candidate, {
        company: normalizedPosting.company,
        role: normalizedPosting.title,
        applicationUrl: applicationUrl ?? "",
        knownListingUrl: normalizedPosting.sourceUrl,
      }),
    );
    const isYouHired = classification.kind === "custom" && isVerifiedYouHiredApplicationUrl(applicationUrl);
    const isMatlen = classification.kind === "custom" && isVerifiedMatlenApplicationUrl(applicationUrl);
    const isProtagona = classification.kind === "custom" && isVerifiedProtagonaApplicationUrl(applicationUrl);
    const isGusto = classification.kind === "custom" && isVerifiedGustoApplicationUrl(applicationUrl);
    const isGreenhouse = classification.kind === "greenhouse" &&
      Boolean(classification.siteIdentifier) &&
      Boolean(classification.postingIdentifier) &&
      isVerifiedGreenhouseApplicationUrl(applicationUrl, classification.siteIdentifier!, classification.postingIdentifier!);
    const isWorkday = classification.kind === "workday" && isVerifiedWorkdayApplicationUrl(applicationUrl, classification.siteIdentifier);
    if (!applicationUrl) {
      throw new Error("The selected posting needs a valid application URL.");
    }
    if (isYouHired) {
      if (!youHiredPostingId(applicationUrl)) {
        throw new Error("The selected YouHired application URL is missing its verified job identity.");
      }
    } else if (isMatlen) {
      if (!matlenPostingId(applicationUrl)) {
        throw new Error("The selected Matlen Silver application URL is missing its verified job identity.");
      }
    } else if (isProtagona) {
      if (!protagonaPostingId(applicationUrl)) {
        throw new Error("The selected Protagona application URL is missing its verified job identity.");
      }
    } else if (isGusto) {
      if (!gustoPostingId(applicationUrl)) {
        throw new Error("The selected Gusto application URL is missing its verified job identity.");
      }
    } else if (isWorkday) {
      if (!classification.siteIdentifier || !workdayPostingId(applicationUrl)) {
        throw new Error("The selected Workday application URL is missing its verified job identity.");
      }
    } else if (isGreenhouse) {
      // Greenhouse-hosted job pages are also the public application form. The
      // board token and numeric posting ID must be identical across both URLs.
      if (!classification.siteIdentifier || !classification.postingIdentifier) {
        throw new Error("The selected Greenhouse application URL is missing its verified job identity.");
      }
    } else if (!classification.siteIdentifier || !classification.postingIdentifier ||
      !["rippling", "lever", "ashby"].includes(classification.kind)) {
      if (!officialCandidate) {
        throw new Error("The selected direct application requires verified official-employer evidence; supported destinations are verified Lever, Rippling, Ashby, Workday, YouHired, Matlen Silver, Protagona, or the selected Gusto route.");
      }
    }

    const sourceUrl = canonicalJobUrl(normalizedPosting.sourceUrl);
    if (!sourceUrl) throw new Error("A selected posting needs a valid posting/source URL.");
    if (
      classification.kind === "lever" &&
      (!isVerifiedLeverHostedUrl(sourceUrl, classification.siteIdentifier!, classification.postingIdentifier!) ||
        !isVerifiedLeverApplicationUrl(applicationUrl, classification.siteIdentifier!, classification.postingIdentifier!))
    ) {
      throw new Error("The selected Lever posting and application URLs do not match the same verified posting.");
    }
    if (
      classification.kind === "ashby" &&
      (!isVerifiedAshbyHostedUrl(sourceUrl, classification.siteIdentifier!, classification.postingIdentifier!) ||
        !isVerifiedAshbyApplicationUrl(applicationUrl, classification.siteIdentifier!, classification.postingIdentifier!))
    ) {
      throw new Error("The selected Ashby posting and application URLs do not match the same verified posting.");
    }
    if (isGreenhouse && (!isVerifiedGreenhouseHostedUrl(sourceUrl, classification.siteIdentifier!, classification.postingIdentifier!) ||
      !isVerifiedGreenhouseApplicationUrl(applicationUrl, classification.siteIdentifier!, classification.postingIdentifier!))) {
      throw new Error("The selected Greenhouse posting and application URLs do not match the same verified posting.");
    }
    if (isYouHired && (sourceUrl !== applicationUrl || youHiredPostingId(applicationUrl) === undefined)) {
      throw new Error("The selected YouHired posting must retain the same verified job URL as its application destination.");
    }
    if (isMatlen && (sourceUrl !== applicationUrl || matlenPostingId(applicationUrl) === undefined)) {
      throw new Error("The selected Matlen Silver posting must retain the same verified job URL as its application destination.");
    }
    if (isProtagona && (sourceUrl !== applicationUrl || protagonaPostingId(applicationUrl) === undefined)) {
      throw new Error("The selected Protagona posting must retain the same verified job URL as its application destination.");
    }
    if (isGusto && (!isVerifiedGustoHostedUrl(sourceUrl) || gustoPostingId(sourceUrl) !== gustoPostingId(applicationUrl))) {
      throw new Error("The selected Gusto posting and application URLs do not match the same verified posting.");
    }
    if (isWorkday && (!isVerifiedWorkdayHostedUrl(sourceUrl, classification.siteIdentifier) ||
      workdayPostingId(sourceUrl) !== workdayPostingId(applicationUrl))) {
      throw new Error("The selected Workday posting and application URLs do not match the same verified posting.");
    }

    const job: JobPosting = {
      ...normalizedPosting,
      sourceUrl,
      applicationUrl,
      ats: classification.kind === "lever" ? "Lever" : classification.kind === "ashby" ? "Ashby" : classification.kind === "rippling" ? "Rippling" : classification.kind === "workday" ? "Workday" : classification.kind === "greenhouse" ? "Greenhouse" : "Custom",
    };
    const sourceRecordId =
      classification.kind === "lever"
        ? classification.postingIdentifier
        : classification.kind === "rippling" || classification.kind === "ashby"
          ? `${classification.siteIdentifier}:${classification.postingIdentifier}`
          : isYouHired
            ? `youhired:${youHiredPostingId(applicationUrl)}`
            : isMatlen
              ? `matlensilver:${matlenPostingId(applicationUrl)}`
              : isProtagona
                ? `protagona:${protagonaPostingId(applicationUrl)}`
                  : isWorkday
                  ? `workday:${workdayPostingId(applicationUrl)}`
                  : isGreenhouse
                    ? `greenhouse:${classification.siteIdentifier}:${classification.postingIdentifier}`
                    : officialCandidate
                      ? `official:${applicationUrl}`
                      : `gusto:${gustoPostingId(applicationUrl)}`;
    const discoveredAt = this.now();
    const sourceId = CURATED_JOB_SOURCE_ID;
    const sourceMode = "live" as const;
    const actionability = "actionable" as const;
    const scouted: ScoutedJob = {
      sourceId,
      sourceMode,
      actionability,
      sourceRecordId,
      isExample: false,
      job,
      discoveredAt,
      fingerprint: `source:${sourceId}:id:${sourceRecordId}`,
      dedupeKeys: jobDedupeKeys(job, sourceRecordId, sourceId),
      sourceObservations: [
        {
          sourceId,
          mode: sourceMode,
          actionability,
          sourceRecordId,
          ...(job.sourceUrl ? { sourceUrl: job.sourceUrl } : {}),
          ...(job.applicationUrl ? { applicationUrl: job.applicationUrl } : {}),
          observedAt: discoveredAt,
        },
      ],
      queueSelected: Boolean(input.queueSelected),
      ...(input.resumeFamily ? { queueResumeFamily: input.resumeFamily } : {}),
      ...(input.queueFit ? { queueFit: input.queueFit } : {}),
      ...(input.queuePriority ? { queuePriority: input.queuePriority } : {}),
    };
    const destinationResolution: DestinationResolution = {
      status: "resolved",
      attemptedAt: discoveredAt,
      destinationUrl: job.applicationUrl,
      ats: classification.kind === "lever" ? "Lever" : classification.kind === "ashby" ? "Ashby" : classification.kind === "rippling" ? "Rippling" : classification.kind === "workday" ? "Workday" : classification.kind === "greenhouse" ? "Greenhouse" : "Custom",
      actionable: true,
      provenance: officialCandidate ? "official_employer_evidence" : "recognized_ats_evidence",
      evidence: officialCandidate
        ? ["curated:official-employer-evidence", ...officialCandidate.evidence]
        : ["curated:explicit-public-posting", ...classification.evidence],
    };
    const existing = this.findExistingJob(scouted);
    if (existing) {
      const merged = this.mergeScoutedRecord(existing, scouted);
      const updated = this.saveJob({
        ...merged,
        destinationResolution,
        updatedAt: this.now(),
      });
      // A prior curated run may have persisted fit/pursuit before the
      // actionable posting reached preparation. Resume that incomplete
      // selection through the normal preparation path instead of leaving it
      // permanently stuck at `pursuing`.
      if (updated.status === "pursuing" && !updated.applicationId && updated.actionability === "actionable") {
        const outcome = await this.prepareAndMaybeExecute(campaign, {
          ...updated,
          status: "preparing",
          applicationStartedAt: updated.applicationStartedAt ?? this.now(),
          updatedAt: this.now(),
        });
      if (outcome.careerJob) {
          return this.saveJob({
            ...outcome.careerJob,
            destinationResolution,
            updatedAt: this.now(),
          });
        }
      }
      // Curated intake is an explicit re-selection of a public posting. If a
      // prior intake rejected that same posting before a profile/policy fact
      // was corrected, re-evaluate it under the current durable inputs rather
      // than allowing history dedupe to make the old decision permanent. The
      // existing job identity and source provenance remain unchanged.
      if ((updated.status === "rejected" || updated.status === "held") && !updated.applicationId && updated.sourceId === CURATED_JOB_SOURCE_ID) {
        return this.reconsiderRejectedCuratedJob(campaign, updated, destinationResolution, Boolean(input.queueSelected), input.resumeFamily, input.queueFit, input.queuePriority);
      }
      // A queue-selected retry may recover the same packet after a browser
      // failure that occurred before submission. Never reopen a failed packet
      // when there is any durable proof or ambiguous post-click evidence.
      if (input.queueSelected && updated.applicationId &&
        updated.sourceId === CURATED_JOB_SOURCE_ID && updated.execution?.status === "failed") {
        const application = this.applicationService.getApplication(updated.applicationId);
        const ambiguousPostClick = updated.blockers.some((blocker) =>
          blocker.status === "open" && blocker.kind === "external_verification" &&
          blocker.unit === "submission" && blocker.resumeAfterHuman === false,
        ) || (updated.execution.evidence ?? []).some((evidence) => /submit:(?:clicked|unknown)/i.test(evidence));
        if ((updated.status === "failed" || updated.status === "preparing") &&
          (application.status === "failed" || application.status === "ready_for_review") &&
          !updated.submissionProof && !updated.manualSubmissionConfirmation &&
          !application.submissionProof && !application.manualSubmissionConfirmation && !ambiguousPostClick) {
          // A field-fill failure can occur before the executor emits its
          // final submit:not-clicked marker. The absence of clicked/unknown
          // evidence is the stronger duplicate-safety condition here.
          return this.recoverFailedApplicationForExecution(campaign.id, updated.id);
        }
      }
      return updated;
    }

    await this.processScoutedJob(campaign, scouted);
    const created = this.listJobs(campaignId).find(
      (candidate) => candidate.sourceId === sourceId && candidate.sourceRecordId === sourceRecordId,
    );
    if (!created) throw new Error("The selected posting was not persisted by the campaign service.");

    return this.saveJob({
      ...created,
      destinationResolution,
      updatedAt: this.now(),
    });
  }

  /**
   * Process one bounded daily-hunt report through the existing selected-posting
   * path. Only explicit Apply links are considered; incomplete or unsupported
   * links are returned as skipped items so a report cannot manufacture a
   * posting or destination.
   */
  async processDailyHuntMessage(campaignId: string, message: string): Promise<DailyHuntProcessingResult> {
    const parsed = parseDailyHuntMessage(message);
    const items: DailyHuntProcessingItem[] = [];
    for (const candidate of parsed.candidates) {
      // The generic posting normalizer can infer a company from arbitrary
      // prose. A Daily hunt report is a curated external input, so do not
      // allow a title-only heading to become durable job identity. Require an
      // explicit employer hint or a labeled public Company field first.
      if (!candidate.companyHint && !/^\s*company\s*:/im.test(candidate.input.rawText)) {
        items.push({
          applicationUrl: candidate.applicationLink.url,
          label: candidate.applicationLink.label,
          status: "skipped",
          ...(candidate.titleHint ? { title: candidate.titleHint } : {}),
          reason: "The Apply link has no unambiguous public employer name.",
        });
        continue;
      }
      try {
        const job = await this.processCuratedJob(campaignId, candidate.input);
        items.push({
          applicationUrl: candidate.applicationLink.url,
          label: candidate.applicationLink.label,
          status: "processed",
          company: job.job.company,
          title: job.job.title,
          jobId: job.id,
        });
      } catch (error) {
        items.push({
          applicationUrl: candidate.applicationLink.url,
          label: candidate.applicationLink.label,
          status: "skipped",
          ...(candidate.companyHint ? { company: candidate.companyHint } : {}),
          ...(candidate.titleHint ? { title: candidate.titleHint } : {}),
          reason: error instanceof Error ? error.message : "The selected posting could not be processed.",
        });
      }
    }
    for (const skipped of parsed.skipped) {
      items.push({
        applicationUrl: skipped.url,
        label: skipped.label,
        status: "skipped",
        reason: skipped.reason,
      });
    }
    return {
      parsed,
      items,
      processed: items.filter((item) => item.status === "processed").length,
      skipped: items.filter((item) => item.status === "skipped").length,
    };
  }

  /** Re-evaluate one held job under the current policy; fit itself is never recomputed here. */
  async pursueHeldJob(campaignId: string, jobId: string): Promise<CareerJob> {
    const campaign = this.getCampaign(campaignId);
    const job = this.getJob(jobId);
    if (job.campaignId !== campaignId) throw new Error("That job does not belong to the selected campaign.");
    if (job.status !== "held" || !job.fit) return job;
    if (applyHardFilters(job.job, campaign.searchCriteria).decision !== "pass") return job;
    if (decidePursuit(job.fit, campaign.fitPolicy).decision !== "pursue") return job;
    if (!campaign.applicationPolicy.autoPrepare || this.applicationCapReached(campaign, this.now())) return job;

    const actionable = await this.resolveDestinationForJob(job);
    if (this.destinationResolver && actionable.destinationResolution?.status !== "resolved") return actionable;
    const outcome = await this.prepareAndMaybeExecute(campaign, {
      ...actionable,
      status: "preparing",
      applicationStartedAt: this.now(),
      decisionReason: undefined,
      updatedAt: this.now(),
    });
    return outcome.careerJob ?? this.getJob(job.id);
  }

  /**
   * Permanently skips one application at the user's request. This closes the
   * career-job path and its attention records without creating a replacement
   * application or changing campaign search/fit policy.
   */
  async skipApplication(campaignId: string, jobId: string, reason = "Skipped by the user; no application was submitted."): Promise<CareerJob> {
    const campaign = this.getCampaign(campaignId);
    const job = this.getJob(jobId);
    if (job.campaignId !== campaignId) throw new Error("That job does not belong to the selected campaign.");
    if (job.status === "rejected") return job;
    if (job.status === "applied" || job.submissionProof || job.manualSubmissionConfirmation) {
      throw new Error("An applied job cannot be skipped.");
    }
    if (job.applicationId) {
      const application = this.applicationService.getApplication(job.applicationId);
      if (application.status === "applied" || application.submissionProof || application.manualSubmissionConfirmation) {
        throw new Error("An applied application cannot be skipped.");
      }
      if (application.status !== "failed") {
        this.applicationService.failApplication(application.id, reason);
      }
    }

    const now = this.now();
    const openAttention = (campaign.attentionEvents ?? []).filter(
      (event) => event.jobId === job.id && event.status === "open",
    );
    const cancelledAttention = openAttention.map((event) => ({
      ...event,
      status: "cancelled" as const,
      resolvedAt: now,
    }));
    if (cancelledAttention.length > 0) {
      const cancelledIds = new Set(cancelledAttention.map((event) => event.id));
      this.careerRepository.saveCampaign({
        ...campaign,
        attentionEvents: (campaign.attentionEvents ?? []).map((event) =>
          cancelledIds.has(event.id) ? (cancelledAttention.find((candidate) => candidate.id === event.id) ?? event) : event,
        ),
        updatedAt: now,
      });
    }
    for (const event of cancelledAttention) {
      try {
        await this.notificationAdapter?.closeAttentionEvent?.(publicAttentionEvent(event));
      } catch {
        // Durable closure is authoritative; notification cleanup is best effort.
      }
    }

    const skipped = this.saveJob({
      ...job,
      status: "rejected",
      decisionReason: reason,
      blockers: job.blockers.map((blocker) =>
        blocker.status === "open" ? { ...blocker, status: "resolved" as const, resolvedAt: now } : blocker,
      ),
      ...(job.execution && !["closed", "cancelled"].includes(job.execution.status)
        ? {
            execution: {
              ...job.execution,
              status: "closed" as const,
              evidence: [...new Set([...job.execution.evidence, "application:skipped", "submit:not-clicked", "submission:manual-only"])],
              updatedAt: now,
            },
          }
        : {}),
      updatedAt: now,
    });
    this.appendEvent(campaign.id, "job.rejected", careerEventMetadata(skipped, undefined, reason));
    return skipped;
  }

  listEvents(campaignId: string): readonly CareerEvent[] {
    return [...this.careerRepository.listEvents(campaignId)].sort(
      (left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt),
    );
  }

  listAttentionEvents(campaignId?: string): readonly AttentionEvent[] {
    return this.careerRepository
      .listCampaigns()
      .filter((campaign) => campaignId === undefined || campaign.id === campaignId)
      .flatMap((campaign) => (campaign.attentionEvents ?? []).map(publicAttentionEvent));
  }

  /** Re-delivers only durable open events that were not acknowledged by an adapter. */
  async publishPendingAttentionEvents(campaignId?: string): Promise<number> {
    const campaigns = this.careerRepository
      .listCampaigns()
      .filter((campaign) => campaignId === undefined || campaign.id === campaignId);
    for (const campaign of campaigns) await this.reconcileStaleAttentionEvents(campaign.id);
    if (!this.notificationAdapter) return 0;
    const published = this.careerRepository
      .listCampaigns()
      .filter((campaign) => campaignId === undefined || campaign.id === campaignId)
      .flatMap((campaign) => campaign.attentionEvents ?? [])
      .filter((record) => record.status === "open" && Boolean(record.publishedAt));
    for (const record of published) await this.refreshPublishedAttentionDraft(record);
    const records = this.careerRepository
      .listCampaigns()
      .filter((campaign) => campaignId === undefined || campaign.id === campaignId)
      .flatMap((campaign) => campaign.attentionEvents ?? [])
      .filter((record) => record.status === "open" && !record.publishedAt);
    let delivered = 0;
    for (const record of records) {
      // A browser can discover several unresolved controls in one inspection,
      // but the human review contract is strictly sequential: do not publish
      // the next question until the current one has been answered. Re-read
      // durable state on every iteration because delivery of the prior record
      // changes the gate while this snapshot is still in memory.
      if (record.applicationId) {
        const current = this.careerRepository
          .listCampaigns()
          .filter((campaign) => campaignId === undefined || campaign.id === campaignId)
          .flatMap((campaign) => campaign.attentionEvents ?? [])
          .some((candidate) =>
            candidate.id !== record.id &&
            candidate.applicationId === record.applicationId &&
            candidate.status === "open" &&
            Boolean(candidate.publishedAt),
          );
        if (current) continue;
      }
      if (await this.deliverAttentionRecord(record)) delivered += 1;
    }
    return delivered;
  }

  /**
   * Publish only the canonical next blocker for one job.  This is intentionally
   * narrower than the campaign-wide retry method so local recovery helpers
   * cannot turn a set of ATS questions into a batch of Slack messages.
   */
  async publishNextAttentionEvent(campaignId: string, jobId: string): Promise<void> {
    const campaign = this.getCampaign(campaignId);
    const job = this.getJob(jobId);
    if (job.campaignId !== campaignId) throw new Error("That job does not belong to the selected campaign.");
    if (job.status !== "needs_input") throw new Error("Only a needs-input job can publish an attention event.");
    await this.reconcileStaleAttentionEvents(campaignId);
    await this.publishAttentionForJob(this.getCampaign(campaignId), this.getJob(jobId));
  }

  /**
   * Reannounce one exact open, already-published attention event. This is a
   * notification recovery seam only: it never resumes the browser, changes a
   * blocker, or creates a second application question/event.
   */
  async reannounceAttentionEvent(campaignId: string, eventId: string): Promise<void> {
    const campaign = this.getCampaign(campaignId);
    const record = campaign.attentionEvents?.find((candidate) => candidate.id === eventId);
    if (!record || record.type !== "needs_input" || record.status !== "open" || !record.publishedAt || !record.question) {
      throw new Error("Only one open, already-published attention question can be reannounced.");
    }
    if (!this.notificationAdapter?.reannounceAttentionEvent) {
      throw new Error("The configured notification adapter cannot reannounce attention events.");
    }
    const providerDelivery = await this.notificationAdapter.reannounceAttentionEvent(publicAttentionEvent(record));
    if (!providerDelivery) throw new Error("The notification adapter did not return a Slack delivery correlation.");
    const current = this.getCampaign(campaignId);
    this.careerRepository.saveCampaign({
      ...current,
      attentionEvents: (current.attentionEvents ?? []).map((candidate) =>
        candidate.id === eventId
          ? { ...candidate, providerDelivery, publishedAt: this.now() }
          : candidate,
      ),
      updatedAt: this.now(),
    });
  }

  /**
   * Recover a sequential review whose persisted Slack root belongs to stale
   * history. The old event remains auditable and its replies are no longer
   * actionable; the current blocker is republished as a fresh top-level root.
   */
  async restartAttentionReview(campaignId: string, jobId: string): Promise<void> {
    const campaign = this.getCampaign(campaignId);
    const job = this.getJob(jobId);
    if (job.campaignId !== campaignId) throw new Error("That job does not belong to the selected campaign.");
    if (job.status !== "needs_input") throw new Error("Only a needs-input job can restart an attention review.");
    const current = this.getCampaign(campaignId);
    const openEvents = (current.attentionEvents ?? []).filter(
      (event) => event.jobId === jobId && event.status === "open" && event.type === "needs_input",
    );
    if (openEvents.length > 0) {
      this.careerRepository.saveCampaign({
        ...current,
        attentionEvents: (current.attentionEvents ?? []).map((event) =>
          openEvents.some((candidate) => candidate.id === event.id)
            ? { ...event, status: "cancelled" as const, resolvedAt: this.now() }
            : event,
        ),
        updatedAt: this.now(),
      });
    }
    if (job.applicationId) this.notificationAdapter?.startFreshApplicationReview?.(job.applicationId);
    await this.publishAttentionForJob(this.getCampaign(campaignId), this.getJob(jobId));
  }

  /**
   * Replaces attention records written by older runtimes that claimed delivery
   * without retaining a provider correlation, including Slack roots that were
   * published without an application-thread correlation. Only the canonical
   * current application blocker may be carried forward; the old record remains
   * in campaign history for auditability.
   */
  async repairLegacyAttentionEvents(
    campaignId?: string,
    options: LegacyAttentionRepairOptions = {},
  ): Promise<LegacyAttentionRepairResult> {
    const candidates = this.careerRepository
      .listCampaigns()
      .filter((campaign) => campaignId === undefined || campaign.id === campaignId)
      .flatMap((campaign) =>
        (campaign.attentionEvents ?? []).filter((event) => {
          const hasCanonicalThread = (campaign.attentionEvents ?? []).some(
            (candidate) =>
              candidate.id !== event.id &&
              candidate.applicationId === event.applicationId &&
              candidate.providerDelivery?.provider === "slack" &&
              Boolean(candidate.providerDelivery.threadTs),
          );
          return (
            event.type === "needs_input" &&
            event.status === "open" &&
            Boolean(event.publishedAt) &&
            (options.jobId === undefined || event.jobId === options.jobId) &&
            (!event.providerDelivery ||
              (event.providerDelivery.provider === "slack" &&
                !event.providerDelivery.threadTs &&
                (hasCanonicalThread || event.jobId === options.jobId)))
          );
        }),
      );
    const result: LegacyAttentionRepairResult = {
      inspected: 0,
      eligible: 0,
      replaced: 0,
      skipped: 0,
      newRootsPublished: 0,
      deliveryMetadataPersisted: 0,
    };

    for (const legacy of candidates) {
      result.inspected += 1;
      const campaign = this.careerRepository.getCampaign(legacy.campaignId);
      if (!campaign) {
        result.skipped += 1;
        continue;
      }
      const current = campaign.attentionEvents?.find((event) => event.id === legacy.id);
      const hasCanonicalThread = (campaign.attentionEvents ?? []).some(
        (candidate) =>
          candidate.id !== current?.id &&
          candidate.applicationId === current?.applicationId &&
          candidate.providerDelivery?.provider === "slack" &&
          Boolean(candidate.providerDelivery.threadTs),
      );
      if (
        !current ||
        current.status !== "open" ||
        (current.providerDelivery &&
          !(current.providerDelivery.provider === "slack" &&
            !current.providerDelivery.threadTs &&
            (hasCanonicalThread || current.jobId === options.jobId)))
      ) {
        result.skipped += 1;
        continue;
      }

      const newer = (campaign.attentionEvents ?? []).find(
        (event) =>
          event.id !== current.id &&
          event.type === "needs_input" &&
          event.status === "open" &&
          event.applicationId === current.applicationId,
      );
      if (newer) {
        const cancelled: PersistedAttentionEvent = {
          ...current,
          status: "cancelled",
          resolvedAt: this.now(),
          closureReason: "legacy_unreplyable_superseded",
          replacementEventId: newer.id,
        };
        this.careerRepository.saveCampaign({
          ...campaign,
          attentionEvents: (campaign.attentionEvents ?? []).map((event) => (event.id === current.id ? cancelled : event)),
          updatedAt: this.now(),
        });
        result.skipped += 1;
        continue;
      }

      if (!current.applicationId || !current.jobId || !current.blockerId) {
        result.skipped += 1;
        continue;
      }
      const job = this.careerRepository.getJob(current.jobId);
      if (!job || job.campaignId !== campaign.id || job.applicationId !== current.applicationId) {
        result.skipped += 1;
        continue;
      }
      let application: Application;
      try {
        application = this.applicationService.getApplication(current.applicationId);
      } catch {
        result.skipped += 1;
        continue;
      }
      const blocker = job.blockers.find(
        (candidate) =>
          candidate.id === current.blockerId &&
          candidate.status === "open" &&
          attentionDescriptorSignature(candidate, job.job.compensation) !== undefined,
      );
      const applicationBlocker = blocker
        ? application.blockers.find(
            (candidate) =>
              candidate.status === "open" &&
              (candidate.id === blocker.field || candidate.field === blocker.field || candidate.id === blocker.id),
          )
        : undefined;
      if (application.status !== "needs_input" || !blocker || !applicationBlocker) {
        result.skipped += 1;
        continue;
      }

      const generated = attentionEventForCareerBlocker({
        campaignId: campaign.id,
        jobId: job.id,
        blocker,
        postingCompensation: job.job.compensation,
        createdAt: blocker.createdAt,
        createId: this.createId,
      });
      if (!generated) {
        result.skipped += 1;
        continue;
      }

      result.eligible += 1;
      const cancelled: PersistedAttentionEvent = {
        ...current,
        status: "cancelled",
        resolvedAt: this.now(),
        closureReason: "legacy_unreplyable_replaced",
        replacementEventId: generated.record.id,
      };
      this.careerRepository.saveCampaign({
        ...campaign,
        attentionEvents: [
          ...(campaign.attentionEvents ?? []).map((event) => (event.id === current.id ? cancelled : event)),
          generated.record,
        ],
        updatedAt: this.now(),
      });
      result.replaced += 1;

      await this.deliverAttentionRecord(generated.record);
      const persistedReplacement = this.careerRepository
        .getCampaign(campaign.id)
        ?.attentionEvents?.find((event) => event.id === generated.record.id);
      const delivery = persistedReplacement?.providerDelivery;
      if (delivery?.provider === "slack") {
        result.deliveryMetadataPersisted += 1;
        if (!delivery.threadTs) result.newRootsPublished += 1;
      }
    }
    return result;
  }

  private async publishConfigurationAttention(
    campaign: Campaign,
    readiness: Extract<CareerReadinessResult, { ok: false }>,
  ): Promise<boolean> {
    const currentCampaign = this.getCampaign(campaign.id);
    const existing = currentCampaign.attentionEvents?.find(
      (event) => event.type === "configuration_required" && event.status === "open" && event.reasonCode === readiness.reasonCode,
    );
    if (existing) {
      await this.deliverAttentionRecord(existing);
      return false;
    }

    const generated = attentionEventForConfiguration({
      campaignId: campaign.id,
      createdAt: this.now(),
      createId: this.createId,
      reasonCode: readiness.reasonCode,
    });
    this.careerRepository.saveCampaign({
      ...currentCampaign,
      attentionEvents: [...(currentCampaign.attentionEvents ?? []), generated.record],
      updatedAt: this.now(),
    });
    await this.deliverAttentionRecord(generated.record);
    return true;
  }

  private async resolveConfigurationAttentionEvents(campaignId: string): Promise<void> {
    const campaign = this.getCampaign(campaignId);
    const open = (campaign.attentionEvents ?? []).filter((event) => event.type === "configuration_required" && event.status === "open");
    if (open.length === 0) return;

    const resolvedAt = this.now();
    const resolvedIds = new Set(open.map((event) => event.id));
    const updatedEvents = (campaign.attentionEvents ?? []).map((event) =>
      resolvedIds.has(event.id) ? { ...event, status: "resolved" as const, resolvedAt } : event,
    );
    this.careerRepository.saveCampaign({
      ...campaign,
      attentionEvents: updatedEvents,
      updatedAt: this.now(),
    });
    for (const event of open) {
      try {
        await this.notificationAdapter?.closeAttentionEvent?.(
          publicAttentionEvent({
            ...event,
            status: "resolved",
            resolvedAt,
          }),
        );
      } catch {
        // Resolution is durable; notification cleanup is best effort.
      }
    }
  }

  createCampaign(input: CreateCampaignInput): Campaign {
    const searchIntent = input.searchIntent ? normalizeJobSearchIntent(input.searchIntent) : undefined;
    if (
      (input.searchCriteria?.minimumSalary !== undefined &&
        (!Number.isFinite(input.searchCriteria.minimumSalary) || input.searchCriteria.minimumSalary < 0)) ||
      (searchIntent?.minimumSalary !== undefined && (!Number.isFinite(searchIntent.minimumSalary) || searchIntent.minimumSalary < 0))
    ) {
      throw new Error("Minimum salary must be a non-negative finite number.");
    }
    const searchCriteria: SearchCriteria = searchIntent
      ? searchCriteriaFromJobSearchIntent(searchIntent, cleanList(input.searchCriteria?.excludedCompanies))
      : {
          ...DEFAULT_SEARCH_CRITERIA,
          ...(input.searchCriteria?.roleLanes ? { roleLanes: cleanList(input.searchCriteria.roleLanes) } : {}),
          ...(input.searchCriteria?.searchQueries ? { searchQueries: cleanList(input.searchCriteria.searchQueries) } : {}),
          ...(input.searchCriteria?.locations ? { locations: cleanList(input.searchCriteria.locations) } : {}),
          ...(input.searchCriteria?.remoteOnly !== undefined ? { remoteOnly: input.searchCriteria.remoteOnly } : {}),
          ...(input.searchCriteria?.employmentTypes
            ? {
                employmentTypes: cleanList(input.searchCriteria.employmentTypes),
              }
            : {}),
          ...(input.searchCriteria?.minimumSalary !== undefined ? { minimumSalary: input.searchCriteria.minimumSalary } : {}),
          ...(input.searchCriteria?.excludedSeniorities
            ? {
                excludedSeniorities: cleanList(input.searchCriteria.excludedSeniorities),
              }
            : {}),
          ...(input.searchCriteria?.excludedTitleTerms
            ? {
                excludedTitleTerms: cleanList(input.searchCriteria.excludedTitleTerms),
              }
            : {}),
          ...(input.searchCriteria?.excludedCompanies
            ? {
                excludedCompanies: cleanList(input.searchCriteria.excludedCompanies),
              }
            : {}),
        };
    const sourceConfigs = normalizeSourceConfigs(input.sourceConfigs);
    const configuredSourceIds = sourceConfigs?.map(jobSourceConfigId) ?? [];
    const searchSources = cleanList(input.searchSources.length > 0 ? input.searchSources : configuredSourceIds);
    const createdAt = this.now();
    const campaign: Campaign = {
      ...(input.ownerId?.trim() ? { ownerId: input.ownerId.trim() } : {}),
      id: this.createId("campaign"),
      name: cleanString(input.name, "Campaign name"),
      goal: cleanString(input.goal, "Campaign goal"),
      status: "draft",
      ...(searchIntent ? { searchIntent } : {}),
      searchCriteria,
      searchSources,
      ...(sourceConfigs && sourceConfigs.length > 0 ? { sourceConfigs } : {}),
      fitPolicy: {
        ...DEFAULT_FIT_POLICY,
        ...(input.fitPolicy?.strong !== undefined ? { strong: input.fitPolicy.strong } : {}),
        ...(input.fitPolicy?.good !== undefined ? { good: input.fitPolicy.good } : {}),
        ...(input.fitPolicy?.stretch !== undefined ? { stretch: input.fitPolicy.stretch } : {}),
        ...(input.fitPolicy?.weak !== undefined ? { weak: input.fitPolicy.weak } : {}),
      },
      applicationPolicy: {
        ...DEFAULT_APPLICATION_POLICY,
        ...(input.applicationPolicy?.autoPrepare !== undefined ? { autoPrepare: input.applicationPolicy.autoPrepare } : {}),
        ...(input.applicationPolicy?.allowGroundedDrafts !== undefined
          ? { allowGroundedDrafts: input.applicationPolicy.allowGroundedDrafts }
          : {}),
        ...(input.applicationPolicy?.approvedResumeFamilies
          ? {
              approvedResumeFamilies: [...input.applicationPolicy.approvedResumeFamilies],
            }
          : {}),
      },
      submissionPolicy: {
        ...DEFAULT_SUBMISSION_POLICY,
        ...(input.submissionPolicy?.authority !== undefined ? { authority: input.submissionPolicy.authority } : {}),
        ...(input.submissionPolicy?.requireExplicitApproval !== undefined
          ? {
              requireExplicitApproval: input.submissionPolicy.requireExplicitApproval,
            }
          : {}),
        ...(input.submissionPolicy?.allowedAts ? { allowedAts: cleanList(input.submissionPolicy.allowedAts) } : {}),
      },
      dailyApplicationLimit: positiveInteger(input.dailyApplicationLimit, 3, "Daily application limit"),
      ...(input.optionalWeeklyLimit !== undefined
        ? {
            optionalWeeklyLimit: optionalPositiveInteger(input.optionalWeeklyLimit, "Weekly application limit"),
          }
        : {}),
      reviewConditions: {
        ...DEFAULT_REVIEW_CONDITIONS,
        ...(input.reviewConditions?.unusualTerms !== undefined ? { unusualTerms: input.reviewConditions.unusualTerms } : {}),
        ...(input.reviewConditions?.authenticationRequired !== undefined
          ? {
              authenticationRequired: input.reviewConditions.authenticationRequired,
            }
          : {}),
        ...(input.reviewConditions?.unknownFacts !== undefined ? { unknownFacts: input.reviewConditions.unknownFacts } : {}),
        ...(input.reviewConditions?.subjectiveAnswers !== undefined ? { subjectiveAnswers: input.reviewConditions.subjectiveAnswers } : {}),
      },
      stopConditions: {
        ...DEFAULT_STOP_CONDITIONS,
        ...(input.stopConditions?.stopOnAcceptedOffer !== undefined
          ? { stopOnAcceptedOffer: input.stopConditions.stopOnAcceptedOffer }
          : {}),
        ...(input.stopConditions?.maxApplications !== undefined
          ? {
              maxApplications: optionalPositiveInteger(input.stopConditions.maxApplications, "Maximum applications"),
            }
          : {}),
        ...(input.stopConditions?.maxDays !== undefined
          ? {
              maxDays: optionalPositiveInteger(input.stopConditions.maxDays, "Maximum campaign days"),
            }
          : {}),
        ...(input.stopConditions?.systemicFailureLimit !== undefined
          ? {
              systemicFailureLimit: positiveInteger(input.stopConditions.systemicFailureLimit, 1, "Systemic failure limit"),
            }
          : {}),
      },
      consecutiveSystemicFailures: 0,
      createdAt,
      updatedAt: createdAt,
    };

    if (
      !isPursuitDecision(campaign.fitPolicy.strong) ||
      !isPursuitDecision(campaign.fitPolicy.good) ||
      !isPursuitDecision(campaign.fitPolicy.stretch) ||
      !isPursuitDecision(campaign.fitPolicy.weak)
    ) {
      throw new Error("Campaign fit policy contains an unsupported pursuit decision.");
    }
    if (!isSubmissionAuthority(campaign.submissionPolicy.authority)) {
      throw new Error("Campaign submission policy contains an unsupported authority.");
    }

    this.careerRepository.saveCampaign(campaign);
    this.appendEvent(
      campaign.id,
      "campaign.created",
      metadataFrom([
        ["status", campaign.status],
        ["sourceCount", String(campaign.searchSources.length)],
      ]),
    );
    return campaign;
  }

  /**
   * Explicit user-authorized transition for a persisted campaign. This keeps
   * automatic submission opt-in durable without changing discovery, fit, or
   * pursuit policy.
   */
  authorizeAutomaticSubmission(campaignId: string): Campaign {
    const campaign = this.getCampaign(campaignId);
    if (campaign.submissionPolicy.authority === "automatic" && !campaign.submissionPolicy.requireExplicitApproval) {
      return campaign;
    }
    const updated = {
      ...campaign,
      submissionPolicy: {
        ...campaign.submissionPolicy,
        authority: "automatic" as const,
        requireExplicitApproval: false,
      },
      updatedAt: this.now(),
    };
    this.careerRepository.saveCampaign(updated);
    return updated;
  }

  activateCampaign(campaignId: string): Campaign {
    const campaign = this.getCampaign(campaignId);
    if (campaign.status === "active") return campaign;
    assertCampaignTransition(campaign.status, "active");
    const updated = {
      ...campaign,
      status: "active" as const,
      updatedAt: this.now(),
    };
    this.careerRepository.saveCampaign(updated);
    this.appendEvent(campaignId, "campaign.started");
    return updated;
  }

  /** Update pursuit decisions without changing fit scoring or search intent. */
  updateFitPolicy(campaignId: string, patch: Partial<FitPolicy>): Campaign {
    const campaign = this.getCampaign(campaignId);
    const nextPolicy: FitPolicy = { ...campaign.fitPolicy, ...patch };
    if (
      !isPursuitDecision(nextPolicy.strong) ||
      !isPursuitDecision(nextPolicy.good) ||
      !isPursuitDecision(nextPolicy.stretch) ||
      !isPursuitDecision(nextPolicy.weak)
    ) {
      throw new Error("Campaign fit policy contains an unsupported pursuit decision.");
    }
    const updated = {
      ...campaign,
      fitPolicy: nextPolicy,
      updatedAt: this.now(),
    };
    this.careerRepository.saveCampaign(updated);
    return updated;
  }

  /** Update submission authority as a durable safety setting. */
  updateSubmissionPolicy(campaignId: string, patch: Partial<SubmissionPolicy>): Campaign {
    const campaign = this.getCampaign(campaignId);
    const nextPolicy: SubmissionPolicy = {
      ...campaign.submissionPolicy,
      ...patch,
    };
    if (!isSubmissionAuthority(nextPolicy.authority)) {
      throw new Error("Campaign submission policy contains an unsupported authority.");
    }
    const updated = {
      ...campaign,
      submissionPolicy: nextPolicy,
      updatedAt: this.now(),
    };
    this.careerRepository.saveCampaign(updated);
    return updated;
  }

  pauseCampaign(campaignId: string): Campaign {
    const campaign = this.getCampaign(campaignId);
    if (campaign.status === "paused") return campaign;
    assertCampaignTransition(campaign.status, "paused");
    const updated = {
      ...campaign,
      status: "paused" as const,
      updatedAt: this.now(),
    };
    this.careerRepository.saveCampaign(updated);
    this.appendEvent(campaignId, "campaign.paused");
    return updated;
  }

  completeCampaign(campaignId: string, reason = "campaign_completed"): Campaign {
    const campaign = this.getCampaign(campaignId);
    if (campaign.status === "completed") return campaign;
    assertCampaignTransition(campaign.status, "completed");
    const updated = {
      ...campaign,
      status: "completed" as const,
      updatedAt: this.now(),
    };
    this.careerRepository.saveCampaign(updated);
    this.appendEvent(campaignId, "campaign.completed", metadataFrom([["reason", reason]]));
    return updated;
  }

  markOfferAccepted(campaignId: string): Campaign {
    return this.completeCampaign(campaignId, "offer_accepted");
  }

  failCampaign(campaignId: string, reason = "campaign_failed"): Campaign {
    const campaign = this.getCampaign(campaignId);
    if (campaign.status === "failed") return campaign;
    assertCampaignTransition(campaign.status, "failed");
    const updated = {
      ...campaign,
      status: "failed" as const,
      updatedAt: this.now(),
    };
    this.careerRepository.saveCampaign(updated);
    this.appendEvent(campaignId, "campaign.failed", metadataFrom([["reason", reason]]));
    return updated;
  }

  snapshot(campaignId: string, at = this.now()): CampaignSnapshot {
    const campaign = this.getCampaign(campaignId);
    const jobs = this.listJobs(campaignId);
    const todayJobs = jobs.filter((job) => sameUtcDay(job.discoveredAt, at));
    const counts: CampaignCounts = {
      discovered: todayJobs.length,
      worthPursuing: todayJobs.filter((job) =>
        ["pursuing", "preparing", "needs_input", "ready_to_submit", "submitted", "applied"].includes(job.status),
      ).length,
      prepared: todayJobs.filter((job) => ["preparing", "needs_input", "ready_to_submit", "submitted", "applied"].includes(job.status))
        .length,
      applied: todayJobs.filter((job) => job.status === "applied").length,
      needsYou: jobs.filter(jobNeedsAttention).length,
      rejected: todayJobs.filter((job) => job.status === "rejected").length,
      held: todayJobs.filter((job) => job.status === "held").length,
      failed: todayJobs.filter((job) => job.status === "failed").length,
    };

    return {
      campaign,
      counts,
      jobs,
      attentionJobs: jobs.filter(jobNeedsAttention),
      recentEvents: this.listEvents(campaignId).slice(-16).reverse(),
    };
  }

  async runCampaign(campaignId: string): Promise<CampaignRunResult> {
    let campaign = this.getCampaign(campaignId);
    const accumulator = emptyAccumulator();
    const runStartedAt = this.now();
    const eventBaseline = new Set(this.listEvents(campaignId).map((event) => event.id));
    const trace = new ExecutionTraceBuilder(this.createId("execution-run"), "campaign_run", this.now, runStartedAt);
    const previousTraceCompletedAt = campaign.lastRunTrace?.completedAt;
    const finish = (): CampaignRunResult => this.finishRun(campaignId, accumulator, trace, eventBaseline, previousTraceCompletedAt);

    if (campaign.status !== "active") {
      return finish();
    }

    campaign = this.applyStopConditions(campaign);
    if (campaign.status !== "active") {
      return finish();
    }

    const readiness = trace.measureSync(
      `campaign.readiness.${campaign.id}`,
      "deterministic",
      () => validateCareerAgentReadiness(this.profile, this.resumeArtifactAvailable),
      {
        inputCount: 1,
        outputCount: (result) => (result.ok ? 0 : 1),
        outcome: (result) => (result.ok ? "success" : "blocked"),
        failureReason: (result) => (result.ok ? undefined : result.failureReason),
        humanAttentionRequired: (result) => !result.ok,
        humanAttentionCategory: (result) => (result.ok ? undefined : result.attentionCategory),
        metadata: { stage: "campaign.readiness" },
      },
    );
    if (!readiness.ok) {
      const created = await this.publishConfigurationAttention(campaign, readiness);
      if (created) {
        this.appendEvent(campaign.id, "campaign.review_needed", {
          reasonCode: readiness.reasonCode,
          attentionCategory: readiness.attentionCategory,
          stage: "campaign.readiness",
        });
      }
      await this.publishPendingAttentionEvents(campaignId);
      return finish();
    }
    await this.resolveConfigurationAttentionEvents(campaign.id);
    await this.publishPendingAttentionEvents(campaignId);

    await this.resolveDestinations(campaign.id);

    for (const job of this.listJobs(campaignId).filter(
      (candidate) =>
        candidate.status === "needs_input" &&
        candidate.destinationResolution?.status !== "unresolved" &&
        candidate.destinationResolution?.status !== "ambiguous" &&
        !(candidate.execution?.mode === "real_local" && candidate.execution.hostExecutionId),
    )) {
      let resumeAttempt = 1;
      if (job.applicationResumeAttempt !== undefined && job.applicationId) {
        try {
          const application = this.applicationService.getApplication(job.applicationId);
          if (application.status === "ready_for_review") resumeAttempt = job.applicationResumeAttempt + 1;
        } catch {
          // The measured resume node will record the packet lookup failure.
        }
      }
      const outcome = await trace.measure(
        `application.resume.${job.id}`,
        "human_gate",
        () => this.resumeBlockedJob(campaign, job, trace, `application.resume.${job.id}`),
        {
          inputCount: 1,
          outputCount: () => 1,
          outcome: (result) => (result.failure ? "failed" : result.careerJob.status === "needs_input" ? "blocked" : "success"),
          humanAttentionRequired: (result) => result.careerJob.status === "needs_input",
          humanAttentionCategory: (result) => (result.careerJob.status === "needs_input" ? "candidate_fact_missing" : undefined),
          attempt: resumeAttempt,
          ...(resumeAttempt > 1
            ? {
                retryReasonCode: "blocker" as const,
                previousOutcome: "blocked" as const,
              }
            : {}),
          metadata: { jobId: job.id, stage: "preparation.resume" },
        },
      );
      if (outcome.applied) accumulator.applied += 1;
      if (outcome.failure) accumulator.failures += 1;
      campaign = this.getCampaign(campaignId);
      if (outcome.careerJob.status === "needs_input") {
        await this.publishAttentionForJob(campaign, outcome.careerJob);
      }
      if (campaign.status !== "active") return finish();
    }

    this.appendEvent(campaignId, "job.discovery_started", metadataFrom([["sourceIds", campaign.searchSources.join(",") || "none"]]));

    const scoutResult = await trace.measure("scout.fetch-and-reduce", "external_io", () => this.scout.discover(campaign), {
      inputCount: campaign.searchSources.length,
      outputCount: (result) => result.jobs.length,
      outcome: (result) => (result.failures.length === 0 ? "success" : result.jobs.length > 0 ? "partial" : "failed"),
      metadata: {
        sourceCount: String(campaign.searchSources.length),
        stage: "scout.total",
      },
    });
    trace.addMany(scoutResult.executionNodes ?? []);
    const sourceFailures = scoutResult.failures;
    const existingBeforeDiscovery = this.careerRepository.listJobs();
    const newCount = await trace.measure(
      "scout.history-dedupe",
      "deterministic",
      async () => scoutResult.jobs.filter((scouted) => !this.findExistingJob(scouted, existingBeforeDiscovery)).length,
      {
        inputCount: scoutResult.jobs.length,
        outputCount: (count) => count,
        metadata: {
          historicalJobCount: String(existingBeforeDiscovery.length),
          stage: "scout.history-dedupe",
        },
      },
    );
    const allSourcesNotConfigured =
      scoutResult.sourceSummaries.length > 0 && scoutResult.sourceSummaries.every((source) => source.status === "not_configured");
    const discoveryStatus: DiscoverySummary["status"] =
      scoutResult.jobs.length === 0
        ? allSourcesNotConfigured
          ? "not_configured"
          : sourceFailures.length > 0
            ? "failed"
            : "empty"
        : sourceFailures.length > 0
          ? "partial"
          : "success";
    const discoverySummary: DiscoverySummary = {
      status: discoveryStatus,
      sourceIds: scoutResult.sourceSummaries.map((source) => source.sourceId),
      sourceModes: [...new Set(scoutResult.sourceSummaries.map((source) => source.mode))],
      sourceSummaries: scoutResult.sourceSummaries.map((source): DiscoverySourceSummary => ({ ...source })),
      startedAt: scoutResult.startedAt,
      completedAt: scoutResult.completedAt,
      receivedCount: scoutResult.receivedCount,
      normalizedCount: scoutResult.normalizedCount,
      duplicateCount: scoutResult.duplicateCount,
      newCount,
      failureCount: sourceFailures.filter((failure) => failure.kind !== "listing").length,
      warningCount: sourceFailures.filter((failure) => failure.kind === "listing").length,
      ...(scoutResult.referenceMetrics ? { referenceMetrics: scoutResult.referenceMetrics } : {}),
    };
    campaign = {
      ...campaign,
      lastDiscovery: discoverySummary,
      updatedAt: this.now(),
    };
    this.careerRepository.saveCampaign(campaign);
    const discoveryEventType: CareerEventType =
      discoveryStatus === "failed" || discoveryStatus === "not_configured"
        ? "job.discovery_failed"
        : discoveryStatus === "partial"
          ? "job.discovery_partial"
          : "job.discovery_completed";
    const discoveryMetadata: [string, string][] = [
      ["status", discoveryStatus],
      ["received", String(scoutResult.receivedCount)],
      ["normalized", String(scoutResult.normalizedCount)],
      ["duplicates", String(scoutResult.duplicateCount)],
      ["new", String(newCount)],
      ["failures", String(discoverySummary.failureCount)],
      ["warnings", String(discoverySummary.warningCount)],
      ["sourceStatuses", scoutResult.sourceSummaries.map((source) => source.sourceId + ":" + source.status).join(",")],
    ];
    if (scoutResult.referenceMetrics) {
      discoveryMetadata.push(
        ["references", String(scoutResult.referenceMetrics.referencesDiscovered)],
        ["knownAts", String(scoutResult.referenceMetrics.knownAtsReferences)],
        ["leverReferences", String(scoutResult.referenceMetrics.leverReferences)],
        ["greenhouseReferences", String(scoutResult.referenceMetrics.greenhouseReferences)],
        ["knownUnsupported", String(scoutResult.referenceMetrics.knownUnsupportedReferences)],
        ["unknownOrCustom", String(scoutResult.referenceMetrics.unknownOrCustomReferences)],
        ["structuredResolved", String(scoutResult.referenceMetrics.structuredJobsResolved)],
        ["referenceDuplicates", String(scoutResult.referenceMetrics.duplicatesRemoved)],
      );
      const optionalMetrics: Array<[string, number | undefined]> = [
        ["providerResults", scoutResult.referenceMetrics.providerResults],
        ["acceptedReferences", scoutResult.referenceMetrics.acceptedReferences],
        ["rejectedReferences", scoutResult.referenceMetrics.rejectedReferences],
        ["duplicateReferences", scoutResult.referenceMetrics.duplicateReferences],
        ["queriesExecuted", scoutResult.referenceMetrics.queriesExecuted],
        ["ashbyReferences", scoutResult.referenceMetrics.ashbyReferences],
        ["workdayReferences", scoutResult.referenceMetrics.workdayReferences],
        ["customReferences", scoutResult.referenceMetrics.customReferences],
        ["unknownReferences", scoutResult.referenceMetrics.unknownReferences],
        ["fallbackRequired", scoutResult.referenceMetrics.fallbackRequiredReferences],
        ["invalidReferences", scoutResult.referenceMetrics.invalidReferences],
        ["failedReferences", scoutResult.referenceMetrics.failedReferences],
        ["uniqueLeverSites", scoutResult.referenceMetrics.uniqueLeverSites],
        ["uniqueGreenhouseBoards", scoutResult.referenceMetrics.uniqueGreenhouseBoards],
      ];
      for (const [key, value] of optionalMetrics) {
        if (value !== undefined) discoveryMetadata.push([key, String(value)]);
      }
    }
    this.appendEvent(campaignId, discoveryEventType, metadataFrom(discoveryMetadata));

    if (scoutResult.jobs.length === 0 && sourceFailures.length > 0) {
      const nextFailureCount = campaign.consecutiveSystemicFailures + 1;
      campaign = {
        ...campaign,
        consecutiveSystemicFailures: nextFailureCount,
        updatedAt: this.now(),
      };
      this.careerRepository.saveCampaign(campaign);
      if (nextFailureCount >= campaign.stopConditions.systemicFailureLimit) {
        this.failCampaign(campaignId, "repeated_systemic_job_source_failure");
        return finish();
      }
    } else if (campaign.consecutiveSystemicFailures !== 0) {
      campaign = {
        ...campaign,
        consecutiveSystemicFailures: 0,
        updatedAt: this.now(),
      };
      this.careerRepository.saveCampaign(campaign);
    }

    for (const scouted of scoutResult.jobs) {
      campaign = this.getCampaign(campaignId);
      if (campaign.status !== "active") break;
      const existing = this.findExistingJob(scouted);
      if (existing) {
        const enriched = this.mergeScoutedRecord(existing, scouted);
        if (
          enriched.status === "held" &&
          enriched.decisionReason === APPLICATION_CAP_HOLD_REASON &&
          !this.applicationCapReached(campaign, this.now())
        ) {
          const outcome = await trace.measure(
            `application.resume-cap.${enriched.id}`,
            "deterministic",
            () => this.resumeCapHeldJob(campaign, enriched, trace),
            {
              inputCount: 1,
              outputCount: () => 1,
              outcome: (result) => (result.failure ? "failed" : "success"),
              metadata: { jobId: enriched.id, stage: "preparation.total" },
            },
          );
          if (outcome.applied) accumulator.applied += 1;
          if (outcome.prepared) accumulator.prepared += 1;
          if (outcome.failure) accumulator.failures += 1;
          continue;
        }
        const application = enriched.applicationId
          ? (this.applicationService.listApplications().find((candidate) => candidate.id === enriched.applicationId) ?? null)
          : null;
        if (enriched.status === "applied" || isApplicationApplied(application)) accumulator.alreadyApplied += 1;
        else accumulator.alreadySeen += 1;
        continue;
      }

      accumulator.discovered += 1;
      const outcome = await trace.measure(
        `job.process.${accumulator.discovered}`,
        "judgment",
        () => this.processScoutedJob(campaign, scouted, trace, `job.process.${accumulator.discovered}`),
        {
          inputCount: 1,
          outputCount: () => 1,
          outcome: (result) => (result.failure ? "failed" : result.held || result.blocked ? "blocked" : "success"),
          humanAttentionRequired: (result) => Boolean(result.held || result.blocked || result.failure),
          metadata: {
            sourceId: scouted.sourceId,
            actionability: scouted.actionability,
            stage: "job.total",
          },
        },
      );
      if (outcome.applied) accumulator.applied += 1;
      if (outcome.prepared) accumulator.prepared += 1;
      if (outcome.rejected) accumulator.rejected += 1;
      if (outcome.held) accumulator.held += 1;
      if (outcome.failure) accumulator.failures += 1;
      campaign = this.applyStopConditions(this.getCampaign(campaignId));
    }

    this.applyStopConditions(this.getCampaign(campaignId));
    await this.publishPendingPreparationAttention(campaignId);
    return finish();
  }

  async resolveCareerBlocker(
    campaignId: string,
    jobId: string,
    blockerId: string,
    value: AnswerValue,
    options: CareerBlockerResolutionOptions = {},
  ): Promise<CareerJob> {
    if (!answerIsMeaningful(value)) {
      throw new Error("A career blocker needs a non-empty answer.");
    }

    const campaign = this.getCampaign(campaignId);
    const job = this.getJob(jobId);
    if (job.campaignId !== campaignId) throw new Error("That job does not belong to the selected campaign.");
    const blocker = job.blockers.find((candidate) => candidate.id === blockerId);
    if (!blocker || blocker.status === "resolved") throw new Error("That career blocker is no longer open.");

    if (blocker.unit === "application_preparation" && blocker.context.applicationId && blocker.field) {
      const application = this.applicationService.getApplication(blocker.context.applicationId);
      const applicationBlocker = application.blockers.find(
        (candidate) => candidate.id === blocker.field || candidate.field === blocker.field,
      );
      if (applicationBlocker?.status === "open") {
        this.applicationService.resolveHumanField(application.id, applicationBlocker.id, value);
      }
    }

    const resolved: CareerJob = {
      ...job,
      blockers: job.blockers.map((candidate) =>
        candidate.id === blocker.id
          ? {
              ...candidate,
              status: "resolved" as const,
              resolvedAt: this.now(),
              value,
              ...(options.answerEvidence && options.answerEvidence.length > 0
                ? { evidence: [...new Set([...candidate.evidence, ...options.answerEvidence])] }
                : {}),
            }
          : candidate,
      ),
      updatedAt: this.now(),
    };
    this.careerRepository.saveJob(resolved);
    await this.recordAttentionResolution(campaign, resolved, blocker, value, options.attentionResponse);

    if (options.deferResume) return resolved;

    // A real local browser owns its live session. Resolving a blocker updates
    // the persisted domain value, but the UI must explicitly resume that
    // same host session instead of falling back to the injected executor.
    if (resolved.execution?.mode === "real_local" && resolved.execution.hostExecutionId) {
      return resolved;
    }

    if (campaign.status === "active") {
      const resumed = await this.resumeBlockedJob(campaign, resolved);
      if (resumed.careerJob.status === "needs_input") {
        await this.publishAttentionForJob(this.getCampaign(campaign.id), resumed.careerJob);
      }
      return resumed.careerJob;
    }
    return resolved;
  }

  /**
   * Correct one already-resolved answer without reopening or resuming the
   * browser. Every identity and the previously persisted value must match;
   * this is intentionally separate from the normal response path so a stale
   * Slack reply cannot mutate a different application.
   */
  reviseResolvedCareerAnswer(input: ResolvedCareerAnswerRevision): CareerAnswerRevisionResult {
    const fields = [
      input.campaignId,
      input.jobId,
      input.blockerId,
      input.attentionEventId,
      input.expectedCurrentValue,
      input.replacementValue,
    ];
    if (fields.some((value) => typeof value !== "string" || value.trim().length === 0)) {
      throw new AttentionResponseError("A resolved answer revision requires all exact identifiers and values.");
    }
    if (input.expectedCurrentValue === input.replacementValue) {
      throw new AttentionResponseError("The replacement answer must differ from the persisted answer.");
    }

    const campaign = this.getCampaign(input.campaignId);
    const job = this.getJob(input.jobId);
    if (job.campaignId !== campaign.id) throw new AttentionResponseError("That job does not belong to the selected campaign.");
    if (job.status !== "failed") throw new AttentionResponseError("Only the failed, pre-submit application can be safely corrected.");
    const hasPositivePreSubmitEvidence = job.execution?.evidence.some((item) =>
      item === "submit:not-clicked" || item.includes("submit:not-clicked;"),
    );
    if (!hasPositivePreSubmitEvidence) {
      throw new AttentionResponseError("A pre-submit evidence fence is required before correcting this answer.");
    }
    if (job.submissionProof || job.manualSubmissionConfirmation || job.execution?.evidence.some((item) => item.includes("submit:clicked"))) {
      throw new AttentionResponseError("A submitted or submission-uncertain application cannot be corrected this way.");
    }

    const blocker = job.blockers.find((candidate) => candidate.id === input.blockerId);
    if (!blocker || blocker.status !== "resolved") throw new AttentionResponseError("That resolved blocker was not found.");
    if (blocker.value !== input.expectedCurrentValue) throw new AttentionResponseError("The blocker value no longer matches the expected answer.");

    const record = (campaign.attentionEvents ?? []).find((candidate) => candidate.id === input.attentionEventId);
    if (!record || record.status !== "resolved" || record.jobId !== job.id || record.blockerId !== blocker.id) {
      throw new AttentionResponseError("That resolved attention event does not match the requested blocker.");
    }
    if (record.answerUsed !== input.expectedCurrentValue || record.response?.selectedOption !== input.expectedCurrentValue) {
      throw new AttentionResponseError("The attention event value no longer matches the expected answer.");
    }
    if (record.question?.prompt !== blocker.question) {
      throw new AttentionResponseError("The attention event question no longer matches the blocker.");
    }

    const revisedJob: CareerJob = {
      ...job,
      blockers: job.blockers.map((candidate) =>
        candidate.id === blocker.id ? { ...candidate, value: input.replacementValue } : candidate,
      ),
      updatedAt: this.now(),
    };
    const revisedEvent: PersistedAttentionEvent = {
      ...record,
      answerUsed: input.replacementValue,
      response: record.response ? { ...record.response, selectedOption: input.replacementValue } : record.response,
    };
    this.careerRepository.saveJob(revisedJob);
    this.careerRepository.saveCampaign({
      ...campaign,
      attentionEvents: (campaign.attentionEvents ?? []).map((candidate) =>
        candidate.id === record.id ? revisedEvent : candidate,
      ),
      updatedAt: this.now(),
    });
    return { careerJob: revisedJob, attentionEvent: revisedEvent };
  }

  /**
   * Applies one authenticated response to the exact persisted blocker and then
   * invokes the already-existing host resume operation when one is injected.
   */
  async resolveAttentionResponse(response: AttentionResponse): Promise<CareerAttentionResponseResult> {
    if (!isAttentionResponse(response)) {
      throw new AttentionResponseError("The attention response is malformed.");
    }

    const inFlight = this.attentionResponseInFlight.get(response.eventId);
    if (inFlight) {
      if (inFlight.selectedOption !== response.selectedOption) {
        throw new AttentionResponseError("That attention event is already being resolved with a different choice.");
      }
      return inFlight.promise;
    }

    const promise = this.resolveAttentionResponseOnce(response);
    this.attentionResponseInFlight.set(response.eventId, {
      selectedOption: response.selectedOption,
      promise,
    });
    try {
      return await promise;
    } finally {
      if (this.attentionResponseInFlight.get(response.eventId)?.promise === promise) {
        this.attentionResponseInFlight.delete(response.eventId);
      }
    }
  }

  private async resolveAttentionResponseOnce(response: AttentionResponse): Promise<CareerAttentionResponseResult> {
    const located = this.findAttentionRecord(response.eventId);
    if (!located) throw new AttentionResponseError("That attention event is unknown.");
    const { campaign, record } = located;
    if (record.type !== "needs_input" || !record.applicationId || !record.jobId || !record.blockerId || !record.question) {
      throw new AttentionResponseError("That attention event does not accept a response.");
    }
    if (record.status === "resolved") {
      const sameDraftApproval = Boolean(
        record.draft && isDraftApprovalCommand(response.selectedOption) && record.response?.selectedOption === response.selectedOption,
      );
      if (!sameDraftApproval && record.response?.selectedOption !== response.selectedOption) {
        throw new AttentionResponseError("That attention event was already resolved with a different choice.");
      }
      return {
        status: "duplicate",
        event: publicAttentionEvent(record),
        careerJob: this.getJob(record.jobId),
      };
    }
    if (record.status !== "open") {
      throw new AttentionResponseError("That attention event is no longer open.");
    }

    const job = this.getJob(record.jobId);
    if (job.campaignId !== campaign.id || job.applicationId !== record.applicationId || job.status !== "needs_input") {
      throw new AttentionResponseError("That application is no longer eligible for this attention response.");
    }
    let application: Application;
    try {
      application = this.applicationService.getApplication(record.applicationId);
    } catch {
      throw new AttentionResponseError("That application packet is no longer available for a safe resume.");
    }
    const blocker = job.blockers.find((candidate) => candidate.id === record.blockerId);
    if (!blocker || blocker.status !== "open") {
      throw new AttentionResponseError("That application blocker is no longer open.");
    }
    const applicationPreparationResume = blocker.unit === "application_preparation";
    const hostExecutionResumable = job.execution?.mode === "real_local" && Boolean(job.execution.hostExecutionId);
    let preparationOnlyResume = false;
    if (!hostExecutionResumable) {
      try {
        preparationOnlyResume =
          this.executor.executionMode?.({
            campaign,
            careerJob: job,
            application,
            now: this.now(),
            profile: this.profile,
          }) === "preparation_only";
      } catch {
        preparationOnlyResume = false;
      }
    }
    if (!hostExecutionResumable && !preparationOnlyResume && !applicationPreparationResume) {
      throw new AttentionResponseError("That application no longer has a resumable local browser execution.");
    }

    const currentSignature = attentionDescriptorSignature(blocker, job.job.compensation);
    if (!currentSignature || currentSignature !== record.descriptorSignature) {
      await this.replaceStaleAttentionEvent(campaign, job, record, blocker);
      throw new AttentionResponseError("The application question changed; a new attention event was created.");
    }

    const option =
      record.question.kind === "single_choice"
        ? record.question.options.find((candidate) => candidate.id === response.selectedOption)
        : { id: response.selectedOption, label: response.selectedOption };
    if (!option) throw new AttentionResponseError("That choice is not valid for this attention event.");

    if (record.draft && isDraftRejectionCommand(response.selectedOption)) {
      throw new AttentionResponseError("The suggested answer remains open; reply APPROVE or send an edited answer.");
    }
    if (
      !record.draft &&
      record.question.kind === "free_text" &&
      isDraftApprovalCommand(response.selectedOption)
    ) {
      throw new AttentionResponseError("No review draft is attached to this event; send the application answer explicitly.");
    }

    // Attention option IDs are transport-safe presentation IDs. For generated
    // choices (for example `continue-1`), the browser must receive the
    // inspected option label/value rather than the synthetic Slack ID. Keep
    // canonical yes/no IDs stable for existing boolean answer semantics.
    const blockerValue =
      record.draft && isDraftApprovalCommand(response.selectedOption)
        ? record.draft.answer
        : record.question.kind === "single_choice" && option.id !== option.label.trim().toLowerCase()
          ? option.label
          : option.id;

    // Each sequential application question starts a fresh visible Slack root.
    // The adapter keeps historical message timestamps/thread correlations, but
    // must not carry the previous question's root into the next publication.
    this.notificationAdapter?.startFreshApplicationReview?.(record.applicationId);
    const resolved = await this.resolveCareerBlocker(campaign.id, job.id, blocker.id, blockerValue, { attentionResponse: response });
    // Preparation-only background executors re-inspect through the existing
    // service resume path. A real execution host owns its live session and
    // must receive the explicit resume request instead.
    // Some human boundaries are deliberately non-resumable. Submission
    // confirmation is the critical example: once Submit has been activated
    // without deterministic confirmation, answering the attention event must
    // never cause a second Submit attempt.
    const postSubmitVerification = blocker.kind === "external_verification" &&
      blocker.unit === "submission" &&
      blocker.field === "submission-confirmation" &&
      blocker.resumeAfterHuman === false &&
      blocker.evidence.some((item) => item === "submit:clicked" || item.includes("submit:clicked;")) &&
      response.selectedOption.trim().toUpperCase() === "DONE";
    const verificationHandoff = blocker.kind === "captcha" || postSubmitVerification;
    // CAPTCHA and post-submit verification handoffs resume the retained host
    // session after DONE. The durable submission fence remains authoritative:
    // any resumed execution that reaches the submission lane cannot claim or
    // cross an already-used fence, so this never creates a second Submit click.
    if (hostExecutionResumable && (blocker.resumeAfterHuman !== false || postSubmitVerification)) {
      const current = this.getJob(job.id);
      const nextBlocker = this.nextAttentionBlocker(this.getCampaign(campaign.id), current);
      if (nextBlocker) {
        await this.publishAttentionForJob(this.getCampaign(campaign.id), current);
      } else if (this.resumeAttention) {
        try {
          await this.resumeAttention(campaign.id, job.id, { verificationHandoff });
        } catch (error) {
          const expired = /expired|closed|not found|cannot be resumed|session/i.test(error instanceof Error ? error.message : String(error));
          if (!expired) throw error;
          await this.notificationAdapter?.publishExpiredSessionNotice?.(publicAttentionEvent(record));
        }
      }
    }
    const updatedCampaign = this.getCampaign(campaign.id);
    const updatedRecord = updatedCampaign.attentionEvents?.find((candidate) => candidate.id === record.id) ?? record;
    return {
      status: "resolved",
      event: publicAttentionEvent(updatedRecord),
      careerJob: resolved,
    };
  }

  async resumeBlockedApplication(campaignId: string, jobId: string): Promise<CareerJob> {
    const campaign = this.getCampaign(campaignId);
    const job = this.getJob(jobId);
    if (job.campaignId !== campaignId) throw new Error("That job does not belong to the selected campaign.");
    return (await this.resumeBlockedJob(campaign, job)).careerJob;
  }

  /**
   * Reopens the same prepared packet after a retryable browser failure. The
   * application and career job identities are preserved; only the transient
   * execution state is reset for a fresh trusted host attempt.
   */
  recoverFailedApplicationForExecution(campaignId: string, jobId: string): CareerJob {
    const campaign = this.getCampaign(campaignId);
    const job = this.getJob(jobId);
    if (job.campaignId !== campaignId) throw new Error("That job does not belong to the selected campaign.");
    if (!job.applicationId || !["failed", "preparing"].includes(job.status)) {
      throw new Error("Only a failed pre-submit career job with an existing application can be recovered for browser execution.");
    }
    const application = this.applicationService.getApplication(job.applicationId);
    if ((job.execution && job.execution.status !== "failed") || (!job.execution && application.status !== "failed")) {
      throw new Error("Only a failed pre-submit career job with an existing application can be recovered for browser execution.");
    }
    this.applicationService.reopenFailedApplicationForExecution(application.id);
    const recovered = this.saveJob({
      ...job,
      status: "preparing",
      decisionReason: undefined,
      ...(job.execution
        ? {
            execution: {
              ...job.execution,
              status: "not_started",
              hostExecutionId: undefined,
              failureReasonCode: undefined,
              updatedAt: this.now(),
            },
          }
        : {}),
      updatedAt: this.now(),
    });
    this.appendEvent(campaign.id, "application.execution_resumed", {
      ...careerEventMetadata(recovered),
      recovery: "retryable_browser_execution",
    });
    return recovered;
  }

  /** Refresh an existing proof-free packet after a profile/resume-family update. */
  async reprepareExistingApplication(campaignId: string, jobId: string): Promise<CareerJob> {
    const campaign = this.getCampaign(campaignId);
    const job = this.getJob(jobId);
    if (job.campaignId !== campaign.id || !job.applicationId) throw new Error("The application refresh target is not in the selected campaign.");
    if (["applied"].includes(job.status) || ["starting", "inspecting", "executing", "resuming"].includes(job.execution?.status ?? "")) {
      throw new Error("An applied or in-flight application cannot be refreshed.");
    }
    const currentApplication = this.applicationService.getApplication(job.applicationId);
    if (currentApplication.submissionProof || currentApplication.status === "applied") throw new Error("A proof-bearing application cannot be refreshed.");
    const refreshedFit = trustedQueueFitAssessment(
      await this.applicationService.assessJob(job.job),
      Boolean(job.queueSelected),
      job.queueFit,
      job.queuePriority,
      job.queueResumeFamily,
      this.profile,
    );
    const refreshed = await this.applicationService.reprepareExistingApplication(currentApplication.id, refreshedFit, job.job);
    const updated = this.saveJob({
      ...job,
      fit: refreshed.fit ?? job.fit,
      status: refreshed.status === "needs_input" ? "needs_input" : "preparing",
      decisionReason: undefined,
      ...(job.execution ? { execution: { ...job.execution, status: "not_started", hostExecutionId: undefined, fieldsDetected: [], fieldsFilled: [], unresolvedFields: [], evidence: [], updatedAt: this.now() } } : {}),
      updatedAt: this.now(),
    });
    this.appendEvent(campaign.id, "application.execution_resumed", { ...careerEventMetadata(updated), recovery: "profile_resume_family_refresh" });
    return updated;
  }

  /**
   * Reprepare a packet whose browser host disappeared before submission.
   * Every identity and the positive pre-submit evidence fence is checked so
   * an unknown or recently active session can never be silently replaced.
   */
  async recoverStalePreSubmitApplication(
    campaignId: string,
    jobId: string,
    applicationId: string,
    executionId: string,
    hostUnavailable: StalePreSubmitHostUnavailable,
  ): Promise<CareerJob> {
    if (!hostUnavailable) throw new Error("A stale pre-submit recovery requires an explicit unavailable-host reason.");
    const campaign = this.getCampaign(campaignId);
    const job = this.getJob(jobId);
    if (job.campaignId !== campaign.id || job.applicationId !== applicationId) {
      throw new Error("The campaign, job, and application IDs do not match.");
    }
    const application = this.applicationService.getApplication(applicationId);
    if (application.status !== "ready_for_review" || job.status === "applied" || job.submissionProof || job.manualSubmissionConfirmation || application.submissionProof || application.manualSubmissionConfirmation) {
      throw new Error("Stale pre-submit recovery requires the exact proof-free ready-for-review packet.");
    }
    const execution = job.execution;
    if (!execution || execution.mode !== "real_local" || execution.hostExecutionId !== executionId) {
      throw new Error("Stale pre-submit recovery requires the exact retained real-browser execution ID.");
    }
    if (!(execution.status === "starting" || execution.status === "inspecting" || execution.status === "executing" || execution.status === "resuming")) {
      throw new Error("Stale pre-submit recovery requires an active, pre-submit execution state.");
    }
    if (!execution.evidence.some((item) => item === "submit:not-clicked" || item.includes("submit:not-clicked;"))) {
      throw new Error("Stale pre-submit recovery requires positive evidence that Submit was not clicked.");
    }
    const updatedAt = Date.parse(execution.updatedAt);
    const now = Date.parse(this.now());
    if (!Number.isFinite(updatedAt) || !Number.isFinite(now) || now - updatedAt < STALE_PRE_SUBMIT_EXECUTION_MS) {
      throw new Error("The pre-submit execution is not stale enough to recover safely.");
    }

    const fenced = this.saveJob({
      ...job,
      execution: {
        ...execution,
        status: "not_started",
        hostExecutionId: undefined,
        fieldsDetected: [],
        fieldsFilled: [],
        unresolvedFields: [],
        evidence: [...new Set([...execution.evidence, `execution:stale-host-${hostUnavailable}`, "submit:not-clicked", "submission:manual-only"])],
        startedAt: this.now(),
        updatedAt: this.now(),
      },
      updatedAt: this.now(),
    });
    this.appendEvent(campaign.id, "application.execution_resumed", {
      ...careerEventMetadata(fenced),
      recovery: `stale_pre_submit_host_${hostUnavailable}`,
    });
    await this.reprepareExistingApplication(campaignId, fenced.id);
    const refreshedJob = this.getJob(fenced.id);
    return this.saveJob({
      ...refreshedJob,
      execution: refreshedJob.execution
        ? {
            ...refreshedJob.execution,
            evidence: [...new Set([...(fenced.execution?.evidence ?? []), "execution:stale-pre-submit-reprepared"])],
            updatedAt: this.now(),
          }
        : refreshedJob.execution,
      updatedAt: this.now(),
    });
  }

  reopenApplicationFieldsForManualHandoff(campaignId: string, jobId: string, fields: readonly string[]): CareerJob {
    const campaign = this.getCampaign(campaignId);
    const job = this.getJob(jobId);
    if (job.campaignId !== campaignId || !job.applicationId) throw new Error("The manual handoff target is not in the selected campaign.");
    const careerOnlyBrowserField = (field: string): boolean => /^(?:\d+|question_\d+|gdpr_[a-z0-9_]+)$/i.test(field);
    const hasResolvedCareerAggregate = job.blockers.some((blocker) => blocker.field === "demographic_disclosure" && blocker.status === "resolved");
    const careerOnly = fields.length > 0 && fields.every(careerOnlyBrowserField) && hasResolvedCareerAggregate;
    // Some ATSs persist only the aggregate demographic disclosure blocker on
    // the application while the individual browser controls live solely on
    // the career job. In that exact case, reopen the career-only fields
    // without inventing application blockers; the browser will re-inspect and
    // recreate precise field blockers if a control remains unresolved.
    const application = careerOnly
      ? this.applicationService.getApplication(job.applicationId)
      : this.applicationService.reopenFieldsForManualHandoff(job.applicationId, fields);
    const selected = new Set(fields);
    return this.saveJob({ ...job, status: "needs_input", blockers: job.blockers.map((blocker) => selected.has(blocker.field ?? "") || selected.has(blocker.id)
      ? { ...blocker, status: "open" as const, resolvedAt: undefined, value: undefined }
      : blocker), updatedAt: this.now() });
  }

  /**
   * Reopens the same application packet after the user explicitly elects to
   * retry an automatic submission whose external result was ambiguous. This
   * never creates a second packet or campaign, and it closes the old
   * verification event before the new host attempt begins.
   */
  async retryUnconfirmedAutomaticSubmission(campaignId: string, jobId: string): Promise<CareerJob> {
    const campaign = this.getCampaign(campaignId);
    const job = this.getJob(jobId);
    if (campaign.submissionPolicy.authority !== "automatic") {
      throw new Error("An unconfirmed submission can only be retried under automatic submission authority.");
    }
    if (job.campaignId !== campaign.id || job.status !== "needs_input" || !job.applicationId) {
      throw new Error("Only the same needs-input application can retry an unconfirmed submission.");
    }
    const application = this.applicationService.getApplication(job.applicationId);
    if (job.submissionProof || job.manualSubmissionConfirmation || application.submissionProof || application.manualSubmissionConfirmation) {
      throw new Error("An application with existing submission proof cannot use unknown-outcome manual confirmation.");
    }
    if (application.status !== "ready_for_review") {
      throw new Error("The application packet is not in a safe reviewable state for a retry.");
    }
    const blocker = job.blockers.find(
      (candidate) =>
        candidate.status === "open" &&
        candidate.kind === "external_verification" &&
        candidate.unit === "submission" &&
        candidate.field === "submission-confirmation" &&
        candidate.resumeAfterHuman === false,
    );
    if (!blocker) {
      throw new Error("The application has no open ambiguous-submission verification boundary.");
    }

    const now = this.now();
    const currentCampaign = this.getCampaign(campaign.id);
    const cancelledEvents = (currentCampaign.attentionEvents ?? [])
      .filter((event) => event.status === "open" && event.jobId === job.id && event.blockerId === blocker.id)
      .map((event) => ({
        ...event,
        status: "cancelled" as const,
        resolvedAt: now,
      }));
    const cancelledIds = new Set(cancelledEvents.map((event) => event.id));
    this.careerRepository.saveCampaign({
      ...currentCampaign,
      attentionEvents: (currentCampaign.attentionEvents ?? []).map((event) =>
        cancelledIds.has(event.id) ? (cancelledEvents.find((candidate) => candidate.id === event.id) ?? event) : event,
      ),
      updatedAt: now,
    });
    for (const event of cancelledEvents) {
      try {
        await this.notificationAdapter?.closeAttentionEvent?.(publicAttentionEvent(event));
      } catch {
        // Durable cancellation is authoritative; notification closure is best effort.
      }
    }

    const retried = this.saveJob({
      ...job,
      status: "preparing",
      blockers: job.blockers.map((candidate) =>
        candidate.id === blocker.id
          ? {
              ...candidate,
              status: "resolved" as const,
              resolvedAt: now,
              value: "explicit_retry_after_unconfirmed_submission",
            }
          : candidate,
      ),
      ...(job.execution
        ? {
            execution: {
              ...job.execution,
              status: "not_started" as const,
              hostExecutionId: undefined,
              fieldsDetected: [],
              fieldsFilled: [],
              unresolvedFields: [],
              evidence: [...new Set([...job.execution.evidence, "execution:explicit-unconfirmed-submission-retry"])],
              startedAt: now,
              updatedAt: now,
            },
          }
        : {}),
      updatedAt: now,
    });
    this.appendEvent(campaign.id, "application.execution_resumed", {
      ...careerEventMetadata(retried),
      recovery: "explicit_unconfirmed_submission_retry",
    });
    return retried;
  }

  /**
   * Close a stale CAPTCHA/post-submit attention boundary after the user
   * explicitly attests that the employer did not receive the application.
   * This records the durable fence recovery first, then only resets durable
   * review state. It never starts a host or performs a submission.
   */
  async recoverUnsubmittedHumanVerification(
    campaignId: string,
    jobId: string,
    applicationId: string,
    submissionAuthority: DurableSubmissionAuthority,
    input: { confirmedNotSubmitted: true; reason: string },
  ): Promise<CareerJob> {
    const campaign = this.getCampaign(campaignId);
    const job = this.getJob(jobId);
    if (job.campaignId !== campaignId || job.applicationId !== applicationId || !applicationId) {
      throw new Error("The recovery target campaign, job, and application IDs must match exactly.");
    }
    const application = this.applicationService.getApplication(applicationId);
    if (job.submissionProof || job.manualSubmissionConfirmation || application.submissionProof || application.manualSubmissionConfirmation) {
      throw new Error("Recovery is forbidden when any submission proof exists.");
    }
    if (application.status !== "ready_for_review") throw new Error("Recovery requires the application packet to remain ready for review.");
    const blocker = job.blockers.find((candidate) => candidate.status === "open" &&
      candidate.kind === "external_verification" && candidate.unit === "submission" &&
      candidate.field === "submission-confirmation" && candidate.resumeAfterHuman === false &&
      candidate.evidence.some((evidence) => evidence === "submit:clicked" || evidence.includes("submit:clicked;")));
    const execution = job.execution;
    const historicalBlocker = job.blockers.find((candidate) => candidate.status === "resolved" &&
      candidate.kind === "external_verification" && candidate.unit === "submission" &&
      candidate.field === "submission-confirmation" && candidate.resumeAfterHuman === false &&
      candidate.evidence.some((evidence) => evidence === "submit:clicked" || evidence.includes("submit:clicked;")));
    // A host restart/reopen can leave the exact packet safely ready_to_submit
    // while the historical post-submit blocker has already been resolved. This
    // branch only records the no-submission assertion and cancels stale
    // attention; it never starts, resumes, or submits a browser execution.
    const reopenedRecovery = job.status === "ready_to_submit" &&
      !blocker && Boolean(execution) && execution?.mode === "real_local" &&
      Boolean(execution.hostExecutionId?.trim()) && execution.status === "ready_to_submit" &&
      execution.evidence.some((evidence) => evidence === "submit:not-clicked" || evidence.includes("submit:not-clicked;")) &&
      Boolean(historicalBlocker);
    if (reopenedRecovery) {
      submissionAuthority.recoverUnknownForFreshAttempt(applicationId, jobId, input, this.now());
      const now = this.now();
      const currentCampaign = this.getCampaign(campaignId);
      const cancelledEvents = (currentCampaign.attentionEvents ?? [])
        .filter((event) => event.status === "open" && event.jobId === jobId && event.blockerId === historicalBlocker!.id)
        .map((event) => ({ ...event, status: "cancelled" as const, resolvedAt: now }));
      const cancelledIds = new Set(cancelledEvents.map((event) => event.id));
      this.careerRepository.saveCampaign({
        ...currentCampaign,
        attentionEvents: (currentCampaign.attentionEvents ?? []).map((event) =>
          cancelledIds.has(event.id) ? (cancelledEvents.find((candidate) => candidate.id === event.id) ?? event) : event),
        updatedAt: now,
      });
      for (const event of cancelledEvents) {
        try { await this.notificationAdapter?.closeAttentionEvent?.(publicAttentionEvent(event)); } catch { /* durable cancellation wins */ }
      }
      const recovered = this.saveJob({ ...job, decisionReason: input.reason.trim(), updatedAt: now });
      this.appendEvent(campaignId, "application.execution_resumed", {
        ...careerEventMetadata(recovered),
        recovery: "user_asserted_not_submitted_after_reopened_human_verification",
        reason: input.reason.trim(),
      });
      return recovered;
    }

    if (job.status !== "needs_input") throw new Error("Recovery requires the unresolved needs-input job or the exact reopened ready-to-submit execution.");
    if (!blocker) throw new Error("The exact unresolved human-verification submission boundary was not found.");

    // Persist the no-submission assertion before changing job/attention state.
    submissionAuthority.recoverUnknownForFreshAttempt(applicationId, jobId, input, this.now());
    const now = this.now();
    const currentCampaign = this.getCampaign(campaignId);
    const cancelledEvents = (currentCampaign.attentionEvents ?? [])
      .filter((event) => event.status === "open" && event.jobId === jobId && event.blockerId === blocker.id)
      .map((event) => ({ ...event, status: "cancelled" as const, resolvedAt: now }));
    const cancelledIds = new Set(cancelledEvents.map((event) => event.id));
    this.careerRepository.saveCampaign({
      ...currentCampaign,
      attentionEvents: (currentCampaign.attentionEvents ?? []).map((event) =>
        cancelledIds.has(event.id) ? (cancelledEvents.find((candidate) => candidate.id === event.id) ?? event) : event),
      updatedAt: now,
    });
    for (const event of cancelledEvents) {
      try { await this.notificationAdapter?.closeAttentionEvent?.(publicAttentionEvent(event)); } catch { /* durable cancellation wins */ }
    }
    const recovered = this.saveJob({
      ...job,
      status: "ready_to_submit",
      blockers: job.blockers.map((candidate) => candidate.id === blocker.id
        ? { ...candidate, status: "resolved" as const, resolvedAt: now, value: "user_asserted_not_submitted" }
        : candidate),
      decisionReason: input.reason.trim(),
      updatedAt: now,
    });
    this.appendEvent(campaignId, "application.execution_resumed", {
      ...careerEventMetadata(recovered),
      recovery: "user_asserted_not_submitted_after_human_verification",
      reason: input.reason.trim(),
    });
    return recovered;
  }

  /** Roll back an explicitly opened retry when no host snapshot was accepted. */
  rollbackUnconfirmedAutomaticSubmissionRetry(campaignId: string, jobId: string): CareerJob {
    const campaign = this.getCampaign(campaignId);
    const job = this.getJob(jobId);
    if (job.campaignId !== campaignId || !job.applicationId || job.status !== "preparing") {
      throw new Error("The retry cannot be rolled back from its current state.");
    }
    const updated = this.saveJob({
      ...job,
      status: "needs_input",
      blockers: job.blockers.map((blocker) => blocker.field === "submission-confirmation" && blocker.unit === "submission"
        ? { ...blocker, status: "open" as const, resolvedAt: undefined, value: undefined }
        : blocker),
      ...(job.execution ? { execution: { ...job.execution, status: "not_started", hostExecutionId: undefined, updatedAt: this.now() } } : {}),
      updatedAt: this.now(),
    });
    return updated;
  }

  /** Restore a one-shot submission-authority approval when host start was not accepted. */
  rollbackSubmissionAuthorityApproval(campaignId: string, jobId: string): CareerJob {
    const job = this.getJob(jobId);
    if (job.campaignId !== campaignId || job.status === "applied") throw new Error("The submission-authority approval cannot be rolled back from its current state.");
    const gate = job.blockers.find((blocker) => blocker.unit === "submission" && blocker.field === "submission_authority");
    if (!gate) throw new Error("The submission-authority blocker is not present.");
    return this.saveJob({
      ...job,
      status: "needs_input",
      blockers: job.blockers.map((blocker) => blocker.id === gate.id
        ? { ...blocker, status: "open" as const, resolvedAt: undefined, value: undefined }
        : blocker),
      updatedAt: this.now(),
    });
  }

  /** Reopen the same packet after the host's automatic-submission gate blocked before launch. */
  resumePreparationOnlyConfigurationBlocker(campaignId: string, jobId: string, submissionAuthority?: DurableSubmissionAuthority): CareerJob {
    const campaign = this.getCampaign(campaignId);
    const job = this.getJob(jobId);
    if (job.campaignId !== campaign.id || job.status !== "needs_input" || !job.applicationId) {
      throw new Error("Only the same needs-input application can resume preparation-only execution.");
    }
    const blocker = job.blockers.find((candidate) => candidate.status === "open" &&
      (candidate.field === "submission-authority" || candidate.field === "submission_authority") &&
      candidate.kind === "submission_approval" && candidate.questionProvenance === "CONFIGURATION");
    if (!blocker) throw new Error("The job has no exact execution-host configuration blocker.");
    const application = this.applicationService.getApplication(job.applicationId);
    if (application.status !== "ready_for_review") throw new Error("The application packet is not ready for preparation-only execution.");
    if (job.submissionProof || job.manualSubmissionConfirmation || application.submissionProof || application.manualSubmissionConfirmation) {
      throw new Error("Preparation-only recovery cannot reuse an application with submission proof.");
    }
    const execution = job.execution;
    if (!execution || execution.boundaries?.browserLaunched !== false || !execution.evidence.includes("submit:not-clicked")) {
      throw new Error("Preparation-only recovery requires proof that the browser never launched and submission was not clicked.");
    }
    if (!submissionAuthority) throw new Error("Preparation-only recovery requires the durable submission authority to verify no fence exists.");
    if (submissionAuthority.get(application.id, job.id)) throw new Error("Preparation-only recovery is unavailable after a submission fence was created.");
    const now = this.now();
    const resumed = this.saveJob({
      ...job,
      status: "preparing",
      blockers: job.blockers.map((candidate) => candidate.id === blocker.id
        ? { ...candidate, status: "resolved" as const, resolvedAt: now, value: "preparation_only_host_override" }
        : candidate),
      execution: {
        ...execution,
        status: "not_started",
        hostExecutionId: undefined,
        fieldsDetected: [],
        fieldsFilled: [],
        unresolvedFields: [],
        evidence: [...new Set([...execution.evidence, "execution:preparation-only-host-override"])],
        updatedAt: now,
      },
      updatedAt: now,
    });
    this.appendEvent(campaign.id, "application.execution_resumed", {
      ...careerEventMetadata(resumed),
      recovery: "preparation_only_host_configuration_override",
    });
    return resumed;
  }

  /**
   * Record the user's explicit confirmation after the browser reached the
   * manual Submit boundary. This is the only Career Agent path that turns a
   * ready-to-submit packet into Applied without executor submission proof.
   */
  async confirmManualApplication(campaignId: string, jobId: string, submissionAuthority?: DurableSubmissionAuthority): Promise<CareerJob> {
    const campaign = this.getCampaign(campaignId);
    const job = this.getJob(jobId);
    if (job.campaignId !== campaignId) throw new Error("That job does not belong to the selected campaign.");
    if (job.status === "applied") return job;
    const ambiguousBlocker = job.blockers.find((candidate) => candidate.status === "open" && candidate.kind === "external_verification" && candidate.unit === "submission" && candidate.field === "submission-confirmation" && candidate.resumeAfterHuman === false);
    const unknownRecovery = job.status === "needs_input" && Boolean(ambiguousBlocker);
    if (job.status !== "ready_to_submit" && !unknownRecovery) throw new Error("Only a prepared or explicitly unknown application stopped at the manual Submit boundary can be marked Applied.");
    if (!job.applicationId) throw new Error("The career job has no application packet to mark Applied.");

    const application = this.applicationService.getApplication(job.applicationId);
    if (unknownRecovery && (job.submissionProof || job.manualSubmissionConfirmation || application.submissionProof || application.manualSubmissionConfirmation)) {
      throw new Error("An unknown submission outcome with existing proof cannot be manually confirmed.");
    }
    if (application.status !== "ready_for_review") {
      throw new Error("The application packet must remain ready for review until manual submission is confirmed.");
    }
    if (unknownRecovery) {
      if (!submissionAuthority) throw new Error("Unknown automatic submission outcomes require the durable submission authority for explicit confirmation.");
      const fence = submissionAuthority.get(application.id, job.id);
      if (!fence) throw new Error("The durable submission fence for this application/job was not found.");
      submissionAuthority.confirmManual(fence, "application received successfully", this.now());
    }
    const appliedApplication = this.applicationService.recordManualSubmissionConfirmation(application.id, this.now());
    const evidence = appliedApplication.manualSubmissionConfirmation;
    if (!evidence) throw new Error("The manual submission confirmation was not persisted.");

    let applied = this.saveJob({
      ...job,
      status: "applied",
      manualSubmissionConfirmation: evidence,
      blockers: this.mergeBlockers(job, [], application.id).map((blocker) => ambiguousBlocker && blocker.id === ambiguousBlocker.id
        ? { ...blocker, status: "resolved" as const, resolvedAt: this.now(), value: "user_confirmed_external_success" }
        : blocker),
      trackerFailureReason: undefined,
      trackerSync: {
        status: "pending",
        attemptedAt: this.now(),
        updatedAt: this.now(),
      },
      updatedAt: this.now(),
    });
    this.appendEvent(campaign.id, "application.applied", careerEventMetadata(applied, undefined, "manual"));
    applied = await this.syncTrackerForAppliedJob(campaign, applied, appliedApplication, evidence, "tracker.update_started");
    return applied;
  }

  /** Correct an explicitly identified false manual-submission confirmation. */
  correctFalseManualSubmissionConfirmation(campaignId: string, jobId: string, reason = "The manual submission confirmation was recorded in error; no application was submitted."): CareerJob {
    const campaign = this.getCampaign(campaignId);
    const job = this.getJob(jobId);
    if (job.campaignId !== campaignId) throw new Error("That job does not belong to the selected campaign.");
    if (!job.applicationId || !["applied", "ready_to_submit", "needs_input"].includes(job.status) || !job.manualSubmissionConfirmation || job.submissionProof) {
      throw new Error("Only an Applied or inconsistent prepared job with manual confirmation and no submission proof can be corrected.");
    }
    const application = this.applicationService.getApplication(job.applicationId);
    const restoredApplication = this.applicationService.retractManualSubmissionConfirmation(job.applicationId, reason);
    const hasOpenBlocker = job.blockers.some((blocker) => blocker.status === "open");
    const restoredStatus: CareerJobStatus = job.status === "needs_input" || hasOpenBlocker ? "needs_input" : "ready_to_submit";
    const restored = this.saveJob({
      ...job,
      status: restoredStatus,
      manualSubmissionConfirmation: undefined,
      submissionProof: undefined,
      trackerRecordId: undefined,
      trackerFailureReason: undefined,
      trackerSync: undefined,
      decisionReason: reason,
      updatedAt: this.now(),
    });
    this.appendEvent(campaign.id, "application.failed", {
      ...careerEventMetadata(restored, undefined, reason),
      correction: "manual_submission_confirmation_retracted",
      previousApplicationStatus: application.status,
      restoredApplicationStatus: restoredApplication.status,
    });
    return restored;
  }

  /** Retry only the downstream tracker unit; the applied application is not regenerated. */
  async retryTrackerSync(campaignId: string, jobId: string): Promise<CareerJob> {
    const campaign = this.getCampaign(campaignId);
    const job = this.getJob(jobId);
    if (job.campaignId !== campaignId) throw new Error("That job does not belong to the selected campaign.");
    if (job.status !== "applied" || !job.applicationId) {
      throw new Error("Only an Applied application can retry tracker sync.");
    }
    const application = this.applicationService.getApplication(job.applicationId);
    const evidence = job.manualSubmissionConfirmation ?? job.submissionProof;
    if (!isAppliedEvidence(evidence) || !isApplicationApplied(application)) {
      throw new Error("Tracker retry requires persisted Applied evidence.");
    }
    return this.syncTrackerForAppliedJob(campaign, job, application, evidence, "tracker.retry_started");
  }

  private findAttentionRecord(eventId: string): { campaign: Campaign; record: PersistedAttentionEvent } | undefined {
    for (const campaign of this.careerRepository.listCampaigns()) {
      const record = campaign.attentionEvents?.find((candidate) => candidate.id === eventId);
      if (record) return { campaign, record };
    }
    return undefined;
  }

  private markAttentionEventsForJob(campaignId: string, jobId: string, status: "cancelled" | "expired"): void {
    const campaign = this.getCampaign(campaignId);
    const attentionEvents = campaign.attentionEvents ?? [];
    const updated = attentionEvents.map((event) =>
      event.jobId === jobId && event.status === "open" ? { ...event, status, resolvedAt: this.now() } : event,
    );
    if (updated.some((event, index) => event !== attentionEvents[index])) {
      this.careerRepository.saveCampaign({
        ...campaign,
        attentionEvents: updated,
        updatedAt: this.now(),
      });
    }
  }

  private async deliverAttentionRecord(record: PersistedAttentionEvent): Promise<boolean> {
    if (!this.notificationAdapter || record.status !== "open" || record.publishedAt) return false;
    let providerDelivery: Awaited<ReturnType<NotificationAdapter["publishAttentionEvent"]>>;
    try {
      providerDelivery = await this.notificationAdapter.publishAttentionEvent(publicAttentionEvent(record));
    } catch {
      // The durable open event remains unpublished so a later worker cycle can
      // retry it. Only bounded, non-sensitive delivery metadata is retained.
      const campaign = this.getCampaign(record.campaignId);
      const events = (campaign.attentionEvents ?? []).map((candidate) =>
        candidate.id === record.id
          ? {
              ...candidate,
              deliveryFailureCount: Math.min((candidate.deliveryFailureCount ?? 0) + 1, 1_000),
              lastDeliveryFailureAt: this.now(),
              lastDeliveryFailureCode: "provider_error" as const,
            }
          : candidate,
      );
      this.careerRepository.saveCampaign({
        ...campaign,
        attentionEvents: events,
        updatedAt: this.now(),
      });
      return false;
    }
    const campaign = this.getCampaign(record.campaignId);
    const events = (campaign.attentionEvents ?? []).map((candidate) =>
      candidate.id === record.id
        ? {
            ...candidate,
            ...(providerDelivery ? { providerDelivery } : {}),
            publishedAt: this.now(),
          }
        : candidate,
    );
    this.careerRepository.saveCampaign({
      ...campaign,
      attentionEvents: events,
      updatedAt: this.now(),
    });
    return true;
  }

  /**
   * Backfills a review-only draft onto an already-published exact ATS question.
   * The event is persisted first, then the existing notification is updated in
   * place so a restart never creates a duplicate Slack message or thread.
   */
  private async refreshPublishedAttentionDraft(record: PersistedAttentionEvent): Promise<boolean> {
    if (
      !this.notificationAdapter?.updateAttentionEvent ||
      record.status !== "open" ||
      !record.publishedAt ||
      record.type !== "needs_input" ||
      record.blockerType !== "subjective_answer" ||
      record.questionProvenance !== "ATS_FORM" ||
      !record.jobId ||
      !record.applicationId
    )
      return false;

    const job = this.careerRepository.getJob(record.jobId);
    if (!job || job.applicationId !== record.applicationId || job.status !== "needs_input") return false;
    const blocker = job.blockers.find((candidate) => candidate.id === record.blockerId && candidate.status === "open");
    if (!blocker) return false;
    const draft = record.draft ?? (await this.draftAtsAnswerForBlocker(job, blocker));
    if (!draft) return false;

    const campaign = this.getCampaign(record.campaignId);
    const current = campaign.attentionEvents?.find((candidate) => candidate.id === record.id);
    if (
      !current ||
      current.status !== "open" ||
      !current.publishedAt ||
      current.jobId !== record.jobId ||
      current.descriptorSignature !== record.descriptorSignature
    )
      return false;

    const enriched = current.draft ? current : { ...current, draft };
    if (!current.draft) {
      this.careerRepository.saveCampaign({
        ...campaign,
        attentionEvents: (campaign.attentionEvents ?? []).map((candidate) => (candidate.id === current.id ? enriched : candidate)),
        updatedAt: this.now(),
      });
    }
    try {
      await this.notificationAdapter.updateAttentionEvent(publicAttentionEvent(enriched));
      return true;
    } catch {
      return false;
    }
  }

  private async draftAtsAnswerForBlocker(job: CareerJob, blocker: CareerBlocker) {
    if (
      !this.applicationAnswerDraftGenerator ||
      blocker.unit !== "submission" ||
      blocker.kind !== "subjective_answer" ||
      questionProvenanceForBlocker(blocker) !== "ATS_FORM" ||
      !job.applicationId
    )
      return undefined;
    try {
      const application = this.applicationService.getApplication(job.applicationId);
      return await this.applicationAnswerDraftGenerator({
        question: blocker.question,
        field: blocker.field,
        job: job.job,
        profile: this.profile,
        resume: application.resume,
      });
    } catch {
      // Model unavailability or malformed model output must leave the exact
      // ATS question as a normal human-required blocker.
      return undefined;
    }
  }

  /**
   * Use the configured local model for exact ATS free-text questions when the
   * campaign explicitly permits grounded drafts. The inspected question is
   * passed to the model here, after the browser has seen the real form, so a
   * generic placeholder can never stand in for the employer's actual prompt.
   */
  private async autoResolveGroundedAtsBlockers(
    campaign: Campaign,
    job: CareerJob,
    drafts: readonly CareerBlockerDraft[],
  ): Promise<CareerJob> {
    if (!campaign.applicationPolicy.allowGroundedDrafts || !this.applicationAnswerDraftGenerator) return job;

    let current = job;
    for (const draft of drafts) {
      if (draft.unit !== "submission" || draft.kind !== "subjective_answer" || draft.questionProvenance !== "ATS_FORM") continue;
      const blocker = current.blockers.find(
        (candidate) => candidate.status === "open" && careerBlockerKey(candidate) === careerBlockerKey(draft),
      );
      if (!blocker) continue;
      const generated = await this.draftAtsAnswerForBlocker(current, blocker);
      if (!generated || !answerIsMeaningful(generated.answer)) continue;

      // Persist a resolved attention record even though no Slack prompt is
      // sent. This keeps the model answer auditable and lets a restarted
      // runtime resume the retained browser session safely.
      const currentCampaign = this.getCampaign(campaign.id);
      const hasOpenRecord = (currentCampaign.attentionEvents ?? []).some(
        (event) => event.status === "open" && event.jobId === current.id && event.blockerId === blocker.id,
      );
      if (!hasOpenRecord) {
        const generatedEvent = attentionEventForCareerBlocker({
          campaignId: campaign.id,
          jobId: current.id,
          blocker,
          postingCompensation: current.job.compensation,
          draft: generated,
          createdAt: blocker.createdAt,
          createId: this.createId,
        });
        if (generatedEvent) {
          this.careerRepository.saveCampaign({
            ...currentCampaign,
            attentionEvents: [...(currentCampaign.attentionEvents ?? []), generatedEvent.record],
            updatedAt: this.now(),
          });
        }
      }
      current = await this.resolveCareerBlocker(campaign.id, current.id, blocker.id, generated.answer, {
        deferResume: true,
        answerEvidence: [
          `answer-provider:${generated.provider}`,
          ...generated.evidence.map((evidence) => `answer-evidence:${evidence}`),
        ],
      });
    }
    return current;
  }

  private async publishAttentionForJob(campaign: Campaign, job: CareerJob): Promise<void> {
    const currentCampaign = this.getCampaign(campaign.id);
    const existing = currentCampaign.attentionEvents?.find((candidate) => candidate.jobId === job.id && candidate.status === "open");
    const blocker = this.nextAttentionBlocker(currentCampaign, job);
    if (existing) {
      if (!blocker) {
        this.markAttentionEventsForJob(campaign.id, job.id, "cancelled");
        return;
      }
      const currentSignature = attentionDescriptorSignature(blocker, job.job.compensation);
      if (currentSignature !== existing.descriptorSignature) {
        await this.replaceStaleAttentionEvent(currentCampaign, job, existing, blocker);
        return;
      }
      const refreshed = existing.blockerId === blocker.id ? existing : { ...existing, blockerId: blocker.id };
      if (refreshed !== existing) {
        this.careerRepository.saveCampaign({
          ...currentCampaign,
          attentionEvents: (currentCampaign.attentionEvents ?? []).map((candidate) =>
            candidate.id === existing.id ? refreshed : candidate,
          ),
          updatedAt: this.now(),
        });
      }
      await this.deliverAttentionRecord(refreshed);
      return;
    }

    if (!blocker) return;
    const draft = await this.draftAtsAnswerForBlocker(job, blocker);
    const generated = attentionEventForCareerBlocker({
      campaignId: campaign.id,
      jobId: job.id,
      blocker,
      postingCompensation: job.job.compensation,
      ...(draft ? { draft } : {}),
      createdAt: blocker.createdAt,
      createId: this.createId,
    });
    if (!generated) return;

    // Persist the durable event before attempting any external delivery.
    const next = {
      ...currentCampaign,
      attentionEvents: [...(currentCampaign.attentionEvents ?? []), generated.record],
      updatedAt: this.now(),
    };
    this.careerRepository.saveCampaign(next);
    await this.deliverAttentionRecord(generated.record);
  }

  /**
   * Return the next blocker that still needs a human answer. A blocker that
   * was explicitly resolved in attention history is not allowed to interrupt
   * a sequential review again if a browser reinspection re-materializes it.
   */
  private nextAttentionBlocker(campaign: Campaign, job: CareerJob): CareerBlocker | undefined {
    const previouslyResolved = new Set(
      (campaign.attentionEvents ?? [])
        .filter((event) => event.jobId === job.id && event.status === "resolved" && event.blockerId)
        .map((event) => event.blockerId as string),
    );
    return job.blockers.find(
      (candidate) =>
        candidate.status === "open" &&
        !previouslyResolved.has(candidate.id) &&
        attentionDescriptorSignature(candidate, job.job.compensation) !== undefined,
    );
  }

  /** Reconcile every remaining preparation blocker once per campaign cycle. */
  private async publishPendingPreparationAttention(campaignId: string): Promise<void> {
    await this.reconcileStaleAttentionEvents(campaignId);
    const openAttentionJobs = new Set(
      (this.getCampaign(campaignId).attentionEvents ?? [])
        .filter((event) => event.status === "open" && event.jobId)
        .map((event) => event.jobId),
    );
    const pendingJobs = this.listJobs(campaignId).filter(
      (job) =>
        job.status === "needs_input" &&
        !(job.execution?.mode === "real_local" && job.execution.hostExecutionId) &&
        !openAttentionJobs.has(job.id),
    );
    for (const job of pendingJobs) {
      await this.publishAttentionForJob(this.getCampaign(campaignId), job);
    }
  }

  /**
   * Close published attention records whose durable blocker was resolved or
   * reclassified before the next campaign cycle could publish a replacement.
   * This keeps old Slack messages from remaining actionable after policy or
   * execution state changes.
   */
  private async reconcileStaleAttentionEvents(campaignId: string): Promise<void> {
    const campaign = this.getCampaign(campaignId);
    const jobs = new Map(this.listJobs(campaignId).map((job) => [job.id, job] as const));
    const stale = (campaign.attentionEvents ?? []).filter((event) => {
      if (event.status !== "open" || !event.jobId || !event.blockerId) return false;
      const job = jobs.get(event.jobId);
      const blocker = job?.blockers.find((candidate) => candidate.id === event.blockerId && candidate.status === "open");
      return !job || job.status !== "needs_input" || !blocker ||
        attentionDescriptorSignature(blocker, job.job.compensation) !== event.descriptorSignature;
    });
    if (stale.length === 0) return;

    const now = this.now();
    const cancelled = stale.map((event) => ({
      ...event,
      status: "cancelled" as const,
      resolvedAt: now,
      closureReason: "reclassified_non_blocking" as const,
    }));
    const staleIds = new Set(cancelled.map((event) => event.id));
    this.careerRepository.saveCampaign({
      ...campaign,
      attentionEvents: (campaign.attentionEvents ?? []).map((event) =>
        staleIds.has(event.id) ? (cancelled.find((candidate) => candidate.id === event.id) ?? event) : event,
      ),
      updatedAt: now,
    });
    for (const event of cancelled) {
      try {
        await this.notificationAdapter?.closeAttentionEvent?.(publicAttentionEvent(event));
      } catch {
        // Durable cancellation is authoritative; notification closure is best effort.
      }
    }
  }

  private async recordAttentionResolution(
    campaign: Campaign,
    job: CareerJob,
    blocker: CareerBlocker,
    value: AnswerValue,
    suppliedResponse?: AttentionResponse,
  ): Promise<void> {
    const currentCampaign = this.getCampaign(campaign.id);
    const record = currentCampaign.attentionEvents?.find(
      (candidate) => candidate.jobId === job.id && candidate.blockerId === blocker.id && candidate.status === "open",
    );
    if (!record || record.type !== "needs_input" || !record.question) return;

    const rawValue = typeof value === "string" ? value.trim() : String(value);
    const option =
      record.question.kind === "free_text"
        ? { id: rawValue, label: rawValue }
        : record.question.options.find(
            (candidate) => candidate.id === rawValue || candidate.label.toLowerCase() === rawValue.toLowerCase(),
          );
    if (!option) return;
    const response =
      suppliedResponse ??
      ({
        eventId: record.id,
        selectedOption: option.id,
        actorIdentity: { provider: "web-ui", userId: "local" },
        respondedAt: this.now(),
      } satisfies AttentionResponse);
    const isDraftApproval = Boolean(
      record.draft && suppliedResponse && isDraftApprovalCommand(suppliedResponse.selectedOption) && rawValue === record.draft.answer,
    );
    if (!isAttentionResponse(response) || response.eventId !== record.id || (response.selectedOption !== option.id && !isDraftApproval))
      return;

    const resolved: PersistedAttentionEvent = {
      ...record,
      status: "resolved",
      resolvedAt: response.respondedAt,
      response,
      answerUsed: rawValue,
    };
    const updatedCampaign: Campaign = {
      ...currentCampaign,
      attentionEvents: (currentCampaign.attentionEvents ?? []).map((candidate) => (candidate.id === record.id ? resolved : candidate)),
      updatedAt: this.now(),
    };
    this.careerRepository.saveCampaign(updatedCampaign);
    try {
      await this.notificationAdapter?.closeAttentionEvent?.(publicAttentionEvent(resolved));
    } catch {
      // Closing a notification is best effort; the persisted resolution is authoritative.
    }
  }

  private async replaceStaleAttentionEvent(
    campaign: Campaign,
    job: CareerJob,
    record: PersistedAttentionEvent,
    blocker: CareerBlocker,
  ): Promise<void> {
    const currentCampaign = this.getCampaign(campaign.id);
    const cancelled = {
      ...record,
      status: "cancelled" as const,
      resolvedAt: this.now(),
    };
    const generated = attentionEventForCareerBlocker({
      campaignId: campaign.id,
      jobId: job.id,
      blocker,
      postingCompensation: job.job.compensation,
      createdAt: blocker.createdAt,
      createId: this.createId,
    });
    const attentionEvents = (currentCampaign.attentionEvents ?? []).map((candidate) =>
      candidate.id === record.id ? cancelled : candidate,
    );
    if (generated) attentionEvents.push(generated.record);
    this.careerRepository.saveCampaign({
      ...currentCampaign,
      attentionEvents,
      updatedAt: this.now(),
    });
    if (generated) await this.deliverAttentionRecord(generated.record);
  }

  /**
   * Persist the opaque execution-host ID and high-level state without
   * serializing any browser/session data into the career repository.
   */
  async recordExecutionHostSnapshot(campaignId: string, jobId: string, snapshot: ExecutionHostSnapshot): Promise<CareerJob> {
    const campaign = this.getCampaign(campaignId);
    const job = this.getJob(jobId);
    if (job.campaignId !== campaign.id) throw new Error("That job does not belong to the selected campaign.");
    if (snapshot.campaignId !== campaign.id || snapshot.jobId !== job.id) {
      throw new Error("The execution-host snapshot does not match the selected career job.");
    }
    if (!job.applicationId || snapshot.applicationId !== job.applicationId) {
      throw new Error("The execution-host snapshot does not match the application packet.");
    }

    // A host session can outlive the application lifecycle (for example, a
    // queued poll may deliver a stale `needs_input` or `ready_to_submit`
    // snapshot after manual confirmation completed).  Once both durable
    // layers carry Applied evidence, that older host is no longer authoritative
    // and must not reopen or downgrade the application.
    const application = this.applicationService.getApplication(job.applicationId);
    if (
      job.status === "applied" &&
      application.status === "applied" &&
      isAppliedEvidence(job.submissionProof ?? job.manualSubmissionConfirmation) &&
      isAppliedEvidence(application.submissionProof ?? application.manualSubmissionConfirmation)
    ) {
      return job;
    }

    const previousStatus = job.execution?.status;
    const status = snapshotStatusToCareerStatus(snapshot.status);
    const inspection = snapshot.inspection;
    const sameHostExecution = job.execution?.mode === "real_local" && job.execution.hostExecutionId === snapshot.id;

    // GET is intentionally idempotent. A page reload or a second poll may
    // observe the same terminal result; do not regenerate the packet or emit
    // duplicate audit events for an unchanged host snapshot.
    if (sameHostExecution && snapshot.result && previousStatus === status && this.hostResultAlreadyReconciled(campaign, job, snapshot)) {
      return job;
    }

    const marker = executionStateFromHostSnapshot(snapshot, job.execution, status);
    let marked = this.saveJob({
      ...job,
      status: careerJobStatusForHostStatus(status, job.status),
      execution: marker,
      // A new browser attempt replaces stale executor blockers (for example,
      // the unavailable placeholder from the browser-only UI). Preserve
      // blockers while the same host session is being resumed.
      blockers: sameHostExecution ? job.blockers : this.mergeBlockers(job, [], job.applicationId),
      updatedAt: this.now(),
    });

    if (job.execution?.hostExecutionId !== snapshot.id) {
      const hostExecutor =
        job.destinationResolution?.ats === "Greenhouse"
          ? "greenhouse-browser-executor"
          : job.destinationResolution?.ats === "Rippling"
            ? "rippling-browser-executor"
            : job.destinationResolution?.ats === "Ashby"
              ? "ashby-browser-executor"
            : job.destinationResolution?.ats === "Workday"
                ? "workday-browser-executor"
                : job.sourceRecordId?.startsWith("gusto:")
                  ? "gusto-browser-executor"
                  : "lever-browser-executor";
      this.appendEvent(campaign.id, "application.execution_host_started", {
        ...careerEventMetadata(marked),
        executionId: snapshot.id,
        mode: "real_local",
        ...(snapshot.attempt !== undefined ? { attempt: String(snapshot.attempt) } : {}),
      });
      this.appendEvent(campaign.id, "application.execution_started", {
        ...careerEventMetadata(marked),
        executor: hostExecutor,
        executionHost: "real_local",
      });
    }
    if (status === "resuming" && previousStatus !== "resuming") {
      this.appendEvent(campaign.id, "application.execution_resumed", {
        ...careerEventMetadata(marked),
        executionId: snapshot.id,
        ...(snapshot.attempt !== undefined ? { attempt: String(snapshot.attempt) } : {}),
        ...browserTelemetryMetadata(snapshot.telemetry),
      });
    }

    if (snapshot.result) {
      marked = await this.recordExecutionHostResult(campaign, marked, snapshot);
      if (snapshot.result.state === "requires_human" || snapshot.result.state === "unsupported") {
        this.appendEvent(campaign.id, "application.execution_paused", {
          ...careerEventMetadata(marked),
          executionId: snapshot.id,
          blocker:
            snapshot.result.state === "requires_human" ? snapshot.result.blocker.kind : (snapshot.result.blocker?.kind ?? "unsupported"),
        });
      }
      if (snapshot.result.state === "failed") {
        this.appendEvent(campaign.id, "application.execution_failed", {
          ...careerEventMetadata(marked),
          executionId: snapshot.id,
        });
      }
      return marked;
    }

    if (inspection) {
      this.appendEvent(campaign.id, "application.form_inspected", {
        ...careerEventMetadata(marked),
        fieldsDetected: String(inspection.fields.length),
        fieldsFilled: String(inspection.fieldsFilled.length),
        unresolvedFields: String(inspection.unresolvedFields.length),
        executionHost: "real_local",
        ...browserTelemetryMetadata(snapshot.telemetry),
      });
    }
    return marked;
  }

  /**
   * A host may keep returning the same result while its browser session is
   * waiting. A result is idempotent only after its current blocker has either
   * been resolved or has a matching open attention event. This distinction is
   * important when a resume advances from one real form question to the next:
   * the career job can already contain the next blocker before its attention
   * event has been published.
   */
  private hostResultAlreadyReconciled(
    campaign: Campaign,
    job: CareerJob,
    snapshot: ExecutionHostSnapshot,
  ): boolean {
    const result = snapshot.result;
    if (!result) return false;
    const drafts = result.state === "requires_human"
      ? [result.blocker, ...(result.blockers ?? [])]
      : result.state === "unsupported" && result.blocker
        ? [result.blocker]
        : [];
    const uniqueDrafts = [...new Map(
      drafts.filter(isCareerBlockerDraft).map((draft) => [careerBlockerKey(draft), draft] as const),
    ).values()];
    if (uniqueDrafts.length === 0) return true;

    return uniqueDrafts.every((draft) => {
      const current = job.blockers.find((candidate) => careerBlockerKey(candidate) === careerBlockerKey(draft));
      if (!current || current.status === "resolved") return Boolean(current);
      const signature = attentionDescriptorSignature(current, job.job.compensation);
      return Boolean(signature && (campaign.attentionEvents ?? []).some(
        (event) =>
          event.status === "open" &&
          event.jobId === job.id &&
          event.blockerId === current.id &&
          event.descriptorSignature === signature,
      ));
    });
  }

  /** Apply a terminal or blocker result returned by the local host. */
  private async recordExecutionHostResult(campaign: Campaign, careerJob: CareerJob, snapshot: ExecutionHostSnapshot): Promise<CareerJob> {
    if (!snapshot.result) return careerJob;
    const applicationId = careerJob.applicationId;
    if (!applicationId) throw new Error("A browser execution requires an application packet.");
    const reconciledJob = await this.reconcileNonBlockingCaptcha(careerJob, snapshot.inspection);
    const application = this.applicationService.getApplication(applicationId);
    const result = snapshot.result;
    const outcome = await this.executePreparedApplication(campaign, reconciledJob, application, {
      result,
      executionId: snapshot.id,
      hostStatus: snapshotStatusToCareerStatus(snapshot.status),
      ...(snapshot.manualSubmission ? { manualSubmission: true } : {}),
    });
    return outcome.careerJob ?? this.getJob(careerJob.id);
  }

  /**
   * A reinspection can prove that a previously blocking CAPTCHA is only
   * passive infrastructure. Close the stale attention event and blocker while
   * retaining both records and their Slack correlation, then let the current
   * form result publish the next real blocker if one exists.
   */
  private async reconcileNonBlockingCaptcha(job: CareerJob, inspection: ExecutionInspection | undefined): Promise<CareerJob> {
    const captchaState =
      inspection?.captcha?.state ??
      (inspection?.evidence.includes("captcha-state:infrastructure_present") ? "infrastructure_present" : undefined);
    if (captchaState !== "infrastructure_present") return job;

    const now = this.now();
    const staleBlockers = job.blockers.filter((blocker) => blocker.status === "open" && blocker.kind === "captcha");
    const reconciled =
      staleBlockers.length === 0
        ? job
        : this.saveJob({
            ...job,
            blockers: job.blockers.map((blocker) =>
              staleBlockers.some((stale) => stale.id === blocker.id)
                ? {
                    ...blocker,
                    status: "resolved" as const,
                    resolvedAt: blocker.resolvedAt ?? now,
                    reason: `${blocker.reason} Reclassified as non-blocking CAPTCHA infrastructure.`,
                    evidence: [...new Set([...blocker.evidence, "captcha-reclassified:infrastructure"])],
                  }
                : blocker,
            ),
            updatedAt: now,
          });

    const currentCampaign = this.getCampaign(job.campaignId);
    const staleEvents = (currentCampaign.attentionEvents ?? []).filter(
      (event) => event.jobId === job.id && event.status === "open" && event.blockerType === "captcha",
    );
    if (staleEvents.length === 0) return reconciled;

    const closureReason: AttentionClosureReason = "reclassified_non_blocking";
    const cancelled = staleEvents.map((event) => ({
      ...event,
      status: "cancelled" as const,
      resolvedAt: now,
      closureReason,
    }));
    const staleIds = new Set(cancelled.map((event) => event.id));
    this.careerRepository.saveCampaign({
      ...currentCampaign,
      attentionEvents: (currentCampaign.attentionEvents ?? []).map((event) =>
        staleIds.has(event.id) ? (cancelled.find((candidate) => candidate.id === event.id) ?? event) : event,
      ),
      updatedAt: now,
    });
    for (const event of cancelled) {
      try {
        await this.notificationAdapter?.closeAttentionEvent?.(publicAttentionEvent(event));
      } catch {
        // The durable cancellation is authoritative; notification closure is best effort.
      }
    }
    return reconciled;
  }

  recordExecutionHostCancelled(campaignId: string, jobId: string, executionId: string): CareerJob {
    const campaign = this.getCampaign(campaignId);
    const job = this.getJob(jobId);
    if (job.campaignId !== campaign.id || job.execution?.hostExecutionId !== executionId) {
      throw new Error("The execution cancellation does not match the selected career job.");
    }
    const updated = this.saveJob({
      ...job,
      status: "failed",
      decisionReason: "Local browser execution was cancelled; no application was submitted.",
      execution: {
        ...(job.execution ?? emptyCareerExecutionState(this.now())),
        mode: "real_local",
        hostExecutionId: executionId,
        status: "cancelled",
        failureReasonCode: "cancelled",
        evidence: [...(job.execution?.evidence ?? []), "execution:cancelled", "submit:not-clicked", "submission:manual-only"],
        updatedAt: this.now(),
      },
      updatedAt: this.now(),
    });
    this.markAttentionEventsForJob(campaign.id, updated.id, "cancelled");
    this.appendEvent(campaign.id, "application.execution_cancelled", {
      ...careerEventMetadata(updated),
      executionId,
    });
    return updated;
  }

  recordExecutionHostInterrupted(
    campaignId: string,
    jobId: string,
    executionId: string,
    reason = "The local browser host no longer has this execution session; no application was submitted.",
  ): CareerJob {
    const campaign = this.getCampaign(campaignId);
    const job = this.getJob(jobId);
    if (job.campaignId !== campaign.id || job.execution?.hostExecutionId !== executionId) {
      throw new Error("The interrupted execution does not match the selected career job.");
    }
    const updated = this.saveJob({
      ...job,
      status: "failed",
      decisionReason: reason,
      execution: {
        ...(job.execution ?? emptyCareerExecutionState(this.now())),
        mode: "real_local",
        hostExecutionId: executionId,
        status: "failed",
        failureReasonCode: "browser_interrupted",
        evidence: [
          ...new Set([...(job.execution?.evidence ?? []), "execution-host:unavailable", "submit:not-clicked", "submission:manual-only"]),
        ],
        updatedAt: this.now(),
      },
      updatedAt: this.now(),
    });
    this.markAttentionEventsForJob(campaign.id, updated.id, "expired");
    this.appendEvent(campaign.id, "application.execution_failed", {
      ...careerEventMetadata(updated),
      executionId,
      reason: "host_session_unavailable",
    });
    this.appendEvent(campaign.id, "campaign.review_needed", careerEventMetadata(updated, undefined, "host_session_unavailable"));
    return updated;
  }

  private applyStopConditions(campaign: Campaign): Campaign {
    if (campaign.status !== "active") return campaign;

    const now = this.now();
    if (campaign.stopConditions.maxDays !== undefined) {
      const ageMs = Date.parse(now) - Date.parse(campaign.createdAt);
      if (ageMs >= campaign.stopConditions.maxDays * 24 * 60 * 60 * 1000) {
        return this.completeCampaign(campaign.id, "max_days_reached");
      }
    }

    if (campaign.stopConditions.maxApplications !== undefined) {
      const appliedCount = this.careerRepository.listJobs(campaign.id).filter((job) => job.status === "applied").length;
      if (appliedCount >= campaign.stopConditions.maxApplications) {
        return this.completeCampaign(campaign.id, "max_applications_reached");
      }
    }

    return campaign;
  }

  private finishRun(
    campaignId: string,
    accumulator: RunAccumulator,
    trace?: ExecutionTraceBuilder,
    eventBaseline: ReadonlySet<string> = new Set(),
    previousTraceCompletedAt?: string,
  ): CampaignRunResult {
    // An application.created event is the canonical boundary at which a
    // policy-pursued job enters active application work. Deriving this from
    // the per-run event baseline makes retries and attention resumes
    // idempotent without requiring submission or a second counter.
    const pursuedJobIds = new Set(
      this.listEvents(campaignId)
        .filter((event) => !eventBaseline.has(event.id) && event.type === "application.created" && event.jobId)
        .map((event) => event.jobId),
    );
    const runTrace = trace
      ? (() => {
          const newAttentionEvents = this.listEvents(campaignId).filter((event) => !eventBaseline.has(event.id) && event.attention);
          const attentionByCategory = newAttentionEvents.reduce<Partial<Record<HumanAttentionCategory, number>>>((counts, event) => {
            const category = event.attentionCategory ?? attentionCategoryForEvent(event.type, event.metadata);
            if (category) counts[category] = (counts[category] ?? 0) + 1;
            return counts;
          }, {});
          trace.setHumanAttentionEvents(newAttentionEvents.length, attentionByCategory);
          trace.setHumanWaitDuration(
            humanWaitDurationSince(this.listJobs(campaignId), previousTraceCompletedAt ?? trace.startedAt, this.now()),
          );
          const completed = trace.finish(this.now());
          const campaign = this.getCampaign(campaignId);
          this.careerRepository.saveCampaign({
            ...campaign,
            lastRunTrace: completed,
            runHistory: [...(campaign.runHistory ?? []), completed].slice(-EXECUTION_RUN_HISTORY_LIMIT),
            updatedAt: this.now(),
          });
          return completed;
        })()
      : undefined;
    const snapshot = this.snapshot(campaignId);
    const openConfigurationAttentionCount = (snapshot.campaign.attentionEvents ?? []).filter(
      (event) => event.type === "configuration_required" && event.status === "open",
    ).length;
    return {
      snapshot,
      ...accumulator,
      pursued: pursuedJobIds.size,
      attentionRequired: snapshot.counts.needsYou + openConfigurationAttentionCount,
      ...(runTrace ? { trace: runTrace } : {}),
    };
  }

  private findExistingJob(scouted: ScoutedJob, jobs: readonly CareerJob[] = this.careerRepository.listJobs()): CareerJob | undefined {
    return jobs.find((candidate) => {
      const candidateKeys = candidate.dedupeKeys ?? jobDedupeKeys(candidate.job, candidate.sourceRecordId, candidate.sourceId);
      const candidateMode = candidate.sourceMode ?? (candidate.isExample ? "demo" : "live");
      return jobKeysMatch(scouted.sourceId, scouted.dedupeKeys, scouted.sourceMode, candidate.sourceId, candidateKeys, candidateMode);
    });
  }

  private mergeScoutedRecord(existing: CareerJob, incoming: ScoutedJob): CareerJob {
    const existingActionability = existing.actionability ?? "discoverable_only";
    const shouldPreferIncoming = incoming.actionability === "actionable" && existingActionability !== "actionable";
    const observations = new Map<string, JobSourceObservation>();
    for (const observation of existing.sourceObservations ?? []) {
      observations.set(
        JSON.stringify([
          observation.sourceId,
          observation.sourceRecordId ?? "",
          observation.sourceUrl ?? "",
          observation.applicationUrl ?? "",
        ]),
        observation,
      );
    }
    for (const observation of incoming.sourceObservations) {
      observations.set(
        JSON.stringify([
          observation.sourceId,
          observation.sourceRecordId ?? "",
          observation.sourceUrl ?? "",
          observation.applicationUrl ?? "",
        ]),
        observation,
      );
    }
    const incomingJob = incoming.job;
    const mergedJob: JobPosting = {
      ...existing.job,
      company: incomingJob.company || existing.job.company,
      title: incomingJob.title || existing.job.title,
      description: incomingJob.description || existing.job.description,
      ...(incomingJob.location ? { location: incomingJob.location } : {}),
      ...(incomingJob.remoteStatus ? { remoteStatus: incomingJob.remoteStatus } : {}),
      ...(incomingJob.employmentType ? { employmentType: incomingJob.employmentType } : {}),
      ...(incomingJob.compensation ? { compensation: incomingJob.compensation } : {}),
      ...(incomingJob.requiredSkills.length ? { requiredSkills: incomingJob.requiredSkills } : {}),
      ...(incomingJob.preferredSkills.length ? { preferredSkills: incomingJob.preferredSkills } : {}),
      ...(incomingJob.seniority ? { seniority: incomingJob.seniority } : {}),
      capturedAt: incomingJob.capturedAt,
    };
    const contextChanged = JSON.stringify(mergedJob) !== JSON.stringify(existing.job);
    const merged: CareerJob = {
      ...existing,
      ...(shouldPreferIncoming
        ? {
            isExample: incoming.isExample,
            sourceMode: incoming.sourceMode,
            actionability: incoming.actionability,
            fingerprint: incoming.fingerprint,
            sourceId: incoming.sourceId,
            ...(incoming.sourceRecordId ? { sourceRecordId: incoming.sourceRecordId } : {}),
            ...(incoming.sourcePublishedAt ? { sourcePublishedAt: incoming.sourcePublishedAt } : {}),
            ...(incoming.sourceExpiresAt ? { sourceExpiresAt: incoming.sourceExpiresAt } : {}),
            job: mergedJob,
          }
        : {}),
      ...(shouldPreferIncoming || contextChanged ? { job: mergedJob, updatedAt: this.now() } : {}),
      dedupeKeys: [...new Set([...(existing.dedupeKeys ?? []), ...incoming.dedupeKeys])],
      sourceObservations: [...observations.values()],
      ...(incoming.queueSelected !== undefined ? { queueSelected: incoming.queueSelected } : {}),
      ...(incoming.queueResumeFamily ? { queueResumeFamily: incoming.queueResumeFamily } : {}),
      ...(incoming.queueFit ? { queueFit: incoming.queueFit } : {}),
      ...(incoming.queuePriority ? { queuePriority: incoming.queuePriority } : {}),
      ...(shouldPreferIncoming ? { updatedAt: this.now() } : {}),
    };
    const dedupeKeysChanged = JSON.stringify(merged.dedupeKeys ?? []) !== JSON.stringify(existing.dedupeKeys ?? []);
    const observationsChanged = JSON.stringify(merged.sourceObservations ?? []) !== JSON.stringify(existing.sourceObservations ?? []);
    const queueMetadataChanged = incoming.queueSelected !== undefined || incoming.queueResumeFamily !== undefined || incoming.queueFit !== undefined || incoming.queuePriority !== undefined;
    if (shouldPreferIncoming || contextChanged || dedupeKeysChanged || observationsChanged || queueMetadataChanged) {
      const updated = shouldPreferIncoming ? merged : { ...merged, updatedAt: this.now() };
      this.saveJob(updated);
      return updated;
    }
    return merged;
  }

  private async reconsiderRejectedCuratedJob(
    campaign: Campaign,
    existing: CareerJob,
    destinationResolution: DestinationResolution,
    queueSelected = false,
    resumeFamily?: string,
    queueFit?: string,
    queuePriority?: string,
  ): Promise<CareerJob> {
    const hardFilter = applyHardFilters(existing.job, criteriaForQueueSelection(queueSelected ? { ...campaign.searchCriteria, employmentTypes: [] } : campaign.searchCriteria, queueSelected, resumeFamily),);
    if (hardFilter.decision === "reject") return existing;
    if (hardFilter.decision === "review") {
      return this.saveJob({
        ...existing,
        status: "held",
        decisionReason: hardFilter.reason,
        destinationResolution,
        updatedAt: this.now(),
      });
    }

    let fit: FitAssessment;
    try {
      fit = trustedQueueFitAssessment(await this.applicationService.assessJob(existing.job), queueSelected, queueFit, queuePriority, resumeFamily, this.profile);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Fit assessment failed.";
      const failed = this.saveJob({
        ...existing,
        destinationResolution,
        decisionReason: reason,
        updatedAt: this.now(),
      });
      this.appendEvent(campaign.id, "application.failed", careerEventMetadata(failed, undefined, reason));
      return failed;
    }

    const pursuit = decidePursuit(fit, campaign.fitPolicy);
    if (pursuit.decision !== "pursue") {
      const status = pursuit.decision === "reject" ? "rejected" : "held";
      return this.saveJob({
        ...existing,
        fit,
        status,
        destinationResolution,
        decisionReason: pursuit.reason,
        updatedAt: this.now(),
      });
    }

    let pursuing = this.saveJob({
      ...existing,
      fit,
      status: "pursuing",
      destinationResolution,
      decisionReason: undefined,
      updatedAt: this.now(),
    });
    if (!campaign.applicationPolicy.autoPrepare) {
      return this.saveJob({
        ...pursuing,
        status: "held",
        decisionReason: "Campaign application policy does not authorize automatic preparation.",
        updatedAt: this.now(),
      });
    }
    if (this.applicationCapReached(campaign, this.now())) {
      return this.saveJob({
        ...pursuing,
        status: "held",
        decisionReason: APPLICATION_CAP_HOLD_REASON,
        updatedAt: this.now(),
      });
    }

    const outcome = await this.prepareAndMaybeExecute(campaign, {
      ...pursuing,
      status: "preparing",
      applicationStartedAt: pursuing.applicationStartedAt ?? this.now(),
      updatedAt: this.now(),
    });
    if (outcome.careerJob) {
      pursuing = this.saveJob({
        ...outcome.careerJob,
        destinationResolution,
        updatedAt: this.now(),
      });
    } else {
      // Preparation persists its terminal/blocked state even when the
      // process outcome only carries a boolean marker (for example, a
      // preparation failure). Return that canonical record instead of
      // leaking the temporary `pursuing` state from before preparation.
      pursuing = this.getJob(existing.id);
    }
    return pursuing;
  }

  private async processScoutedJob(
    campaign: Campaign,
    scouted: ScoutedJob,
    trace?: ExecutionTraceBuilder,
    parentNodeId?: string,
  ): Promise<ProcessOutcome> {
    const createdAt = this.now();
    let careerJob: CareerJob = {
      id: this.createId("career-job"),
      campaignId: campaign.id,
      isExample: scouted.isExample,
      sourceMode: scouted.sourceMode,
      actionability: scouted.actionability,
      fingerprint: scouted.fingerprint,
      sourceId: scouted.sourceId,
      ...(scouted.sourceRecordId ? { sourceRecordId: scouted.sourceRecordId } : {}),
      ...(scouted.sourcePublishedAt ? { sourcePublishedAt: scouted.sourcePublishedAt } : {}),
      ...(scouted.sourceExpiresAt ? { sourceExpiresAt: scouted.sourceExpiresAt } : {}),
      dedupeKeys: [...scouted.dedupeKeys],
      sourceObservations: [...scouted.sourceObservations],
      ...(scouted.queueSelected !== undefined ? { queueSelected: scouted.queueSelected } : {}),
      ...(scouted.queueResumeFamily ? { queueResumeFamily: scouted.queueResumeFamily } : {}),
      ...(scouted.queueFit ? { queueFit: scouted.queueFit } : {}),
      ...(scouted.queuePriority ? { queuePriority: scouted.queuePriority } : {}),
      job: scouted.job,
      discoveredAt: scouted.discoveredAt,
      fit: null,
      status: "discovered",
      blockers: [],
      createdAt,
      updatedAt: createdAt,
    };
    const persistDiscovered = () => {
      this.careerRepository.saveJob(careerJob);
      this.appendEvent(campaign.id, "job.discovered", careerEventMetadata(careerJob));
      return careerJob;
    };
    careerJob = trace
      ? trace.measureSync(`job.persist-discovered.${careerJob.id}`, "persistence", persistDiscovered, {
          parentNodeId,
          inputCount: 1,
          outputCount: () => 1,
          metadata: { stage: "job.persist-discovered", jobId: careerJob.id },
        })
      : persistDiscovered();

    const hardFilter = trace
      ? trace.measureSync(
          `job.hard-filter.${careerJob.id}`,
          "deterministic",
          () => applyHardFilters(careerJob.job, criteriaForQueueSelection(scouted.queueSelected ? { ...campaign.searchCriteria, employmentTypes: [] } : campaign.searchCriteria, Boolean(scouted.queueSelected), scouted.queueResumeFamily)),
          {
            parentNodeId,
            inputCount: 1,
            outputCount: () => 1,
            outcome: (result) => (result.decision === "pass" ? "success" : "blocked"),
            failureReason: (result) => (result.decision === "pass" ? undefined : "policy_rejected"),
            metadata: { stage: "job.hard-filter", jobId: careerJob.id },
          },
        )
      : applyHardFilters(careerJob.job, criteriaForQueueSelection(scouted.queueSelected ? { ...campaign.searchCriteria, employmentTypes: [] } : campaign.searchCriteria, Boolean(scouted.queueSelected), scouted.queueResumeFamily));
    if (hardFilter.decision === "reject") {
      careerJob = this.decideJob(careerJob, "rejected", hardFilter.reason);
      this.appendEvent(campaign.id, "job.rejected", careerEventMetadata(careerJob, hardFilter));
      return { rejected: true };
    }
    if (hardFilter.decision === "review") {
      careerJob = this.decideJob(careerJob, "held", hardFilter.reason);
      this.appendEvent(campaign.id, "job.held", careerEventMetadata(careerJob, hardFilter));
      this.appendEvent(campaign.id, "campaign.review_needed", careerEventMetadata(careerJob, hardFilter));
      return { held: true };
    }

    let fit: FitAssessment;
    try {
      fit = trace
          ? await trace.measure(`job.fit.${careerJob.id}`, "judgment", () => this.applicationService.assessJob(careerJob.job).then((fit) => trustedQueueFitAssessment(fit, Boolean(scouted.queueSelected), scouted.queueFit, scouted.queuePriority, scouted.queueResumeFamily, this.profile)), {
            parentNodeId,
            inputCount: 1,
            outputCount: () => 1,
            metadata: { stage: "job.fit", jobId: careerJob.id },
          })
        : trustedQueueFitAssessment(await this.applicationService.assessJob(careerJob.job), Boolean(scouted.queueSelected), scouted.queueFit, scouted.queuePriority, scouted.queueResumeFamily, this.profile);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Fit assessment failed.";
      careerJob = this.decideJob(careerJob, "failed", reason);
      this.appendEvent(campaign.id, "application.failed", careerEventMetadata(careerJob, undefined, reason));
      this.appendEvent(campaign.id, "campaign.review_needed", careerEventMetadata(careerJob, undefined, reason));
      return { failure: true };
    }

    careerJob = this.saveJob({
      ...careerJob,
      fit,
      status: "pursuing",
      updatedAt: this.now(),
    });
    const pursuit = trace
      ? trace.measureSync(`job.pursuit-policy.${careerJob.id}`, "deterministic", () => decidePursuit(fit, campaign.fitPolicy), {
          parentNodeId,
          inputCount: 1,
          outputCount: () => 1,
          outcome: (result) => (result.decision === "pursue" ? "success" : "blocked"),
          failureReason: (result) => (result.decision === "pursue" ? undefined : "policy_rejected"),
          metadata: { stage: "job.pursuit-policy", jobId: careerJob.id },
        })
      : decidePursuit(fit, campaign.fitPolicy);
    if (pursuit.decision !== "pursue") {
      const status = pursuit.decision === "reject" ? "rejected" : "held";
      careerJob = this.decideJob(careerJob, status, pursuit.reason);
      this.appendEvent(
        campaign.id,
        status === "rejected" ? "job.rejected" : "job.held",
        careerEventMetadata(careerJob, undefined, pursuit.reason),
      );
      if (status === "held")
        this.appendEvent(campaign.id, "campaign.review_needed", careerEventMetadata(careerJob, undefined, pursuit.reason));
      return status === "rejected" ? { rejected: true } : { held: true };
    }

    if (!campaign.applicationPolicy.autoPrepare) {
      careerJob = this.decideJob(careerJob, "held", "Campaign application policy does not authorize automatic preparation.");
      this.appendEvent(campaign.id, "job.held", careerEventMetadata(careerJob, undefined, careerJob.decisionReason));
      this.appendEvent(campaign.id, "campaign.review_needed", careerEventMetadata(careerJob, undefined, careerJob.decisionReason));
      return { held: true };
    }

    if (this.applicationCapReached(campaign, this.now())) {
      careerJob = this.decideJob(careerJob, "held", APPLICATION_CAP_HOLD_REASON);
      this.appendEvent(campaign.id, "job.held", careerEventMetadata(careerJob, undefined, careerJob.decisionReason));
      return { held: true };
    }

    careerJob = await this.resolveDestinationForJob(careerJob, trace, parentNodeId);
    if (this.destinationResolver && careerJob.actionability !== "actionable" && careerJob.destinationResolution?.status !== "resolved") {
      return {};
    }

    const outcome = await this.prepareAndMaybeExecute(
      campaign,
      {
        ...careerJob,
        status: "preparing",
        applicationStartedAt: this.now(),
        updatedAt: this.now(),
      },
      trace,
      parentNodeId,
    );
    return { ...outcome, prepared: true };
  }

  private async resumeCapHeldJob(
    campaign: Campaign,
    job: CareerJob,
    trace?: ExecutionTraceBuilder,
    parentNodeId?: string,
  ): Promise<ProcessOutcome> {
    if (!job.fit || this.applicationCapReached(campaign, this.now())) return { held: true };
    const outcome = await this.prepareAndMaybeExecute(
      campaign,
      {
        ...job,
        status: "preparing",
        applicationStartedAt: this.now(),
        updatedAt: this.now(),
        decisionReason: undefined,
      },
      trace,
      parentNodeId,
    );
    return { ...outcome, prepared: true };
  }

  private async prepareAndMaybeExecute(
    campaign: Campaign,
    initialJob: CareerJob,
    trace?: ExecutionTraceBuilder,
    parentNodeId?: string,
  ): Promise<ProcessOutcome & { careerJob?: CareerJob }> {
    let careerJob = this.saveJob(initialJob);
    let application: Application | null = null;
    const preparationNodeId = `preparation.total.${careerJob.id}`;

    try {
      const created = trace
        ? await trace.measure(
            `job.application-create.${careerJob.id}`,
            "persistence",
            () => this.applicationService.createApplicationFromJob(careerJob.job, careerJob.isExample),
            {
              parentNodeId,
              inputCount: 1,
              outputCount: () => 1,
              metadata: {
                stage: "job.application-create",
                jobId: careerJob.id,
              },
            },
          )
        : await this.applicationService.createApplicationFromJob(careerJob.job, careerJob.isExample);
      application = created;
      careerJob = this.saveJob({
        ...careerJob,
        applicationId: created.id,
        updatedAt: this.now(),
      });
      this.appendEvent(campaign.id, "application.created", careerEventMetadata(careerJob));

      const evaluated = trace
        ? await trace.measure(
            `job.application-evaluate.${careerJob.id}`,
            "judgment",
            () => this.applicationService.evaluateApplication(created.id, careerJob.fit ?? undefined),
            {
              parentNodeId,
              inputCount: 1,
              outputCount: () => 1,
              metadata: {
                stage: "job.application-evaluate",
                jobId: careerJob.id,
              },
            },
          )
        : await this.applicationService.evaluateApplication(created.id, careerJob.fit ?? undefined);
      application = evaluated;
      careerJob = this.saveJob({
        ...careerJob,
        fit: evaluated.fit,
        updatedAt: this.now(),
      });
      this.appendEvent(campaign.id, "application.evaluated", careerEventMetadata(careerJob));

      const prepared = trace
        ? await trace.measure(
            preparationNodeId,
            "judgment",
            () =>
              this.applicationService.prepareApplication(evaluated.id, {
                trace,
                parentNodeId: preparationNodeId,
              }),
            {
              parentNodeId,
              inputCount: 1,
              outputCount: () => 1,
              outcome: (result) => (result.status === "needs_input" ? "blocked" : "success"),
              humanAttentionRequired: (result) => result.status === "needs_input",
              humanAttentionCategory: (result) =>
                result.status === "needs_input" ? humanAttentionCategoryForBlocker(result.blockers[0]) : undefined,
              metadata: {
                stage: "preparation.total",
                jobId: careerJob.id,
                applicationId: evaluated.id,
              },
            },
          )
        : await this.applicationService.prepareApplication(evaluated.id);
      application = prepared;
      this.appendEvent(
        campaign.id,
        "application.prepared",
        careerEventMetadata(careerJob, undefined, String(prepared.blockers.filter((blocker) => blocker.status === "open").length)),
      );

      const preparationDrafts = trace
        ? trace.measureSync(`preparation.validation.${careerJob.id}`, "deterministic", () => careerBlockerDraftsForApplication(prepared), {
            parentNodeId,
            inputCount: 1,
            outputCount: (value) => value.length,
            outcome: (value) => (value.length > 0 ? "blocked" : "success"),
            humanAttentionRequired: (value) => value.length > 0,
            humanAttentionCategory: (value) => (value.length > 0 ? humanAttentionCategoryForBlocker(value[0]) : undefined),
            metadata: {
              stage: "preparation.validation",
              jobId: careerJob.id,
            },
          })
        : careerBlockerDraftsForApplication(prepared);
      careerJob = this.saveJob({
        ...careerJob,
        status: preparationDrafts.length > 0 ? "needs_input" : "preparing",
        blockers: this.mergeBlockers(careerJob, preparationDrafts, prepared.id),
        updatedAt: this.now(),
      });

      if (preparationDrafts.length > 0) {
        this.appendEvent(
          campaign.id,
          "application.needs_input",
          careerEventMetadata(careerJob, undefined, String(preparationDrafts.length)),
        );
        this.appendEvent(campaign.id, "campaign.review_needed", careerEventMetadata(careerJob, undefined, "application_preparation"));
        await this.publishAttentionForJob(campaign, careerJob);
        return { blocked: true };
      }

      this.appendEvent(campaign.id, "application.ready_for_review", careerEventMetadata(careerJob));
      return this.executePreparedApplication(campaign, careerJob, application, {}, trace, parentNodeId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Application preparation failed.";
      if (application && application.status !== "applied" && application.status !== "failed") {
        try {
          this.applicationService.failApplication(application.id, reason);
        } catch {
          // The application state is already the more reliable record if it cannot transition.
        }
      }
      careerJob = this.saveJob({
        ...careerJob,
        status: "failed",
        decisionReason: reason,
        updatedAt: this.now(),
      });
      this.appendEvent(campaign.id, "application.failed", careerEventMetadata(careerJob, undefined, reason));
      this.appendEvent(campaign.id, "campaign.review_needed", careerEventMetadata(careerJob, undefined, reason));
      return { failure: true };
    }
  }

  private async resumeBlockedJob(
    campaign: Campaign,
    careerJob: CareerJob,
    trace?: ExecutionTraceBuilder,
    parentNodeId?: string,
  ): Promise<{ careerJob: CareerJob } & ProcessOutcome> {
    if (!careerJob.applicationId || careerJob.status === "applied") return { careerJob };

    let application: Application;
    try {
      application = this.applicationService.getApplication(careerJob.applicationId);
    } catch {
      const failed = this.saveJob({
        ...careerJob,
        status: "failed",
        decisionReason: "The persisted application packet could not be found.",
        updatedAt: this.now(),
      });
      this.appendEvent(campaign.id, "application.failed", careerEventMetadata(failed, undefined, failed.decisionReason));
      return { careerJob: failed, failure: true };
    }

    if (application.status === "needs_input") {
      const drafts = trace
        ? trace.measureSync(
            `preparation.blocker-evaluation.resume.${careerJob.id}`,
            "deterministic",
            () => careerBlockerDraftsForApplication(application),
            {
              parentNodeId,
              inputCount: 1,
              outputCount: (value) => value.length,
              metadata: {
                stage: "preparation.blocker-evaluation",
                jobId: careerJob.id,
              },
            },
          )
        : careerBlockerDraftsForApplication(application);
      const synchronized = this.saveJob({
        ...careerJob,
        status: drafts.length > 0 ? "needs_input" : careerJob.status,
        blockers: this.mergeBlockers(careerJob, drafts, application.id),
        updatedAt: this.now(),
      });
      if (drafts.length > 0) return { careerJob: synchronized, blocked: true };
      careerJob = synchronized;
    }

    if (application.status !== "ready_for_review") {
      return { careerJob };
    }

    const resumeAttempt = (careerJob.applicationResumeAttempt ?? 0) + 1;
    careerJob = this.saveJob({
      ...careerJob,
      applicationResumeAttempt: resumeAttempt,
      updatedAt: this.now(),
    });
    const resumed = await this.executePreparedApplication(campaign, careerJob, application, {}, trace, parentNodeId);
    return {
      careerJob: resumed.careerJob ?? careerJob,
      ...resumed,
      resumeAttempt,
    };
  }

  private async executePreparedApplication(
    campaign: Campaign,
    careerJob: CareerJob,
    application: Application,
    override: PreparedExecutionOverride = {},
    trace?: ExecutionTraceBuilder,
    parentNodeId?: string,
  ): Promise<ProcessOutcome & { careerJob?: CareerJob }> {
    // A restarted browser may rediscover ATS controls that were already
    // answered through Slack. Rehydrate those exact answers from the durable
    // resolved attention records before building the executor request, so the
    // new session replays them instead of reopening the same questions.
    careerJob = this.rehydrateResolvedAttentionAnswers(campaign, careerJob);
    const resolvedKinds = new Set(
      careerJob.blockers.filter((blocker) => blocker.status === "resolved").map((blocker) => careerBlockerKey(blocker)),
    );
    const executionRequest: ApplicationExecutionRequest = {
      campaign,
      careerJob,
      application,
      now: this.now(),
      profile: this.profile,
    };
    // A host result is already produced by the preparation-only browser
    // executor. Never invoke the local/injected executor a second time when a
    // transport result is being recorded.
    const preparationOnly =
      override.result !== undefined
        ? override.manualSubmission !== true && (override.result.state !== "submitted" || campaign.submissionPolicy.authority !== "automatic")
        : this.executor.executionMode?.(executionRequest) === "preparation_only";
    const gate = trace
      ? trace.measureSync(
          `execution.policy-check.${careerJob.id}`,
          "deterministic",
          () =>
            verifyPreparedApplication(
              application,
              campaign.applicationPolicy,
              campaign.submissionPolicy,
              campaign,
              resolvedKinds,
              preparationOnly,
            ),
          {
            parentNodeId,
            inputCount: 1,
            outputCount: (result) => result.blockers.length,
            outcome: (result) => (result.allowed ? "success" : "blocked"),
            humanAttentionRequired: (result) => !result.allowed,
            humanAttentionCategory: (result) => (result.allowed ? undefined : "policy_decision"),
            failureReason: (result) => (result.allowed ? undefined : "policy_rejected"),
            metadata: { stage: "execution.policy-check", jobId: careerJob.id },
          },
        )
      : verifyPreparedApplication(
          application,
          campaign.applicationPolicy,
          campaign.submissionPolicy,
          campaign,
          resolvedKinds,
          preparationOnly,
        );

    if (!gate.allowed) {
      const updated = this.saveJob({
        ...careerJob,
        status: "needs_input",
        blockers: this.mergeBlockers(careerJob, gate.blockers, application.id),
        updatedAt: this.now(),
      });
      this.appendEvent(campaign.id, "application.needs_input", careerEventMetadata(updated, undefined, String(gate.blockers.length)));
      this.appendEvent(campaign.id, "campaign.review_needed", careerEventMetadata(updated, undefined, gate.reason));
      return { careerJob: updated, blocked: true };
    }

    let ready = this.saveJob({
      ...careerJob,
      status: "ready_to_submit",
      blockers: this.mergeBlockers(careerJob, [], application.id),
      updatedAt: this.now(),
    });
    let readyEventEmitted = false;
    if (careerJob.status !== "ready_to_submit" && !preparationOnly) {
      this.appendEvent(campaign.id, "application.ready_to_submit", careerEventMetadata(ready));
      readyEventEmitted = true;
    }

    if (!override.result && (this.executor.inspect || preparationOnly)) {
      const executionStartedAt = this.now();
      const markHostStarted = () => {
        ready = this.saveJob({
          ...ready,
          execution: {
            status: "inspecting",
            fieldsDetected: [],
            fieldsFilled: [],
            unresolvedFields: [],
            evidence: [`executor:${this.executor.id}`, "submission:manual-only"],
            startedAt: executionStartedAt,
            updatedAt: executionStartedAt,
          },
          updatedAt: executionStartedAt,
        });
        this.appendEvent(campaign.id, "application.execution_started", {
          ...careerEventMetadata(ready),
          executor: this.executor.id,
        });
        return ready;
      };
      if (trace) {
        trace.measureSync(`execution.host-start.${careerJob.id}`, "persistence", markHostStarted, {
          parentNodeId,
          inputCount: 1,
          outputCount: () => 1,
          metadata: {
            stage: "execution.host-start",
            jobId: careerJob.id,
            executor: this.executor.id,
          },
        });
      } else {
        markHostStarted();
      }
    }

    let execution: ApplicationExecutorResult;
    try {
      if (override.result) {
        execution = override.result;
      } else {
        const request: ApplicationExecutionRequest = {
          ...executionRequest,
          careerJob: ready,
          now: this.now(),
        };
        execution = trace
          ? await trace.measure(`execution.lever-execute.${careerJob.id}`, "external_io", () => this.executor.execute(request), {
              parentNodeId,
              inputCount: 1,
              outputCount: () => 1,
              outcome: (result) =>
                result.state === "failed"
                  ? "failed"
                  : result.state === "ready_to_submit" || result.state === "submitted"
                    ? "success"
                    : "blocked",
              humanAttentionRequired: (result) => result.state !== "ready_to_submit" && result.state !== "submitted",
              humanAttentionCategory: (result) =>
                result.state === "requires_human"
                  ? humanAttentionCategoryForBlocker(result.blocker)
                  : result.state === "unsupported"
                    ? "unsupported_field"
                    : result.state === "failed"
                      ? "operational_failure"
                      : undefined,
              failureReason: (result) =>
                result.state === "failed"
                  ? executionFailureReason(result.reason)
                  : result.state === "requires_human"
                    ? "human_gate"
                    : result.state === "unsupported"
                      ? "validation_error"
                      : undefined,
              metadata: {
                stage: "execution.lever-execute",
                jobId: careerJob.id,
                executor: this.executor.id,
              },
            })
          : await this.executor.execute(request);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Application executor failed.";
      const failed = this.saveJob({
        ...ready,
        status: "failed",
        decisionReason: reason,
        updatedAt: this.now(),
      });
      this.failPreparedApplication(application, reason);
      this.appendEvent(campaign.id, "application.failed", careerEventMetadata(failed, undefined, reason));
      this.appendEvent(campaign.id, "campaign.review_needed", careerEventMetadata(failed, undefined, reason));
      return { careerJob: failed, failure: true };
    }

    const proofAuthorized =
      execution.state === "submitted" &&
      (override.manualSubmission === true || campaign.submissionPolicy.authority === "automatic" ||
        (campaign.submissionPolicy.authority === "simulated" && execution.proof.mode === "simulated"));
    if (execution.state === "submitted" && (preparationOnly || !proofAuthorized)) {
      const reason = "Submission proof was returned without an authorized automatic-submission policy; applied state was not recorded.";
      const failed = this.saveJob({
        ...ready,
        status: "failed",
        decisionReason: reason,
        updatedAt: this.now(),
      });
      this.failPreparedApplication(application, reason);
      this.appendEvent(campaign.id, "application.failed", careerEventMetadata(failed, undefined, "preparation_only_proof_rejected"));
      this.appendEvent(campaign.id, "campaign.review_needed", careerEventMetadata(failed, undefined, "preparation_only_proof_rejected"));
      return { careerJob: failed, failure: true };
    }

    if (execution.state === "requires_human") {
      const drafts = [
        ...new Map(
          [execution.blocker, ...(execution.blockers ?? [])]
            .filter(isCareerBlockerDraft)
            .map((draft) => [careerBlockerKey(draft), draft] as const),
        ).values(),
      ];
      if (drafts.length === 0) {
        const reason = "The executor returned a malformed human blocker; execution was stopped.";
        const failed = this.saveJob({
          ...ready,
          status: "failed",
          decisionReason: reason,
          updatedAt: this.now(),
        });
        this.failPreparedApplication(application, reason);
        this.appendEvent(campaign.id, "application.failed", careerEventMetadata(failed, undefined, reason));
        this.appendEvent(campaign.id, "campaign.review_needed", careerEventMetadata(failed, undefined, "malformed_executor_blocker"));
        return { careerJob: failed, failure: true };
      }
      let blocked = this.saveJob({
        ...ready,
        status: "needs_input",
        ...(execution.inspection
          ? {
              execution: careerExecutionState(
                execution.inspection,
                override.hostStatus ?? "needs_input",
                this.now(),
                override.executionId
                  ? {
                      mode: "real_local",
                      hostExecutionId: override.executionId,
                    }
                  : {},
              ),
            }
          : {}),
        blockers: this.mergeBlockers(ready, drafts, application.id),
        updatedAt: this.now(),
      });
      if (execution.inspection) {
        this.appendEvent(campaign.id, "application.form_inspected", {
          ...careerEventMetadata(blocked),
          fieldsDetected: String(execution.inspection.fields.length),
          fieldsFilled: String(execution.inspection.fieldsFilled.length),
          unresolvedFields: String(execution.inspection.unresolvedFields.length),
        });
      }

      blocked = await this.autoResolveGroundedAtsBlockers(campaign, blocked, drafts);
      const openDrafts = drafts.filter((draft) =>
        blocked.blockers.some((candidate) => candidate.status === "open" && careerBlockerKey(candidate) === careerBlockerKey(draft)),
      );
      if (openDrafts.length === 0) {
        if (blocked.execution?.mode === "real_local" && blocked.execution.hostExecutionId && this.resumeAttention) {
          await this.resumeAttention(campaign.id, blocked.id);
          return { careerJob: this.getJob(blocked.id) };
        }
        const resumed = await this.resumeBlockedJob(campaign, blocked, trace, parentNodeId);
        return resumed;
      }
      this.appendEvent(
        campaign.id,
        "application.needs_input",
        careerEventMetadata(blocked, undefined, openDrafts.map((draft) => draft.kind).join(",")),
      );
      this.appendEvent(campaign.id, "campaign.review_needed", careerEventMetadata(blocked, undefined, openDrafts[0].reason));
      await this.publishAttentionForJob(campaign, blocked);
      return { careerJob: blocked, blocked: true };
    }

    if (execution.state === "unsupported") {
      const fallbackBlocker: CareerBlockerDraft = {
        kind: "unknown_form_field",
        unit: "submission",
        questionProvenance: "POLICY",
        field: "application-form",
        question: "Supported application form",
        reason: execution.reason,
        evidence: [`executor:${this.executor.id}`, "submission:manual-only"],
        resumeAfterHuman: true,
      };
      const blocker = execution.blocker && isCareerBlockerDraft(execution.blocker) ? execution.blocker : fallbackBlocker;
      const unsupported = this.saveJob({
        ...ready,
        status: "needs_input",
        ...(execution.inspection
          ? {
              execution: careerExecutionState(
                execution.inspection,
                override.hostStatus ?? "needs_input",
                this.now(),
                override.executionId
                  ? {
                      mode: "real_local",
                      hostExecutionId: override.executionId,
                    }
                  : {},
              ),
            }
          : {}),
        blockers: this.mergeBlockers(ready, [blocker], application.id),
        updatedAt: this.now(),
      });
      if (execution.inspection) {
        this.appendEvent(campaign.id, "application.form_inspected", {
          ...careerEventMetadata(unsupported),
          fieldsDetected: String(execution.inspection.fields.length),
          fieldsFilled: String(execution.inspection.fieldsFilled.length),
          unresolvedFields: String(execution.inspection.unresolvedFields.length),
        });
      }
      this.appendEvent(campaign.id, "application.needs_input", careerEventMetadata(unsupported, undefined, blocker.kind));
      this.appendEvent(campaign.id, "campaign.review_needed", careerEventMetadata(unsupported, undefined, blocker.reason));
      await this.publishAttentionForJob(campaign, unsupported);
      return { careerJob: unsupported, blocked: true };
    }

    if (execution.state === "ready_to_submit") {
      const prepared = this.saveJob({
        ...ready,
        status: "ready_to_submit",
        execution: careerExecutionState(
          execution.inspection,
          override.hostStatus ?? "ready_to_submit",
          this.now(),
          override.executionId ? { mode: "real_local", hostExecutionId: override.executionId } : {},
        ),
        blockers: this.mergeBlockers(ready, [], application.id),
        updatedAt: this.now(),
      });
      if (!readyEventEmitted) {
        this.appendEvent(campaign.id, "application.ready_to_submit", careerEventMetadata(prepared));
      }
      this.appendEvent(campaign.id, "application.form_inspected", {
        ...careerEventMetadata(prepared),
        fieldsDetected: String(execution.inspection.fields.length),
        fieldsFilled: String(execution.inspection.fieldsFilled.length),
        unresolvedFields: String(execution.inspection.unresolvedFields.length),
      });
      return { careerJob: prepared };
    }

    if (execution.state === "failed") {
      const failed = this.saveJob({
        ...ready,
        status: "failed",
        ...(execution.inspection
          ? {
              execution: careerExecutionState(
                execution.inspection,
                override.hostStatus ?? "failed",
                this.now(),
                override.executionId
                  ? {
                      mode: "real_local",
                      hostExecutionId: override.executionId,
                    }
                  : {},
              ),
            }
          : {}),
        decisionReason: execution.reason,
        updatedAt: this.now(),
      });
      this.failPreparedApplication(application, execution.reason);
      this.appendEvent(campaign.id, "application.failed", careerEventMetadata(failed, undefined, execution.reason));
      if (execution.retryable)
        this.appendEvent(campaign.id, "campaign.review_needed", careerEventMetadata(failed, undefined, "retryable_executor_failure"));
      return { careerJob: failed, failure: true };
    }

    if (!isSubmissionProof(execution.proof)) {
      const reason = "The executor returned malformed submission proof; applied state was not recorded.";
      const failed = this.saveJob({
        ...ready,
        status: "failed",
        decisionReason: reason,
        updatedAt: this.now(),
      });
      this.failPreparedApplication(application, reason);
      this.appendEvent(campaign.id, "application.failed", careerEventMetadata(failed, undefined, reason));
      this.appendEvent(campaign.id, "campaign.review_needed", careerEventMetadata(failed, undefined, "malformed_submission_proof"));
      return { careerJob: failed, failure: true };
    }

    const submitted = this.saveJob({
      ...ready,
      status: "submitted",
      submissionProof: execution.proof,
      updatedAt: this.now(),
    });
    this.appendEvent(campaign.id, "application.submitted", careerEventMetadata(submitted, undefined, execution.proof.mode));

    let appliedApplication: Application;
    try {
      appliedApplication = this.applicationService.recordApplied(application.id, execution.proof);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "The submission proof could not be recorded.";
      const failed = this.saveJob({
        ...submitted,
        status: "failed",
        decisionReason: reason,
        updatedAt: this.now(),
      });
      this.appendEvent(campaign.id, "application.failed", careerEventMetadata(failed, undefined, reason));
      this.appendEvent(campaign.id, "campaign.review_needed", careerEventMetadata(failed, undefined, "submission_proof_recording"));
      return { careerJob: failed, failure: true };
    }

    let applied = this.saveJob({
      ...submitted,
      status: "applied",
      submissionProof: appliedApplication.submissionProof,
      blockers: this.mergeBlockers(submitted, [], application.id),
      trackerFailureReason: undefined,
      trackerSync: {
        status: "pending",
        attemptedAt: this.now(),
        updatedAt: this.now(),
      },
      updatedAt: this.now(),
    });
    this.appendEvent(campaign.id, "application.applied", careerEventMetadata(applied, undefined, execution.proof.mode));

    applied = await this.syncTrackerForAppliedJob(
      campaign,
      applied,
      appliedApplication,
      execution.proof,
      "tracker.update_started",
      trace,
      parentNodeId,
    );

    return { careerJob: applied, applied: true };
  }

  private rehydrateResolvedAttentionAnswers(campaign: Campaign, job: CareerJob): CareerJob {
    const resolved = (campaign.attentionEvents ?? []).filter((event) =>
      event.jobId === job.id && event.status === "resolved" &&
      event.answerUsed !== undefined && event.questionProvenance === "ATS_FORM",
    );
    if (resolved.length === 0) return job;
    let changed = false;
    const blockers = job.blockers.map((blocker) => {
      if (blocker.status === "resolved" && blocker.value !== undefined) return blocker;
      const signature = attentionDescriptorSignature(blocker, job.job.compensation);
      const event = resolved.find((candidate) => candidate.descriptorSignature === signature);
      if (!event) return blocker;
      changed = true;
      return {
        ...blocker,
        status: "resolved" as const,
        value: event.answerUsed,
        resolvedAt: blocker.resolvedAt ?? event.resolvedAt,
      };
    });
    return changed ? { ...job, blockers } : job;
  }

  /** Return the durable job shape that a fresh browser host must execute. */
  prepareJobForHostExecution(campaignId: string, jobId: string): CareerJob {
    const campaign = this.getCampaign(campaignId);
    const job = this.getJob(jobId);
    const prepared = this.rehydrateResolvedAttentionAnswers(campaign, job);
    return prepared === job ? job : this.saveJob({ ...prepared, updatedAt: this.now() });
  }

  private async syncTrackerForAppliedJob(
    campaign: Campaign,
    job: CareerJob,
    application: Application,
    evidence: SubmissionEvidence,
    startEvent: "tracker.update_started" | "tracker.retry_started",
    trace?: ExecutionTraceBuilder,
    parentNodeId?: string,
  ): Promise<CareerJob> {
    const attempt = (job.trackerSync?.attempt ?? 0) + 1;
    const pending = this.saveJob({
      ...job,
      trackerFailureReason: undefined,
      trackerSync: {
        status: "pending",
        attempt,
        attemptedAt: this.now(),
        updatedAt: this.now(),
      },
      updatedAt: this.now(),
    });
    this.appendEvent(campaign.id, startEvent, {
      ...careerEventMetadata(pending),
      tracker: this.tracker.id,
      attempt: String(attempt),
    });

    const update = trackerUpdateForJob(pending, evidence);
    const context = trackerSyncContextForJob(campaign, pending, application, evidence);
    const trackerStartedAt = monotonicNow();
    try {
      const record = () => this.tracker.recordApplied(update, context);
      const result = trace
        ? await trace.measure(`tracker.sync.${job.id}`, "external_io", record, {
            parentNodeId,
            attempt,
            retryReasonCode: startEvent === "tracker.retry_started" ? "tracker_failure" : undefined,
            previousOutcome: startEvent === "tracker.retry_started" ? "failed" : undefined,
            inputCount: 1,
            outputCount: () => 1,
            externalMetrics: (value) =>
              isJobTrackerResult(value)
                ? {
                    requestCount: value.simulated ? 0 : 1,
                    successCount: value.ok && !value.simulated ? 1 : 0,
                    failureCount: !value.ok && !value.simulated ? 1 : 0,
                  }
                : { requestCount: 1, successCount: 0, failureCount: 1 },
            metadata: {
              stage: startEvent === "tracker.retry_started" ? "tracker.retry" : "tracker.sync",
              jobId: job.id,
              tracker: this.tracker.id,
            },
          })
        : await record();
      if (isJobTrackerResult(result) && result.ok) {
        const synced = this.saveJob({
          ...pending,
          trackerRecordId: result.trackerRecordId,
          trackerFailureReason: undefined,
          trackerSync: {
            status: "synced",
            attempt,
            ...(pending.trackerSync?.attemptedAt ? { attemptedAt: pending.trackerSync.attemptedAt } : {}),
            updatedAt: this.now(),
            ...(result.trackerRecordId ? { trackerRecordId: result.trackerRecordId } : {}),
            durationMs: Math.max(0, Math.round(monotonicNow() - trackerStartedAt)),
            requestCount: 1,
            successCount: 1,
            failureCount: 0,
            timeoutCount: 0,
          },
          updatedAt: this.now(),
        });
        this.appendEvent(
          campaign.id,
          "tracker.updated",
          careerEventMetadata(synced, undefined, result.simulated ? "simulated" : "external"),
        );
        return synced;
      }
      const reason = isJobTrackerResult(result) ? (result.error ?? "Tracker update failed.") : "Tracker returned a malformed result.";
      return this.markTrackerSyncFailed(campaign, pending, reason, {
        durationMs: Math.max(0, Math.round(monotonicNow() - trackerStartedAt)),
        timeoutCount: 0,
      });
    } catch (error) {
      return this.markTrackerSyncFailed(campaign, pending, error instanceof Error ? error.message : "Tracker update failed.", {
        durationMs: Math.max(0, Math.round(monotonicNow() - trackerStartedAt)),
        timeoutCount: executionFailureReason(error) === "timeout" ? 1 : 0,
      });
    }
  }

  private markTrackerSyncFailed(
    campaign: Campaign,
    job: CareerJob,
    reason: string,
    telemetry: { durationMs: number; timeoutCount: number },
  ): CareerJob {
    const failed = this.saveJob({
      ...job,
      trackerRecordId: undefined,
      trackerFailureReason: reason,
      trackerSync: {
        status: "failed",
        ...(job.trackerSync?.attempt !== undefined ? { attempt: job.trackerSync.attempt } : {}),
        ...(job.trackerSync?.attemptedAt ? { attemptedAt: job.trackerSync.attemptedAt } : {}),
        updatedAt: this.now(),
        failureReason: reason,
        durationMs: telemetry.durationMs,
        requestCount: 1,
        successCount: 0,
        failureCount: 1,
        timeoutCount: telemetry.timeoutCount,
      },
      updatedAt: this.now(),
    });
    this.appendEvent(campaign.id, "tracker.failed", careerEventMetadata(failed, undefined, reason));
    this.appendEvent(campaign.id, "campaign.review_needed", careerEventMetadata(failed, undefined, "tracker_failure"));
    return failed;
  }

  private failPreparedApplication(application: Application, reason: string): void {
    if (application.status === "applied" || application.status === "failed") return;
    try {
      this.applicationService.failApplication(application.id, reason);
    } catch {
      // The career record and event still preserve the failure if the packet is terminal.
    }
  }

  private applicationCapReached(campaign: Campaign, at: string): boolean {
    const started = this.careerRepository.listJobs(campaign.id).filter((job) => job.applicationStartedAt !== undefined);
    const daily = started.filter((job) => sameUtcDay(job.applicationStartedAt ?? "", at)).length;
    if (daily >= campaign.dailyApplicationLimit) return true;
    const weekly =
      campaign.optionalWeeklyLimit === undefined ? 0 : started.filter((job) => sameUtcWeek(job.applicationStartedAt ?? "", at)).length;
    return campaign.optionalWeeklyLimit !== undefined && weekly >= campaign.optionalWeeklyLimit;
  }

  private decideJob(job: CareerJob, status: Extract<CareerJobStatus, "rejected" | "held" | "failed">, reason: string): CareerJob {
    return this.saveJob({
      ...job,
      status,
      decisionReason: reason,
      updatedAt: this.now(),
    });
  }

  private saveJob(job: CareerJob): CareerJob {
    this.careerRepository.saveJob(job);
    return job;
  }

  private async resolveDestinationForJob(job: CareerJob, trace?: ExecutionTraceBuilder, parentNodeId?: string): Promise<CareerJob> {
    if (!this.destinationResolver || job.actionability === "actionable") return job;
    const destinationResolver = this.destinationResolver;
    const resolve = () =>
      destinationResolver.resolve({
        company: job.job.company,
        role: job.job.title,
        ...(job.job.sourceUrl ? { knownListingUrl: job.job.sourceUrl } : {}),
        ...(job.job.applicationUrl ? { existingApplicationUrl: job.job.applicationUrl } : {}),
        existingApplicationActionable: job.actionability === "actionable",
        sourceObservations: job.sourceObservations ?? [],
      });
    let resolution: DestinationResolution;
    try {
      resolution = trace
        ? await trace.measure(`job.destination-resolution.${job.id}`, "external_io", resolve, {
            parentNodeId,
            inputCount: 1,
            outputCount: () => 1,
            outcome: (result) => (result.status === "resolved" ? "success" : result.status === "ambiguous" ? "blocked" : "skipped"),
            externalMetrics: () => ({ requestCount: 1, successCount: 1 }),
            metadata: { stage: "job.destination-resolution", jobId: job.id },
          })
        : await resolve();
    } catch {
      resolution = {
        status: "unresolved",
        attemptedAt: this.now(),
        evidence: ["destination-resolver:error"],
        reason: "The bounded destination resolver was unavailable; the pursued job remains available for retry.",
      };
    }

    if (resolution.status !== "resolved" || !resolution.destinationUrl || resolution.actionable !== true) {
      return this.saveJob({
        ...job,
        destinationResolution: resolution,
        updatedAt: this.now(),
      });
    }

    const updatedPosting = {
      ...job.job,
      applicationUrl: resolution.destinationUrl,
    };
    if (job.applicationId) {
      try {
        this.applicationService.updateApplicationJob(job.applicationId, updatedPosting);
      } catch {
        const unresolved: DestinationResolution = {
          status: "unresolved",
          attemptedAt: resolution.attemptedAt,
          evidence: [...resolution.evidence, "application-packet:update-failed"],
          reason:
            "The verified destination could not be synchronized to the application packet; the pursued job remains available for retry.",
        };
        return this.saveJob({
          ...job,
          destinationResolution: unresolved,
          updatedAt: this.now(),
        });
      }
    }
    return this.saveJob({
      ...job,
      actionability: "actionable",
      destinationResolution: resolution,
      job: updatedPosting,
      updatedAt: this.now(),
    });
  }

  private mergeBlockers(job: CareerJob, drafts: readonly CareerBlockerDraft[], applicationId?: string): readonly CareerBlocker[] {
    const now = this.now();
    const byKey = new Map(drafts.map((draft) => [careerBlockerKey(draft), draft]));
    const consumed = new Set<string>();
    const existing = job.blockers.map((current) => {
      const key = careerBlockerKey(current);
      const draft = byKey.get(key);
      if (!draft) {
        return current.status === "open"
          ? {
              ...current,
              status: "resolved" as const,
              resolvedAt: current.resolvedAt ?? now,
            }
          : current;
      }
      consumed.add(key);
      if (current.status === "resolved") {
        return {
          ...current,
          kind: draft.kind,
          unit: draft.unit,
          ...(draft.questionProvenance ? { questionProvenance: draft.questionProvenance } : {}),
          ...(draft.field ? { field: draft.field } : {}),
          question: draft.question,
          reason: draft.reason,
          evidence: [...draft.evidence],
          ...(draft.resumeAfterHuman !== undefined ? { resumeAfterHuman: draft.resumeAfterHuman } : {}),
          status: "open" as const,
          resolvedAt: undefined,
          value: undefined,
        };
      }
      return {
        ...current,
        ...(draft.questionProvenance ? { questionProvenance: draft.questionProvenance } : {}),
        question: draft.question,
        reason: draft.reason,
        evidence: [...draft.evidence],
      };
    });

    const created = drafts
      .filter((draft) => !consumed.has(careerBlockerKey(draft)))
      .map((draft): CareerBlocker => ({
        id: this.createId("career-blocker"),
        kind: draft.kind,
        unit: draft.unit,
        ...(draft.questionProvenance ? { questionProvenance: draft.questionProvenance } : {}),
        ...(draft.field ? { field: draft.field } : {}),
        question: draft.question,
        context: {
          jobId: job.id,
          ...(applicationId ? { applicationId } : job.applicationId ? { applicationId: job.applicationId } : {}),
          company: job.job.company,
          role: job.job.title,
          ...(job.job.sourceUrl ? { sourceUrl: job.job.sourceUrl } : {}),
          ...(job.job.applicationUrl ? { applicationUrl: job.job.applicationUrl } : {}),
        },
        reason: draft.reason,
        evidence: [...draft.evidence],
        ...(draft.resumeAfterHuman !== undefined ? { resumeAfterHuman: draft.resumeAfterHuman } : {}),
        status: "open",
        createdAt: now,
      }));

    return [...existing, ...created];
  }

  private appendEvent(
    campaignId: string,
    type: CareerEventType,
    metadata?: Readonly<Record<string, string>>,
    jobId?: string,
    applicationId?: string,
  ): void {
    const attentionCategory = attentionCategoryForEvent(type, metadata);
    const event: CareerEvent = {
      id: this.createId("career-event"),
      type,
      campaignId,
      ...(jobId || metadata?.jobId ? { jobId: jobId ?? metadata?.jobId } : {}),
      ...(applicationId || metadata?.applicationId ? { applicationId: applicationId ?? metadata?.applicationId } : {}),
      occurredAt: this.now(),
      attention: isAttentionWorthyEvent(type),
      ...(attentionCategory ? { attentionCategory } : {}),
      ...(metadata ? { metadata } : {}),
    };
    this.careerRepository.appendEvent(event);
  }
}

export function createCareerAgentService(
  profile: CandidateProfile,
  dependencies: CareerAgentDependencies = {},
  options: CareerAgentServiceOptions = {},
): CareerAgentService {
  return new CareerAgentService(profile, dependencies, options);
}

function careerEventMetadata(job: CareerJob, filter?: HardFilterResult, reason?: string): Readonly<Record<string, string>> {
  return metadataFrom([
    ["jobId", job.id],
    ["company", job.job.company],
    ["role", job.job.title],
    ["source", job.sourceId],
    ["actionability", job.actionability ?? "discoverable_only"],
    ["applicationUrl", job.job.applicationUrl ? "present" : "absent"],
    ...(job.applicationId ? [["applicationId", job.applicationId] as [string, string]] : []),
    ...(job.fit ? [["fit", job.fit.classification] as [string, string]] : []),
    ...(filter ? [["filterDecision", filter.decision] as [string, string]] : []),
    ...(reason ? [["reason", reason] as [string, string]] : []),
  ]);
}

function humanWaitDurationSince(jobs: readonly CareerJob[], since: string, until: string): number {
  const sinceMs = Date.parse(since);
  const untilMs = Date.parse(until);
  if (Number.isNaN(sinceMs) || Number.isNaN(untilMs)) return 0;
  return jobs.reduce(
    (total, job) =>
      total +
      job.blockers.reduce((jobTotal, blocker) => {
        if (blocker.status !== "resolved" || !blocker.resolvedAt) return jobTotal;
        const createdMs = Date.parse(blocker.createdAt);
        const resolvedMs = Date.parse(blocker.resolvedAt);
        if (Number.isNaN(createdMs) || Number.isNaN(resolvedMs) || resolvedMs <= sinceMs || resolvedMs > untilMs) return jobTotal;
        return jobTotal + Math.max(0, resolvedMs - Math.max(createdMs, sinceMs));
      }, 0),
    0,
  );
}

function browserTelemetryMetadata(telemetry: ExecutionHostSnapshot["telemetry"]): Readonly<Record<string, string>> {
  if (!telemetry) return {};
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(telemetry)) {
    if (typeof value === "number" && Number.isFinite(value)) entries.push([key, String(Math.round(value))]);
  }
  return metadataFrom(entries);
}
