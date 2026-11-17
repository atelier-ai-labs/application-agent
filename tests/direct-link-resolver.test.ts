/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import {
  boardLinksInPage,
  companySlugCandidates,
  sameCompany,
  resolveDirectPostingLink,
  titleMatchesRole,
  type DirectLinkFetcher,
} from "../application-agent/automation/directLinkResolver";
import { resolveTrackerLinks } from "../application-agent/automation/resolveTrackerLinksCli";
import { GoogleSheetsJobQueue } from "../application-agent/automation/googleSheetsJobQueue";
import type { GoogleSheetMetadata, GoogleSheetsApiTransport, GoogleSheetValueRange } from "../application-agent/automation/googleSheetsJobTracker";

function boards(responses: Record<string, unknown>): DirectLinkFetcher {
  return async (url) => {
    const body = responses[url];
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body };
  };
}

const GH = "https://boards-api.greenhouse.io/v1/boards";

describe("direct posting link resolver", () => {
  it("reads the employer's posting off a job-board page and trusts it only when the board confirms the role", async () => {
    const page = `<a href="https://job-boards.greenhouse.io/defenseunicorns/jobs/5227539007?gh_src=nogig">Apply</a>
      <script>{"similar":"https:\\/\\/jobs.ashbyhq.com\\/othercorp\\/0f6b7a70-0000-4000-8000-000000000001"}</script>`;
    expect(boardLinksInPage(page)).toEqual([
      { provider: "greenhouse", slug: "defenseunicorns", id: "5227539007" },
      { provider: "ashby", slug: "othercorp", id: "0f6b7a70-0000-4000-8000-000000000001" },
    ]);
    // Six "Platform Engineer" listings make the name guess ambiguous; the page names the exact one.
    const listings = Array.from({ length: 6 }, (_, index) => ({ id: 5227539000 + index, title: "Platform Engineer", location: { name: "Remote, US" } }));
    listings[5] = { id: 5227539007, title: "Platform Engineer", location: { name: "Remote - US" } };
    const fetcher = boards({ [`${GH}/defenseunicorns`]: { name: "Defense Unicorns" }, [`${GH}/defenseunicorns/jobs`]: { jobs: listings } });
    const fromPage = await resolveDirectPostingLink({ company: "Defense Unicorns", role: "Platform Engineer", listingUrl: "https://www.nogigiddy.com/jobs/x" }, fetcher, async () => page);
    expect(fromPage).toMatchObject({ status: "resolved", url: "https://job-boards.greenhouse.io/defenseunicorns/jobs/5227539007" });
    expect(await resolveDirectPostingLink({ company: "Defense Unicorns", role: "Platform Engineer" }, fetcher, async () => page)).toMatchObject({ status: "ambiguous" });
    // A link on the page to some other company's board, or to a different role, is not used.
    const other = await resolveDirectPostingLink({ company: "Sourcegraph", role: "Agent Engineer", listingUrl: "https://www.remoteworkusa.com/job/x" }, boards({
      "https://api.ashbyhq.com/posting-api/job-board/othercorp": { jobs: [{ id: "0f6b7a70-0000-4000-8000-000000000001", title: "Agent Engineer" }] },
    }), async () => page);
    expect(other.status).toBe("not_found");
    const onSite = await resolveDirectPostingLink({ company: "Defense Unicorns", role: "Platform Engineer", listingUrl: "https://x.invalid" }, boards({
      [`${GH}/defenseunicorns`]: { name: "Defense Unicorns" }, [`${GH}/defenseunicorns/jobs`]: { jobs: [{ ...listings[5], location: { name: "San Antonio, Texas" } }] },
    }), async () => page);
    expect(onSite).toMatchObject({ status: "not_found", reason: expect.stringMatching(/on-site in San Antonio/) });
    const wrongRole = await resolveDirectPostingLink({ company: "Defense Unicorns", role: "Site Reliability Engineer", listingUrl: "https://x.invalid" }, fetcher, async () => page);
    expect(wrongRole.status).toBe("not_found");
  });

  it("derives a few deterministic board slugs from a company name", () => {
    expect(companySlugCandidates("Defense Unicorns")).toEqual(["defenseunicorns", "defense-unicorns"]);
    expect(companySlugCandidates("Sidekick Solutions LLC")).toEqual(["sidekicksolutions", "sidekick-solutions"]);
    expect(companySlugCandidates("FullThrottle.ai")).toContain("fullthrottle");
  });

  it("matches the role without accepting an unrequested seniority level", () => {
    expect(titleMatchesRole("Platform Engineer ", "Platform Engineer")).toBe(true);
    expect(titleMatchesRole("Platform Engineer (FedD145)", "Platform Engineer")).toBe(true);
    expect(titleMatchesRole("Senior Platform Engineer", "Platform Engineer")).toBe(false);
    expect(titleMatchesRole("SkillBridge Intern - Platform Engineer", "Platform Engineer")).toBe(false);
    expect(titleMatchesRole("Platform Engineer", "Platform Engineer, Kubernetes")).toBe(false);
  });

  it("prefers the single exact US-remote posting over title variants", async () => {
    const result = await resolveDirectPostingLink({ company: "Defense Unicorns", role: "Platform Engineer" }, boards({
      [`${GH}/defenseunicorns`]: { name: "Defense Unicorns" },
      [`${GH}/defenseunicorns/jobs`]: { jobs: [
        { id: 1, title: "Platform Engineer", location: { name: "San Antonio, Texas" } },
        { id: 2, title: "Platform Engineer", location: { name: "San Antonio, Texas" } },
        { id: 3, title: "Platform Engineer ", location: { name: "Remote, United States" } },
        { id: 4, title: "Platform Engineer (FedD145)", location: { name: "Remote, United States" } },
        { id: 5, title: "Senior Platform Engineer", location: { name: "Remote" } },
      ] },
    }));
    expect(result).toMatchObject({ status: "resolved", provider: "greenhouse", url: "https://job-boards.greenhouse.io/defenseunicorns/jobs/3" });
  });

  it("accepts only the same employer name, allowing one generic extra word", () => {
    expect(sameCompany("Sidekick Solutions LLC", "Sidekick Solutions")).toBe(true);
    expect(sameCompany("Acme Labs", "Acme")).toBe(true);
    expect(sameCompany("Acme Widgets Europe", "Acme")).toBe(false);
    expect(sameCompany("Torc Robotics", "Torc")).toBe(false);
  });

  it("does not trust a Greenhouse board whose company name differs", async () => {
    const result = await resolveDirectPostingLink({ company: "Acme", role: "Platform Engineer" }, boards({
      [`${GH}/acme`]: { name: "Acme Widgets Europe Holdings Different" },
      [`${GH}/acme/jobs`]: { jobs: [{ id: 9, title: "Platform Engineer" }] },
    }));
    expect(result.status).toBe("not_found");
  });

  it("reports ambiguity instead of choosing between equal postings", async () => {
    const result = await resolveDirectPostingLink({ company: "Acme", role: "DevOps Engineer" }, boards({
      "https://api.lever.co/v0/postings/acme?mode=json": [
        { id: "a", text: "DevOps Engineer", categories: { location: "Remote - US" } },
        { id: "b", text: "DevOps Engineer", categories: { location: "Remote, USA" } },
      ],
    }));
    expect(result.status).toBe("ambiguous");
  });

  it("resolves Lever and Ashby postings to their direct routes", async () => {
    await expect(resolveDirectPostingLink({ company: "Acme", role: "DevOps Engineer" }, boards({
      "https://api.lever.co/v0/postings/acme?mode=json": [{ id: "post-1", text: "DevOps Engineer" }],
    }))).resolves.toMatchObject({ status: "resolved", url: "https://jobs.lever.co/acme/post-1" });
    await expect(resolveDirectPostingLink({ company: "Acme", role: "AI Engineer" }, boards({
      "https://api.ashbyhq.com/posting-api/job-board/acme": { jobs: [{ id: "8b0f6a0e-1111-2222-3333-444455556666", title: "AI Engineer", isListed: true }] },
    }))).resolves.toMatchObject({ status: "resolved", url: "https://jobs.ashbyhq.com/acme/8b0f6a0e-1111-2222-3333-444455556666" });
  });
});

const trackerHeaders = ["Company", "Role", "Job Link", "Location / Remote", "Salary Min", "Salary Max", "Fit", "Priority", "Status", "Date Found", "Date Applied", "Follow-Up Date", "Contact / Referral", "Resume Version", "Next Step", "Notes"];
const queueHeaders = ["Job ID", "Company", "Role", "Job Link", "Source Record ID", "Status", "Worker ID", "Lease Until", "Attempt ID", "Last Error", "Proof ID", "Confirmation Evidence"];

class TwoTabTransport implements GoogleSheetsApiTransport {
  writes: GoogleSheetValueRange[] = [];
  constructor(public tabs: Record<string, unknown[][]>) {}
  async getSpreadsheetMetadata(): Promise<GoogleSheetMetadata> {
    return { spreadsheetId: "s", title: "Tracker", sheets: [{ title: "Job Tracker", sheetId: 1 }, { title: "Application Queue", sheetId: 2 }] };
  }
  async getValues(_id: string, range: string): Promise<readonly (readonly unknown[])[]> {
    const tab = range.match(/^'([^']+)'/)![1]!;
    const rows = this.tabs[tab] ?? [];
    const rowMatch = range.match(/!A(\d+):Z(\d+)$/);
    if (rowMatch && rowMatch[1] === rowMatch[2]) return [rows[Number(rowMatch[1]) - 1] ?? []];
    return rows.map((row) => [...row]);
  }
  async updateValues(_id: string, data: readonly GoogleSheetValueRange[]): Promise<{ updatedCells: number }> {
    for (const write of data) {
      this.writes.push(write);
      const match = write.range.match(/^'([^']+)'!([A-Z]+)(\d+)$/)!;
      let column = 0;
      for (const letter of match[2]!) column = column * 26 + letter.charCodeAt(0) - 64;
      (this.tabs[match[1]!]![Number(match[3]) - 1] ??= [])[column - 1] = write.values[0]?.[0];
    }
    return { updatedCells: data.length };
  }
}

describe("tracker link resolution", () => {
  const aggregator = "https://www.nogigiddy.com/jobs/platform-engineer-defense-unicorns-1pe4n97";
  const resolved = async () => ({ status: "resolved" as const, url: "https://job-boards.greenhouse.io/defenseunicorns/jobs/3", provider: "greenhouse" as const, board: "defenseunicorns", postingTitle: "Platform Engineer" });

  function transport(): TwoTabTransport {
    return new TwoTabTransport({
      "Job Tracker": [
        trackerHeaders,
        ["Defense Unicorns", "Platform Engineer", aggregator, "Remote — U.S.", "", "", "Good", "High", "Researching", "", "", "", "", "cloud-platform", "", "my note"],
        ["Protagona", "AWS Cloud Engineer", "https://www.indeed.com/viewjob?jk=1", "", "", "", "", "", "Applied"],
      ],
      "Application Queue": [
        queueHeaders,
        ["tracker-url:aaaa0001", "Defense Unicorns", "Platform Engineer", aggregator, "tracker-url:aaaa0001", "Needs Input", "", "", "", "[queue-destination-input] Needs Input — no Apply link", "", ""],
      ],
    });
  }

  it("reports without writing in dry-run mode and skips terminal rows", async () => {
    const sheets = transport();
    const queue = new GoogleSheetsJobQueue({ spreadsheetId: "s", spreadsheetName: "Tracker", sheetTab: "Application Queue", timeoutMs: 1000 }, sheets);
    const reports = await resolveTrackerLinks({ transport: sheets, queue, spreadsheetId: "s", trackerTab: "Job Tracker", apply: false, resolve: resolved });
    expect(reports.map((report) => report.company)).toEqual(["Defense Unicorns"]);
    expect(sheets.writes).toHaveLength(0);
  });

  it("writes only the Job Link cell and reopens the matching queue row", async () => {
    const sheets = transport();
    const queue = new GoogleSheetsJobQueue({ spreadsheetId: "s", spreadsheetName: "Tracker", sheetTab: "Application Queue", timeoutMs: 1000 }, sheets);
    const [report] = await resolveTrackerLinks({ transport: sheets, queue, spreadsheetId: "s", trackerTab: "Job Tracker", apply: true, resolve: resolved });
    expect(report!.applied).toContain("reopened as Ready");
    const trackerRow = sheets.tabs["Job Tracker"]![1]!;
    expect(trackerRow[2]).toBe("https://job-boards.greenhouse.io/defenseunicorns/jobs/3");
    expect(trackerRow[15]).toBe("my note");
    const queued = await queue.get("tracker-url:aaaa0001");
    expect(queued.jobLink).toBe("https://job-boards.greenhouse.io/defenseunicorns/jobs/3");
    expect(queued.status).toBe("Ready");
  });
});
