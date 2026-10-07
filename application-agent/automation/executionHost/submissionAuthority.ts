import { randomUUID } from "node:crypto";
import { FileKeyValueStorage } from "../runtime/fileKeyValueStorage";
import type { KeyValueStorage } from "../../src/persistence/storage";

export type SubmissionFenceState = "claimed" | "clicking" | "unknown" | "recovered" | "retry_authorized" | "submitted";

export interface SubmissionFenceRecovery {
  kind: "user_asserted_not_submitted";
  confirmedNotSubmitted: true;
  reason: string;
  assertedAt: string;
  previousToken: string;
}

export interface DuplicateRiskRetryAuthorization {
  kind: "explicit_duplicate_risk_retry";
  confirmedRisk: true;
  reason: string;
  authorizedAt: string;
  previousToken: string;
}

export interface SubmissionFence {
  key: string;
  applicationId: string;
  jobId: string;
  workerId: string;
  token: string;
  state: SubmissionFenceState;
  updatedAt: string;
  proofExternalApplicationId?: string;
  recovery?: SubmissionFenceRecovery;
  duplicateRiskRetryAuthorization?: DuplicateRiskRetryAuthorization;
}

export type SubmissionReconciliation =
  | { state: "submitted"; externalApplicationId: string }
  | { state: "needs_input"; reason: string }
  | { state: "not_found" };

export class SubmissionAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubmissionAuthorityError";
  }
}

function fenceKey(applicationId: string, jobId: string): string {
  return `${applicationId}\u0000${jobId}`;
}

function storageKey(key: string): string {
  return `atelier.execution.submission-fence.v1:${key}`;
}

function parse(value: string | null): SubmissionFence | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return undefined;
    const candidate = parsed as Partial<SubmissionFence>;
    if (typeof candidate.key !== "string" || typeof candidate.applicationId !== "string" ||
      typeof candidate.jobId !== "string" || typeof candidate.workerId !== "string" ||
      typeof candidate.token !== "string" || typeof candidate.state !== "string" ||
      typeof candidate.updatedAt !== "string") return undefined;
    if (!["claimed", "clicking", "unknown", "recovered", "retry_authorized", "submitted"].includes(candidate.state)) return undefined;
    return candidate as SubmissionFence;
  } catch {
    return undefined;
  }
}

/** Durable single-worker submission fencing. Sheets remains a queue, never a lock. */
export class DurableSubmissionAuthority {
  private readonly storage: KeyValueStorage;

  constructor(
    private readonly workerId: string,
    options: { storage?: KeyValueStorage; stateFile?: string } = {},
  ) {
    if (!workerId.trim()) throw new Error("Submission worker ID must be non-empty.");
    this.storage = options.storage ?? new FileKeyValueStorage(options.stateFile);
  }

  claim(applicationId: string, jobId: string, now: string): SubmissionFence {
    return this.transaction(() => {
      const key = fenceKey(applicationId, jobId);
      const existing = parse(this.storage.getItem(storageKey(key)));
      if (existing && existing.workerId !== this.workerId) {
        throw new SubmissionAuthorityError("This application already has a submission fence owned by another worker or an unresolved outcome.");
      }
      if (existing && (existing.state === "clicking" || existing.state === "unknown" || existing.state === "submitted")) {
        throw new SubmissionAuthorityError("This application has already crossed the submission boundary and cannot be submitted automatically again.");
      }
      const fence: SubmissionFence = {
        key,
        applicationId,
        jobId,
        workerId: this.workerId,
        token: randomUUID(),
        state: "claimed",
        updatedAt: now,
        ...(existing?.recovery ? { recovery: existing.recovery } : {}),
        ...(existing?.duplicateRiskRetryAuthorization ? { duplicateRiskRetryAuthorization: existing.duplicateRiskRetryAuthorization } : {}),
      };
      this.write(fence);
      return fence;
    });
  }

  /** Explicitly authorize one duplicate-risk retry; this does not click or open a browser. */
  authorizeDuplicateRiskRetry(
    applicationId: string,
    jobId: string,
    input: { confirmedRisk: true; reason: string },
    now: string,
  ): SubmissionFence {
    return this.transaction(() => {
      const key = fenceKey(applicationId, jobId);
      const current = parse(this.storage.getItem(storageKey(key)));
      if (!current || current.applicationId !== applicationId || current.jobId !== jobId) {
        throw new SubmissionAuthorityError("The exact application/job submission fence was not found.");
      }
      if (current.duplicateRiskRetryAuthorization) {
        throw new SubmissionAuthorityError("Duplicate-risk retry authorization was already consumed for this exact application/job fence.");
      }
      if (current.state !== "unknown" || current.proofExternalApplicationId) {
        throw new SubmissionAuthorityError("Duplicate-risk retry requires one unresolved unknown fence with no submission proof.");
      }
      if (input.confirmedRisk !== true || input.reason.trim().length < 10) {
        throw new SubmissionAuthorityError("Duplicate-risk retry requires explicit confirmedRisk=true and a reason of at least 10 characters.");
      }
      const authorized: SubmissionFence = {
        ...current,
        state: "retry_authorized",
        updatedAt: now,
        duplicateRiskRetryAuthorization: {
          kind: "explicit_duplicate_risk_retry",
          confirmedRisk: true,
          reason: input.reason.trim(),
          authorizedAt: now,
          previousToken: current.token,
        },
      };
      this.write(authorized);
      return authorized;
    });
  }

  /**
   * Record an explicit user assertion that an unknown click was stopped by an
   * external challenge before the employer received the application. This is
   * deliberately a state transition only: it never opens a browser or retries
   * a click. A later, separately authorized claim is the only way to begin a
   * fresh attempt.
   */
  recoverUnknownForFreshAttempt(
    applicationId: string,
    jobId: string,
    input: { confirmedNotSubmitted: true; reason: string },
    now: string,
  ): SubmissionFence {
    return this.transaction(() => {
      const key = fenceKey(applicationId, jobId);
      const current = parse(this.storage.getItem(storageKey(key)));
      if (!current || current.applicationId !== applicationId || current.jobId !== jobId) {
        throw new SubmissionAuthorityError("The exact application/job submission fence was not found.");
      }
      if (current.state === "recovered" && current.recovery) {
        if (input.confirmedNotSubmitted === true && input.reason.trim() === current.recovery.reason) return current;
        throw new SubmissionAuthorityError("Recovery is already recorded; retry must use the same exact no-submission assertion.");
      }
      if (current.state !== "unknown" || current.proofExternalApplicationId) {
        throw new SubmissionAuthorityError("Recovery requires one unresolved unknown fence with no submission proof.");
      }
      if (input.confirmedNotSubmitted !== true || input.reason.trim().length < 10) {
        throw new SubmissionAuthorityError("Recovery requires explicit confirmedNotSubmitted=true and a reason of at least 10 characters.");
      }
      const recovered: SubmissionFence = {
        ...current,
        state: "recovered",
        updatedAt: now,
        recovery: {
          kind: "user_asserted_not_submitted",
          confirmedNotSubmitted: true,
          reason: input.reason.trim(),
          assertedAt: now,
          previousToken: current.token,
        },
      };
      this.write(recovered);
      return recovered;
    });
  }

  beforeClick(fence: SubmissionFence, now: string): void {
    this.transaction(() => {
      const current = this.read(fence);
      if (current.workerId !== this.workerId || current.token !== fence.token || current.state !== "claimed") {
        throw new SubmissionAuthorityError("Submission ownership was lost before the final click; no application was submitted.");
      }
      this.write({ ...current, state: "clicking", updatedAt: now });
    });
  }

  markUnknown(fence: SubmissionFence, now: string): void {
    this.transaction(() => {
      const current = this.read(fence);
      if (current.token !== fence.token) return;
      this.write({ ...current, state: "unknown", updatedAt: now });
    });
  }

  markSubmitted(fence: SubmissionFence, externalApplicationId: string, now: string): void {
    this.transaction(() => {
      const current = this.read(fence);
      if (current.token !== fence.token || current.workerId !== this.workerId || current.state !== "clicking") {
        throw new SubmissionAuthorityError("Submission proof did not match the durable submission fence.");
      }
      this.write({ ...current, state: "submitted", proofExternalApplicationId: externalApplicationId, updatedAt: now });
    });
  }

  /** Explicit human confirmation closes an unknown click without retrying it. */
  confirmManual(fence: SubmissionFence, confirmationId: string, now: string): void {
    this.transaction(() => {
      const current = this.read(fence);
      if (current.token !== fence.token || current.workerId !== this.workerId || current.state !== "unknown") {
        throw new SubmissionAuthorityError("Manual confirmation requires the same exact application/job fence in unknown state.");
      }
      this.write({ ...current, state: "submitted", proofExternalApplicationId: `user-confirmed:${confirmationId}`, updatedAt: now });
    });
  }

  get(applicationId: string, jobId: string): SubmissionFence | undefined {
    (this.storage as KeyValueStorage & { reload?: () => void }).reload?.();
    return parse(this.storage.getItem(storageKey(fenceKey(applicationId, jobId))));
  }

  /** Crash recovery is read-only: it never opens a browser or retries a click. */
  reconcile(applicationId: string, jobId: string): SubmissionReconciliation {
    const fence = this.get(applicationId, jobId);
    if (!fence) return { state: "not_found" };
    if (fence.state === "submitted" && fence.proofExternalApplicationId) {
      return { state: "submitted", externalApplicationId: fence.proofExternalApplicationId };
    }
    return { state: "needs_input", reason: fence.state === "unknown"
      ? "A prior submission click had no deterministic confirmation; verify externally and do not retry automatically."
      : "Submission was in progress when the worker stopped; no automatic retry is permitted." };
  }

  private read(fence: SubmissionFence): SubmissionFence {
    const current = this.get(fence.applicationId, fence.jobId);
    if (!current) throw new SubmissionAuthorityError("The durable submission fence is missing.");
    return current;
  }

  private write(fence: SubmissionFence): void {
    this.storage.setItem(storageKey(fence.key), JSON.stringify(fence));
  }

  private transaction<T>(operation: () => T): T {
    const locked = this.storage as KeyValueStorage & { withExclusiveLock?: <R>(fn: () => R) => R };
    return locked.withExclusiveLock ? locked.withExclusiveLock(operation) : operation();
  }
}
