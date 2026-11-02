/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { MuseJobSource, museLevels, museLocations, parseMuseResponse } from "../application-agent/src/domain/museJobSource";
import type { JobSearchIntent } from "../application-agent/src/domain/searchIntent";
import type { SearchCriteria } from "../application-agent/src/domain/campaignTypes";

const capturedAt = "2026-11-02T12:00:00.000Z";
const intent = {
  primaryLanes: ["Software Engineer"], adjacentLanes: [], secondaryLanes: [], preferredSeniorities: ["junior", "mid-level"],
  excludedSeniorities: [], excludedTitleTerms: [], locations: ["United States", "Pittsburgh, PA"], remotePreference: "remote_preferred", breadth: "balanced",
} as JobSearchIntent;

const result = (id: number, name: string, location: string, published = "2026-10-25T00:00:00Z") => ({
  id, name, publication_date: published, contents: "<p>Build <b>automation</b> for the bank.</p>",
  company: { name: "PNC" }, locations: [{ name: location }], levels: [{ name: "Mid Level" }],
  refs: { landing_page: `https://www.themuse.com/jobs/pnc/${id}` },
});

describe("The Muse discovery", () => {
  it("searches each configured city plus remote, at the intent's levels", () => {
    expect(museLocations(intent, {} as SearchCriteria)).toEqual(["Pittsburgh, PA", "Flexible / Remote"]);
    expect(museLevels(intent)).toEqual(["Entry Level", "Mid Level"]);
    expect(museLocations({ ...intent, remotePreference: "any" }, {} as SearchCriteria)).toEqual(["Pittsburgh, PA"]);
  });

  it("keeps fresh postings whose title matches a search term, as discoverable-only Muse links", () => {
    const payload = { page_count: 1, results: [
      result(1, "Software Engineer - Data & Automation", "Pittsburgh, PA"),
      result(2, "Tire and Battery Service Advisor", "Pittsburgh, PA"),
      result(3, "Software Engineer II", "Flexible / Remote", "2025-04-16T23:31:33Z"),
    ] };
    const { listings } = parseMuseResponse(payload, ["Software Engineer"], capturedAt, 60);
    expect(listings.map((listing) => listing.input.titleHint)).toEqual(["Software Engineer - Data & Automation"]);
    expect(listings[0]!.input.rawText).toContain("Location: Pittsburgh, PA");
    expect(listings[0]!.input.rawText).toContain("Build automation for the bank.");
    expect(listings[0]!.sourceRecordId).toBe("themuse:1");
    expect(new MuseJobSource().classifyActionability()).toBe("discoverable_only");
  });

  it("requests each location with categories and levels, de-duplicating across pages", async () => {
    const urls: string[] = [];
    const source = new MuseJobSource({
      pagesPerLocation: 2,
      fetcher: async (url) => {
        urls.push(url);
        return { ok: true, status: 200, json: async () => ({ page_count: 2, results: [result(7, "Software Engineer", "Pittsburgh, PA")] }) };
      },
    });
    const batch = await source.discover({ searchQueries: ["Software Engineer"] } as unknown as SearchCriteria, { now: capturedAt, maxResults: 10, searchIntent: intent });
    expect(batch.listings).toHaveLength(1);
    expect(urls).toHaveLength(4);
    const first = new URL(urls[0]!);
    expect(first.searchParams.getAll("location")).toEqual(["Pittsburgh, PA"]);
    expect(first.searchParams.getAll("level")).toEqual(["Entry Level", "Mid Level"]);
    expect(first.searchParams.getAll("category")).toContain("Software Engineering");
  });
});
