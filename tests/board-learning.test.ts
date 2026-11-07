/** @vitest-environment node */
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { learnBoardsFromFeeds, loadLearnedBoards, saveLearnedBoards, type LearnedBoards } from "../application-agent/automation/boardLearning";
import type { ScoutedJob } from "../application-agent/src/domain/scout";

const now = new Date("2026-11-07T02:00:00Z");
const scouted = (company: string, title: string, sourceId: string): ScoutedJob => ({
  sourceId, sourceMode: "live", actionability: "discoverable_only", isExample: false, discoveredAt: now.toISOString(), fingerprint: company, dedupeKeys: [], sourceObservations: [],
  job: { company, title, sourceUrl: `https://remotive.com/jobs/${company}`, description: "", requiredSkills: [], preferredSkills: [], capturedAt: now.toISOString() } as never,
});

describe("learning employer boards from feed companies", () => {
  it("adds a company's board when it lists the role the feed showed, and remembers who was checked", async () => {
    const learned: LearnedBoards = { greenhouse: [], lever: [], ashby: [], checked: { "old co": "2026-11-01T00:00:00Z" } };
    const asked: string[] = [];
    const result = await learnBoardsFromFeeds({
      jobs: [
        scouted("SmartAsset", "Software Engineer", "remotive"),
        scouted("SmartAsset", "Data Engineer", "himalayas-live"),    // same company: looked up once
        scouted("Nowhere Inc", "DevOps Engineer", "themuse-live"),    // no board found
        scouted("Old Co", "Cloud Engineer", "remotive"),              // checked 6 days ago: skipped
        scouted("Arize AI", "Applied AI Engineer", "remotive"),       // already a board source below
        scouted("Arize AI", "DevOps Engineer", "greenhouse:arizeai"),
        scouted("Known Ltd", "Platform Engineer", "remotive"),        // its board is already configured
      ],
      known: new Set(["ashby:knownltd"]),
      learned,
      now,
      resolve: async ({ company }) => {
        asked.push(company);
        if (company === "SmartAsset") return { status: "resolved", url: "https://job-boards.greenhouse.io/smartasset/jobs/1", provider: "greenhouse", board: "smartasset", postingTitle: "Software Engineer" };
        if (company === "Known Ltd") return { status: "resolved", url: "https://jobs.ashbyhq.com/knownltd/x", provider: "ashby", board: "KnownLtd", postingTitle: "Platform Engineer" };
        return { status: "not_found", reason: "none" };
      },
    });
    expect(asked).toEqual(["SmartAsset", "Nowhere Inc", "Known Ltd"]);
    expect(result).toEqual({ probed: 3, learned: [{ company: "SmartAsset", provider: "greenhouse", slug: "smartasset" }] });
    expect(learned.greenhouse).toEqual(["smartasset"]);
    expect(Object.keys(learned.checked).sort()).toEqual(["known ltd", "nowhere inc", "old co", "smartasset"]);
    // Nowhere Inc is not looked up again tomorrow.
    const again = await learnBoardsFromFeeds({ jobs: [scouted("Nowhere Inc", "DevOps Engineer", "remotive")], known: new Set(), learned, now: new Date("2026-11-08T02:00:00Z"), resolve: async () => { throw new Error("should not be asked"); } });
    expect(again.probed).toBe(0);
  });

  it("round-trips the learned file and ignores malformed board names", () => {
    const file = join(mkdtempSync(join(tmpdir(), "boards-")), "learned.json");
    saveLearnedBoards({ greenhouse: ["gitlab", "bad name!"], lever: ["palantir"], ashby: [], checked: { gitlab: now.toISOString() } }, file);
    expect(JSON.parse(readFileSync(file, "utf8")).greenhouse).toHaveLength(2);
    expect(loadLearnedBoards(file)).toEqual({ greenhouse: ["gitlab"], lever: ["palantir"], ashby: [], checked: { gitlab: now.toISOString() } });
    expect(loadLearnedBoards(join(tmpdir(), "missing-learned.json"))).toEqual({ greenhouse: [], lever: [], ashby: [], checked: {} });
  });
});
