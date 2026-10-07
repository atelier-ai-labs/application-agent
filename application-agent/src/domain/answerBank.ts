import type { AnswerValue } from "./types";
import type { CareerBlocker, CareerBlockerKind, CareerJob } from "./campaignTypes";

/**
 * Cross-job answer bank.
 *
 * When the human answers a question the agent could not classify, that answer
 * is stored on the job's resolved blocker. Without reuse, the identical
 * question on the next application escalates to the human again. This module
 * derives a reusable view over those already-persisted resolved blockers; it
 * adds no new storage.
 *
 * Reuse is deliberately narrow, and the line is "a choice from a fixed list is
 * reusable, prose is not". Eligible answers are:
 *   - `unknown_form_field`: inspected employer fields the classifier could not
 *     place, and
 *   - `subjective_answer` ONLY when the original control was a select/radio
 *     with an option list ("Are you 18 or older?", "How did you hear about
 *     us?" as a dropdown). Narrative answers ("Why do you want to work here?")
 *     are company-specific and are never carried over.
 * Everything with job- or attestation-specific meaning stays a per-application
 * human decision: salary, sponsorship, legal attestations, demographic
 * disclosures, relocation/travel. Eligibility is re-checked wherever the bank
 * is consumed, so a widened host request cannot smuggle a gated answer into a
 * form.
 */
export const REUSABLE_BLOCKER_KINDS: ReadonlySet<CareerBlockerKind> = new Set<CareerBlockerKind>([
  "unknown_form_field",
  "subjective_answer",
]);

/** Upper bound on bank entries sent across the execution-host boundary. */
export const MAX_REUSABLE_ANSWERS = 200;

const PROMPT_EVIDENCE_PREFIX = "question-prompt:";
const SECTION_EVIDENCE_PREFIX = "question-section:";
const OPTIONS_EVIDENCE_PREFIX = "options:";

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function isAnswerValuePresent(value: AnswerValue | undefined): value is AnswerValue {
  return value !== undefined && (typeof value !== "string" || value.trim().length > 0);
}

function evidenceValue(blocker: CareerBlocker, prefix: string): string | undefined {
  const raw = blocker.evidence.find((item) => item.startsWith(prefix))?.slice(prefix.length).trim();
  return raw ? raw : undefined;
}

/** The original control was a select/radio that exposed its option list. */
function wasFixedChoiceControl(blocker: CareerBlocker): boolean {
  return (blocker.evidence.includes("field-type:select") || blocker.evidence.includes("field-type:radio")) &&
    evidenceValue(blocker, OPTIONS_EVIDENCE_PREFIX) !== undefined;
}

/**
 * A blocker is reusable only when the human resolved it, it came from an
 * inspected employer form field, its kind is on the allow-list, and it
 * recorded the exact prompt text it was asked under (the match key). Subjective
 * answers additionally must have been a fixed-choice control, never prose.
 */
export function isReusableAnswer(blocker: CareerBlocker): boolean {
  return blocker.status === "resolved" &&
    REUSABLE_BLOCKER_KINDS.has(blocker.kind) &&
    blocker.questionProvenance === "ATS_FORM" &&
    isAnswerValuePresent(blocker.value) &&
    evidenceValue(blocker, PROMPT_EVIDENCE_PREFIX) !== undefined &&
    (blocker.kind !== "subjective_answer" || wasFixedChoiceControl(blocker));
}

/** Identity of a question: prompt, section, and the option set (order-insensitive). */
export function reusableAnswerKey(blocker: CareerBlocker): string {
  const prompt = normalize(evidenceValue(blocker, PROMPT_EVIDENCE_PREFIX));
  const section = normalize(evidenceValue(blocker, SECTION_EVIDENCE_PREFIX));
  const options = (evidenceValue(blocker, OPTIONS_EVIDENCE_PREFIX) ?? "")
    .split("|")
    .map((option) => normalize(option))
    .filter(Boolean)
    .sort()
    .join("|");
  return `${prompt}\u0000${section}\u0000${options}`;
}

function resolvedTime(blocker: CareerBlocker): number {
  const parsed = Date.parse(blocker.resolvedAt ?? blocker.createdAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Collect reusable answers from every job except `excludeJobId`. When the
 * same question was answered more than once, the most recent answer wins, so
 * correcting an answer in Slack corrects it for future applications too.
 */
export function collectReusableAnswers(
  jobs: readonly Pick<CareerJob, "id" | "blockers">[],
  excludeJobId?: string,
): readonly CareerBlocker[] {
  const newestByKey = new Map<string, CareerBlocker>();
  for (const job of jobs) {
    if (job.id === excludeJobId) continue;
    for (const blocker of job.blockers) {
      if (!isReusableAnswer(blocker)) continue;
      const key = reusableAnswerKey(blocker);
      const existing = newestByKey.get(key);
      if (!existing || resolvedTime(blocker) > resolvedTime(existing)) newestByKey.set(key, blocker);
    }
  }
  return [...newestByKey.values()]
    .sort((left, right) => resolvedTime(right) - resolvedTime(left))
    .slice(0, MAX_REUSABLE_ANSWERS);
}
