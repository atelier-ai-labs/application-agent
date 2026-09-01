import { describe, expect, it } from "vitest";
import {
  HttpGoogleSheetsJobTracker,
  TrackerHostResponseError,
  TrackerHostUnavailableError,
} from "../application-agent/src/service/trackerClient";
import type {
  JobTrackerSyncContext,
  JobTrackerUpdate,
} from "../application-agent/src/domain/tracker";
import type { JobPosting } from "../application-agent/src/domain/types";

const job: JobPosting = {
  company: "Acme Cloud",
  title: "Cloud Platform Engineer",
  sourceUrl: "https://jobs.lever.co/acme/post-1",
  applicationUrl: "https://jobs.lever.co/acme/post-1/apply",
  description: "Build cloud systems.",
  requiredSkills: ["Azure"],
  preferredSkills: [],
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
  sourceRecordId: "post-1",
  job,
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
  sourceRecordId: "post-1",
  sourceUrl: job.sourceUrl,
  applicationUrl: job.applicationUrl,
  company: job.company,
  role: job.title,
  jobLink: job.applicationUrl,
  fit: "strong",
  priority: "high",
  status: "Applied",
  dateFound: job.capturedAt,
  dateApplied: "2026-08-31T15:30:00.000Z",
  resumeVersion: "cloud-platform",
  nextStep: "Await response",
  notes: "test",
  proofMode: "manual",
};

describe("browser Google Sheets tracker client", () => {
  it("posts only the typed applied sync request and validates the result", async () => {
    let receivedUrl = "";
    let receivedBody: unknown;
    const client = new HttpGoogleSheetsJobTracker({
      baseUrl: "http://127.0.0.1:8787/",
      fetcher: async (input, init) => {
        receivedUrl = String(input);
        receivedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ ok: true, simulated: false, trackerRecordId: "Job Tracker!row:2" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    await expect(client.recordApplied(update, context)).resolves.toEqual({
      ok: true,
      simulated: false,
      trackerRecordId: "Job Tracker!row:2",
    });
    expect(receivedUrl).toBe("http://127.0.0.1:8787/career-agent/tracker-sync");
    expect(receivedBody).toMatchObject({ mode: "google_sheets", update: { status: "Applied" } });
  });

  it("reports host unavailability and malformed/error responses without falling back", async () => {
    const unavailable = new HttpGoogleSheetsJobTracker({
      fetcher: async () => { throw new Error("connection refused"); },
    });
    await expect(unavailable.recordApplied(update, context)).rejects.toBeInstanceOf(TrackerHostUnavailableError);

    const malformed = new HttpGoogleSheetsJobTracker({
      fetcher: async () => new Response(JSON.stringify({ ok: "yes" }), { status: 200 }),
    });
    await expect(malformed.recordApplied(update, context)).rejects.toBeInstanceOf(TrackerHostResponseError);

    const failed = new HttpGoogleSheetsJobTracker({
      fetcher: async () => new Response(JSON.stringify({ error: "tracker unavailable" }), { status: 503 }),
    });
    await expect(failed.recordApplied(update, context)).rejects.toMatchObject({ statusCode: 503 });
  });

  it("does not call the host for an invalid or non-applied context", async () => {
    let calls = 0;
    const client = new HttpGoogleSheetsJobTracker({
      fetcher: async () => {
        calls += 1;
        return new Response(JSON.stringify({ ok: true, simulated: false }), { status: 200 });
      },
    });
    const notApplied = { ...context, applicationStatus: "ready_for_review" as const } as unknown as JobTrackerSyncContext;
    const result = await client.recordApplied(update, notApplied);
    expect(result.ok).toBe(false);
    expect(result.simulated).toBe(false);
    expect(calls).toBe(0);
  });
});
