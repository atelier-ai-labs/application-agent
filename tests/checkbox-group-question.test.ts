import { describe, expect, it } from "vitest";
import { questionForBlocker } from "../application-agent/src/domain/attention";
import { answerBankKey, questionFromBlocker, withCheckboxLabel } from "../application-agent/src/domain/answerBank";
import type { CareerBlocker } from "../application-agent/src/domain/campaignTypes";

// Hex, 2026-11-23: "From where do you intend to work?" with San Francisco,
// New York and Remote - US boxes came to Slack as three identical Yes/No questions.
const prompt = "From where do you intend to work?";
const box = (id: string, label: string): CareerBlocker => ({
  id: `career-blocker-${id}`, kind: "unknown_form_field", unit: "submission", questionProvenance: "ATS_FORM", field: id, status: "open",
  createdAt: "2026-11-23T22:36:13.663Z", question: prompt, reason: "The checkbox value is not an explicit boolean answer.", resumeAfterHuman: true,
  context: { jobId: "career-job-hex", applicationId: "application-hex", company: "Hex", role: "Software Engineer, Infrastructure" },
  evidence: [`field-id:${id}`, "field-type:checkbox", `field-label:${label}`, "field-required:true", `question-prompt:${prompt}`],
});

describe("a box in a checkbox group", () => {
  it("names the box in the Slack question", () => {
    const question = questionForBlocker(box("question_13539607004[]", "San Francisco (Hybrid)"))!;
    expect(question.prompt).toBe("From where do you intend to work? — San Francisco (Hybrid)");
    expect(question.options.map((option) => option.label)).toEqual(["Yes", "No"]);
  });

  it("saves each box under its own answer-bank key", () => {
    const keys = ["question_1[]", "question_1[]--2", "question_1[]--3"].map((id, index) =>
      answerBankKey(questionFromBlocker(box(id, ["San Francisco (Hybrid)", "New York City (Hybrid)", "Remote - US"][index]!)).question));
    expect(new Set(keys).size).toBe(3);
  });

  it("leaves a lone checkbox's prompt alone", () => {
    expect(withCheckboxLabel("I confirm the information is true.", "checkbox", "Acknowledge", "ack")).toBe("I confirm the information is true.");
    expect(withCheckboxLabel(prompt, "radio", "Remote - US", "q[]")).toBe(prompt);
  });
});
