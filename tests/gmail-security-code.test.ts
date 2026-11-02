/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { extractSecurityCode, gmailMessageText, GmailSecurityCodeReader } from "../application-agent/automation/gmailSecurityCode";

const encode = (text: string) => Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

describe("emailed application security codes", () => {
  it("reads the code that follows Greenhouse's instruction", () => {
    expect(extractSecurityCode("Copy and paste this code into the security code field on your application: dkKeNpLf\nThanks")).toBe("dkKeNpLf");
  });

  it("falls back to a code alone on its line, but not an ordinary word", () => {
    expect(extractSecurityCode("Your code is below\n\n  7Hq2LmPx  \n\nThe Upstart team")).toBe("7Hq2LmPx");
    expect(extractSecurityCode("Hello\nwelcome\nthanks")).toBeUndefined();
  });

  it("reads text out of nested HTML parts", () => {
    const payload = { mimeType: "multipart/alternative", parts: [
      { mimeType: "text/html", body: { data: encode("<p>Enter the security code: <b>AbC123xY</b></p>") } },
    ] };
    expect(extractSecurityCode(gmailMessageText(payload))).toBe("AbC123xY");
  });

  it("only asks Gmail for Greenhouse mail and ignores codes sent before Submit", async () => {
    const urls: string[] = [];
    const submittedAt = Date.parse("2026-11-02T02:07:00Z");
    const messages: Record<string, { internalDate: string; text: string }> = {
      old: { internalDate: String(submittedAt - 3_600_000), text: "security code: OLDcode1" },
      fresh: { internalDate: String(submittedAt + 30_000), text: "security code field on your application: NEWcode2" },
    };
    const reader = new GmailSecurityCodeReader({
      accessToken: async () => "token",
      fetcher: async (url) => {
        urls.push(url);
        const id = /\/messages\/([^?]+)/.exec(url)?.[1];
        const body = id
          ? { internalDate: messages[id]!.internalDate, payload: { mimeType: "text/plain", body: { data: encode(messages[id]!.text) } } }
          : { messages: [{ id: "old" }, { id: "fresh" }] };
        return { ok: true, status: 200, json: async () => body };
      },
    });

    await expect(reader.latestCode(submittedAt)).resolves.toBe("NEWcode2");
    expect(decodeURIComponent(urls[0]!)).toContain("from:(greenhouse-mail.io OR greenhouse.io)");
  });

  it("gives up after the timeout when no code arrives", async () => {
    let clock = 0;
    const reader = new GmailSecurityCodeReader({
      accessToken: async () => "token",
      fetcher: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });
    await expect(reader.waitForCode(0, 30_000)).resolves.toBeUndefined();
  });
});
