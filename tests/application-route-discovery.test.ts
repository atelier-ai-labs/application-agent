/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";
import { PlaywrightApplicationRouteDiscoverer } from "../application-agent/automation/applicationRouteDiscovery";
import type { LeverBrowserSession, LeverBrowserSessionFactory } from "../application-agent/src/domain/executor";

function session(overrides: Partial<LeverBrowserSession> = {}): LeverBrowserSession {
  return {
    navigate: vi.fn(async () => undefined),
    currentUrl: vi.fn(() => "https://listing.example/jobs/1"),
    inspectFields: vi.fn(async () => []),
    detectHumanBoundary: vi.fn(async () => null),
    hasSubmitControl: vi.fn(async () => false),
    submit: vi.fn(async () => ({ clicked: false, confirmed: false, evidence: "submit:not-clicked" })),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("bounded application route discovery", () => {
  it("opens the public listing, delegates the bounded Apply click, and closes the session", async () => {
    const browserSession = session({
      discoverApplicationRoute: vi.fn(async () => ({
        status: "resolved" as const,
        applicationUrl: "https://jobs.lever.co/acme/job-1/apply",
        evidence: ["listing-identity:verified", "apply:clicked"],
      })),
    });
    const factory: LeverBrowserSessionFactory = { open: vi.fn(async () => browserSession) };
    const discoverer = new PlaywrightApplicationRouteDiscoverer(factory);

    await expect(discoverer.discover({
      jobId: "job-1",
      company: "Acme",
      role: "Engineer",
      sourceUrl: "https://listing.example/jobs/1",
    })).resolves.toMatchObject({ status: "resolved", applicationUrl: "https://jobs.lever.co/acme/job-1/apply" });
    expect(factory.open).toHaveBeenCalledWith("route-discovery:job-1");
    expect(browserSession.navigate).toHaveBeenCalledWith("https://listing.example/jobs/1");
    expect(browserSession.discoverApplicationRoute).toHaveBeenCalledWith("Acme", "Engineer");
    expect(browserSession.close).toHaveBeenCalledTimes(1);
  });

  it("converts a stale listing observation into a blocked result without clicking", async () => {
    const browserSession = session({
      detectUnavailablePage: vi.fn(async () => ({ reasonCode: "posting_closed" as const, evidence: ["posting:closed"] })),
      discoverApplicationRoute: vi.fn(),
    });
    const factory: LeverBrowserSessionFactory = { open: vi.fn(async () => browserSession) };
    const result = await new PlaywrightApplicationRouteDiscoverer(factory).discover({
      jobId: "job-closed",
      company: "Acme",
      role: "Engineer",
      sourceUrl: "https://listing.example/jobs/closed",
    });
    expect(result).toMatchObject({ status: "blocked", evidence: ["posting:closed", "apply:not-clicked"] });
    expect(browserSession.discoverApplicationRoute).not.toHaveBeenCalled();
    expect(browserSession.close).toHaveBeenCalledTimes(1);
  });
});
