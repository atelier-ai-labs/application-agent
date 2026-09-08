/** Shared result types for the offline evals harness. */

export type GraderKind = "deterministic" | "model_rubric";

export type EvalTaskKind =
  | "classify_url"
  | "assess_fit"
  | "field_fill"
  | "submit_policy"
  | "groundedness";

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
