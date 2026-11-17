import type { CareerJob } from "./campaignTypes";

/** How many applications one company gets in a rolling window (2026-11-11). */
export interface CompanyApplicationLimit {
  /** Default per company. */
  max: number;
  windowDays: number;
  /** Companies with their own published rule, by name ("Upstart": 3). */
  overrides?: Readonly<Record<string, number>>;
}

/**
 * "Gusto, Inc." and "Gusto" are one company; so are "D.A. Davidson" and
 * "D A Davidson", and "Outmarket AI" and "Outmarket" (2026-11-12).
 */
export function companyKey(name: string | undefined): string {
  const key = (name ?? "").toLowerCase().replace(/[.,'’]/g, " ")
    .replace(/\b(?:inc|llc|ltd|corp|corporation|co|plc|gmbh|company)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim();
  const withoutSuffix = key.replace(/\s+(?:ai|hq)$/, "");
  return withoutSuffix.length >= 3 ? withoutSuffix : key;
}

/**
 * The employer's own job-board account, from the posting link: one Ashby org,
 * Greenhouse board, Lever site or Rippling board is one company. Names alone
 * missed "Span" vs "Span App", both on jobs.ashbyhq.com/span.app (2026-11-17).
 */
export function companyBoardKey(job: Pick<CareerJob["job"], "sourceUrl" | "applicationUrl">): string | undefined {
  for (const raw of [job.applicationUrl, job.sourceUrl]) {
    if (!raw) continue;
    let url: URL;
    try { url = new URL(raw); } catch { continue; }
    const host = url.hostname.toLowerCase();
    const first = url.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
    if (host === "jobs.ashbyhq.com" && first) return `ashby:${first}`;
    if (host === "jobs.lever.co" && first) return `lever:${first}`;
    if (/(^|\.)greenhouse\.io$/.test(host)) {
      const board = url.searchParams.get("for")?.toLowerCase() ?? (first && first !== "embed" ? first : undefined);
      if (board) return `greenhouse:${board}`;
    }
    if (host === "ats.rippling.com" && first) return `rippling:${first}`;
  }
  return undefined;
}

/** Two jobs are at the same company when the names match or the job boards do. */
export function sameCompany(a: CareerJob, b: CareerJob): boolean {
  const name = companyKey(a.job.company);
  if (name && name === companyKey(b.job.company)) return true;
  const board = companyBoardKey(a.job);
  return Boolean(board && board === companyBoardKey(b.job));
}

const IN_PROGRESS = new Set(["pursuing", "needs_input", "ready_to_submit"]);

function appliedAt(job: CareerJob): string {
  return job.manualSubmissionConfirmation?.confirmedAt ?? job.submissionProof?.submittedAt ?? job.updatedAt;
}

/**
 * Upstart allows three applications per person in 60 days and declined the
 * fourth (2026-11-11); three of its roles had started the same evening. A
 * company's count is its applications inside the window plus any still in
 * progress, so roles found together can't all start at once.
 */
export function companyLimitReached(
  job: CareerJob,
  allJobs: readonly CareerJob[],
  limit: CompanyApplicationLimit,
  now: Date,
): { company: string; count: number; max: number; windowDays: number } | undefined {
  const key = companyKey(job.job.company);
  if (!key && !companyBoardKey(job.job)) return undefined;
  const override = Object.entries(limit.overrides ?? {}).find(([name]) => companyKey(name) === key)?.[1];
  const max = override ?? limit.max;
  const since = now.getTime() - limit.windowDays * 24 * 60 * 60 * 1_000;
  const count = allJobs.filter((other) =>
    other.id !== job.id &&
    sameCompany(job, other) &&
    // In progress counts only when active inside the window: weeks-old jobs
    // stuck in "pursuing" must not use up a company's limit.
    ((other.status === "applied" && Date.parse(appliedAt(other)) >= since) ||
      (IN_PROGRESS.has(other.status) && Date.parse(other.updatedAt) >= since)),
  ).length;
  return count >= max ? { company: job.job.company, count, max, windowDays: limit.windowDays } : undefined;
}
