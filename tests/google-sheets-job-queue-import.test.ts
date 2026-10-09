import { describe, expect, it } from "vitest";
import { GoogleSheetsJobQueue } from "../application-agent/automation/googleSheetsJobQueue";
import { importTrackerRowsToQueue } from "../application-agent/automation/googleSheetsJobQueueImport";
import type { GoogleSheetMetadata, GoogleSheetValueRange, GoogleSheetsApiTransport } from "../application-agent/automation/googleSheetsJobTracker";

const queueHeaders = ["Job ID", "Company", "Role", "Job Link", "Source Record ID", "Status", "Worker ID", "Lease Until", "Attempt ID", "Last Error", "Proof ID", "Confirmation Evidence", "Location", "Description/Notes", "Resume Version", "Priority", "Fit"];
const trackerHeaders = ["Company", "Role", "Job Link", "Source Record ID", "Status"];
class FakeTransport implements GoogleSheetsApiTransport {
  writes: GoogleSheetValueRange[] = [];
  reads = 0;
  constructor(public queueRows: unknown[][], public trackerRows: unknown[][]) {}
  async getSpreadsheetMetadata(): Promise<GoogleSheetMetadata> { return { spreadsheetId: "s", title: "Book", sheets: [{ title: "Application Queue", sheetId: 1 }, { title: "Job Tracker", sheetId: 2 }] }; }
  async getValues(_id: string, range: string): Promise<readonly (readonly unknown[])[]> { this.reads += 1; return range.includes("Job Tracker") ? this.trackerRows : this.queueRows; }
  async updateValues(_id: string, writes: readonly GoogleSheetValueRange[]): Promise<{ updatedCells: number }> { this.writes.push(...writes); for (const write of writes) { const match = write.range.match(/!([A-Z]+)(\d+)(?::([A-Z]+)\d+)?$/); if (!match) continue; let column = 0; for (const letter of match[1]!) column = column * 26 + letter.charCodeAt(0) - 64; const row = Number(match[2]) - 1; if (match[3]) this.queueRows[row] = [...write.values[0]!]; else (this.queueRows[row] ??= [])[column - 1] = write.values[0]?.[0]; } return { updatedCells: writes.length }; }
}
function make(queueRows: unknown[][], trackerRows: unknown[][]) { const transport = new FakeTransport(queueRows, trackerRows); return { transport, queue: new GoogleSheetsJobQueue({ spreadsheetId: "s", spreadsheetName: "Book", sheetTab: "Application Queue", timeoutMs: 1000 }, transport) }; }

describe("tracker to application queue import", () => {
  it("dry-runs pending rows, excludes terminal rows, and is duplicate-safe", async () => {
    const { queue, transport } = make([queueHeaders, ["tracker:old", "Acme", "Engineer", "https://boards.greenhouse.io/acme/jobs/1", "old", "Ready", "", "", "", "", "", ""]], [trackerHeaders, ["Acme", "Engineer", "https://boards.greenhouse.io/acme/jobs/1", "old", "Applied"], ["Beta", "Designer", "https://boards.greenhouse.io/beta/jobs/2", "new", "Discovered"]]);
    const result = await importTrackerRowsToQueue(queue, transport, "s", "Job Tracker", true);
    expect(result).toMatchObject({ considered: 2, promoted: 1, skippedTerminal: 1, skippedDuplicate: 0, dryRun: true });
    expect(transport.writes).toHaveLength(0);
  });

  it("writes only verified supported pending rows in explicit live mode", async () => {
    const { queue, transport } = make([queueHeaders], [["Company", "Role", "Job Link", "Source Record ID", "Status", "Location", "Description", "Resume Version"], ["Beta", "Designer", "https://boards.greenhouse.io/beta/jobs/2", "new", "Discovered", "Remote", "Useful posting notes", "frontend-software"]]);
    const result = await importTrackerRowsToQueue(queue, transport, "s", "Job Tracker", false);
    expect(result.promoted).toBe(1);
    expect(transport.writes).toHaveLength(1);
    expect(transport.queueRows[1]!.slice(0, 3)).toEqual(["tracker:new", "Beta", "Designer"]);
    expect(transport.queueRows[1]!.slice(12)).toEqual(["Remote", "Useful posting notes", "frontend-software", "", ""]);
  });

  it("fails closed for actionable rows with unsupported links", async () => {
    const { queue, transport } = make([queueHeaders], [trackerHeaders, ["Beta", "Designer", "not-a-url", "new", "Ready"]]);
    await expect(importTrackerRowsToQueue(queue, transport, "s", "Job Tracker", true)).rejects.toThrow(/unsupported/);
  });

  it("derives fallback identity from the canonical URL rather than row position", async () => {
    const first = make([queueHeaders], [trackerHeaders, ["Beta", "Designer", "https://boards.greenhouse.io/beta/jobs/2", "", "Ready"]]);
    const one = await importTrackerRowsToQueue(first.queue, first.transport, "s", "Job Tracker", true);
    const reordered = make([queueHeaders], [trackerHeaders, ["Other", "Engineer", "https://boards.greenhouse.io/other/jobs/3", "", "Ready"], ["Beta", "Designer", "https://boards.greenhouse.io/beta/jobs/2", "", "Ready"]]);
    const two = await importTrackerRowsToQueue(reordered.queue, reordered.transport, "s", "Job Tracker", true);
    expect(two.jobIds).toContain(one.jobIds[0]);
  });

  it("enriches an existing queue row without creating a duplicate", async () => {
    const existing = ["tracker:new", "Beta", "Designer", "https://boards.greenhouse.io/beta/jobs/2", "new", "Ready", "", "", "", "", "", "", "", "", "", "", ""];
    const { queue, transport } = make([queueHeaders, existing], [["Company", "Role", "Job Link", "Source Record ID", "Status", "Location", "Description", "Resume Version"], ["Beta", "Designer", "https://boards.greenhouse.io/beta/jobs/2", "new", "Ready", "Remote", "Grounded notes", "frontend-software"]]);
    const result = await importTrackerRowsToQueue(queue, transport, "s", "Job Tracker", false);
    expect(result).toMatchObject({ promoted: 0, enriched: 1 });
    expect((await queue.get("tracker:new")).location).toBe("Remote");
  });

  it("does not retry a blocked queue row after the tracker becomes terminal", async () => {
    const existing = ["tracker:applied", "Beta", "Designer", "https://boards.greenhouse.io/beta/jobs/2", "applied", "Needs Input", "worker", "", "attempt", "browser blocker", "", "", "", "", "", "", ""];
    const { queue, transport } = make([queueHeaders, existing], [trackerHeaders, ["Beta", "Designer", "https://boards.greenhouse.io/beta/jobs/2", "applied", "Applied"]]);
    const result = await importTrackerRowsToQueue(queue, transport, "s", "Job Tracker", false);
    expect(result.reconciledTerminal).toBe(1);
    await expect(queue.get("tracker:applied")).resolves.toMatchObject({ status: "Skipped", lastError: expect.stringContaining("already Applied") });
  });

  it("reopens an active route-blocked row once, but leaves policy skips terminal", async () => {
    const routeBlocked = ["tracker:route", "Beta", "Designer", "https://www.indeed.com/viewjob?jk=abc", "route", "Skipped", "worker", "", "attempt", "Skipped — this listing is not an executable verified Lever, Greenhouse, Rippling, Ashby, Workday, YouHired, Matlen Silver, Protagona, or Gusto application route.", "", "", "", "", "", ""];
    const policyBlocked = ["tracker:policy", "Gamma", "Engineer", "https://boards.greenhouse.io/gamma/jobs/3", "policy", "Skipped", "", "", "", "Skipped — contract, 1099, or task-based work is excluded by candidate policy.", "", "", "", "", "", ""];
    const trackerRows = [trackerHeaders, ["Beta", "Designer", routeBlocked[3], "route", "Researching"], ["Gamma", "Engineer", policyBlocked[3], "policy", "Researching"]];
    const { queue, transport } = make([queueHeaders, routeBlocked, policyBlocked], trackerRows);
    const first = await importTrackerRowsToQueue(queue, transport, "s", "Job Tracker", false);
    expect(first).toMatchObject({ reopened: 1, skippedAppliedDuplicate: 0 });
    await expect(queue.get("tracker:route")).resolves.toMatchObject({ status: "Ready", lastError: expect.stringContaining("queue-destination-input") });
    await expect(queue.get("tracker:policy")).resolves.toMatchObject({ status: "Skipped" });
    const second = await importTrackerRowsToQueue(queue, transport, "s", "Job Tracker", false);
    expect(second.reopened).toBe(0);
  });

  it("does not reopen an active duplicate when another tracker row is already applied", async () => {
    const existing = ["tracker:sidekick", "Sidekick Solutions", "Cloud Engineer", "https://www.indeed.com/viewjob?jk=abc", "sidekick", "Skipped", "worker", "", "attempt", "Skipped — this listing is not an executable verified application route.", "", "", "", "", "", ""];
    const trackerRows = [trackerHeaders,
      ["Sidekick Solutions", "Cloud Engineer", existing[3], "sidekick", "Researching"],
      ["Sidekick Solutions LLC", "Cloud Engineer", "https://jobs.gusto.com/postings/sidekick-solutions-llc-cloud-engineer-ac0d6b2b-36c5-4bad-a8d2-91b69546d4ad", "gusto:sidekick", "Applied"]];
    const { queue, transport } = make([queueHeaders, existing], trackerRows);
    const result = await importTrackerRowsToQueue(queue, transport, "s", "Job Tracker", false);
    expect(result.skippedAppliedDuplicate).toBe(1);
    await expect(queue.get("tracker:sidekick")).resolves.toMatchObject({ status: "Skipped", lastError: expect.stringContaining("another Job Tracker row") });
  });

  it("updates a queue route when the tracker supplies a replacement application URL", async () => {
    const oldLink = "https://www.indeed.com/viewjob?jk=abc";
    const newLink = "https://boards.greenhouse.io/beta/jobs/42";
    const existing = ["tracker:route", "Beta", "Designer", oldLink, "route", "Needs Input", "", "", "", "[queue-destination-input] Needs Input — update the route", "", "", "", "", "", ""];
    const { queue, transport } = make([queueHeaders, existing], [trackerHeaders, ["Beta", "Designer", newLink, "route", "Researching"]]);
    const result = await importTrackerRowsToQueue(queue, transport, "s", "Job Tracker", false);
    expect(result).toMatchObject({ updatedSource: 1, reopened: 1 });
    await expect(queue.get("tracker:route")).resolves.toMatchObject({ status: "Ready", jobLink: newLink });
  });

  it("bulk-enriches many existing rows with constant read overhead", async () => {
    const queueRows = [queueHeaders, ...Array.from({ length: 40 }, (_, index) => [`tracker:${index}`, "Acme", "Engineer", `https://boards.greenhouse.io/acme/jobs/${index + 1}`, `source:${index}`, "Ready", "", "", "", "", "", "", "", "", "", "", ""])];
    const trackerRows = [["Company", "Role", "Job Link", "Source Record ID", "Status", "Location", "Description", "Resume Version"], ...Array.from({ length: 40 }, (_, index) => ["Acme", "Engineer", `https://boards.greenhouse.io/acme/jobs/${index + 1}`, `source:${index}`, "Ready", "Remote", `Notes ${index}`, "frontend-software"])];
    const { queue, transport } = make(queueRows, trackerRows);
    const result = await importTrackerRowsToQueue(queue, transport, "s", "Job Tracker", false);
    expect(result.enriched).toBe(40);
    expect(transport.reads).toBeLessThanOrEqual(4);
  });
});
