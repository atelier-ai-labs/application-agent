/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { checkPostingOpen, expireClosedPostings, type HttpGet } from "../application-agent/automation/postingLiveness";
import type { GoogleSheetValueRange } from "../application-agent/automation/googleSheetsJobTracker";

/** Answers by URL (POST bodies ignored); anything unlisted does not answer. */
function web(pages: Record<string, number | [number, string]>): HttpGet {
  return async (url) => {
    const page = pages[url];
    if (page === undefined) return undefined;
    const [status, body] = Array.isArray(page) ? page : [page, ""];
    return { status, ok: status >= 200 && status < 300, text: async () => body };
  };
}

describe("is the posting still open?", () => {
  it("asks Greenhouse, Lever and Ashby, and only calls a posting closed when its board still answers", async () => {
    const gh = "https://boards-api.greenhouse.io/v1/boards/acme";
    expect(await checkPostingOpen("https://job-boards.greenhouse.io/acme/jobs/11", web({ [`${gh}/jobs/11`]: 200 }))).toEqual({ state: "open" });
    expect((await checkPostingOpen("https://job-boards.greenhouse.io/acme/jobs/11", web({ [`${gh}/jobs/11`]: 404, [gh]: 200 }))).state).toBe("closed");
    expect((await checkPostingOpen("https://job-boards.greenhouse.io/acme/jobs/11", web({ [`${gh}/jobs/11`]: 404 }))).state).toBe("unknown");
    expect((await checkPostingOpen("https://jobs.lever.co/acme/0f6b7a70-0000-4000-8000-000000000001/apply", web({
      "https://api.lever.co/v0/postings/acme/0f6b7a70-0000-4000-8000-000000000001": 404, "https://api.lever.co/v0/postings/acme?limit=1": 200,
    }))).state).toBe("closed");
    const ashby = "https://api.ashbyhq.com/posting-api/job-board/span.app";
    expect((await checkPostingOpen("https://jobs.ashbyhq.com/span.app/0f6b7a70-0000-4000-8000-000000000001", web({ [ashby]: [200, JSON.stringify({ jobs: [{ id: "other" }] })] }))).state).toBe("closed");
    expect((await checkPostingOpen("https://jobs.ashbyhq.com/span.app/0f6b7a70-0000-4000-8000-000000000001/application", web({ [ashby]: [200, JSON.stringify({ jobs: [{ id: "0F6B7A70-0000-4000-8000-000000000001" }] })] }))).state).toBe("open");
  });

  it("reads Workday's job API: a refused posting on a site that still answers is closed", async () => {
    const api = "https://guidewire.wd5.myworkdayjobs.com/wday/cxs/guidewire/external";
    const link = "https://guidewire.wd5.myworkdayjobs.com/en-US/external/job/United-States---Remote/Junior-AI-Engineer_JR_15319-1/apply";
    const job = `${api}/job/United-States---Remote/Junior-AI-Engineer_JR_15319-1`;
    expect((await checkPostingOpen(link, web({ [job]: 403, [`${api}/jobs`]: 200 }))).state).toBe("closed");
    expect((await checkPostingOpen(link, web({ [job]: 403 }))).state).toBe("unknown");
    expect(await checkPostingOpen(link, web({ [job]: [200, JSON.stringify({ jobPostingInfo: { title: "Junior AI Engineer", canApply: true } })] }))).toEqual({ state: "open" });
    expect((await checkPostingOpen(link, web({ [job]: [200, JSON.stringify({ jobPostingInfo: { canApply: false } })] }))).state).toBe("closed");
  });

  it("closes other pages only on 404/410 or an explicit notice, never on a block", async () => {
    const url = "https://remotive.com/remote/jobs/x-1";
    expect((await checkPostingOpen(url, web({ [url]: 404 }))).state).toBe("closed");
    expect((await checkPostingOpen(url, web({ [url]: 403 }))).state).toBe("unknown");
    expect((await checkPostingOpen(url, web({ [url]: [200, "<h1>Agent Engineer</h1><p>Position Closed</p><p>We are no longer accepting candidates</p>"] }))).state).toBe("closed");
    expect(await checkPostingOpen(url, web({ [url]: [200, "<h1>Agent Engineer</h1><button>Apply now</button>"] }))).toEqual({ state: "open" });
  });

  it("marks closed jobs Expired in the tracker and queue, leaving done rows and in-flight applications alone", async () => {
    const rows = [
      ["Company", "Role", "Job Link", "Status", "Notes"],
      ["Gone Co", "Engineer", "https://x.invalid/gone", "Researching", "Found by search."],
      ["Open Co", "Engineer", "https://x.invalid/open", "Researching", ""],
      ["Done Co", "Engineer", "https://x.invalid/done", "Applied", ""],
      ["Busy Co", "Engineer", "https://x.invalid/busy", "Researching", ""],
    ];
    const writes: GoogleSheetValueRange[] = [];
    const transport = {
      getSpreadsheetMetadata: async () => ({ spreadsheetId: "s", title: "T", sheets: [] }),
      getValues: async (_id: string, range: string) => { const at = /!A(\d+):Z\1$/.exec(range); return at ? [rows[Number(at[1]) - 1]!] : rows; },
      updateValues: async (_id: string, data: readonly GoogleSheetValueRange[]) => { writes.push(...data); return { updatedCells: data.length }; },
    };
    const expired: [string, string][] = [];
    const queue = {
      list: async () => [
        { jobId: "q-gone", company: "Gone Co", role: "Engineer", jobLink: "https://x.invalid/gone/", status: "Ready" },
        { jobId: "q-busy", company: "Busy Co", role: "Engineer", jobLink: "https://x.invalid/busy", status: "Ready to Submit" },
      ] as never,
      markExpired: async (jobId: string, reason: string) => { expired.push([jobId, reason]); return {} as never; },
    };
    const checked: string[] = [];
    const reports = await expireClosedPostings({
      transport, queue, spreadsheetId: "s", trackerTab: "Job Tracker", apply: true, today: "11/6/2026",
      check: async (link) => { checked.push(link); return link.endsWith("gone") ? { state: "closed", reason: "the job page returned 404" } : { state: "open" }; },
    });
    expect(checked).toEqual(["https://x.invalid/gone", "https://x.invalid/open"]);
    expect(writes).toEqual([
      { range: "'Job Tracker'!D2", values: [["Expired"]] },
      { range: "'Job Tracker'!E2", values: [["Found by search. Posting closed (checked 11/6/2026: the job page returned 404)."]] },
    ]);
    expect(expired).toEqual([["q-gone", "Posting closed (checked 11/6/2026: the job page returned 404)."]]);
    expect(reports[0]!.applied).toBe("tracker + 1 queue row marked Expired");
  });
});
