import { describe, expect, it } from "vitest";
import {
  answerBankKey, answerRiskTier, findAnswerBankMatch, isBankableQuestion, isOpaqueQuestion, questionFromBlocker,
  standingRecordsFromJobs, standingTopicFor, valueForOptions, withRecordedAnswer, withStandingAnswer, type AnswerBankEntry, type StandingTopicId,
} from "../application-agent/src/domain/answerBank";

const entry = (question: string, value: string, company?: string, extra: Partial<AnswerBankEntry> = {}): AnswerBankEntry => ({
  id: `e-${question}`, key: answerBankKey(question, company), question, value, tier: answerRiskTier(question, company),
  source: "slack", recordedAt: "2026-11-01T00:00:00.000Z", ...(company ? { company } : {}), ...extra,
});

describe("answer bank", () => {
  it("keys questions without the employer name or executor wrappers", () => {
    expect(answerBankKey("How did you hear about Phantom?*", "Phantom")).toBe("how did you hear about {company}");
    expect(answerBankKey("Before applying, how did you hear about Upstart?*", "Upstart")).toBe("before applying how did you hear about {company}");
    expect(answerBankKey("How familiar were you with Sparksoft Corporation's products?", "Sparksoft Corporation")).toBe("how familiar were you with {company} products");
    expect(answerBankKey('Required question under "Location": "Are you open to travel?"')).toBe("are you open to travel");
  });

  it("rates risk so attestations, pay, sponsorship, employer-specific questions, and essays are never reused", () => {
    expect(answerRiskTier("How did you hear about Phantom?", "Phantom")).toBe("low");
    expect(answerRiskTier("We currently support remote work from North America, South America, and Europe. Which of these three locations will you be working from?")).toBe("low");
    expect(answerRiskTier("How many years of experience do you have with React?")).toBe("medium");
    expect(answerRiskTier("Are you open to travel?")).toBe("medium");
    expect(answerRiskTier("Have you previously worked for Kapitus?", "Kapitus")).toBe("high");
    expect(answerRiskTier("Were you referred by a Kapitus employee?", "Kapitus")).toBe("high");
    expect(answerRiskTier("What is your desired base salary?")).toBe("high");
    expect(answerRiskTier("Do you now or will you in the future require visa sponsorship?")).toBe("high");
    expect(answerRiskTier("I certify that the information provided is true and complete")).toBe("high");
    expect(answerRiskTier("Have you ever been fired or asked to resign?")).toBe("high");
    expect(answerRiskTier("Please tell us your story, what has you looking for a new role?")).toBe("high");
    expect(answerRiskTier({ question: "Anything else?", fieldType: "textarea" })).toBe("high");
    expect(answerRiskTier({ question: "How did you come to know about Plane?", company: "Plane", fieldType: "textarea" })).toBe("low");
  });

  it("refuses opaque labels, long text, and skipped answers", () => {
    for (const label of ["Select", "Phone", "Search", "Required yes/no application question (control cards[2651cb46])", "I have read this"]) {
      expect(isOpaqueQuestion(label)).toBe(true);
    }
    expect(isBankableQuestion({ question: "How did you hear about us?" }, "LinkedIn")).toBe(true);
    expect(isBankableQuestion({ question: "How did you hear about us?" }, "x".repeat(201))).toBe(false);
    expect(isBankableQuestion({ question: "How did you hear about us?" }, "__atelier_optional_answer_skipped__")).toBe(false);
    expect(isBankableQuestion({ question: "What is your desired salary?" }, "100000")).toBe(false);
    expect(isBankableQuestion({ question: "Please let us know where you heard about this job opening?", company: "MeridianLink" }, "MeridianLink Career Site")).toBe(false);
    expect(isBankableQuestion({ question: "I understand that as permitted by law, MeridianLink will conduct an investigative consumer report", company: "MeridianLink" }, "I agree")).toBe(false);
    expect(isBankableQuestion({ question: "Please select if you are a" }, "a U.S. citizen or national;")).toBe(false);
    expect(isBankableQuestion({ question: "If available immediately, what was your last working day?" }, "10/31/26")).toBe(false);
    expect(answerRiskTier("Please let us know where you heard about this job opening?")).toBe("low");
  });

  it("maps a saved answer onto this form's options", () => {
    expect(valueForOptions("yes", ["Yes", "No"])).toBe("Yes");
    expect(valueForOptions("no", ["Yes, I am", "No, I am not"])).toBe("No, I am not");
    expect(valueForOptions("North America", ["north america", "Europe"])).toBe("north america");
    expect(valueForOptions("Another job site", ["LinkedIn", "Other"])).toBeUndefined();
    expect(valueForOptions("Other", undefined)).toBe("Other");
  });

  it("reuses an exact answer at another company, and similar wording only for low-risk questions", async () => {
    const bank = [
      entry("How did you hear about Phantom?", "Other", "Phantom"),
      entry("Are you open to travel?", "yes"),
      entry("How many years of experience do you have with React?", "2"),
    ];
    expect((await findAnswerBankMatch(bank, { question: "How did you hear about Sparksoft?", company: "Sparksoft", options: ["LinkedIn", "Other"] }))?.value).toBe("Other");
    expect((await findAnswerBankMatch(bank, { question: "Before applying, how did you hear about Sparksoft?", company: "Sparksoft", options: ["Other"] }))?.kind).toBe("similar");
    expect((await findAnswerBankMatch(bank, { question: "Are you open to travel?*", options: ["Yes", "No"] }))?.value).toBe("Yes");
    // Medium risk needs the exact question: a different technology is a different question.
    expect(await findAnswerBankMatch(bank, { question: "How many years of experience do you have with Python?" })).toBeUndefined();
    // The saved answer is not one of this form's options.
    expect(await findAnswerBankMatch(bank, { question: "How did you hear about Sparksoft?", company: "Sparksoft", options: ["LinkedIn", "Indeed"] })).toBeUndefined();
  });

  it("asks the model only for low-risk questions and only accepts a confident pick", async () => {
    const bank = [entry("Which region will you be working from?", "North America")];
    const question = { question: "Which region will you be based in while you work with us?", options: ["North America", "Europe"] };
    let calls = 0;
    const matcher = (confidence: number) => async (_q: unknown, candidates: readonly AnswerBankEntry[]) => { calls += 1; return { entryId: candidates[0].id, confidence }; };
    expect((await findAnswerBankMatch(bank, question, matcher(0.95)))?.kind).toBe("model");
    expect(await findAnswerBankMatch(bank, question, matcher(0.6))).toBeUndefined();
    calls = 0;
    expect(await findAnswerBankMatch([entry("How many years of experience do you have with React?", "2")], { question: "How many years of React experience?" }, matcher(0.99))).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("skips disabled entries and keeps only the newest answer per question", async () => {
    const old = entry("Are you open to travel?", "no", undefined, { id: "old", recordedAt: "2026-10-01T00:00:00.000Z" });
    const updated = withRecordedAnswer([old], entry("Are you open to travel?", "yes", undefined, { id: "new" }));
    expect(updated.map((item) => item.id)).toEqual(["new"]);
    expect(await findAnswerBankMatch([{ ...updated[0], disabled: true }], { question: "Are you open to travel?" })).toBeUndefined();
  });

  it("reads field type and options from executor evidence", () => {
    const question = questionFromBlocker({
      kind: "unknown_form_field", question: "How did you hear about Phantom?",
      context: { company: "Phantom", role: "AI Engineer" } as never,
      evidence: ["field-type:select", "options:Phantom User|Other", "question-prompt:How did you hear about Phantom?"],
    });
    expect(question).toEqual({ question: "How did you hear about Phantom?", company: "Phantom", fieldType: "select", options: ["Phantom User", "Other"], kind: "unknown_form_field" });
  });
});

describe("standing answers", () => {
  const standing = (topic: StandingTopicId, value: string) => withStandingAnswer([], topic, value, "2026-11-04T00:00:00.000Z")[0]!;

  it("matches each topic only for questions asked about the candidate", () => {
    expect(standingTopicFor("Have you been convicted of, or pled guilty or nolo contendere (“no contest”) in a domestic, foreign, or military court to any felony?")).toBe("criminal_conviction");
    expect(standingTopicFor("Have you ever been fired or asked to resign to avoid being fired from a job?")).toBe("terminated");
    expect(standingTopicFor("Do you have an unsatisfied judgements or liens against you?")).toBe("financial_judgments");
    expect(standingTopicFor("Has a bonding company ever denied, paid out on, or revoked a bond for you?")).toBe("financial_judgments");
    expect(standingTopicFor("Have you ever been licensed in the insurance or securities industry?")).toBe("financial_license");
    expect(standingTopicFor("If you answered “Yes” to either licensing question above, have you ever been disciplined by a regulatory body?")).toBe("regulatory_discipline");
    expect(standingTopicFor("Have you signed any confidentiality, noncompetition, or non-solicitation agreements with your current employer?")).toBe("restrictive_agreements");
    expect(standingTopicFor("Are you willing to undergo a background check, in accordance with local law?")).toBe("background_check");
    expect(standingTopicFor("Are you able to perform the essential functions of the position with or without reasonable accommodation?")).toBe("essential_functions");
    expect(standingTopicFor("Have you previously applied for employment with D.A. Davidson Companies?", "D.A. Davidson Companies")).toBe("previously_applied");
    expect(standingTopicFor("Have you previously interviewed for a role at Teamworks?", "Teamworks")).toBe("previously_interviewed");
    // Statements and consents are not questions about the candidate's history.
    expect(standingTopicFor("I understand my employment is at-will and may be terminated at any time.")).toBeUndefined();
    expect(standingTopicFor("Do you understand that employment may be terminated at any time?")).toBeUndefined();
    expect(standingTopicFor("Do you consent to a criminal history check?")).toBeUndefined();
    expect(standingTopicFor("Do you agree to sign a confidentiality agreement if hired?")).toBeUndefined();
  });

  it("answers a standing topic from the set value, mapped to the form's options", async () => {
    const bank = [standing("criminal_conviction", "No"), standing("regulatory_discipline", "No"), standing("essential_functions", "Yes")];
    expect((await findAnswerBankMatch(bank, { question: "Have you been convicted of a felony?", options: ["Yes", "No"] }))).toMatchObject({ value: "No", kind: "standing" });
    expect((await findAnswerBankMatch(bank, { question: "If you answered Yes above, have you ever been disciplined by a regulatory body?", options: ["Yes", "No", "N/A"] }))?.value).toBe("No");
    expect((await findAnswerBankMatch(bank, { question: "Can you perform the essential functions of this job with or without reasonable accommodation?", options: ["Yes, I can", "No, I cannot"] }))?.value).toBe("Yes, I can");
    // A topic with no standing answer still asks.
    expect(await findAnswerBankMatch(bank, { question: "Have you ever been fired or asked to resign?", options: ["Yes", "No"] })).toBeUndefined();
  });

  it("answers applied-before from the agent's records", async () => {
    const bank = [standing("previously_applied", "@records"), standing("previously_interviewed", "@records")];
    const jobs = [{ id: "old", status: "applied", job: { company: "Sparksoft Corporation" } }, { id: "now", status: "needs_input", job: { company: "Sparksoft Corporation" } }];
    const records = standingRecordsFromJobs(jobs, "now");
    const ask = (question: string, company: string, recordsLookup = records) => findAnswerBankMatch(bank, { question, company, options: ["Yes", "No"] }, undefined, recordsLookup);
    expect((await ask("Have you previously applied for a role at Sparksoft?", "Sparksoft Corporation"))?.value).toBe("Yes");
    expect((await ask("Have you previously applied for a role at Phantom?", "Phantom"))?.value).toBe("No");
    // Interviewed before: unknowable after a past application, so it asks.
    expect(await ask("Have you previously interviewed for a role at Sparksoft?", "Sparksoft Corporation")).toBeUndefined();
    expect((await ask("Have you previously interviewed for a role at Phantom?", "Phantom"))?.value).toBe("No");
  });
});
