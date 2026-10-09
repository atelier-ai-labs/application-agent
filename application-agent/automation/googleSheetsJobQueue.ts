import type { GoogleSheetValueRange, GoogleSheetsApiTransport } from "./googleSheetsJobTracker";

export const JOB_QUEUE_STATUSES = ["Discovered", "Ready", "Claimed", "Applying", "Needs Input", "Ready to Submit", "Submitted", "Confirmed", "Expired", "Skipped", "Failed"] as const;
export const JOB_QUEUE_HEADERS = ["Job ID", "Company", "Role", "Job Link", "Source Record ID", "Status", "Worker ID", "Lease Until", "Attempt ID", "Last Error", "Proof ID", "Confirmation Evidence", "Location", "Description/Notes", "Resume Version", "Priority", "Fit"] as const;
/** A queue-level destination blocker needs a tracker/URL change before it is retried. */
export const QUEUE_DESTINATION_INPUT_MARKER = "[queue-destination-input]";
export type JobQueueStatus = typeof JOB_QUEUE_STATUSES[number];

export interface SheetJobQueueRecord {
  jobId: string;
  company: string;
  role: string;
  jobLink: string;
  sourceRecordId?: string;
  status: JobQueueStatus;
  workerId?: string;
  leaseUntil?: string;
  attemptId?: string;
  lastError?: string;
  proofId?: string;
  confirmationEvidence?: string;
  location?: string;
  description?: string;
  resumeVersion?: string;
  priority?: string;
  fit?: string;
}

export interface GoogleSheetsJobQueueConfig {
  spreadsheetId: string;
  spreadsheetName: string;
  sheetTab: string;
  timeoutMs: number;
  leaseMs?: number;
}

export interface ClaimedSheetJob extends SheetJobQueueRecord {
  workerId: string;
  leaseUntil: string;
  attemptId: string;
}

export interface SheetJobQueueUpdate {
  status: JobQueueStatus;
  workerId?: string;
  leaseUntil?: string;
  attemptId?: string;
  lastError?: string;
  proofId?: string;
  confirmationEvidence?: string;
}
export interface SheetJobQueueContextUpdate { location?: string; description?: string; resumeVersion?: string; priority?: string; fit?: string; }

const REQUIRED_HEADERS = ["job id", "company", "role", "job link", "status", "worker id", "lease until", "attempt id", "last error", "proof id", "confirmation evidence"] as const;
const MAX_ROWS = 1_000;

function text(value: unknown): string { return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value).trim() : ""; }
function key(value: unknown): string { return text(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function col(index: number): string { let n = index + 1; let result = ""; while (n) { const r = (n - 1) % 26; result = String.fromCharCode(65 + r) + result; n = Math.floor((n - 1) / 26); } return result; }
function quote(tab: string): string { return `'${tab.replace(/'/g, "''")}'`; }
function cell(tab: string, column: number, row: number): string { return `${quote(tab)}!${col(column)}${row}`; }
function status(value: unknown): JobQueueStatus | undefined { return JOB_QUEUE_STATUSES.includes(value as JobQueueStatus) ? value as JobQueueStatus : undefined; }
function parseDate(value: string | undefined): number | undefined { if (!value) return undefined; const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : undefined; }

type Columns = Record<string, number>;

export class GoogleSheetsJobQueue {
  public readonly id = "google-sheets-job-queue";
  public readonly sheetTab: string;
  private readonly leaseMs: number;
  private configurationVerified = false;
  constructor(private readonly config: GoogleSheetsJobQueueConfig, private readonly transport: GoogleSheetsApiTransport) {
    if (!config.spreadsheetId.trim() || !config.spreadsheetName.trim() || !config.sheetTab.trim()) throw new Error("Google Sheets job queue requires spreadsheet ID, name, and tab.");
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0) throw new Error("Google Sheets job queue timeout must be positive.");
    this.leaseMs = config.leaseMs ?? 300_000;
    this.sheetTab = config.sheetTab;
    if (!Number.isInteger(this.leaseMs) || this.leaseMs <= 0) throw new Error("Google Sheets job queue lease must be positive.");
  }

  get leaseDurationMs(): number { return this.leaseMs; }

  private async verifyConfiguration(): Promise<void> {
    if (this.configurationVerified) return;
    const metadata = await this.transport.getSpreadsheetMetadata(this.config.spreadsheetId);
    if (metadata.spreadsheetId !== this.config.spreadsheetId || metadata.title !== this.config.spreadsheetName) throw new Error("Google Sheets job queue configuration does not match the spreadsheet.");
    if (!metadata.sheets.some((sheet) => sheet.title === this.config.sheetTab)) throw new Error(`Google Sheets job queue tab '${this.config.sheetTab}' was not found.`);
    this.configurationVerified = true;
  }

  private async rows(): Promise<{ rows: readonly (readonly unknown[])[]; columns: Columns }> {
    await this.verifyConfiguration();
    const rows = await this.transport.getValues(this.config.spreadsheetId, `${quote(this.config.sheetTab)}!A1:Z${MAX_ROWS}`);
    if (rows.length === 0) throw new Error("Google Sheets job queue has no header row.");
    const columns: Columns = {};
    for (let i = 0; i < (rows[0] ?? []).length; i += 1) columns[key(rows[0]![i])] = i;
    const missing = REQUIRED_HEADERS.filter((header) => columns[header] === undefined);
    if (missing.length) throw new Error(`Google Sheets job queue schema is missing headers: ${missing.join(", ")}.`);
    return { rows, columns };
  }

  private record(row: readonly unknown[], columns: Columns): SheetJobQueueRecord {
    const get = (name: string) => text(row[columns[name]]);
    const parsedStatus = status(get("status"));
    if (!get("job id")) throw new Error("Google Sheets job queue contains a row with no stable job ID.");
    if (!parsedStatus) throw new Error(`Google Sheets job queue contains an unsupported status for job '${get("job id")}'.`);
    if (!get("company") || !get("role") || !get("job link")) throw new Error(`Google Sheets job queue row '${get("job id")}' is missing company, role, or Job Link.`);
    return { jobId: get("job id"), company: get("company"), role: get("role"), jobLink: get("job link"), ...(get("source record id") ? { sourceRecordId: get("source record id") } : {}), status: parsedStatus, ...(get("worker id") ? { workerId: get("worker id") } : {}), ...(get("lease until") ? { leaseUntil: get("lease until") } : {}), ...(get("attempt id") ? { attemptId: get("attempt id") } : {}), ...(get("last error") ? { lastError: get("last error") } : {}), ...(get("proof id") ? { proofId: get("proof id") } : {}), ...(get("confirmation evidence") ? { confirmationEvidence: get("confirmation evidence") } : {}), ...(get("location") ? { location: get("location") } : {}), ...(get("description notes") ? { description: get("description notes") } : {}), ...(get("resume version") ? { resumeVersion: get("resume version") } : {}), ...(get("priority") ? { priority: get("priority") } : {}), ...(get("fit") ? { fit: get("fit") } : {}) };
  }

  async list(): Promise<readonly SheetJobQueueRecord[]> { const { rows, columns } = await this.rows(); const seen = new Set<string>(); const result: SheetJobQueueRecord[] = []; for (let i = 1; i < rows.length; i += 1) { if ((rows[i] ?? []).every((value) => text(value) === "")) continue; const item = this.record(rows[i]!, columns); if (seen.has(item.jobId)) throw new Error(`Google Sheets job queue contains duplicate job ID '${item.jobId}'.`); seen.add(item.jobId); result.push(item); } return result; }

  /** Create only the dedicated queue tab, or validate it if it exists. */
  async initialize(): Promise<void> {
    const metadata = await this.transport.getSpreadsheetMetadata(this.config.spreadsheetId);
    if (metadata.spreadsheetId !== this.config.spreadsheetId || metadata.title !== this.config.spreadsheetName) throw new Error("Google Sheets job queue configuration does not match the spreadsheet.");
    const existing = metadata.sheets.find((sheet) => sheet.title === this.config.sheetTab);
    if (existing) {
      const rows = await this.transport.getValues(this.config.spreadsheetId, `${quote(this.config.sheetTab)}!A1:Q${MAX_ROWS}`);
      const actual = (rows[0] ?? []).map((value) => text(value));
      while (actual.at(-1) === "") actual.pop();
      const exact = actual.length === JOB_QUEUE_HEADERS.length && actual.every((value, index) => value === JOB_QUEUE_HEADERS[index]);
      if (!exact) {
        const prefix = actual.every((value, index) => value === JOB_QUEUE_HEADERS[index]) && actual.length < JOB_QUEUE_HEADERS.length;
        const hasData = rows.slice(1).some((row) => row.some((value) => text(value) !== ""));
        if (!prefix || (hasData && actual.length < 12)) throw new Error(`Google Sheets job queue tab '${this.config.sheetTab}' has an invalid or non-empty legacy schema; migration requires an exact trailing schema (legacy core migration requires an empty tab).`);
        const capacity = existing.gridProperties?.columnCount;
        if (capacity === undefined || capacity < actual.length) throw new Error(`Google Sheets job queue tab '${this.config.sheetTab}' did not provide a valid column capacity for migration.`);
        if (capacity < JOB_QUEUE_HEADERS.length) {
          if (!this.transport.batchUpdate) throw new Error("Queue schema migration requires batch-update support to extend the tab grid; no other tab was modified.");
          await this.transport.batchUpdate(this.config.spreadsheetId, [{ insertDimension: { range: { sheetId: existing.sheetId, dimension: "COLUMNS", startIndex: capacity, endIndex: JOB_QUEUE_HEADERS.length }, inheritFromBefore: true } }]);
          const resized = await this.transport.getSpreadsheetMetadata(this.config.spreadsheetId);
          const resizedSheet = resized.sheets.find((sheet) => sheet.title === this.config.sheetTab);
          if (!resizedSheet || (resizedSheet.gridProperties?.columnCount ?? 0) < JOB_QUEUE_HEADERS.length) throw new Error("Google Sheets job queue grid expansion could not be verified.");
        }
        if (!this.transport.updateValues) throw new Error("Queue schema migration requires a Sheets transport with update support; no other tab was modified.");
        await this.transport.updateValues(this.config.spreadsheetId, JOB_QUEUE_HEADERS.slice(actual.length).map((header, offset) => ({ range: cell(this.config.sheetTab, actual.length + offset, 1), values: [[header]] })));
        const migrated = await this.transport.getValues(this.config.spreadsheetId, `${quote(this.config.sheetTab)}!A1:Q1`);
        const migratedHeaders = (migrated[0] ?? []).map((value) => text(value));
        if (migratedHeaders.length !== JOB_QUEUE_HEADERS.length || migratedHeaders.some((value, index) => value !== JOB_QUEUE_HEADERS[index])) throw new Error("Google Sheets job queue schema migration could not be verified.");
      }
      this.configurationVerified = true;
      return;
    }
    if (!this.transport.batchUpdate) throw new Error("Queue initialization requires a Sheets transport with batch-update support; no other tab was modified.");
    const sheetId = Math.max(-1, ...metadata.sheets.map((sheet) => sheet.sheetId)) + 1;
    await this.transport.batchUpdate(this.config.spreadsheetId, [
      { addSheet: { properties: { sheetId, title: this.config.sheetTab, gridProperties: { rowCount: MAX_ROWS, columnCount: JOB_QUEUE_HEADERS.length } } } },
      { updateCells: { start: { sheetId, rowIndex: 0, columnIndex: 0 }, rows: [{ values: JOB_QUEUE_HEADERS.map((userEnteredValue) => ({ userEnteredValue: { stringValue: userEnteredValue } })) }], fields: "userEnteredValue" } },
      { setDataValidation: { range: { sheetId, startRowIndex: 1, endRowIndex: MAX_ROWS, startColumnIndex: 5, endColumnIndex: 6 }, rule: { condition: { type: "ONE_OF_LIST", values: JOB_QUEUE_STATUSES.map((value) => ({ userEnteredValue: value })) }, strict: true, showCustomUi: true } } },
    ]);
    const verify = await this.transport.getSpreadsheetMetadata(this.config.spreadsheetId);
    const created = verify.sheets.find((sheet) => sheet.title === this.config.sheetTab);
    if (!created || !Number.isInteger(created.sheetId) || created.sheetId < 0) throw new Error("Google Sheets job queue tab creation could not be verified.");
    const writtenHeaders = await this.transport.getValues(this.config.spreadsheetId, `${quote(this.config.sheetTab)}!A1:Q1`);
    const actualHeaders = (writtenHeaders[0] ?? []).map((value) => text(value));
    if (actualHeaders.length !== JOB_QUEUE_HEADERS.length || actualHeaders.some((value, index) => value !== JOB_QUEUE_HEADERS[index])) throw new Error("Google Sheets job queue header write could not be verified.");
    this.configurationVerified = true;
  }

  async claimNext(workerId: string, now = new Date(), targetJobId?: string, allowTargetReadyToSubmit = false, allowNeedsInputRetry = false): Promise<ClaimedSheetJob | undefined> {
    if (!workerId.trim() || Number.isNaN(now.getTime())) throw new Error("A valid worker ID and timestamp are required to claim a queue job.");
    if (targetJobId !== undefined && !targetJobId.trim()) throw new Error("A targeted queue run requires a non-empty exact Job ID.");
    const { rows, columns } = await this.rows(); const candidates: { item: SheetJobQueueRecord; row: number }[] = [];
    for (let i = 1; i < rows.length; i += 1) {
      if ((rows[i] ?? []).every((value) => text(value) === "")) continue;
      const item = this.record(rows[i]!, columns);
      const stale = ["Claimed", "Applying"].includes(item.status) && (parseDate(item.leaseUntil) ?? 0) <= now.getTime();
      const targetedResume = allowTargetReadyToSubmit && targetJobId !== undefined && item.jobId === targetJobId && item.status === "Ready to Submit";
      const needsInputRetry = allowNeedsInputRetry && item.status === "Needs Input" && !item.lastError?.includes(QUEUE_DESTINATION_INPUT_MARKER);
      if (item.status === "Ready" || stale || targetedResume || needsInputRetry) {
        candidates.push({ item, row: i + 1 });
        if (targetJobId === undefined) break;
      }
      if (targetJobId === undefined && !stale && !["Confirmed", "Expired", "Skipped", "Failed"].includes(item.status) &&
        !(item.status === "Needs Input" && allowNeedsInputRetry)) {
        // Preserve strict source order. A prepared submission, a live lease,
        // or a human blocker must finish before a later row is considered.
        break;
      }
    }
    const candidate = targetJobId === undefined ? candidates[0] : candidates.find(({ item }) => item.jobId === targetJobId);
    if (targetJobId !== undefined && !candidate) {
      const target = (await this.list()).find((item) => item.jobId === targetJobId);
      if (!target) throw new Error(`Google Sheets job queue target Job ID '${targetJobId}' was not found.`);
      throw new Error(`Google Sheets job queue target Job ID '${targetJobId}' is not eligible for claiming (status '${target.status}').`);
    }
    if (!candidate) return undefined;
    const leaseUntil = new Date(now.getTime() + this.leaseMs).toISOString(); const attemptId = `${workerId}:${now.getTime()}:${candidate.item.jobId}`;
    const writes: GoogleSheetValueRange[] = [
      { range: cell(this.config.sheetTab, columns.status, candidate.row), values: [["Claimed"]] },
      { range: cell(this.config.sheetTab, columns["worker id"], candidate.row), values: [[workerId]] },
      { range: cell(this.config.sheetTab, columns["lease until"], candidate.row), values: [[leaseUntil]] },
      { range: cell(this.config.sheetTab, columns["attempt id"], candidate.row), values: [[attemptId]] },
    ];
    await this.transport.updateValues(this.config.spreadsheetId, writes);
    const reread = await this.list(); const claimed = reread.find((item) => item.jobId === candidate.item.jobId);
    if (!claimed || claimed.status !== "Claimed" || claimed.workerId !== workerId || claimed.leaseUntil !== leaseUntil || claimed.attemptId !== attemptId) throw new Error(`Google Sheets job queue claim lost its read-after-write verification for '${candidate.item.jobId}'.`);
    return { ...claimed, workerId, leaseUntil, attemptId };
  }

  async get(jobId: string): Promise<SheetJobQueueRecord> { const item = (await this.list()).find((candidate) => candidate.jobId === jobId); if (!item) throw new Error(`Google Sheets job queue job '${jobId}' was not found.`); return item; }

  async enrichMany(enrichments: readonly { jobId: string; context: SheetJobQueueContextUpdate }[]): Promise<readonly SheetJobQueueRecord[]> {
    if (!enrichments.length) return [];
    const { rows, columns } = await this.rows(); const writes: GoogleSheetValueRange[] = [];
    for (const enrichment of enrichments) {
      const rowIndex = rows.findIndex((row, index) => index > 0 && text(row[columns["job id"]]) === enrichment.jobId);
      if (rowIndex < 1) throw new Error(`Google Sheets job queue job '${enrichment.jobId}' was not found.`);
      const values: Record<string, string | undefined> = { location: enrichment.context.location, "description notes": enrichment.context.description, "resume version": enrichment.context.resumeVersion, priority: enrichment.context.priority, fit: enrichment.context.fit };
      for (const [name, fieldValue] of Object.entries(values)) if (fieldValue && text((rows[rowIndex] ?? [])[columns[name]]) !== fieldValue) writes.push({ range: cell(this.config.sheetTab, columns[name]!, rowIndex + 1), values: [[fieldValue]] });
    }
    if (writes.length) await this.transport.updateValues(this.config.spreadsheetId, writes);
    const verified = await this.list();
    return enrichments.map(({ jobId }) => { const record = verified.find((candidate) => candidate.jobId === jobId); if (!record) throw new Error(`Queue enrichment could not verify '${jobId}'.`); return record; });
  }

  async enrich(jobId: string, context: SheetJobQueueContextUpdate): Promise<SheetJobQueueRecord> {
    return (await this.enrichMany([{ jobId, context }]))[0]!;
  }

  /** Update tracker-owned identity fields without touching lifecycle proof. */
  async updateSource(jobId: string, update: { company?: string; role?: string; jobLink?: string; sourceRecordId?: string }): Promise<SheetJobQueueRecord> {
    const { rows, columns } = await this.rows();
    const rowIndex = rows.findIndex((row, index) => index > 0 && text(row[columns["job id"]]) === jobId);
    if (rowIndex < 1) throw new Error(`Google Sheets job queue job '${jobId}' was not found.`);
    const values: Record<string, string | undefined> = {
      company: update.company,
      role: update.role,
      "job link": update.jobLink,
      "source record id": update.sourceRecordId,
    };
    const writes: GoogleSheetValueRange[] = [];
    for (const [name, next] of Object.entries(values)) {
      if (next !== undefined && text((rows[rowIndex] ?? [])[columns[name]]) !== next) {
        writes.push({ range: cell(this.config.sheetTab, columns[name]!, rowIndex + 1), values: [[next]] });
      }
    }
    if (writes.length) {
      await this.transport.updateValues(this.config.spreadsheetId, writes);
      const verified = await this.get(jobId);
      const property: Record<string, keyof SheetJobQueueRecord> = { company: "company", role: "role", "job link": "jobLink", "source record id": "sourceRecordId" };
      for (const [name, next] of Object.entries(values)) {
        if (next !== undefined && text(verified[property[name]]) !== next) throw new Error(`Google Sheets job queue source update verification failed for '${name}'.`);
      }
      return verified;
    }
    return this.record(rows[rowIndex]!, columns);
  }

  async update(jobId: string, update: SheetJobQueueUpdate): Promise<SheetJobQueueRecord> {
    if (!status(update.status)) throw new Error("Google Sheets job queue update has an unsupported status.");
    if (update.status === "Submitted" && !update.proofId?.trim()) throw new Error("Google Sheets job queue cannot mark a job Submitted without deterministic proof.");
    if (update.status === "Confirmed" && !update.confirmationEvidence?.trim()) throw new Error("Google Sheets job queue cannot mark a job Confirmed without confirmation evidence.");
    const { rows, columns } = await this.rows(); const rowIndex = rows.findIndex((row, index) => index > 0 && text(row[columns["job id"]]) === jobId); if (rowIndex < 1) throw new Error(`Google Sheets job queue job '${jobId}' was not found.`);
    const current = this.record(rows[rowIndex]!, columns); const writes: GoogleSheetValueRange[] = [];
    const values: Record<string, string | undefined> = { status: update.status, "worker id": update.workerId, "lease until": update.leaseUntil, "attempt id": update.attemptId, "last error": update.lastError, "proof id": update.proofId, "confirmation evidence": update.confirmationEvidence };
    for (const [name, value] of Object.entries(values)) if (value !== undefined && text((rows[rowIndex] ?? [])[columns[name]]) !== value) writes.push({ range: cell(this.config.sheetTab, columns[name]!, rowIndex + 1), values: [[value]] });
    if (writes.length) {
      await this.transport.updateValues(this.config.spreadsheetId, writes);
      const verified = await this.get(jobId);
      const property: Record<string, keyof SheetJobQueueRecord> = { status: "status", "worker id": "workerId", "lease until": "leaseUntil", "attempt id": "attemptId", "last error": "lastError", "proof id": "proofId", "confirmation evidence": "confirmationEvidence" };
      for (const [name, value] of Object.entries(values)) if (value !== undefined && text(verified[property[name]]) !== value) throw new Error(`Google Sheets job queue update verification failed for '${name}'.`);
      return verified;
    }
    return current;
  }

  async renew(jobId: string, workerId: string, attemptId: string, now = new Date()): Promise<ClaimedSheetJob> {
    const current = await this.get(jobId);
    if (current.workerId !== workerId || current.attemptId !== attemptId || !current.leaseUntil || (parseDate(current.leaseUntil) ?? 0) <= now.getTime()) throw new Error(`Google Sheets job queue claim was lost for '${jobId}'.`);
    const leaseUntil = new Date(now.getTime() + this.leaseMs).toISOString();
    const updated = await this.update(jobId, { status: current.status, workerId, attemptId, leaseUntil });
    if (!updated.leaseUntil || updated.leaseUntil !== leaseUntil) throw new Error(`Google Sheets job queue lease renewal could not be verified for '${jobId}'.`);
    return { ...updated, workerId, attemptId, leaseUntil };
  }

  async rereadBeforeSubmission(jobId: string): Promise<SheetJobQueueRecord> { const item = await this.get(jobId); if (!["Ready to Submit", "Applying"].includes(item.status)) throw new Error(`Job '${jobId}' is not in a submission-ready queue state.`); if (item.status === "Applying" && (!item.leaseUntil || (parseDate(item.leaseUntil) ?? 0) <= Date.now())) throw new Error(`Job '${jobId}' has an expired lease before submission.`); return item; }

  /** Preserve expired listings for audit; the queue never deletes rows. */
  async markExpired(jobId: string, reason = "Listing expired."): Promise<SheetJobQueueRecord> {
    return this.update(jobId, { status: "Expired", lastError: reason.slice(0, 500) });
  }

  /** Explicitly reopen one proof-free failed row for a bounded retry. */
  async requeueFailed(jobId: string): Promise<SheetJobQueueRecord> {
    const current = await this.get(jobId);
    if (current.status !== "Failed") throw new Error(`Only Failed queue jobs can be requeued ('${jobId}' is ${current.status}).`);
    if (current.proofId) throw new Error(`Queue job '${jobId}' has submission proof and cannot be requeued.`);
    return this.update(jobId, { status: "Ready", workerId: "", leaseUntil: "", attemptId: "", lastError: "" });
  }
}
