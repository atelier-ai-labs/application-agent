import type {
  CareerJob,
  Campaign,
  JobActionability,
  JobSourceMode,
} from "./campaignTypes";
import type {
  Application,
  JobPosting,
  ManualSubmissionConfirmation,
  SubmissionProof,
} from "./types";
import { isAppliedEvidence, isJobPosting, isRecord } from "./validation";

export type TrackerProofMode = SubmissionProof["mode"] | ManualSubmissionConfirmation["mode"];
export type SubmissionEvidence = SubmissionProof | ManualSubmissionConfirmation;

/**
 * The provider-neutral record written after an application is truthfully
 * marked Applied. Provider-specific transports consume this contract only.
 */
export interface JobTrackerUpdate {
  applicationId?: string;
  careerJobId?: string;
  campaignId?: string;
  sourceId?: string;
  sourceRecordId?: string;
  sourceUrl?: string;
  applicationUrl?: string;
  company: string;
  role: string;
  /** Preferred canonical URL for the tracker row; application URL wins when available. */
  jobLink?: string;
  locationRemote?: string;
  salaryMin?: number;
  salaryMax?: number;
  fit: string;
  priority: string;
  status: "Applied";
  dateFound: string;
  dateApplied: string;
  followUpDate?: string;
  resumeVersion: string;
  nextStep: string;
  /** Kept for simulated/audit consumers; the Google adapter preserves sheet Notes. */
  notes: string;
  proofMode: TrackerProofMode;
}

export interface JobTrackerResult {
  ok: boolean;
  trackerRecordId?: string;
  simulated: boolean;
  error?: string;
}

export function isJobTrackerResult(value: unknown): value is JobTrackerResult {
  if (!isRecord(value)) return false;
  return typeof value.ok === "boolean" &&
    typeof value.simulated === "boolean" &&
    isOptionalString(value.trackerRecordId) &&
    isOptionalString(value.error);
}

/**
 * Minimal state evidence sent to a trusted tracker host. It contains no
 * candidate profile or answer packet, but lets the host reject tracker writes
 * that are not already in an applied state.
 */
export interface JobTrackerSyncContext {
  campaignId: string;
  careerJobId: string;
  applicationId: string;
  campaignStatus: Campaign["status"];
  careerJobStatus: "applied";
  applicationStatus: "applied";
  sourceMode: JobSourceMode;
  actionability: JobActionability;
  sourceId: string;
  sourceRecordId?: string;
  job: JobPosting;
  evidence: SubmissionEvidence;
}

export interface JobTrackerSyncRequest {
  mode: "google_sheets";
  context: JobTrackerSyncContext;
  update: JobTrackerUpdate;
}

export interface JobTracker {
  id: string;
  /** Optional context keeps the original tracker seam compatible with tests/adapters. */
  recordApplied(update: JobTrackerUpdate, context?: JobTrackerSyncContext): Promise<JobTrackerResult>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function isOptionalString(value: unknown): boolean {
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

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isJobSourceMode(value: unknown): value is JobSourceMode {
  return value === "live" || value === "demo";
}

function isJobActionability(value: unknown): value is JobActionability {
  return value === "discoverable_only" || value === "actionable";
}

function isCampaignStatus(value: unknown): value is Campaign["status"] {
  return value === "draft" || value === "active" || value === "paused" || value === "completed" || value === "failed";
}

function isTrackerProofMode(value: unknown): value is TrackerProofMode {
  return value === "external" || value === "simulated" || value === "manual";
}

export function isJobTrackerUpdate(value: unknown): value is JobTrackerUpdate {
  if (!isRecord(value)) return false;
  return (
    isOptionalString(value.applicationId) &&
    isOptionalString(value.careerJobId) &&
    isOptionalString(value.campaignId) &&
    isOptionalString(value.sourceId) &&
    isOptionalString(value.sourceRecordId) &&
    isOptionalHttpUrl(value.sourceUrl) &&
    isOptionalHttpUrl(value.applicationUrl) &&
    isNonEmptyString(value.company) &&
    isNonEmptyString(value.role) &&
    isOptionalHttpUrl(value.jobLink) &&
    isOptionalString(value.locationRemote) &&
    isOptionalFiniteNumber(value.salaryMin) &&
    isOptionalFiniteNumber(value.salaryMax) &&
    isNonEmptyString(value.fit) &&
    isNonEmptyString(value.priority) &&
    value.status === "Applied" &&
    isTimestamp(value.dateFound) &&
    isTimestamp(value.dateApplied) &&
    isOptionalString(value.followUpDate) &&
    isNonEmptyString(value.resumeVersion) &&
    isNonEmptyString(value.nextStep) &&
    isNonEmptyString(value.notes) &&
    isTrackerProofMode(value.proofMode)
  );
}

export function isJobTrackerSyncContext(value: unknown): value is JobTrackerSyncContext {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.campaignId) &&
    isNonEmptyString(value.careerJobId) &&
    isNonEmptyString(value.applicationId) &&
    isCampaignStatus(value.campaignStatus) &&
    value.careerJobStatus === "applied" &&
    value.applicationStatus === "applied" &&
    isJobSourceMode(value.sourceMode) &&
    isJobActionability(value.actionability) &&
    isNonEmptyString(value.sourceId) &&
    isOptionalString(value.sourceRecordId) &&
    isJobPosting(value.job) &&
    isAppliedEvidence(value.evidence)
  );
}

export function isJobTrackerSyncRequest(value: unknown): value is JobTrackerSyncRequest {
  if (!isRecord(value)) return false;
  if (value.mode !== "google_sheets") return false;
  if (!isJobTrackerSyncContext(value.context) || !isJobTrackerUpdate(value.update)) return false;
  const context = value.context;
  const update = value.update;
  return update.status === "Applied" &&
    update.applicationId === context.applicationId &&
    update.careerJobId === context.careerJobId &&
    update.campaignId === context.campaignId &&
    update.sourceId === context.sourceId &&
    context.sourceMode === "live" &&
    update.proofMode !== "simulated";
}

export function trackerUpdateForJob(
  careerJob: CareerJob,
  evidence: SubmissionEvidence,
): JobTrackerUpdate {
  const fit = careerJob.fit?.classification ?? "unknown";
  const priority = fit === "strong" ? "high" : fit === "good" ? "standard" : "review";
  const dateApplied = evidence.mode === "manual" ? evidence.confirmedAt : evidence.submittedAt;
  const applicationUrl = careerJob.job.applicationUrl;
  const sourceUrl = careerJob.job.sourceUrl;
  return {
    ...(careerJob.applicationId ? { applicationId: careerJob.applicationId } : {}),
    careerJobId: careerJob.id,
    campaignId: careerJob.campaignId,
    sourceId: careerJob.sourceId,
    ...(careerJob.sourceRecordId ? { sourceRecordId: careerJob.sourceRecordId } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(applicationUrl ? { applicationUrl } : {}),
    company: careerJob.job.company,
    role: careerJob.job.title,
    ...(applicationUrl ? { jobLink: applicationUrl } : sourceUrl ? { jobLink: sourceUrl } : {}),
    ...(careerJob.job.location || careerJob.job.remoteStatus
      ? { locationRemote: [careerJob.job.location, careerJob.job.remoteStatus].filter(Boolean).join(" · ") }
      : {}),
    ...(careerJob.job.compensation?.minimum !== undefined ? { salaryMin: careerJob.job.compensation.minimum } : {}),
    ...(careerJob.job.compensation?.maximum !== undefined ? { salaryMax: careerJob.job.compensation.maximum } : {}),
    fit,
    priority,
    status: "Applied",
    dateFound: careerJob.discoveredAt,
    dateApplied,
    resumeVersion: careerJob.fit?.recommendedResumeFamily ?? (careerJob.applicationId ? `application:${careerJob.applicationId}` : "not-recorded"),
    nextStep: "Await response",
    notes: evidence.mode === "simulated"
      ? "SIMULATED — local executor result; Google Sheets was not updated."
      : evidence.mode === "manual"
        ? "User confirmed successful manual submission; tracker sync is downstream state recording."
        : `External proof: ${evidence.externalApplicationId}`,
    proofMode: evidence.mode,
  };
}

export function trackerSyncContextForJob(
  campaign: Campaign,
  careerJob: CareerJob,
  application: Application,
  evidence: SubmissionEvidence,
): JobTrackerSyncContext {
  return {
    campaignId: campaign.id,
    careerJobId: careerJob.id,
    applicationId: application.id,
    campaignStatus: campaign.status,
    careerJobStatus: "applied",
    applicationStatus: "applied",
    sourceMode: careerJob.sourceMode ?? (careerJob.isExample ? "demo" : "live"),
    actionability: careerJob.actionability ?? "discoverable_only",
    sourceId: careerJob.sourceId,
    ...(careerJob.sourceRecordId ? { sourceRecordId: careerJob.sourceRecordId } : {}),
    job: careerJob.job,
    evidence,
  };
}

export interface InMemoryJobTrackerOptions {
  fail?: boolean;
}

/** Deterministic tracker for tests and local simulation. */
export class InMemoryJobTracker implements JobTracker {
  public readonly id = "in-memory-tracker";
  private readonly updates: JobTrackerUpdate[] = [];
  private readonly fail: boolean;

  constructor(options: InMemoryJobTrackerOptions = {}) {
    this.fail = options.fail === true;
  }

  async recordApplied(update: JobTrackerUpdate, _context?: JobTrackerSyncContext): Promise<JobTrackerResult> {
    if (this.fail) {
      return {
        ok: false,
        simulated: true,
        error: "Deterministic tracker failure; no canonical sheet write occurred.",
      };
    }

    this.updates.push({ ...update });
    return {
      ok: true,
      trackerRecordId: `memory-row-${this.updates.length}`,
      simulated: true,
    };
  }

  listUpdates(): readonly JobTrackerUpdate[] {
    return this.updates.map((update) => ({ ...update }));
  }
}

/**
 * Honest server/configuration fallback. It never treats missing Google
 * credentials as a successful write.
 */
export class UnavailableJobTracker implements JobTracker {
  public readonly id: string;
  private readonly reason: string;

  constructor(
    reason = "Google Sheets connectivity is not configured; the Nate Job Search Tracker was not updated.",
    id = "google-sheets-unavailable",
  ) {
    this.id = id;
    this.reason = reason;
  }

  async recordApplied(_update: JobTrackerUpdate, _context?: JobTrackerSyncContext): Promise<JobTrackerResult> {
    return { ok: false, simulated: false, error: this.reason };
  }
}

/**
 * Backward-compatible name retained for callers that used the original
 * placeholder. The real implementation lives in the Node automation boundary.
 */
export class GoogleSheetsJobTrackerAdapter extends UnavailableJobTracker {
  constructor() {
    super(undefined, "google-sheets-nate-job-search-tracker");
  }
}

/** Selects local simulation for demo proof and the configured real tracker for live proof. */
export class SourceAwareJobTracker implements JobTracker {
  public readonly id = "source-aware-tracker";

  constructor(
    private readonly demoTracker: JobTracker = new InMemoryJobTracker(),
    private readonly liveTracker: JobTracker = new UnavailableJobTracker(),
  ) {}

  recordApplied(update: JobTrackerUpdate, context?: JobTrackerSyncContext): Promise<JobTrackerResult> {
    const useDemo = context?.sourceMode === "demo" || update.proofMode === "simulated";
    return (useDemo ? this.demoTracker : this.liveTracker).recordApplied(update, context);
  }
}
