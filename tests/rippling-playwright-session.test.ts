/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
import {
  isUnselectedNativeOption,
  unmatchedSelectOptionMessage,
  PlaywrightLeverBrowserSession,
  isSafeHumanVerificationButton,
} from "../application-agent/automation/playwrightLeverBrowserSession";

class DomLocator {
  constructor(private readonly elements: readonly Element[]) {}

  async count(): Promise<number> {
    return this.elements.length;
  }

  async evaluateAll<R>(callback: (elements: Element[]) => R): Promise<R> {
    return callback([...this.elements]);
  }

  async isVisible(): Promise<boolean> {
    const element = this.elements[0];
    if (!element) return false;
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  }

  nth(index: number): DomLocator {
    return new DomLocator(this.elements[index] ? [this.elements[index]!] : []);
  }

  first(): DomLocator {
    return this.nth(0);
  }

  locator(selector: string): DomLocator {
    if (selector.startsWith("xpath=")) return new DomLocator([]);
    return new DomLocator(this.elements.flatMap((element) => Array.from(element.querySelectorAll(selector))));
  }

  getByRole(role: string, options?: { name?: string }): DomLocator {
    const name = options?.name;
    return new DomLocator(this.elements.filter((element) =>
      element.getAttribute("role") === role && (!name || element.textContent?.trim() === name)));
  }

  async click(): Promise<void> {
    (this.elements[0] as HTMLElement | undefined)?.click();
  }

  async press(key: string): Promise<void> {
    (this.elements[0] as HTMLElement | undefined)?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  }

  async inputValue(): Promise<string> {
    const element = this.elements[0] as HTMLInputElement | HTMLSelectElement | undefined;
    return element?.value ?? "";
  }

  async boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> {
    return { x: 1, y: 1, width: 100, height: 20 };
  }

  async isDisabled(): Promise<boolean> {
    return (this.elements[0] as HTMLButtonElement | HTMLInputElement | undefined)?.disabled ?? false;
  }

  async isEnabled(): Promise<boolean> {
    return !(await this.isDisabled());
  }

  async getAttribute(name: string): Promise<string | null> {
    return this.elements[0]?.getAttribute(name) ?? null;
  }

  async innerText(): Promise<string> {
    return (this.elements[0] as HTMLElement | undefined)?.innerText || this.elements[0]?.textContent || "";
  }

  async evaluate<R>(callback: (element: Element, arg?: unknown) => R, arg?: unknown): Promise<R> {
    return callback(this.elements[0]!, arg);
  }

  async waitFor(): Promise<void> {}

  async setInputFiles(path: string): Promise<void> {
    const input = this.elements[0] as HTMLInputElement | undefined;
    if (input) {
      if (!input.hasAttribute("data-remount")) input.setAttribute("data-uploaded-path", path);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
}

class DomPage {
  setDefaultTimeout(): void {}

  constructor(private readonly currentPageUrl = "https://example.invalid/form") {}

  url(): string {
    return this.currentPageUrl;
  }

  async waitForSelector(): Promise<void> {}

  async waitForTimeout(): Promise<void> {}

  async waitForLoadState(): Promise<void> {}

  async title(): Promise<string> { return ""; }

  async evaluate<R>(callback: (arg?: unknown) => R, arg?: unknown): Promise<R> {
    return callback(arg);
  }

  keyboard = { press: async (): Promise<void> => {} };
  mouse = { move: async (): Promise<void> => {}, down: async (): Promise<void> => {}, up: async (): Promise<void> => {} };

  locator(selector: string): DomLocator {
    return new DomLocator(Array.from(document.querySelectorAll(selector)));
  }

  getByRole(role: string, options?: { name?: string; exact?: boolean }): DomLocator {
    const name = options?.name;
    return new DomLocator(Array.from(document.querySelectorAll(`[role="${role}"]`)).filter((element) => {
      if (!name) return true;
      const text = element.textContent?.trim() ?? "";
      return options?.exact ? text === name : text.includes(name);
    }));
  }
}

function sessionForDocument(currentPageUrl?: string): PlaywrightLeverBrowserSession {
  return new PlaywrightLeverBrowserSession(
    new DomPage(currentPageUrl) as unknown as Page,
    {} as BrowserContext,
    {} as Browser,
    5_000,
    {},
  );
}

describe("Rippling Playwright DOM integration", () => {
  it("rejects verification-looking submit controls from the human handoff", () => {
    document.body.innerHTML = `<form><button type="submit" role="button">Verify you are human</button></form>`;
    expect(isSafeHumanVerificationButton(document.querySelector("button")!)).toBe(false);
    document.body.innerHTML = `<button type="button" role="button">Verify you are human</button>`;
    expect(isSafeHumanVerificationButton(document.querySelector("button")!)).toBe(true);
    document.body.innerHTML = `<div role="button">Verify you are human</div><a href="/submit" role="button">Verify you are human</a>`;
    expect(isSafeHumanVerificationButton(document.querySelector("div")!)).toBe(false);
    expect(isSafeHumanVerificationButton(document.querySelector("a")!)).toBe(false);
    document.body.innerHTML = `<button>Verify you are human</button>`;
    expect(isSafeHumanVerificationButton(document.querySelector("button")!)).toBe(false);
  });
  it("discovers and activates only an exact non-submit human-verification button", async () => {
    let clicks = 0;
    document.body.innerHTML = `<button type="button" aria-label="Verify you are human">Verify you are human</button><button type="button">Continue</button>`;
    document.querySelector("button")?.addEventListener("click", () => { clicks += 1; });
    const session = sessionForDocument();
    await expect(session.handoffControls()).resolves.toEqual([{ id: "verify-human", label: "Verify you are human", bounds: { x: 1, y: 1, width: 100, height: 20 } }]);
    await session.activateHandoffControl("verify-human");
    expect(clicks).toBe(1);
    await expect(session.activateHandoffControl("submit")).rejects.toThrow(/Only a verified CAPTCHA frame tap/);
  });
  it("recognizes Ashby's out-of-form submit control on a verified application route", async () => {
    document.body.innerHTML = `<button class="ashby-application-form-submit-button">Submit Application</button>`;
    expect(await sessionForDocument("https://jobs.ashbyhq.com/litellm/769df1b5-70bb-40fe-b2e2-ef052eb3afa3/application").hasSubmitControl()).toBe(true);
  });

  it("does not recognize the Ashby submit class on a non-Ashby route", async () => {
    document.body.innerHTML = `<button class="ashby-application-form-submit-button">Submit Application</button>`;
    expect(await sessionForDocument("https://example.invalid/litellm/769df1b5-70bb-40fe-b2e2-ef052eb3afa3/application").hasSubmitControl()).toBe(false);
  });

  it("does not treat unrelated page buttons as submit controls", async () => {
    document.body.innerHTML = `<button>Submit Application</button><button class="help-button">Apply now</button>`;
    expect(await sessionForDocument("https://jobs.ashbyhq.com/litellm/769df1b5-70bb-40fe-b2e2-ef052eb3afa3/application").hasSubmitControl()).toBe(false);
  });

  it("blocks submit on a visible native-invalid control without exposing its identity or value", async () => {
    let clicks = 0;
    document.body.innerHTML = `<form><input id="applicant-email-nate@example.com" name="secret-answer" type="email" value="not-an-email" required><button type="submit">Submit</button></form>`;
    document.querySelector("button")?.addEventListener("click", () => { clicks += 1; });
    const result = await sessionForDocument().submit();
    expect(result).toMatchObject({ clicked: false, confirmed: false, outcome: "rejected", reasonCode: "validation-error" });
    expect(result.evidence).toContain("validity:typeMismatch");
    expect(result.evidence).not.toContain("nate@example.com");
    expect(result.evidence).not.toContain("secret-answer");
    expect(clicks).toBe(0);
  });

  it("finds a visible invalid control after hidden invalid template controls", async () => {
    let clicks = 0;
    document.body.innerHTML = `<form><div style="display:none"><input required></div>${Array.from({ length: 14 }, () => "<input required>").join("")}<button type="submit">Submit</button></form>`;
    document.querySelector("button")?.addEventListener("click", () => { clicks += 1; });
    const result = await sessionForDocument().submit();
    expect(result.clicked).toBe(false);
    expect(result.evidence).toContain("invalid-control:ordinal-0");
    expect(clicks).toBe(0);
  });

  it("allows a valid form to click and confirms the resulting page", async () => {
    let clicks = 0;
    document.body.innerHTML = `<form><input id="safe" value="ok"><button type="submit">Submit</button><p>Application submitted</p></form>`;
    document.querySelector("button")?.addEventListener("click", (event) => { event.preventDefault(); clicks += 1; });
    const result = await sessionForDocument("https://example.invalid/confirmation").submit();
    expect(result).toMatchObject({ clicked: true, confirmed: true, outcome: "confirmed" });
    expect(clicks).toBe(1);
  });

  it("treats provider placeholder values as unselected native options", () => {
    const options = [
      { label: "-- No answer --", value: "resumator_no_selection" },
      { label: "Yes", value: "Yes" },
      { label: "No", value: "No" },
    ];
    expect(isUnselectedNativeOption("resumator_no_selection", options)).toBe(true);
    expect(isUnselectedNativeOption("Yes", options)).toBe(false);
    expect(isUnselectedNativeOption("No", options)).toBe(false);
  });

  it("uses the production inspectFields callback to extract an opaque custom prompt", async () => {
    document.body.innerHTML = `
      <form>
        <div class="question-block">
          <div class="paddingX--16">What is your expected salary? ✱</div>
          <div class="field-wrap">
            <input id="opaqueSalaryABC1" name="opaqueSalaryABC1" type="text" required>
          </div>
        </div>
      </form>
    `;

    const fields = await sessionForDocument().inspectFields();
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      id: "opaqueSalaryABC1",
      label: "What is your expected salary?",
      required: true,
      questionDescriptor: {
        promptText: "What is your expected salary?",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    });
  });

  it("associates Breezy binary controls with the visible question label", async () => {
    document.body.innerHTML = `
      <form>
        <div class="form-group" id="section_1784070260855">
          <div class="breezy-question-label">May Rootstock contact your current or most recent employer?</div>
          <label><input id="section_1784070260855_question_0" name="section_1784070260855_question_0" type="radio" value="yes" required>Yes</label>
          <label><input name="section_1784070260855_question_0" type="radio" value="no">No</label>
        </div>
      </form>
    `;

    const fields = await sessionForDocument("https://rootstock-software.breezy.hr/p/example/apply").inspectFields();
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      id: "section_1784070260855_question_0",
      label: "Yes",
      type: "radio",
      questionDescriptor: {
        promptText: "May Rootstock contact your current or most recent employer?",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    });
  });

  it("preserves Breezy authorization and sponsorship prompts across wrapped radio options", async () => {
    document.body.innerHTML = `
      <form>
        <div class="form-group">
          <div>Are you currently authorized to work in the United States?</div>
          <div class="choice"><span>Yes</span><input id="section_1784070260855_question_0_yes" name="section_1784070260855_question_0" type="radio" value="yes"></div>
          <div class="choice"><span>No</span><input id="section_1784070260855_question_0_no" name="section_1784070260855_question_0" type="radio" value="no"></div>
        </div>
        <div class="form-group">
          <div>Will you require visa sponsorship at any point during your employment with Rootstock?</div>
          <div class="choice"><span>Yes</span><input id="section_1784070260855_question_1_yes" name="section_1784070260855_question_1" type="radio" value="yes"></div>
          <div class="choice"><span>No</span><input id="section_1784070260855_question_1_no" name="section_1784070260855_question_1" type="radio" value="no"></div>
        </div>
      </form>
    `;

    const fields = await sessionForDocument("https://rootstock-software.breezy.hr/p/example/apply").inspectFields();
    expect(fields).toHaveLength(2);
    expect(fields.map((field) => field.questionDescriptor?.promptText)).toEqual([
      "Are you currently authorized to work in the United States?",
      "Will you require visa sponsorship at any point during your employment with Rootstock?",
    ]);
    expect(fields.every((field) => !["Yes", "No"].includes(field.questionDescriptor?.promptText ?? ""))).toBe(true);
  });

  it("scopes unclassed Breezy prompts to each shared-name radio group in one section", async () => {
    document.body.innerHTML = `
      <form><div class="form-group section-wrapper">
        <div>Are you currently authorized to work in the United States?</div>
        <div class="option-row"><span>Yes</span><input id="section_1784070260855_question_0_yes" name="section_1784070260855_question_0" type="radio" value="yes"></div>
        <div class="option-row"><span>No</span><input id="section_1784070260855_question_0_no" name="section_1784070260855_question_0" type="radio" value="no"></div>
        <div>Will you require visa sponsorship at any point during your employment with Rootstock?</div>
        <div class="option-row"><span>Yes</span><input id="section_1784070260855_question_1_yes" name="section_1784070260855_question_1" type="radio" value="yes"></div>
        <div class="option-row"><span>No</span><input id="section_1784070260855_question_1_no" name="section_1784070260855_question_1" type="radio" value="no"></div>
      </div></form>
    `;
    const fields = await sessionForDocument("https://rootstock-software.breezy.hr/p/example/apply").inspectFields();
    expect(fields.map((field) => field.questionDescriptor?.promptText)).toEqual([
      "Are you currently authorized to work in the United States?",
      "Will you require visa sponsorship at any point during your employment with Rootstock?",
    ]);
    expect(fields.every((field) => !["Yes", "No"].includes(field.questionDescriptor?.promptText ?? ""))).toBe(true);
  });

  it("keeps Breezy race and gender option labels separate from their group prompts", async () => {
    document.body.innerHTML = `
      <form>
        <div class="form-group">
          <div class="question-label">Race / Ethnicity</div>
          <div class="radio-options">
            <label for="race_white">White (not Hispanic or Latino)</label><input id="race_white" name="race" type="radio" value="white">
            <label for="race_black">Black/African-American</label><input id="race_black" name="race" type="radio" value="black">
            <label for="race_asian">Asian</label><input id="race_asian" name="race" type="radio" value="asian">
          </div>
        </div>
        <div class="form-group">
          <div>Gender</div>
          <div class="radio-options">
            <label for="gender_male">Male</label><input id="gender_male" name="gender" type="radio" value="male">
            <label for="gender_female">Female</label><input id="gender_female" name="gender" type="radio" value="female">
            <label for="gender_decline">I don't wish to answer</label><input id="gender_decline" name="gender" type="radio" value="decline">
          </div>
        </div>
      </form>
    `;

    const fields = await sessionForDocument("https://rootstock-software.breezy.hr/p/example/apply").inspectFields();
    expect(fields).toHaveLength(2);
    expect(fields[0]?.questionDescriptor?.promptText).not.toBe("White (not Hispanic or Latino)");
    expect(fields[1]?.questionDescriptor?.promptText).toBe("Gender");
    expect(fields[0]?.label).toBe("White (not Hispanic or Latino)");
    expect(fields[1]?.label).toBe("Male");
    expect(fields[1]?.options?.map((option) => option.label)).toEqual(["Male", "Female", "I don't wish to answer"]);
  });

  it("keeps repeated Rippling demographic comboboxes distinct when ids and labels are generic", async () => {
    document.body.innerHTML = `
      <form>
        <div class="question-block"><div class="paddingX--16">Gender</div><div id="field-109" role="combobox" aria-required="true">Select...</div></div>
        <div class="question-block"><div class="paddingX--16">Are you Hispanic/Latino?</div><div id="field-109" role="combobox" aria-required="true">Select...</div></div>
        <div class="question-block"><div class="paddingX--16">Are you a protected veteran?</div><div id="field-109" role="combobox" aria-required="true">Select...</div></div>
        <div class="question-block"><div class="paddingX--16">Do you have a disability?</div><div id="field-109" role="combobox" aria-required="true">Select...</div></div>
      </form>
    `;

    const fields = await sessionForDocument().inspectFields();
    expect(fields).toHaveLength(4);
    expect(fields.map((field) => field.questionDescriptor?.promptText)).toEqual([
      "Gender",
      "Are you Hispanic/Latino?",
      "Are you a protected veteran?",
      "Do you have a disability?",
    ]);
    expect(new Set(fields.map((field) => field.id)).size).toBe(4);
    expect(new Set(fields.map((field) => field.sourceSelector)).size).toBe(4);
    expect(fields.every((field) => field.type === "select")).toBe(true);
  });

  it("discovers Rippling's ARIA radio consent control when no native inputs exist", async () => {
    document.body.innerHTML = `
      <form>
        <div class="question-block">
          <div class="paddingX--16">Check Yes or No to indicate your agreement to receive text message updates from Fullthrottle.ai regarding your job application. Frequency may vary. Message and data rates may apply. Reply HELP for assistance. Reply STOP to opt out of future messaging.</div>
          <div role="radiogroup" aria-required="true">
            <div role="radio" aria-label="Yes" aria-checked="false"></div>
            <div role="radio" aria-label="No" aria-checked="false"></div>
          </div>
        </div>
      </form>
    `;

    const fields = await sessionForDocument().inspectFields();
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      type: "radio",
      required: true,
      options: [{ label: "Yes", value: "Yes" }, { label: "No", value: "No" }],
      questionDescriptor: { promptText: expect.stringContaining("text message updates") },
    });
  });

  it("deduplicates duplicated logical SMS radio groups emitted by Rippling", async () => {
    const prompt = "Check Yes or No to indicate your agreement to receive text message updates from Fullthrottle.ai regarding your job application. Frequency may vary. Message and data rates may apply. Reply HELP for assistance. Reply STOP to opt out of future messaging.";
    const options = `
      <div role="radio" aria-label="Yes - I consent to receiving text messages" value="true" aria-checked="false"></div>
      <div role="radio" aria-label="No - I do not consent to receiving text messages" value="false" aria-checked="false"></div>`;
    document.body.innerHTML = `
      <form>
        <div class="question-block"><div class="paddingX--16">${prompt}</div><div role="radiogroup" aria-required="true">${options}</div></div>
        <div class="question-block"><div class="paddingX--16">${prompt}</div><div role="radiogroup" aria-required="true">${options}</div></div>
      </form>`;

    const fields = await sessionForDocument().inspectFields();
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      type: "radio",
      options: [
        { label: "Yes - I consent to receiving text messages", value: "true" },
        { label: "No - I do not consent to receiving text messages", value: "false" },
      ],
      questionDescriptor: { promptText: expect.stringContaining("text message updates") },
    });
  });

  it("commits a portal-rendered Rippling combobox option against the exact open listbox", async () => {
    document.body.innerHTML = `
      <form>
        <div class="question-block"><div class="paddingX--16">Gender</div><div id="field-103" role="combobox" aria-expanded="false">Select...</div></div>
      </form>
      <div id="gender-menu" role="listbox" style="display:none">
        <div role="option" aria-hidden="true">Male</div>
        <div id="gender-male" role="option"><span class="select__option">Male</span></div>
        <div role="option">Female</div>
        <div role="option">Non-binary</div>
        <div role="option">Choose not to disclose</div>
      </div>
    `;
    const control = document.querySelector("#field-103") as HTMLElement;
    const menu = document.querySelector("#gender-menu") as HTMLElement;
    control.addEventListener("click", () => {
      menu.style.display = "block";
      control.setAttribute("aria-expanded", "true");
    });
    document.querySelector("#gender-male")?.addEventListener("click", () => {
      control.textContent = "Male";
      control.setAttribute("aria-expanded", "false");
      menu.style.display = "none";
    });

    const fields = await sessionForDocument().inspectFields();
    await fields[0]!.select("Male");
    expect(await fields[0]!.readValue?.()).toBe("Male");
  });

  it("rejects two visible exact portal options but ignores hidden template duplicates", async () => {
    document.body.innerHTML = `
      <form><div class="question-block"><div class="paddingX--16">Veteran</div><div id="field-122" role="combobox" aria-expanded="false">Select...</div></div></form>
      <div id="menu" role="listbox" style="display:none">
        <div role="option" aria-hidden="true">No, I am not a protected veteran</div>
        <div role="option">No, I am not a protected veteran</div>
      </div>
    `;
    const control = document.querySelector("#field-122") as HTMLElement;
    const menu = document.querySelector("#menu") as HTMLElement;
    control.addEventListener("click", () => { menu.style.display = "block"; control.setAttribute("aria-expanded", "true"); });
    const fields = await sessionForDocument().inspectFields();
    const selected = document.querySelector('[role="option"]:not([aria-hidden="true"])') as HTMLElement;
    selected.addEventListener("click", () => { control.textContent = "No, I am not a protected veteran"; menu.style.display = "none"; });
    await fields[0]!.select("No, I am not a protected veteran");
    expect(await fields[0]!.readValue?.()).toBe("No, I am not a protected veteran");

    document.body.innerHTML = `
      <form><div class="question-block"><div class="paddingX--16">Veteran</div><div id="field-122" role="combobox" aria-expanded="false">Select...</div></div></form>
      <div id="menu" role="listbox" style="display:none"><div role="option">No, I am not a protected veteran</div><div role="option">No, I am not a protected veteran</div></div>
    `;
    const ambiguousControl = document.querySelector("#field-122") as HTMLElement;
    const ambiguousMenu = document.querySelector("#menu") as HTMLElement;
    ambiguousControl.addEventListener("click", () => { ambiguousMenu.style.display = "block"; ambiguousControl.setAttribute("aria-expanded", "true"); });
    const ambiguousFields = await sessionForDocument().inspectFields();
    await expect(ambiguousFields[0]!.select("No, I am not a protected veteran")).rejects.toThrow("not uniquely verified");

  });

  it("fails closed when a portal combobox has ambiguous or uncommitted options", async () => {
    document.body.innerHTML = `
      <form><div class="question-block"><div class="paddingX--16">Gender</div><div id="field-103" role="combobox" aria-expanded="false">Select...</div></div></form>
      <div id="menu-a" role="listbox" style="display:none"><div role="option">Male</div></div>
      <div id="menu-b" role="listbox" style="display:none"><div role="option">Male</div></div>
    `;
    const control = document.querySelector("#field-103") as HTMLElement;
    const menus = [document.querySelector("#menu-a"), document.querySelector("#menu-b")] as HTMLElement[];
    control.addEventListener("click", () => {
      for (const menu of menus) menu.style.display = "block";
      control.setAttribute("aria-expanded", "true");
    });
    const fields = await sessionForDocument().inspectFields();
    await expect(fields[0]!.select("Male")).rejects.toThrow("multiple visible listboxes");

    document.body.innerHTML = `
      <form><div class="question-block"><div class="paddingX--16">Gender</div><div id="field-103" role="combobox" aria-expanded="false">Select...</div></div></form>
      <div id="gender-menu" role="listbox" style="display:none"><div role="option">Male</div></div>
    `;
    const noCommitControl = document.querySelector("#field-103") as HTMLElement;
    const noCommitMenu = document.querySelector("#gender-menu") as HTMLElement;
    noCommitControl.addEventListener("click", () => {
      noCommitMenu.style.display = "block";
      noCommitControl.setAttribute("aria-expanded", "true");
    });
    const noCommitFields = await sessionForDocument().inspectFields();
    await expect(noCommitFields[0]!.select("Male")).rejects.toThrow("did not commit");
  }, 10_000);



  it("opens the bounded Matlen Apply panel before inspecting its real controls", async () => {
    document.body.innerHTML = `
      <a class="wpjb-form-job-apply" href="/job/azure-engineer-60869931/?form=apply">Apply Now</a>
      <form id="wpjb-apply-form" style="display:none">
        <div class="wpjb-element-input-file">
          <label>Attachments</label>
          <input id="matlen-resume" type="file">
        </div>
        <input id="wpjb_submit" type="submit" value="Send Application">
      </form>
    `;
    const form = document.querySelector("#wpjb-apply-form") as HTMLElement;
    document.querySelector("a.wpjb-form-job-apply")?.addEventListener("click", (event) => {
      event.preventDefault();
      form.style.display = "block";
    });

    const fields = await sessionForDocument("https://matlensilver.com/job/azure-engineer-60869931").inspectFields();

    expect(fields.map((field) => ({ id: field.id, label: field.label, type: field.type }))).toEqual([
      { id: "matlen-resume", label: "Attachments", type: "file" },
    ]);
  });

  it("opens Protagona's resume panel before inspecting its file input", async () => {
    document.body.innerHTML = `
      <a id="resumator-choose-upload" href="#">Attach resume</a>
      <div id="resumator-resume-upload-wrapper" class="none" style="display:none">
        <p>Attach resume as .pdf or .docx</p>
        <div id="resumator-resume-field"><input id="resumator-resume-value" name="resumator-resume-value" type="file"></div>
      </div>
    `;
    const wrapper = document.querySelector("#resumator-resume-upload-wrapper") as HTMLElement;
    document.querySelector("#resumator-choose-upload")?.addEventListener("click", (event) => {
      event.preventDefault();
      wrapper.style.display = "block";
    });

    const fields = await sessionForDocument("https://protagona.applytojob.com/apply/YDO63zlPbH/AWS-Cloud-Engineer").inspectFields();

    expect(fields.map((field) => ({ id: field.id, type: field.type }))).toEqual([
      { id: "resumator-resume-value", type: "file" },
    ]);
  });

  it("detects a hidden Rippling resume input behind a styled dropzone", async () => {
    document.body.innerHTML = `
      <form>
        <div class="resume-dropzone" role="button">
          <span>Upload your resume</span>
          <input id="resume-file" name="resume" type="file" style="display:none">
        </div>
      </form>
    `;
    const fields = await sessionForDocument("https://ats.rippling.com/fullthrottle1/jobs/rippling-posting-123/apply").inspectFields();
    expect(fields.map((field) => ({ id: field.id, type: field.type, label: field.label }))).toEqual([
      { id: "resume-file", type: "file", label: "Upload your resume" },
    ]);
    await fields[0]!.uploadFile("/tmp/ai-platform-agentic.pdf");
    expect(document.querySelector("#resume-file")?.getAttribute("data-uploaded-path")).toBe("/tmp/ai-platform-agentic.pdf");
  });

  it("discovers Rippling's canonical data-testid resume control", async () => {
    document.body.innerHTML = `
      <form>
        <div data-testid="resume" class="resume-field resume-dropzone" role="button">
          <label data-testid="resume" for="input-resume">Résumé</label>
          <p>The résumé will be parsed and used to autofill the application.</p>
          <span class="screen-reader-only">Total 0 file selected</span>
          <input data-testid="input-resume" id="input-resume" type="file" style="display:none">
        </div>
      </form>
    `;
    const fields = await sessionForDocument("https://ats.rippling.com/easy-dynamics/jobs/rippling-posting-123/apply").inspectFields();
    expect(fields.filter((field) => field.type === "file").map((field) => ({ id: field.id, label: field.label }))).toEqual([
      { id: "input-resume", label: "Résumé" },
    ]);
  });

  it("accepts a canonical Rippling resume whose visible label is extension-only", async () => {
    document.body.innerHTML = `
      <form>
        <div data-testid="resume" class="resume-field resume-dropzone" role="button">
          <span>Résumé</span>
          <span>Drop or select (.doc / .docx / .pdf)</span>
          <span class="help-text">File name</span>
          <input data-testid="input-resume" id="field-1" data-remount type="file" style="display:none">
          <span id="receipt">Total 0 file selected</span>
        </div>
      </form>
    `;
    document.querySelector("#field-1")?.addEventListener("change", () => {
      document.querySelector("#receipt")!.textContent = "Total 1 file selected";
    });
    const fields = await sessionForDocument("https://ats.rippling.com/easy-dynamics/jobs/rippling-posting-123/apply").inspectFields();
    await expect(fields[0]!.uploadFile("/tmp/ai-platform-agentic.pdf")).resolves.toBeUndefined();
  });

  it("uses a preceding sibling prompt for Rippling Select comboboxes", async () => {
    document.body.innerHTML = `
      <form>
        <div data-testid="field">
          <div>Are you currently authorized to work in the U.S.?</div>
          <div id="field-61" role="combobox" aria-label="Select" aria-required="true"></div>
        </div>
        <div data-testid="field">
          <div>Will you now or in the future require employment-based visa sponsorship to work in the US?</div>
          <div id="field-55" role="combobox" aria-label="Select" aria-required="true"></div>
        </div>
      </form>
    `;
    const fields = await sessionForDocument("https://ats.rippling.com/easy-dynamics/jobs/rippling-posting-123/apply").inspectFields();
    expect(fields.map((field) => field.questionDescriptor?.promptText)).toEqual([
      "Are you currently authorized to work in the U.S.?",
      "Will you now or in the future require employment-based visa sponsorship to work in the US?",
    ]);
  });

  it("commits distinct Rippling sponsorship and authorization selections", async () => {
    document.body.innerHTML = `
      <form>
        <div data-testid="field"><div>Are you currently authorized to work in the U.S.?</div><div id="field-61" role="combobox" aria-label="Select" aria-controls="menu-61" aria-expanded="false"></div></div>
        <div data-testid="field"><div>Will you now or in the future require employment-based visa sponsorship to work in the US?</div><div id="field-55" role="combobox" aria-label="Select" aria-controls="menu-55" aria-expanded="false"></div></div>
      </form>
      <div id="menu-61" role="listbox" style="display:none"><div role="option">Yes</div><div role="option">No</div></div>
      <div id="menu-55" role="listbox" style="display:none"><div role="option">Yes</div><div role="option">No</div></div>
    `;
    for (const id of ["61", "55"]) {
      const control = document.querySelector(`#field-${id}`) as HTMLElement;
      const menu = document.querySelector(`#menu-${id}`) as HTMLElement;
      control.addEventListener("click", () => { menu.style.display = "block"; control.setAttribute("aria-expanded", "true"); });
      for (const option of Array.from(menu.querySelectorAll('[role="option"]'))) {
        option.addEventListener("click", () => { control.textContent = option.textContent; menu.style.display = "none"; control.setAttribute("aria-expanded", "false"); });
      }
    }
    const fields = await sessionForDocument("https://ats.rippling.com/easy-dynamics/jobs/rippling-posting-123/apply").inspectFields();
    await fields[0]!.select("Yes");
    await fields[1]!.select("No");
    expect(await fields[0]!.readValue?.()).toBe("Yes");
    expect(await fields[1]!.readValue?.()).toBe("No");
  });

  it("handles Rippling prompts beside deeply nested field wrappers", async () => {
    document.body.innerHTML = `
      <form>
        <div class="question-row">
          <div class="prompt-copy">Are you currently authorized to work in the U.S.?</div>
          <div class="layout-a"><div class="layout-b"><div class="layout-c"><div class="layout-d"><div class="layout-e"><div class="layout-f">
            <div data-testid="field"><div class="inner-a"><div class="inner-b"><div id="field-61" role="combobox" aria-label="Select" aria-expanded="false"></div></div></div></div>
          </div></div></div></div></div></div>
        </div>
        <div class="question-row">
          <div class="prompt-copy">Will you now or in the future require employment-based visa sponsorship to work in the US?</div>
          <div class="layout-a"><div class="layout-b"><div class="layout-c"><div class="layout-d"><div class="layout-e"><div class="layout-f">
            <div data-testid="field"><div class="inner-a"><div class="inner-b"><div id="field-55" role="combobox" aria-label="Select" aria-expanded="false"></div></div></div></div>
          </div></div></div></div></div></div>
        </div>
      </form>
    `;
    const fields = await sessionForDocument("https://ats.rippling.com/easy-dynamics/jobs/rippling-posting-123/apply").inspectFields();
    expect(fields.map((field) => field.questionDescriptor?.promptText)).toEqual([
      "Are you currently authorized to work in the U.S.?",
      "Will you now or in the future require employment-based visa sponsorship to work in the US?",
    ]);
  });

  it("accepts Rippling's provider receipt when the hidden file input remounts", async () => {
    document.body.innerHTML = `
      <form>
        <div class="resume-dropzone" role="button">
          <span>Drop or select (.doc / .docx / .pdf)</span>
          <input id="resume-file" data-remount type="file" style="display:none">
          <span id="upload-receipt"></span>
        </div>
      </form>
    `;
    document.querySelector("#resume-file")?.addEventListener("change", () => {
      document.querySelector("#upload-receipt")!.textContent = "Total 1 file selected";
    });
    const fields = await sessionForDocument("https://ats.rippling.com/easy-dynamics/jobs/rippling-posting-123/apply").inspectFields();
    await expect(fields[0]!.uploadFile("/tmp/ai-platform-agentic.pdf")).resolves.toBeUndefined();
  });

  it("rejects a Rippling remount when no provider receipt is rendered", async () => {
    document.body.innerHTML = `
      <form>
        <div class="resume-dropzone" role="button">
          <span>Drop or select (.doc / .docx / .pdf)</span>
          <input id="resume-file" data-remount type="file" style="display:none">
        </div>
      </form>
    `;
    const fields = await sessionForDocument("https://ats.rippling.com/easy-dynamics/jobs/rippling-posting-123/apply").inspectFields();
    await expect(fields[0]!.uploadFile("/tmp/ai-platform-agentic.pdf")).rejects.toThrow(/uploaded resume was not committed.*upload-diagnostic:i=1,f=0,c=1,o=1,m=1,r=n,v=0,x=0,X=0,S=0,I=0,p=0,d=0/);
  });

  it("rejects a stale Rippling receipt that was present before upload", async () => {
    document.body.innerHTML = `
      <form>
        <div class="resume-dropzone" role="button">
          <span>Drop or select (.doc / .docx / .pdf)</span>
          <input id="resume-file" data-remount type="file" style="display:none">
          <span id="upload-receipt">Total 1 file selected</span>
        </div>
      </form>
    `;
    const fields = await sessionForDocument("https://ats.rippling.com/easy-dynamics/jobs/rippling-posting-123/apply").inspectFields();
    await expect(fields[0]!.uploadFile("/tmp/ai-platform-agentic.pdf")).rejects.toThrow(/uploaded resume was not committed/);
  });

  it("requires the Rippling resume receipt to remain after later field remounts", async () => {
    document.body.innerHTML = `
      <form>
        <div data-testid="resume" class="resume-dropzone" role="button">
          <span>Drop or select (.doc / .docx / .pdf)</span>
          <input id="resume-file" data-remount type="file" style="display:none">
          <span id="upload-receipt">Total 1 file selected</span>
        </div>
      </form>
    `;
    const session = sessionForDocument("https://ats.rippling.com/easy-dynamics/jobs/rippling-posting-123/apply");
    expect(await session.verifyUploadedFile?.("/tmp/ai-platform-agentic.pdf")).toBe(true);
    document.querySelector("#upload-receipt")?.remove();
    expect(await session.verifyUploadedFile?.("/tmp/ai-platform-agentic.pdf")).toBe(false);
    expect(session.uploadVerificationDiagnostics?.()).toContain("strict-owner=1");
  });

  it("accepts a visible Rippling filename after the hidden input remounts empty", async () => {
    document.body.innerHTML = `
      <form>
        <div data-testid="resume" class="resume-dropzone">
          <span>Résumé</span>
          <input data-testid="input-resume" id="resume-file" type="file">
          <span class="file-name">ai-platform-agentic.pdf</span>
        </div>
      </form>
    `;
    const session = sessionForDocument("https://ats.rippling.com/easy-dynamics/jobs/rippling-posting-123/apply");
    expect(await session.verifyUploadedFile?.("/tmp/ai-platform-agentic.pdf")).toBe(true);
  });

  it("keeps the canonical accented resume distinct from another attachment", async () => {
    document.body.innerHTML = `
      <form>
        <div data-testid="resume" class="resume-field">
          <span>Résumé</span>
          <input data-testid="input-resume" id="resume-file" type="file">
          <span class="file-name">ai-platform-agentic.pdf</span>
        </div>
        <div data-testid="additional-document" class="attachment-field">
          <span>Additional document</span>
          <input data-testid="input-attachment" id="other-file" type="file">
          <span>Total 1 file selected</span>
        </div>
      </form>
    `;
    const session = sessionForDocument("https://ats.rippling.com/easy-dynamics/jobs/rippling-posting-123/apply");
    expect(await session.verifyUploadedFile?.("/tmp/ai-platform-agentic.pdf")).toBe(true);
  });

  it("widens to the canonical resume section when the filename chip is beside the label wrapper", async () => {
    document.body.innerHTML = `
      <form>
        <section data-testid="resume" class="resume-section">
          <label data-testid="resume">Résumé</label>
          <div class="resume-control"><input data-testid="input-resume" id="resume-file" type="file"></div>
          <div class="file-chip">ai-platform-agentic.pdf</div>
        </section>
        <section data-testid="cover-letter" class="attachment-section">
          <label>Cover letter</label>
          <input data-testid="input-cover-letter" id="cover-file" type="file">
          <div class="file-chip">other-document.pdf</div>
        </section>
      </form>
    `;
    const session = sessionForDocument("https://ats.rippling.com/easy-dynamics/jobs/rippling-posting-123/apply");
    expect(await session.verifyUploadedFile?.("/tmp/ai-platform-agentic.pdf")).toBe(true);
  });

  it("does not treat a Rippling FileList without visible attachment UI as uploaded", async () => {
    document.body.innerHTML = `
      <form>
        <div data-testid="resume" class="resume-dropzone" role="button">
          <span>Drop or select (.doc / .docx / .pdf)</span>
          <input id="resume-file" type="file">
          <span class="screen-reader-only">Total 1 file selected</span>
        </div>
      </form>
    `;
    const session = sessionForDocument("https://ats.rippling.com/easy-dynamics/jobs/rippling-posting-123/apply");
    const input = document.querySelector("#resume-file") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [{ name: "ai-platform-agentic.pdf" }] });
    expect(await session.verifyUploadedFile?.("/tmp/ai-platform-agentic.pdf")).toBe(false);
  });

  it("does not use another document receipt when the Rippling resume is missing", async () => {
    document.body.innerHTML = `
      <form>
        <div data-testid="resume" class="resume-dropzone">
          <span>Drop or select (.doc / .docx / .pdf)</span>
          <input data-testid="input-resume" id="resume-file" type="file">
        </div>
        <div data-testid="additional-document" class="resume-dropzone">
          <span>Drop or select (.doc / .docx / .pdf)</span>
          <input id="other-file" type="file">
          <span>Total 1 file selected</span>
        </div>
      </form>
    `;
    const session = sessionForDocument("https://ats.rippling.com/easy-dynamics/jobs/rippling-posting-123/apply");
    expect(await session.verifyUploadedFile?.("/tmp/ai-platform-agentic.pdf")).toBe(false);
  });

  it("fails closed when multiple extension-only Rippling dropzones are indistinguishable", async () => {
    document.body.innerHTML = `
      <form>
        <div class="resume-dropzone" role="button">
          <span>Drop or select (.doc / .docx / .pdf)</span>
          <input id="field-1" type="file" style="display:none">
        </div>
        <div class="resume-dropzone" role="button">
          <span>Drop or select (.doc / .docx / .pdf)</span>
          <input id="field-12" type="file" style="display:none">
        </div>
      </form>
    `;
    const fields = await sessionForDocument("https://ats.rippling.com/fullthrottle1/jobs/rippling-posting-123/apply").inspectFields();
    expect(fields.filter((field) => field.type === "file")).toHaveLength(0);
  });

  it("keeps a semantically identified Rippling resume when an additional document is adjacent", async () => {
    document.body.innerHTML = `
      <form>
        <div class="resume-dropzone" role="button">
          <span>Drop or select (.doc / .docx / .pdf)</span>
          <input id="additional-document" type="file" style="display:none">
        </div>
        <div class="resume-dropzone" role="button">
          <span>Drop or select (.doc / .docx / .pdf)</span>
          <input id="resume-file" name="resume" type="file" style="display:none">
        </div>
      </form>
    `;
    const fields = await sessionForDocument("https://ats.rippling.com/fullthrottle1/jobs/rippling-posting-123/apply").inspectFields();
    expect(fields.filter((field) => field.type === "file").map((field) => field.id)).toEqual(["resume-file"]);
  });

  it("uses the canonical Ashby resume attachment without triggering optional autofill", async () => {
    document.body.innerHTML = `
      <form>
        <input id="field-1" type="file">
        <label for="_systemfield_resume">Resume</label>
        <input id="_systemfield_resume" type="file">
      </form>
    `;
    const fields = await sessionForDocument("https://jobs.ashbyhq.com/meridianlink/a3b7147c-f9c5-4dd4-9cf2-e8c183b19162/application").inspectFields();
    expect(fields.filter((field) => field.type === "file").map((field) => field.id)).toEqual(["_systemfield_resume"]);
  });

  it("requires Ashby to visibly acknowledge the canonical resume upload", async () => {
    document.body.innerHTML = `
      <form>
        <div data-field-path="resume-field" class="ashby-application-form-field-entry">
          <label for="_systemfield_resume">Resume</label>
          <input id="_systemfield_resume" type="file">
          <div class="ashby-application-form-file-name">ai-platform-agentic.pdf</div>
        </div>
      </form>
    `;
    const fields = await sessionForDocument("https://jobs.ashbyhq.com/meridianlink/a3b7147c-f9c5-4dd4-9cf2-e8c183b19162/application").inspectFields();
    await expect(fields[0]!.uploadFile("/tmp/ai-platform-agentic.pdf")).resolves.toBeUndefined();
  });

  it("does not accept a hidden Ashby filename rendered under a visible field owner", async () => {
    document.body.innerHTML = `
      <form>
        <div data-field-path="resume-field" class="ashby-application-form-field-entry">
          <label for="_systemfield_resume">Resume</label>
          <input id="_systemfield_resume" type="file">
          <div class="ashby-application-form-file-name" style="display:none">ai-platform-agentic.pdf</div>
        </div>
      </form>
    `;
    const fields = await sessionForDocument("https://jobs.ashbyhq.com/meridianlink/a3b7147c-f9c5-4dd4-9cf2-e8c183b19162/application").inspectFields();
    await expect(fields[0]!.uploadFile("/tmp/ai-platform-agentic.pdf")).rejects.toThrow(/provider-confirmed uploaded filename or status/);
  });

  it("does not treat an Ashby FileList as an uploaded resume without visible provider state", async () => {
    document.body.innerHTML = `
      <form>
        <div data-field-path="resume-field" class="ashby-application-form-field-entry">
          <label for="_systemfield_resume">Resume</label>
          <input id="_systemfield_resume" type="file">
        </div>
      </form>
    `;
    const fields = await sessionForDocument("https://jobs.ashbyhq.com/meridianlink/a3b7147c-f9c5-4dd4-9cf2-e8c183b19162/application").inspectFields();
    await expect(fields[0]!.uploadFile("/tmp/ai-platform-agentic.pdf")).rejects.toThrow(/provider-confirmed uploaded filename or status/);
  });

  it("filters Ashby autofill uploads when the form stays on the public posting URL", async () => {
    document.body.innerHTML = `
      <form>
        <input id="field-1" type="file">
        <input id="_systemfield_resume" type="file">
      </form>
    `;
    const fields = await sessionForDocument("https://jobs.ashbyhq.com/meridianlink/a3b7147c-f9c5-4dd4-9cf2-e8c183b19162").inspectFields();
    expect(fields.filter((field) => field.type === "file").map((field) => field.id)).toEqual(["_systemfield_resume"]);
  });

  it("deduplicates Ashby native radio options into one logical question", async () => {
    document.body.innerHTML = `
      <form>
        <div class="ashby-application-form-field-entry">
          <div class="ashby-application-form-question-title">Gender</div>
          <label><input id="c441__systemfield_eeoc_gender-labeled-radio-0" name="c441__systemfield_eeoc_gender" type="radio" value="Male">Male</label>
          <label><input id="c441__systemfield_eeoc_gender-labeled-radio-1" name="c441__systemfield_eeoc_gender" type="radio" value="Female">Female</label>
          <label><input id="c441__systemfield_eeoc_gender-labeled-radio-2" name="c441__systemfield_eeoc_gender" type="radio" value="Decline to self-identify">Decline to self-identify</label>
        </div>
      </form>
    `;
    const fields = await sessionForDocument("https://jobs.ashbyhq.com/meridianlink/a3b7147c-f9c5-4dd4-9cf2-e8c183b19162/application").inspectFields();
    expect(fields.filter((field) => field.type === "radio")).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      id: "c441__systemfield_eeoc_gender-labeled-radio-0",
      label: "Gender",
      options: [
        { label: "Male", value: "Male" },
        { label: "Female", value: "Female" },
        { label: "Decline to self-identify", value: "Decline to self-identify" },
      ],
    });
  });

  it("discovers Ashby yes/no button widgets as logical required radio questions", async () => {
    document.body.innerHTML = `
      <form>
        <div class="ashby-application-form-field-entry" data-field-path="current-employer">
          <div class="ashby-application-form-question-title">May MeridianLink contact your CURRENT or MOST RECENT employer?</div>
          <label class="required">Required</label>
          <div class="ashby-application-form-input-yesno">
            <button type="button" data-option="yes" aria-pressed="false">Yes</button>
            <button type="button" data-option="no" aria-pressed="false">No</button>
          </div>
        </div>
        <div class="ashby-application-form-field-entry" data-field-path="past-employer">
          <div class="ashby-application-form-question-title">May MeridianLink Contact your PAST employers?</div>
          <label class="required">Required</label>
          <div class="ashby-application-form-input-yesno">
            <button type="button" data-option="yes" aria-pressed="false">Yes</button>
            <button type="button" data-option="no" aria-pressed="false">No</button>
          </div>
        </div>
        <div class="ashby-application-form-field-entry" data-field-path="termination-history">
          <div class="ashby-application-form-question-title">Have you ever been fired or asked to resign to avoid being fired from a job?</div>
          <label class="required">Required</label>
          <div class="ashby-application-form-input-yesno">
            <button type="button" data-option="yes" aria-pressed="false">Yes</button>
            <button type="button" data-option="no" aria-pressed="false">No</button>
          </div>
        </div>
      </form>
    `;
    const fields = await sessionForDocument("https://jobs.ashbyhq.com/meridianlink/a3b7147c-f9c5-4dd4-9cf2-e8c183b19162/application").inspectFields();
    expect(fields.filter((field) => field.type === "radio").map((field) => field.label)).toEqual([
      "May MeridianLink contact your CURRENT or MOST RECENT employer?",
      "May MeridianLink Contact your PAST employers?",
      "Have you ever been fired or asked to resign to avoid being fired from a job?",
    ]);
    expect(fields.filter((field) => field.type === "radio").every((field) => field.required)).toBe(true);
    expect(fields.filter((field) => field.type === "radio")[0]?.options).toEqual([
      { label: "Yes", value: "yes" },
      { label: "No", value: "no" },
    ]);
    for (const button of Array.from(document.querySelectorAll(".ashby-application-form-input-yesno button[data-option]"))) {
      button.addEventListener("click", () => {
        for (const sibling of Array.from(button.parentElement?.querySelectorAll("button[data-option]") ?? [])) sibling.setAttribute("aria-pressed", sibling === button ? "true" : "false");
      });
    }
    await fields[0]!.select("no");
    expect(await fields[0]!.readValue?.()).toBe("no");
  });

  it("reads the associated label when a native radio uses the generic on value", async () => {
    document.body.innerHTML = `
      <form>
        <div class="ashby-application-form-field-entry">
          <div class="ashby-application-form-question-title">May we contact you?</div>
          <label for="contact-yes">Yes</label>
          <input id="contact-yes" name="contact" type="radio" value="on" checked>
          <label for="contact-no">No</label>
          <input id="contact-no" name="contact" type="radio" value="on">
        </div>
      </form>
    `;
    const fields = await sessionForDocument("https://jobs.ashbyhq.com/meridianlink/a3b7147c-f9c5-4dd4-9cf2-e8c183b19162/application").inspectFields();
    expect(fields.filter((field) => field.type === "radio")).toHaveLength(1);
    expect(await fields.find((field) => field.type === "radio")?.readValue?.()).toBe("Yes");
  });

  it("scopes Ashby native radio selection to the owning field entry", async () => {
    document.body.innerHTML = `
      <form>
        <div class="ashby-application-form-field-entry">
          <div class="ashby-application-form-question-title">What gender do you identify as?</div>
          <label><input id="custom-female" name="shared-gender" type="radio" value="female">Female</label>
          <label><input id="custom-male" name="shared-gender" type="radio" value="male">Male</label>
          <label><input id="custom-nonbinary" name="shared-gender" type="radio" value="non-binary">Non-binary</label>
        </div>
        <div class="ashby-application-form-field-entry">
          <div class="ashby-application-form-question-title">What is your other gender preference?</div>
          <label><input id="other-female" name="shared-gender" type="radio" value="female">Female</label>
          <label><input id="other-male" name="shared-gender" type="radio" value="male">Male</label>
          <label><input id="other-nonbinary" name="shared-gender" type="radio" value="non-binary">Non-binary</label>
        </div>
      </form>
    `;
    const fields = await sessionForDocument("https://jobs.ashbyhq.com/meridianlink/a3b7147c-f9c5-4dd4-9cf2-e8c183b19162/application").inspectFields();
    const gender = fields.find((field) => field.label === "What gender do you identify as?");
    expect(gender).toBeDefined();
    await gender!.select("male");
    expect((document.querySelector("#custom-male") as HTMLInputElement).checked).toBe(true);
    expect((document.querySelector("#other-male") as HTMLInputElement).checked).toBe(false);
    expect(await gender!.readValue?.()).toBe("Male");
  });

  it("uses Ashby's field title instead of the first race option as the prompt", async () => {
    document.body.innerHTML = `
      <form>
        <div class="ashby-application-form-field-entry" data-field-path="_systemfield_eeoc_race">
          <div class="ashby-application-form-question-title">Race</div>
          <label><input id="race-hispanic" name="race" type="radio" value="Hispanic or Latino">Hispanic or Latino</label>
          <label><input id="race-white" name="race" type="radio" value="White (Not Hispanic or Latino)">White (Not Hispanic or Latino)</label>
        </div>
      </form>
    `;
    const fields = await sessionForDocument("https://jobs.ashbyhq.com/meridianlink/a3b7147c-f9c5-4dd4-9cf2-e8c183b19162/application").inspectFields();
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ id: "_systemfield_eeoc_race", label: "Race" });
    await fields[0]!.select("White (Not Hispanic or Latino)");
    expect((document.querySelector("#race-white") as HTMLInputElement).checked).toBe(true);
    expect((document.querySelector("#race-hispanic") as HTMLInputElement).checked).toBe(false);
    expect(await fields[0]!.readValue?.()).toBe("White (Not Hispanic or Latino)");
  });

  it("deduplicates duplicated Ashby EEOC gender groups when prompt wrappers differ", async () => {
    document.body.innerHTML = `
      <form>
        <div class="ashby-application-form-field-entry">
          <div class="ashby-application-form-question-title">Input gender</div>
          <label><input id="2a5__systemfield_eeoc_gender-labeled-radio-0" name="2a5__systemfield_eeoc_gender" type="radio" value="Male">Male</label>
          <label><input id="2a5__systemfield_eeoc_gender-labeled-radio-1" name="2a5__systemfield_eeoc_gender" type="radio" value="Female">Female</label>
        </div>
        <div class="ashby-application-form-field-entry">
          <div class="ashby-application-form-question-title">Gender</div>
          <label><input id="2a5__systemfield_eeoc_gender-labeled-radio-0-duplicate" name="2a5__systemfield_eeoc_gender" type="radio" value="Male">Male</label>
          <label><input id="2a5__systemfield_eeoc_gender-labeled-radio-1-duplicate" name="2a5__systemfield_eeoc_gender" type="radio" value="Female">Female</label>
        </div>
        <div class="ashby-application-form-field-entry">
          <div class="ashby-application-form-question-title">Optional diversity question</div>
          <label><input id="other__gender-labeled-radio-0" name="other__gender" type="radio" value="Yes">Yes</label>
          <label><input id="other__gender-labeled-radio-1" name="other__gender" type="radio" value="No">No</label>
        </div>
      </form>
    `;
    const fields = await sessionForDocument("https://jobs.ashbyhq.com/meridianlink/a3b7147c-f9c5-4dd4-9cf2-e8c183b19162/application").inspectFields();
    expect(fields.filter((field) => field.type === "radio")).toHaveLength(2);
    expect(fields.filter((field) => field.type === "radio").map((field) => field.id)).toEqual([
      "2a5__systemfield_eeoc_gender-labeled-radio-0",
      "other__gender-labeled-radio-0",
    ]);
  });

  it("rebinds an Ashby combobox to its only visible listbox after the owned node is replaced", async () => {
    document.body.innerHTML = `
      <form>
        <div id="field-12" role="combobox" aria-expanded="false" aria-controls="stale-listbox">Select...</div>
      </form>
      <div id="stale-listbox" role="listbox" style="display:none"><div role="option">McDonald, Pennsylvania, United States</div></div>
      <div id="fresh-listbox" role="listbox" style="display:none"><div role="option">McDonald, Pennsylvania, United States</div></div>
    `;
    const control = document.querySelector("#field-12") as HTMLElement;
    const stale = document.querySelector("#stale-listbox") as HTMLElement;
    const fresh = document.querySelector("#fresh-listbox") as HTMLElement;
    control.addEventListener("click", () => {
      stale.style.display = "none";
      fresh.style.display = "block";
      control.setAttribute("aria-expanded", "true");
    });
    fresh.querySelector('[role="option"]')?.addEventListener("click", () => {
      control.textContent = "McDonald, Pennsylvania, United States";
      control.setAttribute("aria-expanded", "false");
      fresh.style.display = "none";
    });
    const fields = await sessionForDocument("https://jobs.ashbyhq.com/meridianlink/a3b7147c-f9c5-4dd4-9cf2-e8c183b19162/application").inspectFields();
    await fields[0]!.select("McDonald, Pennsylvania, USA", { groundedLocation: "McDonald, Pennsylvania, USA" });
    expect(await fields[0]!.readValue?.()).toBe("McDonald, Pennsylvania, United States");
  });

  it("treats duplicate Ashby option renderings without values as one verified choice", async () => {
    document.body.innerHTML = `
      <form>
        <div id="source" role="combobox" aria-expanded="false" aria-controls="source-options">Select...</div>
      </form>
      <div id="source-options" role="listbox" style="display:none">
        <div role="option"><div class="select__option">Internet</div></div>
      </div>
    `;
    const control = document.querySelector("#source") as HTMLElement;
    const listbox = document.querySelector("#source-options") as HTMLElement;
    control.addEventListener("click", () => {
      listbox.style.display = "block";
      control.setAttribute("aria-expanded", "true");
    });
    listbox.querySelectorAll('[role="option"]').forEach((option) => option.addEventListener("click", () => {
      control.textContent = "Internet";
      control.setAttribute("aria-expanded", "false");
      listbox.style.display = "none";
    }));
    const fields = await sessionForDocument("https://jobs.ashbyhq.com/meridianlink/a3b7147c-f9c5-4dd4-9cf2-e8c183b19162/application").inspectFields();
    await fields[0]!.select("internet");
    expect(await fields[0]!.readValue?.()).toBe("Internet");
  });

  it("opens Ashby custom selects through the unique field-container toggle", async () => {
    document.body.innerHTML = `
      <form>
        <div data-field-path="job_source">
          <input id="source" role="combobox" aria-expanded="false">
          <button type="button" aria-label="Open source options">Open</button>
        </div>
      </form>
      <div id="source-options" role="listbox" style="display:none">
        <div role="option">Indeed</div>
        <div role="option">LinkedIn</div>
        <div role="option">MeridianLink Career Site</div>
      </div>
    `;
    const field = document.querySelector("#source") as HTMLInputElement;
    const button = document.querySelector('[data-field-path="job_source"] button') as HTMLButtonElement;
    const listbox = document.querySelector("#source-options") as HTMLElement;
    button.addEventListener("click", () => {
      field.setAttribute("aria-expanded", "true");
      listbox.style.display = "block";
    });

    const fields = await sessionForDocument("https://jobs.ashbyhq.com/meridianlink/a3b7147c-f9c5-4dd4-9cf2-e8c183b19162/application").inspectFields();
    expect(fields[0]?.options).toEqual([
      { label: "Indeed", value: "Indeed" },
      { label: "LinkedIn", value: "LinkedIn" },
      { label: "MeridianLink Career Site", value: "MeridianLink Career Site" },
    ]);
    expect(field.getAttribute("aria-expanded")).toBe("true");
  });

  it("does not treat a generic Internet answer as a unique Ashby source choice", () => {
    expect(unmatchedSelectOptionMessage("internet", ["Indeed", "LinkedIn", "MeridianLink Career Site"]))
      .toBe("The select option internet was not found; verified choices:indeed|linkedin|meridianlink career site.");
  });
});
