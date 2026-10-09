import { describe, expect, it } from "vitest";
import {
  assertSubmitPreparedApplicationPreflight,
  assertDuplicateRiskRetryAuthorization,
  assertTrustedExecutionHostBaseUrl,
} from "../application-agent/automation/runtime/submitPreparedApplicationPreflight";
import type { Application } from "../application-agent/src/domain/types";
import type { CareerJob } from "../application-agent/src/domain/campaignTypes";
import { authorizeThenSubmit } from "../application-agent/automation/runtime/submitPreparedApplicationFlow";

const ids = { campaignId: "campaign-1", jobId: "job-1", applicationId: "application-1" };

function packet(overrides: { job?: Partial<CareerJob>; application?: Partial<Application> } = {}) {
  const job = {
    id: ids.jobId,
    campaignId: ids.campaignId,
    applicationId: ids.applicationId,
    status: "ready_to_submit",
    execution: { status: "ready_to_submit", mode: "real_local", hostExecutionId: "host-1" },
    ...overrides.job,
  } as CareerJob;
  const application = {
    id: ids.applicationId,
    status: "ready_for_review",
    ...overrides.application,
  } as Application;
  return { ...ids, job, application, executionHostBaseUrl: "http://127.0.0.1:8787" };
}

describe("submit prepared application preflight", () => {
  it("accepts an exact proof-free retained packet", () => {
    expect(() => assertSubmitPreparedApplicationPreflight(packet())).not.toThrow();
  });

  it.each([
    [{ application: { status: "needs_input" } }, "ready-for-review"],
    [{ job: { status: "preparing" } }, "ready-to-submit"],
    [{ job: { execution: { status: "ready_to_submit", mode: "simulated", hostExecutionId: "host-1" } } }, "retained real local"],
    [{ job: { submissionProof: { mode: "external" } } }, "durable submission proof"],
  ] as const)("rejects %s", (overrides, label) => {
    expect(() => assertSubmitPreparedApplicationPreflight(packet(overrides as { job?: Partial<CareerJob>; application?: Partial<Application> }))).toThrow(label);
  });

  it("rejects an ID mismatch and untrusted host", () => {
    expect(() => assertSubmitPreparedApplicationPreflight(packet({ job: { applicationId: "other" } }))).toThrow("IDs do not match");
    expect(() => assertSubmitPreparedApplicationPreflight({ ...packet(), executionHostBaseUrl: "https://example.com" })).toThrow("trusted local");
  });
});

describe("trusted execution host", () => {
  it("accepts loopback HTTP and rejects remote or non-HTTP URLs", () => {
    expect(() => assertTrustedExecutionHostBaseUrl("http://localhost:8787")).not.toThrow();
    expect(() => assertTrustedExecutionHostBaseUrl("http://[::1]:8787")).not.toThrow();
    expect(() => assertTrustedExecutionHostBaseUrl("https://127.0.0.1:8787")).toThrow();
    expect(() => assertTrustedExecutionHostBaseUrl("http://10.0.0.2:8787")).toThrow();
  });
});

describe("duplicate-risk submit authorization", () => {
  it("allows a fresh packet without duplicate-risk metadata", () => {
    expect(() => assertDuplicateRiskRetryAuthorization(undefined, undefined, undefined)).not.toThrow();
  });

  it("requires duplicate-risk metadata only for an unknown fence", () => {
    expect(() => assertDuplicateRiskRetryAuthorization("unknown", undefined, undefined)).toThrow("unknown submission fence");
    expect(() => assertDuplicateRiskRetryAuthorization("unknown", "I_ACCEPT_DUPLICATE_SUBMISSION_RISK", "User accepts duplicate risk.")).not.toThrow();
  });
});

describe("submit lock ordering", () => {
  it("starts the host action only after the async state lock is released", async () => {
    let locked = false;
    let hostSawLock = true;
    const result = await authorizeThenSubmit(
      async (operation) => {
        locked = true;
        try { return await operation(); } finally { locked = false; }
      },
      () => expect(locked).toBe(true),
      async () => { hostSawLock = locked; return "host-result"; },
    );
    expect(result).toBe("host-result");
    expect(hostSawLock).toBe(false);
  });
});
