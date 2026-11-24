import { STANDING_TOPICS, type StandingTopicChecker, type StandingTopicClassifier, type StandingTopicId } from "../../src/domain/answerBank";
import { promptVersion, type ModelCallLogger } from "../modelCallLog";
import { OLLAMA_KEEP_ALIVE } from "./ollamaAnswerBankMatcher";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface OllamaStandingTopicClassifierOptions {
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetcher?: Fetcher;
  logger?: ModelCallLogger;
}

/**
 * What each topic covers and, where people mix them up, what it does not.
 * The wording rules in STANDING_TOPICS catch the common phrasings; this is
 * for the rest (2026-11-23). The model only names a topic. The answer
 * always comes from what the candidate saved for that topic.
 */
const TOPIC_GUIDE: Record<StandingTopicId, string> = {
  criminal_conviction: "ever convicted of, or pled guilty / no contest to, a crime (felony or misdemeanor)",
  terminated: "ever fired, terminated for cause, dismissed, or asked to resign. NOT a layoff",
  financial_judgments: "unpaid judgments or liens, bankruptcy, or a bond denied, paid out or revoked",
  financial_license: "holds or held an insurance or securities license (Series 7, FINRA). NOT a driver's license or a tech certification",
  regulatory_discipline: "disciplined by a regulator, or a professional license suspended or revoked",
  restrictive_agreements: "bound by a non-compete, non-solicitation, confidentiality or other agreement with a current or past employer that restricts working here",
  background_check: "willing to undergo a background check or drug test",
  essential_functions: "ABLE to perform the job's essential functions with or without accommodation. NOT whether they need or request an accommodation",
  previously_applied: "has applied to this company before (Yes = applied before). NOT 'is this your first time applying', where Yes means the opposite",
  previously_interviewed: "has interviewed at this company before",
  related_to_employee: "related to, or has family or household members who work at, this company",
  knows_employee: "personally knows (friends, former colleagues) someone who works at this company. NOT who referred them, and NOT a request to list names",
  security_clearance: "CURRENTLY HOLDS an active government security clearance (Secret, TS/SCI, polygraph). NOT whether they could get, obtain or are willing to get one",
  military_service: "is a veteran or has served in the military. NOT the protected-veteran self-identification",
  work_location: "where they intend or plan to work from if hired. NOT where they live now, and NOT willingness to relocate or come to an office",
  notice_period: "how much notice they must give their current employer before starting. NOT their earliest start date",
  certifications: "a list of the professional certifications they hold, or none. NOT one specific named certification",
};

const SYSTEM_PROMPT =
  "You read one question from a job application and decide which single topic from a fixed list it asks about. " +
  "Answer with a topic only when the candidate's one saved answer for that topic would be a correct, complete answer to this exact question. " +
  "Answer none when the question is about something else, asks about two topics at once, asks for a list of names or details, reverses the meaning (where Yes would mean No), " +
  "or is a statement to acknowledge rather than a question. When unsure, answer none: a wrong topic puts a wrong answer on a real application, while none only means a person answers it. " +
  "Confidence is how sure you are that the topic's saved answer correctly answers this question.";

const TOPIC_IDS = STANDING_TOPICS.map((topic) => topic.id);

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    topic: { type: "string", enum: [...TOPIC_IDS, "none"] },
    confidence: { type: "number" },
  },
  required: ["topic", "confidence"],
  additionalProperties: false,
} as const;

const TOPIC_LIST = TOPIC_IDS.map((id) => `- ${id}: ${TOPIC_GUIDE[id]}`).join("\n");


const CHECK_SYSTEM_PROMPT =
  "You check one proposed match on a job application. You get a question and a fact the candidate already answered. " +
  "First restate in a few words what the question literally asks. Then answer yes only if the candidate's answer to the fact, given as-is, is a correct and complete answer to the question. " +
  "Answer no when the question asks something related but different: a different situation (laid off vs. fired, living somewhere vs. working from there, coming to an office, relocating, travel), " +
  "the opposite framing (first time vs. before, need vs. able), permission or agreement to something, a single item of a list, or a request for names or details.";

const CHECK_SCHEMA = {
  type: "object",
  properties: {
    asks: { type: "string" },
    answer: { type: "string", enum: ["yes", "no"] },
  },
  required: ["asks", "answer"],
  additionalProperties: false,
} as const;

async function verifyTopic(
  topic: StandingTopicId,
  question: Parameters<StandingTopicClassifier>[0],
  call: { baseUrl: string; fetcher: Fetcher; model: string; signal: AbortSignal },
): Promise<"yes" | "no" | "error"> {
  const fact = STANDING_TOPICS.find((candidate) => candidate.id === topic)!;
  const prompt = [
    `Question: ${question.question}`,
    question.options?.length ? `Its options: ${question.options.join(" | ")}` : "",
    `Fact the candidate answered: ${fact.label} (${TOPIC_GUIDE[topic]})`,
    "",
    `Return {"asks": "<what the question asks>", "answer": "yes" or "no"}.`,
  ].filter(Boolean).join("\n");
  try {
    const response = await call.fetcher(`${call.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: call.model, system: CHECK_SYSTEM_PROMPT, prompt, stream: false, format: CHECK_SCHEMA, keep_alive: OLLAMA_KEEP_ALIVE,
        options: { temperature: 0, num_ctx: 4_096, num_predict: 80 },
      }),
      signal: call.signal,
    });
    if (!response.ok) return "error";
    const payload = await response.json() as { response?: unknown };
    const parsed = typeof payload.response === "string" ? JSON.parse(payload.response) as { answer?: unknown } : undefined;
    return parsed?.answer === "yes" ? "yes" : parsed?.answer === "no" ? "no" : "error";
  } catch {
    return "error";
  }
}

export const STANDING_TOPIC_PROMPT_VERSION = promptVersion(SYSTEM_PROMPT, TOPIC_LIST, JSON.stringify(RESPONSE_SCHEMA), CHECK_SYSTEM_PROMPT, JSON.stringify(CHECK_SCHEMA));

/** The same narrow check on its own, for a topic the wording rules picked. */
export function createOllamaStandingTopicChecker(options: OllamaStandingTopicClassifierOptions): StandingTopicChecker {
  const baseUrl = (options.baseUrl ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  return async (topic, question) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const verdict = await verifyTopic(topic, question, { baseUrl, fetcher, model: options.model.trim(), signal: controller.signal });
      options.logger?.record({
        at: new Date().toISOString(), purpose: "standing_topic", model: options.model.trim(), promptVersion: STANDING_TOPIC_PROMPT_VERSION, attempt: 1,
        ...(question.company ? { company: question.company } : {}), question: question.question,
        outcome: controller.signal.aborted ? "timeout" : `check:${topic}:${verdict}`, latencyMs: Date.now() - started,
      });
      return verdict;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Asks the local model which standing topic, if any, a question is about. */
export function createOllamaStandingTopicClassifier(options: OllamaStandingTopicClassifierOptions): StandingTopicClassifier {
  const baseUrl = (options.baseUrl ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  return async (question) => {
    const prompt = [
      `Company: ${question.company ?? "unknown"}`,
      `Question: ${question.question}`,
      question.options?.length ? `Its options: ${question.options.join(" | ")}` : `Field type: ${question.fieldType ?? "text"}`,
      "",
      "Topics:",
      TOPIC_LIST,
      "",
      `Return {"topic": "<one topic id or none>", "confidence": <0 to 1>}.`,
    ].join("\n");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    let output: string | undefined;
    let tokens: { promptTokens?: number; outputTokens?: number } = {};
    const done = <T>(outcome: string, result: T): T => {
      options.logger?.record({
        at: new Date().toISOString(), purpose: "standing_topic", model: options.model.trim(), promptVersion: STANDING_TOPIC_PROMPT_VERSION, attempt: 1,
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
          model: options.model.trim(), system: SYSTEM_PROMPT, prompt, stream: false, format: RESPONSE_SCHEMA, keep_alive: OLLAMA_KEEP_ALIVE,
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
      const parsed = typeof payload.response === "string" ? JSON.parse(payload.response) as { topic?: unknown; confidence?: unknown } : undefined;
      const topic = parsed?.topic;
      const confidence = parsed?.confidence;
      if (typeof topic !== "string" || typeof confidence !== "number") return done("unparseable_output", undefined);
      if (topic !== "none" && !TOPIC_IDS.includes(topic as StandingTopicId)) return done("unknown_topic", undefined);
      const clamped = Math.max(0, Math.min(1, confidence));
      if (topic === "none") return done("none", { topic: "none", confidence: clamped });
      // The model is sure of almost every pick, right or wrong (the first eval
      // run: 12 wrong picks, all at confidence 1.00). A second, narrower
      // question checks the pick before it counts.
      const verified = await verifyTopic(topic as StandingTopicId, question, { baseUrl, fetcher, model: options.model.trim(), signal: controller.signal });
      if (verified !== "yes") return done(`${topic}@${clamped.toFixed(2)}:rejected_by_check(${verified})`, { topic: "none", confidence: clamped });
      return done(`${topic}@${clamped.toFixed(2)}:checked`, { topic: topic as StandingTopicId, confidence: clamped });
    } catch (error) {
      return done(controller.signal.aborted ? "timeout" : `error:${error instanceof Error ? error.message.slice(0, 60) : "unknown"}`, undefined);
    } finally {
      clearTimeout(timer);
    }
  };
}
