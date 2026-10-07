/** Shared result types for the offline evals harness. */

export type GraderKind = "deterministic" | "model_rubric";

export type EvalTaskKind =
  | "classify_url"
  | "assess_fit"
  | "field_fill"
  | "submit_policy"
  | "groundedness"
  | "field_classify"
  | "rippling_dom"
  | "blocker_policy"
  | "pass_k";

export interface GraderResult {
  grader: GraderKind;
  name: string;
  passed: boolean;
  score: number;
  detail: string;
}

export interface TaskResult {
  id: string;
  kind: EvalTaskKind;
  description: string;
  passed: boolean;
  score: number;
  graders: readonly GraderResult[];
}

export interface SuiteReport {
  ranAt: string;
  fixtureCount: number;
  passedCount: number;
  failedCount: number;
  averageScore: number;
  modelGraderMode: "mock" | "live";
  tasks: readonly TaskResult[];
}

/** Compact baseline artifact written by the runner for CI uploads. */
export interface BaselineArtifact {
  ranAt: string;
  fixtureCount: number;
  passedCount: number;
  failedCount: number;
  passRate: number;
  averageScore: number;
  modelGraderMode: "mock" | "live";
  summaryLine: string;
  tasks: readonly {
    id: string;
    kind: EvalTaskKind;
    passed: boolean;
    score: number;
  }[];
}
