import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnv } from "vite";
import { classifyJobEmail, type JobEmailKind } from "../src/domain/jobEmailClassifier";
export { GMAIL_JOB_QUERY, gmailInbox, type InboxEmail, type InboxSource, type RecentEmailOptions } from "./gmailInbox";
import { gmailInbox, type InboxEmail, type InboxSource } from "./gmailInbox";
import { createGoogleOAuthAccessTokenProvider, gmailSecurityCodesEnabled } from "./googleOAuth";
import { createConfiguredGoogleSheetsTransport, type GoogleSheetsApiTransport, type GoogleSheetsEnvironment } from "./googleSheetsJobTracker";
import { resolveSlackConfig } from "./slack/config";
import { SlackNotificationAdapter } from "./slack/slackNotificationAdapter";

/**
 * Reads application emails (read-only) and keeps the Job Tracker current:
 * rejections set Rejected, callbacks set Interviewing and ping Slack, and
 * "application received" confirms Applied. Each email is handled once.
 */
export type InboxDecision =
  | { email: string; kind: JobEmailKind; action: "updated"; row: number; company: string; role: string; status: string }
  | { email: string; kind: JobEmailKind; action: "notify" | "skipped"; reason: string; company?: string };

/** Company names that are ordinary words and must not match from an email body. */
const COMMON_WORDS = new Set(["future", "plane", "span", "phantom", "clair", "pogo", "reflow", "implicit", "upstart", "instructure", "outmarket"]);
const CLOSED = new Set(["withdrawn", "expired"]);
const key = (value: unknown) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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

function companyKey(company: string): string {
  return key(company).replace(/\b(?:inc|llc|corp|corporation|co|ltd|technologies|the)\b/g, " ").replace(/\s+/g, " ").trim();
}

function hasWord(text: string, phrase: string): boolean {
  return Boolean(phrase) && new RegExp(`(?:^|[^a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`).test(text);
}

/** Tracker row indexes this email is about; sender and subject are trusted, the body only for distinctive names. */
function matchingRows(email: InboxEmail, rows: readonly (readonly unknown[])[], companyCol: number, roleCol: number): number[] {
  const header = key(`${email.from} ${email.subject}`);
  const senderDomain = key((/@([a-z0-9.-]+)/i.exec(email.from)?.[1] ?? "").replace(/\.[a-z]+$/, ""));
  const body = email.text.slice(0, 4_000);
  const byCompany = new Map<string, number[]>();
  for (let index = 1; index < rows.length; index += 1) {
    const company = String(rows[index]![companyCol] ?? "").trim();
    const name = companyKey(company);
    if (!name) continue;
    const compact = name.replace(/ /g, "");
    const inHeader = hasWord(header, name) || (compact.length >= 4 && senderDomain.replace(/ /g, "").includes(compact));
    const inBody = !COMMON_WORDS.has(name) && name.length >= 5 && new RegExp(`\\b${company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(body);
    if (inHeader || inBody) byCompany.set(name, [...(byCompany.get(name) ?? []), index]);
  }
  if (byCompany.size !== 1) return [];
  const candidates = [...byCompany.values()][0]!;
  if (candidates.length === 1) return candidates;
  // Several roles at one company: keep those whose title the email names.
  const text = key(`${email.subject} ${body}`);
  const named = candidates.filter((index) => hasWord(text, key(rows[index]![roleCol])));
  return named.length > 0 ? named : candidates;
}

export interface CheckInboxOptions {
  inbox: InboxSource;
  transport: GoogleSheetsApiTransport;
  spreadsheetId: string;
  trackerTab: string;
  apply: boolean;
  processed: Set<string>;
  sinceDays?: number;
  notify?: (text: string) => Promise<void>;
}

export async function checkInboxForTracker(options: CheckInboxOptions): Promise<InboxDecision[]> {
  const rows = await options.transport.getValues(options.spreadsheetId, `${quote(options.trackerTab)}!A1:Z1000`);
  const header = (rows[0] ?? []).map((cell) => key(cell));
  const col = (name: string) => header.indexOf(key(name));
  const [companyCol, roleCol, statusCol, notesCol, nextCol, followCol, appliedCol] =
    ["Company", "Role", "Status", "Notes", "Next Step", "Follow-Up Date", "Date Applied"].map(col) as [number, number, number, number, number, number, number];
  if (companyCol < 0 || roleCol < 0 || statusCol < 0) throw new Error("The tracker tab needs Company, Role, and Status columns.");

  const decisions: InboxDecision[] = [];
  const emails = [...await options.inbox.recentEmails(options.sinceDays ?? 14)].sort((left, right) => left.receivedAt.localeCompare(right.receivedAt));
  for (const email of emails) {
    if (options.processed.has(email.id)) continue;
    const kind = classifyJobEmail(email);
    const label = `${email.subject.slice(0, 80)} (${email.receivedAt.slice(0, 10)})`;
    const done = () => { if (options.apply) options.processed.add(email.id); };
    if (kind === "not_job") { done(); continue; }
    const matches = matchingRows(email, rows, companyCol, roleCol);
    // A "thanks for applying" email only ever moves a Researching row to
    // Applied. When every matching row is already past that, it changes
    // nothing, so there is nothing to ask about.
    if (kind === "received" && matches.length > 1 &&
      matches.every((index) => !["researching", ""].includes(key(String(rows[index]?.[statusCol] ?? "").trim())))) {
      decisions.push({ email: label, kind, action: "skipped", reason: "every matching row is already past Applied" });
      done();
      continue;
    }
    if (matches.length !== 1) {
      const reason = matches.length === 0 ? "no tracker row matched" : "several tracker rows matched";
      // Ping only when the email is plausibly ours: several matching rows, or
      // a callback from a hiring system. Newsletters that merely say
      // "application" or "interview" match no row and stay quiet.
      const fromHiringSystem = /@(?:[a-z0-9-]+\.)*(?:greenhouse-mail\.io|greenhouse\.io|lever\.co|ashbyhq\.com|myworkday\.com|workday\.com|icims\.com|smartrecruiters\.com|jobvite\.com|rippling\.com|bamboohr\.com|breezy\.hr|workable\.com|recruitee\.com)\b/i.test(email.from);
      if (matches.length > 1 || (kind === "interview" && fromHiringSystem)) {
        decisions.push({ email: label, kind, action: "notify", reason });
        if (options.apply) await options.notify?.(`Inbox: a ${kind === "interview" ? "possible callback" : "job email"} needs a look (${reason}): "${email.subject}" from ${email.from}, ${email.receivedAt.slice(0, 10)}.`);
      } else {
        decisions.push({ email: label, kind, action: "skipped", reason });
      }
      done();
      continue;
    }
    const index = matches[0]!;
    const row = rows[index]!;
    const company = String(row[companyCol] ?? "").trim();
    const role = String(row[roleCol] ?? "").trim();
    const current = String(row[statusCol] ?? "").trim();
    const date = new Date(email.receivedAt);
    const usDate = `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}/${date.getUTCFullYear()}`;
    const writes: { col: number; value: string }[] = [];
    const note = (text: string) => notesCol >= 0 && writes.push({ col: notesCol, value: [String(row[notesCol] ?? "").trim(), `${usDate}: ${text} (email "${email.subject.slice(0, 80)}").`].filter(Boolean).join(" ") });
    let status = current;
    if (kind === "unclear") {
      decisions.push({ email: label, kind, action: "notify", reason: "wording was not clear", company });
      if (options.apply) await options.notify?.(`Inbox: an email about ${company} — ${role} needs a look: "${email.subject}", ${email.receivedAt.slice(0, 10)}.`);
      done();
      continue;
    }
    if (CLOSED.has(key(current)) && kind !== "interview") {
      decisions.push({ email: label, kind, action: "skipped", reason: `row is already ${current}`, company });
      done();
      continue;
    }
    if (kind === "rejection" && key(current) !== "rejected") {
      status = "Rejected";
      note("Rejected");
    } else if (kind === "interview" && key(current) !== "interviewing") {
      status = "Interviewing";
      note("Callback / interview request");
      if (nextCol >= 0) writes.push({ col: nextCol, value: `Reply to ${company}'s email to schedule` });
      if (followCol >= 0) writes.push({ col: followCol, value: usDate });
    } else if (kind === "received" && ["researching", ""].includes(key(current))) {
      status = "Applied";
      note("Application received");
      if (appliedCol >= 0 && !String(row[appliedCol] ?? "").trim()) writes.push({ col: appliedCol, value: usDate });
    }
    if (status === current) {
      decisions.push({ email: label, kind, action: "skipped", reason: `row already ${current || "set"}`, company });
      done();
      continue;
    }
    writes.push({ col: statusCol, value: status });
    decisions.push({ email: label, kind, action: "updated", row: index + 1, company, role, status });
    if (options.apply) {
      await options.transport.updateValues(options.spreadsheetId, writes.map((write) => ({
        range: `${quote(options.trackerTab)}!${columnLetter(write.col)}${index + 1}`,
        values: [[write.value]],
      })));
      // Later emails in this run see the new status.
      (rows[index] as unknown[])[statusCol] = status;
      if (kind === "interview") await options.notify?.(`Callback: ${company} — ${role} replied ("${email.subject}", ${email.receivedAt.slice(0, 10)}). The tracker now says Interviewing; reply to schedule.`);
    }
    done();
  }
  return decisions;
}

const PROCESSED_FILE = ".local/career-agent/inbox-processed.json";
export const INBOX_LOG_FILE = ".local/career-agent/inbox-log.jsonl";

/** Entry point for `npm run career-agent:inbox` (dry run unless `--apply`). */
export async function runInboxCommand(argv: readonly string[] = process.argv): Promise<void> {
  const loaded = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
  for (const [name, value] of Object.entries(loaded)) if (process.env[name] === undefined) process.env[name] = value;
  const env = process.env as GoogleSheetsEnvironment & Record<string, string | undefined>;
  if (!gmailSecurityCodesEnabled(env)) throw new Error("Gmail access is off; set ATELIER_GMAIL_SECURITY_CODES=true and re-run career-agent:google-auth.");
  const spreadsheetId = env.ATELIER_GOOGLE_SHEET_ID?.trim();
  if (!spreadsheetId) throw new Error("ATELIER_GOOGLE_SHEET_ID is required.");
  const apply = argv.includes("--apply");
  const daysFlag = argv.indexOf("--days");
  const sinceDays = daysFlag >= 0 ? Math.min(365, Math.max(1, Number(argv[daysFlag + 1]) || 14)) : 14;
  const processedPath = resolve(env.ATELIER_CAREER_AGENT_INBOX_STATE_FILE?.trim() || PROCESSED_FILE);
  const processed = new Set<string>(existsSync(processedPath) ? JSON.parse(readFileSync(processedPath, "utf8")) as string[] : []);
  const tokens = createGoogleOAuthAccessTokenProvider(env, 10_000);
  let slack: SlackNotificationAdapter | undefined;
  try { slack = new SlackNotificationAdapter({ config: resolveSlackConfig(env as never) }); } catch { slack = undefined; }
  const decisions = await checkInboxForTracker({
    inbox: gmailInbox(() => tokens.getAccessToken()),
    transport: createConfiguredGoogleSheetsTransport(env),
    spreadsheetId,
    trackerTab: env.ATELIER_GOOGLE_SHEET_TAB?.trim() || "Job Tracker",
    apply,
    processed,
    sinceDays,
    ...(slack ? { notify: (text: string) => slack!.publishInfoNotice(text) } : {}),
  });
  if (apply) {
    mkdirSync(dirname(processedPath), { recursive: true });
    writeFileSync(processedPath, JSON.stringify([...processed].slice(-5_000)) + "\n");
    // Outcome log for the application history report.
    const at = new Date().toISOString();
    const outcomes = decisions.filter((decision) => decision.action !== "skipped");
    if (outcomes.length > 0) appendFileSync(resolve(INBOX_LOG_FILE), outcomes.map((decision) => JSON.stringify({ at, ...decision })).join("\n") + "\n");
  }
  for (const decision of decisions) {
    console.log(decision.action === "updated"
      ? `~ row ${decision.row} ${decision.company} — ${decision.role}: ${decision.status} [${decision.kind}] ${decision.email}`
      : `${decision.action === "notify" ? "!" : "-"} ${decision.kind}${decision.company ? ` ${decision.company}` : ""}: ${decision.reason} — ${decision.email}`);
  }
  console.log(`[career-agent-inbox] ${decisions.filter((decision) => decision.action === "updated").length} tracker updates${apply ? "" : " (dry run; pass --apply to write them)"}.`);
}
