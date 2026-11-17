/**
 * Reads an application security code that an ATS emails after Submit
 * (Greenhouse: "Copy and paste this code into the security code field on
 * your application"). Read-only Gmail access, enabled only when the user
 * opts in with ATELIER_GMAIL_SECURITY_CODES=true and re-authorizes.
 */

export type GmailFetcher = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface GmailSecurityCodeReaderOptions {
  accessToken: () => Promise<string>;
  fetcher?: GmailFetcher;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
}

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

/** All text in a Gmail message payload, with HTML tags removed. */
export function gmailMessageText(payload: unknown): string {
  const parts: string[] = [];
  const visit = (part: unknown) => {
    const item = record(part);
    if (!item) return;
    const data = record(item.body)?.data;
    if (typeof data === "string" && /^text\/(?:plain|html)/.test(String(item.mimeType ?? "text/plain"))) {
      const text = decodeBase64Url(data);
      parts.push(String(item.mimeType).startsWith("text/html")
        ? text.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ")
        : text);
    }
    if (Array.isArray(item.parts)) item.parts.forEach(visit);
  };
  visit(payload);
  return parts.join("\n").replace(/[ \t]+/g, " ");
}

/**
 * The code from a security-code email. Prefers the code that follows the
 * instruction sentence; otherwise a line that holds only a code-shaped token
 * (letters and digits, 6–12 characters, not an ordinary lowercase word).
 */
export function extractSecurityCode(text: string): string | undefined {
  const instructed = /security code[^:\n]{0,120}:\s*([A-Za-z0-9]{6,12})\b/i.exec(text)?.[1];
  if (instructed) return instructed;
  for (const line of text.split(/\r?\n/)) {
    const token = /^\s*([A-Za-z0-9]{6,12})\s*$/.exec(line)?.[1];
    if (token && (/\d/.test(token) || /[a-z]/.test(token) && /[A-Z]/.test(token))) return token;
  }
  return undefined;
}

export class GmailSecurityCodeReader {
  private readonly fetcher: GmailFetcher;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;

  constructor(private readonly options: GmailSecurityCodeReaderOptions) {
    this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
  }

  private async get(path: string): Promise<unknown> {
    const response = await this.fetcher(`${GMAIL_API}${path}`, {
      headers: { authorization: `Bearer ${await this.options.accessToken()}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Gmail returned ${response.status}.`);
    return response.json();
  }

  /** Newest code from a security-code email that arrived at or after `since` (ms epoch). */
  async latestCode(since: number): Promise<string | undefined> {
    // Only the ATS's own mail: a bank or account "security code" must never
    // be typed into a job application.
    const query = `from:(greenhouse-mail.io OR greenhouse.io) "security code" after:${Math.floor((since - 60_000) / 1_000)}`;
    const list = record(await this.get(`/messages?maxResults=5&q=${encodeURIComponent(query)}`));
    const messages = Array.isArray(list?.messages) ? list!.messages : [];
    for (const summary of messages) {
      const id = record(summary)?.id;
      if (typeof id !== "string") continue;
      const message = record(await this.get(`/messages/${encodeURIComponent(id)}?format=full`));
      if (Number(message?.internalDate ?? 0) < since - 5_000) continue;
      const code = extractSecurityCode(gmailMessageText(message?.payload));
      if (code) return code;
    }
    return undefined;
  }

  /** Polls until a fresh code arrives or `timeoutMs` passes. */
  async waitForCode(since: number, timeoutMs = 120_000): Promise<string | undefined> {
    const deadline = this.now() + timeoutMs;
    do {
      const code = await this.latestCode(since).catch(() => undefined);
      if (code) return code;
      await this.sleep(this.pollIntervalMs);
    } while (this.now() < deadline);
    return undefined;
  }
}
