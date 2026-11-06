/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { checkInboxForTracker, type InboxEmail } from "../application-agent/automation/inboxMonitor";
import type { GoogleSheetMetadata, GoogleSheetsApiTransport, GoogleSheetValueRange } from "../application-agent/automation/googleSheetsJobTracker";

const headers = ["Company", "Role", "Job Link", "Location / Remote", "Salary Min", "Salary Max", "Fit", "Priority", "Status", "Date Found", "Date Applied", "Follow-Up Date", "Contact / Referral", "Resume Version", "Next Step", "Notes"];
const row = (company: string, role: string, status: string, notes = "") => [company, role, "https://x", "", "", "", "Good", "High", status, "11/01/2026", "", "", "", "cloud-platform", "", notes];

class Tracker implements GoogleSheetsApiTransport {
  writes: GoogleSheetValueRange[] = [];
  constructor(public rows: unknown[][]) {}
  async getSpreadsheetMetadata(): Promise<GoogleSheetMetadata> { return { spreadsheetId: "s", title: "T", sheets: [{ title: "Job Tracker", sheetId: 1 }] }; }
  async getValues(): Promise<readonly (readonly unknown[])[]> { return this.rows; }
  async updateValues(_id: string, data: readonly GoogleSheetValueRange[]): Promise<{ updatedCells: number }> { this.writes.push(...data); return { updatedCells: data.length }; }
  cell(range: string): unknown { return this.writes.find((write) => write.range === range)?.values[0]?.[0]; }
}

const mail = (id: string, from: string, subject: string, text: string): InboxEmail => ({ id, receivedAt: "2026-11-02T18:00:00.000Z", from, subject, text });

function run(tracker: Tracker, emails: InboxEmail[], processed = new Set<string>(), apply = true) {
  const notices: string[] = [];
  return checkInboxForTracker({
    inbox: { recentEmails: async () => emails }, transport: tracker, spreadsheetId: "s", trackerTab: "Job Tracker", apply, processed,
    notify: async (text) => { notices.push(text); },
  }).then((decisions) => ({ decisions, notices }));
}

describe("inbox monitor", () => {
  it("marks a rejection Rejected and notes the email", async () => {
    const tracker = new Tracker([headers, row("Upstart", "DevOps Engineer II, Cloud Platform", "Applied", "Found via ChatGPT.")]);
    const { decisions } = await run(tracker, [mail("m1", "Upstart <no-reply@us.greenhouse-mail.io>", "Your application to Upstart",
      "Thank you for your interest. After careful review we have decided to move forward with other candidates.")]);
    expect(decisions[0]).toMatchObject({ action: "updated", status: "Rejected", row: 2 });
    expect(tracker.cell("'Job Tracker'!I2")).toBe("Rejected");
    expect(String(tracker.cell("'Job Tracker'!P2"))).toMatch(/^Found via ChatGPT\. 11\/02\/2026: Rejected \(email "Your application to Upstart"\)\.$/);
  });

  it("marks a callback Interviewing, sets the next step, and pings Slack", async () => {
    const tracker = new Tracker([headers, row("Stack AV", "Full-Stack Software Engineer, Machine Learning Platform", "Applied")]);
    const { decisions, notices } = await run(tracker, [mail("m2", "Jordan <jordan@stackav.com>", "Next steps",
      "Hi Nathaniel, we'd like to schedule a call to learn more about you. Please select a time that works.")]);
    expect(decisions[0]).toMatchObject({ action: "updated", status: "Interviewing" });
    expect(tracker.cell("'Job Tracker'!O2")).toBe("Reply to Stack AV's email to schedule");
    expect(tracker.cell("'Job Tracker'!L2")).toBe("11/02/2026");
    expect(notices[0]).toContain("Callback: Stack AV");
  });

  it("confirms Applied from an application-received email and handles each email once", async () => {
    const tracker = new Tracker([headers, row("Cargomatic", "AI Engineer – Agentic Automation", "Researching")]);
    const processed = new Set<string>();
    const email = mail("m3", "no-reply@us.greenhouse-mail.io", "Thank you for applying to Cargomatic", "We have received your application.");
    expect((await run(tracker, [email], processed)).decisions[0]).toMatchObject({ action: "updated", status: "Applied" });
    expect(tracker.cell("'Job Tracker'!K2")).toBe("11/02/2026");
    expect((await run(tracker, [email], processed)).decisions).toEqual([]);
  });

  it("stays quiet about a receipt matching several rows that are all already Applied, but asks when one could change", async () => {
    const receipt = mail("m9", "no-reply@us.greenhouse-mail.io", "Thank you for applying to Sparksoft Corporation", "Your application has been received.");
    const done = new Tracker([headers, row("Sparksoft Corporation", "Jr. Full Stack Developer", "Applied"), row("Sparksoft Corporation", "Full Stack Developer - Mid-Level", "Applied")]);
    const quiet = await run(done, [receipt]);
    expect(quiet.notices).toEqual([]);
    expect(quiet.decisions[0]).toMatchObject({ action: "skipped" });
    const open = new Tracker([headers, row("Sparksoft Corporation", "Jr. Full Stack Developer", "Applied"), row("Sparksoft Corporation", "Full Stack Developer - Mid-Level", "Researching")]);
    expect((await run(open, [{ ...receipt, id: "m10" }])).notices).toEqual([expect.stringContaining("several tracker rows matched")]);
  });

  it("does not match a company named by an everyday word in the body, and asks when unsure", async () => {
    const tracker = new Tracker([headers, row("Future", "Applied AI Engineer", "Applied"), row("Clair", "DevOps Engineer", "Applied")]);
    const { decisions, notices } = await run(tracker, [mail("m4", "talent@othercorp.com", "Your application",
      "We have decided to move forward with other candidates, but we'll keep you in mind for future roles.")]);
    expect(decisions[0]).toMatchObject({ action: "skipped", reason: "no tracker row matched" });
    expect(tracker.writes).toHaveLength(0);
    expect(notices).toEqual([]);

    const unclear = await run(tracker, [mail("m5", "Clair Recruiting <jobs@clair.com>", "Question about your application", "Could you send your portfolio link?")]);
    expect(unclear.decisions[0]).toMatchObject({ action: "notify", kind: "unclear", company: "Clair" });
    expect(unclear.notices[0]).toContain("Clair");
  });

  it("stays quiet about newsletters that only mention an application or interview", async () => {
    const tracker = new Tracker([headers, row("Upstart", "DevOps Engineer II", "Applied")]);
    const { decisions, notices } = await run(tracker, [
      mail("n1", "news@hostingco.com", "Build, deploy, and monitor your application in one place", "Try our platform."),
      mail("n2", "briefing@news.com", "The Jeffries interview: what's next", "Today's top stories."),
    ]);
    expect(decisions.every((decision) => decision.action === "skipped")).toBe(true);
    expect(notices).toEqual([]);
  });

  it("writes nothing and records nothing on a dry run", async () => {
    const tracker = new Tracker([headers, row("Upstart", "DevOps Engineer II", "Applied")]);
    const processed = new Set<string>();
    const { decisions } = await run(tracker, [mail("m6", "Upstart <no-reply@us.greenhouse-mail.io>", "Upstart update", "We regret to inform you the position has been filled.")], processed, false);
    expect(decisions[0]).toMatchObject({ action: "updated", status: "Rejected" });
    expect(tracker.writes).toHaveLength(0);
    expect(processed.size).toBe(0);
  });
});
