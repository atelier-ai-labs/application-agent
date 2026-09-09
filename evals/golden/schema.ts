/**
 * Golden-task schema for the evals harness.
 * JSON fixtures under `evals/golden/fixtures/` should match these shapes.
 * Known-bad fail-audit fixtures live under `evals/golden/negative/` with expectFail: true.
 */

import type { EvalTaskKind, GraderKind } from "../types";
import type { AtsClassificationKind } from "../../application-agent/src/domain/jobUrlClassifier";
import type {
  CandidateProfile,
  FitClassification,
  JobPosting,
} from "../../application-agent/src/domain/types";
import type { SubmissionAuthority } from "../../application-agent/src/domain/campaignTypes";
import type { ApplicationFieldClassification } from "../../application-agent/src/domain/executor";
import type { CareerBlocker, CareerBlockerKind } from "../../application-agent/src/domain/campaignTypes";
import type { JobCompensation } from "../../application-agent/src/domain/types";
import type { RipplingPromptCandidate } from "../../application-agent/automation/ripplingDomHelpers";

export interface GoldenTaskBase {
  id: string;
  kind: EvalTaskKind;
  description: string;
  graders: readonly GraderKind[];
  /** Tag for fail-audit negatives: fixture must FAIL grading (see evals/golden/negative/). */
  expectFail?: boolean;
}

export interface ClassifyUrlTask extends GoldenTaskBase {
  kind: "classify_url";
  input: {
    url: string;
    /** When set with verifyPostingId, assert isVerifiedRipplingHostedUrl. */
    verifyOrganization?: string;
    verifyPostingId?: string;
  };
  expected: {
    kind: AtsClassificationKind;
    siteIdentifier?: string;
    postingIdentifier?: string;
    verifiedHosted?: boolean;
    verifiedApplication?: boolean;
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
    /** Fields that must remain needs_input (ask policy / missing profile fact). */
    needsInputFields?: readonly string[];
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

export interface FieldClassifyCase {
  id: string;
  label: string;
  type: "text" | "textarea" | "select" | "radio" | "checkbox" | "file" | "hidden" | "button" | "other";
  section?: string;
  options?: readonly { label: string; value: string }[];
  questionDescriptor?: {
    promptText?: string;
    sectionTitle?: string;
    accessibleName?: string;
    nearbyInstructionText?: string;
    sourceStrategy: "fieldset_legend" | "aria_labelledby" | "question_container" | "nearby_text" | "unavailable";
    confidence: "high" | "medium" | "uncertain";
  };
}

export interface FieldClassifyTask extends GoldenTaskBase {
  kind: "field_classify";
  input: {
    fields: readonly FieldClassifyCase[];
  };
  expected: {
    /** Map of field id → expected ApplicationFieldClassification. */
    classifications: Readonly<Record<string, ApplicationFieldClassification>>;
  };
}

export type RipplingDomCase =
  | {
      id: string;
      type: "prompt_candidates";
      candidates: readonly RipplingPromptCandidate[];
      expectedPrompt: string | null;
    }
  | {
      id: string;
      type: "opaque_token";
      value: string;
      expected: boolean;
    }
  | {
      id: string;
      type: "prompt_text";
      value: string;
      expected: boolean;
    }
  | {
      id: string;
      type: "nearest_unique";
      anchor: { x: number; y: number };
      points: readonly { x: number; y: number }[];
      marginPx: number;
      maxDistancePx?: number;
      expectedIndex: number | null;
    };

export interface RipplingDomTask extends GoldenTaskBase {
  kind: "rippling_dom";
  input: {
    cases: readonly RipplingDomCase[];
  };
  expected: {
    /** All cases must pass; kept for schema symmetry. */
    allMustPass: true;
  };
}

export interface BlockerPolicyTask extends GoldenTaskBase {
  kind: "blocker_policy";
  input: {
    campaignId: string;
    jobId: string;
    blocker: CareerBlocker;
    postingCompensation?: JobCompensation;
  };
  expected: {
    mustProduceAttentionEvent: boolean;
    eventType?: "needs_input" | "configuration_required";
    blockerType?: CareerBlockerKind;
    /** Fail if CAPTCHA/login would be silently skipped (no attention event). */
    mustNotSilentSkip: boolean;
  };
}

/** Nested task kinds allowed inside pass^k stability smoke. */
export type PassKNestedTask = AssessFitTask | ClassifyUrlTask | FieldFillTask | FieldClassifyTask;

export interface PassKTask extends GoldenTaskBase {
  kind: "pass_k";
  input: {
    k: number;
    nested: PassKNestedTask;
  };
  expected: {
    requireIdenticalDeterministicScores: boolean;
  };
}

export type GoldenTask =
  | ClassifyUrlTask
  | AssessFitTask
  | FieldFillTask
  | SubmitPolicyTask
  | GroundednessTask
  | FieldClassifyTask
  | RipplingDomTask
  | BlockerPolicyTask
  | PassKTask;

export function isGoldenTask(value: unknown): value is GoldenTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  return (
    typeof task.id === "string" &&
    typeof task.kind === "string" &&
    typeof task.description === "string" &&
    Array.isArray(task.graders) &&
    task.input !== undefined &&
    task.expected !== undefined &&
    (task.expectFail === undefined || typeof task.expectFail === "boolean")
  );
}
