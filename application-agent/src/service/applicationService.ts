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
