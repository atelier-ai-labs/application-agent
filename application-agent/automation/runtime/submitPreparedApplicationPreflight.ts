import type { Application } from "../../src/domain/types";
import type { CareerJob } from "../../src/domain/campaignTypes";

export interface SubmitPreparedApplicationPreflightInput {
  campaignId: string;
  jobId: string;
  applicationId: string;
  job: CareerJob;
  application: Application;
  executionHostBaseUrl: string;
}

/**
 * Validate the durable packet before the action-time submit command is allowed
 * to call the runtime.  This is deliberately stricter than the runtime's
 * reconciliation method: a CLI invocation must never turn an ambiguous or
 * already-proven packet into another submit attempt.
 */
export function assertSubmitPreparedApplicationPreflight(
  input: SubmitPreparedApplicationPreflightInput,
): void {
  const { campaignId, jobId, applicationId, job, application } = input;
  if (!campaignId || !jobId || !applicationId) {
    throw new Error("Campaign, job, and application IDs are required.");
  }
  if (job.id !== jobId || job.campaignId !== campaignId || job.applicationId !== applicationId || application.id !== applicationId) {
    throw new Error("The campaign, job, and application IDs do not match.");
  }
  if (application.status !== "ready_for_review" || job.status !== "ready_to_submit") {
    throw new Error("Submit requires a proof-free ready-for-review application and ready-to-submit job.");
  }
  if (job.execution?.status !== "ready_to_submit" || job.execution.mode !== "real_local" || !job.execution.hostExecutionId) {
    throw new Error("Submit requires the retained real local execution to be ready_to_submit.");
  }
  if (job.submissionProof || job.manualSubmissionConfirmation || application.submissionProof || application.manualSubmissionConfirmation) {
    throw new Error("Submit is refused because durable submission proof already exists.");
  }
  assertTrustedExecutionHostBaseUrl(input.executionHostBaseUrl);
}

/** Only the local trusted execution host may receive this action-time command. */
export function assertTrustedExecutionHostBaseUrl(value: string): void {
  const raw = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("ATELIER_EXECUTION_HOST_BASE_URL must be a valid trusted loopback URL.");
  }
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname)) {
    throw new Error("ATELIER_EXECUTION_HOST_BASE_URL must use the trusted local HTTP execution host.");
  }
}

/** Unknown fences require an explicit duplicate-risk assertion; fresh packets do not. */
export function assertDuplicateRiskRetryAuthorization(
  fenceState: string | undefined,
  approval: string | undefined,
  reason: string | undefined,
): void {
  if (fenceState !== "unknown") return;
  if (approval !== "I_ACCEPT_DUPLICATE_SUBMISSION_RISK" || !reason || reason.trim().length < 10) {
    throw new Error("An unknown submission fence requires one-shot duplicate-risk authorization and a reason.");
  }
}
