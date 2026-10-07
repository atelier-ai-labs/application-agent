import { describe, expect, it } from "vitest";
import { createHandoffReannouncementQueue } from "../application-agent/automation/executionHost/handoffReannouncementQueue";

describe("handoff reannouncement queue", () => {
  it("posts only the latest fresh origin when tunnel recovery changes rapidly", async () => {
    const queue = createHandoffReannouncementQueue();
    const announced: string[] = [];
    queue.enqueue("https://old.trycloudflare.com", async (origin) => { announced.push(origin); });
    queue.enqueue("https://fresh.trycloudflare.com", async (origin) => { announced.push(origin); });

    await queue.flush();

    expect(announced).toEqual(["https://fresh.trycloudflare.com"]);
  });

  it("drops queued handoffs when the tunnel disconnects", async () => {
    const queue = createHandoffReannouncementQueue();
    const announced: string[] = [];
    queue.enqueue("https://expired.trycloudflare.com", async (origin) => { announced.push(origin); });
    queue.invalidate();

    await queue.flush();

    expect(announced).toEqual([]);
  });
});
