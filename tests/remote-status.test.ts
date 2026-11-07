import { describe, expect, it } from "vitest";
import { inferRemoteStatus } from "../application-agent/src/domain/job";
import { parseAshbyBoardResponse } from "../application-agent/src/domain/ashbyBoardSource";

describe("remote, hybrid or on-site", () => {
  it("reads the location first, and an office location needs clear remote wording", () => {
    // Chime, 2026-11-06: office location, remote mentioned, office days required.
    expect(inferRemoteStatus("We offer flexibility... remote benefits. This role requires 3 days a week in the office.", "San Francisco, CA, USA")).toBe("hybrid");
    // PlanetScale: in-office, relocation offered; a passing "remote" is not enough.
    expect(inferRemoteStatus("This is an in-office role in San Francisco. We support relocation. Our remote colleagues...", "San Francisco Office")).not.toBe("remote");
    // Figma-style: hubs listed, but the role can be held remotely in the US.
    expect(inferRemoteStatus("This role can be held from one of our US hubs or remotely in the United States.", "San Francisco, CA • New York, NY • United States")).toBe("remote");
    expect(inferRemoteStatus("Anything at all.", "Remote - United States")).toBe("remote");
    expect(inferRemoteStatus("Anything.", "New York (Hybrid)")).toBe("hybrid");
    expect(inferRemoteStatus("Remote status: remote\nWe have offices.", "United States")).toBe("remote");
    // No location at all: a remote mention still counts, as before.
    expect(inferRemoteStatus("Fully distributed team, remote.", undefined)).toBe("remote");
  });
});

describe("Ashby workplace type", () => {
  it("does not call a Hybrid job remote because of isRemote, but keeps a listed remote location", async () => {
    const { normalizeJobPosting } = await import("../application-agent/src/domain/job");
    const job = (overrides: Record<string, unknown>) => ({ id: "0f6b7a70-0000-4000-8000-000000000001", title: "Software Engineer, Growth", isListed: true, descriptionPlain: "Build growth features for our product with the team.", ...overrides });
    const statusOf = (overrides: Record<string, unknown>) => {
      const listing = parseAshbyBoardResponse({ jobs: [job(overrides)] }, "notion", {} as never, "2026-11-07T00:00:00Z", 50, "Notion").listings[0]!;
      return normalizeJobPosting(listing.input, "2026-11-07T00:00:00Z").remoteStatus;
    };
    // Notion / Replit: workplaceType Hybrid, isRemote true, office locations only.
    expect(statusOf({ workplaceType: "Hybrid", isRemote: true, location: "San Francisco, California", secondaryLocations: [{ location: "New York, New York" }] })).toBe("hybrid");
    // Ramp: Hybrid HQ, with a "Remote (US)" location listed beside it.
    expect(statusOf({ workplaceType: "Hybrid", isRemote: true, location: "New York, NY (HQ)", secondaryLocations: [{ location: "Remote (US)" }] })).toBe("remote");
    expect(statusOf({ workplaceType: "Remote", isRemote: true, location: "United States (Remote)" })).toBe("remote");
  });
});
