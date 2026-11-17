import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnv } from "vite";
import { retrieveCandidateAnswerEvidence } from "../../src/domain/applicationAnswerDraft";
import type { JobPosting } from "../../src/domain/types";
import { loadBackgroundCandidateProfile } from "../runtime/careerAgentRuntime";
import { FileModelCallLogger } from "../modelCallLog";
import { ESSAY_PROMPT_VERSION, OllamaApplicationAnswerDraftGenerator } from "./ollamaApplicationAnswerDraftGenerator";
import { overallScore, scoreEssay, type EssayEvalCase, type EssayScore } from "./essayEval";

/**
 * `npm run career-agent:eval-essays [-- --save-baseline] [--only <id>]`
 *
 * Drafts every case in application-agent/evals/essay-cases.json with the real
 * drafter and local model, scores each draft, prints a table, saves the full
 * report (drafts included) under .local/career-agent/evals/, and compares the
 * scores with the saved baseline when there is one (2026-11-14).
 */
const loaded = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
for (const [key, value] of Object.entries(loaded)) if (process.env[key] === undefined) process.env[key] = value;

const CASES_FILE = resolve("application-agent/evals/essay-cases.json");
const OUT_DIR = resolve(".local/career-agent/evals");
const BASELINE_FILE = resolve(OUT_DIR, "essay-baseline.json");

interface EvalReport { at: string; model: string; promptVersion: string; overall: number; scores: EssayScore[] }

const argv = process.argv.slice(2);
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : undefined;
const model = process.env.ATELIER_CAREER_AGENT_OLLAMA_MODEL?.trim();
if (!model) throw new Error("ATELIER_CAREER_AGENT_OLLAMA_MODEL is required to run the essay eval.");

const cases = (JSON.parse(readFileSync(CASES_FILE, "utf8")) as { cases: EssayEvalCase[] }).cases
  .filter((testCase) => !only || testCase.id === only);
const profile = loadBackgroundCandidateProfile(process.env);
const generator = new OllamaApplicationAnswerDraftGenerator({
  model,
  ...(process.env.ATELIER_CAREER_AGENT_OLLAMA_BASE_URL?.trim() ? { baseUrl: process.env.ATELIER_CAREER_AGENT_OLLAMA_BASE_URL.trim() } : {}),
  timeoutMs: Number(process.env.ATELIER_CAREER_AGENT_OLLAMA_TIMEOUT_MS) || 60_000,
  logger: new FileModelCallLogger(resolve(OUT_DIR, "eval-model-calls.jsonl")),
});
// Everything the candidate could truthfully claim: the whole profile.
const evidenceText = JSON.stringify(profile);

const scores: EssayScore[] = [];
for (const testCase of cases) {
  const job = {
    company: testCase.company, title: testCase.title, description: testCase.posting,
    requiredSkills: [], preferredSkills: [], capturedAt: new Date().toISOString(),
  } as unknown as JobPosting;
  const request = { question: testCase.question, job, profile, resume: null };
  const started = Date.now();
  const draft = retrieveCandidateAnswerEvidence(request).length > 0 ? await generator.generate(request) : undefined;
  const score = scoreEssay(testCase, draft?.answer, evidenceText);
  scores.push(score);
  const failed = score.checks.filter((check) => !check.passed).map((check) => `${check.name}${check.detail ? ` (${check.detail})` : ""}`);
  console.log(`${score.score.toFixed(2)}  ${testCase.id.slice(0, 48).padEnd(48)} ${((Date.now() - started) / 1000).toFixed(1)}s  ${failed.join("; ")}`);
}

const report: EvalReport = { at: new Date().toISOString(), model, promptVersion: ESSAY_PROMPT_VERSION, overall: overallScore(scores), scores };
mkdirSync(OUT_DIR, { recursive: true });
const reportFile = resolve(OUT_DIR, `essays-${report.at.replace(/[:.]/g, "-")}.json`);
writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);

const checkNames = [...new Set(scores.flatMap((score) => score.checks.map((check) => check.name)))];
const passRate = (name: string, list: readonly EssayScore[]) => {
  const relevant = list.flatMap((score) => score.checks.filter((check) => check.name === name));
  return relevant.length ? relevant.filter((check) => check.passed).length / relevant.length : 1;
};
console.log(`\nOverall ${report.overall.toFixed(2)} across ${scores.length} cases · model ${model} · prompt ${ESSAY_PROMPT_VERSION}`);
console.log(checkNames.map((name) => `${name} ${Math.round(passRate(name, scores) * 100)}%`).join(" · "));

if (existsSync(BASELINE_FILE)) {
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as EvalReport;
  const delta = report.overall - baseline.overall;
  console.log(`Baseline ${baseline.overall.toFixed(2)} (prompt ${baseline.promptVersion}) → ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`);
  for (const score of scores) {
    const before = baseline.scores.find((candidate) => candidate.id === score.id);
    if (before && Math.abs(before.score - score.score) >= 0.01) console.log(`  ${score.id.slice(0, 48)}: ${before.score.toFixed(2)} → ${score.score.toFixed(2)}`);
  }
}
if (argv.includes("--save-baseline")) {
  mkdirSync(dirname(BASELINE_FILE), { recursive: true });
  writeFileSync(BASELINE_FILE, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Saved as the baseline: ${BASELINE_FILE}`);
}
console.log(`Report: ${reportFile}`);
