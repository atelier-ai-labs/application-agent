import { randomUUID } from "node:crypto";
import type {
  ApplicationExecutionRequest,
  ApplicationExecutor,
  ApplicationExecutorResult,
  BrowserExecutionTelemetry,
  ExecutionInspection,
} from "../../src/domain/executor";
import { executionFailureReason, monotonicNow } from "../../src/domain/executionTrace";
import type {
  ExecutionHostRequest,
  ExecutionHostResult,
  ExecutionHostSnapshot,
  ExecutionHostStatus,
} from "../../src/domain/executionHostTypes";
import { assertTrustedExecutionRequest } from "./trustedRequest";

export interface ExecutionHostLogEntry {
  event: "started" | "status" | "closed" | "failed";
  executionId: string;
  applicationId: string;
  jobId: string;
  status: ExecutionHostStatus;
  reason?: string;
}

export interface ExecutionSessionRegistryOptions {
  executor: ApplicationExecutor;
  now?: () => string;
  createId?: () => string;
  maxConcurrent?: number;
  sessionTimeoutMs?: number;
  logger?: (entry: ExecutionHostLogEntry) => void;
}

export class ExecutionHostRegistryError extends Error {
  constructor(
    message: string,
    public readonly code: "invalid_request" | "payload_too_large" | "capacity" | "not_found" | "conflict" | "state",
  ) {
    super(message);
    this.name = "ExecutionHostRegistryError";
  }
}

interface ExecutionSession {
  readonly id: string;
  request: ExecutionHostRequest;
  readonly browserSessionHandle: symbol;
  snapshot: ExecutionHostSnapshot;
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
  terminal: boolean;
  attempt: number;
}

const ACTIVE_STATUSES: ReadonlySet<ExecutionHostStatus> = new Set([
  "starting",
  "inspecting",
  "executing",
  "needs_input",
  "waiting_for_human",
  "resuming",
  "ready_to_submit",
]);

function defaultNow(): string {
  return new Date().toISOString();
}

function defaultCreateId(): string {
  return `execution-${randomUUID()}`;
}

function safeReason(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  // Keep host errors useful without echoing request bodies or long browser
  // payloads into the API/log stream.
  const compact = message
    .replace(/\s+/g, " ")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/\+?\d[\d() .-]{7,}\d/g, "[redacted-number]")
    .trim();
  return (compact || fallback).slice(0, 500);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isBoundaryBlocker(result: Extract<ExecutionHostResult, { state: "requires_human" }>): boolean {
  return result.blocker.kind === "external_login" ||
    result.blocker.kind === "captcha" ||
    result.blocker.kind === "external_verification";
}

function requestForHost(request: ExecutionHostRequest, now: string): ApplicationExecutionRequest {
  return {
    campaign: request.campaign,
    careerJob: request.careerJob,
    application: request.application,
    profile: request.profile,
    now,
  };
}

function unsupportedFromInspection(inspection: ExecutionInspection): ExecutionHostResult {
  return {
    state: "unsupported",
    reason: inspection.evidence.find((item) => item.startsWith("unsupported:"))?.slice("unsupported:".length) ??
      "The browser executor could not safely support this application form.",
    ...(inspection.blockers[0] ? { blocker: inspection.blockers[0] } : {}),
    inspection,
  };
}

function failedFromInspection(inspection: ExecutionInspection): ExecutionHostResult {
  return {
    state: "failed",
    reason: inspection.evidence.find((item) => item.startsWith("error:"))?.slice("error:".length) ??
      "The browser executor could not inspect this application form.",
    retryable: true,
    inspection,
  };
}

function blockerFromInspection(inspection: ExecutionInspection): ExecutionHostResult | undefined {
  if (inspection.status === "needs_input" && inspection.blockers[0]) {
    return {
      state: "requires_human",
      blocker: inspection.blockers[0],
      blockers: inspection.blockers,
      inspection,
    };
  }
  if (inspection.status === "unsupported") return unsupportedFromInspection(inspection);
  if (inspection.status === "failed") return failedFromInspection(inspection);
  return undefined;
}

function statusForResult(result: ExecutionHostResult): ExecutionHostStatus {
  if (result.state === "requires_human") return isBoundaryBlocker(result) ? "waiting_for_human" : "needs_input";
  if (result.state === "unsupported") return "needs_input";
  if (result.state === "ready_to_submit") return "ready_to_submit";
  return "failed";
}

export class ExecutionSessionRegistry {
  private readonly now: () => string;
  private readonly createId: () => string;
  private readonly executor: ApplicationExecutor;
  private readonly maxConcurrent: number;
  private readonly sessionTimeoutMs: number;
  private readonly logger?: (entry: ExecutionHostLogEntry) => void;
  private readonly sessions = new Map<string, ExecutionSession>();

  constructor(options: ExecutionSessionRegistryOptions) {
    this.now = options.now ?? defaultNow;
    this.createId = options.createId ?? defaultCreateId;
    this.executor = options.executor;
    this.maxConcurrent = options.maxConcurrent ?? 1;
    this.sessionTimeoutMs = options.sessionTimeoutMs ?? 30 * 60 * 1_000;
    this.logger = options.logger;
    if (!Number.isInteger(this.maxConcurrent) || this.maxConcurrent <= 0) {
      throw new Error("Execution host concurrency must be a positive integer.");
    }
    if (!Number.isInteger(this.sessionTimeoutMs) || this.sessionTimeoutMs <= 0) {
      throw new Error("Execution host session timeout must be a positive integer.");
    }
  }

  start(request: ExecutionHostRequest): ExecutionHostSnapshot {
    try {
      assertTrustedExecutionRequest(request);
    } catch (error) {
      throw new ExecutionHostRegistryError(safeReason(error, "The execution request is not trusted."), "invalid_request");
    }

    const activeForApplication = [...this.sessions.values()].find((session) =>
      !session.terminal && session.request.application.id === request.application.id,
    );
    if (activeForApplication) {
      throw new ExecutionHostRegistryError("That application already has an active browser execution.", "conflict");
    }
    if (this.activeCount() >= this.maxConcurrent) {
      throw new ExecutionHostRegistryError("The local execution host is at capacity; close or finish another browser session first.", "capacity");
    }

    const startedAt = this.now();
    const id = this.createId();
    const session: ExecutionSession = {
      id,
      request,
      browserSessionHandle: Symbol("server-only-browser-session"),
      snapshot: {
        id,
        mode: "real_local",
        applicationId: request.application.id,
        jobId: request.careerJob.id,
        campaignId: request.campaign.id,
        status: "starting",
        startedAt,
        updatedAt: startedAt,
        attempt: 1,
      },
      running: false,
      terminal: false,
      attempt: 1,
    };
    this.sessions.set(id, session);
    this.touch(session);
    this.log(session, "started");
    void this.run(session, false);
    return this.snapshot(session);
  }

  get(id: string): ExecutionHostSnapshot {
    const session = this.sessions.get(id);
    if (!session) throw new ExecutionHostRegistryError("Execution session was not found.", "not_found");
    return this.snapshot(session);
  }

  resume(id: string, replacement?: ExecutionHostRequest): ExecutionHostSnapshot {
    const session = this.sessions.get(id);
    if (!session) throw new ExecutionHostRegistryError("Execution session was not found.", "not_found");
    if (session.terminal) throw new ExecutionHostRegistryError("That execution session is closed and cannot be resumed.", "state");
    if (session.running) throw new ExecutionHostRegistryError("That execution session is already running.", "conflict");
    if (session.snapshot.status !== "needs_input" && session.snapshot.status !== "waiting_for_human") {
      throw new ExecutionHostRegistryError("Only a blocked browser execution can be resumed.", "state");
    }
    if (replacement) {
      try {
        assertTrustedExecutionRequest(replacement);
      } catch (error) {
        throw new ExecutionHostRegistryError(safeReason(error, "The replacement execution request is not trusted."), "invalid_request");
      }
      if (replacement.campaign.id !== session.request.campaign.id ||
        replacement.careerJob.id !== session.request.careerJob.id ||
        replacement.application.id !== session.request.application.id) {
        throw new ExecutionHostRegistryError("The replacement request does not belong to this browser execution.", "invalid_request");
      }
      session.request = replacement;
    }
    session.attempt += 1;
    session.snapshot = {
      ...session.snapshot,
      attempt: session.attempt,
      retryReasonCode: "human_gate",
    };
    this.update(session, "resuming");
    void this.run(session, true);
    return this.snapshot(session);
  }

  async cancel(id: string): Promise<ExecutionHostSnapshot> {
    const session = this.sessions.get(id);
    if (!session) throw new ExecutionHostRegistryError("Execution session was not found.", "not_found");
    if (session.terminal) return this.snapshot(session);
    session.terminal = true;
    this.addTelemetry(session, { cancellationCount: 1 });
    session.snapshot = { ...session.snapshot, failureReasonCode: "cancelled" };
    this.clearTimer(session);
    await this.closeExecutor(session);
    this.update(session, "cancelled", "Local browser execution was cancelled; no application was submitted.");
    this.log(session, "closed");
    return this.snapshot(session);
  }

  activeCount(): number {
    return [...this.sessions.values()].filter((session) => !session.terminal && ACTIVE_STATUSES.has(session.snapshot.status)).length;
  }

  /** Used by deterministic tests and graceful process shutdown. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map(async (session) => {
      if (session.terminal) return;
      session.terminal = true;
      this.clearTimer(session);
      await this.closeExecutor(session);
      this.update(session, "closed", "The local execution host closed; the browser session is no longer recoverable.");
      this.log(session, "closed");
    }));
  }

  async waitForStatus(
    id: string,
    statuses: ReadonlySet<ExecutionHostStatus> | readonly ExecutionHostStatus[],
    timeoutMs = 10_000,
  ): Promise<ExecutionHostSnapshot> {
    const wanted = statuses instanceof Set ? statuses : new Set(statuses);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const snapshot = this.get(id);
      if (wanted.has(snapshot.status)) return snapshot;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.get(id);
  }

  private snapshot(session: ExecutionSession): ExecutionHostSnapshot {
    return clone(session.snapshot);
  }

  private update(session: ExecutionSession, status: ExecutionHostStatus, error?: string): void {
    if (session.terminal && status !== "cancelled" && status !== "closed" && status !== "failed") return;
    session.snapshot = {
      ...session.snapshot,
      status,
      updatedAt: this.now(),
      ...(error ? { error: safeReason(error, "Execution host error.") } : {}),
    };
    if (ACTIVE_STATUSES.has(status)) this.touch(session);
    this.log(session, "status", error);
  }

  private log(session: ExecutionSession, event: ExecutionHostLogEntry["event"], reason?: string): void {
    this.logger?.({
      event,
      executionId: session.id,
      applicationId: session.request.application.id,
      jobId: session.request.careerJob.id,
      status: session.snapshot.status,
      ...(reason ? { reason: safeReason(reason, "") } : {}),
    });
  }

  private touch(session: ExecutionSession): void {
    this.clearTimer(session);
    session.timer = setTimeout(() => {
      void this.expire(session);
    }, this.sessionTimeoutMs);
    const timer = session.timer as ReturnType<typeof setTimeout> & { unref?: () => void };
    timer.unref?.();
  }

  private clearTimer(session: ExecutionSession): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = undefined;
  }

  private async expire(session: ExecutionSession): Promise<void> {
    if (session.terminal || !ACTIVE_STATUSES.has(session.snapshot.status)) return;
    session.terminal = true;
    session.snapshot = { ...session.snapshot, failureReasonCode: "timeout" };
    await this.closeExecutor(session);
    this.update(session, "failed", "The local browser execution session timed out; no application was submitted.");
    this.log(session, "failed", "session_timeout");
  }

  private async closeExecutor(session: ExecutionSession): Promise<void> {
    try {
      await this.executor.close?.(session.request.application.id);
    } catch (error) {
      this.log(session, "failed", safeReason(error, "Browser session cleanup failed."));
    }
  }

  private async run(session: ExecutionSession, resuming: boolean): Promise<void> {
    if (session.terminal || session.running) return;
    session.running = true;
    const browserPreparationStartedAt = monotonicNow();
    try {
      const request = () => requestForHost(session.request, this.now());
      if (this.executor.supports && !this.executor.supports(request())) {
        await this.finish(session, {
          state: "unsupported",
          reason: "The configured executor does not support this trusted Lever posting.",
        });
        return;
      }

      this.update(session, resuming ? "resuming" : "inspecting");
      if (this.executor.inspect) {
        const inspectionStartedAt = monotonicNow();
        let inspection: ExecutionInspection;
        try {
          inspection = await this.executor.inspect(request());
        } finally {
          this.addTelemetry(session, { preflightInspectionDurationMs: monotonicNow() - inspectionStartedAt });
        }
        if (session.terminal) {
          this.addTelemetry(session, { lateCompletionCount: 1 });
          return;
        }
        this.addTelemetry(session, { domInspectionCount: inspection.domInspectionCount ?? 0 });
        session.snapshot = {
          ...session.snapshot,
          inspection: clone(inspection),
          updatedAt: this.now(),
        };
        const inspectionResult = blockerFromInspection(inspection);
        if (inspectionResult) {
          await this.finish(session, inspectionResult);
          return;
        }
      }

      if (session.terminal) return;
      this.update(session, "executing");
      let result: ApplicationExecutorResult;
      result = await this.executor.execute(request());
      if (session.terminal) {
        this.addTelemetry(session, { lateCompletionCount: 1 });
        return;
      }
      this.addTelemetry(session, {
        executorInspectionDurationMs: result.state === "submitted" ? undefined : result.inspection?.durationMs,
        domInspectionCount: result.state === "submitted" ? 0 : result.inspection?.domInspectionCount ?? 0,
      });
      if (result.state === "submitted") {
        // This is a defense-in-depth check. The production Lever executor is
        // preparation-only, and this host never forwards submission proof.
        await this.finish(session, {
          state: "failed",
          reason: "The local preparation host rejected submission proof from an executor; no application was submitted.",
          retryable: false,
        });
        return;
      }
      await this.finish(session, result);
    } catch (error) {
      if (!session.terminal) {
        await this.finish(session, {
          state: "failed",
          reason: safeReason(error, "The local browser executor failed."),
          retryable: true,
          ...(session.snapshot.inspection ? { inspection: session.snapshot.inspection } : {}),
        });
      }
    } finally {
      this.addTelemetry(session, { browserPreparationDurationMs: monotonicNow() - browserPreparationStartedAt });
      session.running = false;
    }
  }

  private async finish(session: ExecutionSession, result: ExecutionHostResult): Promise<void> {
    if (session.terminal) return;
    const status = statusForResult(result);
    session.snapshot = {
      ...session.snapshot,
      status,
      failureReasonCode: result.state === "requires_human"
        ? "human_gate"
        : result.state === "unsupported"
          ? "validation_error"
          : result.state === "failed" ? executionFailureReason(result.reason) : undefined,
      ...(result.inspection ? { inspection: clone(result.inspection) } : {}),
      result: clone(result),
      updatedAt: this.now(),
      ...(result.state === "failed" ? { error: safeReason(result.reason, "The browser executor failed.") } : {}),
    };
    if (status === "failed") {
      session.terminal = true;
      this.clearTimer(session);
      await this.closeExecutor(session);
      this.log(session, "failed", result.state === "failed" ? result.reason : "unsupported");
    } else {
      this.touch(session);
      this.log(session, "status");
    }
  }

  private addTelemetry(session: ExecutionSession, next: BrowserExecutionTelemetry): void {
    const current = session.snapshot.telemetry;
    const sum = (left: number | undefined, right: number | undefined): number | undefined =>
      left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
    session.snapshot = {
      ...session.snapshot,
      telemetry: {
        ...(sum(current?.preflightInspectionDurationMs, next.preflightInspectionDurationMs) !== undefined
          ? { preflightInspectionDurationMs: sum(current?.preflightInspectionDurationMs, next.preflightInspectionDurationMs) } : {}),
        ...(sum(current?.executorInspectionDurationMs, next.executorInspectionDurationMs) !== undefined
          ? { executorInspectionDurationMs: sum(current?.executorInspectionDurationMs, next.executorInspectionDurationMs) } : {}),
        ...(sum(current?.browserPreparationDurationMs, next.browserPreparationDurationMs) !== undefined
          ? { browserPreparationDurationMs: sum(current?.browserPreparationDurationMs, next.browserPreparationDurationMs) } : {}),
        ...(sum(current?.domInspectionCount, next.domInspectionCount) !== undefined
          ? { domInspectionCount: sum(current?.domInspectionCount, next.domInspectionCount) } : {}),
        ...(sum(current?.cancellationCount, next.cancellationCount) !== undefined
          ? { cancellationCount: sum(current?.cancellationCount, next.cancellationCount) } : {}),
      },
    };
  }
}
