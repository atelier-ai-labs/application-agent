import type { AnswerBankEntry, AnswerBankQuestion, AnswerBankSemanticMatcher } from "../../src/domain/answerBank";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface OllamaAnswerBankMatcherOptions {
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetcher?: Fetcher;
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
      if (!response.ok) return undefined;
      const payload = await response.json() as { response?: unknown };
      const parsed = typeof payload.response === "string" ? JSON.parse(payload.response) as { match?: unknown; confidence?: unknown } : undefined;
      const match = parsed?.match;
      const confidence = parsed?.confidence;
      if (typeof match !== "string" || typeof confidence !== "number") return undefined;
      const picked = labelled.find(({ label }) => label.toLowerCase() === match.trim().toLowerCase());
      return picked ? { entryId: picked.entry.id, confidence: Math.max(0, Math.min(1, confidence)) } : undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };
}
