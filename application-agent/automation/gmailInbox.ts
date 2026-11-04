import { gmailMessageText } from "./gmailSecurityCode";

export interface InboxEmail {
  id: string;
  receivedAt: string;
  from: string;
  subject: string;
  text: string;
}

export interface InboxSource {
  /** Candidate application emails received since `sinceDays` ago. */
  recentEmails(sinceDays: number, options?: RecentEmailOptions): Promise<readonly InboxEmail[]>;
}

export interface RecentEmailOptions {
  /** Message ids already handled; their bodies are not downloaded again. */
  skipIds?: ReadonlySet<string>;
  maxResults?: number;
}

/** Hiring-system senders, and subjects that usually mean an application email. */
export const GMAIL_JOB_QUERY = "(from:(greenhouse-mail.io OR greenhouse.io OR lever.co OR ashbyhq.com OR myworkday.com OR workday.com OR icims.com " +
  "OR smartrecruiters.com OR jobvite.com OR rippling.com OR bamboohr.com OR breezy.hr OR workable.com OR recruitee.com) " +
  "OR subject:(application OR applying OR interview OR candidacy OR \"next steps\") " +
  "OR \"your application\" OR \"applying to\" OR \"your candidacy\" OR \"interest in joining\")";

/** Gmail, read-only, through the same OAuth token as the security-code reader. */
export function gmailInbox(accessToken: () => Promise<string>, fetcher: typeof fetch = fetch): InboxSource {
  const get = async (path: string): Promise<any> => {
    const response = await fetcher(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
      headers: { authorization: `Bearer ${await accessToken()}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Gmail returned ${response.status}.`);
    return response.json();
  };
  return {
    async recentEmails(sinceDays, options = {}) {
      const list = await get(`/messages?maxResults=${options.maxResults ?? 100}&q=${encodeURIComponent(`${GMAIL_JOB_QUERY} newer_than:${Math.max(1, Math.floor(sinceDays))}d`)}`);
      const emails: InboxEmail[] = [];
      for (const summary of list.messages ?? []) {
        if (options.skipIds?.has(summary.id)) continue;
        const message = await get(`/messages/${encodeURIComponent(summary.id)}?format=full`);
        const header = (name: string) => message.payload?.headers?.find((entry: { name: string }) => entry.name.toLowerCase() === name)?.value ?? "";
        emails.push({ id: summary.id, receivedAt: new Date(Number(message.internalDate)).toISOString(), from: header("from"), subject: header("subject"), text: gmailMessageText(message.payload) });
      }
      return emails;
    },
  };
}
