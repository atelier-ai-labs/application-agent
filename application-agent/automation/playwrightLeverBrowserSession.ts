import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Response } from "playwright";
import type {
  ApplicationFieldOption,
  ApplicationFieldQuestionDescriptor,
  ApplicationFieldType,
  BrowserHumanBoundary,
  BrowserCaptchaDiagnostics,
  BrowserExecutionBoundaryState,
  BrowserExecutionDiagnostic,
  BrowserNavigationDiagnostics,
  BrowserSubmissionResult,
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
  stableSelector?: string;
  stableSelectorSource?: string;
  stableIdentity?: StableControlIdentity;
  stableIdentityUnique?: boolean;
  options?: readonly ApplicationFieldOption[];
  section?: string;
  groupName?: string;
  questionEvidence?: LeverQuestionAssociationEvidence;
}

export interface LeverQuestionAssociationEvidence {
  fieldsetLegend?: string;
  ariaLabelledByText?: string;
  accessibleName?: string;
  questionContainerPrompts?: readonly string[];
  nearbyPromptText?: string;
  sectionTitle?: string;
  nearbyInstructionText?: string;
}

export interface StableControlIdentity {
  tagName: string;
  id?: string;
  name?: string;
  type?: string;
  value?: string;
  ariaLabel?: string;
}

function boundedDescriptorText(value: string | undefined, maximum = 240): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").replace(/\s*[✱]\s*$/, "").trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function uniqueDescriptorTexts(values: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const bounded = boundedDescriptorText(value);
    if (!bounded) continue;
    const key = bounded.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(bounded);
  }
  return result;
}

/** Resolves only explicit or tightly bounded question associations. */
export function questionDescriptorFromEvidence(
  evidence: LeverQuestionAssociationEvidence,
): ApplicationFieldQuestionDescriptor | undefined {
  const sectionTitle = boundedDescriptorText(evidence.sectionTitle, 160);
  const accessibleName = boundedDescriptorText(evidence.accessibleName);
  const nearbyInstructionText = boundedDescriptorText(evidence.nearbyInstructionText, 160);
  const context = {
    ...(sectionTitle ? { sectionTitle } : {}),
    ...(accessibleName ? { accessibleName } : {}),
    ...(nearbyInstructionText ? { nearbyInstructionText } : {}),
  };
  const explicitSources: readonly [string | undefined, ApplicationFieldQuestionDescriptor["sourceStrategy"]][] = [
    [evidence.fieldsetLegend, "fieldset_legend"],
    [evidence.ariaLabelledByText, "aria_labelledby"],
  ];
  for (const [candidate, sourceStrategy] of explicitSources) {
    const promptText = boundedDescriptorText(candidate);
    if (promptText) {
      return {
        ...context,
        promptText,
        sourceStrategy,
        confidence: "high",
      };
    }
  }

  const prompts = uniqueDescriptorTexts(evidence.questionContainerPrompts ?? []);
  if (prompts.length === 1) {
    return {
      ...context,
      promptText: prompts[0],
      sourceStrategy: "question_container",
      confidence: "high",
    };
  }
  if (prompts.length > 1) {
    return {
      ...context,
      sourceStrategy: "unavailable",
      confidence: "uncertain",
    };
  }

  const nearbyPromptText = boundedDescriptorText(evidence.nearbyPromptText);
  if (nearbyPromptText) {
    return {
      ...context,
      promptText: nearbyPromptText,
      sourceStrategy: "nearby_text",
      confidence: "uncertain",
    };
  }
  return Object.keys(context).length > 0
    ? { ...context, sourceStrategy: "unavailable", confidence: "uncertain" }
    : undefined;
}

export interface CaptchaDomObservation {
  markerCount: number;
  visibleMarkerCount: number;
  passiveVisibleMarkerCount?: number;
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
  if (observation.visibleMarkerCount > (observation.passiveVisibleMarkerCount ?? 0)) {
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
    visibleMarkerCount: observation.visibleMarkerCount,
    challengeIframeCount: observation.challengeIframeCount,
    visibleChallengeIframeCount: 0,
    evidenceCategory: observation.visibleMarkerCount > 0 ? "passive_infrastructure" : "hidden_infrastructure",
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
  'textarea[name*="captcha"]',
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

/** Escapes a value for a CSS identifier without relying on a browser global. */
export function escapeCssIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
}

function escapeCssAttribute(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Builds a stable locator from DOM identity; it never falls back to position. */
export function stableSelectorForControl(
  identity: StableControlIdentity,
): { selector: string; source: string } | undefined {
  const tagName = identity.tagName.toLowerCase();
  if (identity.id?.trim()) {
    return {
      selector: `${tagName}#${escapeCssIdentifier(identity.id.trim())}`,
      source: `dom-id:${identity.id.trim()}`,
    };
  }
  if (identity.name?.trim()) {
    const nameSelector = `${tagName}[name="${escapeCssAttribute(identity.name.trim())}"]`;
    const selector = identity.type?.toLowerCase() === "radio" && identity.value !== undefined
      ? `${nameSelector}[value="${escapeCssAttribute(identity.value)}"]`
      : nameSelector;
    return { selector, source: `dom-name:${identity.name.trim()}` };
  }
  if (identity.ariaLabel?.trim()) {
    return {
      selector: `${tagName}[aria-label="${escapeCssAttribute(identity.ariaLabel.trim())}"]`,
      source: "dom-aria-label",
    };
  }
  return undefined;
}

/** Greenhouse country options append a dialing code to the visible label. */
export function greenhouseOptionMatches(
  optionText: string,
  optionValue: string | null,
  desired: string,
): boolean {
  const normalize = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");
  const normalizedText = normalize(optionText);
  const normalizedDesired = normalize(desired);
  return normalizedText === normalizedDesired ||
    (optionValue !== null && normalize(optionValue) === normalizedDesired) ||
    normalizedText.startsWith(`${normalizedDesired}+`) ||
    normalizedText.startsWith(`${normalizedDesired} +`);
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
  public readonly questionDescriptor?: ApplicationFieldQuestionDescriptor;

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
    this.sourceSelector = raw.stableSelector
      ? (raw.stableSelectorSource ?? "dom-selector:stable")
      : "dom-selector:unavailable";
    this.questionDescriptor = raw.questionEvidence
      ? questionDescriptorFromEvidence(raw.questionEvidence)
      : undefined;
  }

  private locator(): Locator {
    if (!this.raw.stableSelector) {
      throw new Error(`No stable DOM identity was available for ${this.raw.id}.`);
    }
    // Resolve the selector at action time so React rerenders after an upload
    // cannot retarget a different positional control.
    return this.page.locator(this.raw.stableSelector);
  }

  async fill(value: string): Promise<void> {
    await this.locator().fill(value);
  }

  async select(value: string): Promise<void> {
    if (this.type === "select") {
      const locator = this.locator();
      const tagName = await locator.evaluate((element) => element.tagName.toLowerCase());
      if (tagName === "select") {
        await locator.selectOption(value);
        return;
      }
      // Greenhouse uses a React combobox rather than a native select. Open
      // only the verified field, then choose an exact visible option.
      const toggle = locator
        .locator('xpath=ancestor::div[contains(@class, "select__container")]')
        .getByRole("button", { name: "Toggle flyout" });
      const expanded = await locator.getAttribute("aria-expanded").catch(() => null);
      if (expanded !== "true") {
        // Greenhouse's react-select opens reliably from the combobox keyboard
        // path, including the phone-country control. Some deployments expose
        // a toggle button that changes focus without opening the list.
        await locator.press("ArrowDown").catch(() => undefined);
      }
      if ((await locator.getAttribute("aria-expanded").catch(() => null)) !== "true") {
        if (await toggle.count() > 0 && await visibleFormControl(toggle.first())) {
          await toggle.first().click();
        } else {
          await locator.click();
        }
      }
      // Greenhouse's React select uses the visible option label as a search
      // input. Clicking the rendered option is not sufficient on every
      // Greenhouse deployment: the menu can close without committing the
      // controlled value. Select through the widget's keyboard path, then
      // verify the committed single-value state before returning.
      const matchedOption = this.options?.find((option) =>
        greenhouseOptionMatches(option.label, option.value, value));
      if (this.options && !matchedOption) {
        throw new Error(`The select option ${value} was not found.`);
      }
      await locator.fill(matchedOption?.label ?? value);
      await locator.press("Enter");
      const expectedValue = matchedOption?.value ?? value;
      const isCommitted = async (): Promise<boolean> => {
        const selected = await this.readValue();
        if (typeof selected !== "string") return false;
        if (selected === expectedValue || greenhouseOptionMatches(selected, selected, expectedValue)) return true;
        // The Greenhouse phone-country control displays only the dialing code
        // after commit (for example, "+1") even though the selected option was
        // the uniquely filtered full country label. Accept that representation
        // only when it is the exact suffix of the option we selected.
        const selectedDialingCode = selected.trim().match(/^\+\d+$/)?.[0];
        const expectedDialingCode = expectedValue.trim().match(/\+\d+$/)?.[0];
        return Boolean(selectedDialingCode && expectedDialingCode && selectedDialingCode === expectedDialingCode);
      };
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (await isCommitted()) return;
        if (attempt < 19) await this.page.waitForTimeout(50);
      }
      // A few Greenhouse deployments do not commit a filtered option from
      // Enter alone. Clicking the exact visible option is safe because the
      // option was discovered from this same verified control.
      const visibleOption = this.page.getByRole("option", { name: matchedOption?.label ?? value, exact: true }).first();
      if (await visibleOption.count() > 0 && await visibleFormControl(visibleOption)) {
        await visibleOption.click();
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (await isCommitted()) return;
          if (attempt < 19) await this.page.waitForTimeout(50);
        }
      }
      // If Enter closed the menu before the controlled value was committed,
      // reopen the same combobox and click the exact option text as a second
      // safe interaction. This is needed by some Greenhouse phone-country
      // deployments whose option list is virtualized.
      if ((await locator.getAttribute("aria-expanded").catch(() => null)) !== "true") {
        await locator.press("ArrowDown").catch(() => undefined);
      }
      await locator.fill(matchedOption?.label ?? value);
      const options = this.page.locator('[role="option"], .select__option');
      for (let index = 0; index < await options.count(); index += 1) {
        const option = options.nth(index);
        if (!(await visibleFormControl(option))) continue;
        const label = (await option.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        if (label !== (matchedOption?.label ?? value).trim()) continue;
        await option.click();
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (await isCommitted()) return;
          if (attempt < 19) await this.page.waitForTimeout(50);
        }
        break;
      }
      throw new Error(`The select option ${value} was not committed by the form.`);
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

  private async readCustomSelection(): Promise<string | null> {
    const candidate = await this.locator().evaluate((element) => {
      const root = element.closest(".select__container") ?? element.parentElement;
      const selectedValue = root?.querySelector(".select__single-value")?.textContent;
      const ariaValue = element.getAttribute("aria-valuetext");
      const dataValue = element.parentElement?.getAttribute("data-value");
      return [selectedValue, ariaValue, dataValue]
        .map((value) => value?.replace(/\s+/g, " ").trim() ?? "")
        .find(Boolean) ?? null;
    }).catch(() => null);
    if (!candidate) return null;
    const matchedOption = this.options?.find((option) =>
      greenhouseOptionMatches(option.label, option.value, candidate));
    return matchedOption?.value ?? candidate;
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
    if (this.type === "select") {
      const tagName = await this.locator().evaluate((element) => element.tagName.toLowerCase());
      if (tagName !== "select") return this.readCustomSelection();
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
        message: safeBrowserDiagnosticMessage(error, "The application page could not be opened."),
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
        for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
          const style = window.getComputedStyle(ancestor);
          if (ancestor.getAttribute("aria-hidden") === "true" || style.display === "none" ||
            style.visibility === "hidden" || Number.parseFloat(style.opacity || "1") === 0) return false;
        }
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
        // Invisible reCAPTCHA renders its attribution badge using an anchor
        // iframe too. That iframe is not a checkbox or image challenge.
        try {
          const url = new URL(element.getAttribute("src") ?? "", document.baseURI);
          if (/\/(?:api2|enterprise)\/anchor$/.test(url.pathname) &&
            url.searchParams.get("size") === "invisible" && element.closest(".grecaptcha-badge")) return false;
        } catch { /* Unknown visible frames remain ambiguous. */ }
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
      let passiveVisibleMarkerCount = 0;
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
        if (visible && !challengeIframe && !isChallengeControl(element, visible)) {
          const badge = element.closest(".grecaptcha-badge");
          const passiveText = /protected by\s+recaptcha/i.test(element.textContent ?? "") &&
            !element.querySelector('iframe, input, button, [role="checkbox"], [role="dialog"]');
          // Unknown frames cannot become passive solely through their parent.
          const unexpectedControl = badge && Array.from(badge.querySelectorAll('button, input, select, textarea, [role="button"], [role="checkbox"], [role="dialog"], [tabindex]')).some(isVisible);
          let passiveFrame = element.matches('.grecaptcha-badge, .grecaptcha-logo') && !unexpectedControl;
          if (element.tagName.toLowerCase() === "iframe" && badge && !unexpectedControl) {
            try {
              const url = new URL(element.getAttribute("src") ?? "", document.baseURI);
              passiveFrame = /\/(?:api2|enterprise)\/anchor$/.test(url.pathname) && url.searchParams.get("size") === "invisible";
            } catch { /* Remain uncertain. */ }
          }
          if ((badge && passiveFrame) || passiveText) passiveVisibleMarkerCount += 1;
        }
      }
      return {
        markerCount: elements.length,
        visibleMarkerCount,
        passiveVisibleMarkerCount,
        challengeIframeCount,
        visibleChallengeIframeCount,
        visibleChallengeControlCount,
      };
    }).catch(() => ({
      // Failure to observe is not evidence that no challenge exists.
      markerCount: 1,
      visibleMarkerCount: 1,
      challengeIframeCount: 0,
      visibleChallengeIframeCount: 0,
      visibleChallengeControlCount: 0,
    }));
    const bodyText = await this.page.locator("body").innerText({ timeout: this.timeoutMs }).catch(() => "");
    const lowerBody = bodyText.toLowerCase();
    this.captchaDiagnostics = classifyCaptchaEvidence({
      ...captchaObservation,
      markerCount: /protected by\s+recaptcha/i.test(bodyText) ? Math.max(1, captchaObservation.markerCount) : captchaObservation.markerCount,
      explicitChallengeText: ACTIVE_CAPTCHA_TEXT.test(lowerBody),
    });

    if (this.captchaDiagnostics.state === "active_challenge" || this.captchaDiagnostics.state === "uncertain") {
      return {
        kind: "captcha",
        question: "Complete the CAPTCHA in the browser",
        reason: "The application is protected by a CAPTCHA or human-verification boundary. The executor will not bypass it.",
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
      // Greenhouse uses visually-hidden required inputs as validation mirrors
      // for its custom comboboxes. They are infrastructure, not user fields.
      if (control instanceof HTMLInputElement && (control.classList.contains("requiredInput") || control.className.includes("requiredInput"))) {
        return [];
      }

      const labels = Array.from(document.querySelectorAll("label"));
      const associated = control.id
        ? labels.find((label) => label.htmlFor === control.id)
        : labels.find((label) => label.contains(control));
      const descriptorText = (value: string | null | undefined, maximum = 240): string | undefined => {
        const compact = (value ?? "").replace(/\s+/g, " ").replace(/\s*[✱]\s*$/, "").trim();
        return compact ? compact.slice(0, maximum) : undefined;
      };
      const textFrom = (element: Element | null | undefined, maximum = 240): string | undefined =>
        descriptorText(element?.textContent, maximum);
      const fieldset = control.closest("fieldset");
      const legend = textFrom(fieldset?.querySelector("legend"));
      const labelledByIds = (control.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .map((id) => id.trim())
        .filter(Boolean);
      const ariaLabelledByText = descriptorText(labelledByIds
        .map((id) => document.getElementById(id))
        .map((element) => element?.textContent ?? "")
        .join(" "));
      const ariaLabel = descriptorText(control.getAttribute("aria-label"));
      const questionContainer = control.closest(".application-question");
      const promptElements = questionContainer
        ? Array.from(questionContainer.querySelectorAll(
            '.application-label .text, [data-qa="question"], [data-qa="question-text"], .question-prompt',
          ))
        : [];
      const fallbackPromptElements = questionContainer && promptElements.length === 0
        ? Array.from(questionContainer.querySelectorAll(".application-label"))
        : [];
      const questionContainerPrompts = [...promptElements, ...fallbackPromptElements]
        .map((element) => textFrom(element))
        .filter((value): value is string => Boolean(value))
        .slice(0, 4);
      const sectionContainer = control.closest(".section.application-form, .section");
      const sectionHeading = sectionContainer?.querySelector('h4[data-qa="card-name"]') ?? sectionContainer?.querySelector("h4");
      const sectionTitle = textFrom(sectionHeading, 160);
      const instructionElement = questionContainer?.querySelector('.application-label .description, [data-qa="description"]');
      const nearbyInstructionText = textFrom(instructionElement, 160);
      const adjacentPrompt = control.previousElementSibling;
      const nearbyPromptText = adjacentPrompt &&
        adjacentPrompt.matches('[data-qa="question"], [data-qa="question-text"], .question-prompt')
        ? textFrom(adjacentPrompt)
        : undefined;
      const questionEvidence = {
        ...(legend ? { fieldsetLegend: legend } : {}),
        ...(ariaLabelledByText ? { ariaLabelledByText } : {}),
        ...((ariaLabelledByText || ariaLabel) ? { accessibleName: ariaLabelledByText ?? ariaLabel } : {}),
        ...(questionContainerPrompts.length > 0 ? { questionContainerPrompts } : {}),
        ...(nearbyPromptText ? { nearbyPromptText } : {}),
        ...(sectionTitle ? { sectionTitle } : {}),
        ...(nearbyInstructionText ? { nearbyInstructionText } : {}),
      };
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
          : control.getAttribute("role") === "combobox"
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
      const tagName = control.tagName.toLowerCase();
      const escapeIdentifier = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
      const escapeAttribute = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const uniqueSelector = (selector: string): boolean => document.querySelectorAll(selector).length === 1;
      let stableSelector: string | undefined;
      let stableSelectorSource: string | undefined;
      if (control.id.trim()) {
        const selector = `${tagName}#${escapeIdentifier(control.id.trim())}`;
        if (uniqueSelector(selector)) {
          stableSelector = selector;
          stableSelectorSource = `dom-id:${control.id.trim()}`;
        }
      }
      if (!stableSelector && control.name?.trim()) {
        const nameSelector = `${tagName}[name="${escapeAttribute(control.name.trim())}"]`;
        const selector = control instanceof HTMLInputElement && control.type.toLowerCase() === "radio"
          ? `${nameSelector}[value="${escapeAttribute(control.value)}"]`
          : nameSelector;
        if (uniqueSelector(selector)) {
          stableSelector = selector;
          stableSelectorSource = `dom-name:${control.name.trim()}`;
        }
      }
      if (!stableSelector) {
        const ariaLabelValue = control.getAttribute("aria-label")?.trim();
        if (ariaLabelValue) {
          const selector = `${tagName}[aria-label="${escapeAttribute(ariaLabelValue)}"]`;
          if (uniqueSelector(selector)) {
            stableSelector = selector;
            stableSelectorSource = "dom-aria-label";
          }
        }
      }
      const isFirstRadioInGroup = type !== "radio" || !control.name ||
        Array.from(document.querySelectorAll('input[type="radio"]')).find((candidate) => (candidate as HTMLInputElement).name === control.name) === control;
      return [{
        index,
        id,
        label,
        type,
        required: isFirstRadioInGroup && (control.required || control.getAttribute("aria-required") === "true"),
        ...(stableSelector ? { stableSelector } : {}),
        ...(stableSelectorSource ? { stableSelectorSource } : {}),
        ...(options && options.length > 0 ? { options } : {}),
        ...(legend ? { section: legend } : {}),
        ...(control instanceof HTMLInputElement && control.type.toLowerCase() === "radio" && control.name
          ? { groupName: control.name }
          : {}),
        ...(Object.keys(questionEvidence).length > 0 ? { questionEvidence } : {}),
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
      const enrichedItem = uniqueItem.type === "select" && (!uniqueItem.options || uniqueItem.options.length === 0)
        ? { ...uniqueItem, options: await this.inspectCustomSelectOptions(uniqueItem) }
        : uniqueItem;
      const locator = enrichedItem.stableSelector ? this.page.locator(enrichedItem.stableSelector) : controls.nth(enrichedItem.index);
      if (await visibleFormControl(locator)) {
        fields.push(new PlaywrightLeverBrowserField(this.page, enrichedItem));
      }
    }
    return fields;
  }

  /** Opens a custom combobox only to read its visible options; no option is selected. */
  private async inspectCustomSelectOptions(raw: InspectedRawField): Promise<readonly ApplicationFieldOption[] | undefined> {
    if (!raw.stableSelector) return undefined;
    const field = this.page.locator(raw.stableSelector);
    if (!(await visibleFormControl(field))) return undefined;
    const toggle = field
      .locator('xpath=ancestor::div[contains(@class, "select__container")]')
      .getByRole("button", { name: "Toggle flyout" });
    if (await toggle.count() > 0 && await visibleFormControl(toggle.first())) {
      await toggle.first().click();
    } else {
      await field.click();
    }
    try {
      const options = this.page.locator('[role="option"], .select__option');
      const result: ApplicationFieldOption[] = [];
      const seen = new Set<string>();
      for (let index = 0; index < await options.count(); index += 1) {
        const option = options.nth(index);
        if (!(await visibleFormControl(option))) continue;
        const label = (await option.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        if (!label) continue;
        const value = (await option.getAttribute("data-value").catch(() => null)) ??
          (await option.getAttribute("value").catch(() => null)) ?? label;
        const key = `${value}\u0000${label}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ label, value });
      }
      return result.length > 0 ? result : undefined;
    } finally {
      await this.page.keyboard.press("Escape").catch(() => undefined);
    }
  }

  async hasSubmitControl(): Promise<boolean> {
    return Boolean(await this.submitControl());
  }

  private async submitControl(): Promise<Locator | null> {
    const submitInputs = this.page.locator('input[type="submit"], button[type="submit"]');
    for (let index = 0; index < await submitInputs.count(); index += 1) {
      const candidate = submitInputs.nth(index);
      if (await visibleFormControl(candidate)) return candidate;
    }
    // Text-only buttons are considered only inside the application form. This
    // avoids treating a page-level cookie/help/navigation button as Submit.
    const buttons = this.page.locator("form button");
    for (let index = 0; index < await buttons.count(); index += 1) {
      const button = buttons.nth(index);
      if (!(await visibleFormControl(button))) continue;
      const text = (await button.innerText().catch(() => "")).trim().toLowerCase();
      if (/^(?:submit(?: application)?|apply(?: now)?|send application)$/.test(text)) return button;
    }
    return null;
  }

  async submit(): Promise<BrowserSubmissionResult> {
    const control = await this.submitControl();
    if (!control) return { clicked: false, confirmed: false, evidence: "submit:control-missing" };
    if (await control.isDisabled().catch(() => true) || (await control.getAttribute("aria-disabled").catch(() => null)) === "true") {
      return { clicked: false, confirmed: false, evidence: "submit:control-disabled" };
    }

    const beforeUrl = this.page.url();
    let clicked = false;
    try {
      await control.click();
      clicked = true;
    } catch {
      // A navigation can race the click promise. The post-click inspection
      // below remains conservative and will not claim success without proof.
      clicked = this.page.url() !== beforeUrl;
    }

    await this.page.waitForLoadState("domcontentloaded", { timeout: Math.min(this.timeoutMs, 5_000) }).catch(() => undefined);
    await this.page.waitForTimeout(Math.min(750, this.timeoutMs));
    const afterUrl = this.page.url();
    const bodyText = await this.page.locator("body").innerText({ timeout: this.timeoutMs }).catch(() => "");
    const confirmationText = /\b(?:your application (?:has been )?submitted|application (?:has been )?submitted|thank you for applying|thanks for applying|application received)\b/i.test(bodyText);
    const confirmationUrl = /\/(?:confirmation|success|thank[-_]?you)(?:\/|$)/i.test(new URL(afterUrl).pathname);
    const confirmed = clicked && (confirmationText || confirmationUrl);
    if (!confirmed) {
      return {
        clicked,
        confirmed: false,
        evidence: clicked ? "submit:clicked; confirmation:not-detected" : "submit:not-clicked; confirmation:not-detected",
      };
    }

    const parsed = new URL(afterUrl);
    return {
      clicked: true,
      confirmed: true,
      externalApplicationId: `confirmation:${parsed.hostname}${parsed.pathname}`,
      evidence: confirmationUrl ? "submit:clicked; confirmation:url" : "submit:clicked; confirmation:text",
    };
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
