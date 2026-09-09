/**
 * Model / rubric grader stub for groundedness and fit-vs-resume judgments.
 *
 * Default (CI / offline): deterministic mock — no network LLM calls.
 * Opt into a live scorer later with EVALS_MODEL_GRADER=live (not wired yet).
 *
 * Fail-audit: mock MUST be able to FAIL (see evals/golden/negative/).
 * Do not return always-pass stubs for unhandled kinds — return null (skip).
 */

import { assessFit } from "../../application-agent/src/domain/fit";
import type {
  AssessFitTask,
  GoldenTask,
  GroundednessTask,
} from "../golden/schema";
import type { GraderResult } from "../types";

export type ModelGraderMode = "mock" | "live";

export function resolveModelGraderMode(
  env: NodeJS.ProcessEnv = process.env,
): ModelGraderMode {
  return env.EVALS_MODEL_GRADER === "live" ? "live" : "mock";
}

function containsInventedSkill(draftText: string, forbidden: readonly string[]): string | undefined {
  const lower = draftText.toLowerCase();
  return forbidden.find((skill) => {
    const needle = skill.trim().toLowerCase();
    if (!needle) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(lower);
  });
}

function countGroundedFacts(draftText: string, facts: readonly string[]): number {
  const lower = draftText.toLowerCase();
  return facts.filter((fact) => lower.includes(fact.trim().toLowerCase())).length;
}

/** Offline rubric: reward profile-fact overlap; penalize invented skills/employers/years. */
export function mockGradeGroundedness(task: GroundednessTask): GraderResult {
  const factHits = countGroundedFacts(task.input.draftText, task.input.profileFacts);
  const factScore = task.input.profileFacts.length === 0
    ? 1
    : factHits / task.input.profileFacts.length;
  const invented = containsInventedSkill(
    task.input.draftText,
    task.expected.mustNotInventSkills ?? [],
  );
  const inventPenalty = invented ? 0.5 : 0;
  const score = Number(Math.max(0, Math.min(1, factScore - inventPenalty)).toFixed(3));
  // Invented employers / years / skills always fail — never soft-pass on fact overlap alone.
  const passed = !invented && score >= task.expected.minScore;

  return {
    grader: "model_rubric",
    name: "groundedness_mock",
    passed,
    score,
    detail: invented
      ? `invented-skill:${invented}; factHits=${factHits}/${task.input.profileFacts.length}`
      : `factHits=${factHits}/${task.input.profileFacts.length}; score=${score}`,
  };
}

/** Offline rubric: compare deterministic fit classification to expected band. */
export function mockGradeFitRubric(task: AssessFitTask): GraderResult {
  const fit = assessFit(task.input.job, task.input.profile);
  const passed = fit.classification === task.expected.classification;
  const score = passed ? 1 : 0;
  return {
    grader: "model_rubric",
    name: "fit_vs_resume_mock",
    passed,
    score,
    detail: `classification=${fit.classification}; recommendation=${fit.applicationRecommendation}; family=${fit.recommendedResumeFamily}`,
  };
}

function liveUnavailable(name: string): GraderResult {
  return {
    grader: "model_rubric",
    name,
    passed: false,
    score: 0,
    detail: "EVALS_MODEL_GRADER=live is reserved; wire an LLM client before enabling. Using mock in CI.",
  };
}

export async function runModelRubricGrader(
  task: GoldenTask,
  mode: ModelGraderMode = resolveModelGraderMode(),
): Promise<GraderResult | null> {
  if (!task.graders.includes("model_rubric")) return null;

  if (mode === "live") {
    // Soft-fail stub: keep CI offline until a real client is opted in.
    return liveUnavailable(`${task.kind}_live`);
  }

  switch (task.kind) {
    case "groundedness":
      return mockGradeGroundedness(task);
    case "assess_fit":
      return mockGradeFitRubric(task);
    case "pass_k":
      // HARDENED: previously always-pass `pass_k_variance_note` (score=1).
      // Deterministic pass_k already asserts stability; skip rubric so it cannot mask fails.
      return null;
    case "classify_url":
    case "field_fill":
    case "submit_policy":
    case "field_classify":
    case "rippling_dom":
    case "blocker_policy":
      // HARDENED: previously always-pass `*_rubric_skipped` (score=1 / N/A pass).
      // No model rubric for these kinds — skip instead of fake-pass.
      return null;
    default: {
      const _exhaustive: never = task;
      return _exhaustive;
    }
  }
}
