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
export type AnswerBankMatchKind = "exact" | "similar" | "model" | "standing";

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
  /** A standing answer the candidate set for one fixed topic (see STANDING_TOPICS). */
  topic?: StandingTopicId;
  /** Years of experience with one skill (see EXPERIENCE_SKILLS), set by the candidate. */
  skill?: ExperienceSkillId;
}

export interface AnswerBankQuestion {
  question: string;
  company?: string;
  fieldType?: string;
  options?: readonly string[];
  kind?: string;
}

/**
 * Standing answers: facts about the candidate that do not change between
 * applications (no convictions, no securities license). They are high risk,
 * so they are never learned from Slack; the candidate sets each one once.
 * Each topic matches only questions asked about the candidate, worded
 * narrowly; a question touching two topics is still asked.
 */
export type StandingTopicId =
  | "criminal_conviction" | "terminated" | "financial_judgments" | "financial_license" | "regulatory_discipline"
  | "restrictive_agreements" | "background_check" | "essential_functions" | "previously_applied" | "previously_interviewed"
  | "related_to_employee" | "security_clearance" | "military_service" | "work_location" | "notice_period" | "certifications";

/** A standing value that is looked up from the agent's own records instead of fixed. */
export const STANDING_FROM_RECORDS = "@records";

export const STANDING_TOPICS: readonly {
  id: StandingTopicId;
  label: string;
  pattern: RegExp;
  /** Also matches "If you are related to…, what is…?" prompts. */
  conditional?: boolean;
  /** The sentence for a free-text box, from a "No" standing value. */
  asText?: (value: string, company?: string) => string | undefined;
  /** Matches labels and statements too ("Notice period"), not only questions. */
  anyPhrasing?: boolean;
  /** Wording that makes it a different question ("able to obtain a clearance"). */
  exclude?: RegExp;
  /** A text answer: never typed into a date picker or an option list it does not match. */
  textOnly?: boolean;
  /** The value for a Yes/No list, when the standing value is text ("None" → "No"). */
  asYesNo?: (value: string) => "Yes" | "No" | undefined;
}[] = [
  { id: "criminal_conviction", label: "Convicted of, or pled guilty / no contest to, a crime", pattern: /\bconvicted\b|\bple(?:d|aded) guilty\b|\bnolo contendere\b|\bno contest\b/ },
  { id: "terminated", label: "Fired, or asked to resign", pattern: /\b(?:been|were you|ever been) (?:fired|terminated|discharged|dismissed)\b|\basked to resign\b/ },
  { id: "financial_judgments", label: "Unsatisfied liens or judgments, bankruptcy, or a bond denied or revoked", pattern: /\b(?:unsatisfied|outstanding) (?:judge?ments?|liens?)\b|\bliens?\b.{0,30}\bagainst you\b|\bbankruptcy\b|\bbond(?:ing)? company\b|\bbond\b.{0,40}\b(?:denied|revoked|paid out)\b/ },
  { id: "financial_license", label: "Holds or has held an insurance or securities license", pattern: /\blicen[cs](?:e|ed|es|ing)\b.{0,30}\b(?:insurance|securities|finra)\b|\b(?:insurance|securities)\b.{0,20}\blicen[cs]e|\bseries (?:6|7|24|63|65|66)\b|\bfinra\b/ },
  { id: "regulatory_discipline", label: "Disciplined by a regulator", pattern: /\bdisciplin\w*\b.{0,60}\b(?:regulat\w*|finra|self regulatory|agency|body)\b/ },
  { id: "restrictive_agreements", label: "Signed a non-compete, non-solicitation, or confidentiality agreement", pattern: /\b(?:signed|bound by|subject to|party to|entered into)\b.{0,60}\b(?:non ?compet\w*|non ?solicit\w*|confidentiality|restrictive covenants?)\b/ },
  { id: "background_check", label: "Willing to undergo a background check or drug screen", pattern: /\b(?:willing|able|agree) to (?:undergo|complete|pass|submit to|take)\b.{0,30}\b(?:background|drug)\b/ },
  { id: "essential_functions", label: "Can perform the essential functions with or without reasonable accommodation", pattern: /\bessential functions\b/ },
  { id: "previously_applied", label: "Previously applied to this company", pattern: /\b(?:previously|ever|before)\b.{0,20}\bappl(?:ied|y)\b.{0,40}\{company\}|\bappl(?:ied)\b.{0,30}\{company\}.{0,20}\b(?:before|previously)\b/ },
  { id: "previously_interviewed", label: "Previously interviewed at this company", pattern: /\b(?:previously|ever|before)\b.{0,20}\binterview(?:ed)?\b.{0,40}\{company\}/ },
  {
    id: "related_to_employee", label: "Related to anyone who works at the company",
    pattern: /\brelated to\b.{0,30}\b(?:anyone|any(?:one)? (?:current )?employees?|an? (?:current )?employee|someone)\b.{0,30}(?:\{company\}|\bemploy)|\brelated to\b.{0,20}\{company\}|\b(?:relatives?|family members?)\b.{0,40}\b(?:work(?:s|ing)?|employed)\b.{0,20}(?:\{company\}|\bhere\b)/,
    conditional: true,
    asText: (value, company) => /^no\b/i.test(value.trim()) ? `Not applicable. I am not related to anyone at ${company?.trim() || "the company"}.` : undefined,
  },
  {
    id: "security_clearance", label: "Currently holds an active security clearance",
    pattern: /\b(?:hold|have|possess)\b.{0,40}\bclearance\b|\b(?:active|current)\b.{0,30}\bclearance\b/,
    // Being able to get one is a different question with a different answer.
    exclude: /\b(?:obtain|eligib\w*|able to (?:get|acquire|receive)|willing to|maintain|sponsor)\b/,
  },
  {
    id: "military_service", label: "Veteran, or served in the military",
    pattern: /\bserved in the (?:u ?s |united states )?(?:military|armed forces)\b|\bmilitary service\b|\b(?:are|were) you (?:a |an )?(?:military |u ?s )?veteran\b/,
    // "Protected veteran" is the self-identification form; the profile answers that one.
    exclude: /\bprotected\b|\bspouse\b|\bdependent\b/,
  },
  {
    id: "work_location", label: "Where you intend to work from, if hired",
    pattern: /\bwhere\b.{0,30}\b(?:intend|plan|expect)\b.{0,20}\bwork\b|\b(?:intend|plan|expect) to work from\b/,
    anyPhrasing: true, textOnly: true,
  },
  {
    id: "notice_period", label: "Notice period before you can start",
    pattern: /\bnotice period\b|\bhow much notice\b|\bnotice (?:do you need|is required|would you need)\b/,
    anyPhrasing: true, textOnly: true,
  },
  {
    id: "certifications", label: "Professional certifications you hold (or None)",
    pattern: /\b(?:list|what|which|any|relevant)\b.{0,30}\bcertifications?\b|\bcertifications?\b.{0,30}\b(?:you (?:have|hold)|held)\b/,
    // A question about one named certification is answered per form.
    exclude: /\b(?:aws|azure|gcp|google|cissp|security\+?|comptia|pmp|cka|ckad|terraform|kubernetes|scrum|itil|ccna|cpa|license)\b/,
    anyPhrasing: true,
    asYesNo: (value) => /^(?:none|no)\b/i.test(value.trim()) ? "No" : value.trim() ? "Yes" : undefined,
  },
];

/** The one standing topic a question is about, or undefined for none or several. */
export function standingTopicFor(question: string, company?: string): StandingTopicId | undefined {
  const key = answerBankKey(question, company);
  // Only questions about the candidate: statements to acknowledge are not answers.
  const interrogative = /\b(?:have you|are you|do you|were you|has a|has any|did you|can you|would you|will you|is there)\b/.test(key);
  const conditional = /\bif you (?:are|have)\b/.test(key);
  const topics = STANDING_TOPICS.filter((topic) =>
    (interrogative || (conditional && topic.conditional) || topic.anyPhrasing) && topic.pattern.test(key) && !topic.exclude?.test(key));
  return topics.length === 1 ? topics[0]!.id : undefined;
}

export function standingEntryKey(topic: StandingTopicId): string {
  return `standing:${topic}`;
}

/** Answers a records-backed standing topic ("Yes" if the agent applied there before). */
export type StandingRecordsLookup = (topic: StandingTopicId, company: string | undefined) => string | undefined;

/**
 * "Applied before?" from the agent's own records: Yes when another job at
 * this company reached Applied. "Interviewed before?" is No only when the
 * agent never applied there; otherwise it cannot know and asks.
 */
export function standingRecordsFromJobs(
  jobs: readonly { id: string; status: string; job: { company: string }; manualSubmissionConfirmation?: unknown; submissionProof?: unknown }[],
  excludeJobId?: string,
): StandingRecordsLookup {
  const companyKey = (value: string) => normalizedText(value).replace(/[^a-z0-9 ]+/g, " ").replace(/\b(?:inc|llc|corp|corporation|co|ltd|technologies|the|companies|company)\b/g, " ").replace(/\s+/g, " ").trim();
  return (topic, company) => {
    if (!company) return undefined;
    const appliedBefore = jobs.some((job) => job.id !== excludeJobId && companyKey(job.job.company) === companyKey(company) &&
      (job.status === "applied" || Boolean(job.manualSubmissionConfirmation) || Boolean(job.submissionProof)));
    if (topic === "previously_applied") return appliedBefore ? "Yes" : "No";
    if (topic === "previously_interviewed") return appliedBefore ? undefined : "No";
    return undefined;
  };
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
    if (entry.disabled || entry.tier === "high" || entry.topic || entry.skill) continue;
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
  records?: StandingRecordsLookup,
): Promise<AnswerBankMatch | undefined> {
  if (isOpaqueQuestion(question.question)) return undefined;
  const experience = experienceMatch(entries, question);
  if (experience) return experience;
  const topic = standingTopicFor(question.question, question.company);
  if (topic) {
    const definition = STANDING_TOPICS.find((candidate) => candidate.id === topic);
    const entry = entries.find((candidate) => candidate.topic === topic && !candidate.disabled);
    if (!entry) return undefined;
    const value = entry.value === STANDING_FROM_RECORDS ? records?.(topic, question.company) : entry.value;
    if (value === undefined) return undefined;
    if (definition?.textOnly && question.fieldType && !/^(?:text|textarea)$/.test(question.fieldType) && !question.options?.length) return undefined;
    if (definition?.asYesNo && question.options?.length) {
      const yesNo = definition.asYesNo(String(value));
      const mapped = yesNo ? valueForOptions(yesNo, question.options) : undefined;
      if (mapped !== undefined) return { entry, value: mapped, kind: "standing" };
    }
    if (!question.options?.length && (question.fieldType === "text" || question.fieldType === "textarea")) {
      const asText = STANDING_TOPICS.find((candidate) => candidate.id === topic)?.asText;
      if (asText) {
        const text = asText(String(value), question.company);
        return text === undefined ? undefined : { entry, value: text, kind: "standing" };
      }
    }
    const mapped = valueForOptions(value, question.options);
    return mapped === undefined ? undefined : { entry, value: mapped, kind: "standing" };
  }
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
export function withStandingAnswer(entries: readonly AnswerBankEntry[], topic: StandingTopicId, value: string, now: string): AnswerBankEntry[] {
  const definition = STANDING_TOPICS.find((candidate) => candidate.id === topic);
  if (!definition) throw new Error(`Unknown standing topic: ${topic}`);
  return withRecordedAnswer(entries, {
    id: standingEntryKey(topic), key: standingEntryKey(topic), question: definition.label, value, tier: "high", topic, source: "manual", recordedAt: now,
  });
}

/**
 * Years of experience the candidate set once per skill. A question is
 * answered only when every word in it is accounted for: a skill named here,
 * or generic "how many years of experience" wording. "Years with Go and
 * Python" has an unknown skill (Go), so it is still asked; two known skills
 * answer with the smaller number, which stays true for both.
 */
export type ExperienceSkillId =
  | "software" | "python" | "javascript" | "typescript" | "react" | "node" | "sql" | "azure" | "aws"
  | "kubernetes" | "docker" | "terraform" | "b2b_saas" | "llm" | "devops";

export const EXPERIENCE_SKILLS: readonly { id: ExperienceSkillId; label: string; pattern?: RegExp }[] = [
  { id: "software", label: "Professional software engineering, any language" },
  { id: "python", label: "Python", pattern: /\bpython\b/g },
  { id: "javascript", label: "JavaScript", pattern: /\bjavascript\b/g },
  { id: "typescript", label: "TypeScript", pattern: /\btypescript\b/g },
  { id: "react", label: "React", pattern: /\breact(?: ?js)?\b/g },
  { id: "node", label: "Node.js", pattern: /\bnode(?: ?js)?\b/g },
  { id: "sql", label: "SQL / relational databases", pattern: /\b(?:sql|postgres(?:ql)?|mysql|relational databases?)\b/g },
  { id: "azure", label: "Microsoft Azure", pattern: /\b(?:microsoft )?azure\b/g },
  { id: "aws", label: "AWS", pattern: /\baws\b|\bamazon web services\b/g },
  { id: "kubernetes", label: "Kubernetes", pattern: /\bkubernetes\b|\bk8s\b/g },
  { id: "docker", label: "Docker / containers", pattern: /\bdocker\b|\bcontainers?\b/g },
  { id: "terraform", label: "Terraform / infrastructure as code", pattern: /\bterraform\b|\binfrastructure as code\b|\biac\b/g },
  { id: "b2b_saas", label: "Working at a B2B SaaS company", pattern: /\bb2b\b|\bsaas\b/g },
  { id: "llm", label: "LLMs / generative AI", pattern: /\bllms?\b|\blarge language models?\b|\bgen(?:erative)? ?ai\b/g },
  { id: "devops", label: "DevOps / CI/CD", pattern: /\bdevops\b|\bci ?cd\b/g },
];

const EXPERIENCE_FILLER = new Set(("how many years year yrs of experience experiences do you have has had professional professionally hands on relevant " +
  "with in using use used working work worked total commercial production overall industry building developing writing programming " +
  "a an the your and or what is are level paid full time combined approximately approx please indicate select enter number " +
  "environment environments setting settings company companies organization organizations").split(" "));
const SOFTWARE_WORDS = /\b(?:software|engineering|engineer|development|developer|programming|coding)\b/;

export function experienceEntryKey(skill: ExperienceSkillId): string {
  return `experience:${skill}`;
}

/** The skills a years-of-experience question asks about, or undefined when it is not one this table answers. */
export function experienceSkillsFor(question: string): { skills: ExperienceSkillId[]; mode: "years" | "yesno" } | undefined {
  let key = answerBankKey(question);
  const years = /\b(?:years?|yrs)\b/.test(key) && /\bexperience\b|\bworked\b|\bused\b|\busing\b|\bwith\b/.test(key);
  const yesno = !years && /\b(?:do you have|have you)\b.{0,20}\b(?:experience|worked|used)\b/.test(key);
  if (!years && !yesno) return undefined;
  const skills: ExperienceSkillId[] = [];
  for (const skill of EXPERIENCE_SKILLS) {
    if (!skill.pattern) continue;
    const replaced = key.replace(skill.pattern, " ");
    if (replaced !== key) { skills.push(skill.id); key = replaced; }
  }
  const software = SOFTWARE_WORDS.test(key);
  key = key.replace(new RegExp(SOFTWARE_WORDS.source, "g"), " ");
  const leftover = key.split(" ").filter((word) => word && !EXPERIENCE_FILLER.has(word) && !/^\d+$/.test(word));
  if (leftover.length > 0) return undefined;
  if (skills.length === 0) return software && years ? { skills: ["software"], mode: "years" } : undefined;
  return { skills, mode: years ? "years" : "yesno" };
}

function optionRange(option: string): [number, number] | undefined {
  const text = normalizedText(option).replace(/\byears?\b|\byrs?\b/g, " ").replace(/\s+/g, " ").trim();
  let match: RegExpExecArray | null;
  if (/^(?:none|no experience|0|n\/a)$/.test(text)) return [0, 0];
  if ((match = /^(?:less than|under|fewer than|<)\s*(\d+(?:\.\d+)?)$/.exec(text))) return [0, Number(match[1]) - 1e-9];
  if ((match = /^(\d+(?:\.\d+)?)\s*(?:\+|or more|plus|and (?:above|up|over))$/.exec(text)) ||
    (match = /^(?:more than|over|greater than|>)\s*(\d+(?:\.\d+)?)$/.exec(text))) {
    const n = Number(match[1]);
    return [/^(?:more|over|greater|>)/.test(text) ? n + 1e-9 : n, Number.POSITIVE_INFINITY];
  }
  if ((match = /^(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)$/.exec(text))) return [Number(match[1]), Number(match[2])];
  if ((match = /^(\d+(?:\.\d+)?)$/.exec(text))) return [Number(match[1]), Number(match[1])];
  return undefined;
}

/** Years as this field wants it: the number, the range option holding it, or Yes/No. */
export function yearsAsAnswer(years: number, options: readonly string[] | undefined, mode: "years" | "yesno"): AnswerValue | undefined {
  if (!options || options.length === 0) return mode === "years" ? String(years) : undefined;
  const yesNo = valueForOptions(years > 0 ? "Yes" : "No", options);
  if (mode === "yesno" || yesNo !== undefined) return yesNo;
  const ranges = options.map((option) => ({ option, range: optionRange(option) }));
  if (ranges.some(({ range }) => !range)) {
    // Placeholders like "Select…" are fine; any other unreadable option means we cannot be sure.
    const unreadable = ranges.filter(({ option, range }) => !range && !/^(?:select|choose|please select|--)/i.test(option.trim()));
    if (unreadable.length > 0) return undefined;
  }
  const holding = ranges.filter(({ range }) => range && years >= range[0] && years <= range[1]);
  // Overlapping edges ("1-3", "3-5" for 3): the range that starts at it.
  const best = holding.find(({ range }) => range![0] === years) ?? holding[0];
  return holding.length === 0 ? undefined : best!.option;
}

/** The answer from the years table, or undefined so the usual bank rules still apply. */
function experienceMatch(entries: readonly AnswerBankEntry[], question: AnswerBankQuestion): AnswerBankMatch | undefined {
  if (question.fieldType === "textarea") return undefined;
  const asked = experienceSkillsFor(question.question);
  if (!asked) return undefined;
  const found = asked.skills.map((skill) => entries.find((entry) => entry.skill === skill && !entry.disabled));
  if (found.some((entry) => !entry || typeof entry.value !== "number")) return undefined;
  const fewest = found.reduce((low, entry) => (entry!.value as number) < (low!.value as number) ? entry : low)!;
  const value = yearsAsAnswer(fewest.value as number, question.options, asked.mode);
  return value === undefined ? undefined : { entry: fewest, value, kind: "standing" };
}

export function withExperienceYears(entries: readonly AnswerBankEntry[], skill: ExperienceSkillId, years: number, now: string): AnswerBankEntry[] {
  const definition = EXPERIENCE_SKILLS.find((candidate) => candidate.id === skill);
  if (!definition) throw new Error(`Unknown skill: ${skill}`);
  if (!Number.isFinite(years) || years < 0 || years > 60) throw new Error(`Years must be a number from 0 to 60, got ${years}.`);
  return withRecordedAnswer(entries, {
    id: experienceEntryKey(skill), key: experienceEntryKey(skill), question: `Years of experience: ${definition.label}`, value: years,
    tier: "high", skill, source: "manual", recordedAt: now,
  });
}

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
