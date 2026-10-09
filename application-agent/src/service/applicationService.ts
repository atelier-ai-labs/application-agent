import {
  blockersFromAnswers,
  prepareApplicationAnswers,
} from "../domain/answers";
import { createApplicationEvent } from "../domain/events";
import type { ExecutionTraceBuilder } from "../domain/executionTrace";
import { assertTransition } from "../domain/lifecycle";
import {
  deterministicModelClient,
  type ModelClient,
} from "../domain/model";
import type {
  AnswerValue,
  Application,
  ApplicationEvent,
  ApplicationStatus,
  CandidateProfile,
  FitAssessment,
  JobIntakeInput,
  JobPosting,
  ManualSubmissionConfirmation,
  SubmissionProof,
  SubmissionApproval,
} from "../domain/types";
import { isJobPosting, isManualSubmissionConfirmation, isSubmissionProof } from "../domain/validation";
import { getDefaultApplicationRepository, type ApplicationRepository } from "../persistence/applicationRepository";

let fallbackId = 0;

export interface ApplicationServiceOptions {
  now?: () => string;
  createId?: (prefix: string) => string;
}

/** Narrow opt-in recorder used only when Career Agent owns a run trace. */
export interface ApplicationInstrumentation {
  trace: ExecutionTraceBuilder;
  parentNodeId?: string;
}

function defaultCreateId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  fallbackId += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackId}`;
}

function defaultNow(): string {
  return new Date().toISOString();
}

function nonEmptyAnswerValue(value: AnswerValue): boolean {
  return typeof value !== "string" || value.trim().length > 0;
}

export class ApplicationNotFoundError extends Error {
  constructor(applicationId: string) {
    super(`Application ${applicationId} was not found.`);
    this.name = "ApplicationNotFoundError";
  }
}

export class SubmissionDisabledError extends Error {
  constructor() {
    super("Application submission is disabled in V0; review and submit manually.");
    this.name = "SubmissionDisabledError";
  }
}

export class ApplicationService {
  private readonly now: () => string;
  private readonly createId: (prefix: string) => string;

  constructor(
    private readonly repository: ApplicationRepository = getDefaultApplicationRepository(),
    private readonly profile: CandidateProfile,
    private readonly model: ModelClient = deterministicModelClient,
    options: ApplicationServiceOptions = {},
  ) {
    this.now = options.now ?? defaultNow;
    this.createId = options.createId ?? defaultCreateId;
  }

  listApplications(): readonly Application[] {
    return [...this.repository.listApplications()].sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    );
  }

  getApplication(applicationId: string): Application {
    const application = this.repository.getApplication(applicationId);
    if (!application) {
      throw new ApplicationNotFoundError(applicationId);
    }
    return application;
  }

  listEvents(applicationId: string): readonly ApplicationEvent[] {
    return this.repository.listEvents(applicationId);
  }

  async createApplication(input: JobIntakeInput): Promise<Application> {
    const job = await this.model.analyzeJob(input, this.now());
    return this.createApplicationFromJob(job, input.isExample === true);
  }

  async createApplicationFromJob(job: JobPosting, isExample = false): Promise<Application> {
    if (!isJobPosting(job)) {
      throw new Error("A normalized job posting is required before creating an application.");
    }
    const createdAt = this.now();
    const application: Application = {
      id: this.createId("application"),
      isExample,
      job,
      fit: null,
      resume: null,
      answers: [],
      blockers: [],
      status: "discovered",
      createdAt,
      updatedAt: createdAt,
    };

    this.repository.saveApplication(application);
    this.appendEvent(
      application.id,
      "application.created",
      { source: application.isExample ? "example" : "pasted" },
    );
    return application;
  }

  /** Update only the normalized posting provenance after a destination is verified. */
  updateApplicationJob(applicationId: string, job: JobPosting): Application {
    if (!isJobPosting(job)) throw new Error("A normalized job posting is required before updating an application.");
    const application = this.getApplication(applicationId);
    if (application.status === "applied") {
      throw new Error("An Applied application cannot be rewritten with a new destination.");
    }
    const updated: Application = {
      ...application,
      job,
      updatedAt: this.now(),
    };
    this.repository.saveApplication(updated);
    return updated;
  }

  async assessJob(job: JobPosting): Promise<FitAssessment> {
    return this.model.assessFit(job, this.profile);
  }

  async evaluateApplication(applicationId: string, knownFit?: FitAssessment): Promise<Application> {
    const application = this.getApplication(applicationId);
    assertTransition(application.status, "evaluated");
    const fit = knownFit ?? await this.assessJob(application.job);
    const evaluated: Application = {
      ...application,
      fit,
      status: "evaluated",
      updatedAt: this.now(),
    };

    this.repository.saveApplication(evaluated);
    this.appendEvent(applicationId, "application.evaluated", {
      classification: fit.classification,
      resumeFamily: fit.recommendedResumeFamily,
    });
    return evaluated;
  }

  async prepareApplication(applicationId: string, instrumentation?: ApplicationInstrumentation): Promise<Application> {
    const application = this.getApplication(applicationId);
    assertTransition(application.status, "preparing");
    if (!application.fit) {
      throw new Error("Application must be evaluated before preparation.");
    }
    const fit = application.fit;

    const preparing: Application = {
      ...application,
      status: "preparing",
      updatedAt: this.now(),
    };
    this.repository.saveApplication(preparing);

    try {
      const generatedAt = this.now();
      const resumeOperation = () => this.model.draftResume(
        application.job,
        this.profile,
        fit,
        generatedAt,
      );
      const resume = instrumentation
        ? await instrumentation.trace.measure(
          `preparation.resume.${applicationId}`,
          "judgment",
          resumeOperation,
          {
            parentNodeId: instrumentation.parentNodeId,
            inputCount: 1,
            outputCount: () => 1,
            metadata: { stage: "preparation.resume", applicationId },
          },
        )
        : await resumeOperation();
      const answersOperation = () => prepareApplicationAnswers(
        application.job,
        this.profile,
        fit,
        resume,
        (context) => this.model.draftAnswer(context),
      );
      const answers = instrumentation
        ? await instrumentation.trace.measure(
          `preparation.answers.${applicationId}`,
          "judgment",
          answersOperation,
          {
            parentNodeId: instrumentation.parentNodeId,
            inputCount: 1,
            outputCount: (value) => value.length,
            metadata: { stage: "preparation.answers", applicationId },
          },
        )
        : await answersOperation();
      const blockers = instrumentation
        ? instrumentation.trace.measureSync(
          `preparation.blocker-evaluation.${applicationId}`,
          "deterministic",
          () => blockersFromAnswers(answers),
          {
            parentNodeId: instrumentation.parentNodeId,
            inputCount: answers.length,
            outputCount: (value) => value.length,
            metadata: { stage: "preparation.blocker-evaluation", applicationId },
          },
        )
        : blockersFromAnswers(answers);
      const status: ApplicationStatus = blockers.length > 0
        ? "needs_input"
        : "ready_for_review";
      assertTransition("preparing", status);
      const prepared: Application = {
        ...preparing,
        resume,
        answers,
        blockers,
        status,
        updatedAt: this.now(),
      };

      this.repository.saveApplication(prepared);
      this.appendEvent(applicationId, "application.prepared", {
        blockerCount: String(blockers.length),
      });
      this.appendEvent(
        applicationId,
        status === "needs_input"
          ? "application.needs_input"
          : "application.ready_for_review",
        status === "needs_input" ? { blockerCount: String(blockers.length) } : undefined,
      );
      return prepared;
    } catch (error) {
      const current = this.repository.getApplication(applicationId);
      if (current && current.status === "preparing") {
        this.failApplication(applicationId, "Preparation failed; no application was submitted.");
      }
      throw error;
    }
  }

  /** Recompute a proof-free packet against the current profile and model. */
  async reprepareExistingApplication(applicationId: string, knownFit?: FitAssessment, refreshedJob?: JobPosting): Promise<Application> {
    const application = this.getApplication(applicationId);
    if (application.status === "applied" || application.submissionProof) {
      throw new Error("An applied or proof-bearing application cannot be re-prepared.");
    }
    if (application.status === "preparing") {
      throw new Error("An application already being prepared cannot be re-prepared concurrently.");
    }
    const job = refreshedJob ?? application.job;
    const fit = knownFit ?? await this.assessJob(job);
    const resume = await this.model.draftResume(job, this.profile, fit, this.now());
    const generated = await prepareApplicationAnswers(
      job,
      this.profile,
      fit,
      resume,
      (context) => this.model.draftAnswer(context),
    );
    const preserved = application.answers.filter((answer) => answer.status === "resolved" && answer.policy !== "draft_review");
    const answers = generated.map((answer) => preserved.find((candidate) => candidate.field === answer.field) ?? answer);
    const blockers = blockersFromAnswers(answers);
    const status: ApplicationStatus = blockers.length > 0 ? "needs_input" : "ready_for_review";
    const updated: Application = {
      ...application,
      job,
      fit,
      resume,
      answers,
      blockers,
      status,
      failureReason: undefined,
      updatedAt: this.now(),
    };
    this.repository.saveApplication(updated);
    this.appendEvent(applicationId, "application.evaluated", { classification: fit.classification, resumeFamily: fit.recommendedResumeFamily, recovery: "profile_resume_family_refresh" });
    this.appendEvent(applicationId, "application.prepared", { blockerCount: String(blockers.length), recovery: "profile_resume_family_refresh" });
    return updated;
  }

  async prepareFromIntake(input: JobIntakeInput): Promise<Application> {
    const created = await this.createApplication(input);
    const evaluated = await this.evaluateApplication(created.id);
    return this.prepareApplication(evaluated.id);
  }

  async prepareFromNormalizedJob(
    job: JobPosting,
    isExample = false,
    knownFit?: FitAssessment,
  ): Promise<Application> {
    const created = await this.createApplicationFromJob(job, isExample);
    const fit = knownFit ?? await this.assessJob(job);
    const evaluated = await this.evaluateApplication(created.id, fit);
    return this.prepareApplication(evaluated.id);
  }

  /**
   * Reopens the same fully prepared packet after a retryable browser-execution
   * failure. This never creates a new application or regenerates preparation
   * output; it only restores the manual-review boundary for another trusted
   * execution attempt.
   */
  reopenFailedApplicationForExecution(applicationId: string): Application {
    const application = this.getApplication(applicationId);
    if (application.status !== "failed" && application.status !== "ready_for_review") {
      throw new Error("Only a failed or already-recovered application packet can be reopened for browser execution.");
    }
    if (application.status === "failed" && (!application.fit || !application.resume)) {
      throw new Error("A failed application must retain grounded fit and resume outputs before browser recovery.");
    }
    if (application.status === "failed" && application.blockers.some((blocker) => blocker.status === "open")) {
      throw new Error("A failed application with unresolved preparation blockers cannot be reopened for browser execution.");
    }
    if (application.status === "ready_for_review") return application;
    assertTransition(application.status, "ready_for_review");
    const reopened: Application = {
      ...application,
      status: "ready_for_review",
      failureReason: undefined,
      updatedAt: this.now(),
    };
    this.repository.saveApplication(reopened);
    this.appendEvent(applicationId, "application.ready_for_review", {
      recovery: "retryable_browser_execution",
    });
    return reopened;
  }

  /** Reopens only explicitly selected form fields for a manual browser handoff. */
  reopenFieldsForManualHandoff(applicationId: string, fields: readonly string[]): Application {
    const application = this.getApplication(applicationId);
    if (application.status !== "ready_for_review" && !(application.status === "needs_input" && application.blockers.every((blocker) => blocker.status === "resolved"))) throw new Error("Only a ready application can reopen manual fields.");
    const selected = new Set(fields);
    if (selected.size === 0) throw new Error("At least one manual field is required.");
    const blockers = application.blockers.map((blocker) => selected.has(blocker.field) || selected.has(blocker.id)
      ? { ...blocker, status: "open" as const, resolvedAt: undefined, value: undefined }
      : blocker);
    const aggregateDemographic = application.blockers.some((blocker) => blocker.field === "demographic_disclosure" && blocker.status === "resolved");
    const careerOnlyBrowserField = (field: string): boolean => /^(?:\d+|question_\d+|gdpr_[a-z0-9_]+)$/i.test(field);
    if (!fields.every((field) => application.blockers.some((blocker) => (blocker.field === field || blocker.id === field) && blocker.status === "resolved") || (aggregateDemographic && careerOnlyBrowserField(field)))) throw new Error("A requested manual field is missing or not resolved.");
    const reopened: Application = { ...application, blockers, status: "ready_for_review", updatedAt: this.now() };
    this.repository.saveApplication(reopened);
    return reopened;
  }

  /** Defer generic preparation placeholders until the real ATS form is inspected. */
  deferGenericPreparationBlockersForInspection(applicationId: string): Application {
    const application = this.getApplication(applicationId);
    if (application.status !== "needs_input") return application;
    const genericFields = new Set(["salary_expectations", "relocation", "travel", "demographic_disclosure", "legal_attestations"]);
    const remaining = application.blockers.filter((blocker) => blocker.status !== "open" || !genericFields.has(blocker.field));
    if (remaining.some((blocker) => blocker.status === "open")) return application;
    assertTransition(application.status, "ready_for_review");
    const updated = { ...application, blockers: remaining, status: "ready_for_review" as const, updatedAt: this.now() };
    this.repository.saveApplication(updated);
    this.appendEvent(applicationId, "application.ready_for_review", { deferred: "generic_preparation_until_ats_inspection" });
    return updated;
  }

  recordApplied(applicationId: string, submissionProof: SubmissionProof): Application {
    if (!isSubmissionProof(submissionProof)) {
      throw new Error("A valid external or simulated submission proof is required.");
    }

    const application = this.getApplication(applicationId);
    assertTransition(application.status, "applied");
    const applied: Application = {
      ...application,
      status: "applied",
      submissionProof,
      updatedAt: this.now(),
    };

    this.repository.saveApplication(applied);
    this.appendEvent(applicationId, "application.applied", {
      mode: submissionProof.mode,
      provider: submissionProof.provider,
    });
    return applied;
  }

  /**
   * Record the user's explicit confirmation after they submitted manually. This
   * is deliberately not represented as executor proof or an invented ATS ID.
   */
  recordManualSubmissionConfirmation(applicationId: string, confirmedAt = this.now()): Application {
    const confirmation: ManualSubmissionConfirmation = {
      mode: "manual",
      confirmedAt,
      evidence: "user_confirmed_successful_manual_submission",
    };
    if (!isManualSubmissionConfirmation(confirmation)) {
      throw new Error("A manual submission confirmation must include a valid confirmation timestamp.");
    }

    const application = this.getApplication(applicationId);
    assertTransition(application.status, "applied");
    const applied: Application = {
      ...application,
      status: "applied",
      manualSubmissionConfirmation: confirmation,
      updatedAt: this.now(),
    };

    this.repository.saveApplication(applied);
    this.appendEvent(applicationId, "application.applied", {
      mode: "manual",
      provider: "user-confirmed",
    });
    return applied;
  }

  /**
   * Correct a manual confirmation that was recorded in error. This is an
   * explicit operator repair path; executor submission proof can never be
   * retracted through it.
   */
  retractManualSubmissionConfirmation(applicationId: string, reason: string): Application {
    const application = this.getApplication(applicationId);
    if ((application.status !== "applied" && application.status !== "ready_for_review") || !application.manualSubmissionConfirmation || application.submissionProof) {
      throw new Error("Only an Applied or inconsistent ready-for-review application with manual confirmation and no submission proof can be corrected.");
    }
    const restored: Application = {
      ...application,
      status: "ready_for_review",
      manualSubmissionConfirmation: undefined,
      updatedAt: this.now(),
    };
    this.repository.saveApplication(restored);
    this.appendEvent(applicationId, "application.failed", {
      reason,
      correction: "manual_submission_confirmation_retracted",
    });
    return restored;
  }

  resolveHumanField(applicationId: string, blockerId: string, value: AnswerValue): Application {
    if (!nonEmptyAnswerValue(value)) {
      throw new Error("A human-required field needs a non-empty answer.");
    }

    const application = this.getApplication(applicationId);
    assertTransition(application.status, "needs_input");
    const blocker = application.blockers.find(
      (candidate) => candidate.id === blockerId || candidate.field === blockerId,
    );
    if (!blocker || blocker.status === "resolved") {
      throw new Error("That human-required field is no longer open.");
    }

    const answers = application.answers.map((answer) =>
      answer.id === blocker.answerId
        ? { ...answer, value, status: "resolved" as const }
        : answer,
    );
    const blockers = application.blockers.map((candidate) =>
      candidate.id === blocker.id
        ? { ...candidate, status: "resolved" as const, value }
        : candidate,
    );
    const ready = blockers.every((candidate) => candidate.status === "resolved");
    const status: ApplicationStatus = ready ? "ready_for_review" : "needs_input";
    const updated: Application = {
      ...application,
      answers,
      blockers,
      status,
      updatedAt: this.now(),
    };

    this.repository.saveApplication(updated);
    if (ready) {
      this.appendEvent(applicationId, "application.ready_for_review");
    }
    return updated;
  }

  failApplication(applicationId: string, reason = "Application preparation failed."): Application {
    const application = this.getApplication(applicationId);
    if (application.status === "applied") {
      throw new Error("An applied application cannot be marked failed.");
    }
    assertTransition(application.status, "failed");
    const failed: Application = {
      ...application,
      status: "failed",
      failureReason: reason,
      updatedAt: this.now(),
    };
    this.repository.saveApplication(failed);
    this.appendEvent(applicationId, "application.failed", { reason: "workflow_failed" });
    return failed;
  }

  async submitApplication(_applicationId: string, _approval: SubmissionApproval): Promise<never> {
    throw new SubmissionDisabledError();
  }

  private appendEvent(
    applicationId: string,
    type: ApplicationEvent["type"],
    metadata?: Readonly<Record<string, string>>,
  ): void {
    this.repository.appendEvent(
      createApplicationEvent(
        applicationId,
        type,
        { now: this.now, createId: this.createId },
        metadata,
      ),
    );
  }
}

export function createApplicationService(
  profile: CandidateProfile,
  repository: ApplicationRepository = getDefaultApplicationRepository(),
  model: ModelClient = deterministicModelClient,
  options?: ApplicationServiceOptions,
): ApplicationService {
  return new ApplicationService(repository, profile, model, options);
}
