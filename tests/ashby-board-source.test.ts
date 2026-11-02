/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { AshbyBoardSource, parseAshbyBoardResponse } from "../application-agent/src/domain/ashbyBoardSource";
import type { SearchCriteria } from "../application-agent/src/domain/campaignTypes";

const capturedAt = "2026-11-02T12:00:00.000Z";
const criteria = { searchQueries: ["Software Engineer"] } as unknown as SearchCriteria;

const payload = {
  jobs: [
    {
      id: "11111111-2222-3333-4444-555555555555", title: "Software Engineer, Platform", department: "Engineering",
      location: "Pittsburgh, PA", secondaryLocations: [{ location: "Remote - US" }], employmentType: "FullTime", isRemote: true,
      isListed: true, publishedAt: "2026-10-30T10:00:00.000Z", descriptionPlain: "Build the platform that clinicians rely on every day.",
      jobUrl: "https://jobs.ashbyhq.com/abridge/11111111-2222-3333-4444-555555555555",
      applyUrl: "https://jobs.ashbyhq.com/abridge/11111111-2222-3333-4444-555555555555/application",
    },
    { id: "unlisted", title: "Software Engineer, Hidden", isListed: false },
    { id: "66666666-7777-8888-9999-000000000000", title: "Account Executive", location: "New York", isListed: true, descriptionPlain: "Sell to health systems." },
  ],
};

describe("Ashby board discovery", () => {
  it("keeps listed postings that match the search terms, with direct Ashby links", () => {
    const batch = parseAshbyBoardResponse(payload, "abridge", criteria, capturedAt, 50, "Abridge");
    expect(batch.listings).toHaveLength(1);
    const [listing] = batch.listings;
    expect(listing!.input).toMatchObject({
      companyHint: "Abridge",
      titleHint: "Software Engineer, Platform",
      applicationUrl: "https://jobs.ashbyhq.com/abridge/11111111-2222-3333-4444-555555555555/application",
    });
    expect(listing!.input.rawText).toContain("Location: Pittsburgh, PA; Remote - US (Remote)");
    expect(listing!.input.rawText).toContain("Employment type: FullTime");
    expect(listing!.sourcePublishedAt).toBe("2026-10-30T10:00:00.000Z");
  });

  it("returns every listed posting when no search terms are given", () => {
    const batch = parseAshbyBoardResponse(payload, "abridge", {} as SearchCriteria, capturedAt, 50);
    expect(batch.listings.map((listing) => listing.input.titleHint)).toEqual(["Software Engineer, Platform", "Account Executive"]);
    expect(batch.listings[1]!.input.companyHint).toBe("Abridge");
  });

  it("calls the public board API and reports HTTP failures", async () => {
    const urls: string[] = [];
    const ok = new AshbyBoardSource({ board: "abridge", fetcher: async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => payload }; } });
    await expect(ok.discover(criteria, { now: capturedAt, maxResults: 10 })).resolves.toMatchObject({ listings: [expect.anything()] });
    expect(urls).toEqual(["https://api.ashbyhq.com/posting-api/job-board/abridge"]);

    const failing = new AshbyBoardSource({ board: "abridge", fetcher: async () => ({ ok: false, status: 429, json: async () => ({}) }) });
    await expect(failing.discover(criteria)).rejects.toThrow("HTTP 429 (rate limited)");
    expect(() => new AshbyBoardSource({ board: "../etc" })).toThrow("Invalid Ashby board name");
  });
});
