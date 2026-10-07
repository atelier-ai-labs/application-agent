import { classifyJobUrl } from "../src/domain/jobUrlClassifier";
import { GoogleSheetsJobQueue, QUEUE_DESTINATION_INPUT_MARKER, type SheetJobQueueRecord } from "./googleSheetsJobQueue";
import type { GoogleSheetsApiTransport, GoogleSheetValueRange } from "./googleSheetsJobTracker";

const MAX_ROWS = 1_000;
const TERMINAL = new Set(["applied", "submitted", "confirmed", "rejected", "withdrawn", "expired", "skipped", "failed", "closed"]);
const APPLIED = new Set(["applied", "submitted", "confirmed"]);
const RECOVERABLE_QUEUE_SKIP = /not an executable verified|unsupported|unverifiable|needs review/i;
const key = (value: unknown) => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const identity = (company: string, role: string) => `${key(company).replace(/\b(?:llc|inc|incorporated|corp|corporation|co|company|ltd|limited)\b/g, " ").replace(/\s+/g, " ").trim()}::${key(role)}`;
const value = (row: readonly unknown[], columns: Record<string, number>, ...names: string[]) => {
  for (const name of names) { const index = columns[key(name)]; if (index !== undefined) { const text = String(row[index] ?? "").trim(); if (text) return text; } }
  return "";
};
function stableId(sourceId: string, link: string): string {
  if (sourceId) return `tracker:${sourceId}`;
  let hash = 2166136261;
  for (const char of link) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return `tracker-url:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
function quote(tab: string): string { return `'${tab.replace(/'/g, "''")}'`; }

export interface QueueImportResult { considered: number; promoted: number; reopened: number; updatedSource: number; enriched: number; skippedTerminal: number; skippedDuplicate: number; skippedAppliedDuplicate: number; reconciledTerminal: number; dryRun: boolean; jobIds: readonly string[]; }

/** Reconcile active tracker rows into the dedicated queue without duplicating source records. */
export async function importTrackerRowsToQueue(
  queue: GoogleSheetsJobQueue,
  transport: GoogleSheetsApiTransport,
  spreadsheetId: string,
  trackerTab = "Job Tracker",
  dryRun = true,
): Promise<QueueImportResult> {
  const existing = await queue.list();
  const existingIds = new Set(existing.map((row) => row.jobId));
  const existingSources = new Set(existing.map((row) => row.sourceRecordId).filter(Boolean));
  const existingLinks = new Set(existing.map((row) => classifyJobUrl(row.jobLink).canonicalUrl ?? row.jobLink));
  const rows = await transport.getValues(spreadsheetId, `${quote(trackerTab)}!A1:Z${MAX_ROWS}`);
  if (!rows.length) throw new Error(`Tracker tab '${trackerTab}' has no header row.`);
  const columns: Record<string, number> = {};
  for (let i = 0; i < (rows[0] ?? []).length; i += 1) columns[key(rows[0]![i])] = i;
  const normalized: { row: number; record: SheetJobQueueRecord }[] = [];
  const enrichments: { jobId: string; context: Pick<SheetJobQueueRecord, "location" | "description" | "resumeVersion" | "priority" | "fit"> }[] = [];
  const sourceUpdates: { jobId: string; company: string; role: string; jobLink: string; sourceRecordId: string }[] = [];
  const reopenedRows: { jobId: string; reason: string }[] = [];
  const appliedDuplicateRows: { jobId: string; reason: string }[] = [];
  let considered = 0; let reopened = 0; let updatedSource = 0; let skippedTerminal = 0; let skippedDuplicate = 0; let skippedAppliedDuplicate = 0; let reconciledTerminal = 0;
  const terminalQueueUpdates: { jobId: string; reason: string }[] = [];
  const appliedTrackerIdentities = new Set<string>();
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i] ?? [];
    if (!row.length || row.every((cell) => String(cell ?? "").trim() === "")) continue;
    const status = value(row, columns, "Status").toLowerCase();
    if (!APPLIED.has(status)) continue;
    const company = value(row, columns, "Company");
    const role = value(row, columns, "Role", "Title", "Job Title");
    if (company && role) appliedTrackerIdentities.add(identity(company, role));
  }
  for (let i = 1; i < rows.length; i += 1) {
    const sourceStatus = value(rows[i]!, columns, "Status");
    if (!sourceStatus && (rows[i] ?? []).every((cell) => String(cell ?? "").trim() === "")) continue;
    considered += 1;
    const company = value(rows[i]!, columns, "Company");
    const role = value(rows[i]!, columns, "Role", "Title", "Job Title");
    const jobLink = value(rows[i]!, columns, "Job Link", "Job URL", "URL", "Link");
    const suppliedSourceRecordId = value(rows[i]!, columns, "Source Record ID", "Record ID", "ID");
    const canonicalLink = jobLink ? (classifyJobUrl(jobLink).canonicalUrl ?? jobLink) : jobLink;
    const sourceRecordId = suppliedSourceRecordId || stableId("", canonicalLink);
    const jobId = stableId(suppliedSourceRecordId, canonicalLink);
    const existingJob = existing.find((candidate) => candidate.jobId === jobId || candidate.sourceRecordId === sourceRecordId || candidate.jobLink === canonicalLink);
    if (TERMINAL.has(sourceStatus.toLowerCase())) {
      skippedTerminal += 1;
      // Job Tracker is the source of truth for whether a posting has already
      // been applied/closed. A stale queue blocker must not be retried after
      // the tracker has reached a terminal state, because doing so could
      // submit a duplicate application.
      if (!dryRun && existingJob && existingJob.status === "Needs Input" && !existingJob.proofId) {
        terminalQueueUpdates.push({ jobId: existingJob.jobId, reason: `Skipped — the Job Tracker is already ${sourceStatus}; the queue will not retry this posting.` });
      }
      continue;
    }
    const location = value(rows[i]!, columns, "Location", "Location/Remote", "Remote");
    const description = value(rows[i]!, columns, "Description/Notes", "Description", "Notes", "Next Step");
    const employmentType = value(rows[i]!, columns, "Employment Type", "Employment", "Type");
    const resumeVersion = value(rows[i]!, columns, "Resume Version", "Resume", "Resume Family");
    const priority = value(rows[i]!, columns, "Priority");
    const fit = value(rows[i]!, columns, "Fit", "Fit Score");
    if (!company || !role || !jobLink) throw new Error(`Tracker row ${i + 1} is actionable but missing Company, Role, or Job Link.`);
    const classification = classifyJobUrl(jobLink);
    if (classification.kind === "unknown") throw new Error(`Tracker row ${i + 1} has an unsupported or unverifiable Job Link.`);
    if (appliedTrackerIdentities.has(identity(company, role))) {
      skippedAppliedDuplicate += 1;
      if (!dryRun && existingJob && !["Submitted", "Confirmed"].includes(existingJob.status) && !existingJob.proofId) {
        appliedDuplicateRows.push({ jobId: existingJob.jobId, reason: `Skipped — another Job Tracker row for ${company} / ${role} is already Applied; the queue will not retry this posting.` });
      }
      continue;
    }
    const sourceChanged = Boolean(existingJob && (existingJob.company !== company || existingJob.role !== role || existingJob.jobLink !== canonicalLink || existingJob.sourceRecordId !== sourceRecordId));
    if (existingJob && sourceChanged && !existingJob.proofId && !["Submitted", "Confirmed"].includes(existingJob.status)) {
      sourceUpdates.push({ jobId: existingJob.jobId, company, role, jobLink: canonicalLink, sourceRecordId });
      updatedSource += 1;
    }
    const groundedDescription = [employmentType ? `Employment Type: ${employmentType}` : "", description].filter(Boolean).join("\n");
    if (existingIds.has(jobId) || existingSources.has(sourceRecordId) || existingLinks.has(canonicalLink)) {
      const routeNeedsReopen = Boolean(existingJob && !existingJob.proofId && (
        existingJob.status === "Skipped" && RECOVERABLE_QUEUE_SKIP.test(existingJob.lastError ?? "") && !existingJob.lastError?.includes(QUEUE_DESTINATION_INPUT_MARKER) ||
        existingJob.status === "Needs Input" && existingJob.lastError?.includes(QUEUE_DESTINATION_INPUT_MARKER) && sourceChanged
      ));
      if (routeNeedsReopen && existingJob) {
        reopened += 1;
        if (!dryRun) reopenedRows.push({ jobId: existingJob.jobId, reason: `${QUEUE_DESTINATION_INPUT_MARKER} Active Job Tracker row is being reopened for application-destination review.` });
      }
      skippedDuplicate += 1;
      if (existingJob && (location || groundedDescription || resumeVersion || priority || fit)) enrichments.push({ jobId: existingJob.jobId, context: { ...(location ? { location } : {}), ...(groundedDescription ? { description: groundedDescription } : {}), ...(resumeVersion ? { resumeVersion } : {}), ...(priority ? { priority } : {}), ...(fit ? { fit } : {}) } });
      continue;
    }
    existingIds.add(jobId); existingSources.add(sourceRecordId); existingLinks.add(canonicalLink);
    normalized.push({ row: i + 1, record: { jobId, company, role, jobLink: canonicalLink, sourceRecordId, status: "Ready", ...(location ? { location } : {}), ...(groundedDescription ? { description: groundedDescription } : {}), ...(resumeVersion ? { resumeVersion } : {}), ...(priority ? { priority } : {}), ...(fit ? { fit } : {}) } });
  }
  if (!dryRun) {
    for (const update of sourceUpdates) {
      await queue.updateSource(update.jobId, update);
    }
    for (const update of reopenedRows) {
      await queue.update(update.jobId, { status: "Ready", workerId: "", leaseUntil: "", attemptId: "", lastError: update.reason });
    }
    for (const update of terminalQueueUpdates) {
      await queue.update(update.jobId, { status: "Skipped", workerId: "", leaseUntil: "", attemptId: "", lastError: update.reason });
      reconciledTerminal += 1;
    }
    for (const update of appliedDuplicateRows) {
      await queue.update(update.jobId, { status: "Skipped", workerId: "", leaseUntil: "", attemptId: "", lastError: update.reason });
    }
    await queue.enrichMany(enrichments);
  }
  if (!dryRun && normalized.length) {
    const queueRows = await transport.getValues(spreadsheetId, `${quote(queue.sheetTab)}!A1:Q${MAX_ROWS}`);
    const start = queueRows.length + 1;
    const sheetTab = queue.sheetTab;
    const writes: GoogleSheetValueRange[] = normalized.map(({ record }, offset) => ({ range: `${quote(sheetTab)}!A${start + offset}:Q${start + offset}`, values: [[record.jobId, record.company, record.role, record.jobLink, record.sourceRecordId ?? "", record.status, "", "", "", "", "", "", record.location ?? "", record.description ?? "", record.resumeVersion ?? "", record.priority ?? "", record.fit ?? ""]] }));
    await transport.updateValues(spreadsheetId, writes);
    const after = await queue.list();
    for (const { record } of normalized) if (!after.some((row) => row.jobId === record.jobId)) throw new Error(`Queue import could not verify '${record.jobId}'.`);
  }
  return { considered, promoted: normalized.length, reopened, updatedSource, enriched: dryRun ? 0 : enrichments.length, skippedTerminal, skippedDuplicate, skippedAppliedDuplicate, reconciledTerminal, dryRun, jobIds: normalized.map(({ record }) => record.jobId) };
}
