import { isCompanyInterestQuestion } from "../../src/domain/applicationAnswerDraft";
import { fillerPhrases, phrasesCopiedFromPosting } from "./ollamaApplicationAnswerDraftGenerator";

/**
 * Scores one essay draft with checks a computer can verify (2026-11-14).
 * The point is a number that moves when the drafter gets better or worse,
 * so a prompt change can be judged by more than "this one reads nicer".
 */
export interface EssayEvalCase {
  id: string;
  company: string;
  title: string;
  question: string;
  /** A word limit the question states ("150 words max"). */
  maxWords?: number;
  posting: string;
}

export interface EssayCheck {
  name: "drafted" | "length" | "no_filler" | "not_copied" | "grounded" | "names_company";
  passed: boolean;
  detail?: string;
}

export interface EssayScore {
  id: string;
  score: number;
  checks: EssayCheck[];
  draft?: string;
}

/**
 * Technologies and tools a draft might claim. A claim counts as grounded only
 * when the candidate's own evidence (profile, work history, projects) names
 * it; the posting naming it doesn't count. "PuckPulse is like ElevenLabs'
 * tool-using agents" (2026-11-10) is the kind of claim this catches.
 */
const TECH_TERMS = [
  "aws", "azure", "gcp", "google cloud", "kubernetes", "k8s", "docker", "terraform", "pulumi", "ansible", "helm",
  "python", "typescript", "javascript", "golang", "rust", "java", "kotlin", "c#", "c\\+\\+", "ruby", "scala", "swift",
  "react", "next\\.js", "vue", "angular", "svelte", "node\\.js", "fastapi", "django", "flask", "express", "graphql",
  "postgres", "postgresql", "mysql", "mongodb", "redis", "kafka", "spark", "snowflake", "bigquery", "elasticsearch",
  "langchain", "langgraph", "langfuse", "openai", "anthropic", "claude", "gemini", "groq", "ollama", "llama", "pytorch", "tensorflow",
  "rag", "vector database", "pinecone", "playwright", "selenium", "github actions", "jenkins", "circleci", "datadog", "grafana",
  "prometheus", "sentry", "temporal", "airflow", "dbt", "sql", "nosql", "microservices", "serverless", "lambda",
  "container apps", "static web apps", "slack", "sqlite", "tailwind",
];

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean);
const mentions = (text: string, term: string) => new RegExp(`(?:^|[^a-z0-9])${term}(?:$|[^a-z0-9])`, "i").test(text);

export function scoreEssay(testCase: EssayEvalCase, draft: string | undefined, evidenceText: string): EssayScore {
  const checks: EssayCheck[] = [];
  if (!draft) {
    checks.push({ name: "drafted", passed: false, detail: "no draft (dropped or failed)" });
    return { id: testCase.id, score: 0, checks };
  }
  checks.push({ name: "drafted", passed: true });

  const count = words(draft).length;
  const maximum = testCase.maxWords ?? 220;
  checks.push({ name: "length", passed: count >= 40 && count <= maximum, detail: `${count} words (40–${maximum})` });

  const filler = fillerPhrases(draft);
  checks.push({ name: "no_filler", passed: filler.length === 0, ...(filler.length ? { detail: filler.join(", ") } : {}) });

  const copied = phrasesCopiedFromPosting(draft, testCase.posting);
  checks.push({ name: "not_copied", passed: copied.length === 0, ...(copied.length ? { detail: copied.slice(0, 3).join(" | ") } : {}) });

  // The company's own name ("Temporal", "Pinecone") isn't a technology claim.
  const company = testCase.company.toLowerCase();
  const ungrounded = TECH_TERMS.filter((term) => !company.includes(term.replace(/\\/g, "")) && mentions(draft, term) && !mentions(evidenceText, term))
    .map((term) => term.replace(/\\/g, ""));
  checks.push({ name: "grounded", passed: ungrounded.length === 0, ...(ungrounded.length ? { detail: `not in your evidence: ${ungrounded.join(", ")}` } : {}) });

  if (isCompanyInterestQuestion(testCase.question)) {
    const named = draft.toLowerCase().includes(testCase.company.toLowerCase().replace(/\s+(?:inc|ai|corp)\.?$/i, ""));
    checks.push({ name: "names_company", passed: named });
  }

  const passed = checks.filter((check) => check.passed).length;
  return { id: testCase.id, score: Math.round((passed / checks.length) * 100) / 100, checks, draft };
}

/** The mean case score, the headline number a run is judged by. */
export function overallScore(scores: readonly EssayScore[]): number {
  if (scores.length === 0) return 0;
  return Math.round((scores.reduce((total, score) => total + score.score, 0) / scores.length) * 100) / 100;
}
