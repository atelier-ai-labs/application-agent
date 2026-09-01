import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import type {
  ApplicationFieldOption,
  ApplicationFieldType,
  BrowserHumanBoundary,
  LeverBrowserField,
  LeverBrowserSession,
  LeverBrowserSessionFactory,
} from "../src/domain/executor";

export interface PlaywrightLeverBrowserOptions {
  headless?: boolean;
  slowMo?: number;
  timeoutMs?: number;
}

interface InspectedRawField {
  index: number;
  id: string;
  label: string;
  type: ApplicationFieldType;
  required: boolean;
  options?: readonly ApplicationFieldOption[];
  section?: string;
  groupName?: string;
}

function visibleFormControl(locator: Locator): Promise<boolean> {
  return locator.isVisible().catch(() => false);
}

class PlaywrightLeverBrowserField implements LeverBrowserField {
  public readonly classification = "unknown" as const;
  public readonly id: string;
  public readonly label: string;
  public readonly type: ApplicationFieldType;
  public readonly required: boolean;
  public readonly options?: readonly ApplicationFieldOption[];
  public readonly section?: string;
  public readonly sourceSelector: string;

  constructor(
    private readonly page: Page,
    private readonly raw: InspectedRawField,
  ) {
    this.id = raw.id;
    this.label = raw.label;
    this.type = raw.type;
    this.required = raw.required;
    this.options = raw.options;
    this.section = raw.section;
    this.sourceSelector = `form-control-index:${raw.index}`;
  }

  private locator(): Locator {
    return this.page.locator("input, textarea, select").nth(this.raw.index);
  }

  async fill(value: string): Promise<void> {
    await this.locator().fill(value);
  }

  async select(value: string): Promise<void> {
    if (this.type === "select") {
      await this.locator().selectOption(value);
      return;
    }

    if (this.type === "radio") {
      const radios = this.page.locator('input[type="radio"]');
      const count = await radios.count();
      for (let index = 0; index < count; index += 1) {
        const candidate = radios.nth(index);
        const matches = await candidate.evaluate((element, wanted) => {
          const input = element as HTMLInputElement;
          const labels = input.id
            ? Array.from(document.querySelectorAll("label")).filter((label) => label.htmlFor === input.id)
            : [];
          const labelText = labels.map((label) => label.textContent ?? "").join(" ");
          return input.name === wanted.name && (
            input.value === wanted.value ||
            labelText.trim().toLowerCase() === wanted.value.trim().toLowerCase()
          );
        }, { name: this.raw.groupName ?? "", value });
        if (matches) {
          await candidate.check();
          return;
        }
      }
    }

    throw new Error(`The radio option ${value} was not found.`);
  }

  async setChecked(value: boolean): Promise<void> {
    if (value) await this.locator().check();
    else await this.locator().uncheck();
  }

  async uploadFile(path: string): Promise<void> {
    await this.locator().setInputFiles(path);
  }

  async readValue(): Promise<string | boolean | null> {
    if (this.type === "checkbox") {
      return this.locator().isChecked();
    }
    if (this.type === "radio") {
      const radios = this.page.locator('input[type="radio"]');
      const count = await radios.count();
      for (let index = 0; index < count; index += 1) {
        const radio = radios.nth(index);
        const state = await radio.evaluate((element, wanted) => {
          const input = element as HTMLInputElement;
          return input.name === wanted && input.checked ? input.value : null;
        }, this.raw.groupName ?? "");
        if (state) return state;
      }
      return null;
    }
    const value = await this.locator().inputValue();
    return value.trim() ? value : null;
  }
}

export class PlaywrightLeverBrowserSession implements LeverBrowserSession {
  private closed = false;

  constructor(
    private readonly page: Page,
    private readonly context: BrowserContext,
    private readonly browser: Browser,
    private readonly timeoutMs: number,
  ) {
    this.page.setDefaultTimeout(timeoutMs);
  }

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: this.timeoutMs,
    });
    await this.page.waitForLoadState("networkidle", {
      timeout: Math.min(this.timeoutMs, 3_000),
    }).catch(() => undefined);
  }

  currentUrl(): string {
    return this.page.url();
  }

  async detectHumanBoundary(): Promise<BrowserHumanBoundary | null> {
    const passwordCount = await this.page.locator('input[type="password"]').count().catch(() => 0);
    const captchaCount = await this.page.locator(
      'iframe[src*="captcha"], iframe[src*="recaptcha"], [id*="captcha"], [class*="captcha"]',
    ).count().catch(() => 0);
    const bodyText = await this.page.locator("body").innerText({ timeout: this.timeoutMs }).catch(() => "");
    const lowerBody = bodyText.toLowerCase();

    if (captchaCount > 0 || /captcha|recaptcha|prove you are human/.test(lowerBody)) {
      return {
        kind: "captcha",
        question: "Complete the CAPTCHA in the browser",
        reason: "The Lever application is protected by a CAPTCHA or human-verification boundary. The executor will not bypass it.",
        evidence: [`captcha-elements:${captchaCount}`, "credentials-never-requested", "submit:not-clicked"],
      };
    }

    if (passwordCount > 0 || /\b(?:sign in|log in|login|multi-factor|mfa|verification code)\b/.test(lowerBody)) {
      return {
        kind: "external_login",
        question: "Authenticate the application session in the browser",
        reason: "The application requires login, MFA, or an authenticated session. Complete it in the browser; credentials are never stored in application state.",
        evidence: [`password-fields:${passwordCount}`, "credentials-never-requested", "submit:not-clicked"],
      };
    }

    return null;
  }

  async inspectFields(): Promise<readonly LeverBrowserField[]> {
    const controls = this.page.locator("input, textarea, select");
    const raw = await controls.evaluateAll((elements) => elements.flatMap((element, index): InspectedRawField[] => {
      const control = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      if (control instanceof HTMLInputElement && ["hidden", "submit", "button", "reset"].includes(control.type.toLowerCase())) {
        return [];
      }

      const labels = Array.from(document.querySelectorAll("label"));
      const associated = control.id
        ? labels.find((label) => label.htmlFor === control.id)
        : labels.find((label) => label.contains(control));
      const fieldset = control.closest("fieldset");
      const legend = fieldset?.querySelector("legend")?.textContent?.trim();
      const label = (
        associated?.textContent?.trim() ||
        control.getAttribute("aria-label")?.trim() ||
        control.getAttribute("placeholder")?.trim() ||
        control.getAttribute("name")?.trim() ||
        control.id.trim() ||
        `Field ${index + 1}`
      );
      const rawType = control instanceof HTMLInputElement
        ? control.type.toLowerCase()
        : control instanceof HTMLTextAreaElement
          ? "textarea"
          : "select";
      const type: ApplicationFieldType = control instanceof HTMLTextAreaElement
        ? "textarea"
        : control instanceof HTMLSelectElement
          ? "select"
          : rawType === "email"
            ? "email"
            : rawType === "tel"
              ? "tel"
              : rawType === "file"
                ? "file"
                : rawType === "checkbox"
                  ? "checkbox"
                  : rawType === "radio"
                    ? "radio"
                    : ["text", "search", "url", "number"].includes(rawType)
                      ? "text"
                      : "unknown";
      const options = control instanceof HTMLSelectElement
        ? Array.from(control.options).map((option) => ({ label: option.textContent?.trim() || option.value, value: option.value }))
        : type === "radio" && control.name
          ? Array.from(document.querySelectorAll('input[type="radio"]'))
              .filter((candidate) => (candidate as HTMLInputElement).name === control.name)
              .map((candidate) => {
                const radio = candidate as HTMLInputElement;
                const labelForRadio = radio.id
                  ? labels.find((label) => label.htmlFor === radio.id)
                  : labels.find((label) => label.contains(radio));
                return {
                  label: labelForRadio?.textContent?.trim() || radio.value,
                  value: radio.value,
                };
              })
          : undefined;
      const id = control.id.trim() || control.getAttribute("name")?.trim() || `field-${index + 1}`;
      const isFirstRadioInGroup = type !== "radio" || !control.name ||
        Array.from(document.querySelectorAll('input[type="radio"]')).find((candidate) => (candidate as HTMLInputElement).name === control.name) === control;
      return [{
        index,
        id,
        label,
        type,
        required: isFirstRadioInGroup && (control.required || control.getAttribute("aria-required") === "true"),
        ...(options && options.length > 0 ? { options } : {}),
        ...(legend ? { section: legend } : {}),
        ...(control instanceof HTMLInputElement && control.type.toLowerCase() === "radio" && control.name
          ? { groupName: control.name }
          : {}),
      }];
    }));

    const fields: LeverBrowserField[] = [];
    const idOccurrences = new Map<string, number>();
    for (const item of raw) {
      const occurrence = idOccurrences.get(item.id) ?? 0;
      idOccurrences.set(item.id, occurrence + 1);
      const uniqueItem = occurrence === 0
        ? item
        : { ...item, id: `${item.id}--${occurrence + 1}` };
      const locator = controls.nth(uniqueItem.index);
      if (await visibleFormControl(locator)) {
        fields.push(new PlaywrightLeverBrowserField(this.page, uniqueItem));
      }
    }
    return fields;
  }

  async hasSubmitControl(): Promise<boolean> {
    const submitInputs = this.page.locator('input[type="submit"], button[type="submit"]');
    if (await submitInputs.count() > 0) {
      for (let index = 0; index < await submitInputs.count(); index += 1) {
        if (await visibleFormControl(submitInputs.nth(index))) return true;
      }
    }
    // Text-only buttons are considered only inside the application form. This
    // avoids treating a page-level cookie/help/navigation button as Submit.
    const buttons = this.page.locator("form button");
    const count = await buttons.count();
    for (let index = 0; index < count; index += 1) {
      const button = buttons.nth(index);
      if (!(await visibleFormControl(button))) continue;
      const text = (await button.innerText().catch(() => "")).trim().toLowerCase();
      if (/^(?:submit(?: application)?|apply(?: now)?|send application)$/.test(text)) return true;
    }
    return false;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }
}

export class PlaywrightLeverBrowserSessionFactory implements LeverBrowserSessionFactory {
  private readonly options: Required<PlaywrightLeverBrowserOptions>;

  constructor(options: PlaywrightLeverBrowserOptions = {}) {
    this.options = {
      headless: options.headless ?? true,
      slowMo: options.slowMo ?? 0,
      timeoutMs: options.timeoutMs ?? 15_000,
    };
  }

  async open(_applicationId: string): Promise<LeverBrowserSession> {
    const browser = await chromium.launch({
      headless: this.options.headless,
      slowMo: this.options.slowMo,
    });
    const context = await browser.newContext({
      acceptDownloads: false,
    });
    const page = await context.newPage();
    return new PlaywrightLeverBrowserSession(page, context, browser, this.options.timeoutMs);
  }
}
