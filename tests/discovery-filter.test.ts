/** @vitest-environment node */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { locationAllowed, screenDiscoveredJob } from "../application-agent/src/domain/discoveryFilter";
import { normalizeJobSearchIntent, type JobSearchIntent } from "../application-agent/src/domain/searchIntent";

const intent = normalizeJobSearchIntent(JSON.parse(readFileSync("application-agent/search-intent.example.json", "utf8")) as JobSearchIntent);
const job = (title: string, location = "Remote, United States", description = "Build reliable systems.", remoteStatus?: string) =>
  ({ title, location, description, ...(remoteStatus ? { remoteStatus } : {}) });

describe("discovery screening", () => {
  it("keeps in-lane, full-time, US-remote and Pittsburgh roles", () => {
    for (const [title, location] of [
      ["Platform Engineer (Early Career)", "United States"],
      ["DevOps Engineer", "Remote - US"],
      ["Full-Stack Software Engineer, Machine Learning Platform", "Pittsburgh, PA or Remote"],
      ["Software Engineer - Data & Automation", "Pittsburgh, PA"],
      ["Applied AI Engineer", "Remote (San Francisco)"],
      ["Frontend Engineer", "Remote"],
    ] as const) {
      expect(screenDiscoveredJob(job(title, location, "Build reliable systems.", location === "United States" ? "remote" : undefined), intent), `${title} / ${location}`).toEqual({ keep: true });
    }
  });

  it("drops senior, intern, contract, part-time, and off-lane roles", () => {
    expect(screenDiscoveredJob(job("Senior Software Engineer, Backend"), intent)).toEqual({ keep: false, reason: "seniority" });
    expect(screenDiscoveredJob(job("Engineering Intern – Gen AI Platform"), intent)).toEqual({ keep: false, reason: "seniority" });
    expect(screenDiscoveredJob(job("Cloud Engineer (Contract)"), intent)).toEqual({ keep: false, reason: "employment" });
    expect(screenDiscoveredJob(job("DevOps Engineer", "Remote, US", "This is a 12-month contract-to-hire role."), intent)).toEqual({ keep: false, reason: "employment" });
    expect(screenDiscoveredJob(job("Frontend Engineer", "Remote, US", "Part-time, 20 hours a week."), intent)).toEqual({ keep: false, reason: "employment" });
    expect(screenDiscoveredJob(job("Supply Chain Analyst - Data and Controls"), intent)).toEqual({ keep: false, reason: "role" });
    expect(screenDiscoveredJob(job("Electrical Engineer"), intent)).toEqual({ keep: false, reason: "role" });
  });

  it("hires-in-the-US rule: keeps US and US/Canada remote, drops Canada-only and other countries", () => {
    const allowed = (location: string, remoteStatus?: string) => locationAllowed({ location, ...(remoteStatus ? { remoteStatus } : {}) }, intent);
    expect(allowed("United States/Canada (Remote)")).toBe(true);
    expect(allowed("Remote US; Remote India")).toBe(true);
    expect(allowed("Remote — U.S., Canada, or Latin America")).toBe(true);
    expect(allowed("Remote, Ontario; Remote, British Columbia")).toBe(false);
    expect(allowed("Remote (Buenos Aires)")).toBe(false);
    expect(allowed("Germany", "remote")).toBe(false);
    expect(allowed("San Francisco, CA")).toBe(false);
    expect(allowed("Pittsburgh, PA")).toBe(true);
    // Allow-list: an unlisted country is never assumed to be US-remote.
    expect(allowed("Budapest, Hungary (Remote)")).toBe(false);
    expect(allowed("New York City (Remote)")).toBe(true);
    expect(allowed("Remote - Austin, TX")).toBe(true);
    expect(allowed("Flexible / Remote")).toBe(true);
  });

  it("allows Canada-only remote roles when the user lists Canada", () => {
    const withCanada = { ...intent, locations: [...intent.locations, "Canada"] };
    expect(locationAllowed({ location: "Remote, Ontario; Remote, British Columbia" }, withCanada)).toBe(true);
    expect(locationAllowed({ location: "Remote (Buenos Aires)" }, withCanada)).toBe(false);
  });
});

describe("state codes in remote locations", () => {
  it("reads an uppercase code as a US state but not the word 'or'", async () => {
    const { locationAllowed } = await import("../application-agent/src/domain/discoveryFilter");
    const intent = { locations: ["United States", "Pittsburgh, PA"], remotePreference: "remote_preferred" } as never;
    expect(locationAllowed({ location: "Canada - Remote (ON, AB, BC, or NS Only)", remoteStatus: "remote" } as never, intent)).toBe(false);
    expect(locationAllowed({ location: "Portland, OR (Remote)", remoteStatus: "remote" } as never, intent)).toBe(true);
  });
});
