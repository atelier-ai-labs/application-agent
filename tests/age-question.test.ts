import { describe, expect, it } from "vitest";
import { classifyLeverApplicationField } from "../application-agent/src/domain/leverBrowserExecutor";

// Supabase, 2026-11-23: "Are you over the age of 18?" came to Slack.
const classify = (label: string) => classifyLeverApplicationField({ id: "q", label, type: "radio", options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }] } as never);

describe("age questions", () => {
  it("reads every common wording as the age check", () => {
    for (const label of [
      "Are you over the age of 18?",
      "Are you at least 18?",
      "Are you over 18 years old?",
      "Are you 18 years of age or older?",
      "Are you at least eighteen years old?",
    ]) expect(classify(label), label).toBe("legal_attestation");
  });

  it("leaves experience questions alone", () => {
    expect(classify("Do you have over 18 months of experience with Kubernetes?")).not.toBe("legal_attestation");
    expect(classify("Do you have at least 18 months of production Go experience?")).not.toBe("legal_attestation");
  });
});
