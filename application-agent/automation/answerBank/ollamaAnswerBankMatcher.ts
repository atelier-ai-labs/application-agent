import type { AnswerBankEntry, AnswerBankQuestion, AnswerBankSemanticMatcher } from "../../src/domain/answerBank";
import { promptVersion, type ModelCallLogger } from "../modelCallLog";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface OllamaAnswerBankMatcherOptions {
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetcher?: Fetcher;
  /** Records every model call (prompt version, outcome, timing, tokens). */
  logger?: ModelCallLogger;
}

const SYSTEM_PROMPT =
  "You match a new job-application question to previously answered questions. " +
  "Pick a candidate when the new question asks for the same fact, even in different words, so the candidate's saved answer is also a correct answer to the new question. " +
  "Answer none when the questions ask about different things, such as a different skill, a different kind of place (country vs. time zone vs. city), or a different time frame. " +
  "Confidence is how sure you are that the saved answer is correct for the new question.";

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    match: { type: "string" },
    confidence: { type: "number" },
  },
  required: ["match", "confidence"],
  additionalProperties: false,
} as const;

const MATCH_PROMPT_VERSION = promptVersion(SYSTEM_PROMPT, JSON.stringify(RESPONSE_SCHEMA));

/** Asks the local model which saved question, if any, the new one repeats. */
export function createOllamaAnswerBankMatcher(options: OllamaAnswerBankMatcherOptions): AnswerBankSemanticMatcher {
  const baseUrl = (options.baseUrl ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  return async (question: AnswerBankQuestion, candidates: readonly AnswerBankEntry[]) => {
    if (candidates.length === 0) return undefined;
    const labelled = candidates.map((entry, index) => ({ label: `C${index + 1}`, entry }));
    const prompt = [
      `New question: ${question.question}`,
      question.options?.length ? `Its options: ${question.options.join(" | ")}` : "It is a free-text field.",
      "",
      "Previously answered questions:",
      ...labelled.map(({ label, entry }) => `${label}: ${entry.question} -> ${String(entry.value)}`),
      "",
      `Return {"match": "<C1..C${labelled.length} or none>", "confidence": <0 to 1>}.`,
    ].join("\n");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    let tokens: { promptTokens?: number; outputTokens?: number } = {};
    let output: string | undefined;
    const done = <T>(outcome: string, result: T): T => {
      options.logger?.record({
        at: new Date().toISOString(), purpose: "answer_bank_match", model: options.model.trim(), promptVersion: MATCH_PROMPT_VERSION, attempt: 1,
        ...(question.company ? { company: question.company } : {}), question: question.question, outcome,
        ...(output !== undefined ? { output } : {}), latencyMs: Date.now() - started, ...tokens,
      });
      return result;
    };
    try {
      const response = await fetcher(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: options.model.trim(), system: SYSTEM_PROMPT, prompt, stream: false, format: RESPONSE_SCHEMA,
          options: { temperature: 0, num_ctx: 4_096, num_predict: 40 },
        }),
        signal: controller.signal,
      });
      if (!response.ok) return done(`http_${response.status}`, undefined);
      const payload = await response.json() as { response?: unknown; prompt_eval_count?: unknown; eval_count?: unknown };
      tokens = {
        ...(typeof payload.prompt_eval_count === "number" ? { promptTokens: payload.prompt_eval_count } : {}),
        ...(typeof payload.eval_count === "number" ? { outputTokens: payload.eval_count } : {}),
      };
      if (typeof payload.response === "string") output = payload.response;
      const parsed = typeof payload.response === "string" ? JSON.parse(payload.response) as { match?: unknown; confidence?: unknown } : undefined;
      const match = parsed?.match;
      const confidence = parsed?.confidence;
      if (typeof match !== "string" || typeof confidence !== "number") return done("unparseable_output", undefined);
      const picked = labelled.find(({ label }) => label.toLowerCase() === match.trim().toLowerCase());
      return picked
        ? done(`matched:${picked.label}@${confidence.toFixed(2)}`, { entryId: picked.entry.id, confidence: Math.max(0, Math.min(1, confidence)) })
        : done("no_match", undefined);
    } catch (error) {
      return done(controller.signal.aborted ? "timeout" : `error:${error instanceof Error ? error.message.slice(0, 60) : "unknown"}`, undefined);
    } finally {
      clearTimeout(timer);
    }
  };
}
