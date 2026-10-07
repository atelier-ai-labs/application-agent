import { describe, expect, it } from "vitest";
import type { CareerBlocker, CareerBlockerKind } from "../application-agent/src";
import {
  MAX_REUSABLE_ANSWERS,
  REUSABLE_BLOCKER_KINDS,
  collectReusableAnswers,
  isReusableAnswer,
  reusableAnswerKey,
} from "../application-agent/src/domain/answerBank";

const earlier = "2026-10-01T00:00:00.000Z";
const later = "2026-10-02T00:00:00.000Z";

function evidenceFor(prompt: string, extra: readonly string[] = []): string[] {
  return ["executor:test", `question-prompt:${prompt}`, ...extra];
}

function blocker(overrides: Partial<CareerBlocker> = {}): CareerBlocker {
  return {
    id: "blocker-1",
    kind: "unknown_form_field",
    unit: "submission",
    questionProvenance: "ATS_FORM",
    field: "question-1",
    question: "How did you hear about us?",
    context: { jobId: "job-a", company: "Acme", role: "Engineer" },
    reason: "Input was required.",
    evidence: evidenceFor("How did you hear about us?"),
    status: "resolved",
    createdAt: earlier,
    resolvedAt: earlier,
    value: "LinkedIn",
    ...overrides,
  };
}

function job(id: string, blockers: readonly CareerBlocker[]) {
  return { id, blockers };
}

describe("cross-job answer bank", () => {
  it("collects resolved answers from other jobs and skips the current job", () => {
    const fromA = blocker({ id: "from-a" });
    const fromB = blocker({
      id: "from-b",
      evidence: evidenceFor("What is your favorite programming language?"),
      value: "TypeScript",
    });
    const answers = collectReusableAnswers([job("job-a", [fromA]), job("job-b", [fromB])], "job-b");
    expect(answers.map((entry) => entry.id)).toEqual(["from-a"]);
  });

  it("allow-lists only unclassified form questions and fixed-choice subjective questions", () => {
    expect([...REUSABLE_BLOCKER_KINDS].sort()).toEqual(["subjective_answer", "unknown_form_field"]);
  });

  it("reuses a subjective answer only when the original control was a fixed choice", () => {
    const choice = blocker({
      kind: "subjective_answer",
      evidence: evidenceFor("Are you 18 years of age or older?", ["field-type:select", "options:Yes|No"]),
      value: "Yes",
    });
    const radio = blocker({
      kind: "subjective_answer",
      evidence: evidenceFor("Are you 18 years of age or older?", ["field-type:radio", "options:Yes|No"]),
      value: "Yes",
    });
    const prose = blocker({
      kind: "subjective_answer",
      evidence: evidenceFor("Why do you want to work here?", ["field-type:textarea"]),
      value: "I love your mission.",
    });
    const shortText = blocker({
      kind: "subjective_answer",
      evidence: evidenceFor("Anything else you'd like to share?", ["field-type:text"]),
      value: "No",
    });
    const optionsButTextControl = blocker({
      kind: "subjective_answer",
      evidence: evidenceFor("Are you 18 years of age or older?", ["field-type:text", "options:Yes|No"]),
      value: "Yes",
    });
    expect(isReusableAnswer(choice)).toBe(true);
    expect(isReusableAnswer(radio)).toBe(true);
    expect(isReusableAnswer(prose)).toBe(false);
    expect(isReusableAnswer(shortText)).toBe(false);
    expect(isReusableAnswer(optionsButTextControl)).toBe(false);
  });

  it("never reuses gated or non-form blocker kinds, even when resolved with a value", () => {
    const kinds: CareerBlockerKind[] = [
      "salary",
      "sponsorship",
      "relocation",
      "travel",
      "legal_attestation",
      "demographic_disclosure",
      "unknown_fact",
      "external_login",
      "captcha",
      "external_verification",
      "unsupported_widget",
      "resume_missing",
      "required_file_missing",
      "submission_approval",
      "other",
    ];
    const gated = kinds.map((kind, index) => blocker({ id: `gated-${index}`, kind, value: "answer" }));
    for (const entry of gated) expect(isReusableAnswer(entry), entry.kind).toBe(false);
    expect(collectReusableAnswers([job("job-a", gated)], "job-z")).toEqual([]);
  });

  it("rejects answers that are open, empty, not from the ATS form, or missing the prompt key", () => {
    const ineligible = [
      blocker({ id: "open", status: "open", resolvedAt: undefined }),
      blocker({ id: "no-value", value: undefined }),
      blocker({ id: "blank-value", value: "   " }),
      blocker({ id: "no-provenance", questionProvenance: undefined }),
      blocker({ id: "policy", questionProvenance: "POLICY" }),
      blocker({ id: "no-prompt", evidence: ["executor:test", "field-id:question-1"] }),
    ];
    for (const entry of ineligible) expect(isReusableAnswer(entry), entry.id).toBe(false);
    expect(collectReusableAnswers([job("job-a", ineligible)], "job-z")).toEqual([]);
  });

  it("keeps a boolean false answer, since it is a real answer", () => {
    expect(isReusableAnswer(blocker({ value: false }))).toBe(true);
  });

  it("keeps the most recent answer when the same question was answered twice", () => {
    const stale = blocker({ id: "stale", value: "Referral", resolvedAt: earlier });
    const fresh = blocker({ id: "fresh", value: "LinkedIn", resolvedAt: later });
    const answers = collectReusableAnswers([job("job-a", [fresh]), job("job-b", [stale])], "job-z");
    expect(answers.map((entry) => [entry.id, entry.value])).toEqual([["fresh", "LinkedIn"]]);
  });

  it("treats prompt casing, whitespace, and option order as the same question", () => {
    const first = blocker({ evidence: evidenceFor("Are you  over 18?", ["options:Yes|No"]) });
    const second = blocker({ evidence: evidenceFor("are you over 18?", ["options:No|Yes"]) });
    expect(reusableAnswerKey(first)).toBe(reusableAnswerKey(second));
  });

  it("treats a different section or option set as a different question", () => {
    const base = blocker({ evidence: evidenceFor("Preferred contact method?", ["options:Email|Phone"]) });
    const otherSection = blocker({
      evidence: evidenceFor("Preferred contact method?", ["options:Email|Phone", "question-section:Referrals"]),
    });
    const otherOptions = blocker({
      evidence: evidenceFor("Preferred contact method?", ["options:Email|Phone|Text"]),
    });
    expect(reusableAnswerKey(otherSection)).not.toBe(reusableAnswerKey(base));
    expect(reusableAnswerKey(otherOptions)).not.toBe(reusableAnswerKey(base));
  });

  it("bounds the bank and returns the newest answers first", () => {
    const total = MAX_REUSABLE_ANSWERS + 5;
    const many = Array.from({ length: total }, (_, index) => blocker({
      id: `answer-${index}`,
      evidence: evidenceFor(`Distinct question number ${index}?`),
      resolvedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(),
    }));
    const answers = collectReusableAnswers([job("job-a", many)], "job-z");
    expect(answers).toHaveLength(MAX_REUSABLE_ANSWERS);
    expect(answers[0].id).toBe(`answer-${total - 1}`);
  });
});
