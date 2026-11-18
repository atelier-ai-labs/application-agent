import { describe, expect, it } from "vitest";
import { gmailInbox } from "../application-agent/automation/gmailInbox";

describe("Gmail inbox reader", () => {
  it("also reads job emails that were moved to Trash or Spam (2026-11-18)", async () => {
    const requested: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("/messages?")) return new Response(JSON.stringify({ messages: [{ id: "m1" }] }));
      return new Response(JSON.stringify({
        internalDate: "1794676505000",
        payload: { headers: [{ name: "From", value: "no-reply@samsara.com" }, { name: "Subject", value: "Thank you for your interest in Samsara" }], mimeType: "text/plain", body: { data: Buffer.from("We have decided to move forward with other candidates.").toString("base64url") } },
      }));
    }) as typeof fetch;
    const emails = await gmailInbox(async () => "token", fetcher).recentEmails(14);
    expect(requested[0]).toContain("includeSpamTrash=true");
    expect(requested.every((url) => !/\/(?:trash|modify|delete)\b/.test(url))).toBe(true);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.subject).toBe("Thank you for your interest in Samsara");
  });
});
