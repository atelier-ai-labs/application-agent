import assert from "node:assert/strict";
import { chromium } from "playwright";
import { preview } from "vite";
import { PlaywrightLeverBrowserSession } from "../playwrightLeverBrowserSession";

// Uses the production build, a fresh browser profile, and synthetic forms only.
// No configured runtime, employer, Slack, or Google account is contacted.
const server = await preview({ preview: { host: "127.0.0.1", port: 0, open: false } });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const address = server.httpServer.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route("**/*", (route) => route.request().url().startsWith(`${baseUrl}/`)
    ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/application-agent`);
  await page.getByRole("button", { name: /Load example workflow/i }).click();
  await page.getByRole("button", { name: /Normalize and prepare/i }).click();
  await page.getByRole("heading", { name: "What still needs you" }).waitFor();
  let resolved = 0;
  while (await page.locator(".agent-blocker-item").count()) {
    assert(resolved < 30, "Blocker resolution did not converge");
    const blocker = page.locator(".agent-blocker-item").first();
    await blocker.getByRole("textbox").fill("Synthetic acceptance answer");
    await blocker.getByRole("button", { name: "Save answer" }).click();
    resolved++;
  }
  const applicationUrl = page.url();
  await page.reload();
  await page.getByText("No application is sent from here.").waitFor();
  assert.equal(page.url(), applicationUrl);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("atelier.application-agent.applications.v0") ?? "[]"));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, "ready_for_review");
  assert.equal(stored[0].blockers.filter((item: { status: string }) => item.status === "open").length, 0);
  console.log(`PASS production UI: prepared packet, resolved ${resolved} blockers, reloaded persisted ready_for_review packet`);

  await page.goto(`${baseUrl}/career-agent`);
  await page.getByRole("button", { name: /Create live campaign/i }).first().click();
  await page.getByLabel("Target roles").fill("platform engineer, frontend developer");
  await page.getByLabel("Locations", { exact: true }).fill("United States");
  await page.getByLabel("Exclude title terms").fill("director");
  await page.getByRole("button", { name: "Save live campaign" }).click();
  await page.getByRole("button", { name: "Start campaign" }).waitFor();
  await page.reload();
  await page.getByText("platform engineer, frontend developer", { exact: true }).waitFor();
  console.log("PASS production UI: custom live search persisted across reload without running external discovery");

  await page.getByRole("button", { name: /Create local demo campaign/i }).first().click();
  await page.getByRole("button", { name: "Start campaign" }).click();
  await page.getByRole("button", { name: /Run now/i }).click();
  await page.getByText(/Run complete:/).waitFor();
  assert(await page.locator(".career-job-row").count() > 0, "Demo discovery produced no rendered jobs");
  assert.deepEqual(errors, []);
  console.log("PASS production UI: demo campaign discovery and preparation, zero uncaught browser errors");

  const formPage = await context.newPage();
  await formPage.setContent(`<form onsubmit="event.preventDefault(); document.body.dataset.submitted='yes'">
    <label for="name">Full name</label><input id="name" required>
    <label for="email">Email</label><input id="email" type="email" required>
    <label for="location">Location</label><select id="location"><option value="">Choose</option><option value="US">United States</option></select>
    <label for="resume">Resume</label><input id="resume" type="file">
    <input type="hidden" name="csrf" value="synthetic">
    <button type="submit">Submit application</button>
  </form>`);
  const session = new PlaywrightLeverBrowserSession(formPage, context, browser, 5000, {});
  assert.equal(await session.detectHumanBoundary(), null);
  const fields = await session.inspectFields();
  assert.equal(fields.length, 4);
  await fields.find((field) => field.id === "name")!.fill("Synthetic Candidate");
  await fields.find((field) => field.id === "email")!.fill("candidate@example.invalid");
  await fields.find((field) => field.id === "location")!.select("US");
  assert.equal(await fields.find((field) => field.id === "name")!.readValue!(), "Synthetic Candidate");
  assert.equal(await fields.find((field) => field.id === "location")!.readValue!(), "US");
  assert.equal(await session.hasSubmitControl(), true);
  assert.equal(await formPage.evaluate(() => document.body.dataset.submitted), undefined);
  console.log("PASS real Playwright adapter: inspected controls, filled and read back values, detected submit without clicking");

  const customSelectPage = await context.newPage();
  await customSelectPage.setContent(`<form>
    <div class="application-question">
      <div class="select__container">
        <label for="question_previous">Have you previously worked for Kapitus?<span aria-hidden="true">*</span></label>
        <div class="select-shell">
          <div class="select__control">
            <div class="select__value-container">
              <div class="select__input-container" data-value="">
                <input id="question_previous" class="select__input" role="combobox" aria-required="true" aria-expanded="false">
              </div>
            </div>
            <button type="button" aria-label="Toggle flyout">Toggle</button>
          </div>
          <div id="question_previous_options" style="display:none">
            <div class="select__option" data-value="yes" role="option" aria-selected="false">Yes</div>
            <div class="select__option" data-value="no" role="option" aria-selected="false">No</div>
          </div>
          <div class="select__single-value" style="display:none"></div>
        </div>
      </div>
    </div>
  </form>
  <script>
    const input = document.querySelector('#question_previous');
    const menu = document.querySelector('#question_previous_options');
    const selected = document.querySelector('.select__single-value');
    const toggle = document.querySelector('[aria-label="Toggle flyout"]');
    const options = [...document.querySelectorAll('.select__option')];
    const open = () => { menu.style.display = 'block'; input.setAttribute('aria-expanded', 'true'); };
    const close = () => { menu.style.display = 'none'; input.setAttribute('aria-expanded', 'false'); };
    const choose = (option) => {
      selected.textContent = option.textContent;
      selected.style.display = 'block';
      input.value = '';
      input.style.opacity = '0';
      close();
    };
    input.addEventListener('click', open);
    toggle.addEventListener('click', () => menu.style.display === 'none' ? open() : close());
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const wanted = input.value.trim().toLowerCase();
      const option = options.find((candidate) => candidate.textContent.trim().toLowerCase() === wanted);
      if (option) { event.preventDefault(); choose(option); }
    });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
  </script>`);
  const customSession = new PlaywrightLeverBrowserSession(customSelectPage, context, browser, 5000, {});
  const customFields = await customSession.inspectFields();
  assert.equal(customFields.length, 1);
  assert.deepEqual(customFields[0].options, [
    { label: "Yes", value: "yes" },
    { label: "No", value: "no" },
  ]);
  assert.equal(await customFields[0].readValue!(), null);
  await customFields[0].select("no");
  assert.equal(await customFields[0].readValue!(), "no");
  console.log("PASS Greenhouse custom select: keyboard-committed answer survives DOM readback without reopening the blocker");
} finally {
  await browser?.close();
  await new Promise<void>((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
}
