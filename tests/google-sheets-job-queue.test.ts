import { describe, expect, it } from "vitest";
import { GoogleSheetsJobQueue } from "../application-agent/automation/googleSheetsJobQueue";
import type { GoogleSheetMetadata, GoogleSheetValueRange, GoogleSheetsApiTransport } from "../application-agent/automation/googleSheetsJobTracker";

const headers = ["Job ID", "Company", "Role", "Job Link", "Source Record ID", "Status", "Worker ID", "Lease Until", "Attempt ID", "Last Error", "Proof ID", "Confirmation Evidence", "Location", "Description/Notes", "Resume Version", "Priority", "Fit"];
const metadata: GoogleSheetMetadata = { spreadsheetId: "sheet", title: "Queue", sheets: [{ title: "Jobs", sheetId: 1, gridProperties: { columnCount: 17, rowCount: 1_000 } }] };
function column(range: string): number { const match = range.match(/!([A-Z]+)\d+$/)!; return [...match[1]!].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1; }
class FakeTransport implements GoogleSheetsApiTransport {
  constructor(public rows: unknown[][]) {}
  async getSpreadsheetMetadata(): Promise<GoogleSheetMetadata> { return metadata; }
  async getValues(): Promise<readonly (readonly unknown[])[]> { return this.rows.map((row) => [...row]); }
  async updateValues(_id: string, data: readonly GoogleSheetValueRange[]): Promise<{ updatedCells: number }> { for (const write of data) { const rowMatch = write.range.match(/(\d+)$/)!; const row = Number(rowMatch[1]) - 1; const target = this.rows[row] ?? (this.rows[row] = []); target[column(write.range)] = write.values[0]?.[0]; } return { updatedCells: data.length }; }
}
class LegacyGridTransport extends FakeTransport {
  private expanded = false;
  async getSpreadsheetMetadata(): Promise<GoogleSheetMetadata> { return { ...metadata, sheets: [{ title: "Jobs", sheetId: 1, gridProperties: { columnCount: this.expanded ? 17 : 12, rowCount: 1_000 } }] }; }
  async batchUpdate(): Promise<void> { this.expanded = true; }
}
function queue(transport: FakeTransport): GoogleSheetsJobQueue { return new GoogleSheetsJobQueue({ spreadsheetId: "sheet", spreadsheetName: "Queue", sheetTab: "Jobs", timeoutMs: 1000, leaseMs: 60_000 }, transport); }
function row(id: string, status = "Ready", lease = ""): unknown[] { return [id, "Acme", "Engineer", `https://example.com/${id}`, `src:${id}`, status, "", lease, "", "", "", "", "", "", "", "", ""]; }

describe("Google Sheets authoritative job queue", () => {
  it("claims by stable job ID despite row reordering and verifies the lease", async () => {
    const transport = new FakeTransport([headers, row("a"), row("b")]);
    const claimed = await queue(transport).claimNext("worker-1", new Date("2026-01-01T00:00:00Z"));
    expect(claimed).toMatchObject({ jobId: "a", status: "Claimed", workerId: "worker-1" });
    transport.rows.splice(1, 2, transport.rows[2]!, transport.rows[1]!);
    expect((await queue(transport).get("a")).jobId).toBe("a");
  });

  it("claims only the exact requested Job ID", async () => {
    const transport = new FakeTransport([headers, row("first"), row("target")]);
    const claimed = await queue(transport).claimNext("worker-1", new Date("2026-01-01T00:00:00Z"), "target");
    expect(claimed).toMatchObject({ jobId: "target", status: "Claimed" });
    expect((await queue(transport).get("first")).status).toBe("Ready");
  });

  it("rejects a missing or ineligible exact target without falling back", async () => {
    await expect(queue(new FakeTransport([headers, row("first")])).claimNext("worker-1", new Date(), "missing")).rejects.toThrow(/target Job ID 'missing' was not found/);
    await expect(queue(new FakeTransport([headers, row("first", "Needs Input")])).claimNext("worker-1", new Date(), "first")).rejects.toThrow(/target Job ID 'first' is not eligible/);
  });

  it("recovers stale leases and rejects duplicate stable IDs", async () => {
    const stale = new FakeTransport([headers, row("a", "Applying", "2020-01-01T00:00:00Z")]);
    expect((await queue(stale).claimNext("worker", new Date("2026-01-01T00:00:00Z")))?.jobId).toBe("a");
    await expect(queue(new FakeTransport([headers, row("a"), row("a")])).list()).rejects.toThrow("duplicate job ID");
  });

  it("requires proof for Submitted and makes idempotent updates", async () => {
    const transport = new FakeTransport([headers, row("a", "Ready to Submit")]); const q = queue(transport);
    await expect(q.update("a", { status: "Submitted" })).rejects.toThrow("deterministic proof");
    await expect(q.update("a", { status: "Submitted", proofId: "external-1" })).resolves.toMatchObject({ status: "Submitted", proofId: "external-1" });
    await expect(q.update("a", { status: "Submitted", proofId: "external-1" })).resolves.toMatchObject({ status: "Submitted" });
    await expect(q.rereadBeforeSubmission("a")).rejects.toThrow("submission-ready");
  });

  it("requires confirmation evidence for Confirmed", async () => {
    const q = queue(new FakeTransport([headers, row("a", "Ready to Submit")]));
    await expect(q.update("a", { status: "Confirmed" })).rejects.toThrow("confirmation evidence");
    await expect(q.update("a", { status: "Confirmed", confirmationEvidence: "confirmation-page:abc" })).resolves.toMatchObject({ status: "Confirmed", confirmationEvidence: "confirmation-page:abc" });
  });

  it("requires a live lease immediately before submission", async () => {
    const transport = new FakeTransport([headers, row("a", "Applying", "2099-01-01T00:10:00Z")]);
    await expect(queue(transport).rereadBeforeSubmission("a")).resolves.toMatchObject({ jobId: "a" });
    transport.rows[1]![7] = "2020-01-01T00:00:00Z";
    await expect(queue(transport).rereadBeforeSubmission("a")).rejects.toThrow("expired lease");
  });

  it("allows only an exact one-shot target to resume Ready to Submit", async () => {
    const transport = new FakeTransport([headers, row("a", "Ready to Submit")]);
    await expect(queue(transport).claimNext("worker", new Date("2026-01-01T00:00:00Z"), "a")).rejects.toThrow(/not eligible/);
    const claimed = await queue(transport).claimNext("worker", new Date("2026-01-01T00:00:00Z"), "a", true);
    expect(claimed?.jobId).toBe("a");
    const pollTransport = new FakeTransport([headers, row("a", "Ready to Submit")]);
    await expect(queue(pollTransport).claimNext("worker", new Date("2026-01-01T00:00:00Z"))).resolves.toBeUndefined();
  });

  it("can retry the current Needs Input row only when polling explicitly allows it", async () => {
    const transport = new FakeTransport([headers, row("a", "Needs Input"), row("b", "Ready")]);
    await expect(queue(transport).claimNext("worker", new Date("2026-01-01T00:00:00Z"))).resolves.toBeUndefined();
    const retryTransport = new FakeTransport([headers, row("a", "Needs Input"), row("b", "Ready")]);
    await expect(queue(retryTransport).claimNext("worker", new Date("2026-01-01T00:00:00Z"), undefined, false, true)).resolves.toMatchObject({ jobId: "a" });
  });

  it("does not skip a Ready to Submit row for a later job", async () => {
    const transport = new FakeTransport([headers, row("a", "Ready to Submit"), row("b", "Ready")]);
    await expect(queue(transport).claimNext("worker", new Date("2026-01-01T00:00:00Z"))).resolves.toBeUndefined();
  });

  it("requeues only one proof-free failed row", async () => {
    const transport = new FakeTransport([headers, row("a", "Failed")]);
    await expect(queue(transport).requeueFailed("a")).resolves.toMatchObject({ status: "Ready" });
    const submittedRow = row("b", "Failed"); submittedRow[10] = "proof";
    const submitted = new FakeTransport([headers, submittedRow]);
    await expect(queue(submitted).requeueFailed("b")).rejects.toThrow(/proof/);
  });

  it("fails initialization when Sheets acknowledges creation without creating the tab", async () => {
    const transport = new class extends FakeTransport {
      async getSpreadsheetMetadata(): Promise<GoogleSheetMetadata> { return { ...metadata, sheets: [] }; }
      async batchUpdate(): Promise<void> { /* transport falsely acknowledges without changing metadata */ }
    }([headers]);
    await expect(queue(transport).initialize()).rejects.toThrow("tab creation could not be verified");
  });

  it("migrates an empty legacy prefix exactly once and rejects populated or reordered prefixes", async () => {
    const legacyHeaders = headers.slice(0, 12);
    const empty = new LegacyGridTransport([legacyHeaders]);
    await queue(empty).initialize();
    expect(empty.rows[0]).toEqual(headers);
    await queue(empty).initialize();
    expect(empty.rows[0]).toEqual(headers);

    const populated = new FakeTransport([headers.slice(0, 12), row("a")]);
    await queue(populated).initialize();
    expect(populated.rows[0]).toEqual(headers);
    const legacyPopulated = new FakeTransport([headers.slice(0, 11), row("a")]);
    await expect(queue(legacyPopulated).initialize()).rejects.toThrow(/exact trailing schema/);
    const reordered = new FakeTransport([["Company", "Job ID", ...headers.slice(2, 12)]]);
    await expect(queue(reordered).initialize()).rejects.toThrow(/invalid or non-empty legacy schema/);
  });
});
