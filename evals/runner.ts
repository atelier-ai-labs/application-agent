/**
 * Evals suite runner: load golden fixtures, execute domain steps, emit pass/fail + score.
 * Also writes evals/baseline.json for CI artifact uploads.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isGoldenTask, type GoldenTask } from "./golden/schema";
import { runDeterministicGrader } from "./graders/deterministic";
import {
  resolveModelGraderMode,
  runModelRubricGrader,
  type ModelGraderMode,
} from "./graders/modelRubric";
import type { BaselineArtifact, GraderResult, SuiteReport, TaskResult } from "./types";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultFixturesDir = path.join(here, "golden", "fixtures");
const defaultBaselinePath = path.join(here, "baseline.json");

export async function loadGoldenTasks(
  fixturesDir: string = defaultFixturesDir,
): Promise<GoldenTask[]> {
  const entries = await readdir(fixturesDir);
  const jsonFiles = entries.filter((name) => name.endsWith(".json")).sort();
  const tasks: GoldenTask[] = [];

  for (const name of jsonFiles) {
    const raw = await readFile(path.join(fixturesDir, name), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isGoldenTask(parsed)) {
      throw new Error(`Invalid golden fixture: ${name}`);
    }
    tasks.push(parsed);
  }

  return tasks;
}

function average(scores: readonly number[]): number {
  if (scores.length === 0) return 0;
  return Number((scores.reduce((sum, value) => sum + value, 0) / scores.length).toFixed(3));
}

export async function runTask(
  task: GoldenTask,
  modelMode: ModelGraderMode,
): Promise<TaskResult> {
  const graders: GraderResult[] = [];
  const deterministic = await runDeterministicGrader(task);
  if (deterministic) graders.push(deterministic);
  const rubric = await runModelRubricGrader(task, modelMode);
  if (rubric) graders.push(rubric);

  if (graders.length === 0) {
    return {
      id: task.id,
      kind: task.kind,
      description: task.description,
      passed: false,
      score: 0,
      graders: [{
        grader: "deterministic",
        name: "no_grader",
        passed: false,
        score: 0,
        detail: "Task listed no applicable graders.",
      }],
    };
  }

  const passed = graders.every((result) => result.passed);
  return {
    id: task.id,
    kind: task.kind,
    description: task.description,
    passed,
    score: average(graders.map((result) => result.score)),
    graders,
  };
}

export async function runEvalSuite(options?: {
  fixturesDir?: string;
  modelMode?: ModelGraderMode;
  now?: () => string;
}): Promise<SuiteReport> {
  const modelMode = options?.modelMode ?? resolveModelGraderMode();
  const tasks = await loadGoldenTasks(options?.fixturesDir);
  const results: TaskResult[] = [];

  for (const task of tasks) {
    results.push(await runTask(task, modelMode));
  }

  const passedCount = results.filter((result) => result.passed).length;
  return {
    ranAt: options?.now?.() ?? new Date().toISOString(),
    fixtureCount: results.length,
    passedCount,
    failedCount: results.length - passedCount,
    averageScore: average(results.map((result) => result.score)),
    modelGraderMode: modelMode,
    tasks: results,
  };
}

export function toBaselineArtifact(report: SuiteReport): BaselineArtifact {
  const passRate = report.fixtureCount === 0
    ? 0
    : Number((report.passedCount / report.fixtureCount).toFixed(4));
  const summaryLine =
    `evals baseline: fixtures=${report.fixtureCount} passed=${report.passedCount} ` +
    `failed=${report.failedCount} passRate=${passRate} averageScore=${report.averageScore}`;
  return {
    ranAt: report.ranAt,
    fixtureCount: report.fixtureCount,
    passedCount: report.passedCount,
    failedCount: report.failedCount,
    passRate,
    averageScore: report.averageScore,
    modelGraderMode: report.modelGraderMode,
    summaryLine,
    tasks: report.tasks.map((task) => ({
      id: task.id,
      kind: task.kind,
      passed: task.passed,
      score: task.score,
    })),
  };
}

export async function writeBaselineArtifact(
  report: SuiteReport,
  baselinePath: string = defaultBaselinePath,
): Promise<BaselineArtifact> {
  const artifact = toBaselineArtifact(report);
  await mkdir(path.dirname(baselinePath), { recursive: true });
  await writeFile(baselinePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return artifact;
}

export function formatSuiteReport(report: SuiteReport): string {
  const baseline = toBaselineArtifact(report);
  const lines: string[] = [
    "=== evals harness baseline ===",
    `ranAt=${report.ranAt}`,
    `fixtures=${report.fixtureCount} passed=${report.passedCount} failed=${report.failedCount}`,
    `passRate=${baseline.passRate} averageScore=${report.averageScore} modelGrader=${report.modelGraderMode}`,
    baseline.summaryLine,
    "",
  ];

  for (const task of report.tasks) {
    lines.push(`${task.passed ? "PASS" : "FAIL"}  ${task.id}  score=${task.score}  (${task.kind})`);
    lines.push(`  ${task.description}`);
    for (const grader of task.graders) {
      lines.push(`  - [${grader.grader}/${grader.name}] ${grader.passed ? "PASS" : "FAIL"} score=${grader.score}`);
      lines.push(`    ${grader.detail}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
