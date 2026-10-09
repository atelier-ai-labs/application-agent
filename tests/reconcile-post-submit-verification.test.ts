import { describe, expect, it } from "vitest";
import { assertPostSubmitVerificationSnapshot } from "../application-agent/automation/runtime/reconcilePostSubmitVerification";
import type { ExecutionHostSnapshot } from "../application-agent/src/domain/executionHostTypes";

const ids = { campaignId: "campaign-1", jobId: "job-1", applicationId: "application-1", executionId: "execution-1" };

function snapshot(overrides: Partial<ExecutionHostSnapshot> = {}): ExecutionHostSnapshot {
  return {
    ...ids,
    id: ids.executionId,
    mode: "real_local",
    status: "waiting_for_human",
    manualSubmission: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    result: {
      state: "requires_human",
      blocker: {
        kind: "external_verification",
        unit: "submission",
        questionProvenance: "POLICY",
        field: "submission-confirmation",
        question: "Verify whether the application was submitted",
        reason: "The Submit control was activated, but provider confirmation was not deterministic.",
        evidence: ["submit:clicked"],
        resumeAfterHuman: false,
      },
    },
    ...overrides,
  };
}

describe("post-submit verification reconciliation", () => {
  it("accepts only the exact post-click external-verification snapshot", () => {
    expect(() => assertPostSubmitVerificationSnapshot(snapshot(), ids)).not.toThrow();
    expect(() => assertPostSubmitVerificationSnapshot(snapshot({ manualSubmission: undefined }), ids)).not.toThrow();
  });

  it.each([
    ["wrong execution", { id: "other" }],
    ["not waiting", { status: "ready_to_submit" }],
    ["wrong blocker", { result: { state: "requires_human", blocker: { kind: "captcha" } } }],
    ["not clicked", { result: { state: "requires_human", blocker: { kind: "external_verification", evidence: ["submit:not-clicked"], resumeAfterHuman: false } } }],
    ["retry allowed", { result: { state: "requires_human", blocker: { kind: "external_verification", evidence: ["submit:clicked"], resumeAfterHuman: true } } }],
  ] as const)("rejects %s", (_label, overrides) => {
    expect(() => assertPostSubmitVerificationSnapshot(snapshot(overrides as Partial<ExecutionHostSnapshot>), ids)).toThrow();
  });
});
