/**
 * Golden-task schema for the evals harness.
 * JSON fixtures under `evals/golden/fixtures/` should match these shapes.
 * Expand toward ≥20 tasks by adding one JSON file per scenario.
 */

import type { EvalTaskKind, GraderKind } from "../types";
import type { AtsClassificationKind } from "../../application-agent/src/domain/jobUrlClassifier";
import type {
  CandidateProfile,
  FitClassification,
  JobPosting,
} from "../../application-agent/src/domain/types";
import type { SubmissionAuthority } from "../../application-agent/src/domain/campaignTypes";

export interface GoldenTaskBase {
  id: string;
  kind: EvalTaskKind;
  description: string;
  graders: readonly GraderKind[];
}

export interface ClassifyUrlTask extends GoldenTaskBase {
  kind: "classify_url";
  input: { url: string };
  expected: {
    kind: AtsClassificationKind;
    siteIdentifier?: string;
    postingIdentifier?: string;
  };
}

export interface AssessFitTask extends GoldenTaskBase {
  kind: "assess_fit";
  input: {
    job: JobPosting;
    profile: CandidateProfile;
  };
  expected: {
    classification: FitClassification;
    mustIncludeStrongMatches?: readonly string[];
    mustIncludeUnsupportedRequired?: readonly string[];
    recommendedResumeFamily?: string;
  };
}

export interface FieldFillTask extends GoldenTaskBase {
  kind: "field_fill";
  input: {
    job: JobPosting;
    profile: CandidateProfile;
  };
  expected: {
    autoFieldsResolved: readonly string[];
    neverAutoBlocked: readonly string[];
  };
}

export interface SubmitPolicyTask extends GoldenTaskBase {
  kind: "submit_policy";
  input: {
    authority: SubmissionAuthority;
    requireExplicitApproval: boolean;
  };
  expected: {
    /** Fail-closed: submit must never be allowed under authority "never". */
    allowed: boolean;
    mustBlockOnAuthorityNever: boolean;
  };
}

export interface GroundednessTask extends GoldenTaskBase {
  kind: "groundedness";
  input: {
    draftText: string;
    profileFacts: readonly string[];
    jobTitle: string;
    jobCompany: string;
  };
  expected: {
    minScore: number;
    mustNotInventSkills?: readonly string[];
  };
}

export type GoldenTask =
  | ClassifyUrlTask
  | AssessFitTask
  | FieldFillTask
  | SubmitPolicyTask
  | GroundednessTask;

export function isGoldenTask(value: unknown): value is GoldenTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  return (
    typeof task.id === "string" &&
    typeof task.kind === "string" &&
    typeof task.description === "string" &&
    Array.isArray(task.graders) &&
    task.input !== undefined &&
    task.expected !== undefined
  );
}
