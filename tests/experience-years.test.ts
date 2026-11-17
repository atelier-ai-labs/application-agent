import { describe, expect, it } from "vitest";
import { requiredYearsOfExperience } from "../application-agent/src/domain/experienceYears";
import { applyHardFilters } from "../application-agent/src/domain/policies";
import { screenDiscoveredJob } from "../application-agent/src/domain/discoveryFilter";
import { normalizeJobSearchIntent, searchCriteriaFromJobSearchIntent } from "../application-agent/src/domain/searchIntent";
import type { JobPosting } from "../application-agent/src/domain/types";

describe("required years of experience", () => {
  it("reads the ways postings state it", () => {
    // Gusto and Ramp (2026-11-10).
    expect(requiredYearsOfExperience("Successful applicants have at least 10+ years of experience and the enthusiasm for a collaborative environment.")).toBe(10);
    expect(requiredYearsOfExperience("Minimum 5+ years of experience shipping high-quality architectures for critical systems preferred.")).toBe(5);
    expect(requiredYearsOfExperience("4+ years of backend or full-stack software engineering experience")).toBe(4);
    expect(requiredYearsOfExperience("You have 1-4 years of backend or full-stack development experience.")).toBe(1);
    expect(requiredYearsOfExperience("3 to 5 years of professional experience.\nRequires 3+ years operating production Kubernetes experience.")).toBe(3);
  });

  it("ignores years that aren't an experience requirement", () => {
    expect(requiredYearsOfExperience("For over 20 years, we have served small businesses.")).toBeUndefined();
    expect(requiredYearsOfExperience("Experience with Go. You must be 18 years of age.")).toBeUndefined();
    expect(requiredYearsOfExperience("Nice to have: 8+ years of experience with payments.")).toBeUndefined();
    expect(requiredYearsOfExperience(undefined)).toBeUndefined();
  });
});

describe("the experience limit", () => {
  const intent = normalizeJobSearchIntent({
    primaryLanes: ["Software Engineer"], adjacentLanes: [], secondaryLanes: [], preferredSeniorities: [], excludedSeniorities: ["senior"],
    excludedTitleTerms: ["stablecoin"], locations: ["United States"], remotePreference: "remote_preferred", breadth: "balanced", maxYearsExperience: 5,
  });
  const posting = (title: string, description: string) => ({
    title, company: "Gusto, Inc.", description, location: "Remote - US", remoteStatus: "remote", employmentType: "full time",
    requiredSkills: [], preferredSkills: [],
  }) as unknown as JobPosting;

  it("rejects a posting that asks for more years than the search allows, at discovery and before applying", () => {
    const gusto = posting("Software Engineer, Financial Data & Payments", "Successful applicants have at least 10+ years of experience.");
    expect(screenDiscoveredJob(gusto, intent)).toEqual({ keep: false, reason: "experience" });
    const criteria = searchCriteriaFromJobSearchIntent(intent);
    expect(criteria.maxYearsExperience).toBe(5);
    expect(applyHardFilters(gusto, criteria)).toMatchObject({ decision: "reject", reason: "Posting asks for 10+ years of experience; the search allows up to 5." });

    const ramp = posting("Software Engineer, Frontend", "Minimum of 5 years of frontend engineering experience preferred.");
    expect(screenDiscoveredJob(ramp, intent)).toEqual({ keep: true });
    expect(applyHardFilters(ramp, criteria).decision).not.toBe("reject");
  });

  it("drops stablecoin titles, and leaves the limit off unless set", () => {
    expect(screenDiscoveredJob(posting("Software Engineer, Security, Stablecoin", "3+ years of experience."), intent)).toMatchObject({ keep: false });
    const { maxYearsExperience: _ignored, ...rest } = intent;
    expect(screenDiscoveredJob(posting("Software Engineer", "At least 10+ years of experience."), rest)).toEqual({ keep: true });
    expect(() => normalizeJobSearchIntent({ ...intent, maxYearsExperience: -1 })).toThrow("maxYearsExperience");
  });
});
