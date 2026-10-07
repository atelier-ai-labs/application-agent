import type { ExecutionHostSnapshot } from "../../src/domain/executionHostTypes";

export interface ReconcilePostSubmitVerificationIds {
  campaignId: string;
  jobId: string;
  applicationId: string;
  executionId: string;
}

/** Accept only the exact host result that requires verification after a click. */
export function assertPostSubmitVerificationSnapshot(
  snapshot: ExecutionHostSnapshot,
  ids: ReconcilePostSubmitVerificationIds,
): void {
  if (snapshot.id !== ids.executionId || snapshot.campaignId !== ids.campaignId || snapshot.jobId !== ids.jobId || snapshot.applicationId !== ids.applicationId) {
    throw new Error("The execution snapshot does not match the exact campaign, job, application, and execution IDs.");
  }
  // The host sets manualSubmission only on its successful submitted branch;
  // ambiguous post-click snapshots legitimately leave it undefined.
  if (snapshot.status !== "waiting_for_human" || snapshot.result?.state !== "requires_human" || snapshot.result.blocker.kind !== "external_verification") {
    throw new Error("Only a waiting post-submit external-verification snapshot may be reconciled.");
  }
  const evidence = snapshot.result.blocker.evidence ?? [];
  if (!evidence.some((item) => /submit:clicked/i.test(item))) {
    throw new Error("The verification snapshot does not prove that Submit was clicked.");
  }
  if (snapshot.result.blocker.resumeAfterHuman !== false) {
    throw new Error("The post-submit verification snapshot must not authorize an automatic retry.");
  }
}
