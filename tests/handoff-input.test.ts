/** @vitest-environment node */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightLeverBrowserSessionFactory } from "../application-agent/automation/playwrightLeverBrowserSession";

const page = `<!doctype html><html><body style="margin:0">
<button id="box" style="position:absolute;left:20px;top:20px;width:200px;height:60px" onclick="this.textContent='checked'">I'm not a robot</button>
<input id="field" style="position:absolute;left:20px;top:120px;width:300px;height:40px">
</body></html>`;

let server: Server;
let url: string;
beforeAll(async () => {
  server = createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end(page); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/apply`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("remote handoff input", () => {
  it("taps, types, and presses keys on the waiting page the way the user would in the window", async () => {
    const session = await new PlaywrightLeverBrowserSessionFactory({ headless: true, timeoutMs: 10_000 }).open("handoff-input");
    try {
      await session.navigate(url);
      await session.handoffInput!({ type: "tap", x: 120, y: 50 });
      await session.handoffInput!({ type: "tap", x: 100, y: 140 });
      await session.handoffInput!({ type: "type", text: "McDonald, PA" });
      await session.handoffInput!({ type: "key", key: "Backspace" });
      await session.handoffInput!({ type: "scroll", dy: 200 });
      const state = await (session as unknown as { page: import("playwright").Page }).page.evaluate(() => ({
        box: document.querySelector("#box")!.textContent,
        field: (document.querySelector("#field") as HTMLInputElement).value,
      }));
      expect(state).toEqual({ box: "checked", field: "McDonald, P" });
      await expect(session.handoffInput!({ type: "tap", x: 99_999, y: 10 })).rejects.toThrow(/outside the page/);
    } finally {
      await session.close();
    }
  }, 60_000);
});
