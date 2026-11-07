import { describe, expect, it } from "vitest";
import { isTrustedAutomaticConfirmation } from "../application-agent/src/domain/leverBrowserExecutor";

// Outmarket AI, 2026-11-06: Ashby showed "application submitted" on the same
// /application URL, and the agent asked for DONE because it only trusted a
// /confirmation-style URL.
describe("Ashby's in-place confirmation", () => {
  const postingId = "10a2487a-1594-4400-8404-9ad2e96eb253";
  const target = { provider: "ashby" as const, postingId, applicationUrl: `https://jobs.ashbyhq.com/outmarket/${postingId}/application` };
  const result = (url: string, evidence: string) => ({
    clicked: true, confirmed: true, externalApplicationId: `confirmation:${url}`, confirmationOrigin: new URL(url).origin, confirmationUrl: url, evidence,
  });
  const page = `https://jobs.ashbyhq.com/outmarket/${postingId}/application`;

  it("is proof when Ashby's success panel (or its wording with the form gone) appears on this posting's page", () => {
    expect(isTrustedAutomaticConfirmation(result(page, "submit:clicked; confirmation:ashby-success; confirmation-path:/outmarket/x/application"), target)).toBe(true);
    expect(isTrustedAutomaticConfirmation(result(page, "submit:clicked; confirmation:ashby-form-replaced; confirmation-path:/outmarket/x/application"), target)).toBe(true);
  });

  it("is not proof on another posting, another host, without the click, or from wording alone", () => {
    const other = `https://jobs.ashbyhq.com/outmarket/0f6b7a70-0000-4000-8000-000000000001/application`;
    expect(isTrustedAutomaticConfirmation(result(other, "submit:clicked; confirmation:ashby-success"), target)).toBe(false);
    expect(isTrustedAutomaticConfirmation({ ...result(page, "submit:clicked; confirmation:ashby-success"), confirmationOrigin: "https://evil.example" }, target)).toBe(false);
    expect(isTrustedAutomaticConfirmation(result(page, "submit:not-clicked; confirmation:ashby-success"), target)).toBe(false);
    expect(isTrustedAutomaticConfirmation(result(page, "submit:clicked; confirmation:text"), target)).toBe(false);
    expect(isTrustedAutomaticConfirmation(result(page, "submit:clicked; confirmation:ashby-success"), { ...target, provider: "greenhouse" as never })).toBe(false);
  });
});
