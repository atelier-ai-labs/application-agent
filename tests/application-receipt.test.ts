import { describe, expect, it } from "vitest";
import { isAwaitingReceipt, isPostSubmitHumanCheck, matchReceiptToJob, type ReceiptEmail } from "../application-agent/src/domain/applicationReceipt";
import type { CareerJob } from "../application-agent/src/domain/campaignTypes";

const postSubmit = { id: "b", kind: "external_verification", unit: "submission", field: "submission-confirmation", question: "Verify", evidence: ["submit:clicked; confirmation:not-detected"], status: "open", resumeAfterHuman: false, context: {}, reason: "", createdAt: "2026-11-03T22:40:00.000Z" };

function job(id: string, company: string, title: string, extra: Partial<CareerJob> = {}): CareerJob {
  return { id, campaignId: "c", applicationId: `app-${id}`, status: "needs_input", blockers: [postSubmit], applicationStartedAt: "2026-11-03T22:35:00.000Z", job: { company, title }, ...extra } as unknown as CareerJob;
}

const email = (subject: string, text = "", from = "no-reply@ashbyhq.com", receivedAt = "2026-11-03T22:41:00.000Z"): ReceiptEmail => ({ id: subject, receivedAt, from, subject, text });

describe("application receipt emails", () => {
  it("waits only on post-Submit checks and Submit reviews", () => {
    expect(isAwaitingReceipt(job("a", "Phantom", "AI Engineer"))).toBe(true);
    expect(isAwaitingReceipt(job("a", "Phantom", "AI Engineer", { status: "ready_to_submit", blockers: [] }))).toBe(true);
    // Still waiting on a question: the candidate may have answered it in the form and submitted.
    expect(isAwaitingReceipt(job("a", "Phantom", "AI Engineer", { blockers: [{ ...postSubmit, kind: "unknown_form_field", evidence: [], resumeAfterHuman: true }] as never }))).toBe(true);
    expect(isAwaitingReceipt(job("a", "Phantom", "AI Engineer", { status: "applied" }))).toBe(false);
  });

  it("treats a login or emailed-code wall after Submit as a submitted application awaiting DONE", () => {
    // Sparksoft: Submit, then Greenhouse's "verification code" page, handed off as external_login.
    const codeWall = { ...postSubmit, kind: "external_login", unit: "external", field: undefined, evidence: ["executor:greenhouse-browser", "submit:clicked", "password-fields:0"] };
    expect(isPostSubmitHumanCheck(codeWall as never)).toBe(true);
    // A login wall before any Submit click is not a submission.
    expect(isPostSubmitHumanCheck({ ...codeWall, evidence: ["password-fields:1", "submit:not-clicked"] } as never)).toBe(false);
    expect(isPostSubmitHumanCheck({ ...codeWall, resumeAfterHuman: true } as never)).toBe(false);
  });

  it("confirms the one waiting job a receipt names", () => {
    const phantom = job("p", "Phantom", "AI Engineer");
    expect(matchReceiptToJob(email("Thank you for applying to Phantom!"), [phantom, job("t", "Thumbtack", "Engineer")])).toEqual({ kind: "confirmed", job: phantom });
    // A company named only in the sender's domain.
    expect(matchReceiptToJob(email("We received your application", "", "careers@phantom.app"), [phantom]).kind).toBe("confirmed");
  });

  it("ignores rejections, other employers, and receipts older than the application", () => {
    const phantom = job("p", "Phantom", "AI Engineer");
    expect(matchReceiptToJob(email("Your application to Phantom", "Unfortunately we have decided to move forward with other candidates."), [phantom]).kind).toBe("none");
    expect(matchReceiptToJob(email("Thanks for applying to Upstart"), [phantom]).kind).toBe("none");
    expect(matchReceiptToJob(email("Thanks for applying to Phantom", "", "no-reply@ashbyhq.com", "2026-10-01T00:00:00.000Z"), [phantom]).kind).toBe("none");
  });

  it("uses the role title to pick between openings at one company, and stays ambiguous otherwise", () => {
    const junior = job("j", "Sparksoft Corporation", "Jr. Full Stack Developer");
    const mid = job("m", "Sparksoft Corporation", "Full Stack Developer - Mid-Level");
    expect(matchReceiptToJob(email("Thank you for applying to Sparksoft", "Thanks for your application for Jr. Full Stack Developer."), [junior, mid])).toEqual({ kind: "confirmed", job: junior });
    expect(matchReceiptToJob(email("Thank you for applying to Sparksoft"), [junior, mid]).kind).toBe("ambiguous");
    // One waiting job, but the receipt names a different Sparksoft role applied to earlier.
    const earlier = job("d", "Sparksoft Corporation", "DevOps Engineer", { status: "applied", blockers: [] });
    expect(matchReceiptToJob(email("Thank you for applying to Sparksoft", "Your application for DevOps Engineer was received."), [junior, earlier]).kind).toBe("none");
  });
});
