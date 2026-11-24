import { STANDING_TOPICS, acceptedModelTopic, standingTopicFor, type StandingTopicChecker, type StandingTopicClassifier, type StandingTopicId } from "../../src/domain/answerBank";

/**
 * Scores how well questions are matched to standing topics (2026-11-23).
 * A "wrong" pick is the error that matters: it puts a saved answer on a
 * question that answer doesn't fit. A "missed" one only means a person gets
 * asked, which is what happens today.
 */
export interface StandingTopicCase {
  id: string;
  source: "form" | "made-up";
  company?: string;
  fieldType?: string;
  options?: string[];
  question: string;
  expected: StandingTopicId | "none";
  note?: string;
}

export type TopicOutcome = "correct" | "missed" | "wrong";

export interface TopicResult {
  id: string;
  expected: StandingTopicId | "none";
  rules?: StandingTopicId;
  /** The model's raw pick, before the confidence and wording checks. */
  model?: { topic: StandingTopicId | "none"; confidence: number };
  /** What the agent would use: the rules first, then an accepted model pick. */
  combined?: StandingTopicId;
  /** The model's check of the rules' own pick. */
  ruleCheck?: "yes" | "no" | "error";
  /** What the agent does: combined, plus the model's check on rule picks for topics marked ruleNeedsCheck. */
  checked?: StandingTopicId;
  outcomes: { rules: TopicOutcome; combined: TopicOutcome; checked: TopicOutcome };
}

export interface TopicSummary { correct: number; missed: number; wrong: number; total: number }

export function outcomeFor(expected: StandingTopicId | "none", picked: StandingTopicId | undefined): TopicOutcome {
  if (picked === undefined) return expected === "none" ? "correct" : "missed";
  return picked === expected ? "correct" : "wrong";
}

export async function scoreStandingTopicCase(testCase: StandingTopicCase, classifier?: StandingTopicClassifier, checker?: StandingTopicChecker): Promise<TopicResult> {
  const question = {
    question: testCase.question,
    ...(testCase.company ? { company: testCase.company } : {}),
    ...(testCase.fieldType ? { fieldType: testCase.fieldType } : {}),
    ...(testCase.options ? { options: testCase.options } : {}),
  };
  const rules = standingTopicFor(question.question, question.company);
  // The model is only asked when the rules found nothing, as in the agent.
  const model = rules === undefined && classifier ? await classifier(question) : undefined;
  const combined = rules ?? acceptedModelTopic(question, model);
  // As in the agent: only topics marked ruleNeedsCheck have their rule match checked.
  const ruleCheck = rules && checker && STANDING_TOPICS.find((topic) => topic.id === rules)?.ruleNeedsCheck ? await checker(rules, question) : undefined;
  const checked = rules ? (ruleCheck === "no" ? undefined : rules) : combined;
  return {
    id: testCase.id,
    expected: testCase.expected,
    ...(rules ? { rules } : {}),
    ...(model ? { model } : {}),
    ...(combined ? { combined } : {}),
    ...(ruleCheck ? { ruleCheck } : {}),
    ...(checked ? { checked } : {}),
    outcomes: { rules: outcomeFor(testCase.expected, rules), combined: outcomeFor(testCase.expected, combined), checked: outcomeFor(testCase.expected, checked) },
  };
}

export function summarize(results: readonly TopicResult[], which: "rules" | "combined" | "checked"): TopicSummary {
  const count = (outcome: TopicOutcome) => results.filter((result) => result.outcomes[which] === outcome).length;
  return { correct: count("correct"), missed: count("missed"), wrong: count("wrong"), total: results.length };
}
