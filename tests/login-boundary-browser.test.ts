// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { PlaywrightLeverBrowserSession, enterOnExactOption } from "../application-agent/automation/playwrightLeverBrowserSession";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] }); }, 60_000);
afterAll(async () => { await browser?.close(); });

async function boundaryFor(html: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(html);
  const session = new PlaywrightLeverBrowserSession(page, context, browser, 5_000, {} as never);
  const boundary = await session.detectHumanBoundary();
  await context.close();
  return boundary;
}

describe("login wall detection on a real page", () => {
  it("reads a posting about building login and MFA as a posting, not a login wall", async () => {
    // Affirm's CIAM role (2026-11-10): stopped as "requires login" with nothing filled.
    const affirm = `<main><p>Build backend services that power registration, login, authorization, and account lifecycle flows.
      Ship features from smoother login experiences to MFA and step-up authentication.</p>
      <form><label for="first_name">First Name</label><input id="first_name" name="first_name"><input id="email" name="email"></form></main>`;
    expect(await boundaryFor(affirm)).toBeNull();
  });

  it("still stops for a real sign-in page or an emailed verification code", async () => {
    expect((await boundaryFor(`<h1>Sign in to continue</h1><input type="email"><input type="password">`))?.kind).toBe("external_login");
    expect((await boundaryFor(`<h1>Sign in</h1><p>Use your account to log in.</p><input type="email">`))?.kind).toBe("external_login");
    const codeAfterSubmit = `<form><input id="first_name" name="first_name"><p>Enter the verification code we emailed you.</p><input name="security_code"></form>`;
    expect((await boundaryFor(codeAfterSubmit))?.kind).toBe("external_login");
  });
});

describe("choosing a searchable dropdown option by keyboard", () => {
  const dropdown = (labels: string[]) => `<input id="gender" role="combobox" aria-activedescendant="">
    <div role="listbox">${labels.map((label, index) => `<div role="option" id="opt-${index}">${label}</div>`).join("")}</div>
    <script>
      const input = document.getElementById("gender"); let focus = -1; const count = ${labels.length};
      input.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown") { focus = (focus + 1) % count; input.setAttribute("aria-activedescendant", "opt-" + focus); }
        if (event.key === "Enter" && focus >= 0) input.dataset.chosen = document.getElementById("opt-" + focus).innerText;
      });
    </script>`;
  const choose = async (labels: string[], target: string) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(dropdown(labels));
    const control = page.locator("#gender");
    await control.focus();
    const pressed = await enterOnExactOption(control, target);
    const chosen = await control.getAttribute("data-chosen");
    await context.close();
    return { pressed, chosen };
  };

  it("presses Enter only on the exact option, not on 'Cis-man' highlighted first", async () => {
    // Samsara (2026-11-12): a blind ArrowDown+Enter committed the wrong gender option.
    expect(await choose(["Agender", "Cis-man", "Man", "Woman"], "Man")).toEqual({ pressed: true, chosen: "Man" });
  });

  it("gives up without choosing when the option isn't there", async () => {
    expect(await choose(["Agender", "Cis-man", "Woman"], "Man")).toEqual({ pressed: false, chosen: null });
  });
});
