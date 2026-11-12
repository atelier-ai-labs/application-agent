import type { CareerJob } from "./campaignTypes";

/** How many applications one company gets in a rolling window (2026-11-11). */
export interface CompanyApplicationLimit {
  /** Default per company. */
  max: number;
  windowDays: number;
  /** Companies with their own published rule, by name ("Upstart": 3). */
  overrides?: Readonly<Record<string, number>>;
}

/** "Gusto, Inc." and "Gusto" are one company; so are "D.A. Davidson" and "D A Davidson". */
export function companyKey(name: string | undefined): string {
  return (name ?? "").toLowerCase().replace(/[.,'’]/g, " ")
    .replace(/\b(?:inc|llc|ltd|corp|corporation|co|plc|gmbh|company)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim();
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
  if (!key) return undefined;
  const override = Object.entries(limit.overrides ?? {}).find(([name]) => companyKey(name) === key)?.[1];
  const max = override ?? limit.max;
  const since = now.getTime() - limit.windowDays * 24 * 60 * 60 * 1_000;
  const count = allJobs.filter((other) =>
    other.id !== job.id &&
    companyKey(other.job.company) === key &&
    ((other.status === "applied" && Date.parse(appliedAt(other)) >= since) || IN_PROGRESS.has(other.status)),
  ).length;
  return count >= max ? { company: job.job.company, count, max, windowDays: limit.windowDays } : undefined;
}
