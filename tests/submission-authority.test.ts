import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableSubmissionAuthority, SubmissionAuthorityError } from "../application-agent/automation/executionHost/submissionAuthority";
import type { KeyValueStorage } from "../application-agent/src/persistence/storage";

class MemoryStorage implements KeyValueStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

describe("durable automatic submission authority", () => {
  it("fences duplicate workers and permits a same-worker restart only before the click boundary", () => {
    const storage = new MemoryStorage();
    const first = new DurableSubmissionAuthority("worker-a", { storage });
    const second = new DurableSubmissionAuthority("worker-b", { storage });
    const fence = first.claim("application-1", "job-1", "2026-09-19T00:00:00.000Z");
    expect(() => second.claim("application-1", "job-1", "2026-09-19T00:00:01.000Z")).toThrow(SubmissionAuthorityError);
    const restarted = new DurableSubmissionAuthority("worker-a", { storage });
    const retry = restarted.claim("application-1", "job-1", "2026-09-19T00:00:02.000Z");
    expect(retry.token).not.toBe(fence.token);
    restarted.beforeClick(retry, "2026-09-19T00:00:03.000Z");
    expect(() => first.beforeClick(fence, "2026-09-19T00:00:04.000Z")).toThrow("ownership was lost");
  });

  it("makes a clicked-but-unproven outcome terminal and never retryable", () => {
    const storage = new MemoryStorage();
    const authority = new DurableSubmissionAuthority("worker-a", { storage });
    const fence = authority.claim("application-2", "job-2", "2026-09-19T00:00:00.000Z");
    authority.beforeClick(fence, "2026-09-19T00:00:01.000Z");
    authority.markUnknown(fence, "2026-09-19T00:00:02.000Z");
    expect(authority.get("application-2", "job-2")?.state).toBe("unknown");
    expect(() => authority.claim("application-2", "job-2", "2026-09-19T00:00:03.000Z")).toThrow("cannot be submitted automatically again");
  });

  it("requires deterministic external proof before recording submitted", () => {
    const storage = new MemoryStorage();
    const authority = new DurableSubmissionAuthority("worker-a", { storage });
    const fence = authority.claim("application-3", "job-3", "2026-09-19T00:00:00.000Z");
    expect(() => authority.markSubmitted(fence, "external-1", "2026-09-19T00:00:01.000Z")).toThrow("did not match");
    authority.beforeClick(fence, "2026-09-19T00:00:02.000Z");
    authority.markSubmitted(fence, "external-1", "2026-09-19T00:00:03.000Z");
    expect(authority.get("application-3", "job-3")).toMatchObject({ state: "submitted", proofExternalApplicationId: "external-1" });
  });

  it("refreshes independent file-backed instances inside the exclusive transaction", () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-submission-fence-"));
    const stateFile = join(directory, "state.json");
    try {
      const first = new DurableSubmissionAuthority("worker-a", { stateFile });
      const second = new DurableSubmissionAuthority("worker-b", { stateFile });
      first.claim("application-race", "job-race", "2026-09-19T00:00:00.000Z");
      expect(() => second.claim("application-race", "job-race", "2026-09-19T00:00:01.000Z")).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reconciles crash boundaries without another click", () => {
    const storage = new MemoryStorage();
    const authority = new DurableSubmissionAuthority("worker-a", { storage });
    const submitted = authority.claim("application-crash-1", "job-crash-1", "2026-09-19T00:00:00.000Z");
    authority.beforeClick(submitted, "2026-09-19T00:00:01.000Z");
    authority.markSubmitted(submitted, "external-proof", "2026-09-19T00:00:02.000Z");
    expect(authority.reconcile("application-crash-1", "job-crash-1")).toEqual({ state: "submitted", externalApplicationId: "external-proof" });
    const unknown = authority.claim("application-crash-2", "job-crash-2", "2026-09-19T00:00:00.000Z");
    authority.beforeClick(unknown, "2026-09-19T00:00:01.000Z");
    authority.markUnknown(unknown, "2026-09-19T00:00:02.000Z");
    expect(authority.reconcile("application-crash-2", "job-crash-2").state).toBe("needs_input");
  });

  it("requires an explicit no-submission assertion before reopening an unknown fence", () => {
    const storage = new MemoryStorage();
    const authority = new DurableSubmissionAuthority("worker-a", { storage });
    const fence = authority.claim("application-recover", "job-recover", "2026-09-19T00:00:00.000Z");
    authority.beforeClick(fence, "2026-09-19T00:00:01.000Z");
    authority.markUnknown(fence, "2026-09-19T00:00:02.000Z");

    expect(() => authority.recoverUnknownForFreshAttempt(
      "application-recover",
      "job-recover",
      { confirmedNotSubmitted: true, reason: "short" },
      "2026-09-19T00:00:03.000Z",
    )).toThrow("at least 10 characters");
    const recovered = authority.recoverUnknownForFreshAttempt(
      "application-recover",
      "job-recover",
      { confirmedNotSubmitted: true, reason: "User confirmed the CAPTCHA stopped submission." },
      "2026-09-19T00:00:03.000Z",
    );
    expect(recovered).toMatchObject({
      state: "recovered",
      recovery: {
        kind: "user_asserted_not_submitted",
        confirmedNotSubmitted: true,
        previousToken: fence.token,
      },
    });
    const fresh = authority.claim("application-recover", "job-recover", "2026-09-19T00:00:04.000Z");
    expect(fresh.state).toBe("claimed");
    expect(fresh.token).not.toBe(fence.token);
    expect(fresh.recovery?.reason).toContain("CAPTCHA");
  });

  it("rejects recovery when the unknown fence already has submission proof", () => {
    const storage = new MemoryStorage();
    const authority = new DurableSubmissionAuthority("worker-a", { storage });
    const fence = authority.claim("application-proof", "job-proof", "2026-09-19T00:00:00.000Z");
    authority.beforeClick(fence, "2026-09-19T00:00:01.000Z");
    authority.markSubmitted(fence, "external-id", "2026-09-19T00:00:02.000Z");
    expect(() => authority.recoverUnknownForFreshAttempt(
      "application-proof",
      "job-proof",
      { confirmedNotSubmitted: true, reason: "The user says it was not submitted." },
      "2026-09-19T00:00:03.000Z",
    )).toThrow("unknown fence");
  });

  it("records explicit duplicate-risk authorization without treating it as a no-submission assertion", () => {
    const storage = new MemoryStorage();
    const authority = new DurableSubmissionAuthority("worker-a", { storage });
    const fence = authority.claim("application-risk", "job-risk", "2026-09-19T00:00:00.000Z");
    authority.beforeClick(fence, "2026-09-19T00:00:01.000Z");
    authority.markUnknown(fence, "2026-09-19T00:00:02.000Z");
    expect(() => authority.authorizeDuplicateRiskRetry("application-risk", "job-risk", { confirmedRisk: true, reason: "short" }, "2026-09-19T00:00:03.000Z")).toThrow(/at least 10/);
    const authorized = authority.authorizeDuplicateRiskRetry(
      "application-risk",
      "job-risk",
      { confirmedRisk: true, reason: "User accepts the possibility of a duplicate submission." },
      "2026-09-19T00:00:03.000Z",
    );
    expect(authorized).toMatchObject({ state: "retry_authorized", duplicateRiskRetryAuthorization: { confirmedRisk: true, previousToken: fence.token } });
    expect(authorized.recovery).toBeUndefined();
    expect(() => authority.authorizeDuplicateRiskRetry("application-risk", "job-risk", { confirmedRisk: true, reason: "User accepts the possibility of a duplicate submission." }, "2026-09-19T00:00:03.500Z")).toThrow(/already consumed/);
    expect(authority.claim("application-risk", "job-risk", "2026-09-19T00:00:04.000Z").state).toBe("claimed");
  });
});
