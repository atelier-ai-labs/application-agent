import type { GoogleSheetsJobQueue } from "./googleSheetsJobQueue";
import type { GoogleSheetsApiTransport } from "./googleSheetsJobTracker";
import { postingLinkKey } from "./postingLink";

/**
 * After the candidate taps a résumé in Slack for a posting that matched two
 * equally, write it as the Resume Version on the tracker row and the queue row
 * and put the queue row back to Ready. The next run applies with it: the
 * Resume Version breaks the tie. The tracker is written too because the daily
 * import copies the tracker's Resume Version over the queue's.
 */
export async function applyResumeChoiceToSheets(input: {
  transport: GoogleSheetsApiTransport;
  spreadsheetId: string;
  trackerTab: string;
  queue: Pick<GoogleSheetsJobQueue, "list" | "enrich" | "update">;
  company: string;
  role: string;
  links: readonly (string | undefined)[];
  resumeFamily: string;
}): Promise<string> {
  const key = (value: unknown) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const linkKeys = new Set(input.links.filter(Boolean).map(postingLinkKey));
  const sameJob = (company: unknown, role: unknown, link: unknown) =>
    linkKeys.has(postingLinkKey(link)) || (key(company) === key(input.company) && key(role) === key(input.role));

  const quoted = `'${input.trackerTab.replace(/'/g, "''")}'`;
  const rows = await input.transport.getValues(input.spreadsheetId, `${quoted}!A1:Z2000`);
  const header = (rows[0] ?? []).map((cell) => key(cell));
  const column = (name: string) => header.indexOf(key(name));
  const [company, role, link, resume] = [column("Company"), column("Role"), column("Job Link"), column("Resume Version")];
  const trackerRows = rows.flatMap((row, index) => (index > 0 && sameJob(row[company], row[role], row[link]) ? [index + 1] : []));
  if (resume >= 0 && trackerRows.length > 0) {
    let letter = "";
    for (let value = resume + 1; value > 0; value = Math.floor((value - 1) / 26)) letter = String.fromCharCode(65 + ((value - 1) % 26)) + letter;
    await input.transport.updateValues(input.spreadsheetId, trackerRows.map((row) => ({ range: `${quoted}!${letter}${row}`, values: [[input.resumeFamily]] })));
  }

  const waiting = (await input.queue.list()).filter((row) =>
    (row.status === "Needs Input" || row.status === "Failed") && !row.proofId && sameJob(row.company, row.role, row.jobLink));
  if (waiting.length !== 1) {
    return waiting.length === 0
      ? "no waiting queue row matched, so set it to Ready in the Sheet"
      : "more than one queue row matched, so set the right one to Ready in the Sheet";
  }
  await input.queue.enrich(waiting[0]!.jobId, { resumeVersion: input.resumeFamily });
  await input.queue.update(waiting[0]!.jobId, { status: "Ready", lastError: "", workerId: "", leaseUntil: "", attemptId: "" });
  return "queued for the next run";
}
