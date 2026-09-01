import { describe, expect, it } from "vitest";
import {
  GoogleSheetsJobTracker,
  createConfiguredGoogleSheetsJobTracker,
  type GoogleSheetMetadata,
  type GoogleSheetValueRange,
  type GoogleSheetsApiTransport,
} from "../application-agent/automation/googleSheetsJobTracker";
import {
  type JobTrackerSyncContext,
  type JobTrackerUpdate,
} from "../application-agent/src/domain/tracker";
import type { JobPosting } from "../application-agent/src/domain/types";

const spreadsheetId = "sheet-test-id";
const headers = [
  "Company",
  "Role",
  "Job Link",
  "Location / Remote",
  "Salary Min",
  "Salary Max",
  "Fit",
  "Priority",
  "Status",
  "Date Found",
  "Date Applied",
  "Follow-Up Date",
  "Contact / Referral",
  "Resume Version",
  "Next Step",
  "Notes",
];

const posting: JobPosting = {
  company: "Acme Cloud",
  title: "Cloud Platform Engineer",
  sourceUrl: "https://jobs.lever.co/acme/cloud-1?utm_source=hq",
  applicationUrl: "https://jobs.lever.co/acme/cloud-1/apply",
  location: "Remote - United States",
  remoteStatus: "remote",
  employmentType: "full time",
  compensation: { minimum: 150000, maximum: 180000, currency: "USD" },
  description: "Build platform systems.",
  requiredSkills: ["Azure"],
  preferredSkills: [],
  ats: "Lever",
  capturedAt: "2026-08-30T12:00:00.000Z",
};

const context: JobTrackerSyncContext = {
  campaignId: "campaign-1",
  careerJobId: "career-job-1",
  applicationId: "application-1",
  campaignStatus: "active",
  careerJobStatus: "applied",
  applicationStatus: "applied",
  sourceMode: "live",
  actionability: "actionable",
  sourceId: "lever:acme",
  sourceRecordId: "cloud-1",
  job: posting,
  evidence: {
    mode: "manual",
    confirmedAt: "2026-08-31T15:30:00.000Z",
    evidence: "user_confirmed_successful_manual_submission",
  },
};

const update: JobTrackerUpdate = {
  applicationId: "application-1",
  careerJobId: "career-job-1",
  campaignId: "campaign-1",
  sourceId: "lever:acme",
  sourceRecordId: "cloud-1",
  sourceUrl: posting.sourceUrl,
  applicationUrl: posting.applicationUrl,
  company: posting.company,
  role: posting.title,
  jobLink: posting.applicationUrl,
  locationRemote: "Remote - United States · remote",
  salaryMin: 150000,
  salaryMax: 180000,
  fit: "strong",
  priority: "high",
  status: "Applied",
  dateFound: "2026-08-30T12:00:00.000Z",
  dateApplied: "2026-08-31T15:30:00.000Z",
  resumeVersion: "cloud-platform",
  nextStep: "Await response",
  notes: "Do not overwrite the user's notes.",
  proofMode: "manual",
};

class FakeSheetsTransport implements GoogleSheetsApiTransport {
  readonly metadata: GoogleSheetMetadata = {
    spreadsheetId,
    title: "Nate Job Search Tracker",
    sheets: [{ title: "Job Tracker", sheetId: 0 }],
  };
  rows: unknown[][];
  updateCalls: GoogleSheetValueRange[][] = [];
  failure: Error | undefined;
  readbackMismatch = false;

  constructor(rows: unknown[][] = [headers]) {
    this.rows = rows.map((row) => [...row]);
  }

  async getSpreadsheetMetadata(): Promise<GoogleSheetMetadata> {
    return this.metadata;
  }

  async getValues(): Promise<readonly (readonly unknown[])[]> {
    if (this.failure) throw this.failure;
    const rows = this.rows.map((row) => [...row]);
    if (this.readbackMismatch && rows[1]) rows[1][1] = "Unexpected readback";
    return rows;
  }

  async updateValues(_id: string, data: readonly GoogleSheetValueRange[]): Promise<{ updatedCells: number }> {
    if (this.failure) throw this.failure;
    this.updateCalls.push(data.map((entry) => ({ ...entry, values: entry.values.map((row) => [...row]) })));
    for (const entry of data) {
      const match = entry.range.match(/!([A-Z]+)(\d+)$/);
      if (!match) continue;
      const [, columnLetters, rowNumber] = match;
      let column = 0;
      for (const letter of columnLetters) column = column * 26 + letter.charCodeAt(0) - 64;
      const rowIndex = Number(rowNumber) - 1;
      this.rows[rowIndex] ??= [];
      this.rows[rowIndex][column - 1] = entry.values[0]?.[0];
    }
    return { updatedCells: data.length };
  }
}

function tracker(transport: GoogleSheetsApiTransport): GoogleSheetsJobTracker {
  return new GoogleSheetsJobTracker({
    spreadsheetId,
    spreadsheetName: "Nate Job Search Tracker",
    sheetTab: "Job Tracker",
    timeoutMs: 1_000,
  }, transport);
}

describe("Google Sheets job tracker", () => {
  it("maps an applied record by header and preserves user-owned fields", async () => {
    const transport = new FakeSheetsTransport([
      headers,
      [
        "Acme Cloud",
        "Cloud Platform Engineer",
        "https://jobs.lever.co/acme/cloud-1",
        "Remote - United States",
        125000,
        155000,
        "Good",
        "Medium",
        "Resume Prep",
        "08/30/2026",
        "",
        "",
        "Referral stays",
        "old-resume",
        "Review manually",
        "Manual notes stay",
      ],
    ]);
    const result = await tracker(transport).recordApplied(update, context);

    expect(result).toEqual({ ok: true, simulated: false, trackerRecordId: "Job Tracker!row:2" });
    expect(transport.rows[1]).toMatchObject({
      0: "Acme Cloud",
      1: "Cloud Platform Engineer",
      2: "https://jobs.lever.co/acme/cloud-1/apply",
      3: "Remote - United States · remote",
      4: 150000,
      5: 180000,
      6: "Excellent",
      7: "High",
      8: "Applied",
      9: "08/30/2026",
      10: "08/31/2026",
      12: "Referral stays",
      13: "cloud-platform",
      14: "Await response",
      15: "Manual notes stay",
    });
    expect(transport.updateCalls[0].every((entry) => !entry.range.endsWith("L2") && !entry.range.endsWith("M2") && !entry.range.endsWith("P2"))).toBe(true);
  });

  it("matches the same row on retry and does not append a duplicate", async () => {
    const transport = new FakeSheetsTransport([headers]);
    const real = tracker(transport);
    await expect(real.recordApplied(update, context)).resolves.toMatchObject({ trackerRecordId: "Job Tracker!row:2" });
    await expect(real.recordApplied(update, context)).resolves.toMatchObject({ trackerRecordId: "Job Tracker!row:2" });
    expect(transport.rows).toHaveLength(2);
    expect(transport.updateCalls).toHaveLength(2);
    expect(transport.updateCalls.every((call) => call.every((entry) => entry.range.endsWith("2")))).toBe(true);
  });

  it("uses company/title fallback when the existing row has no URL and writes known fields only", async () => {
    const transport = new FakeSheetsTransport([
      headers,
      ["Acme Cloud", "Cloud Platform Engineer", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ]);
    const withoutSalary = { ...update, salaryMin: undefined, salaryMax: undefined, locationRemote: undefined };
    const result = await tracker(transport).recordApplied(withoutSalary, context);
    expect(result.ok).toBe(true);
    expect(transport.rows).toHaveLength(2);
    expect(transport.rows[1]?.[2]).toBe(posting.applicationUrl);
    expect(transport.updateCalls[0].some((entry) => entry.range.endsWith("E2") || entry.range.endsWith("F2"))).toBe(false);
  });

  it("uses the provider-plus-record identity when URLs are unavailable", async () => {
    const providerHeaders = [...headers, "Provider Job ID"];
    const transport = new FakeSheetsTransport([providerHeaders]);
    const noUrlContext = {
      ...context,
      job: { ...posting, sourceUrl: undefined, applicationUrl: undefined },
    };
    const noUrlUpdate = {
      ...update,
      sourceUrl: undefined,
      applicationUrl: undefined,
      jobLink: undefined,
    };
    const result = await tracker(transport).recordApplied(noUrlUpdate, noUrlContext);

    expect(result.ok).toBe(true);
    expect(transport.rows[1]?.[16]).toBe("lever:acme:cloud-1");
    await expect(tracker(transport).recordApplied(noUrlUpdate, noUrlContext)).resolves.toMatchObject({
      trackerRecordId: "Job Tracker!row:2",
    });
    expect(transport.rows).toHaveLength(2);
  });

  it("writes a new row below the header without inventing user-owned columns", async () => {
    const transport = new FakeSheetsTransport([headers]);
    const result = await tracker(transport).recordApplied(update, context);
    expect(result.trackerRecordId).toBe("Job Tracker!row:2");
    expect(transport.rows[1]?.[0]).toBe("Acme Cloud");
    expect(transport.rows[1]?.[11]).toBeUndefined();
    expect(transport.rows[1]?.[12]).toBeUndefined();
    expect(transport.rows[1]?.[15]).toBeUndefined();
  });

  it("rejects demo evidence and malformed headers without calling the write boundary", async () => {
    const transport = new FakeSheetsTransport([["Company"]]);
    const demoContext = { ...context, sourceMode: "demo" as const };
    const rejected = await tracker(transport).recordApplied(update, demoContext);
    expect(rejected.ok).toBe(false);
    expect(transport.updateCalls).toHaveLength(0);

    const liveTransport = new FakeSheetsTransport([[...headers.slice(0, 3)]]);
    const malformed = await tracker(liveTransport).recordApplied(update, context);
    expect(malformed.ok).toBe(false);
    expect(malformed.error).toContain("header mismatch");
    expect(liveTransport.updateCalls).toHaveLength(0);
  });

  it("returns transport/auth failures honestly", async () => {
    const transport = new FakeSheetsTransport([headers]);
    transport.failure = new Error("Google Sheets permission denied.");
    const result = await tracker(transport).recordApplied(update, context);
    expect(result).toEqual({ ok: false, simulated: false, error: "Google Sheets permission denied." });
  });

  it("does not report success when the post-write row readback does not match", async () => {
    const transport = new FakeSheetsTransport([headers]);
    transport.readbackMismatch = true;
    const result = await tracker(transport).recordApplied(update, context);
    expect(result).toEqual({
      ok: false,
      simulated: false,
      error: "Google Sheets write verification failed for 'role'.",
    });
    expect(transport.updateCalls).toHaveLength(1);
  });

  it("returns an unavailable real tracker when server credentials are absent", async () => {
    const configured = createConfiguredGoogleSheetsJobTracker({
      ATELIER_GOOGLE_SHEET_ID: spreadsheetId,
    });
    const result = await configured.recordApplied(update, context);
    expect(result).toEqual({
      ok: false,
      simulated: false,
      error: "Google Sheets credentials are not configured; set ATELIER_GOOGLE_AUTH_MODE=oauth and run npm run career-agent:google-auth, or configure an explicit legacy credential mode.",
    });
  });
});
