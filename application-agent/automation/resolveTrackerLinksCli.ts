import { loadEnv } from "vite";
import { createConfiguredGoogleSheetsTransport, type GoogleSheetsApiTransport, type GoogleSheetsEnvironment } from "./googleSheetsJobTracker";
import { GoogleSheetsJobQueue, QUEUE_DESTINATION_INPUT_MARKER } from "./googleSheetsJobQueue";
import { queueDestinationPreflightReason } from "./standaloneJobQueueWorker";
import { resolveDirectPostingLink, type DirectLinkResolution } from "./directLinkResolver";

/** Tracker statuses that mean the row needs no application work. */
const TERMINAL = new Set(["applied", "submitted", "confirmed", "rejected", "withdrawn", "expired", "skipped", "failed", "closed"]);

const key = (value: unknown) => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const quote = (tab: string) => `'${tab.replace(/'/g, "''")}'`;

function columnLetter(index: number): string {
  let value = index + 1;
  let letters = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

export interface TrackerLinkReport {
  row: number;
  company: string;
  role: string;
  oldLink: string;
  resolution: DirectLinkResolution;
  applied?: string;
}

/**
 * Finds active Job Tracker rows whose link the queue cannot open and, where a
 * verified direct posting exists, reports it (dry run) or writes it to the
 * tracker's Job Link cell and the matching queue row (apply).
 */
export async function resolveTrackerLinks(options: {
  transport: GoogleSheetsApiTransport;
  queue: GoogleSheetsJobQueue;
  spreadsheetId: string;
  trackerTab: string;
  apply: boolean;
  resolve?: typeof resolveDirectPostingLink;
  /** Rows already tried in this process; a long-running poller tries each once. */
  attempted?: Set<string>;
}): Promise<TrackerLinkReport[]> {
  const resolve = options.resolve ?? resolveDirectPostingLink;
  const range = `${quote(options.trackerTab)}!A1:Z500`;
  const rows = await options.transport.getValues(options.spreadsheetId, range);
  const header = (rows[0] ?? []).map(key);
  const column = (name: string) => header.indexOf(key(name));
  const [companyCol, roleCol, linkCol, statusCol] = [column("Company"), column("Role"), column("Job Link"), column("Status")];
  if ([companyCol, roleCol, linkCol, statusCol].some((index) => index < 0)) throw new Error("The tracker tab needs Company, Role, Job Link, and Status headers.");
  const queueRows = options.apply ? await options.queue.list() : [];
  const reports: TrackerLinkReport[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    const company = String(row[companyCol] ?? "").trim();
    const role = String(row[roleCol] ?? "").trim();
    const oldLink = String(row[linkCol] ?? "").trim();
    if (!company || !role || !oldLink || TERMINAL.has(key(row[statusCol]))) continue;
    if (!queueDestinationPreflightReason({ jobLink: oldLink })) continue;
    const attemptKey = `${key(company)}|${key(role)}|${oldLink}`;
    if (options.attempted?.has(attemptKey)) continue;
    options.attempted?.add(attemptKey);
    const resolution = await resolve({ company, role });
    const report: TrackerLinkReport = { row: index + 1, company, role, oldLink, resolution };
    reports.push(report);
    if (!options.apply || resolution.status !== "resolved") continue;

    // Re-read the exact row so a concurrent edit is never overwritten.
    const current = (await options.transport.getValues(options.spreadsheetId, `${quote(options.trackerTab)}!A${index + 1}:Z${index + 1}`))[0] ?? [];
    if (String(current[companyCol] ?? "").trim() !== company || String(current[roleCol] ?? "").trim() !== role || String(current[linkCol] ?? "").trim() !== oldLink) {
      report.applied = "skipped: the tracker row changed since it was read";
      continue;
    }
    await options.transport.updateValues(options.spreadsheetId, [{ range: `${quote(options.trackerTab)}!${columnLetter(linkCol)}${index + 1}`, values: [[resolution.url]] }]);

    const matches = queueRows.filter((item) => key(item.company) === key(company) && key(item.role) === key(role) &&
      !["Submitted", "Confirmed"].includes(item.status) && !item.proofId);
    if (matches.length === 1) {
      const queued = matches[0]!;
      await options.queue.updateSource(queued.jobId, { jobLink: resolution.url });
      const reopen = queued.status === "Needs Input" && queued.lastError?.includes(QUEUE_DESTINATION_INPUT_MARKER);
      if (reopen) await options.queue.update(queued.jobId, { status: "Ready", workerId: "", leaseUntil: "", attemptId: "", lastError: `Direct ${resolution.provider} posting found; reopened.` });
      report.applied = `tracker + queue updated${reopen ? " (reopened as Ready)" : ""}`;
    } else {
      report.applied = matches.length === 0 ? "tracker updated (new queue row on next sync)" : "tracker updated; several queue rows match, fix the queue manually";
    }
  }
  return reports;
}

async function main(): Promise<void> {
  const loaded = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
  for (const [name, value] of Object.entries(loaded)) if (process.env[name] === undefined) process.env[name] = value;
  const env = process.env as GoogleSheetsEnvironment & Record<string, string | undefined>;
  const spreadsheetId = env.ATELIER_GOOGLE_SHEET_ID?.trim();
  const spreadsheetName = env.ATELIER_GOOGLE_SHEET_NAME?.trim();
  if (!spreadsheetId || !spreadsheetName) throw new Error("ATELIER_GOOGLE_SHEET_ID and ATELIER_GOOGLE_SHEET_NAME are required.");
  const transport = createConfiguredGoogleSheetsTransport(env);
  const queue = new GoogleSheetsJobQueue({
    spreadsheetId,
    spreadsheetName,
    sheetTab: env.ATELIER_GOOGLE_SHEET_QUEUE_TAB?.trim() || "Application Queue",
    timeoutMs: 10_000,
  }, transport);
  const apply = process.argv.includes("--apply");
  const reports = await resolveTrackerLinks({ transport, queue, spreadsheetId, trackerTab: env.ATELIER_GOOGLE_SHEET_TAB?.trim() || "Job Tracker", apply });
  for (const report of reports) {
    const outcome = report.resolution.status === "resolved"
      ? `${report.resolution.url}  (${report.resolution.postingTitle}${report.resolution.postingLocation ? ` · ${report.resolution.postingLocation}` : ""})`
      : report.resolution.reason;
    console.log(`row ${report.row} | ${report.company} | ${report.role} | ${report.resolution.status} | ${outcome}${report.applied ? ` | ${report.applied}` : ""}`);
  }
  const resolved = reports.filter((report) => report.resolution.status === "resolved").length;
  console.log(`[career-agent-links] ${reports.length} rows checked, ${resolved} direct links found${apply ? "" : " (dry run; pass --apply to write them)"}.`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("resolveTrackerLinksCli.ts")) {
  void main().catch((error) => {
    console.error(`[career-agent-links] ${error instanceof Error ? error.message : "Link resolution failed."}`);
    process.exitCode = 1;
  });
}
