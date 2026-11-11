import { describe, expect, it } from "vitest";
import { slackMessagesToTidy } from "../application-agent/src/domain/slackTidy";

const DAY = 24 * 60 * 60 * 1_000;
const now = new Date("2026-11-11T02:00:00.000Z");
const ts = (msAgo: number) => ((now.getTime() - msAgo) / 1_000).toFixed(6);

describe("Slack tidy", () => {
  it("deletes the bot's finished messages older than a day and keeps everything else", () => {
    const board = ts(3 * DAY);
    const openQuestion = ts(2 * DAY);
    const answered = ts(2 * DAY + 5_000);
    const fresh = ts(60_000);
    const mine = ts(5 * DAY);
    const answeredReply = ts(2 * DAY - 1_000);
    const openReply = ts(2 * DAY - 2_000);
    const doomed = slackMessagesToTidy([
      { ts: board, fromBot: true, botReplyTs: [] },
      { ts: openQuestion, fromBot: true, botReplyTs: [openReply] },
      { ts: answered, fromBot: true, botReplyTs: [answeredReply] },
      { ts: fresh, fromBot: true, botReplyTs: [] },
      { ts: mine, fromBot: false, botReplyTs: [] },
    ], new Set([board, openQuestion]), now, DAY);
    expect(doomed.sort()).toEqual([answered, answeredReply].sort());
  });
});
