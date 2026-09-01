import {
  applyHardFilters,
  careerBlockerDraftsForApplication,
  careerBlockerKey,
  decidePursuit,
  verifyPreparedApplication,
  type HardFilterResult,
} from "../domain/policies";
import { assertCampaignTransition } from "../domain/campaignLifecycle";
import { createApplicationService, type ApplicationService } from "./applicationService";
import { attentionCategoryForEvent, isAttentionWorthyEvent } from "../domain/notifications";
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
} from "../domain/types";
import type {
  ExecutionHostSnapshot,
} from "../domain/executionHostTypes";
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
import { jobSourceConfigId } from "../domain/campaignTypes";
import {
  getDefaultCareerRepository,
  type CareerRepository,
} from "../persistence/careerRepository";
import type { ApplicationExecutor, ExecutionInspection } from "../domain/executor";
import {
  UnavailableApplicationExecutor,
  type ApplicationExecutionRequest,
  type ApplicationExecutorResult,
} from "../domain/executor";
import { JobScout, jobDedupeKeys, jobKeysMatch, type ScoutedJob } from "../domain/scout";
import {
  UnavailableJobTracker,
  isJobTrackerResult,
  trackerSyncContextForJob,
  trackerUpdateForJob,
  type SubmissionEvidence,
  type JobTracker,
} from "../domain/tracker";
import { isAppliedEvidence, isSubmissionProof } from "../domain/validation";

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
}

interface RunAccumulator {
  discovered: number;
  alreadySeen: number;
  alreadyApplied: number;
  pursued: number;
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
  stretch: "hold",
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
      return { type: "greenhouse", board, ...(company ? { company } : {}), ...(id ? { id } : {}) };
    }
    if (config.type !== "remotive" && config.type !== "brave_search" && config.type !== "demo") {
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
    pursued: 0,
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

function jobNeedsAttention(job: CareerJob): boolean {
  return job.blockers.some((blocker) => blocker.status === "open") ||
    job.status === "held" ||
    job.status === "ready_to_submit" ||
    job.status === "failed" ||
    job.trackerSync?.status === "pending" ||
    Boolean(job.trackerFailureReason);
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
  return kinds.has(candidate.kind as string) &&
    units.has(candidate.unit as string) &&
    (candidate.field === undefined || (typeof candidate.field === "string" && candidate.field.trim().length > 0)) &&
    typeof candidate.question === "string" && candidate.question.trim().length > 0 &&
    typeof candidate.reason === "string" && candidate.reason.trim().length > 0 &&
    Array.isArray(candidate.evidence) && candidate.evidence.every((item) => typeof item === "string") &&
    (candidate.resumeAfterHuman === undefined || typeof candidate.resumeAfterHuman === "boolean");
}

function humanAttentionCategoryForBlocker(
  blocker: { kind?: CareerBlockerDraft["kind"]; field?: string } | undefined,
): HumanAttentionCategory {
  const kind = blocker?.kind ?? blocker?.field?.toLowerCase();
  switch (kind) {
    case "captcha": return "captcha";
    case "external_login": return "login";
    case "external_verification": return "mfa";
    case "subjective_answer": return "subjective_answer";
    case "resume_missing":
    case "required_file_missing": return "resume_artifact_missing";
    case "unknown_form_field":
    case "unsupported_widget": return "unsupported_field";
    case "submission_approval": return "manual_submission";
    case "why_company":
    case "cover_letter": return "subjective_answer";
    default: return "candidate_fact_missing";
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

function snapshotStatusToCareerStatus(
  status: ExecutionHostSnapshot["status"],
): CareerExecutionState["status"] {
  return status;
}

function careerJobStatusForHostStatus(
  status: CareerExecutionState["status"],
  current: CareerJobStatus,
): CareerJobStatus {
  if (status === "needs_input" || status === "waiting_for_human") return "needs_input";
  if (status === "ready_to_submit") return "ready_to_submit";
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
    "submit:not-clicked",
    "submission:manual-only",
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
    ...(snapshot.attempt !== undefined ? { attempt: snapshot.attempt } : previous?.attempt !== undefined ? { attempt: previous.attempt } : {}),
    ...(snapshot.retryReasonCode ? { retryReasonCode: snapshot.retryReasonCode } : previous?.retryReasonCode ? { retryReasonCode: previous.retryReasonCode } : {}),
    ...(snapshot.failureReasonCode
      ? { failureReasonCode: snapshot.failureReasonCode }
      : status === "ready_to_submit" ? {} : previous?.failureReasonCode ? { failureReasonCode: previous.failureReasonCode } : {}),
    ...(snapshot.telemetry ? { telemetry: snapshot.telemetry } : previous?.telemetry ? { telemetry: previous.telemetry } : {}),
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

export class CareerAgentService {
  private readonly now: () => string;
  private readonly createId: (prefix: string) => string;
  private readonly applicationService: ApplicationService;
  private readonly careerRepository: CareerRepository;
  private readonly scout: JobScout;
  private readonly executor: ApplicationExecutor;
  private readonly tracker: JobTracker;

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
  }

  listCampaigns(): readonly Campaign[] {
    return [...this.careerRepository.listCampaigns()].sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    );
  }

  getCampaign(campaignId: string): Campaign {
    const campaign = this.careerRepository.getCampaign(campaignId);
    if (!campaign) throw new CampaignNotFoundError(campaignId);
    return campaign;
  }

  listJobs(campaignId?: string): readonly CareerJob[] {
    return [...this.careerRepository.listJobs(campaignId)].sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    );
  }

  getJob(jobId: string): CareerJob {
    const job = this.careerRepository.getJob(jobId);
    if (!job) throw new CareerJobNotFoundError(jobId);
    return job;
  }

  getApplication(applicationId: string): Application {
    return this.applicationService.getApplication(applicationId);
  }

  listEvents(campaignId: string): readonly CareerEvent[] {
    return [...this.careerRepository.listEvents(campaignId)].sort(
      (left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt),
    );
  }

  createCampaign(input: CreateCampaignInput): Campaign {
    if (input.searchCriteria?.minimumSalary !== undefined &&
      (!Number.isFinite(input.searchCriteria.minimumSalary) || input.searchCriteria.minimumSalary < 0)) {
      throw new Error("Minimum salary must be a non-negative finite number.");
    }
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
      searchCriteria: {
        ...DEFAULT_SEARCH_CRITERIA,
        ...(input.searchCriteria?.roleLanes ? { roleLanes: cleanList(input.searchCriteria.roleLanes) } : {}),
        ...(input.searchCriteria?.searchQueries ? { searchQueries: cleanList(input.searchCriteria.searchQueries) } : {}),
        ...(input.searchCriteria?.locations ? { locations: cleanList(input.searchCriteria.locations) } : {}),
        ...(input.searchCriteria?.remoteOnly !== undefined ? { remoteOnly: input.searchCriteria.remoteOnly } : {}),
        ...(input.searchCriteria?.employmentTypes ? { employmentTypes: cleanList(input.searchCriteria.employmentTypes) } : {}),
        ...(input.searchCriteria?.minimumSalary !== undefined ? { minimumSalary: input.searchCriteria.minimumSalary } : {}),
        ...(input.searchCriteria?.excludedSeniorities ? { excludedSeniorities: cleanList(input.searchCriteria.excludedSeniorities) } : {}),
        ...(input.searchCriteria?.excludedCompanies ? { excludedCompanies: cleanList(input.searchCriteria.excludedCompanies) } : {}),
      },
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
        ...(input.applicationPolicy?.allowGroundedDrafts !== undefined ? { allowGroundedDrafts: input.applicationPolicy.allowGroundedDrafts } : {}),
        ...(input.applicationPolicy?.approvedResumeFamilies
          ? { approvedResumeFamilies: [...input.applicationPolicy.approvedResumeFamilies] }
          : {}),
      },
      submissionPolicy: {
        ...DEFAULT_SUBMISSION_POLICY,
        ...(input.submissionPolicy?.authority !== undefined ? { authority: input.submissionPolicy.authority } : {}),
        ...(input.submissionPolicy?.requireExplicitApproval !== undefined
          ? { requireExplicitApproval: input.submissionPolicy.requireExplicitApproval }
          : {}),
        ...(input.submissionPolicy?.allowedAts
          ? { allowedAts: cleanList(input.submissionPolicy.allowedAts) }
          : {}),
      },
      dailyApplicationLimit: positiveInteger(input.dailyApplicationLimit, 3, "Daily application limit"),
      ...(input.optionalWeeklyLimit !== undefined
        ? { optionalWeeklyLimit: optionalPositiveInteger(input.optionalWeeklyLimit, "Weekly application limit") }
        : {}),
      reviewConditions: {
        ...DEFAULT_REVIEW_CONDITIONS,
        ...(input.reviewConditions?.unusualTerms !== undefined ? { unusualTerms: input.reviewConditions.unusualTerms } : {}),
        ...(input.reviewConditions?.authenticationRequired !== undefined
          ? { authenticationRequired: input.reviewConditions.authenticationRequired }
          : {}),
        ...(input.reviewConditions?.unknownFacts !== undefined ? { unknownFacts: input.reviewConditions.unknownFacts } : {}),
        ...(input.reviewConditions?.subjectiveAnswers !== undefined
          ? { subjectiveAnswers: input.reviewConditions.subjectiveAnswers }
          : {}),
      },
      stopConditions: {
        ...DEFAULT_STOP_CONDITIONS,
        ...(input.stopConditions?.stopOnAcceptedOffer !== undefined
          ? { stopOnAcceptedOffer: input.stopConditions.stopOnAcceptedOffer }
          : {}),
        ...(input.stopConditions?.maxApplications !== undefined
          ? { maxApplications: optionalPositiveInteger(input.stopConditions.maxApplications, "Maximum applications") }
          : {}),
        ...(input.stopConditions?.maxDays !== undefined
          ? { maxDays: optionalPositiveInteger(input.stopConditions.maxDays, "Maximum campaign days") }
          : {}),
        ...(input.stopConditions?.systemicFailureLimit !== undefined
          ? { systemicFailureLimit: positiveInteger(input.stopConditions.systemicFailureLimit, 1, "Systemic failure limit") }
          : {}),
      },
      consecutiveSystemicFailures: 0,
      createdAt,
      updatedAt: createdAt,
    };

    if (!isPursuitDecision(campaign.fitPolicy.strong) ||
      !isPursuitDecision(campaign.fitPolicy.good) ||
      !isPursuitDecision(campaign.fitPolicy.stretch) ||
      !isPursuitDecision(campaign.fitPolicy.weak)) {
      throw new Error("Campaign fit policy contains an unsupported pursuit decision.");
    }
    if (!isSubmissionAuthority(campaign.submissionPolicy.authority)) {
      throw new Error("Campaign submission policy contains an unsupported authority.");
    }

    this.careerRepository.saveCampaign(campaign);
    this.appendEvent(campaign.id, "campaign.created", metadataFrom([
      ["status", campaign.status],
      ["sourceCount", String(campaign.searchSources.length)],
    ]));
    return campaign;
  }

  activateCampaign(campaignId: string): Campaign {
    const campaign = this.getCampaign(campaignId);
    if (campaign.status === "active") return campaign;
    assertCampaignTransition(campaign.status, "active");
    const updated = { ...campaign, status: "active" as const, updatedAt: this.now() };
    this.careerRepository.saveCampaign(updated);
    this.appendEvent(campaignId, "campaign.started");
    return updated;
  }

  pauseCampaign(campaignId: string): Campaign {
    const campaign = this.getCampaign(campaignId);
    if (campaign.status === "paused") return campaign;
    assertCampaignTransition(campaign.status, "paused");
    const updated = { ...campaign, status: "paused" as const, updatedAt: this.now() };
    this.careerRepository.saveCampaign(updated);
    this.appendEvent(campaignId, "campaign.paused");
    return updated;
  }

  completeCampaign(campaignId: string, reason = "campaign_completed"): Campaign {
    const campaign = this.getCampaign(campaignId);
    if (campaign.status === "completed") return campaign;
    assertCampaignTransition(campaign.status, "completed");
    const updated = { ...campaign, status: "completed" as const, updatedAt: this.now() };
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
    const updated = { ...campaign, status: "failed" as const, updatedAt: this.now() };
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
      worthPursuing: todayJobs.filter((job) => ["pursuing", "preparing", "needs_input", "ready_to_submit", "submitted", "applied"].includes(job.status)).length,
      prepared: todayJobs.filter((job) => ["preparing", "needs_input", "ready_to_submit", "submitted", "applied"].includes(job.status)).length,
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
    const trace = new ExecutionTraceBuilder(
      this.createId("execution-run"),
      "campaign_run",
      this.now,
      runStartedAt,
    );
    const previousTraceCompletedAt = campaign.lastRunTrace?.completedAt;
    const finish = (): CampaignRunResult => this.finishRun(
      campaignId,
      accumulator,
      trace,
      eventBaseline,
      previousTraceCompletedAt,
    );

    if (campaign.status !== "active") {
      return finish();
    }

    campaign = this.applyStopConditions(campaign);
    if (campaign.status !== "active") {
      return finish();
    }

    for (const job of this.listJobs(campaignId).filter((candidate) => candidate.status === "needs_input")) {
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
          outcome: (result) => result.failure ? "failed" : result.careerJob.status === "needs_input" ? "blocked" : "success",
          humanAttentionRequired: (result) => result.careerJob.status === "needs_input",
          humanAttentionCategory: (result) => result.careerJob.status === "needs_input" ? "candidate_fact_missing" : undefined,
          attempt: resumeAttempt,
          ...(resumeAttempt > 1 ? { retryReasonCode: "blocker" as const, previousOutcome: "blocked" as const } : {}),
          metadata: { jobId: job.id, stage: "preparation.resume" },
        },
      );
      if (outcome.applied) accumulator.applied += 1;
      if (outcome.failure) accumulator.failures += 1;
      campaign = this.getCampaign(campaignId);
      if (campaign.status !== "active") return finish();
    }

    this.appendEvent(campaignId, "job.discovery_started", metadataFrom([
      ["sourceIds", campaign.searchSources.join(",") || "none"],
    ]));

    const scoutResult = await trace.measure(
      "scout.fetch-and-reduce",
      "external_io",
      () => this.scout.discover(campaign),
      {
        inputCount: campaign.searchSources.length,
        outputCount: (result) => result.jobs.length,
        outcome: (result) => result.failures.length === 0 ? "success" : result.jobs.length > 0 ? "partial" : "failed",
        metadata: { sourceCount: String(campaign.searchSources.length), stage: "scout.total" },
      },
    );
    trace.addMany(scoutResult.executionNodes ?? []);
    const sourceFailures = scoutResult.failures;
    const existingBeforeDiscovery = this.careerRepository.listJobs();
    const newCount = await trace.measure(
      "scout.history-dedupe",
      "deterministic",
      async () => scoutResult.jobs.filter(
        (scouted) => !this.findExistingJob(scouted, existingBeforeDiscovery),
      ).length,
      {
        inputCount: scoutResult.jobs.length,
        outputCount: (count) => count,
        metadata: { historicalJobCount: String(existingBeforeDiscovery.length), stage: "scout.history-dedupe" },
      },
    );
    const allSourcesNotConfigured = scoutResult.sourceSummaries.length > 0 &&
      scoutResult.sourceSummaries.every((source) => source.status === "not_configured");
    const discoveryStatus: DiscoverySummary["status"] = scoutResult.jobs.length === 0
      ? allSourcesNotConfigured ? "not_configured" : sourceFailures.length > 0 ? "failed" : "empty"
      : sourceFailures.length > 0 ? "partial" : "success";
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
    const discoveryEventType: CareerEventType = discoveryStatus === "failed" || discoveryStatus === "not_configured"
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
      campaign = { ...campaign, consecutiveSystemicFailures: 0, updatedAt: this.now() };
      this.careerRepository.saveCampaign(campaign);
    }

    for (const scouted of scoutResult.jobs) {
      campaign = this.getCampaign(campaignId);
      if (campaign.status !== "active") break;
      const existing = this.findExistingJob(scouted);
      if (existing) {
        const enriched = this.mergeScoutedRecord(existing, scouted);
        if (enriched.status === "held" &&
          enriched.decisionReason === APPLICATION_CAP_HOLD_REASON &&
          !this.applicationCapReached(campaign, this.now())) {
          const outcome = await trace.measure(
            `application.resume-cap.${enriched.id}`,
            "deterministic",
            () => this.resumeCapHeldJob(campaign, enriched, trace),
            {
              inputCount: 1,
              outputCount: () => 1,
              outcome: (result) => result.failure ? "failed" : "success",
              metadata: { jobId: enriched.id, stage: "preparation.total" },
            },
          );
          if (outcome.applied) accumulator.applied += 1;
          if (outcome.prepared) accumulator.prepared += 1;
          if (outcome.failure) accumulator.failures += 1;
          continue;
        }
        const application = enriched.applicationId ? this.applicationService.listApplications().find((candidate) => candidate.id === enriched.applicationId) ?? null : null;
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
          outcome: (result) => result.failure ? "failed" : result.held || result.blocked ? "blocked" : "success",
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
    return finish();
  }

  async resolveCareerBlocker(
    campaignId: string,
    jobId: string,
    blockerId: string,
    value: AnswerValue,
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
      blockers: job.blockers.map((candidate) => candidate.id === blocker.id
        ? { ...candidate, status: "resolved" as const, resolvedAt: this.now(), value }
        : candidate),
      updatedAt: this.now(),
    };
    this.careerRepository.saveJob(resolved);

    // A real local browser owns its live session. Resolving a blocker updates
    // the persisted domain value, but the UI must explicitly resume that
    // same host session instead of falling back to the injected executor.
    if (resolved.execution?.mode === "real_local" && resolved.execution.hostExecutionId) {
      return resolved;
    }

    if (campaign.status === "active") {
      return (await this.resumeBlockedJob(campaign, resolved)).careerJob;
    }
    return resolved;
  }

  async resumeBlockedApplication(campaignId: string, jobId: string): Promise<CareerJob> {
    const campaign = this.getCampaign(campaignId);
    const job = this.getJob(jobId);
    if (job.campaignId !== campaignId) throw new Error("That job does not belong to the selected campaign.");
    return (await this.resumeBlockedJob(campaign, job)).careerJob;
  }

  /**
   * Record the user's explicit confirmation after the browser reached the
   * manual Submit boundary. This is the only Career Agent path that turns a
   * ready-to-submit packet into Applied without executor submission proof.
   */
  async confirmManualApplication(campaignId: string, jobId: string): Promise<CareerJob> {
    const campaign = this.getCampaign(campaignId);
    const job = this.getJob(jobId);
    if (job.campaignId !== campaignId) throw new Error("That job does not belong to the selected campaign.");
    if (job.status === "applied") return job;
    if (job.status !== "ready_to_submit") {
      throw new Error("Only a prepared application stopped at the manual Submit boundary can be marked Applied.");
    }
    if (!job.applicationId) throw new Error("The career job has no application packet to mark Applied.");

    const application = this.applicationService.getApplication(job.applicationId);
    if (application.status !== "ready_for_review") {
      throw new Error("The application packet must remain ready for review until manual submission is confirmed.");
    }
    const appliedApplication = this.applicationService.recordManualSubmissionConfirmation(application.id, this.now());
    const evidence = appliedApplication.manualSubmissionConfirmation;
    if (!evidence) throw new Error("The manual submission confirmation was not persisted.");

    let applied = this.saveJob({
      ...job,
      status: "applied",
      manualSubmissionConfirmation: evidence,
      blockers: this.mergeBlockers(job, [], application.id),
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

  /**
   * Persist the opaque execution-host ID and high-level state without
   * serializing any browser/session data into the career repository.
   */
  async recordExecutionHostSnapshot(
    campaignId: string,
    jobId: string,
    snapshot: ExecutionHostSnapshot,
  ): Promise<CareerJob> {
    const campaign = this.getCampaign(campaignId);
    const job = this.getJob(jobId);
    if (job.campaignId !== campaign.id) throw new Error("That job does not belong to the selected campaign.");
    if (snapshot.campaignId !== campaign.id || snapshot.jobId !== job.id) {
      throw new Error("The execution-host snapshot does not match the selected career job.");
    }
    if (!job.applicationId || snapshot.applicationId !== job.applicationId) {
      throw new Error("The execution-host snapshot does not match the application packet.");
    }

    const previousStatus = job.execution?.status;
    const status = snapshotStatusToCareerStatus(snapshot.status);
    const inspection = snapshot.inspection;
    const sameHostExecution = job.execution?.mode === "real_local" &&
      job.execution.hostExecutionId === snapshot.id;

    // GET is intentionally idempotent. A page reload or a second poll may
    // observe the same terminal result; do not regenerate the packet or emit
    // duplicate audit events for an unchanged host snapshot.
    if (sameHostExecution && snapshot.result && previousStatus === status) return job;

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
      this.appendEvent(campaign.id, "application.execution_host_started", {
        ...careerEventMetadata(marked),
        executionId: snapshot.id,
        mode: "real_local",
        ...(snapshot.attempt !== undefined ? { attempt: String(snapshot.attempt) } : {}),
      });
      this.appendEvent(campaign.id, "application.execution_started", {
        ...careerEventMetadata(marked),
        executor: "lever-browser-executor",
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
          blocker: snapshot.result.state === "requires_human"
            ? snapshot.result.blocker.kind
            : snapshot.result.blocker?.kind ?? "unsupported",
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

  /** Apply a terminal or blocker result returned by the local host. */
  private async recordExecutionHostResult(
    campaign: Campaign,
    careerJob: CareerJob,
    snapshot: ExecutionHostSnapshot,
  ): Promise<CareerJob> {
    if (!snapshot.result) return careerJob;
    const applicationId = careerJob.applicationId;
    if (!applicationId) throw new Error("A browser execution requires an application packet.");
    const application = this.applicationService.getApplication(applicationId);
    const result = snapshot.result;
    const outcome = await this.executePreparedApplication(campaign, careerJob, application, {
      result,
      executionId: snapshot.id,
      hostStatus: snapshotStatusToCareerStatus(snapshot.status),
    });
    return outcome.careerJob ?? this.getJob(careerJob.id);
  }

  recordExecutionHostCancelled(
    campaignId: string,
    jobId: string,
    executionId: string,
  ): CareerJob {
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
        evidence: [...new Set([...(job.execution?.evidence ?? []), "execution-host:unavailable", "submit:not-clicked", "submission:manual-only"])],
        updatedAt: this.now(),
      },
      updatedAt: this.now(),
    });
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
    const runTrace = trace
      ? (() => {
        const newAttentionEvents = this.listEvents(campaignId)
          .filter((event) => !eventBaseline.has(event.id) && event.attention);
        const attentionByCategory = newAttentionEvents.reduce<Partial<Record<HumanAttentionCategory, number>>>((counts, event) => {
          const category = event.attentionCategory ?? attentionCategoryForEvent(event.type, event.metadata);
          if (category) counts[category] = (counts[category] ?? 0) + 1;
          return counts;
        }, {});
        trace.setHumanAttentionEvents(newAttentionEvents.length, attentionByCategory);
        trace.setHumanWaitDuration(humanWaitDurationSince(
          this.listJobs(campaignId),
          previousTraceCompletedAt ?? trace.startedAt,
          this.now(),
        ));
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
    return {
      snapshot,
      ...accumulator,
      attentionRequired: snapshot.counts.needsYou,
      ...(runTrace ? { trace: runTrace } : {}),
    };
  }

  private findExistingJob(
    scouted: ScoutedJob,
    jobs: readonly CareerJob[] = this.careerRepository.listJobs(),
  ): CareerJob | undefined {
    return jobs.find((candidate) => {
      const candidateKeys = candidate.dedupeKeys ?? jobDedupeKeys(
        candidate.job,
        candidate.sourceRecordId,
        candidate.sourceId,
      );
      const candidateMode = candidate.sourceMode ?? (candidate.isExample ? "demo" : "live");
      return jobKeysMatch(
        scouted.sourceId,
        scouted.dedupeKeys,
        scouted.sourceMode,
        candidate.sourceId,
        candidateKeys,
        candidateMode,
      );
    });
  }

  private mergeScoutedRecord(existing: CareerJob, incoming: ScoutedJob): CareerJob {
    const existingActionability = existing.actionability ?? "discoverable_only";
    const shouldPreferIncoming = incoming.actionability === "actionable" && existingActionability !== "actionable";
    const observations = new Map<string, JobSourceObservation>();
    for (const observation of existing.sourceObservations ?? []) {
      observations.set(JSON.stringify([
        observation.sourceId,
        observation.sourceRecordId ?? "",
        observation.sourceUrl ?? "",
        observation.applicationUrl ?? "",
      ]), observation);
    }
    for (const observation of incoming.sourceObservations) {
      observations.set(JSON.stringify([
        observation.sourceId,
        observation.sourceRecordId ?? "",
        observation.sourceUrl ?? "",
        observation.applicationUrl ?? "",
      ]), observation);
    }
    const merged: CareerJob = {
      ...existing,
      ...(shouldPreferIncoming ? {
        isExample: incoming.isExample,
        sourceMode: incoming.sourceMode,
        actionability: incoming.actionability,
        fingerprint: incoming.fingerprint,
        sourceId: incoming.sourceId,
        ...(incoming.sourceRecordId ? { sourceRecordId: incoming.sourceRecordId } : {}),
        ...(incoming.sourcePublishedAt ? { sourcePublishedAt: incoming.sourcePublishedAt } : {}),
        job: incoming.job,
      } : {}),
      dedupeKeys: [...new Set([...(existing.dedupeKeys ?? []), ...incoming.dedupeKeys])],
      sourceObservations: [...observations.values()],
      ...(shouldPreferIncoming ? { updatedAt: this.now() } : {}),
    };
    const dedupeKeysChanged = JSON.stringify(merged.dedupeKeys ?? []) !== JSON.stringify(existing.dedupeKeys ?? []);
    const observationsChanged = JSON.stringify(merged.sourceObservations ?? []) !== JSON.stringify(existing.sourceObservations ?? []);
    if (shouldPreferIncoming || dedupeKeysChanged || observationsChanged) {
      const updated = shouldPreferIncoming ? merged : { ...merged, updatedAt: this.now() };
      this.saveJob(updated);
      return updated;
    }
    return merged;
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
      dedupeKeys: [...scouted.dedupeKeys],
      sourceObservations: [...scouted.sourceObservations],
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
      ? trace.measureSync(`job.hard-filter.${careerJob.id}`, "deterministic", () => applyHardFilters(careerJob.job, campaign.searchCriteria), {
        parentNodeId,
        inputCount: 1,
        outputCount: () => 1,
        outcome: (result) => result.decision === "pass" ? "success" : "blocked",
        failureReason: (result) => result.decision === "pass" ? undefined : "policy_rejected",
        metadata: { stage: "job.hard-filter", jobId: careerJob.id },
      })
      : applyHardFilters(careerJob.job, campaign.searchCriteria);
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
        ? await trace.measure(
          `job.fit.${careerJob.id}`,
          "judgment",
          () => this.applicationService.assessJob(careerJob.job),
          {
            parentNodeId,
            inputCount: 1,
            outputCount: () => 1,
            metadata: { stage: "job.fit", jobId: careerJob.id },
          },
        )
        : await this.applicationService.assessJob(careerJob.job);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Fit assessment failed.";
      careerJob = this.decideJob(careerJob, "failed", reason);
      this.appendEvent(campaign.id, "application.failed", careerEventMetadata(careerJob, undefined, reason));
      this.appendEvent(campaign.id, "campaign.review_needed", careerEventMetadata(careerJob, undefined, reason));
      return { failure: true };
    }

    careerJob = this.saveJob({ ...careerJob, fit, status: "pursuing", updatedAt: this.now() });
    const pursuit = trace
      ? trace.measureSync(`job.pursuit-policy.${careerJob.id}`, "deterministic", () => decidePursuit(fit, campaign.fitPolicy), {
        parentNodeId,
        inputCount: 1,
        outputCount: () => 1,
        outcome: (result) => result.decision === "pursue" ? "success" : "blocked",
        failureReason: (result) => result.decision === "pursue" ? undefined : "policy_rejected",
        metadata: { stage: "job.pursuit-policy", jobId: careerJob.id },
      })
      : decidePursuit(fit, campaign.fitPolicy);
    if (pursuit.decision !== "pursue") {
      const status = pursuit.decision === "reject" ? "rejected" : "held";
      careerJob = this.decideJob(careerJob, status, pursuit.reason);
      this.appendEvent(campaign.id, status === "rejected" ? "job.rejected" : "job.held", careerEventMetadata(careerJob, undefined, pursuit.reason));
      if (status === "held") this.appendEvent(campaign.id, "campaign.review_needed", careerEventMetadata(careerJob, undefined, pursuit.reason));
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

    const outcome = await this.prepareAndMaybeExecute(campaign, {
      ...careerJob,
      status: "preparing",
      applicationStartedAt: this.now(),
      updatedAt: this.now(),
    }, trace, parentNodeId);
    return { ...outcome, prepared: true };
  }

  private async resumeCapHeldJob(
    campaign: Campaign,
    job: CareerJob,
    trace?: ExecutionTraceBuilder,
    parentNodeId?: string,
  ): Promise<ProcessOutcome> {
    if (!job.fit || this.applicationCapReached(campaign, this.now())) return { held: true };
    const outcome = await this.prepareAndMaybeExecute(campaign, {
      ...job,
      status: "preparing",
      applicationStartedAt: this.now(),
      updatedAt: this.now(),
      decisionReason: undefined,
    }, trace, parentNodeId);
    return { ...outcome, prepared: true };
  }

  private async prepareAndMaybeExecute(
    campaign: Campaign,
    initialJob: CareerJob,
    trace?: ExecutionTraceBuilder,
    parentNodeId?: string,
  ): Promise<ProcessOutcome> {
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
            metadata: { stage: "job.application-create", jobId: careerJob.id },
          },
        )
        : await this.applicationService.createApplicationFromJob(careerJob.job, careerJob.isExample);
      application = created;
      careerJob = this.saveJob({ ...careerJob, applicationId: created.id, updatedAt: this.now() });
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
            metadata: { stage: "job.application-evaluate", jobId: careerJob.id },
          },
        )
        : await this.applicationService.evaluateApplication(created.id, careerJob.fit ?? undefined);
      application = evaluated;
      careerJob = this.saveJob({ ...careerJob, fit: evaluated.fit, updatedAt: this.now() });
      this.appendEvent(campaign.id, "application.evaluated", careerEventMetadata(careerJob));

      const prepared = trace
        ? await trace.measure(
          preparationNodeId,
          "judgment",
          () => this.applicationService.prepareApplication(evaluated.id, {
            trace,
            parentNodeId: preparationNodeId,
          }),
          {
            parentNodeId,
            inputCount: 1,
            outputCount: () => 1,
            outcome: (result) => result.status === "needs_input" ? "blocked" : "success",
            humanAttentionRequired: (result) => result.status === "needs_input",
            humanAttentionCategory: (result) => result.status === "needs_input"
              ? humanAttentionCategoryForBlocker(result.blockers[0])
              : undefined,
            metadata: { stage: "preparation.total", jobId: careerJob.id, applicationId: evaluated.id },
          },
        )
        : await this.applicationService.prepareApplication(evaluated.id);
      application = prepared;
      this.appendEvent(campaign.id, "application.prepared", careerEventMetadata(careerJob, undefined, String(prepared.blockers.filter((blocker) => blocker.status === "open").length)));

      const preparationDrafts = trace
        ? trace.measureSync(
          `preparation.validation.${careerJob.id}`,
          "deterministic",
          () => careerBlockerDraftsForApplication(prepared),
          {
            parentNodeId,
            inputCount: 1,
            outputCount: (value) => value.length,
            outcome: (value) => value.length > 0 ? "blocked" : "success",
            humanAttentionRequired: (value) => value.length > 0,
            humanAttentionCategory: (value) => value.length > 0
              ? humanAttentionCategoryForBlocker(value[0])
              : undefined,
            metadata: { stage: "preparation.validation", jobId: careerJob.id },
          },
        )
        : careerBlockerDraftsForApplication(prepared);
      careerJob = this.saveJob({
        ...careerJob,
        status: preparationDrafts.length > 0 ? "needs_input" : "preparing",
        blockers: this.mergeBlockers(careerJob, preparationDrafts, prepared.id),
        updatedAt: this.now(),
      });

      if (preparationDrafts.length > 0) {
        this.appendEvent(campaign.id, "application.needs_input", careerEventMetadata(careerJob, undefined, String(preparationDrafts.length)));
        this.appendEvent(campaign.id, "campaign.review_needed", careerEventMetadata(careerJob, undefined, "application_preparation"));
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
            metadata: { stage: "preparation.blocker-evaluation", jobId: careerJob.id },
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
    careerJob = this.saveJob({ ...careerJob, applicationResumeAttempt: resumeAttempt, updatedAt: this.now() });
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
    const preparationOnly = override.result !== undefined ||
      this.executor.executionMode?.(executionRequest) === "preparation_only";
    const gate = trace
      ? trace.measureSync(
        `execution.policy-check.${careerJob.id}`,
        "deterministic",
        () => verifyPreparedApplication(
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
          outcome: (result) => result.allowed ? "success" : "blocked",
          humanAttentionRequired: (result) => !result.allowed,
          humanAttentionCategory: (result) => result.allowed ? undefined : "policy_decision",
          failureReason: (result) => result.allowed ? undefined : "policy_rejected",
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
          metadata: { stage: "execution.host-start", jobId: careerJob.id, executor: this.executor.id },
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
        const request: ApplicationExecutionRequest = { ...executionRequest, careerJob: ready, now: this.now() };
        execution = trace
          ? await trace.measure(
            `execution.lever-execute.${careerJob.id}`,
            "external_io",
            () => this.executor.execute(request),
            {
              parentNodeId,
              inputCount: 1,
              outputCount: () => 1,
              outcome: (result) => result.state === "failed"
                ? "failed"
                : result.state === "ready_to_submit" || result.state === "submitted" ? "success" : "blocked",
              humanAttentionRequired: (result) => result.state !== "ready_to_submit" && result.state !== "submitted",
              humanAttentionCategory: (result) => result.state === "requires_human"
                ? humanAttentionCategoryForBlocker(result.blocker)
                : result.state === "unsupported"
                  ? "unsupported_field"
                  : result.state === "failed" ? "operational_failure" : undefined,
              failureReason: (result) => result.state === "failed"
                ? executionFailureReason(result.reason)
                : result.state === "requires_human" ? "human_gate" : result.state === "unsupported" ? "validation_error" : undefined,
              metadata: { stage: "execution.lever-execute", jobId: careerJob.id, executor: this.executor.id },
            },
          )
          : await this.executor.execute(request);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Application executor failed.";
      const failed = this.saveJob({ ...ready, status: "failed", decisionReason: reason, updatedAt: this.now() });
      this.failPreparedApplication(application, reason);
      this.appendEvent(campaign.id, "application.failed", careerEventMetadata(failed, undefined, reason));
      this.appendEvent(campaign.id, "campaign.review_needed", careerEventMetadata(failed, undefined, reason));
      return { careerJob: failed, failure: true };
    }

    if (preparationOnly && execution.state === "submitted") {
      const reason = "A preparation-only executor returned submission proof; the closed Submit lane rejected it.";
      const failed = this.saveJob({ ...ready, status: "failed", decisionReason: reason, updatedAt: this.now() });
      this.failPreparedApplication(application, reason);
      this.appendEvent(campaign.id, "application.failed", careerEventMetadata(failed, undefined, "preparation_only_proof_rejected"));
      this.appendEvent(campaign.id, "campaign.review_needed", careerEventMetadata(failed, undefined, "preparation_only_proof_rejected"));
      return { careerJob: failed, failure: true };
    }

    if (execution.state === "requires_human") {
      const drafts = [execution.blocker, ...(execution.blockers ?? [])].filter(isCareerBlockerDraft);
      if (drafts.length === 0) {
        const reason = "The executor returned a malformed human blocker; execution was stopped.";
        const failed = this.saveJob({ ...ready, status: "failed", decisionReason: reason, updatedAt: this.now() });
        this.failPreparedApplication(application, reason);
        this.appendEvent(campaign.id, "application.failed", careerEventMetadata(failed, undefined, reason));
        this.appendEvent(campaign.id, "campaign.review_needed", careerEventMetadata(failed, undefined, "malformed_executor_blocker"));
        return { careerJob: failed, failure: true };
      }
      const blocked = this.saveJob({
        ...ready,
        status: "needs_input",
        ...(execution.inspection ? {
          execution: careerExecutionState(
            execution.inspection,
            override.hostStatus ?? "needs_input",
            this.now(),
            override.executionId ? { mode: "real_local", hostExecutionId: override.executionId } : {},
          ),
        } : {}),
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
      this.appendEvent(campaign.id, "application.needs_input", careerEventMetadata(blocked, undefined, drafts.map((draft) => draft.kind).join(",")));
      this.appendEvent(campaign.id, "campaign.review_needed", careerEventMetadata(blocked, undefined, drafts[0].reason));
      return { careerJob: blocked, blocked: true };
    }

    if (execution.state === "unsupported") {
      const fallbackBlocker: CareerBlockerDraft = {
        kind: "unknown_form_field",
        unit: "submission",
        field: "application-form",
        question: "Supported application form",
        reason: execution.reason,
        evidence: [`executor:${this.executor.id}`, "submission:manual-only"],
        resumeAfterHuman: true,
      };
      const blocker = execution.blocker && isCareerBlockerDraft(execution.blocker)
        ? execution.blocker
        : fallbackBlocker;
      const unsupported = this.saveJob({
        ...ready,
        status: "needs_input",
        ...(execution.inspection ? {
          execution: careerExecutionState(
            execution.inspection,
            override.hostStatus ?? "needs_input",
            this.now(),
            override.executionId ? { mode: "real_local", hostExecutionId: override.executionId } : {},
          ),
        } : {}),
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
        ...(execution.inspection ? {
          execution: careerExecutionState(
            execution.inspection,
            override.hostStatus ?? "failed",
            this.now(),
            override.executionId ? { mode: "real_local", hostExecutionId: override.executionId } : {},
          ),
        } : {}),
        decisionReason: execution.reason,
        updatedAt: this.now(),
      });
      this.failPreparedApplication(application, execution.reason);
      this.appendEvent(campaign.id, "application.failed", careerEventMetadata(failed, undefined, execution.reason));
      if (execution.retryable) this.appendEvent(campaign.id, "campaign.review_needed", careerEventMetadata(failed, undefined, "retryable_executor_failure"));
      return { careerJob: failed, failure: true };
    }

    if (!isSubmissionProof(execution.proof)) {
      const reason = "The executor returned malformed submission proof; applied state was not recorded.";
      const failed = this.saveJob({ ...ready, status: "failed", decisionReason: reason, updatedAt: this.now() });
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
      const failed = this.saveJob({ ...submitted, status: "failed", decisionReason: reason, updatedAt: this.now() });
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

    applied = await this.syncTrackerForAppliedJob(campaign, applied, appliedApplication, execution.proof, "tracker.update_started", trace, parentNodeId);

    return { careerJob: applied, applied: true };
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
        ? await trace.measure(
          `tracker.sync.${job.id}`,
          "external_io",
          record,
          {
            parentNodeId,
            attempt,
            retryReasonCode: startEvent === "tracker.retry_started" ? "tracker_failure" : undefined,
            previousOutcome: startEvent === "tracker.retry_started" ? "failed" : undefined,
            inputCount: 1,
            outputCount: () => 1,
            externalMetrics: (value) => isJobTrackerResult(value)
              ? {
                requestCount: value.simulated ? 0 : 1,
                successCount: value.ok && !value.simulated ? 1 : 0,
                failureCount: !value.ok && !value.simulated ? 1 : 0,
              }
              : { requestCount: 1, successCount: 0, failureCount: 1 },
            metadata: { stage: startEvent === "tracker.retry_started" ? "tracker.retry" : "tracker.sync", jobId: job.id, tracker: this.tracker.id },
          },
        )
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
        this.appendEvent(campaign.id, "tracker.updated", careerEventMetadata(synced, undefined, result.simulated ? "simulated" : "external"));
        return synced;
      }
      const reason = isJobTrackerResult(result)
        ? result.error ?? "Tracker update failed."
        : "Tracker returned a malformed result.";
      return this.markTrackerSyncFailed(campaign, pending, reason, {
        durationMs: Math.max(0, Math.round(monotonicNow() - trackerStartedAt)),
        timeoutCount: 0,
      });
    } catch (error) {
      return this.markTrackerSyncFailed(
        campaign,
        pending,
        error instanceof Error ? error.message : "Tracker update failed.",
        {
          durationMs: Math.max(0, Math.round(monotonicNow() - trackerStartedAt)),
          timeoutCount: executionFailureReason(error) === "timeout" ? 1 : 0,
        },
      );
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
    const started = this.careerRepository
      .listJobs(campaign.id)
      .filter((job) => job.applicationStartedAt !== undefined);
    const daily = started.filter((job) => sameUtcDay(job.applicationStartedAt ?? "", at)).length;
    if (daily >= campaign.dailyApplicationLimit) return true;
    const weekly = campaign.optionalWeeklyLimit === undefined
      ? 0
      : started.filter((job) => sameUtcWeek(job.applicationStartedAt ?? "", at)).length;
    return campaign.optionalWeeklyLimit !== undefined && weekly >= campaign.optionalWeeklyLimit;
  }

  private decideJob(job: CareerJob, status: Extract<CareerJobStatus, "rejected" | "held" | "failed">, reason: string): CareerJob {
    return this.saveJob({ ...job, status, decisionReason: reason, updatedAt: this.now() });
  }

  private saveJob(job: CareerJob): CareerJob {
    this.careerRepository.saveJob(job);
    return job;
  }

  private mergeBlockers(
    job: CareerJob,
    drafts: readonly CareerBlockerDraft[],
    applicationId?: string,
  ): readonly CareerBlocker[] {
    const now = this.now();
    const byKey = new Map(drafts.map((draft) => [careerBlockerKey(draft), draft]));
    const consumed = new Set<string>();
    const existing = job.blockers.map((current) => {
      const key = careerBlockerKey(current);
      const draft = byKey.get(key);
      if (!draft) {
        return current.status === "open"
          ? { ...current, status: "resolved" as const, resolvedAt: current.resolvedAt ?? now }
          : current;
      }
      consumed.add(key);
      if (current.status === "resolved") {
        return {
          ...current,
          kind: draft.kind,
          unit: draft.unit,
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

function careerEventMetadata(
  job: CareerJob,
  filter?: HardFilterResult,
  reason?: string,
): Readonly<Record<string, string>> {
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

function humanWaitDurationSince(
  jobs: readonly CareerJob[],
  since: string,
  until: string,
): number {
  const sinceMs = Date.parse(since);
  const untilMs = Date.parse(until);
  if (Number.isNaN(sinceMs) || Number.isNaN(untilMs)) return 0;
  return jobs.reduce((total, job) => total + job.blockers.reduce((jobTotal, blocker) => {
    if (blocker.status !== "resolved" || !blocker.resolvedAt) return jobTotal;
    const createdMs = Date.parse(blocker.createdAt);
    const resolvedMs = Date.parse(blocker.resolvedAt);
    if (Number.isNaN(createdMs) || Number.isNaN(resolvedMs) || resolvedMs <= sinceMs || resolvedMs > untilMs) return jobTotal;
    return jobTotal + Math.max(0, resolvedMs - Math.max(createdMs, sinceMs));
  }, 0), 0);
}

function browserTelemetryMetadata(
  telemetry: ExecutionHostSnapshot["telemetry"],
): Readonly<Record<string, string>> {
  if (!telemetry) return {};
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(telemetry)) {
    if (typeof value === "number" && Number.isFinite(value)) entries.push([key, String(Math.round(value))]);
  }
  return metadataFrom(entries);
}
