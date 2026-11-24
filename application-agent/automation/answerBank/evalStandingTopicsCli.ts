import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv } from "vite";
import { FileModelCallLogger } from "../modelCallLog";
import { STANDING_TOPIC_PROMPT_VERSION, createOllamaStandingTopicChecker, createOllamaStandingTopicClassifier } from "./ollamaStandingTopicClassifier";
import { scoreStandingTopicCase, summarize, type StandingTopicCase, type TopicResult, type TopicSummary } from "./standingTopicEval";

/**
 * `npm run career-agent:eval-topics [-- --rules-only] [--holdout] [--only <id>]`
 *
 * Runs every case in application-agent/evals/standing-topic-cases.json
 * through the wording rules alone, then through the rules plus the local
 * model, and prints how many each gets right, misses (asks a person), and
 * gets wrong (would put a saved answer on the wrong question). The full
 * report goes under .local/career-agent/evals/ (2026-11-23).
 */
const loaded = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
for (const [key, value] of Object.entries(loaded)) if (process.env[key] === undefined) process.env[key] = value;

const OUT_DIR = resolve(".local/career-agent/evals");

const argv = process.argv.slice(2);
const rulesOnly = argv.includes("--rules-only");
// --holdout scores the cases the prompt was never tuned on.
const CASES_FILE = resolve(`application-agent/evals/standing-topic-${argv.includes("--holdout") ? "holdout" : "cases"}.json`);
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : undefined;
const model = process.env.ATELIER_CAREER_AGENT_OLLAMA_MODEL?.trim();
if (!rulesOnly && !model) throw new Error("ATELIER_CAREER_AGENT_OLLAMA_MODEL is required (or pass --rules-only).");

const cases = (JSON.parse(readFileSync(CASES_FILE, "utf8")) as { cases: StandingTopicCase[] }).cases
  .filter((testCase) => !only || testCase.id === only);
const classifier = rulesOnly || !model ? undefined : createOllamaStandingTopicClassifier({
  model,
  ...(process.env.ATELIER_CAREER_AGENT_OLLAMA_BASE_URL?.trim() ? { baseUrl: process.env.ATELIER_CAREER_AGENT_OLLAMA_BASE_URL.trim() } : {}),
  timeoutMs: 60_000,
  logger: new FileModelCallLogger(resolve(OUT_DIR, "eval-model-calls.jsonl")),
});

const checker = classifier && model ? createOllamaStandingTopicChecker({
  model,
  ...(process.env.ATELIER_CAREER_AGENT_OLLAMA_BASE_URL?.trim() ? { baseUrl: process.env.ATELIER_CAREER_AGENT_OLLAMA_BASE_URL.trim() } : {}),
  timeoutMs: 60_000,
}) : undefined;

const results: TopicResult[] = [];
for (const testCase of cases) {
  const result = await scoreStandingTopicCase(testCase, classifier, checker);
  results.push(result);
  if (result.outcomes.checked !== "correct" || result.outcomes.combined !== "correct" || result.outcomes.rules !== "correct") {
    const model = result.model ? `${result.model.topic}@${result.model.confidence.toFixed(2)}` : "-";
    console.log(`${result.outcomes.rules.padEnd(7)} → ${result.outcomes.combined.padEnd(7)} → ${result.outcomes.checked.padEnd(7)}  ${testCase.id.padEnd(36)} expected ${result.expected}; rules ${result.rules ?? "-"}${result.ruleCheck ? ` (check ${result.ruleCheck})` : ""}; model ${model}`);
  }
}

const line = (name: string, summary: TopicSummary) =>
  `${name.padEnd(16)} ${summary.correct}/${summary.total} right · ${summary.missed} asked a person · ${summary.wrong} WRONG`;
console.log("");
console.log(line("Rules only", summarize(results, "rules")));
if (classifier) console.log(line("Rules + model", summarize(results, "combined")));
if (checker) console.log(line("Agent (checked)", summarize(results, "checked")));
console.log(`model ${classifier ? model : "(not used)"} · prompt ${STANDING_TOPIC_PROMPT_VERSION}`);

mkdirSync(OUT_DIR, { recursive: true });
const at = new Date().toISOString();
writeFileSync(resolve(OUT_DIR, `topics-${argv.includes("--holdout") ? "holdout-" : ""}${at.replace(/[:.]/g, "-")}.json`), `${JSON.stringify({ at, model, promptVersion: STANDING_TOPIC_PROMPT_VERSION, results }, null, 2)}\n`);
