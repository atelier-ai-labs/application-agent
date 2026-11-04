import type { CareerBlocker, CareerJob } from "./campaignTypes";
import { classifyJobEmail } from "./jobEmailClassifier";

/**
 * A "thanks for applying" email is the employer's own proof that an
 * application arrived. It stands in for the candidate's DONE when the agent
 * clicked Submit but the page never confirmed, or when the candidate
 * submitted from the browser themselves.
 */
export interface ReceiptEmail {
  id: string;
  receivedAt: string;
  from: string;
  subject: string;
  text: string;
}

export type ReceiptMatch =
  | { kind: "confirmed"; job: CareerJob }
  | { kind: "ambiguous"; jobs: readonly CareerJob[] }
  | { kind: "none" };

/**
 * A question asked after Submit was already clicked and not confirmed: either
 * "did it go through?" or a CAPTCHA the provider raised on Submit. Its Slack
 * prompt says DONE means the page showed the application as submitted.
 */
export function isPostSubmitHumanCheck(blocker: CareerBlocker): boolean {
  if (blocker.resumeAfterHuman !== false) return false;
  if (!blocker.evidence.some((item) => item === "submit:clicked" || item.includes("submit:clicked;"))) return false;
  return (blocker.kind === "external_verification" && blocker.unit === "submission" && blocker.field === "submission-confirmation") ||
    blocker.kind === "captcha";
}

/** Jobs a receipt may confirm: waiting on DONE after Submit, or waiting at Submit. */
export function isAwaitingReceipt(job: CareerJob): boolean {
  if (!job.applicationId) return false;
  if (job.status === "ready_to_submit") return true;
  return job.status === "needs_input" && job.blockers.some((blocker) => blocker.status === "open" && isPostSubmitHumanCheck(blocker));
}

/** Company names that are ordinary words and must not be matched from an email body. */
const COMMON_WORDS = new Set(["future", "plane", "span", "phantom", "clair", "pogo", "reflow", "implicit", "upstart", "instructure", "outmarket", "notion", "ramp", "brex", "scale", "found"]);
const HIRING_SYSTEM_SENDER = /@(?:[a-z0-9-]+\.)*(?:greenhouse-mail\.io|greenhouse\.io|lever\.co|ashbyhq\.com|myworkday\.com|workday\.com|icims\.com|smartrecruiters\.com|jobvite\.com|rippling\.com|rippling-ats\.com|bamboohr\.com|breezy\.hr|workable\.com|recruitee\.com)\b/i;

const text = (value: unknown) => String(value ?? "").toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9]+/g, " ").trim();

function companyKey(company: string): string {
  return text(company).replace(/\b(?:inc|llc|corp|corporation|co|ltd|technologies|the)\b/g, " ").replace(/\s+/g, " ").trim();
}

function hasWords(haystack: string, phrase: string): boolean {
  return Boolean(phrase) && new RegExp(`(?:^| )${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$| )`).test(haystack);
}

function namesCompany(email: ReceiptEmail, company: string): boolean {
  const name = companyKey(company);
  if (!name) return false;
  const header = text(`${email.from} ${email.subject}`);
  const senderDomain = text((/@([a-z0-9.-]+)/i.exec(email.from)?.[1] ?? "").replace(/\.[a-z]+$/, "")).replace(/ /g, "");
  const compact = name.replace(/ /g, "");
  if (hasWords(header, name) || (compact.length >= 4 && senderDomain.includes(compact))) return true;
  // The body can name the company only for a distinctive name in a hiring-system email.
  return HIRING_SYSTEM_SENDER.test(email.from) && !COMMON_WORDS.has(name) && name.length >= 5 && hasWords(text(email.text.slice(0, 4_000)), name);
}

/** Role words that distinguish two openings at one company ("Jr. Full Stack Developer"). */
function namesRole(email: ReceiptEmail, role: string): boolean {
  return hasWords(text(`${email.subject} ${email.text.slice(0, 4_000)}`), text(role));
}

export function matchReceiptToJob(email: ReceiptEmail, jobs: readonly CareerJob[]): ReceiptMatch {
  if (classifyJobEmail(email) !== "received") return { kind: "none" };
  const candidates = jobs.filter((job) => isAwaitingReceipt(job) &&
    // An older receipt from the same employer is not proof of this application.
    (!job.applicationStartedAt || email.receivedAt >= job.applicationStartedAt) &&
    namesCompany(email, job.job.company));
  if (candidates.length === 0) return { kind: "none" };
  const companies = new Set(candidates.map((job) => companyKey(job.job.company)));
  if (companies.size > 1) return { kind: "ambiguous", jobs: candidates };
  if (candidates.length === 1) {
    const [job] = candidates;
    // The employer may have other openings we applied to earlier; a receipt naming a different role is not this one.
    const otherRoles = jobs.filter((other) => other.id !== job!.id && companyKey(other.job.company) === companyKey(job!.job.company) && namesRole(email, other.job.title));
    return otherRoles.length > 0 && !namesRole(email, job!.job.title) ? { kind: "none" } : { kind: "confirmed", job: job! };
  }
  const named = candidates.filter((job) => namesRole(email, job.job.title));
  return named.length === 1 ? { kind: "confirmed", job: named[0]! } : { kind: "ambiguous", jobs: named.length > 1 ? named : candidates };
}
