/** @vitest-environment node */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { discoverJobsToTracker, postingLinkKey } from "../application-agent/automation/discoverJobs";
import { normalizeJobPosting } from "../application-agent/src/domain/job";
import { normalizeJobSearchIntent, type JobSearchIntent } from "../application-agent/src/domain/searchIntent";
import { exampleCandidateProfile } from "../application-agent/src";
import type { GoogleSheetMetadata, GoogleSheetsApiTransport, GoogleSheetValueRange } from "../application-agent/automation/googleSheetsJobTracker";
import type { ScoutedJob } from "../application-agent/src/domain/scout";

const now = "2026-11-02T15:00:00.000Z";
const intent = normalizeJobSearchIntent(JSON.parse(readFileSync("application-agent/search-intent.example.json", "utf8")) as JobSearchIntent);
const headers = ["Company", "Role", "Job Link", "Location / Remote", "Salary Min", "Salary Max", "Fit", "Priority", "Status", "Date Found", "Date Applied", "Follow-Up Date", "Contact / Referral", "Resume Version", "Next Step", "Notes"];

class Tracker implements GoogleSheetsApiTransport {
  writes: GoogleSheetValueRange[] = [];
  constructor(public rows: unknown[][]) {}
  async getSpreadsheetMetadata(): Promise<GoogleSheetMetadata> { return { spreadsheetId: "s", title: "T", sheets: [{ title: "Job Tracker", sheetId: 1 }] }; }
  async getValues(): Promise<readonly (readonly unknown[])[]> { return this.rows; }
  async updateValues(_id: string, data: readonly GoogleSheetValueRange[]): Promise<{ updatedCells: number }> { this.writes.push(...data); return { updatedCells: 1 }; }
}

function scouted(company: string, title: string, location: string, links: { sourceUrl: string; applicationUrl?: string }, actionability: ScoutedJob["actionability"], sourceId: string): ScoutedJob {
  const job = normalizeJobPosting({
    companyHint: company, titleHint: title, ...links,
    rawText: `${company}\n${title}\nLocation: ${location}\n\nBuild and operate cloud infrastructure with AWS, Azure, Docker, Terraform, and CI/CD on a DevOps team.`,
  }, now);
  return { sourceId, sourceMode: "live", actionability, isExample: false, job, discoveredAt: now, fingerprint: `${company}|${title}`, dedupeKeys: [], sourceObservations: [] };
}

const jobs = [
  scouted("Monogram Health", "DevOps Engineer", "Remote, United States", { sourceUrl: "https://job-boards.greenhouse.io/monogram/jobs/101", applicationUrl: "https://job-boards.greenhouse.io/monogram/jobs/101" }, "actionable", "greenhouse:monogram"),
  scouted("PNC", "Cloud Engineer", "Pittsburgh, PA", { sourceUrl: "https://www.themuse.com/jobs/pnc/cloud-engineer" }, "discoverable_only", "themuse-live"),
  scouted("Faraway", "DevOps Engineer", "Remote, Ontario", { sourceUrl: "https://jobs.lever.co/faraway/1" }, "actionable", "lever:faraway"),
  scouted("Known Co", "Platform Engineer", "Remote, US", { sourceUrl: "https://job-boards.greenhouse.io/known/jobs/5" }, "actionable", "greenhouse:known"),
  scouted("Nolink Inc", "Cloud Engineer", "Remote, US", { sourceUrl: "https://himalayas.app/companies/nolink/jobs/cloud" }, "discoverable_only", "himalayas-live"),
];

function run(tracker: Tracker, apply: boolean) {
  return discoverJobsToTracker({
    scout: { discover: async () => ({ jobs, failures: [], sourceSummaries: [], startedAt: now, completedAt: now, receivedCount: jobs.length, normalizedCount: jobs.length, duplicateCount: 0 }) },
    campaignInput: { name: "t", goal: "t", searchSources: [] } as never,
    intent, profile: exampleCandidateProfile, transport: tracker, spreadsheetId: "s", trackerTab: "Job Tracker", apply, now: () => now,
    resolveLink: async ({ company }) => company === "PNC"
      ? { status: "resolved", url: "https://pnc.wd5.myworkdayjobs.com/External/job/Pittsburgh/Cloud-Engineer_R1/apply", provider: "greenhouse", board: "pnc", postingTitle: "Cloud Engineer" }
      : { status: "not_found", reason: "none" },
  });
}

describe("career-agent discover", () => {
  it("treats another spelling of a tracked link as the same posting", async () => {
    // Span was added twice: the tracker had /span.app/<id>, the board returned /Span.app/<id>/application.
    expect(postingLinkKey("https://jobs.ashbyhq.com/Span.app/0709/application")).toBe(postingLinkKey("https://jobs.ashbyhq.com/span.app/0709"));
    expect(postingLinkKey("https://www.example.com/jobs/1/?utm=x#top")).toBe(postingLinkKey("http://example.com/jobs/1"));
    expect(postingLinkKey("https://jobs.ashbyhq.com/span.app/0709")).not.toBe(postingLinkKey("https://jobs.ashbyhq.com/span.app/0710"));
    const tracker = new Tracker([headers, ["Known Company", "Platform Eng", "HTTPS://Job-Boards.Greenhouse.io/known/jobs/5/", "", "", "", "", "", "Researching"]]);
    const { decisions } = await run(tracker, false);
    expect(decisions).toContainEqual({ action: "skip", company: "Known Co", role: "Platform Engineer", reason: "in tracker" });
  });


  it("reports new jobs on a dry run without writing", async () => {
    const tracker = new Tracker([headers, ["Known Co", "Platform Engineer", "https://job-boards.greenhouse.io/known/jobs/5", "", "", "", "", "", "Researching"]]);
    const { decisions, written } = await run(tracker, false);
    expect(written).toBe(0);
    expect(tracker.writes).toHaveLength(0);
    expect(decisions.filter((decision) => decision.action === "add").map((decision) => decision.company)).toEqual(["Monogram Health", "PNC"]);
    expect(decisions).toEqual(expect.arrayContaining([
      { action: "skip", company: "Faraway", role: "DevOps Engineer", reason: "location" },
      { action: "skip", company: "Known Co", role: "Platform Engineer", reason: "in tracker" },
      { action: "skip", company: "Nolink Inc", role: "Cloud Engineer", reason: "no direct link" },
    ]));
  });

  it("appends Researching rows with a direct link, fit, and resume version", async () => {
    const tracker = new Tracker([headers]);
    const { written } = await run(tracker, true);
    // Known Co is new here: this tracker starts empty.
    expect(written).toBe(3);
    const [write] = tracker.writes;
    expect(write!.range).toBe("'Job Tracker'!A2:P4");
    const pnc = write!.values[1]!;
    expect(pnc[0]).toBe("PNC");
    expect(pnc[2]).toBe("https://pnc.wd5.myworkdayjobs.com/External/job/Pittsburgh/Cloud-Engineer_R1/apply");
    expect(pnc[8]).toBe("Researching");
    expect(pnc[9]).toBe("11/02/2026");
    expect(pnc[13]).toBeTruthy();
    expect(String(pnc[15])).toContain("themuse-live");
  });
});
