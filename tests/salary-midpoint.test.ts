import { describe, expect, it } from "vitest";
import { buildDraftAnswer, postedSalaryMidpoint, prepareApplicationAnswers } from "../application-agent/src/domain/answers";
import { exampleCandidateProfile } from "../application-agent/src";
import type { CandidateProfile, FitAssessment, JobPosting, TailoredResume } from "../application-agent/src/domain/types";

describe("salary from the posted range", () => {
  it("takes the middle of a real annual USD range, rounded to $1,000", () => {
    expect(postedSalaryMidpoint({ minimum: 120_000, maximum: 160_000, currency: "USD", period: "annual" })).toBe(140_000);
    expect(postedSalaryMidpoint({ minimum: 80_500, maximum: 92_000, currency: "USD", period: "annual" })).toBe(86_000);
    // Period left out but clearly annual numbers (Reddit, Instructure).
    expect(postedSalaryMidpoint({ minimum: 85_000, maximum: 90_000, currency: "USD" })).toBe(88_000);
  });

  it("refuses anything that is not one believable salary band", () => {
    expect(postedSalaryMidpoint(undefined)).toBeUndefined();
    expect(postedSalaryMidpoint({ minimum: 60, currency: "USD", period: "annual" })).toBeUndefined(); // GC AI's stray "$60"
    expect(postedSalaryMidpoint({ minimum: 140_000, currency: "USD" })).toBeUndefined(); // one number, not a range
    expect(postedSalaryMidpoint({ minimum: 45, maximum: 60, currency: "USD", period: "hourly" })).toBeUndefined();
    expect(postedSalaryMidpoint({ minimum: 90_000, maximum: 120_000, currency: "CAD" })).toBeUndefined();
    expect(postedSalaryMidpoint({ minimum: 50_000, maximum: 300_000, currency: "USD" })).toBeUndefined(); // too wide
  });

  it("answers Expected compensation only when the profile opts in and the posting has a range", async () => {
    const job = { company: "Acme", title: "Engineer", requiredSkills: [], compensation: { minimum: 120_000, maximum: 160_000, currency: "USD", period: "annual" } } as unknown as JobPosting;
    const fit = { strongMatches: [], recommendedResumeFamily: "cloud-platform" } as unknown as FitAssessment;
    const resume = { summary: "s" } as unknown as TailoredResume;
    const run = async (profile: CandidateProfile, posting: JobPosting) =>
      (await prepareApplicationAnswers(posting, profile, fit, resume, async (context) => buildDraftAnswer(context))).find((answer) => answer.field === "salary_expectations");
    const optedIn: CandidateProfile = { ...exampleCandidateProfile, workPreferences: { ...exampleCandidateProfile.workPreferences, salaryStrategy: "posting_midpoint" } };

    expect(await run(optedIn, job)).toMatchObject({ status: "resolved", value: "140000" });
    expect(await run(exampleCandidateProfile, job)).toMatchObject({ status: "needs_input" });
    expect(await run(optedIn, { ...job, compensation: undefined })).toMatchObject({ status: "needs_input" });
  });
});
