/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { SUBMISSION_CONFIRMATION_TEXT } from "../application-agent/automation/playwrightLeverBrowserSession";

describe("submission confirmation text", () => {
  it.each([
    "Thanks for submitting your application!",
    "Application submitted",
    "Your application was successfully submitted.",
    "Thank you for applying to Plane.",
    "You've applied",
    "Your application has been received.",
  ])("recognizes %s", (text) => {
    expect(SUBMISSION_CONFIRMATION_TEXT.test(text)).toBe(true);
  });

  it.each([
    "Thanks for your interest in Plane. Submit your application below.",
    "Submit Application",
    "Application",
    "Before you submit your application, review your answers.",
  ])("does not treat %s as a confirmation", (text) => {
    expect(SUBMISSION_CONFIRMATION_TEXT.test(text)).toBe(false);
  });
});
