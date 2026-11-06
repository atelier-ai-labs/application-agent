import { loadEnv } from "vite";
import { assessFit } from "../src/domain/fit";
import { parseCandidateProfile } from "../src/domain/profile";
import { screenDiscoveredJob, type DiscoveryScreen } from "../src/domain/discoveryFilter";
import type { JobScout, ScoutedJob } from "../src/domain/scout";
import type { JobSearchIntent } from "../src/domain/searchIntent";
import type { CandidateProfile, FitClassification } from "../src/domain/types";
import type { CreateCampaignInput } from "../src/domain/campaignTypes";
import { resolveDirectPostingLink } from "./directLinkResolver";
import { queueDestinationPreflightReason } from "./standaloneJobQueueWorker";
import { createConfiguredGoogleSheetsTransport, type GoogleSheetsApiTransport, type GoogleSheetsEnvironment } from "./googleSheetsJobTracker";
import { createRuntimeSources, loadBackgroundSearchIntent } from "./runtime/careerAgentRuntime";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { postingLinkKey } from "./postingLink";

export { postingLinkKey };

/**
 * Finds new jobs with the configured sources and search intent and, with
 * `apply`, adds them to the Job Tracker as Researching rows that the queue
 * then picks up. A dry run (the default) reports the same rows without
 * writing anything.
 */
export type DiscoveryDecision =
  | { action: "add"; company: string; role: string; link: string; location: string; fit: string; priority: string; resumeVersion: string; source: string }
  | { action: "skip"; company: string; role: string; reason: Exclude<DiscoveryScreen, { keep: true }>["reason"] | "in tracker" | "duplicate" | "weak fit" | "fit review" | "no direct link" };

const FIT_LABEL: Record<FitClassification, string> = { strong: "Excellent", good: "Good", stretch: "Stretch", weak: "Weak" };
const PRIORITY: Record<FitClassification, string> = { strong: "High", good: "Medium", stretch: "Low", weak: "Low" };

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

function usDate(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}/${date.getUTCFullYear()}`;
}

export interface DiscoverJobsOptions {
  scout: Pick<JobScout, "discover">;
  campaignInput: CreateCampaignInput;
  intent: JobSearchIntent;
  profile: CandidateProfile;
  transport: GoogleSheetsApiTransport;
  spreadsheetId: string;
  trackerTab: string;
  apply: boolean;
  /** Most rows added in one run, so one search cannot flood the tracker. */
  maxNewRows?: number;
  resolveLink?: typeof resolveDirectPostingLink;
  now?: () => string;
}

export async function discoverJobsToTracker(options: DiscoverJobsOptions): Promise<{ decisions: DiscoveryDecision[]; written: number; failures: readonly string[] }> {
  const now = options.now ?? (() => new Date().toISOString());
  const resolveLink = options.resolveLink ?? resolveDirectPostingLink;
  const maxNewRows = options.maxNewRows ?? 15;
  const range = `${quote(options.trackerTab)}!A1:Z1000`;
  const rows = await options.transport.getValues(options.spreadsheetId, range);
  const header = (rows[0] ?? []).map((cell) => String(cell).trim());
  const column = (name: string) => header.findIndex((cell) => key(cell) === key(name));
  for (const required of ["Company", "Role", "Job Link", "Status"]) {
    if (column(required) < 0) throw new Error(`The tracker tab needs a "${required}" column.`);
  }
  const existingRoles = new Set(rows.slice(1).map((row) => `${key(row[column("Company")])}|${key(row[column("Role")])}`));
  const existingLinks = new Set(rows.slice(1).map((row) => postingLinkKey(row[column("Job Link")])).filter(Boolean));

  const result = await options.scout.discover({ id: "career-agent-discover", ...options.campaignInput } as never);
  const decisions: DiscoveryDecision[] = [];
  const seen = new Set<string>();
  for (const scouted of result.jobs as readonly ScoutedJob[]) {
    const job = scouted.job;
    const company = job.company.trim();
    const role = job.title.trim();
    const skip = (reason: Extract<DiscoveryDecision, { action: "skip" }>["reason"]) => decisions.push({ action: "skip", company, role, reason });
    const roleKey = `${key(company)}|${key(role)}`;
    if (existingRoles.has(roleKey) || [job.applicationUrl, job.sourceUrl].some((link) => link && existingLinks.has(postingLinkKey(link)))) { skip("in tracker"); continue; }
    if (seen.has(roleKey)) { skip("duplicate"); continue; }
    seen.add(roleKey);
    const screen = screenDiscoveredJob(job, options.intent);
    if (!screen.keep) { skip(screen.reason); continue; }
    let fit;
    try {
      fit = assessFit(job, options.profile);
    } catch {
      skip("fit review");
      continue;
    }
    if (fit.classification === "weak") { skip("weak fit"); continue; }
    // Board sources already return the employer's application route; feeds
    // and aggregators must be resolved to one before the queue can use it.
    let link = scouted.actionability === "actionable" ? job.applicationUrl ?? job.sourceUrl : undefined;
    if (!link || queueDestinationPreflightReason({ jobLink: link })) {
      const resolved = await resolveLink({ company, role }).catch(() => undefined);
      link = resolved?.status === "resolved" ? resolved.url : undefined;
    }
    if (!link || existingLinks.has(postingLinkKey(link))) { skip(link ? "in tracker" : "no direct link"); continue; }
    existingLinks.add(postingLinkKey(link));
    decisions.push({
      action: "add", company, role, link,
      location: [job.location, job.remoteStatus === "remote" && !/remote/i.test(job.location ?? "") ? "Remote" : undefined].filter(Boolean).join(" — "),
      fit: FIT_LABEL[fit.classification], priority: PRIORITY[fit.classification], resumeVersion: fit.recommendedResumeFamily, source: scouted.sourceId,
    });
  }

  const additions = decisions.filter((decision): decision is Extract<DiscoveryDecision, { action: "add" }> => decision.action === "add").slice(0, maxNewRows);
  if (options.apply && additions.length > 0) {
    const found = usDate(now());
    const firstRow = rows.length + 1;
    const values = additions.map((addition) => header.map((name) => {
      switch (key(name)) {
        case "company": return addition.company;
        case "role": return addition.role;
        case "job link": return addition.link;
        case "location remote": return addition.location;
        case "fit": return addition.fit;
        case "priority": return addition.priority;
        case "status": return "Researching";
        case "date found": return found;
        case "resume version": return addition.resumeVersion;
        case "notes": return `Found by career-agent discover (${addition.source}).`;
        default: return "";
      }
    }));
    await options.transport.updateValues(options.spreadsheetId, [{
      range: `${quote(options.trackerTab)}!A${firstRow}:${columnLetter(header.length - 1)}${firstRow + values.length - 1}`,
      values,
    }]);
  }
  return {
    decisions,
    written: options.apply ? additions.length : 0,
    failures: result.failures.map((failure) => `${failure.sourceId}: ${failure.reason}`),
  };
}

/** Entry point for `npm run career-agent:discover` (dry run unless `--apply`). */
export async function runDiscoverJobsCommand(argv: readonly string[] = process.argv): Promise<void> {
  const loaded = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
  for (const [name, value] of Object.entries(loaded)) if (process.env[name] === undefined) process.env[name] = value;
  const env = process.env as GoogleSheetsEnvironment & Record<string, string | undefined>;
  const spreadsheetId = env.ATELIER_GOOGLE_SHEET_ID?.trim();
  if (!spreadsheetId) throw new Error("ATELIER_GOOGLE_SHEET_ID is required.");
  const intent = loadBackgroundSearchIntent(env as never);
  if (!intent) throw new Error("A search intent file is required (copy application-agent/search-intent.example.json to .local/career-agent/search-intent.json).");
  const profile = parseCandidateProfile(JSON.parse(readFileSync(resolve(env.ATELIER_CAREER_AGENT_PROFILE_FILE?.trim() || ".local/career-agent/profile.json"), "utf8")));
  const { scout, campaignInput } = createRuntimeSources(env as never);
  const apply = argv.includes("--apply");
  const { decisions, written, failures } = await discoverJobsToTracker({
    scout, campaignInput, intent, profile, apply, spreadsheetId,
    transport: createConfiguredGoogleSheetsTransport(env),
    trackerTab: env.ATELIER_GOOGLE_SHEET_TAB?.trim() || "Job Tracker",
  });
  const additions = decisions.filter((decision) => decision.action === "add");
  for (const decision of additions) {
    if (decision.action === "add") console.log(`+ ${decision.company} | ${decision.role} | ${decision.location} | ${decision.fit} | ${decision.resumeVersion} | ${decision.link}`);
  }
  const skipped = new Map<string, number>();
  for (const decision of decisions) if (decision.action === "skip") skipped.set(decision.reason, (skipped.get(decision.reason) ?? 0) + 1);
  console.log(`[career-agent-discover] ${decisions.length} jobs found; ${additions.length} new${apply ? `, ${written} added to the tracker` : " (dry run; pass --apply to add them)"}.`);
  console.log(`[career-agent-discover] skipped: ${[...skipped].map(([reason, count]) => `${reason} ${count}`).join(", ") || "none"}`);
  for (const failure of failures) console.warn(`[career-agent-discover] source problem: ${failure}`);
}
