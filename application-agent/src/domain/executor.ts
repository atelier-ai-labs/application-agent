import type {
  Application,
  CandidateProfile,
  JobPosting,
  SubmissionProof,
} from "./types";
import type {
  CareerBlockerDraft,
  CareerJob,
  Campaign,
} from "./campaignTypes";

export interface ApplicationExecutionRequest {
  campaign: Campaign;
  careerJob: CareerJob;
  application: Application;
  now: string;
  /** The validated profile is supplied by the host; it is never inferred by an executor. */
  profile?: CandidateProfile;
}

/** Whether an executor can only prepare a form or may return submission proof. */
export type ApplicationExecutorMode = "preparation_only" | "submission_capable";

export type ApplicationFieldType =
  | "text"
  | "email"
  | "tel"
  | "textarea"
  | "select"
  | "radio"
  | "checkbox"
  | "file"
  | "unknown";

export type ApplicationFieldClassification =
  | "contact"
  | "resume_upload"
  | "location"
  | "employment_history"
  | "education"
  | "work_authorization"
  | "sponsorship"
  | "salary"
  | "relocation"
  | "travel"
  | "free_text"
  | "demographic"
  | "legal_attestation"
  | "unknown";

export interface ApplicationFieldOption {
  label: string;
  value: string;
}

/** Serializable description of a form field. It intentionally contains no field value. */
export interface ApplicationFieldDescriptor {
  id: string;
  label: string;
  type: ApplicationFieldType;
  required: boolean;
  options?: readonly ApplicationFieldOption[];
  section?: string;
  sourceSelector?: string;
  classification: ApplicationFieldClassification;
}

export type BrowserBoundaryKind = "external_login" | "captcha" | "external_verification";

export interface BrowserHumanBoundary {
  kind: BrowserBoundaryKind;
  question: string;
  reason: string;
  evidence: readonly string[];
}

export type BrowserCaptchaState = "none" | "infrastructure_present" | "active_challenge" | "uncertain";

export type BrowserCaptchaEvidenceCategory =
  | "no_markers"
  | "hidden_infrastructure"
  | "visible_challenge_iframe"
  | "visible_challenge_control"
  | "explicit_challenge_text"
  | "visible_marker_ambiguous";

/** Safe CAPTCHA observations; no iframe content, token, cookie, or HTML is retained. */
export interface BrowserCaptchaDiagnostics {
  state: BrowserCaptchaState;
  markerCount: number;
  visibleMarkerCount: number;
  challengeIframeCount: number;
  visibleChallengeIframeCount: number;
  evidenceCategory: BrowserCaptchaEvidenceCategory;
}

/** Stable browser-boundary stages used for safe local diagnostics. */
export type BrowserExecutionDiagnosticStage =
  | "browser_launch"
  | "context_create"
  | "page_create"
  | "navigation"
  | "page_load"
  | "preflight_inspection"
  | "controls_inspection"
  | "executor_inspection"
  | "executor_start"
  | "browser_close";

/** Stable, non-sensitive reasons for a browser preparation diagnostic. */
export type BrowserExecutionDiagnosticReasonCode =
  | "browser_launch_failed"
  | "context_create_failed"
  | "page_create_failed"
  | "navigation_failed"
  | "navigation_timeout"
  | "page_load_failed"
  | "inspection_failed"
  | "unsupported_page"
  | "browser_closed"
  | "cancelled"
  | "unknown";

export type BrowserNavigationOutcome = "not_started" | "started" | "completed" | "http_error" | "failed";
export type BrowserLoadState = "domcontentloaded" | "networkidle";

/** Monotonic stage markers; values are presence/absence evidence, not timing. */
export interface BrowserExecutionBoundaryState {
  hostRequestAccepted?: boolean;
  browserLaunched?: boolean;
  contextCreated?: boolean;
  pageCreated?: boolean;
  navigationStarted?: boolean;
  navigationCompleted?: boolean;
  domReady?: boolean;
  preflightInspectionStarted?: boolean;
  preflightInspectionCompleted?: boolean;
  controlsInspectionStarted?: boolean;
  controlsInspectionCompleted?: boolean;
  executorStarted?: boolean;
  executorInspectionStarted?: boolean;
  executorInspectionCompleted?: boolean;
  browserClosed?: boolean;
}

/** Safe navigation facts; full URLs, headers, and response bodies are excluded. */
export interface BrowserNavigationDiagnostics {
  targetHost?: string;
  finalHostname?: string;
  outcome?: BrowserNavigationOutcome;
  httpStatus?: number;
  httpStatusCategory?: "1xx" | "2xx" | "3xx" | "4xx" | "5xx";
  redirectCount?: number;
  loadStateReached?: BrowserLoadState;
  networkIdleTimedOut?: boolean;
}

export interface BrowserExecutionDiagnostic {
  stage: BrowserExecutionDiagnosticStage;
  reasonCode: BrowserExecutionDiagnosticReasonCode;
  /** Bounded, redacted developer context. Never a stack trace or page body. */
  message?: string;
  boundaries?: BrowserExecutionBoundaryState;
  navigation?: BrowserNavigationDiagnostics;
}

/** Error transport between the Playwright adapter and the browser-neutral executor. */
export class BrowserExecutionDiagnosticError extends Error {
  constructor(public readonly diagnostic: BrowserExecutionDiagnostic) {
    super(diagnostic.message ?? diagnostic.reasonCode);
    this.name = "BrowserExecutionDiagnosticError";
  }
}

/** Redacts common secret-bearing values before a short diagnostic is persisted. */
export function safeBrowserDiagnosticMessage(error: unknown, fallback: string): string {
  const source = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  const redacted = source
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]")
    .replace(/\b(?:authorization|proxy-authorization)\s*[:=]\s*bearer\s+[^\s,;]+/gi, "[redacted-secret]")
    .replace(/\b(?:cookie|set-cookie)\s*[:=]\s*[^\n]+/gi, "[redacted-secret]")
    .replace(/\b(?:authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|client[_-]?secret|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "[redacted-secret]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/\+?\d[\d() .-]{7,}\d/g, "[redacted-number]")
    .replace(/\s+/g, " ")
    .trim();
  return (redacted || fallback).slice(0, 240);
}

export function browserDiagnosticForError(
  error: unknown,
  stage: BrowserExecutionDiagnosticStage,
  reasonCode: BrowserExecutionDiagnosticReasonCode,
  fallback: string,
  context: Pick<BrowserExecutionDiagnostic, "boundaries" | "navigation"> = {},
): BrowserExecutionDiagnostic {
  if (error instanceof BrowserExecutionDiagnosticError) {
    return {
      ...error.diagnostic,
      ...(error.diagnostic.message
        ? { message: safeBrowserDiagnosticMessage(error.diagnostic.message, error.diagnostic.reasonCode) }
        : {}),
    };
  }
  return {
    stage,
    reasonCode,
    message: safeBrowserDiagnosticMessage(error, fallback),
    ...context,
  };
}

/** The small browser capability surface used by the Lever domain executor and its tests. */
export interface LeverBrowserField extends ApplicationFieldDescriptor {
  fill(value: string): Promise<void>;
  select(value: string): Promise<void>;
  setChecked(value: boolean): Promise<void>;
  uploadFile(path: string): Promise<void>;
  readValue?(): Promise<string | boolean | null>;
}

export interface LeverBrowserSession {
  navigate(url: string): Promise<void>;
  currentUrl(): string | Promise<string>;
  inspectFields(): Promise<readonly LeverBrowserField[]>;
  detectHumanBoundary(): Promise<BrowserHumanBoundary | null>;
  hasSubmitControl(): Promise<boolean>;
  diagnostics?(): {
    boundaries?: BrowserExecutionBoundaryState;
    navigation?: BrowserNavigationDiagnostics;
    diagnostic?: BrowserExecutionDiagnostic;
    captcha?: BrowserCaptchaDiagnostics;
  };
  close(): Promise<void>;
}

export interface LeverBrowserSessionFactory {
  open(applicationId: string): Promise<LeverBrowserSession>;
}

export type ExecutionInspectionStatus = "inspected" | "needs_input" | "unsupported" | "failed";

/** Safe browser-boundary measurements; no DOM values or form contents. */
export interface BrowserExecutionTelemetry {
  preflightInspectionDurationMs?: number;
  executorInspectionDurationMs?: number;
  browserPreparationDurationMs?: number;
  domInspectionCount?: number;
  cancellationCount?: number;
  lateCompletionCount?: number;
  boundaries?: BrowserExecutionBoundaryState;
  navigation?: BrowserNavigationDiagnostics;
  diagnostic?: BrowserExecutionDiagnostic;
  captcha?: BrowserCaptchaDiagnostics;
}

export interface ExecutionInspection {
  status: ExecutionInspectionStatus;
  fields: readonly ApplicationFieldDescriptor[];
  fieldsFilled: readonly string[];
  unresolvedFields: readonly string[];
  blockers: readonly CareerBlockerDraft[];
  resumeUsed?: string;
  evidence: readonly string[];
  /** Active inspection duration, excluding any human wait between attempts. */
  durationMs?: number;
  domInspectionCount?: number;
  boundaries?: BrowserExecutionBoundaryState;
  navigation?: BrowserNavigationDiagnostics;
  diagnostic?: BrowserExecutionDiagnostic;
  captcha?: BrowserCaptchaDiagnostics;
  startedAt: string;
  updatedAt: string;
}

export type ApplicationExecutorResult =
  | {
      state: "submitted";
      proof: SubmissionProof;
      note?: string;
    }
  | {
      state: "requires_human";
      blocker: CareerBlockerDraft;
      blockers?: readonly CareerBlockerDraft[];
      inspection?: ExecutionInspection;
    }
  | {
      state: "ready_to_submit";
      inspection: ExecutionInspection;
      note?: string;
    }
  | {
      state: "unsupported";
      reason: string;
      blocker?: CareerBlockerDraft;
      inspection?: ExecutionInspection;
    }
  | {
      state: "failed";
      reason: string;
      retryable: boolean;
      inspection?: ExecutionInspection;
    };

export interface ApplicationExecutor {
  id: string;
  supports?(request: ApplicationExecutionRequest | CareerJob | JobPosting): boolean;
  executionMode?(request: ApplicationExecutionRequest): ApplicationExecutorMode;
  inspect?(request: ApplicationExecutionRequest): Promise<ExecutionInspection>;
  execute(request: ApplicationExecutionRequest): Promise<ApplicationExecutorResult>;
  /** Optional lifecycle hook for executors that retain an external session. */
  close?(applicationId: string): Promise<void>;
}

export interface SimulatedApplicationExecutorOptions {
  humanJobIds?: readonly string[];
  failedJobIds?: readonly string[];
}

/**
 * Deterministic executor for local acceptance tests and the demo surface.
 * Its proof is explicitly marked simulated; it never contacts an employer.
 */
export class SimulatedApplicationExecutor implements ApplicationExecutor {
  public readonly id = "simulated-executor";
  private readonly humanJobIds: ReadonlySet<string>;
  private readonly failedJobIds: ReadonlySet<string>;

  constructor(options: SimulatedApplicationExecutorOptions = {}) {
    this.humanJobIds = new Set(options.humanJobIds ?? []);
    this.failedJobIds = new Set(options.failedJobIds ?? []);
  }

  async execute(request: ApplicationExecutionRequest): Promise<ApplicationExecutorResult> {
    if (this.failedJobIds.has(request.careerJob.id)) {
      return {
        state: "failed",
        reason: "The deterministic simulated executor was configured to fail this job.",
        retryable: false,
      };
    }

    if (this.humanJobIds.has(request.careerJob.id)) {
      return {
        state: "requires_human",
        blocker: {
          kind: "external_login",
          unit: "external",
          question: "Authenticate the application session",
          reason: "The executor requires a user-authenticated browser session before it can continue.",
          evidence: [`executor:${this.id}`, "credentials-never-requested-in-application-state"],
        },
      };
    }

    return {
      state: "submitted",
      proof: {
        mode: "simulated",
        provider: this.id,
        externalApplicationId: `simulated-${request.careerJob.id}`,
        submittedAt: request.now,
        evidence: "Deterministic local simulation only; no external request was sent.",
      },
      note: "Simulated executor success; this is not an employer-side application.",
    };
  }
}

/**
 * Keeps the local acceptance workflow useful while preventing a live posting
 * from being marked as simulated-applied by the HQ demo executor.
 */
export class SourceAwareApplicationExecutor implements ApplicationExecutor {
  public readonly id = "source-aware-executor";

  constructor(
    private readonly demoExecutor: ApplicationExecutor = new SimulatedApplicationExecutor(),
    private readonly liveExecutor: ApplicationExecutor = new UnavailableApplicationExecutor(),
  ) {}

  executionMode(request: ApplicationExecutionRequest): ApplicationExecutorMode {
    return this.selectedExecutor(request).executionMode?.(request) ?? "submission_capable";
  }

  execute(request: ApplicationExecutionRequest): Promise<ApplicationExecutorResult> {
    return this.selectedExecutor(request).execute(request);
  }

  private selectedExecutor(request: ApplicationExecutionRequest): ApplicationExecutor {
    return request.careerJob.sourceMode === "demo" || request.careerJob.isExample
      ? this.demoExecutor
      : this.liveExecutor;
  }
}

/** Honest placeholder for a future browser/ATS executor. */
export class UnavailableApplicationExecutor implements ApplicationExecutor {
  public readonly id = "unavailable-executor";

  async execute(_request: ApplicationExecutionRequest): Promise<ApplicationExecutorResult> {
    return {
      state: "requires_human",
      blocker: {
        kind: "external_verification",
        unit: "external",
        question: "Configure an authorized application executor",
        reason: "No real ATS or browser executor is configured; no external application was attempted.",
        evidence: ["executor:unavailable", "external-state:not-verified"],
      },
    };
  }
}
