/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";
const runtimeLifecycle = vi.hoisted(() => ({
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  processCuratedJob: vi.fn(async () => ({ status: "held" as const, decisionReason: "Needs review." })),
}));
vi.mock("../application-agent/automation/runtime/careerAgentRuntime", () => ({
  createConfiguredBackgroundCareerAgentRuntime: vi.fn(() => ({
    start: runtimeLifecycle.start,
    stop: runtimeLifecycle.stop,
    processCuratedJob: runtimeLifecycle.processCuratedJob,
  })),
}));
import { runStandaloneJobQueueCommand } from "../application-agent/automation/standaloneJobQueue";
import { createCareerServiceQueueProcessor, deriveQueueApplicationUrl, deriveQueuePostingUrl, queueDestinationPreflightReason, runStandaloneJobQueuePollTick, runStandaloneJobQueueTick } from "../application-agent/automation/standaloneJobQueueWorker";
import { deduplicateGroundedLocationOptions, deduplicateStaticOptions, groundedLocationRepresentative, isApplicationDiscoveryControlLabel } from "../application-agent/automation/playwrightLeverBrowserSession";
import { GoogleSheetsJobQueue } from "../application-agent/automation/googleSheetsJobQueue";
import type { GoogleSheetsApiTransport, GoogleSheetMetadata, GoogleSheetValueRange } from "../application-agent/automation/googleSheetsJobTracker";
import { DurableSubmissionAuthority } from "../application-agent/automation/executionHost/submissionAuthority";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const metadata: GoogleSheetMetadata = { spreadsheetId: "s", title: "Queue", sheets: [{ title: "Jobs", sheetId: 1 }] };
const headers = [["Job ID", "Company", "Role", "Job Link", "Source Record ID", "Status", "Worker ID", "Lease Until", "Attempt ID", "Last Error", "Proof ID", "Confirmation Evidence", "Location", "Description/Notes", "Resume Version", "Priority", "Fit"]];
class Transport implements GoogleSheetsApiTransport {
  writes = 0;
  async getSpreadsheetMetadata(): Promise<GoogleSheetMetadata> { return metadata; }
  async getValues(): Promise<readonly (readonly unknown[])[]> { return headers; }
  async updateValues(_id: string, _data: readonly GoogleSheetValueRange[]): Promise<{ updatedCells: number }> { this.writes += 1; return { updatedCells: 1 }; }
}
class QueueTransport extends Transport {
  constructor(public data: unknown[][]) { super(); }
  async getValues(): Promise<readonly (readonly unknown[])[]> { return this.data.map((row) => [...row]); }
  async updateValues(_id: string, writes: readonly GoogleSheetValueRange[]): Promise<{ updatedCells: number }> {
    this.writes += writes.length;
    for (const write of writes) { const match = write.range.match(/!([A-Z]+)(\d+)$/)!; const letters = match[1]!; let index = 0; for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64; const row = Number(match[2]) - 1; (this.data[row] ??= [])[index - 1] = write.values[0]?.[0]; }
    return { updatedCells: writes.length };
  }
}
const queueHeaders = ["Job ID", "Company", "Role", "Job Link", "Source Record ID", "Status", "Worker ID", "Lease Until", "Attempt ID", "Last Error", "Proof ID", "Confirmation Evidence"];
function queueRow(status = "Ready"): unknown[] { return ["job-1", "Acme", "Engineer", "https://boards.greenhouse.io/acme/jobs/1", "source-1", status, "", "", "", "", "", ""]; }

describe("standalone queue command", () => {
  it("skips aggregator/listing links without invoking the career service", async () => {
    const jobLink = "https://www.indeed.com/viewjob?jk=abc123";
    expect(queueDestinationPreflightReason({ jobLink })).toMatch(/Needs review/);
    const processCuratedJob = vi.fn();
    const processor = createCareerServiceQueueProcessor({ processCuratedJob }, "campaign-1");
    const result = await processor.process({
      jobId: "job-aggregator", company: "Acme", role: "Engineer", jobLink, status: "Ready", workerId: "worker-1", leaseUntil: new Date(Date.now() + 60_000).toISOString(), attemptId: "attempt-1",
    });
    expect(result.status).toBe("Needs Input");
    expect(result.error).toContain("not an executable verified");
    expect(result.error).toContain("queue-destination-input");
    expect(processCuratedJob).not.toHaveBeenCalled();
  });

  it("uses one discovered Apply destination before invoking the career service", async () => {
    const processCuratedJob = vi.fn(async (_campaignId: string, input: { sourceUrl: string; applicationUrl: string }) => {
      expect(input.sourceUrl).toBe("https://boards.greenhouse.io/acme/jobs/123");
      expect(input.applicationUrl).toBe("https://boards.greenhouse.io/acme/jobs/123");
      return { status: "held" as const, decisionReason: "Needs review." } as never;
    });
    const discoverApplicationRoute = vi.fn(async () => ({
      status: "resolved" as const,
      applicationUrl: "https://boards.greenhouse.io/acme/jobs/123",
      evidence: ["listing-identity:verified", "apply:clicked"],
    }));
    const processor = createCareerServiceQueueProcessor({ processCuratedJob, discoverApplicationRoute }, "campaign-1");
    const result = await processor.process({
      jobId: "job-aggregator", company: "Acme", role: "Engineer", jobLink: "https://www.indeed.com/viewjob?jk=abc123", status: "Ready", workerId: "worker-1", leaseUntil: new Date(Date.now() + 60_000).toISOString(), attemptId: "attempt-1",
    });
    expect(result.status).toBe("Needs Input");
    expect(discoverApplicationRoute).toHaveBeenCalledWith({
      jobId: "job-aggregator",
      company: "Acme",
      role: "Engineer",
      sourceUrl: "https://www.indeed.com/viewjob?jk=abc123",
    });
    expect(processCuratedJob).toHaveBeenCalledTimes(1);
  });

  it("keeps an ambiguous Apply page out of the career service", async () => {
    const processCuratedJob = vi.fn();
    const processor = createCareerServiceQueueProcessor({
      processCuratedJob,
      discoverApplicationRoute: async () => ({
        status: "ambiguous" as const,
        reason: "More than one distinct Apply control was visible on the listing page.",
        evidence: ["apply-controls:2", "apply:not-clicked"],
      }),
    }, "campaign-1");
    const result = await processor.process({
      jobId: "job-aggregator", company: "Acme", role: "Engineer", jobLink: "https://www.indeed.com/viewjob?jk=abc123", status: "Ready", workerId: "worker-1", leaseUntil: new Date(Date.now() + 60_000).toISOString(), attemptId: "attempt-1",
    });
    expect(result).toMatchObject({ status: "Needs Input" });
    expect(result.error).toContain("More than one distinct Apply control");
    expect(result.error).toContain("queue-destination-input");
    expect(processCuratedJob).not.toHaveBeenCalled();
  });

  it("includes the discovered destination host when an Apply route is unsupported", async () => {
    const processCuratedJob = vi.fn();
    const processor = createCareerServiceQueueProcessor({
      processCuratedJob,
      discoverApplicationRoute: async () => ({
        status: "resolved" as const,
        applicationUrl: "https://partner.example/apply-form/?job_id=1",
        evidence: ["listing-identity:verified", "apply:clicked", "destination-host:partner.example"],
      }),
    }, "campaign-1");
    const result = await processor.process({
      jobId: "job-aggregator", company: "Acme", role: "Engineer", jobLink: "https://www.indeed.com/viewjob?jk=abc123", status: "Ready", workerId: "worker-1", leaseUntil: new Date(Date.now() + 60_000).toISOString(), attemptId: "attempt-1",
    });
    expect(result).toMatchObject({ status: "Needs Input" });
    expect(result.error).toContain("destination-host:partner.example");
    expect(processCuratedJob).not.toHaveBeenCalled();
  });

  it("recognizes only explicit application control labels", () => {
    expect(isApplicationDiscoveryControlLabel("Apply Now")).toBe(true);
    expect(isApplicationDiscoveryControlLabel("Apply for this job")).toBe(true);
    expect(isApplicationDiscoveryControlLabel("Apply filters")).toBe(false);
    expect(isApplicationDiscoveryControlLabel("Apply coupon")).toBe(false);
  });

  it("derives the verified Ashby posting URL from a queued application URL", () => {
    expect(deriveQueuePostingUrl("https://jobs.ashbyhq.com/litellm/769df1b5-70bb-40fe-b2e2-ef052eb3afa3/application")).toBe("https://jobs.ashbyhq.com/litellm/769df1b5-70bb-40fe-b2e2-ef052eb3afa3");
    expect(deriveQueuePostingUrl("https://boards.greenhouse.io/acme/jobs/1")).toBe("https://boards.greenhouse.io/acme/jobs/1");
  });
  it("derives the Ashby application route when a queue row stores the posting URL", () => {
    expect(deriveQueueApplicationUrl("https://jobs.ashbyhq.com/Mastra/3b06208b-34fe-4dda-b409-ee3fd9305cc3")).toBe("https://jobs.ashbyhq.com/Mastra/3b06208b-34fe-4dda-b409-ee3fd9305cc3/application");
    expect(deriveQueuePostingUrl("https://jobs.ashbyhq.com/Mastra/3b06208b-34fe-4dda-b409-ee3fd9305cc3")).toBe("https://jobs.ashbyhq.com/Mastra/3b06208b-34fe-4dda-b409-ee3fd9305cc3");
  });
  it("derives supported adjacent application routes before preflight", () => {
    const gustoPosting = "https://jobs.gusto.com/postings/sidekick-solutions-llc-cloud-engineer-ac0d6b2b-36c5-4bad-a8d2-91b69546d4ad";
    const gustoApplication = `${gustoPosting}/applicants/new`;
    expect(deriveQueueApplicationUrl(gustoPosting)).toBe(gustoApplication);
    expect(deriveQueuePostingUrl(gustoApplication)).toBe(gustoPosting);
    expect(queueDestinationPreflightReason({ jobLink: gustoPosting })).toBeUndefined();
  });
  it("deduplicates identical static location options but preserves distinct regional choices", () => {
    expect(deduplicateStaticOptions([
      { label: "McDonald, Pennsylvania, USA", value: "mcdonald-pa" },
      { label: " McDonald,  Pennsylvania, USA ", value: "MCDONALD-PA" },
    ])).toHaveLength(1);
    expect(deduplicateStaticOptions([
      { label: "McDonald, Pennsylvania, USA", value: "mcdonald-pa" },
      { label: "McDonald, Tennessee, USA", value: "mcdonald-tn" },
    ])).toHaveLength(2);
    expect(deduplicateGroundedLocationOptions([
      { label: "McDonald, Pennsylvania, USA", value: "opaque-pa-1" },
      { label: " McDonald,  Pennsylvania, USA ", value: "opaque-pa-2" },
    ], "McDonald, Pennsylvania, USA")).toHaveLength(1);
    expect(deduplicateGroundedLocationOptions([
      { label: "McDonald, Pennsylvania, USA", value: "opaque-pa" },
      { label: "McDonald, Tennessee, USA", value: "opaque-tn" },
    ], "McDonald, Pennsylvania, USA")).toHaveLength(2);
    const pennsylvaniaVariants = [
      { label: "McDonald, Pennsylvania, USA", value: "opaque-pa-1" },
      { label: "McDonald, PA, United States", value: "opaque-pa-2" },
    ];
    expect(groundedLocationRepresentative(pennsylvaniaVariants, "McDonald", "McDonald, Pennsylvania, USA")?.label).toBe("McDonald, Pennsylvania, USA");
    expect(groundedLocationRepresentative([
      ...pennsylvaniaVariants,
      { label: "McDonald, Tennessee, USA", value: "opaque-tn" },
    ], "McDonald", "McDonald, Pennsylvania, USA")).toBeUndefined();
  });
  it("performs read-only schema checks without writes", async () => {
    const transport = new Transport();
    await runStandaloneJobQueueCommand(["--schema-check", "--sheet-id", "s", "--sheet-name", "Queue", "--tab", "Jobs"], {}, transport);
    expect(transport.writes).toBe(0);
  });

  it("requires explicit queue configuration", async () => {
    await expect(runStandaloneJobQueueCommand(["--dry-run"], {}, new Transport())).rejects.toThrow(/sheet-id/i);
  });

  it("rejects targeted polling so --job-id cannot become a repeating selector", async () => {
    await expect(runStandaloneJobQueueCommand(["--job-id", "target", "--poll", "--worker-id", "worker-1", "--sheet-id", "s", "--sheet-name", "Queue", "--tab", "Jobs"], {}, new Transport())).rejects.toThrow(/one-shot runs/i);
  });

  it("maps recoverable select verification failures to Needs Input", async () => {
    const processor = createCareerServiceQueueProcessor({
      processCuratedJob: async () => { throw new Error("The select option McDonald, Pennsylvania, USA was not uniquely verified."); },
    }, "campaign-1");
    const result = await processor.process({
      jobId: "job-ashby", company: "MeridianLink", role: "AI Engineer II", jobLink: "https://jobs.ashbyhq.com/meridianlink/12345678-1234-1234-1234-123456789012/application", status: "Ready", workerId: "worker-1", leaseUntil: new Date(Date.now() + 60_000).toISOString(), attemptId: "attempt-1",
    });
    expect(result).toMatchObject({ status: "Needs Input" });
    const returnedFailure = createCareerServiceQueueProcessor({
      processCuratedJob: async () => ({ status: "failed" as const, decisionReason: "The select option McDonald, Pennsylvania, USA was not uniquely verified." } as never),
    }, "campaign-1");
    await expect(returnedFailure.process({
      jobId: "job-ashby", company: "MeridianLink", role: "AI Engineer II", jobLink: "https://jobs.ashbyhq.com/meridianlink/12345678-1234-1234-1234-123456789012/application", status: "Ready", workerId: "worker-1", leaseUntil: new Date(Date.now() + 60_000).toISOString(), attemptId: "attempt-1",
    })).resolves.toMatchObject({ status: "Needs Input" });
  });

  it("stops on a failed browser run when no human blocker remains", async () => {
    const processor = createCareerServiceQueueProcessor({
      processCuratedJob: async () => ({ status: "preparing" as const, execution: { status: "failed" as const }, blockers: [] } as never),
    }, "campaign-1");
    await expect(processor.process({
      jobId: "job-ashby", company: "MeridianLink", role: "AI Engineer II", jobLink: "https://jobs.ashbyhq.com/meridianlink/12345678-1234-1234-1234-123456789012/application", status: "Ready", workerId: "worker-1", leaseUntil: new Date(Date.now() + 60_000).toISOString(), attemptId: "attempt-1",
    })).resolves.toMatchObject({ status: "Failed" });
  });

  it("runs one claimed row through the processor and maps Needs Input", async () => {
    const transport = new QueueTransport([queueHeaders, queueRow()]);
    const queue = new GoogleSheetsJobQueue({ spreadsheetId: "s", spreadsheetName: "Queue", sheetTab: "Jobs", timeoutMs: 1000, leaseMs: 60_000 }, transport);
    const result = await runStandaloneJobQueueTick(queue, { process: async () => ({ status: "Needs Input" as const, error: "Needs a source answer." }) }, "worker-1", new Date());
    expect(result).toMatchObject({ claimed: "job-1", status: "Needs Input", idle: false });
    expect((await queue.get("job-1")).lastError).toBe("Needs a source answer.");
  });

  it("starts the configured career runtime once before processing and stops it afterward", async () => {
    runtimeLifecycle.start.mockClear();
    runtimeLifecycle.stop.mockClear();
    const transport = new QueueTransport([queueHeaders, queueRow()]);
    await runStandaloneJobQueueCommand(
      ["--sheet-id", "s", "--sheet-name", "Queue", "--tab", "Jobs", "--processor", "career-service", "--worker-id", "worker-1"],
      { ATELIER_CAREER_AGENT_CAMPAIGN_ID: "campaign-1" },
      transport,
    );
    expect(runtimeLifecycle.start).toHaveBeenCalledTimes(1);
    expect(runtimeLifecycle.stop).toHaveBeenCalledTimes(1);
    expect(runtimeLifecycle.start.mock.invocationCallOrder[0]).toBeLessThan(runtimeLifecycle.stop.mock.invocationCallOrder[0]!);
  });

  it("contains a tick failure for pollers without weakening the one-shot tick", async () => {
    const queue = { claimNext: async () => { throw new Error("temporary Sheets-backed processor failure"); } } as unknown as GoogleSheetsJobQueue;
    const result = await runStandaloneJobQueuePollTick(queue, { process: async () => ({ status: "Needs Input" as const }) }, "worker-1", new Date());
    expect(result).toMatchObject({ status: "Failed", idle: false, error: "temporary Sheets-backed processor failure" });
  });

  it("renews the claim while a processor is still running and clears the heartbeat", async () => {
    const transport = new QueueTransport([queueHeaders, queueRow()]);
    const queue = new GoogleSheetsJobQueue({ spreadsheetId: "s", spreadsheetName: "Queue", sheetTab: "Jobs", timeoutMs: 1000, leaseMs: 60_000 }, transport);
    let beat: (() => void) | undefined;
    let cleared = false;
    let release!: () => void;
    const processing = new Promise<void>((resolve) => { release = resolve; });
    const resultPromise = runStandaloneJobQueueTick(queue, { process: async () => { await processing; return { status: "Needs Input" as const }; } }, "worker-1", new Date(), {
      heartbeatMs: 1,
      setIntervalFn: (callback) => { beat = callback; return 1 as unknown as ReturnType<typeof setInterval>; },
      clearIntervalFn: () => { cleared = true; },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(beat).toBeDefined();
    beat!();
    release();
    expect(await resultPromise).toMatchObject({ claimed: "job-1", status: "Needs Input", idle: false });
    expect(cleared).toBe(true);
    expect(transport.writes).toBeGreaterThan(4);
  });

  it("uses sub-100ms heartbeat intervals for short leases", async () => {
    const transport = new QueueTransport([queueHeaders, queueRow()]);
    const queue = new GoogleSheetsJobQueue({ spreadsheetId: "s", spreadsheetName: "Queue", sheetTab: "Jobs", timeoutMs: 1000, leaseMs: 9 }, transport);
    let delay = 0;
    const result = await runStandaloneJobQueueTick(queue, { process: async () => ({ status: "Needs Input" as const }) }, "worker-1", new Date(), {
      setIntervalFn: (callback, heartbeatDelay) => { delay = heartbeatDelay; return setInterval(callback, 10_000); },
      clearIntervalFn: (handle) => clearInterval(handle),
    });
    expect(result.status).toBe("Needs Input");
    expect(delay).toBe(3);
  });

  it("records a submitted transition when the processor supplies deterministic proof", async () => {
    const transport = new QueueTransport([queueHeaders, queueRow()]);
    const queue = new GoogleSheetsJobQueue({ spreadsheetId: "s", spreadsheetName: "Queue", sheetTab: "Jobs", timeoutMs: 1000, leaseMs: 60_000 }, transport);
    const result = await runStandaloneJobQueueTick(queue, { process: async () => ({ status: "Submitted" as const, proofId: "proof" }) }, "worker-1", new Date());
    expect(result).toMatchObject({ claimed: "job-1", status: "Submitted", idle: false });
    expect((await queue.get("job-1")).proofId).toBe("proof");
  });

  it("persists a reconciled durable proof as Submitted without starting a host", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-queue-reconcile-"));
    try {
      const authority = new DurableSubmissionAuthority("queue-worker", { stateFile: join(directory, "submission.json") });
      const fence = authority.claim("application-queue-1", "job-1", "2026-09-19T00:00:00.000Z");
      authority.beforeClick(fence, "2026-09-19T00:00:01.000Z");
      authority.markSubmitted(fence, "external-queue-proof", "2026-09-19T00:00:02.000Z");
      const transport = new QueueTransport([queueHeaders, queueRow()]);
      const queue = new GoogleSheetsJobQueue({ spreadsheetId: "s", spreadsheetName: "Queue", sheetTab: "Jobs", timeoutMs: 1000, leaseMs: 60_000 }, transport);
      const result = await runStandaloneJobQueueTick(queue, {
        process: async () => {
          const recovered = authority.reconcile("application-queue-1", "job-1");
          if (recovered.state !== "submitted") throw new Error("expected durable proof");
          return { status: "Submitted" as const, proofId: recovered.externalApplicationId };
        },
      }, "worker-1", new Date());
      expect(result.status).toBe("Submitted");
      expect((await queue.get("job-1")).proofId).toBe("external-queue-proof");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
