import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Response } from "playwright";
import type {
  ApplicationFieldOption,
  ApplicationFieldType,
  BrowserHumanBoundary,
  BrowserCaptchaDiagnostics,
  BrowserExecutionBoundaryState,
  BrowserExecutionDiagnostic,
  BrowserNavigationDiagnostics,
  LeverBrowserField,
  LeverBrowserSession,
  LeverBrowserSessionFactory,
} from "../src/domain/executor";
import {
  BrowserExecutionDiagnosticError,
  safeBrowserDiagnosticMessage,
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

export interface CaptchaDomObservation {
  markerCount: number;
  visibleMarkerCount: number;
  challengeIframeCount: number;
  visibleChallengeIframeCount: number;
  visibleChallengeControlCount: number;
  explicitChallengeText: boolean;
}

/**
 * Classifies only observable CAPTCHA evidence. Visible but non-specific
 * provider UI remains a human gate through `uncertain`; hidden infrastructure
 * is recorded without requiring interaction.
 */
export function classifyCaptchaEvidence(observation: CaptchaDomObservation): BrowserCaptchaDiagnostics {
  if (observation.explicitChallengeText) {
    return {
      state: "active_challenge",
      markerCount: observation.markerCount,
      visibleMarkerCount: observation.visibleMarkerCount,
      challengeIframeCount: observation.challengeIframeCount,
      visibleChallengeIframeCount: observation.visibleChallengeIframeCount,
      evidenceCategory: "explicit_challenge_text",
    };
  }
  if (observation.visibleChallengeIframeCount > 0) {
    return {
      state: "active_challenge",
      markerCount: observation.markerCount,
      visibleMarkerCount: observation.visibleMarkerCount,
      challengeIframeCount: observation.challengeIframeCount,
      visibleChallengeIframeCount: observation.visibleChallengeIframeCount,
      evidenceCategory: "visible_challenge_iframe",
    };
  }
  if (observation.visibleChallengeControlCount > 0) {
    return {
      state: "active_challenge",
      markerCount: observation.markerCount,
      visibleMarkerCount: observation.visibleMarkerCount,
      challengeIframeCount: observation.challengeIframeCount,
      visibleChallengeIframeCount: observation.visibleChallengeIframeCount,
      evidenceCategory: "visible_challenge_control",
    };
  }
  if (observation.markerCount === 0) {
    return {
      state: "none",
      markerCount: 0,
      visibleMarkerCount: 0,
      challengeIframeCount: 0,
      visibleChallengeIframeCount: 0,
      evidenceCategory: "no_markers",
    };
  }
  if (observation.visibleMarkerCount > 0) {
    return {
      state: "uncertain",
      markerCount: observation.markerCount,
      visibleMarkerCount: observation.visibleMarkerCount,
      challengeIframeCount: observation.challengeIframeCount,
      visibleChallengeIframeCount: observation.visibleChallengeIframeCount,
      evidenceCategory: "visible_marker_ambiguous",
    };
  }
  return {
    state: "infrastructure_present",
    markerCount: observation.markerCount,
    visibleMarkerCount: 0,
    challengeIframeCount: observation.challengeIframeCount,
    visibleChallengeIframeCount: 0,
    evidenceCategory: "hidden_infrastructure",
  };
}

const CAPTCHA_MARKER_SELECTOR = [
  'iframe[src*="captcha"]',
  'iframe[src*="recaptcha"]',
  '[id*="captcha"]',
  '[class*="captcha"]',
  'script[src*="captcha"]',
  'script[src*="recaptcha"]',
  'input[name*="captcha"]',
  '[data-sitekey]',
].join(", ");

const ACTIVE_CAPTCHA_TEXT = /(?:verify\s+you\s+are\s+human|prove\s+you\s+are\s+human|i['’]?m\s+not\s+a\s+robot|select\s+all\b|captcha\s+challenge|recaptcha\s+challenge|complete\s+(?:the\s+)?captcha|checking\s+your\s+browser|security\s+check)/i;

function captchaEvidence(captcha: BrowserCaptchaDiagnostics): string[] {
  return [
    `captcha-state:${captcha.state}`,
    `captcha-elements:${captcha.markerCount}`,
    `captcha-visible-elements:${captcha.visibleMarkerCount}`,
    `captcha-challenge-iframes:${captcha.challengeIframeCount}`,
    `captcha-visible-challenge-iframes:${captcha.visibleChallengeIframeCount}`,
    `captcha-evidence:${captcha.evidenceCategory}`,
  ];
}

function visibleFormControl(locator: Locator): Promise<boolean> {
  return locator.isVisible().catch(() => false);
}

function hostnameOf(value: string): string | undefined {
  try {
    return new URL(value).hostname || undefined;
  } catch {
    return undefined;
  }
}

function statusCategory(status: number): BrowserNavigationDiagnostics["httpStatusCategory"] {
  const category = Math.floor(status / 100);
  return category >= 1 && category <= 5 ? `${category}xx` as BrowserNavigationDiagnostics["httpStatusCategory"] : undefined;
}

function redirectCount(response: Response | null): number {
  let count = 0;
  let request = response?.request();
  while (request?.redirectedFrom()) {
    count += 1;
    request = request.redirectedFrom() ?? undefined;
  }
  return count;
}

function isTimeoutError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return name.toLowerCase().includes("timeout") || message.toLowerCase().includes("timeout");
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
  private boundaryState: BrowserExecutionBoundaryState;
  private navigationDiagnostics: BrowserNavigationDiagnostics = { outcome: "not_started" };
  private diagnostic?: BrowserExecutionDiagnostic;
  private captchaDiagnostics?: BrowserCaptchaDiagnostics;

  constructor(
    private readonly page: Page,
    private readonly context: BrowserContext,
    private readonly browser: Browser,
    private readonly timeoutMs: number,
    boundaries: BrowserExecutionBoundaryState,
  ) {
    this.page.setDefaultTimeout(timeoutMs);
    this.boundaryState = { ...boundaries };
  }

  diagnostics() {
    return {
      boundaries: { ...this.boundaryState },
      navigation: { ...this.navigationDiagnostics },
      ...(this.diagnostic ? { diagnostic: this.diagnostic } : {}),
      ...(this.captchaDiagnostics ? { captcha: { ...this.captchaDiagnostics } } : {}),
    };
  }

  async navigate(url: string): Promise<void> {
    const targetHost = hostnameOf(url);
    this.boundaryState = { ...this.boundaryState, navigationStarted: true };
    this.navigationDiagnostics = {
      targetHost,
      outcome: "started",
    };
    try {
      const response = await this.page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: this.timeoutMs,
      });
      const httpStatus = response?.status();
      this.boundaryState = {
        ...this.boundaryState,
        navigationCompleted: true,
        domReady: true,
      };
      this.navigationDiagnostics = {
        targetHost,
        finalHostname: hostnameOf(this.page.url()),
        outcome: httpStatus !== undefined && httpStatus >= 400 ? "http_error" : "completed",
        ...(httpStatus !== undefined ? { httpStatus, httpStatusCategory: statusCategory(httpStatus) } : {}),
        redirectCount: redirectCount(response),
        loadStateReached: "domcontentloaded",
      };
      try {
        await this.page.waitForLoadState("networkidle", {
          timeout: Math.min(this.timeoutMs, 3_000),
        });
        this.navigationDiagnostics = {
          ...this.navigationDiagnostics,
          loadStateReached: "networkidle",
          finalHostname: hostnameOf(this.page.url()),
        };
      } catch (error) {
        if (isTimeoutError(error)) {
          this.navigationDiagnostics = {
            ...this.navigationDiagnostics,
            networkIdleTimedOut: true,
            finalHostname: hostnameOf(this.page.url()),
          };
        } else {
          this.diagnostic = {
            stage: "page_load",
            reasonCode: "page_load_failed",
            message: safeBrowserDiagnosticMessage(error, "The page did not reach the requested load state."),
            boundaries: { ...this.boundaryState },
            navigation: { ...this.navigationDiagnostics },
          };
        }
      }
    } catch (error) {
      this.navigationDiagnostics = {
        ...this.navigationDiagnostics,
        outcome: "failed",
        finalHostname: hostnameOf(this.page.url()),
      };
      const diagnostic: BrowserExecutionDiagnostic = {
        stage: "navigation",
        reasonCode: isTimeoutError(error) ? "navigation_timeout" : "navigation_failed",
        message: safeBrowserDiagnosticMessage(error, "The Lever application page could not be opened."),
        boundaries: { ...this.boundaryState },
        navigation: { ...this.navigationDiagnostics },
      };
      this.diagnostic = diagnostic;
      throw new BrowserExecutionDiagnosticError(diagnostic);
    }
  }

  currentUrl(): string {
    return this.page.url();
  }

  async detectHumanBoundary(): Promise<BrowserHumanBoundary | null> {
    const passwordCount = await this.page.locator('input[type="password"]').count().catch(() => 0);
    const captchaObservation = await this.page.locator(CAPTCHA_MARKER_SELECTOR).evaluateAll((elements): Omit<CaptchaDomObservation, "explicitChallengeText"> => {
      const isVisible = (element: Element): boolean => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return element.getAttribute("aria-hidden") !== "true" &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number.parseFloat(style.opacity || "1") > 0 &&
          rect.width > 0 &&
          rect.height > 0;
      };
      const isChallengeIframe = (element: Element): boolean => {
        if (element.tagName.toLowerCase() !== "iframe") return false;
        const haystack = [
          element.getAttribute("src") ?? "",
          element.getAttribute("title") ?? "",
          element.getAttribute("aria-label") ?? "",
        ].join(" ").toLowerCase();
        return /(?:bframe|anchor|challenge|verify)/.test(haystack);
      };
      const isChallengeControl = (element: Element, visible: boolean): boolean => {
        if (!visible) return false;
        const haystack = [
          element.getAttribute("aria-label") ?? "",
          element.getAttribute("title") ?? "",
          element.textContent ?? "",
        ].join(" ");
        return /(?:verify\s+you\s+are\s+human|prove\s+you\s+are\s+human|i['’]?m\s+not\s+a\s+robot|select\s+all\b|captcha\s+challenge|recaptcha\s+challenge|complete\s+(?:the\s+)?captcha|checking\s+your\s+browser|security\s+check)/i.test(haystack);
      };
      let visibleMarkerCount = 0;
      let challengeIframeCount = 0;
      let visibleChallengeIframeCount = 0;
      let visibleChallengeControlCount = 0;
      for (const element of elements) {
        const visible = isVisible(element);
        if (visible) visibleMarkerCount += 1;
        const challengeIframe = isChallengeIframe(element);
        if (challengeIframe) challengeIframeCount += 1;
        if (challengeIframe && visible) visibleChallengeIframeCount += 1;
        if (isChallengeControl(element, visible)) visibleChallengeControlCount += 1;
      }
      return {
        markerCount: elements.length,
        visibleMarkerCount,
        challengeIframeCount,
        visibleChallengeIframeCount,
        visibleChallengeControlCount,
      };
    }).catch(() => ({
      markerCount: 0,
      visibleMarkerCount: 0,
      challengeIframeCount: 0,
      visibleChallengeIframeCount: 0,
      visibleChallengeControlCount: 0,
    }));
    const bodyText = await this.page.locator("body").innerText({ timeout: this.timeoutMs }).catch(() => "");
    const lowerBody = bodyText.toLowerCase();
    this.captchaDiagnostics = classifyCaptchaEvidence({
      ...captchaObservation,
      explicitChallengeText: ACTIVE_CAPTCHA_TEXT.test(lowerBody),
    });

    if (this.captchaDiagnostics.state === "active_challenge" || this.captchaDiagnostics.state === "uncertain") {
      return {
        kind: "captcha",
        question: "Complete the CAPTCHA in the browser",
        reason: "The Lever application is protected by a CAPTCHA or human-verification boundary. The executor will not bypass it.",
        evidence: [
          ...captchaEvidence(this.captchaDiagnostics),
          "credentials-never-requested",
          "submit:not-clicked",
        ],
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
    this.boundaryState = { ...this.boundaryState, browserClosed: true };
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
    let browser: Browser;
    try {
      browser = await chromium.launch({
        headless: this.options.headless,
        slowMo: this.options.slowMo,
      });
    } catch (error) {
      throw new BrowserExecutionDiagnosticError({
        stage: "browser_launch",
        reasonCode: "browser_launch_failed",
        message: safeBrowserDiagnosticMessage(error, "Chromium could not be launched."),
        boundaries: { browserLaunched: false, contextCreated: false, pageCreated: false },
      });
    }

    let context: BrowserContext;
    try {
      context = await browser.newContext({
        acceptDownloads: false,
      });
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw new BrowserExecutionDiagnosticError({
        stage: "context_create",
        reasonCode: "context_create_failed",
        message: safeBrowserDiagnosticMessage(error, "The Chromium browser context could not be created."),
        boundaries: { browserLaunched: true, contextCreated: false, pageCreated: false },
      });
    }

    let page: Page;
    try {
      page = await context.newPage();
    } catch (error) {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
      throw new BrowserExecutionDiagnosticError({
        stage: "page_create",
        reasonCode: "page_create_failed",
        message: safeBrowserDiagnosticMessage(error, "The Chromium page could not be created."),
        boundaries: { browserLaunched: true, contextCreated: true, pageCreated: false },
      });
    }

    return new PlaywrightLeverBrowserSession(page, context, browser, this.options.timeoutMs, {
      browserLaunched: true,
      contextCreated: true,
      pageCreated: true,
    });
  }
}
