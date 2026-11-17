/** @vitest-environment node */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightLeverBrowserSessionFactory } from "../application-agent/automation/playwrightLeverBrowserSession";

// Submit raises a visible reCAPTCHA challenge and never confirms, as Ashby can.
const page = `<!doctype html><html><body>
<form onsubmit="event.preventDefault(); const f = document.createElement('iframe'); f.title = 'recaptcha challenge expires in two minutes'; f.src = 'about:blank?recaptcha/api2/bframe'; f.style.width = '300px'; f.style.height = '300px'; document.body.appendChild(f);">
<label for="name">Name</label><input id="name" name="name" value="Ada">
<button type="submit">Submit Application</button>
</form></body></html>`;

let server: Server;
let url: string;
beforeAll(async () => {
  server = createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end(page); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/apply`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("submit confirmation wait", () => {
  it("hands a CAPTCHA raised on Submit to the user right away instead of waiting out the confirmation window", async () => {
    const session = await new PlaywrightLeverBrowserSessionFactory({ headless: true, timeoutMs: 10_000 }).open("captcha-wait");
    try {
      await session.navigate(url);
      const started = Date.now();
      const result = await session.submit();
      expect(result).toMatchObject({ clicked: true, confirmed: false, humanBoundary: { kind: "captcha" } });
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      await session.close();
    }
  }, 90_000);
});
