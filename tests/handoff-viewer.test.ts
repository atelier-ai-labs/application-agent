import { describe, expect, it } from "vitest";
import { HandoffBoundary } from "../application-agent/automation/executionHost/handoffBoundary";
import { createHandoffViewerServer, type HandoffBridge } from "../application-agent/automation/executionHost/handoffViewer";

describe("isolated handoff viewer HTTP boundary", () => {
  it("rotates only to HTTPS public origins", () => {
    const viewer = createHandoffViewerServer({
      boundary: new HandoffBoundary(),
      bridgeForExecution: () => undefined,
      origin: "http://127.0.0.1:18988",
      port: 18988,
    });
    expect(viewer.getPublicOrigin()).toBe("http://127.0.0.1:18988");
    viewer.setPublicOrigin("https://sample.trycloudflare.com");
    expect(viewer.getPublicOrigin()).toBe("https://sample.trycloudflare.com");
    expect(() => viewer.setPublicOrigin("http://public.example.invalid")).toThrow(/HTTPS/);
    expect(() => viewer.setPublicOrigin("https://sample.trycloudflare.com/path")).toThrow(/exact origins/);
  });

  it("redeems once, serves screenshots without Origin on same-origin GET, and rejects cross-site control POSTs", async () => {
    const boundary = new HandoffBoundary({ now: () => 1_000 });
    let activated: string | undefined;
    const bridge: HandoffBridge = {
      screenshot: async () => Buffer.from("png"),
      controls: async () => [{ id: "verify-human", label: "Verify you are human" }],
      activate: async (controlId) => { activated = controlId; },
    };
    const port = 18_987;
    const viewer = createHandoffViewerServer({
      boundary,
      bridgeForExecution: (executionId) => executionId === "execution-1" ? bridge : undefined,
      port,
      origin: `http://127.0.0.1:${port}`,
    });
    try {
      try {
        await viewer.listen();
      } catch (error) {
        // Restricted CI/sandbox environments may forbid loopback binds. The
        // test remains executable on a normal host and does not weaken policy.
        if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EADDRINUSE") return;
        throw error;
      }
      const grant = boundary.issue("execution-1");
      const shell = await fetch(`http://127.0.0.1:${port}/handoff#token=${encodeURIComponent(grant.token)}`);
      expect(shell.status).toBe(200);
      expect(shell.headers.get("content-security-policy")).toContain("connect-src 'self'");
      expect(shell.headers.get("content-security-policy")).toContain("img-src 'self' data: blob:");
      const redeemed = await fetch(`http://127.0.0.1:${port}/handoff/redeem`, { method: "POST", headers: { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" }, body: JSON.stringify({ token: grant.token }) });
      expect(redeemed.status).toBe(200);
      const cookie = redeemed.headers.get("set-cookie");
      expect(cookie).toContain("atelier_handoff_session=");
      expect(((await redeemed.json()) as { location: string }).location).toContain("/handoff/view/execution-1");
      const replay = await fetch(`http://127.0.0.1:${port}/handoff/redeem`, { method: "POST", headers: { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" }, body: JSON.stringify({ token: grant.token }) });
      expect(replay.status).toBe(400);
      const screenshot = await fetch(`http://127.0.0.1:${port}/handoff/api/execution-1/screenshot`, { headers: { cookie: cookie!.split(";")[0]! } });
      expect(screenshot.status).toBe(200);
      expect(screenshot.headers.get("content-type")).toContain("image/png");
      const csrfRejected = await fetch(`http://127.0.0.1:${port}/handoff/api/execution-1/control`, {
        method: "POST", headers: { cookie: cookie!.split(";")[0]!, "content-type": "application/json" }, body: JSON.stringify({ controlId: "verify-human" }),
      });
      expect(csrfRejected.status).toBe(403);
      const humanVerification = await fetch(`http://127.0.0.1:${port}/handoff/api/execution-1/control`, {
        method: "POST", headers: { origin: `http://127.0.0.1:${port}`, cookie: cookie!.split(";")[0]!, "content-type": "application/json" }, body: JSON.stringify({ controlId: "verify-human" }),
      });
      expect(humanVerification.status).toBe(204);
      expect(activated).toBe("verify-human");
      const submitRejected = await fetch(`http://127.0.0.1:${port}/handoff/api/execution-1/control`, {
        method: "POST", headers: { origin: `http://127.0.0.1:${port}`, cookie: cookie!.split(";")[0]!, "content-type": "application/json" }, body: JSON.stringify({ controlId: "submit" }),
      });
      expect(submitRejected.status).toBe(403);
    } finally {
      await viewer.close();
    }
  });
});
