import { buildDraftAnswer, type AnswerDraftContext } from "./answers";
import { assessFit } from "./fit";
import { pastedJobPostingIngestor } from "./job";
import { tailorResume } from "./resume";
import type {
  ApplicationAnswer,
  CandidateProfile,
  FitAssessment,
  JobIntakeInput,
  JobPosting,
  TailoredResume,
} from "./types";

export interface ModelClient {
  analyzeJob(input: JobIntakeInput, capturedAt: string): Promise<JobPosting>;
  assessFit(job: JobPosting, profile: CandidateProfile): Promise<FitAssessment>;
  draftResume(
    job: JobPosting,
    profile: CandidateProfile,
    fit: FitAssessment,
    generatedAt: string,
  ): Promise<TailoredResume>;
  draftAnswer(context: AnswerDraftContext): Promise<ApplicationAnswer>;
}

/**
 * The default V0 client is deliberately local and deterministic. It exercises
 * the same replaceable boundary an eventual model provider will implement,
 * while keeping profile data on-device and tests offline.
 */
export class DeterministicModelClient implements ModelClient {
  async analyzeJob(input: JobIntakeInput, capturedAt: string): Promise<JobPosting> {
    return pastedJobPostingIngestor.ingest(input, capturedAt);
  }

  async assessFit(job: JobPosting, profile: CandidateProfile): Promise<FitAssessment> {
    return assessFit(job, profile);
  }

  async draftResume(
    job: JobPosting,
    profile: CandidateProfile,
    fit: FitAssessment,
    generatedAt: string,
  ): Promise<TailoredResume> {
    return tailorResume(job, profile, fit, generatedAt);
  }

  async draftAnswer(context: AnswerDraftContext): Promise<ApplicationAnswer> {
    return buildDraftAnswer(context);
  }
}

export const deterministicModelClient = new DeterministicModelClient();

export const MODEL_BOUNDARY_NOTE =
  "No external model is configured. V0 uses a deterministic local implementation.";
