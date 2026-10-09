import { describe, expect, it } from "vitest";
import {
  HandoffBoundary,
  HandoffBoundaryError,
  assertHandoffOrigin,
} from "../application-agent/automation/executionHost/handoffBoundary";

describe("remote browser handoff security boundary", () => {
  it("requires a one-time bootstrap token and scopes the resulting session", () => {
    let now = 1_000;
    const boundary = new HandoffBoundary({ now: () => now, bootstrapTtlMs: 100, sessionTtlMs: 500 });
    const grant = boundary.issue("execution-1");
    const session = boundary.redeem(grant.token);
    expect(session.executionId).toBe("execution-1");
    expect(() => boundary.redeem(grant.token)).toThrow(HandoffBoundaryError);
    expect(() => boundary.authenticate(session.token, "execution-2")).toThrow(/another execution/);
    boundary.authenticate(session.token, "execution-1", "view");
    now = 1_501;
    expect(() => boundary.authenticate(session.token, "execution-1")).toThrow(/invalid or expired/);
  });

  it("expires unused grants and supports explicit revocation", () => {
    let now = 5_000;
    const boundary = new HandoffBoundary({ now: () => now, bootstrapTtlMs: 10, sessionTtlMs: 500 });
    const expired = boundary.issue("execution-expired");
    now = 5_010;
    expect(() => boundary.redeem(expired.token)).toThrow(/invalid, expired/);
    now = 6_000;
    const grant = boundary.issue("execution-revoked");
    const session = boundary.redeem(grant.token);
    boundary.revoke("execution-revoked");
    expect(() => boundary.authenticate(session.token, "execution-revoked")).toThrow(/invalid or expired/);
  });

  it("keeps only one active grant for an execution", () => {
    const boundary = new HandoffBoundary({ now: () => 1_000 });
    const first = boundary.issue("execution-single");
    const second = boundary.issue("execution-single");
    expect(() => boundary.redeem(first.token)).toThrow();
    expect(boundary.redeem(second.token).executionId).toBe("execution-single");
  });

  it("is view-only and rejects submit or pointer capabilities", () => {
    const boundary = new HandoffBoundary({ now: () => 1_000 });
    const session = boundary.redeem(boundary.issue("execution-3").token);
    expect(session.capabilities).toEqual(["view"]);
    expect(() => boundary.authenticate(session.token, "execution-3", "pointer" as never)).toThrow(/not permitted/);
    expect(() => boundary.authenticate(session.token, "execution-3", "submit" as never)).toThrow(/not permitted/);
  });

  it("requires an exact allowed origin", () => {
    expect(() => assertHandoffOrigin("https://example.invalid", ["https://viewer.invalid"])).toThrow(/not allowed/);
    expect(() => assertHandoffOrigin(undefined, ["https://viewer.invalid"])).toThrow(/not allowed/);
    expect(() => assertHandoffOrigin("https://viewer.invalid", ["https://viewer.invalid"])).not.toThrow();
  });
});
