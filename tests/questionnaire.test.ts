import { describe, expect, it } from "vitest";
import {
  experienceSkillsFor, findAnswerBankMatch, standingTopicFor, withExperienceYears, withStandingAnswer, yearsAsAnswer, type AnswerBankEntry,
} from "../application-agent/src/domain/answerBank";
import { QUESTIONNAIRE, applyQuestionnaireAnswer, questionnaireRows } from "../application-agent/src/domain/questionnaire";

const now = "2026-11-05T00:00:00.000Z";
const profile = { workPreferences: { remote: null, relocation: null, travel: null } };

describe("years-of-experience table", () => {
  it("answers only questions whose every word it understands", () => {
    expect(experienceSkillsFor("How many years of experience do you have with Python?")).toEqual({ skills: ["python"], mode: "years" });
    expect(experienceSkillsFor("Years of professional experience with React and TypeScript in production")).toEqual({ skills: ["typescript", "react"], mode: "years" });
    expect(experienceSkillsFor("How many years of professional software engineering experience do you have?")).toEqual({ skills: ["software"], mode: "years" });
    expect(experienceSkillsFor("Do you have experience with Kubernetes?")).toEqual({ skills: ["kubernetes"], mode: "yesno" });
    // Go is not in the table, so the whole question is still asked.
    expect(experienceSkillsFor("How many years of experience do you have with Go and Python?")).toBeUndefined();
    expect(experienceSkillsFor("How many years of experience do you have?")).toBeUndefined();
    expect(experienceSkillsFor("How many years of total work experience do you have in a similar role?")).toBeUndefined();
    expect(experienceSkillsFor("Describe your experience with Python")).toBeUndefined();
  });

  it("picks the range option holding the years, and Yes/No from zero or more", () => {
    expect(yearsAsAnswer(3, undefined, "years")).toBe("3");
    expect(yearsAsAnswer(3, ["Select...", "0-1 years", "1-3 years", "3-5 years", "5+ years"], "years")).toBe("3-5 years");
    expect(yearsAsAnswer(0.5, ["Less than 1 year", "1-2 years", "More than 2 years"], "years")).toBe("Less than 1 year");
    expect(yearsAsAnswer(7, ["None", "1 to 3", "4 to 6", "7 or more"], "years")).toBe("7 or more");
    expect(yearsAsAnswer(0, ["Yes", "No"], "yesno")).toBe("No");
    expect(yearsAsAnswer(2, ["Yes", "No"], "years")).toBe("Yes");
    // An option it cannot read means it cannot be sure the pick is right.
    expect(yearsAsAnswer(3, ["Junior", "Mid", "Senior"], "years")).toBeUndefined();
  });

  it("fills from the table and uses the smaller number for two skills", async () => {
    let entries: AnswerBankEntry[] = withExperienceYears([], "react", 4, now);
    entries = withExperienceYears(entries, "typescript", 2, now);
    const both = await findAnswerBankMatch(entries, { question: "Years of experience with React and TypeScript", options: ["0-1", "2-3", "4+"] });
    expect(both?.value).toBe("2-3");
    expect(await findAnswerBankMatch(entries, { question: "How many years of experience with Python?" })).toBeUndefined();
    expect(await findAnswerBankMatch(entries, { question: "Describe your React experience", fieldType: "textarea" })).toBeUndefined();
    expect(() => withExperienceYears([], "python", Number("three"), now)).toThrow();
  });
});

describe("new standing topics", () => {
  it("matches holding a clearance, not being able to get one", () => {
    expect(standingTopicFor("Do you hold an active security clearance? If yes, please list the level.")).toBe("security_clearance");
    expect(standingTopicFor("Do you currently have a security clearance?")).toBe("security_clearance");
    expect(standingTopicFor("Are you able to obtain a security clearance?")).toBeUndefined();
    expect(standingTopicFor("Are you eligible for a security clearance?")).toBeUndefined();
  });

  it("answers work location and notice period as text, never into a date field", async () => {
    let entries = withStandingAnswer([], "work_location", "Remote from McDonald, PA", now);
    entries = withStandingAnswer(entries, "notice_period", "2 weeks", now);
    expect((await findAnswerBankMatch(entries, { question: "If hired, from where do you intend to work?", fieldType: "text" }))?.value).toBe("Remote from McDonald, PA");
    expect((await findAnswerBankMatch(entries, { question: "Notice period", fieldType: "text" }))?.value).toBe("2 weeks");
    expect(await findAnswerBankMatch(entries, { question: "Notice period", fieldType: "date" })).toBeUndefined();
  });

  it("answers certifications as text and as Yes/No, but not a named certification", async () => {
    const entries = withStandingAnswer([], "certifications", "None", now);
    expect((await findAnswerBankMatch(entries, { question: "Please list any relevant certifications", fieldType: "text" }))?.value).toBe("None");
    expect((await findAnswerBankMatch(entries, { question: "Do you have any certifications?", options: ["Yes", "No"] }))?.value).toBe("No");
    expect(standingTopicFor("Do you hold an AWS certification?")).toBeUndefined();
  });
});

describe("questionnaire", () => {
  it("lists every item once and records each kind of answer where the agent reads it", () => {
    expect(new Set(QUESTIONNAIRE.map((item) => item.id)).size).toBe(QUESTIONNAIRE.length);
    let state = applyQuestionnaireAnswer("security_clearance", "n", [], profile, now);
    state = applyQuestionnaireAnswer("years.python", "2", state.entries, state.profile, now);
    state = applyQuestionnaireAnswer("relocation", "no", state.entries, state.profile, now);
    const rows = questionnaireRows(state.entries, state.profile);
    const value = (id: string) => rows.find((row) => row.item.id === id)?.value;
    expect(value("security_clearance")).toBe("No");
    expect(value("years.python")).toBe("2");
    expect(value("relocation")).toBe("No");
    expect(state.profile.workPreferences.relocation).toBe("No");
    expect(value("travel")).toBeUndefined();
    expect(() => applyQuestionnaireAnswer("salary", "100000", [], profile, now)).toThrow(/Unknown/);
    expect(() => applyQuestionnaireAnswer("years.python", "lots", [], profile, now)).toThrow();
  });
});

describe("wording found in saved forms", () => {
  it("reads production-environment and company wording as filler", () => {
    expect(experienceSkillsFor("How many years of experience do you have using React & Typescript in a production environment?")).toEqual({ skills: ["typescript", "react"], mode: "years" });
    expect(experienceSkillsFor("How many years of experience do you have in a B2B SaaS company?")).toEqual({ skills: ["b2b_saas"], mode: "years" });
  });

  it("answers military service but leaves protected-veteran self-ID to the profile", () => {
    expect(standingTopicFor("Are you a veteran/have you served in the military? *")).toBe("military_service");
    expect(standingTopicFor("Are you a protected veteran?")).toBeUndefined();
  });
});
