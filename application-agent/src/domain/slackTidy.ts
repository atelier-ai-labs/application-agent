/**
 * Which of the agent's own Slack messages to delete so the channel shows only
 * what still needs the candidate (2026-11-10: 360 old messages, mostly
 * answered questions). Only the bot's messages are ever chosen; a message is
 * kept while it is the current board, a question for a job still waiting, or
 * the Submit card of a job still ready to submit, and nothing younger than
 * `minimumAgeMs` is touched.
 */
export interface TidyCandidate {
  ts: string;
  fromBot: boolean;
  /** The bot's own replies in this message's thread. */
  botReplyTs: readonly string[];
}

export function slackMessagesToTidy(
  messages: readonly TidyCandidate[],
  keep: ReadonlySet<string>,
  now: Date,
  minimumAgeMs: number,
): string[] {
  const cutoff = now.getTime() / 1_000 - minimumAgeMs / 1_000;
  const old = (ts: string) => Number(ts) > 0 && Number(ts) < cutoff;
  const doomed: string[] = [];
  for (const message of messages) {
    if (keep.has(message.ts)) continue;
    // A kept question's thread holds the conversation about it; leave the thread alone.
    for (const reply of message.botReplyTs) if (old(reply) && !keep.has(reply)) doomed.push(reply);
    if (message.fromBot && old(message.ts)) doomed.push(message.ts);
  }
  return doomed;
}
