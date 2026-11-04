import type { CareerBlocker } from "./campaignTypes";
import type { AnswerValue } from "./types";
import { OPTIONAL_ANSWER_SKIPPED } from "./executor";

/**
 * The answer bank remembers what the candidate answered on earlier forms so a
 * later form asking the same thing is filled instead of asked again.
 *
 * Every question gets a risk tier. The tier decides how loosely a saved
 * answer may be matched:
 *   - low:    marketing/location/self-ID style questions. Exact, similar, or
 *             model-confirmed matches are all reused.
 *   - medium: factual questions where wording matters (years of experience,
 *             travel, relocation). Only an exact question match is reused.
 *   - high:   attestations, salary, sponsorship, conduct history, questions
 *             about this specific employer, and essays. Never reused.
 */
export type AnswerRiskTier = "low" | "medium" | "high";
export type AnswerBankSource = "slack" | "history" | "manual";
export type AnswerBankMatchKind = "exact" | "similar" | "model";

export interface AnswerBankEntry {
  id: string;
  /** Normalized question with the employer's name replaced by `{company}`. */
  key: string;
  /** The question as the form showed it, for reading the bank file. */
  question: string;
  value: AnswerValue;
  tier: AnswerRiskTier;
  fieldType?: string;
  options?: readonly string[];
  company?: string;
  jobId?: string;
  source: AnswerBankSource;
  recordedAt: string;
  usedCount?: number;
  lastUsedAt?: string;
  /** Set by hand in the bank file to stop an entry from being reused. */
  disabled?: boolean;
}

export interface AnswerBankQuestion {
  question: string;
  company?: string;
  fieldType?: string;
  options?: readonly string[];
  kind?: string;
}

export interface AnswerBankMatch {
  entry: AnswerBankEntry;
  /** The value to give the form: an exact option label when options exist. */
  value: AnswerValue;
  kind: AnswerBankMatchKind;
}

/** Optional semantic matcher (the local model) for low-risk questions only. */
export type AnswerBankSemanticMatcher = (
  question: AnswerBankQuestion,
  candidates: readonly AnswerBankEntry[],
) => Promise<{ entryId: string; confidence: number } | undefined>;

export const ANSWER_BANK_MODEL_CONFIDENCE = 0.75;
const SIMILARITY_THRESHOLD = 0.8;
const MAX_REUSABLE_TEXT = 200;

function normalizedText(value: string): string {
  return value.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, "\"").replace(/\s+/g, " ").trim();
}

/** The real question inside executor wrappers like `Required question under "X": "Q"`. */
export function innerQuestion(question: string): string {
  const wrapped = /^required (?:yes\/no )?(?:application )?question(?: under "[^"]*")?:\s*"(.+)"\s*$/i.exec(question.trim());
  return (wrapped?.[1] ?? question).trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Company name variants worth replacing: "Phantom", "Phantom Technologies, Inc." → "phantom". */
function companyVariants(company: string | undefined): string[] {
  const full = normalizedText(company ?? "");
  if (!full) return [];
  const short = full.replace(/,?\s+(?:inc\.?|llc|ltd\.?|corp(?:oration)?\.?|co\.?|technologies|labs|ai|hq|group|company)$/g, "").trim();
  return [...new Set([full, short])].filter((variant) => variant.length >= 2).sort((a, b) => b.length - a.length);
}

export function answerBankKey(question: string, company?: string): string {
  let text = normalizedText(innerQuestion(question));
  for (const variant of companyVariants(company)) {
    text = text.replace(new RegExp(`(^|[^a-z0-9])${escapeRegExp(variant)}(?:'s)?(?=$|[^a-z0-9])`, "g"), "$1{company}");
  }
  return text
    .replace(/\*+/g, " ")
    .replace(/\((?:required|optional)\)/g, " ")
    .replace(/[^a-z0-9{}' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Labels that carry no question of their own and can never be matched safely. */
export function isOpaqueQuestion(question: string): boolean {
  const text = normalizedText(innerQuestion(question));
  if (text.length < 8) return true;
  if (/control cards\[|^required (?:yes\/no )?(?:application )?question\b/.test(text)) return true;
  return /^(?:select|search|phone|phone country|name|first name|last name|email|location|street|city|state|zip|postal code|address|website|linkedin|github(?:\/gitlab)?|i have read this|résumé|resume|cover letter|input \w+)\s*\*?$/.test(text);
}

const HIGH_RISK = [
  // Attestations, signatures, and consent to share data.
  /\b(?:certify|attest|signature|sign(?:ed)? (?:below|here)|under penalty|true and (?:complete|correct|accurate))\b/,
  /\b(?:consent|authorize|i agree|i acknowledge|i understand that|acknowledge the following|by (?:selecting|checking|continuing)|as permitted by law|consumer report|investigative)\b/,
  // Pay and immigration: owned by the profile, never a remembered guess.
  /\b(?:salary|compensation|pay (?:range|expectation)|hourly rate|base pay|desired pay)\b/,
  /\b(?:sponsor(?:ship)?|visa|immigration|authori[sz]ed to work|work authori[sz]ation|citizen(?:ship)?|green card|security clearance|clearance)\b/,
  // Conduct and background history.
  /\b(?:convicted|conviction|criminal|felony|misdemeanor|fired|terminated|asked to resign|disciplin|bonding|bonded|licens(?:e|ing) (?:revoked|suspended)|non[- ]?compete|restrictive covenant)\b/,
  // Anything about this specific employer.
  /\{company\}.{0,40}\b(?:employ(?:ed|ee)|work(?:ed)? (?:for|at)|interview(?:ed)?|applied|referr?(?:ed|al)|related|relative|know|famil(?:y|iar))\b/,
  /\b(?:employ(?:ed|ee)|work(?:ed)? (?:for|at)|interview(?:ed)?|applied|referr?(?:ed|al)|related|relative)\b.{0,40}\{company\}/,
  /\breferr?(?:ed|al)\b|\bwho referred\b/,
  // Dates and availability go stale between applications.
  /\b(?:start date|available to start|availability|notice period|last (?:working )?day|when can you start)\b/,
  // Essays and open-ended prompts.
  /\b(?:why (?:do|are|would)|tell us|describe|explain|share (?:a|an|your)|walk us through|what (?:excites|interests|motivates)|cover letter|in \d+[-–]?\d* (?:words|sentences)|summari[sz]e|reason for leaving|proud)\b/,
];

const LOW_RISK = [
  /\bhow did you (?:hear|learn|find|come to know)\b|\b(?:hear|heard|learn(?:ed)?|first learn) (?:about|of) (?:this|the|our|{company})\b|\bwhere (?:did )?you (?:heard?|find|found|see|saw)\b|\bhow (?:familiar|did you discover)\b|\b(?:job|referral) source\b/,
  /\b(?:which|what) (?:of these )?(?:region|continent|country|state|location|time ?zone)\b|\bworking from\b|\bwork(?:ing)? location\b|\bcurrent(?:ly)? (?:location|based|reside|live)\b|\bwhere (?:are you|do you) (?:located|based|live)\b|\bcity\b/,
  /\bpronouns?\b|\bgender\b|\brace\b|\bethnicity\b|\bhispanic\b|\blatin[oax]\b|\bsexual orientation\b|\btransgender\b|\bveteran\b|\bdisability\b/,
  /\bprivacy (?:policy|notice)\b/,
  /\bphone (?:country|type)\b|\bpreferred (?:name|contact)\b/,
];

const MEDIUM_RISK = [
  /\byears? of (?:professional |hands[- ]on |relevant )?experience\b|\bhow many years\b|\bexperience (?:with|using|in)\b/,
  /\b(?:travel|relocat|commute|on[- ]?site|hybrid|in[- ]office|work (?:schedule|hours|shifts?|weekends))\b/,
  /\b(?:degree|education|certification|certified|bachelor|master)\b/,
  /\b(?:18 years|age of 18|years of age)\b/,
  /\bbackground check\b|\bdrug (?:test|screen)\b|\bcontact (?:your )?(?:current|past|previous|most recent) employers?\b/,
];

export function answerRiskTier(question: AnswerBankQuestion | string, company?: string): AnswerRiskTier {
  const input = typeof question === "string" ? { question, company } : question;
  const key = answerBankKey(input.question, input.company ?? company);
  // A free-text box invites an essay, except for the marketing "how did you hear" question.
  if (input.fieldType === "textarea" && !LOW_RISK[0].test(key)) return "high";
  if (input.kind === "salary" || input.kind === "sponsorship" || input.kind === "legal_attestation") return "high";
  if (HIGH_RISK.some((pattern) => pattern.test(key))) return "high";
  if (MEDIUM_RISK.some((pattern) => pattern.test(key))) return "medium";
  if (LOW_RISK.some((pattern) => pattern.test(key))) return "low";
  return "medium";
}

/** A short factual answer worth remembering: not empty, skipped, or an essay. */
export function isReusableValue(value: AnswerValue | null | undefined): value is AnswerValue {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean" || typeof value === "number") return true;
  const text = value.trim();
  return Boolean(text) && text !== OPTIONAL_ANSWER_SKIPPED && text.length <= MAX_REUSABLE_TEXT && !/\n/.test(text);
}

/** Field type and option labels the executor recorded on a blocker. */
export function questionFromBlocker(blocker: Pick<CareerBlocker, "question" | "evidence" | "kind" | "context">): AnswerBankQuestion {
  const evidence = (prefix: string) => blocker.evidence.find((item) => item.startsWith(prefix))?.slice(prefix.length);
  const options = evidence("options:")?.split("|").map((option) => option.trim()).filter(Boolean);
  const fieldType = evidence("field-type:");
  return {
    question: evidence("question-prompt:") || blocker.question,
    ...(blocker.context.company ? { company: blocker.context.company } : {}),
    ...(fieldType ? { fieldType } : {}),
    ...(options && options.length > 0 ? { options } : {}),
    kind: blocker.kind,
  };
}

/**
 * Whether a question may be stored at all. Opaque labels and high-risk
 * questions are never stored, so they can never be reused by mistake.
 */
export function isBankableQuestion(question: AnswerBankQuestion, value: AnswerValue | null | undefined): value is AnswerValue {
  if (isOpaqueQuestion(question.question) || answerRiskTier(question) === "high" || !isReusableValue(value)) return false;
  const answer = normalizedText(String(value));
  // An answer naming this employer ("MeridianLink Career Site") is wrong anywhere else.
  if (companyVariants(question.company).some((variant) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(variant)}(?=$|[^a-z0-9])`).test(answer))) return false;
  // A vague label can still carry a high-risk answer ("a U.S. citizen", "I agree").
  return !/^(?:i (?:agree|accept|consent|acknowledge|certify))\b/.test(answer) && !HIGH_RISK.slice(0, 5).some((pattern) => pattern.test(answer));
}

const STOPWORDS = new Set(["a", "an", "the", "you", "your", "are", "is", "do", "did", "of", "to", "in", "for", "and", "or", "this", "that", "please", "with", "be", "will", "we", "our", "on", "at", "about", "which", "what", "these", "following", "currently", "select", "one"]);

function tokens(key: string): Set<string> {
  return new Set(key.split(" ").map((token) => token.replace(/^'+|'+$/g, "")).filter((token) => token && !STOPWORDS.has(token)));
}

export function questionSimilarity(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  // Average overlap with containment, so a lead-in like "Before applying,"
  // does not hide that one question is the other.
  const jaccard = shared / (a.size + b.size - shared);
  const containment = Math.min(a.size, b.size) >= 3 ? shared / Math.min(a.size, b.size) : jaccard;
  return (jaccard + containment) / 2;
}

function normalizedValue(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9+]+/g, " ").trim();
}

/**
 * The saved value expressed as one of this field's options, or undefined
 * when the field offers options and none of them is that answer.
 */
export function valueForOptions(value: AnswerValue, options: readonly string[] | undefined): AnswerValue | undefined {
  if (!options || options.length === 0) return value;
  const wanted = normalizedValue(String(typeof value === "boolean" ? (value ? "yes" : "no") : value));
  if (!wanted) return undefined;
  const exact = options.find((option) => normalizedValue(option) === wanted);
  if (exact) return exact;
  // "yes" → "Yes, I am", "no" → "No, I do not": a single option starting with the answer.
  if (/^(?:yes|no)$/.test(wanted)) {
    const leading = options.filter((option) => new RegExp(`^${wanted}\\b`).test(normalizedValue(option)));
    if (leading.length === 1) return leading[0];
  }
  return undefined;
}

/** Newest usable entry per key. */
function liveEntries(entries: readonly AnswerBankEntry[]): AnswerBankEntry[] {
  const byKey = new Map<string, AnswerBankEntry>();
  for (const entry of entries) {
    if (entry.disabled || entry.tier === "high") continue;
    const current = byKey.get(entry.key);
    if (!current || current.recordedAt < entry.recordedAt) byKey.set(entry.key, entry);
  }
  return [...byKey.values()];
}

function usable(entry: AnswerBankEntry, question: AnswerBankQuestion, kind: AnswerBankMatchKind): AnswerBankMatch | undefined {
  const value = valueForOptions(entry.value, question.options);
  if (value === undefined) return undefined;
  // A long saved text answer is not a fit for a short option list and vice versa.
  if ((!question.options || question.options.length === 0) && entry.options && entry.options.length > 0 && question.fieldType === "textarea") return undefined;
  return { entry, value, kind };
}

/**
 * Find a saved answer for a question. Exact key matches serve low and medium
 * tiers; similar wording and the model serve only low-risk questions.
 */
export async function findAnswerBankMatch(
  entries: readonly AnswerBankEntry[],
  question: AnswerBankQuestion,
  semanticMatcher?: AnswerBankSemanticMatcher,
): Promise<AnswerBankMatch | undefined> {
  if (isOpaqueQuestion(question.question)) return undefined;
  const tier = answerRiskTier(question);
  if (tier === "high") return undefined;
  const key = answerBankKey(question.question, question.company);
  const live = liveEntries(entries);

  const exact = live.find((entry) => entry.key === key);
  if (exact) {
    const match = usable(exact, question, "exact");
    if (match) return match;
  }
  if (tier !== "low") return undefined;

  const ranked = live
    .filter((entry) => entry.tier === "low" && entry.key !== key)
    .map((entry) => ({ entry, score: questionSimilarity(key, entry.key) }))
    .sort((a, b) => b.score - a.score);
  for (const { entry, score } of ranked) {
    if (score < SIMILARITY_THRESHOLD) break;
    const match = usable(entry, question, "similar");
    if (match) return match;
  }

  if (!semanticMatcher) return undefined;
  const candidates = ranked
    .filter(({ entry, score }) => score > 0 && usable(entry, question, "model"))
    .slice(0, 8)
    .map(({ entry }) => entry);
  if (candidates.length === 0) return undefined;
  const picked = await semanticMatcher(question, candidates).catch(() => undefined);
  if (!picked || picked.confidence < ANSWER_BANK_MODEL_CONFIDENCE) return undefined;
  const entry = candidates.find((candidate) => candidate.id === picked.entryId);
  return entry ? usable(entry, question, "model") : undefined;
}

/** Add or replace the entry for this question; the newest answer wins. */
export function withRecordedAnswer(entries: readonly AnswerBankEntry[], entry: AnswerBankEntry): AnswerBankEntry[] {
  return [...entries.filter((candidate) => candidate.key !== entry.key), entry];
}

/** Where the bank lives. The service reads and writes it through this. */
export interface AnswerBankStore {
  entries(): readonly AnswerBankEntry[];
  save(entries: readonly AnswerBankEntry[]): void;
}

export class InMemoryAnswerBankStore implements AnswerBankStore {
  private current: AnswerBankEntry[];
  constructor(entries: readonly AnswerBankEntry[] = []) { this.current = [...entries]; }
  entries(): readonly AnswerBankEntry[] { return this.current; }
  save(entries: readonly AnswerBankEntry[]): void { this.current = [...entries]; }
}
