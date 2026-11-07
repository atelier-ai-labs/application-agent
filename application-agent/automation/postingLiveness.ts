import { loadEnv } from "vite";
import { createConfiguredGoogleSheetsTransport, type GoogleSheetsApiTransport, type GoogleSheetsEnvironment } from "./googleSheetsJobTracker";
import { GoogleSheetsJobQueue } from "./googleSheetsJobQueue";
import { postingLinkKey } from "./postingLink";

/**
 * Nightly "is it still open?" check. A tracker row only learned its posting
 * had closed when the agent tried to apply, and only on the boards it starts
 * by itself, so closed jobs sat in Researching/Ready forever. This asks each
 * board's public API (Greenhouse, Lever, Ashby, Workday) or reads the page for
 * an explicit "no longer available" notice, and marks closed jobs Expired in
 * the tracker and the queue. Anything it cannot tell is left alone.
 */
export type PostingState = { state: "open" } | { state: "closed"; reason: string } | { state: "unknown"; reason: string };

export interface HttpResponseLike { status: number; ok: boolean; text(): Promise<string> }
export type HttpGet = (url: string, init?: { method?: "GET" | "POST"; body?: string; accept?: string }) => Promise<HttpResponseLike | undefined>;

const defaultGet: HttpGet = async (url, init = {}) => {
  try {
    return await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        accept: init.accept ?? "application/json",
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return undefined;
  }
};

/** Wording job pages use once a posting is gone. Only these phrases close a non-API page. */
const CLOSED_PAGE = /\b(?:no longer accepting (?:applications|candidates)|position closed|(?:this|the) (?:job|position|posting|role|requisition) (?:is |has been )?(?:no longer (?:available|open|active)|closed|filled|expired|removed)|job (?:posting )?(?:has )?expired|position has been filled|page you are looking for doesn'?t exist|job (?:you(?:'re| are) looking for )?(?:is )?no longer available)\b/i;

async function boardAnswer(get: HttpGet, postingUrl: string, boardUrl: string, label: string, closedStatuses = [404, 410]): Promise<PostingState> {
  const posting = await get(postingUrl);
  if (!posting) return { state: "unknown", reason: `${label} did not answer` };
  if (posting.ok) return { state: "open" };
  if (!closedStatuses.includes(posting.status)) return { state: "unknown", reason: `${label} answered ${posting.status}` };
  // The posting is missing: only call it closed when the board itself still answers (a typo'd board is not a closed job).
  const board = await get(boardUrl);
  return board?.ok ? { state: "closed", reason: `${label} no longer lists this posting` } : { state: "unknown", reason: `${label} board did not answer` };
}

export async function checkPostingOpen(link: string, get: HttpGet = defaultGet): Promise<PostingState> {
  let url: URL;
  try { url = new URL(link.trim()); } catch { return { state: "unknown", reason: "not a link" }; }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);

  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const slug = parts[0];
    const id = parts[1] === "jobs" ? parts[2] : url.searchParams.get("token") ?? undefined;
    if (!slug || slug === "embed" || !id || !/^\d+$/.test(id)) return { state: "unknown", reason: "not a Greenhouse posting link" };
    return boardAnswer(get, `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${id}`, `https://boards-api.greenhouse.io/v1/boards/${slug}`, "Greenhouse");
  }
  if (/(^|\.)lever\.co$/.test(host) && parts[0] && parts[1] && /^[0-9a-f-]{36}$/i.test(parts[1])) {
    return boardAnswer(get, `https://api.lever.co/v0/postings/${parts[0]}/${parts[1]}`, `https://api.lever.co/v0/postings/${parts[0]}?limit=1`, "Lever");
  }
  if (host === "jobs.ashbyhq.com" && parts[0] && parts[1] && /^[0-9a-f-]{36}$/i.test(parts[1])) {
    const board = await get(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(decodeURIComponent(parts[0]))}`);
    if (!board?.ok) return { state: "unknown", reason: "Ashby board did not answer" };
    const jobs = (JSON.parse(await board.text()) as { jobs?: { id?: string }[] }).jobs;
    if (!Array.isArray(jobs)) return { state: "unknown", reason: "Ashby board was unreadable" };
    return jobs.some((job) => job.id?.toLowerCase() === parts[1]!.toLowerCase()) ? { state: "open" } : { state: "closed", reason: "Ashby no longer lists this posting" };
  }
  if (/\.myworkdayjobs\.com$/.test(host)) {
    // https://<tenant>.wdN.myworkdayjobs.com/[en-US/]<site>/job/<location>/<title_id>[/apply...]
    const tenant = host.split(".")[0]!;
    const rest = /^[a-z]{2}-[A-Z]{2}$/.test(parts[0] ?? "") ? parts.slice(1) : parts;
    const jobAt = rest.indexOf("job");
    if (jobAt < 1) return { state: "unknown", reason: "not a Workday posting link" };
    const site = rest[0]!;
    const applyAt = rest.indexOf("apply");
    const path = rest.slice(jobAt, applyAt > jobAt ? applyAt : undefined).join("/");
    const api = `https://${host}/wday/cxs/${tenant}/${site}`;
    const posting = await get(`${api}/${path}`);
    if (!posting) return { state: "unknown", reason: "Workday did not answer" };
    if (posting.ok) {
      const info = (JSON.parse(await posting.text()) as { jobPostingInfo?: { canApply?: boolean } }).jobPostingInfo;
      if (info) return info.canApply === false ? { state: "closed", reason: "Workday no longer takes applications for this posting" } : { state: "open" };
    } else if (![403, 404, 410, 422].includes(posting.status)) {
      // Workday answers 403/422 (not 404) for a posting it no longer serves; the site check below tells that apart from a block.
      return { state: "unknown", reason: `Workday answered ${posting.status}` };
    }
    const board = await get(`${api}/jobs`, { method: "POST", body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: "" }) });
    return board?.ok ? { state: "closed", reason: "Workday no longer lists this posting" } : { state: "unknown", reason: "Workday site did not answer" };
  }

  // Any other page: closed only on 404/410 or an explicit "no longer available" notice.
  const page = await get(url.toString(), { accept: "text/html" });
  if (!page) return { state: "unknown", reason: "the page did not answer" };
  if (page.status === 404 || page.status === 410) return { state: "closed", reason: `the job page returned ${page.status}` };
  if (!page.ok) return { state: "unknown", reason: `the page answered ${page.status}` };
  const text = (await page.text()).slice(0, 2_000_000).replace(/<[^>]+>/g, " ").replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, " ");
  const closed = CLOSED_PAGE.exec(text);
  return closed ? { state: "closed", reason: `the job page says "${closed[0].slice(0, 80)}"` } : { state: "open" };
}

/** Tracker statuses that need no check: the job is done one way or another. */
const DONE = new Set(["applied", "submitted", "confirmed", "rejected", "withdrawn", "expired", "skipped", "failed", "closed", "interviewing", "offer"]);
/** Queue rows that are in the middle of something are never touched. */
const BUSY_QUEUE = new Set(["Claimed", "Applying", "Ready to Submit", "Submitted", "Confirmed", "Expired"]);

export interface LivenessReport { row: number; company: string; role: string; link: string; result: PostingState; applied?: string }

export async function expireClosedPostings(options: {
  transport: GoogleSheetsApiTransport;
  queue: Pick<GoogleSheetsJobQueue, "list" | "markExpired">;
  spreadsheetId: string;
  trackerTab: string;
  apply: boolean;
  check?: (link: string) => Promise<PostingState>;
  today?: string;
}): Promise<LivenessReport[]> {
  const check = options.check ?? ((link: string) => checkPostingOpen(link));
  const key = (value: unknown) => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const quoted = `'${options.trackerTab.replace(/'/g, "''")}'`;
  const rows = await options.transport.getValues(options.spreadsheetId, `${quoted}!A1:Z2000`);
  const header = (rows[0] ?? []).map(key);
  const col = (name: string) => header.indexOf(key(name));
  const [company, role, link, status, notes] = [col("Company"), col("Role"), col("Job Link"), col("Status"), col("Notes")];
  if ([company, role, link, status].some((index) => index < 0)) throw new Error("The tracker tab needs Company, Role, Job Link, and Status headers.");
  const letter = (index: number) => { let out = ""; for (let v = index + 1; v > 0; v = Math.floor((v - 1) / 26)) out = String.fromCharCode(65 + ((v - 1) % 26)) + out; return out; };
  const queueRows = await options.queue.list();
  const reports: LivenessReport[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    const jobLink = String(row[link] ?? "").trim();
    if (!jobLink || !String(row[company] ?? "").trim() || DONE.has(key(row[status]))) continue;
    const matches = queueRows.filter((item) => postingLinkKey(item.jobLink) === postingLinkKey(jobLink) ||
      (key(item.company) === key(row[company]) && key(item.role) === key(row[role])));
    // Leave alone anything the agent is in the middle of.
    if (matches.some((item) => BUSY_QUEUE.has(item.status) && item.status !== "Expired")) continue;
    const result = await check(jobLink);
    const report: LivenessReport = { row: index + 1, company: String(row[company]), role: String(row[role]), link: jobLink, result };
    reports.push(report);
    if (!options.apply || result.state !== "closed") continue;

    // Re-read the row so a concurrent edit is never overwritten.
    const current = (await options.transport.getValues(options.spreadsheetId, `${quoted}!A${index + 1}:Z${index + 1}`))[0] ?? [];
    if (String(current[link] ?? "").trim() !== jobLink || DONE.has(key(current[status]))) { report.applied = "skipped: the row changed"; continue; }
    const note = `Posting closed (checked ${options.today ?? new Date().toLocaleDateString("en-US")}: ${result.reason}).`;
    const writes = [{ range: `${quoted}!${letter(status)}${index + 1}`, values: [["Expired"]] }];
    if (notes >= 0) writes.push({ range: `${quoted}!${letter(notes)}${index + 1}`, values: [[[String(current[notes] ?? "").trim(), note].filter(Boolean).join(" ").slice(0, 1000)]] });
    await options.transport.updateValues(options.spreadsheetId, writes);
    const open = matches.filter((item) => !BUSY_QUEUE.has(item.status) && !item.proofId);
    for (const item of open) await options.queue.markExpired(item.jobId, note);
    report.applied = `tracker${open.length ? ` + ${open.length} queue row${open.length === 1 ? "" : "s"}` : ""} marked Expired`;
  }
  return reports;
}

/** Entry point for `npm run career-agent:check-open` (dry run unless `--apply`). */
export async function runCheckOpenCommand(): Promise<void> {
  const loaded = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
  for (const [name, value] of Object.entries(loaded)) if (process.env[name] === undefined) process.env[name] = value;
  const env = process.env as GoogleSheetsEnvironment & Record<string, string | undefined>;
  const spreadsheetId = env.ATELIER_GOOGLE_SHEET_ID?.trim();
  const spreadsheetName = env.ATELIER_GOOGLE_SHEET_NAME?.trim();
  if (!spreadsheetId || !spreadsheetName) throw new Error("ATELIER_GOOGLE_SHEET_ID and ATELIER_GOOGLE_SHEET_NAME are required.");
  const transport = createConfiguredGoogleSheetsTransport(env);
  const queue = new GoogleSheetsJobQueue({ spreadsheetId, spreadsheetName, sheetTab: env.ATELIER_GOOGLE_SHEET_QUEUE_TAB?.trim() || "Application Queue", timeoutMs: 10_000 }, transport);
  const apply = process.argv.includes("--apply");
  const reports = await expireClosedPostings({ transport, queue, spreadsheetId, trackerTab: env.ATELIER_GOOGLE_SHEET_TAB?.trim() || "Job Tracker", apply });
  for (const report of reports) {
    if (report.result.state === "open") continue;
    console.log(`${report.result.state === "closed" ? "x" : "?"} row ${report.row} | ${report.company} | ${report.role} | ${report.result.reason}${report.applied ? ` | ${report.applied}` : ""}`);
  }
  const closed = reports.filter((report) => report.result.state === "closed").length;
  const open = reports.filter((report) => report.result.state === "open").length;
  console.log(`[career-agent-open] ${reports.length} open jobs checked: ${open} still open, ${closed} closed, ${reports.length - open - closed} unknown${apply ? "" : " (dry run; pass --apply to mark closed ones Expired)"}.`);
}
