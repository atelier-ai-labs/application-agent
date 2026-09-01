import type {
  ApplicationExecutorResult,
  ExecutionInspection,
} from "./executor";
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
 * Submission proof is deliberately absent from this transport contract. A
 * preparation-only host may never return, persist, or forward it.
 */
export type ExecutionHostResult =
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
  inspection?: ExecutionInspection;
  result?: ExecutionHostResult;
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
    value === "failed" ||
    value === "cancelled" ||
    value === "closed";
}
