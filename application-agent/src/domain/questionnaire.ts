import type { CandidateProfile } from "./types";
import {
  EXPERIENCE_SKILLS, STANDING_TOPICS, withExperienceYears, withStandingAnswer,
  type AnswerBankEntry, type ExperienceSkillId, type StandingTopicId,
} from "./answerBank";

/**
 * The onboarding questionnaire: the common application questions the agent
 * cannot answer from a resume, asked once up front so forms stop asking.
 * Each answer is stored where the agent already looks for it: a standing
 * answer or the years-of-experience table in the answer bank, or a work
 * preference in the profile. Salary, essays, and questions about one
 * employer are never here; those stay per application.
 */
export type QuestionnaireTarget =
  | { kind: "standing"; topic: StandingTopicId }
  | { kind: "experience"; skill: ExperienceSkillId }
  | { kind: "preference"; field: "relocation" | "travel" };

export interface QuestionnaireItem {
  id: string;
  section: string;
  prompt: string;
  /** Suggested replies, shown to the person answering. */
  hint?: string;
  target: QuestionnaireTarget;
}

const SECTIONS = ["Background", "Where and when", "Years of experience", "Conduct history"] as const;

const STANDING_SECTION: Record<StandingTopicId, (typeof SECTIONS)[number]> = {
  security_clearance: "Background", military_service: "Background", related_to_employee: "Background", certifications: "Background",
  background_check: "Background", essential_functions: "Background", previously_applied: "Background", previously_interviewed: "Background",
  work_location: "Where and when", notice_period: "Where and when",
  criminal_conviction: "Conduct history", terminated: "Conduct history", financial_judgments: "Conduct history",
  financial_license: "Conduct history", regulatory_discipline: "Conduct history", restrictive_agreements: "Conduct history",
};

const STANDING_HINTS: Partial<Record<StandingTopicId, string>> = {
  previously_applied: "@records lets the agent answer from its own application history",
  previously_interviewed: "@records answers No when the agent never applied there; otherwise it asks",
  work_location: "e.g. Remote from Pittsburgh, PA",
  notice_period: "e.g. 2 weeks",
  certifications: "list them, or None",
};

export const QUESTIONNAIRE: readonly QuestionnaireItem[] = [
  ...STANDING_TOPICS.map((topic): QuestionnaireItem => ({
    id: topic.id, section: STANDING_SECTION[topic.id], prompt: topic.label,
    hint: STANDING_HINTS[topic.id] ?? "Yes or No",
    target: { kind: "standing", topic: topic.id },
  })),
  ...(["relocation", "travel"] as const).map((field): QuestionnaireItem => ({
    id: field, section: "Where and when", hint: "Yes or No", target: { kind: "preference", field },
    prompt: field === "relocation" ? "Willing to relocate" : "Willing to travel occasionally (team offsites, a few times a year)",
  })),
  ...EXPERIENCE_SKILLS.map((skill): QuestionnaireItem => ({
    id: `years.${skill.id}`, section: "Years of experience", prompt: skill.label, hint: "a number of years; 0 for none",
    target: { kind: "experience", skill: skill.id },
  })),
].sort((left, right) => SECTIONS.indexOf(left.section as never) - SECTIONS.indexOf(right.section as never));

export interface QuestionnaireRow {
  item: QuestionnaireItem;
  /** The current answer, or undefined while the agent still asks on each form. */
  value?: string;
}

export function questionnaireRows(entries: readonly AnswerBankEntry[], profile: Pick<CandidateProfile, "workPreferences">): QuestionnaireRow[] {
  return QUESTIONNAIRE.map((item) => {
    const target = item.target;
    let value: unknown;
    if (target.kind === "standing") value = entries.find((entry) => entry.topic === target.topic && !entry.disabled)?.value;
    else if (target.kind === "experience") value = entries.find((entry) => entry.skill === target.skill && !entry.disabled)?.value;
    else value = profile.workPreferences[target.field];
    return value === undefined || value === null || value === "" ? { item } : { item, value: String(value) };
  });
}

/** Record one answer. Returns the updated bank entries and profile work preferences. */
export function applyQuestionnaireAnswer<P extends Pick<CandidateProfile, "workPreferences">>(
  id: string,
  rawValue: string,
  entries: readonly AnswerBankEntry[],
  profile: P,
  now: string,
): { entries: AnswerBankEntry[]; profile: P } {
  const item = QUESTIONNAIRE.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Unknown questionnaire item "${id}". Run career-agent:questionnaire to see the ids.`);
  const value = normalizedReply(rawValue);
  if (!value) throw new Error(`No answer given for "${id}".`);
  const target = item.target;
  if (target.kind === "standing") return { entries: withStandingAnswer(entries, target.topic, value, now), profile };
  if (target.kind === "experience") return { entries: withExperienceYears(entries, target.skill, Number(value), now), profile };
  return { entries: [...entries], profile: { ...profile, workPreferences: { ...profile.workPreferences, [target.field]: value } } };
}

/** "yes" → "Yes", "n" → "No"; anything else is kept as typed. */
function normalizedReply(value: string): string {
  const text = value.trim();
  if (/^(?:y|yes)$/i.test(text)) return "Yes";
  if (/^(?:n|no)$/i.test(text)) return "No";
  return text;
}
