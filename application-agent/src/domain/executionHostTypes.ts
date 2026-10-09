import type {
  ApplicationExecutorResult,
  BrowserExecutionTelemetry,
  ExecutionInspection,
} from "./executor";
import type { ExecutionFailureReason } from "./executionTrace";
import type {
  CareerJob,
  Campaign,
} from "./campaignTypes";
import type {
  Application,
  CandidateProfile,
} from "./types";

/** The only browser-execution mode exposed by the local host in this phase. */
export type ExecutionHostMode = "real_local";

export type ExecutionHostStatus =
  | "starting"
  | "inspecting"
  | "executing"
  | "needs_input"
  | "waiting_for_human"
  | "resuming"
  | "ready_to_submit"
  | "submitted"
  | "failed"
  | "cancelled"
  | "closed";

/**
 * The frontend sends the already prepared domain record to the loopback host.
 * The host validates every member again before opening a browser.
 */
export interface ExecutionHostRequest {
  mode: ExecutionHostMode;
  campaign: Campaign;
  careerJob: CareerJob;
  application: Application;
  profile: CandidateProfile;
}

/**
 * Submission proof is transportable only after the server-side automatic
 * submission gate has accepted a verified external confirmation.
 */
export type ExecutionHostResult =
  | Extract<ApplicationExecutorResult, { state: "submitted" }>
  | Extract<ApplicationExecutorResult, { state: "requires_human" }>
  | Extract<ApplicationExecutorResult, { state: "ready_to_submit" }>
  | Extract<ApplicationExecutorResult, { state: "unsupported" }>
  | Extract<ApplicationExecutorResult, { state: "failed" }>;

export interface ExecutionHostSnapshot {
  id: string;
  mode: ExecutionHostMode;
  applicationId: string;
  jobId: string;
  campaignId: string;
  status: ExecutionHostStatus;
  startedAt: string;
  updatedAt: string;
  /** Attempt 1 is the initial host run; it increments only on explicit resume. */
  attempt?: number;
  retryReasonCode?: ExecutionFailureReason;
  failureReasonCode?: ExecutionFailureReason;
  telemetry?: BrowserExecutionTelemetry;
  inspection?: ExecutionInspection;
  result?: ExecutionHostResult;
  /** Set only by the exact action-time manual-submit route after its durable fence. */
  manualSubmission?: boolean;
  /** High-level server error only; no profile values or browser content. */
  error?: string;
}

/** Type guard used by tests and host/client boundaries. */
export function isExecutionHostStatus(value: unknown): value is ExecutionHostStatus {
  return value === "starting" ||
    value === "inspecting" ||
    value === "executing" ||
    value === "needs_input" ||
    value === "waiting_for_human" ||
    value === "resuming" ||
    value === "ready_to_submit" ||
    value === "submitted" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "closed";
}
