import { describe, expect, it } from "vitest";
import { companyKey, companyLimitReached } from "../application-agent/src/domain/companyLimit";
import { normalizeJobSearchIntent, searchCriteriaFromJobSearchIntent } from "../application-agent/src/domain/searchIntent";
import type { CareerJob } from "../application-agent/src/domain/campaignTypes";

const now = new Date("2026-11-11T17:00:00.000Z");
const job = (id: string, company: string, status: string, updatedAt = "2026-11-10T23:00:00.000Z") =>
  ({ id, status, updatedAt, job: { company, title: "Engineer" } }) as unknown as CareerJob;

describe("per-company application limit", () => {
  it("treats spellings of one company as the same company", () => {
    expect(companyKey("Gusto, Inc.")).toBe(companyKey("Gusto"));
    expect(companyKey("D.A. Davidson")).toBe(companyKey("D A Davidson"));
    expect(companyKey("Upstart")).not.toBe(companyKey("Upstart Bank Holdings"));
  });

  it("counts applications inside the window and ones still in progress, with company overrides", () => {
    const limit = { max: 5, windowDays: 60, overrides: { Upstart: 3 } };
    const history = [
      job("devops", "Upstart", "applied", "2026-10-20T00:00:00.000Z"),
      job("bank", "Upstart", "applied"),
      job("installments", "Upstart", "ready_to_submit"),
      job("old", "Upstart", "applied", "2026-08-01T00:00:00.000Z"),
      job("skipped", "Upstart", "rejected"),
      job("stuck", "Upstart", "pursuing", "2026-09-01T00:00:00.000Z"),
    ];
    expect(companyLimitReached(job("delivery", "Upstart", "pursuing"), history, limit, now)).toEqual({ company: "Upstart", count: 3, max: 3, windowDays: 60 });
    expect(companyLimitReached(job("delivery", "Upstart", "pursuing"), history.slice(1), limit, now)).toBeUndefined();
    expect(companyLimitReached(job("other", "Mercury", "pursuing"), history, limit, now)).toBeUndefined();
  });

  it("is read from the search settings and rejects bad values", () => {
    const intent = {
      primaryLanes: ["Software Engineer"], adjacentLanes: [], secondaryLanes: [], preferredSeniorities: [], excludedSeniorities: [],
      excludedTitleTerms: [], locations: ["United States"], remotePreference: "remote_preferred", breadth: "balanced",
      companyApplicationLimit: { max: 3, windowDays: 60, overrides: { Upstart: 3 } },
    };
    expect(searchCriteriaFromJobSearchIntent(normalizeJobSearchIntent(intent)).companyApplicationLimit).toEqual({ max: 3, windowDays: 60, overrides: { Upstart: 3 } });
    expect(() => normalizeJobSearchIntent({ ...intent, companyApplicationLimit: { max: 0, windowDays: 60 } })).toThrow("companyApplicationLimit");
  });
});
