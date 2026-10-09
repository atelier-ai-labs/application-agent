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
  BrowserUnavailablePage,
  BrowserApplicationRouteDiscovery,
  ApplicationFieldSelectionContext,
  LeverBrowserField,
  LeverBrowserSession,
  LeverBrowserSessionFactory,
} from "../src/domain/executor";
import {
  BrowserExecutionDiagnosticError,
  safeBrowserDiagnosticMessage,
} from "../src/domain/executor";
import { looksLikeInternationalDialingOptions } from "../src/domain/leverBrowserExecutor";
import {
  extractRipplingPromptFromCandidates,
  looksLikeOpaqueToken,
  pickNearestUniqueByDistance,
  SEARCH_NEAR_PHONE_MARGIN_PX,
  SEARCH_NEAR_PHONE_MAX_DISTANCE_PX,
} from "./ripplingDomHelpers";
import type { RipplingPromptCandidate } from "./ripplingDomHelpers";
import {
  isVerifiedMatlenApplicationUrl,
  isVerifiedProtagonaApplicationUrl,
  isVerifiedRipplingApplicationUrl,
  isVerifiedAshbyApplicationUrl,
  isVerifiedAshbyHostedUrl,
  classifyJobUrl,
} from "../src/domain/jobUrlClassifier";

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
  role?: string;
  required: boolean;
  stableSelector?: string;
  stableSelectorSource?: string;
  stableIdentity?: StableControlIdentity;
  stableIdentityUnique?: boolean;
  options?: readonly ApplicationFieldOption[];
  section?: string;
  groupName?: string;
  questionEvidence?: LeverQuestionAssociationEvidence;
  ripplingPromptCandidates?: readonly RipplingPromptCandidate[];
  explicitFileLabel?: boolean;
  providerIdentity?: string;
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
  role?: string;
  fieldPath?: string;
}

export type PostSubmitErrorReason = "validation-error" | "upload-error" | "server-error";

export interface NativeValidityObservation {
  ordinal: number;
  tagName: string;
  type?: string;
  flags: readonly string[];
}

/** Formats native validity using only stable DOM identity and validity flags. */
export function nativeValidityEvidence(observation: NativeValidityObservation): string {
  const safeTag = observation.tagName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase().slice(0, 20) || "control";
  const safeType = (observation.type ?? "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 30);
  const flags = observation.flags.filter((flag) => /^[a-zA-Z]+$/.test(flag)).slice(0, 12).join(",") || "unknown";
  return `invalid-control:ordinal-${Math.max(0, Math.floor(observation.ordinal))};kind:${safeTag}${safeType ? `:${safeType}` : ""};validity:${flags}`;
}

/**
 * Classifies only generic form-error language. The returned value is
 * deliberately a code, never the text itself, so diagnostics cannot leak
 * candidate answers or resume contents.
 */
export function classifyPostSubmitError(text: string): PostSubmitErrorReason | null {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (
    /(?:upload|resume|cv|file|attachment|document)/.test(normalized) &&
    /(?:error|required|invalid|failed|missing|select|format|size|type|attach)/.test(normalized)
  ) {
    return "upload-error";
  }
  if (/(?:required|invalid|please (?:enter|select|complete)|must be|cannot be blank|is missing)/.test(normalized)) {
    return "validation-error";
  }
  if (/(?:error|unable|try again|problem|failed|something went wrong|could not)/.test(normalized)) {
    return "server-error";
  }
  return null;
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
  /** Safe semantic state from a known CAPTCHA checkbox frame; never a token. */
  resolvedChallengeCount?: number;
  explicitChallengeText: boolean;
}

/**
 * Recognizes only strong, page-level unavailable-posting markers. This is a
 * bounded availability check, not a general page crawler or content parser.
 */
export function classifyUnavailablePage(
  bodyText: string,
  pageTitle = "",
): BrowserUnavailablePage | null {
  const firstLines = bodyText
    .split(/\r?\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 8)
    .join(" ");
  const title = pageTitle.replace(/\s+/g, " ").trim();
  if (/\b(?:job|position)\s+not\s+found\b/i.test(firstLines) ||
    /\b(?:job|position)\s+not\s+found\b/i.test(title)) {
    return { reasonCode: "posting_not_found", evidence: ["posting:job-not-found"] };
  }
  if (/(?:\b(?:this\s+)?(?:job|position|posting)\s+(?:is\s+)?no\s+longer\s+available\b|\b(?:job|position)\s+has\s+been\s+filled\b|\bposting\s+closed\b)/i.test(firstLines) ||
    /\b(?:job|position|posting)\s+(?:is\s+)?(?:closed|filled)\b/i.test(title)) {
    return { reasonCode: "posting_closed", evidence: ["posting:closed"] };
  }
  return null;
}

/**
 * Classifies only observable CAPTCHA evidence. Visible but non-specific
 * provider UI remains a human gate through `uncertain`; hidden infrastructure
 * is recorded without requiring interaction.
 */
export function classifyCaptchaEvidence(observation: CaptchaDomObservation): BrowserCaptchaDiagnostics {
  const resolvedChallengeCount = observation.resolvedChallengeCount ?? 0;
  const unresolvedVisibleChallengeIframeCount = Math.max(
    0,
    observation.visibleChallengeIframeCount - resolvedChallengeCount,
  );
  const completedKnownChallenge = resolvedChallengeCount > 0 &&
    unresolvedVisibleChallengeIframeCount === 0 &&
    observation.visibleChallengeControlCount === 0;
  const diagnosticFields = {
    markerCount: observation.markerCount,
    visibleMarkerCount: observation.visibleMarkerCount,
    challengeIframeCount: observation.challengeIframeCount,
    visibleChallengeIframeCount: observation.visibleChallengeIframeCount,
    ...(resolvedChallengeCount > 0 ? { resolvedChallengeCount } : {}),
  };
  if (completedKnownChallenge) {
    return {
      state: "none",
      ...diagnosticFields,
      evidenceCategory: "challenge_completed",
    };
  }
  if (observation.explicitChallengeText) {
    return {
      state: "active_challenge",
      ...diagnosticFields,
      evidenceCategory: "explicit_challenge_text",
    };
  }
  if (unresolvedVisibleChallengeIframeCount > 0) {
    return {
      state: "active_challenge",
      ...diagnosticFields,
      evidenceCategory: "visible_challenge_iframe",
    };
  }
  if (observation.visibleChallengeControlCount > 0) {
    return {
      state: "active_challenge",
      ...diagnosticFields,
      evidenceCategory: "visible_challenge_control",
    };
  }
  if (observation.markerCount === 0) {
    return {
      state: "none",
      ...diagnosticFields,
      evidenceCategory: "no_markers",
    };
  }
  if (observation.visibleMarkerCount > (observation.passiveVisibleMarkerCount ?? 0)) {
    return {
      state: "uncertain",
      ...diagnosticFields,
      evidenceCategory: "visible_marker_ambiguous",
    };
  }
  return {
    state: "infrastructure_present",
    ...diagnosticFields,
    visibleChallengeIframeCount: unresolvedVisibleChallengeIframeCount,
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

export function isSafeHumanVerificationButton(element: Element): boolean {
  // Do not treat arbitrary role="button" elements or links as safe. Their
  // handlers can navigate or submit unrelated page state. Require a native,
  // standalone button with an explicit non-submit type.
  return element instanceof HTMLButtonElement && element.type.toLowerCase() === "button" && !element.form;
}

const HANDOFF_CAPTCHA_HOSTS = new Set(["www.google.com", "www.recaptcha.net", "recaptcha.net", "hcaptcha.com", "newassets.hcaptcha.com", "challenges.cloudflare.com"]);
function isAllowedCaptchaFrameUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return [...HANDOFF_CAPTCHA_HOSTS].some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch { return false; }
}

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

/**
 * Match only short, explicit application actions. Broad substring matching is
 * unsafe here because listing pages also contain controls such as "Apply
 * filters" and "Apply coupon".
 */
export function isApplicationDiscoveryControlLabel(value: string): boolean {
  const normalized = value.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized || normalized.length > 96) return false;
  return /^(?:apply|apply now|apply online|apply today|apply for (?:this )?(?:job|role|position)|apply on (?:the )?(?:company|employer) (?:website|site)|start (?:an )?application|begin (?:an )?application)$/.test(normalized);
}

/** File inputs are frequently visually hidden behind a styled resume dropzone.
 * Keep the input as the upload target, but accept it when its visible wrapper
 * is the user-facing upload control. */
async function visibleUploadContainer(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    if (!(element instanceof HTMLInputElement) || element.type.toLowerCase() !== "file") return false;
    for (let current: HTMLElement | null = element.parentElement; current; current = current.parentElement) {
      const style = window.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const marker = `${current.getAttribute("role") ?? ""} ${current.className?.toString() ?? ""} ${current.id} ${current.textContent ?? ""}`.toLowerCase();
      if (/(?:resume|résumé|cv|dropzone|drop-zone|upload|attach|file)/.test(marker)) return true;
      if (current.tagName.toLowerCase() === "form") break;
    }
    return false;
  }).catch(() => false);
}

/** Rippling's native resume input is labelled only by its accepted extensions. */
function isRipplingResumeUploadLabel(label: string): boolean {
  const normalized = label.replace(/\s+/g, " ").trim().toLowerCase();
  return /(?:resume|résumé|cv)/.test(normalized) ||
    (/drop\s+or\s+select/.test(normalized) && /\.docx?|\.pdf/.test(normalized));
}

function isRipplingCanonicalResumeField(field: InspectedRawField): boolean {
  return field.providerIdentity?.toLowerCase() === "input-resume" ||
    field.id.toLowerCase() === "input-resume";
}

function isGenericSelectPrompt(label: string): boolean {
  return /^(?:select(?:\.\.\.)?|choose|please select)$/i.test(label.replace(/\s+/g, " ").trim());
}

function isOpaqueControlLabel(label: string): boolean {
  // Human labels such as "Attachments" also satisfy the broad token shape;
  // require an identifier-like marker before replacing them with nearby text.
  return looksLikeOpaqueToken(label) && /[0-9_-]/.test(label);
}

/** A provider identity is required when Rippling renders more than one
 * extension-only dropzone (for example resume plus cover letter). */
function hasRipplingResumeIdentity(field: InspectedRawField): boolean {
  const evidence = [
    field.id,
    field.stableIdentity?.id,
    field.stableIdentity?.name,
    field.stableIdentity?.fieldPath,
    field.providerIdentity,
    field.questionEvidence?.accessibleName,
    field.questionEvidence?.nearbyPromptText,
    ...(field.questionEvidence?.questionContainerPrompts ?? []),
  ].filter(Boolean).join(" ");
  return /\b(?:resume|cv|curriculum\s+vitae)\b/i.test(evidence);
}

/** A portal can retain hidden/template option nodes in the active listbox.
 * They must not make an otherwise unique option appear ambiguous. */
async function interactableOption(locator: Locator): Promise<boolean> {
  if (!(await visibleFormControl(locator))) return false;
  if (!(await locator.isEnabled().catch(() => true))) return false;
  return locator.evaluate((element) => {
    for (let current: Element | null = element; current; current = current.parentElement) {
      if (current.getAttribute("aria-hidden") === "true" || current.getAttribute("aria-disabled") === "true") return false;
      if (current instanceof HTMLButtonElement || current instanceof HTMLInputElement || current instanceof HTMLSelectElement) {
        if (current.disabled) return false;
      }
      const style = window.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") return false;
    }
    return true;
  }).catch(() => false);
}

async function exactOptionLabel(locator: Locator): Promise<string> {
  const accessible = (await locator.getAttribute("aria-label").catch(() => null))?.trim();
  return (accessible || (await locator.innerText().catch(() => ""))).replace(/\s+/g, " ").trim();
}

function normalizedOptionLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Returns a bounded, safe description when a typeahead answer has no exact
 * rendered option.  In particular, generic answers such as "internet" must
 * not be silently mapped to an arbitrary source (Indeed, LinkedIn, and the
 * employer site are materially different answers).
 */
export function unmatchedSelectOptionMessage(
  desired: string,
  renderedLabels: readonly string[],
): string {
  const labels = [...new Set(renderedLabels.map((label) => normalizedOptionLabel(label)).filter(Boolean))].slice(0, 8);
  return `The select option ${desired} was not found${labels.length > 0 ? `; verified choices:${labels.join("|")}` : " among the currently rendered options"}.`;
}

/** Stable semantic identity for duplicate option renderings in a portal. */
async function optionSemanticIdentity(locator: Locator): Promise<string | null> {
  return locator.evaluate((element) => {
    const canonical = element.closest('[role="option"]') ?? element.closest(".select__option") ?? element;
    const label = (canonical.getAttribute("aria-label") ?? canonical.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const value = canonical.getAttribute("data-value") ?? canonical.getAttribute("value") ?? canonical.getAttribute("aria-valuetext");
    if (!value?.trim()) return null;
    // A same-label option with a different explicit value is a genuinely
    // different choice; retain both and let exact selection fail closed.
    return `${label}\u0000${(value ?? "").replace(/\s+/g, " ").trim().toLowerCase()}` || null;
  }).catch(() => null);
}

/** Safe, bounded diagnostics for ambiguous option renderings; never includes input values. */
async function optionDiagnostic(locator: Locator): Promise<string> {
  const detail = await locator.evaluate((element) => ({
    text: (element.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 120),
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute("role"),
    hidden: element.getAttribute("aria-hidden") === "true" || getComputedStyle(element).display === "none" || getComputedStyle(element).visibility === "hidden",
    dataValue: element.getAttribute("data-value"),
    value: element.getAttribute("value"),
    ariaValue: element.getAttribute("aria-valuetext"),
  })).catch(() => ({ text: "", tag: "unknown", role: null, hidden: true, dataValue: null, value: null, ariaValue: null }));
  const identity = await logicalOptionIdentity(locator);
  return JSON.stringify({ ...detail, identity });
}

async function optionDiagnostics(locators: readonly Locator[]): Promise<string> {
  const details: string[] = [];
  for (const locator of locators.slice(0, 8)) details.push(await optionDiagnostic(locator));
  return details.join(",");
}

/** Returns the identity of the logical option represented by a matched node.
 * Rippling can expose both a semantic option wrapper and a nested visual
 * `.select__option`; those are one choice, not two. */
async function logicalOptionIdentity(locator: Locator): Promise<string | null> {
  return locator.evaluate((element) => {
    const canonical = element.closest('[role="option"]') ?? element.closest(".select__option") ?? element;
    const parts: string[] = [];
    let current: Element | null = canonical;
    while (current?.parentElement) {
      const siblings = Array.from(current.parentElement.children);
      parts.push(String(siblings.indexOf(current)));
      current = current.parentElement;
      if (current.getAttribute("role") === "listbox") break;
    }
    return parts.reverse().join("/") || null;
  }).catch(() => null);
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

/** Ashby may render the application form on the public posting route without
 * appending `/application`. Keep this bounded to a classifier-verified
 * Ashby posting or application URL before applying provider-specific rules. */
function isVerifiedAshbyFormUrl(value: string): boolean {
  if (isVerifiedAshbyApplicationUrl(value)) return true;
  const classification = classifyJobUrl(value);
  return classification.kind === "ashby" &&
    Boolean(classification.siteIdentifier && classification.postingIdentifier) &&
    isVerifiedAshbyHostedUrl(value, classification.siteIdentifier!, classification.postingIdentifier!);
}

/** Escapes a value for a CSS identifier without relying on a browser global. */
export function escapeCssIdentifier(value: string): string {
  const escaped = value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
  // CSS identifiers cannot begin with a digit. Ashby-generated control IDs
  // commonly do, so use the CSS hexadecimal escape form (`\31 ` for `1`).
  if (/^[0-9]/.test(value)) return `\\3${value[0]} ${escaped.slice(1)}`;
  if (/^-[0-9]/.test(value)) return `-\\3${value[1]} ${escaped.slice(2)}`;
  if (value === "-") return "\\-";
  return escaped;
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
    const id = identity.id.trim();
    const selector = /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(id)
      ? `${tagName}#${escapeCssIdentifier(id)}`
      : `${tagName}[id="${escapeCssAttribute(id)}"]`;
    return {
      selector,
      source: `dom-id:${id}`,
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
  if (identity.fieldPath?.trim()) {
    const fieldPath = identity.fieldPath.trim();
    const roleSelector = identity.role?.trim()
      ? `[role="${escapeCssAttribute(identity.role.trim())}"]`
      : "";
    return {
      selector: `[data-field-path="${escapeCssAttribute(fieldPath)}"] ${tagName}${roleSelector}`,
      source: `dom-field-path:${fieldPath}`,
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
  if (!normalizedDesired) return false;
  return normalizedText === normalizedDesired ||
    (optionValue !== null && normalize(optionValue) === normalizedDesired) ||
    normalizedText.startsWith(`${normalizedDesired}+`) ||
    normalizedText.startsWith(`${normalizedDesired} +`) ||
    // Rippling dialing lists: "+1 US - United States" and committed "+1 US"
    normalizedText.endsWith(` - ${normalizedDesired}`) ||
    normalizedText.endsWith(`-${normalizedDesired}`) ||
    normalizedText.includes(` - ${normalizedDesired}`) ||
    (
      (normalizedDesired === "united states" || normalizedDesired === "us" || normalizedDesired === "usa") &&
      /^\+\d+\s+us\b/.test(normalizedText)
    );
}

export function greenhouseLocationOptionMatches(optionLabel: string, desiredCity: string, groundedLocation?: string): boolean {
  const normalize = (part: string) => part.trim().toLowerCase().replace(/\s+/g, " ");
  const optionParts = optionLabel.split(",").map(normalize).filter(Boolean);
  // The decision layer may pass either a city or the profile's complete
  // location. Ashby renders the city separately from state and country.
  const normalizedCity = normalize(desiredCity.split(",")[0] ?? "");
  if (!normalizedCity || optionParts[0] !== normalizedCity) return false;
  if (!groundedLocation) return true;
  const aliases: Record<string, string[]> = {
    pennsylvania: ["pennsylvania", "pa"], pa: ["pennsylvania", "pa"],
    tennessee: ["tennessee", "tn"], tn: ["tennessee", "tn"],
    "united states": ["united states", "us", "usa"], us: ["united states", "us", "usa"], usa: ["united states", "us", "usa"],
  };
  return groundedLocation.split(",").map(normalize).filter(Boolean).slice(1).every((part) =>
    optionParts.slice(1).some((candidate) => (aliases[part] ?? [part]).includes(candidate)),
  );
}

/** Collapse duplicate static option records without collapsing real choices. */
export function deduplicateStaticOptions(options: readonly ApplicationFieldOption[]): ApplicationFieldOption[] {
  const seen = new Set<string>();
  const result: ApplicationFieldOption[] = [];
  for (const option of options) {
    const identity = `${option.label.trim().toLowerCase().replace(/\s+/g, " ")}\u0000${option.value.trim().toLowerCase().replace(/\s+/g, " ")}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(option);
  }
  return result;
}

/**
 * A location widget can duplicate the same visible location with provider
 * instance-specific opaque values. Collapse only the exact grounded full
 * location label; distinct visible regions remain separate candidates.
 */
export function deduplicateGroundedLocationOptions(
  options: readonly ApplicationFieldOption[],
  groundedLocation: string | undefined,
): ApplicationFieldOption[] {
  const grounded = groundedLocation?.trim().toLowerCase().replace(/\s+/g, " ");
  if (!grounded) return [...options];
  const seenGroundedLabel = new Set<string>();
  return options.filter((option) => {
    const label = option.label.trim().toLowerCase().replace(/\s+/g, " ");
    if (label !== grounded) return true;
    if (seenGroundedLabel.has(label)) return false;
    seenGroundedLabel.add(label);
    return true;
  });
}

/** Select one deterministic representative only for a fully grounded city. */
export function groundedLocationRepresentative(
  options: readonly ApplicationFieldOption[],
  desiredCity: string,
  groundedLocation: string | undefined,
): ApplicationFieldOption | undefined {
  if (!groundedLocation?.trim() || options.length === 0) return undefined;
  const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
  const city = normalize(desiredCity.split(",")[0] ?? "");
  const allMatch = options.every((option) => {
    const visibleCity = normalize(option.label.split(",")[0] ?? option.label);
    return visibleCity === city && greenhouseLocationOptionMatches(option.label, desiredCity, groundedLocation);
  });
  return allMatch ? options[0] : undefined;
}

/** Native ATS selects may expose a non-empty value for their placeholder. */
export function isUnselectedNativeOption(
  value: string,
  options?: readonly ApplicationFieldOption[],
): boolean {
  const normalizedValue = value.replace(/\s+/g, " ").trim().toLowerCase();
  if (normalizedValue === "resumator_no_selection") return true;
  const selected = options?.find((option) => option.value.trim().toLowerCase() === normalizedValue);
  const label = (selected?.label ?? value).replace(/\s+/g, " ").trim().toLowerCase();
  return /^[-–—\s]*(?:no answer|choose(?: one)?|select(?: one)?|please select)[-–—\s]*$/.test(label);
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
    // Keep custom Rippling comboboxes on the option-control path even if a
    // provider remount reports an unusual tag name (for example div).
    this.type = raw.role?.toLowerCase() === "combobox" ? "select" : raw.type;
    this.required = raw.required;
    this.options = raw.options;
    this.section = raw.section;
    this.sourceSelector = raw.stableSelector
      ? (raw.stableSelectorSource === "dom-structure"
        ? raw.stableSelector
        : (raw.stableSelectorSource ?? "dom-selector:stable"))
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

  /** Rippling remounts can invalidate id selectors mid-prep; recover Search comboboxes. */
  private async resolveSelectLocator(): Promise<Locator> {
    const primary = this.locator();
    if (await primary.count() > 0) return primary.first();
    if (!looksLikeInternationalDialingOptions(this.options) && this.label !== "Search") {
      return primary;
    }
    const searches = this.page.locator('input[placeholder="Search"][role="combobox"]');
    const count = await searches.count();
    if (count === 1) return searches.first();
    // Prefer a Search control near the phone field when multiple exist.
    // Fail closed unless the nearest candidate is uniquely best by a clear margin.
    const phone = this.page.locator('input[placeholder="Phone number"], input[id*="phone" i]');
    const phonePoints: { x: number; y: number }[] = [];
    for (let index = 0; index < await phone.count(); index += 1) {
      const box = await phone.nth(index).boundingBox().catch(() => null);
      if (box) phonePoints.push({ x: box.x, y: box.y });
    }
    // Multiple phone anchors are ambiguous: do not assume the first phone
    // field owns the recovered Search control.
    if (phonePoints.length === 1) {
      const candidates: { locator: Locator; point: { x: number; y: number } }[] = [];
      for (let index = 0; index < count; index += 1) {
        const candidate = searches.nth(index);
        const box = await candidate.boundingBox().catch(() => null);
        if (!box) continue;
        candidates.push({ locator: candidate, point: { x: box.x, y: box.y } });
      }
      const picked = pickNearestUniqueByDistance(
        phonePoints[0],
        candidates.map((entry) => entry.point),
        SEARCH_NEAR_PHONE_MARGIN_PX,
        SEARCH_NEAR_PHONE_MAX_DISTANCE_PX,
      );
      if (picked !== null) return candidates[picked]!.locator;
    }
    throw new Error(
      count === 0
        ? `The select control ${this.id} could not be re-identified after a page update.`
        : `The select control ${this.id} could not be uniquely re-identified after a page update.`,
    );
  }

  async fill(value: string): Promise<void> {
    const locator = this.locator();
    const tagName = await locator.evaluate((element) => element.tagName.toLowerCase(), undefined, { timeout: 2_000 });
    const contentEditable = (await locator.getAttribute("contenteditable").catch(() => null)) === "true";
    if (tagName !== "input" && tagName !== "textarea" && !contentEditable) {
      if ((await locator.getAttribute("role").catch(() => null))?.toLowerCase() === "combobox") {
        await this.select(value);
        return;
      }
      throw new Error(`The control ${this.id} is not fillable.`);
    }
    await locator.fill(value);
  }

  /** Resolve options for this combobox, preferring its explicit ARIA-owned
   * listbox so duplicate labels in another open widget cannot be selected. */
  private async visibleOptionsForControl(control: Locator): Promise<Locator[]> {
    const ownership = await control.evaluate((element) =>
      `${element.getAttribute("aria-controls") ?? ""} ${element.getAttribute("aria-owns") ?? ""}`.trim().split(/\s+/).filter(Boolean),
    ).catch(() => [] as string[]);
    if (ownership.length > 1) throw new Error(`The select control ${this.id} owns multiple listboxes.`);
    let listbox: Locator | null = null;
    if (ownership.length === 1) {
      listbox = this.page.locator(`[id="${escapeCssAttribute(ownership[0]!)}"]`);
    } else if (ownership.length === 0) {
      // Rippling's demographic controls render their listbox in a portal and
      // omit aria-controls/aria-owns. Once this verified combobox is open,
      // there should be exactly one visible listbox. Never fall back to every
      // page option: that can select an option from a different widget.
      const openListboxes = this.page.locator('[role="listbox"]');
      const visibleListboxes: Locator[] = [];
      for (let index = 0; index < await openListboxes.count(); index += 1) {
        const candidate = openListboxes.nth(index);
        if (await visibleFormControl(candidate)) visibleListboxes.push(candidate);
      }
      if (visibleListboxes.length > 1) {
        throw new Error(`The select control ${this.id} has multiple visible listboxes.`);
      }
      if (visibleListboxes.length === 1) listbox = visibleListboxes[0]!;
    }
    // Ashby can replace the listbox after a typeahead keystroke while leaving
    // the combobox's aria-controls pointed at the removed node for a short
    // interval. If the owned node disappeared, use a single visible portal
    // listbox only when it is unambiguous; otherwise fail closed.
    if (ownership.length === 1 && (!listbox || await listbox.count() !== 1 || !(await visibleFormControl(listbox)))) {
      const openListboxes = this.page.locator('[role="listbox"]');
      const visibleListboxes: Locator[] = [];
      for (let index = 0; index < await openListboxes.count(); index += 1) {
        const candidate = openListboxes.nth(index);
        if (await visibleFormControl(candidate)) visibleListboxes.push(candidate);
      }
      if (visibleListboxes.length > 1) {
        throw new Error(`The select control ${this.id} has multiple visible listboxes.`);
      }
      if (visibleListboxes.length === 1) listbox = visibleListboxes[0]!;
    }
    // A few Greenhouse deployments render the menu as `.select__option`
    // children of the owning `.select__container` without exposing a
    // listbox role or aria-controls. Keep this fallback inside the verified
    // widget; never broaden it to page-wide option nodes.
    let optionRoot = listbox;
    if (!optionRoot && ownership.length === 0) {
      const selectContainer = control.locator(
        'xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " select__container ")][1]',
      );
      if (await selectContainer.count() === 1 && await visibleFormControl(selectContainer)) {
        const scopedOptions = selectContainer.locator('[role="option"], .select__option');
        for (let index = 0; index < await scopedOptions.count(); index += 1) {
          const option = scopedOptions.nth(index);
          if (await interactableOption(option)) {
            optionRoot = selectContainer;
            break;
          }
        }
      }
    }
    const rendered = optionRoot
      ? optionRoot.locator('[role="option"], .select__option')
      : this.page.locator('[role="option"], .select__option');
    if (ownership.length === 1 && !optionRoot) {
      throw new Error(`The select control ${this.id} has an unavailable owned listbox.`);
    }
    if (ownership.length === 0 && !optionRoot) return [];
    const visible: Locator[] = [];
    const identities = new Set<string>();
    const semanticIdentities = new Set<string>();
    for (let index = 0; index < await rendered.count(); index += 1) {
      const option = rendered.nth(index);
      if (!(await interactableOption(option))) continue;
      const identity = await logicalOptionIdentity(option);
      if (identity && identities.has(identity)) continue;
      if (identity) identities.add(identity);
      const semanticIdentity = await optionSemanticIdentity(option);
      if (semanticIdentity && semanticIdentities.has(semanticIdentity)) continue;
      if (semanticIdentity) semanticIdentities.add(semanticIdentity);
      visible.push(option);
    }
    return visible;
  }

  async select(value: string, context?: ApplicationFieldSelectionContext): Promise<void> {
    if (this.type === "select") {
      const locationSelection = Boolean(context?.groundedLocation);
      const locator = await this.resolveSelectLocator();
      if (await locator.count() === 0) {
        throw new Error(`The select control ${this.id} was not found in the DOM.`);
      }
      const tagName = await locator.evaluate((element) => element.tagName.toLowerCase(), undefined, { timeout: 5_000 });
      if (tagName === "select") {
        await locator.selectOption(value);
        const committed = await locator.inputValue({ timeout: 2_000 }).catch(() => "");
        if (committed !== value) {
          throw new Error(`The select option ${value} was not committed by the native form control.`);
        }
        return;
      }
      const canTypeIntoControl = tagName === "input" || tagName === "textarea" ||
        (await locator.getAttribute("contenteditable").catch(() => null)) === "true";
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
      const staticCandidates = this.options && deduplicateGroundedLocationOptions(
        deduplicateStaticOptions(this.options),
        locationSelection ? context?.groundedLocation : undefined,
      ).filter((option) => locationSelection
        ? greenhouseLocationOptionMatches(option.label, value, context?.groundedLocation)
        : greenhouseOptionMatches(option.label, option.value, value));
      const groundedRepresentative = locationSelection
        ? groundedLocationRepresentative(staticCandidates ?? [], value, context?.groundedLocation)
        : undefined;
      const staticMatches = groundedRepresentative ? [groundedRepresentative] : staticCandidates;
      if (context?.groundedLocation && staticMatches && staticMatches.length > 1) {
        const labels = staticMatches.map((option) => option.label.trim()).filter(Boolean).slice(0, 8).join("|");
        throw new Error(`The select option ${value} was not uniquely verified${labels ? `; candidates:${labels}` : ""}.`);
      }
      let matchedOption = staticMatches?.[0];
      // Ashby can replace its autocomplete options after resume upload. Its
      // static snapshot may say "USA" while the live menu says "United States".
      // For a grounded, typeable location, bind the live option after search.
      if (locationSelection && canTypeIntoControl) matchedOption = undefined;
      const allowTypeahead = Boolean(
        this.options &&
        !matchedOption &&
        (looksLikeInternationalDialingOptions(this.options) ||
          locationSelection),
      );
      if (this.options && !matchedOption && !allowTypeahead) {
        throw new Error(`The select option ${value} was not found.`);
      }
      const typeaheadQuery = matchedOption?.label ?? (
        locationSelection
          ? value.split(",")[0]!.trim()
          : value
      );
      // A Rippling privacy widget can be a div[role=combobox]. It opens by
      // pointer interaction but is not a fillable text control; use its
      // verified rendered options directly in that case.
      if (canTypeIntoControl) await locator.fill(typeaheadQuery);
      const dynamicOptions = !this.options || this.options.length === 0;
      let lastRenderedLabels: string[] = [];
      // For truncated Rippling dialing samples, wait for the filtered list and
      // bind the first exact country match before committing with Enter.
      if (allowTypeahead || !matchedOption || !canTypeIntoControl) {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const candidates: { label: string; value: string }[] = [];
          const filtered = await this.visibleOptionsForControl(locator);
          lastRenderedLabels = [];
          for (const option of filtered) {
            const label = await exactOptionLabel(option);
            if (label) lastRenderedLabels.push(label);
            if (!label || !(locationSelection
              ? greenhouseLocationOptionMatches(label, value, context?.groundedLocation)
              : greenhouseOptionMatches(label, label, value))) continue;
            candidates.push({ label, value: label });
          }
          if (candidates.length === 1) {
            matchedOption = candidates[0];
            break;
          }
          if (candidates.length > 1) throw new Error(`The select option ${value} was not uniquely verified; candidates:${await optionDiagnostics(filtered)}`);
          if (attempt < 19) await this.page.waitForTimeout(50);
        }
      }
      const expectedValue = matchedOption?.value ?? value;
      let exactVisibleOptionVerified = false;
      const isCommitted = async (): Promise<boolean> => {
        const selected = await this.readValue();
        if (typeof selected !== "string") return false;
        if (selected === expectedValue || selected === matchedOption?.label || selected === value) return true;
        // Ashby normalizes the grounded country label during selection (for
        // example, the profile supplies "USA" while the committed control
        // value is "United States"). The option is still safe to accept only
        // when the selected location matches the complete grounded place;
        // this does not accept the city-only typeahead query.
        if (locationSelection && context?.groundedLocation && (
          greenhouseLocationOptionMatches(selected, value, context.groundedLocation) ||
          greenhouseLocationOptionMatches(selected, expectedValue, context.groundedLocation)
        )) return true;
        // Phone-country controls may commit only the exact dialing code.
        const selectedDialingCode = selected.trim().match(/^\+\d+$/)?.[0];
        const expectedDialingCode = expectedValue.trim().match(/^\+\d+$/)?.[0]
          ?? expectedValue.trim().match(/\+\d+$/)?.[0];
        return Boolean(selectedDialingCode && expectedDialingCode && selectedDialingCode === expectedDialingCode);
      };
      // Some Greenhouse application forms render the option list correctly
      // but do not commit a selection from Enter on demographic/privacy
      // controls. Bind and click the one exact visible option discovered for
      // this verified combobox before using the keyboard fallback.
      if (matchedOption) {
        for (let attempt = 0; attempt < 20 && !exactVisibleOptionVerified; attempt += 1) {
          const visibleCandidates: Locator[] = [];
          const rendered = await this.visibleOptionsForControl(locator);
          for (const option of rendered) {
            const label = await exactOptionLabel(option);
            if (normalizedOptionLabel(label) === normalizedOptionLabel(matchedOption.label)) visibleCandidates.push(option);
          }
          if (visibleCandidates.length > 1) throw new Error(`The select option ${value} was not uniquely verified; candidates:${await optionDiagnostics(visibleCandidates)}`);
          if (visibleCandidates.length !== 1) {
            if (attempt < 19) await this.page.waitForTimeout(50);
            continue;
          }
          exactVisibleOptionVerified = true;
          await visibleCandidates[0]!.click();
          for (let attempt = 0; attempt < 20; attempt += 1) {
            if (await isCommitted()) return;
            if (attempt < 19) await this.page.waitForTimeout(50);
          }
        }
      }
      if (matchedOption && (allowTypeahead || dynamicOptions)) {
        if (!exactVisibleOptionVerified) throw new Error(`The select option ${value} was not uniquely verified.`);
        await locator.press("ArrowDown").catch(() => undefined);
        await locator.press("Enter");
      } else {
      if (!exactVisibleOptionVerified) throw new Error(unmatchedSelectOptionMessage(value, lastRenderedLabels));
      await locator.press("ArrowDown").catch(() => undefined);
      await locator.press("Enter");
      }
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
      if (!canTypeIntoControl) {
        throw new Error(`The custom select control ${this.id} did not commit its verified option.`);
      }
      await locator.fill(matchedOption?.label ?? value);
      const options = await this.visibleOptionsForControl(locator);
      for (const option of options) {
        const label = await exactOptionLabel(option);
        if (normalizedOptionLabel(label) !== normalizedOptionLabel(matchedOption?.label ?? value)) continue;
        await option.click();
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (await isCommitted()) return;
          if (attempt < 19) await this.page.waitForTimeout(50);
        }
        break;
      }
      // A small number of React-style ATS widgets swallow an ordinary
      // locator click while the menu is being re-rendered. Use a real pointer
      // gesture only after reopening and re-inspecting the same exact option.
      if ((await locator.getAttribute("aria-expanded").catch(() => null)) !== "true") {
        await locator.press("ArrowDown").catch(() => undefined);
      }
      await locator.fill(matchedOption?.label ?? value);
      const pointerOptions: Locator[] = [];
      const pointerRendered = await this.visibleOptionsForControl(locator);
      for (const option of pointerRendered) {
        const label = await exactOptionLabel(option);
        if (normalizedOptionLabel(label) === normalizedOptionLabel(matchedOption?.label ?? value)) pointerOptions.push(option);
      }
      if (pointerOptions.length !== 1) throw new Error(`The select option ${value} was not uniquely verified for pointer selection; candidates:${await optionDiagnostics(pointerOptions)}`);
      const pointerOption = pointerOptions[0]!;
      const initialBox = await pointerOption.boundingBox().catch(() => null);
      if (!initialBox || initialBox.width <= 0 || initialBox.height <= 0 || initialBox.x < 0 || initialBox.y < 0) {
        throw new Error(`The select option ${value} did not have a stable visible pointer target.`);
      }
      await this.page.waitForTimeout(40);
      const stableBox = await pointerOption.boundingBox().catch(() => null);
      if (!stableBox || Math.abs(stableBox.x - initialBox.x) > 2 || Math.abs(stableBox.y - initialBox.y) > 2 || Math.abs(stableBox.width - initialBox.width) > 2 || Math.abs(stableBox.height - initialBox.height) > 2) {
        throw new Error(`The select option ${value} moved before pointer selection.`);
      }
      const centerX = stableBox.x + stableBox.width / 2;
      const centerY = stableBox.y + stableBox.height / 2;
      await this.page.mouse.move(centerX, centerY);
      await this.page.mouse.down();
      await this.page.waitForTimeout(25);
      await this.page.mouse.up();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (await isCommitted()) return;
        if (attempt < 19) await this.page.waitForTimeout(50);
      }
      throw new Error(`The select option ${value} was not committed by the form.`);
    }

    if (this.type === "radio") {
      const control = this.locator();
      if (this.raw.stableSelectorSource?.startsWith("ashby-yesno-field-path:")) {
        const buttons = control.locator("button[data-option]");
        const matches: Locator[] = [];
        for (let index = 0; index < await buttons.count(); index += 1) {
          const candidate = buttons.nth(index);
          const option = (await candidate.getAttribute("data-option"))?.trim() ?? "";
          const label = (await candidate.innerText().catch(() => "")).trim();
          if (option.toLowerCase() === value.trim().toLowerCase() || label.toLowerCase() === value.trim().toLowerCase()) matches.push(candidate);
        }
        if (matches.length !== 1) throw new Error(`The Ashby yes/no option ${value} was not uniquely identified.`);
        await matches[0]!.click();
        const committed = await matches[0]!.getAttribute("aria-pressed").catch(() => null);
        if (committed !== "true") throw new Error(`The Ashby yes/no option ${value} was not committed.`);
        return;
      }
      if ((await control.getAttribute("role").catch(() => null))?.toLowerCase() === "radio") {
        const group = control.locator('xpath=ancestor-or-self::*[@role="radiogroup"][1]');
        const candidates = group.locator('[role="radio"]');
        const matches: Locator[] = [];
        for (let index = 0; index < await candidates.count(); index += 1) {
          const candidate = candidates.nth(index);
          const text = await candidate.getAttribute("aria-label") ?? await candidate.textContent() ?? "";
          const candidateValue = await candidate.getAttribute("data-value") ?? await candidate.getAttribute("value") ?? text;
          if (text.trim().toLowerCase() === value.trim().toLowerCase() || candidateValue.trim().toLowerCase() === value.trim().toLowerCase()) matches.push(candidate);
        }
        if (matches.length !== 1) throw new Error(`The radio option ${value} was not uniquely identified.`);
        await matches[0]!.click();
        const checked = await matches[0]!.getAttribute("aria-checked").catch(() => null);
        if (checked !== "true") throw new Error(`The radio option ${value} was not committed.`);
        return;
      }
      // Scope Ashby custom radio choices to their owning field entry before
      // falling back to the native name. Separate questions can reuse a
      // generic name, which would otherwise select the wrong group.
      const owner = control.locator('xpath=ancestor::*[@data-field-path or contains(@class, "ashby-application-form-field-entry")][1]');
      const ownerRadios = owner.locator('input[type="radio"]');
      if (await ownerRadios.count() > 0) {
        for (let index = 0; index < await ownerRadios.count(); index += 1) {
          const candidate = ownerRadios.nth(index);
          const matches = await candidate.evaluate((element, wanted) => {
            const input = element as HTMLInputElement;
            const labels = input.id
              ? Array.from(document.querySelectorAll("label")).filter((label) => label.htmlFor === input.id)
              : [];
            const labelText = labels.map((label) => label.textContent ?? "").join(" ");
            return input.value === wanted || labelText.trim().toLowerCase() === wanted.trim().toLowerCase();
          }, value);
          if (matches) {
            await candidate.click();
            const committed = await candidate.evaluate((element) => (element as HTMLInputElement).checked).catch(() => false);
            if (!committed) throw new Error(`The radio option ${value} was not committed.`);
            return;
          }
        }
      }
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
          await candidate.click();
          const committed = await candidate.evaluate((element) => (element as HTMLInputElement).checked).catch(() => false);
          if (!committed) throw new Error(`The radio option ${value} was not committed.`);
          return;
        }
      }
    }

    throw new Error(`The radio option ${value} was not found.`);
  }

  async setChecked(value: boolean): Promise<void> {
    const locator = this.locator();
    const role = (await locator.getAttribute("role").catch(() => null))?.toLowerCase();
    if (role === "checkbox" || role === "switch") {
      const checked = await locator.getAttribute("aria-checked").catch(() => null);
      if ((checked === "true") !== value) await locator.click();
      const committed = await locator.getAttribute("aria-checked").catch(() => null);
      if ((committed === "true") !== value) throw new Error(`The checkbox value for ${this.id} was not committed.`);
      return;
    }
    if (value) await locator.check();
    else await locator.uncheck();
    const committed = await locator.evaluate((element) =>
      element instanceof HTMLInputElement ? element.checked : false,
    ).catch(() => false);
    if (committed !== value) throw new Error(`The checkbox value for ${this.id} was not committed.`);
  }

  async uploadFile(path: string): Promise<void> {
    const locator = this.locator();
    const isRipplingResume = isVerifiedRipplingApplicationUrl(this.page.url()) && (
      isRipplingResumeUploadLabel(this.label) ||
      await locator.evaluate((element) => {
        const identity = `${element.getAttribute("id") ?? ""} ${element.getAttribute("data-testid") ?? ""} ${element.closest("[data-testid]")?.getAttribute("data-testid") ?? ""}`;
        return /(?:^|\s)(?:input-)?resume(?:\s|$)/i.test(identity) || /(?:^|\s)résumé(?:\s|$)/i.test(identity);
      }).catch(() => false)
    );
    const ripplingReceiptBefore = isRipplingResume
      ? await locator.evaluate((element) => {
          const owner = element.parentElement?.closest("[data-testid='resume'], [data-field-path], [role='button'], label, div") ?? element.parentElement;
          return (owner?.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
        }).catch(() => "")
      : "";
    await locator.setInputFiles(path);
    const committed = await locator.evaluate((element, expectedPath) => ({
      fileCount: element instanceof HTMLInputElement && element.type.toLowerCase() === "file"
        ? (element.files?.length ?? 0)
        : 0,
      // The deterministic DOM harness and a few provider wrappers expose a
      // bounded upload marker instead of a FileList.
      uploadMarker: element.getAttribute("data-uploaded-path") === expectedPath,
    }), path).catch(() => ({ fileCount: 0, uploadMarker: false }));
    // Rippling replaces its hidden input after accepting a file. In that
    // window Playwright can observe an empty FileList even though the
    // provider has committed the upload and rendered its receipt. Treat that
    // provider-owned receipt as the source of truth, but only for the
    // canonical Rippling resume control (never for arbitrary file fields).
    if (committed.fileCount !== 1 && !committed.uploadMarker && !isRipplingResume) {
      throw new Error(`The uploaded resume was not committed by the form.`);
    }
    if (isRipplingResume && committed.fileCount !== 1 && !committed.uploadMarker) {
      const filename = path.split(/[\\/]/).pop() ?? path;
      let visibleAcknowledgement = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        visibleAcknowledgement = await locator.evaluate((element, args) => {
          const { expectedFilename, beforeText } = args as { expectedFilename: string; beforeText: string };
          const normalize = (value: string | null | undefined) =>
            (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
          const expected = normalize(expectedFilename);
          const isVisible = (candidate: Element): boolean => {
            for (let current: Element | null = candidate; current; current = current.parentElement) {
              const style = window.getComputedStyle(current);
              if (style.display === "none" || style.visibility === "hidden") return false;
            }
            return true;
          };
          const textOf = (candidate: Element): string => {
            const walker = document.createTreeWalker(candidate, NodeFilter.SHOW_TEXT);
            let text = "";
            let node: Node | null;
            while ((node = walker.nextNode())) {
              if (node.parentElement && isVisible(node.parentElement)) text += ` ${node.textContent ?? ""}`;
            }
            return normalize(text);
          };
          const owner = element.parentElement?.closest("[data-testid='resume'], [data-field-path], [role='button'], label, div") ?? element.parentElement;
          if (!owner) return false;
          const candidates = [owner, ...Array.from(owner.querySelectorAll("*"))].filter(isVisible);
          return candidates.some((candidate) => {
            const text = textOf(candidate);
            const metadata = normalize([
              candidate.getAttribute("aria-label"),
              candidate.getAttribute("title"),
              candidate.getAttribute("data-testid"),
              candidate.getAttribute("class"),
              text,
            ].filter(Boolean).join(" "));
            const hasExpectedFilename = expected.length > 0 && metadata.includes(expected) &&
              !beforeText.includes(expected);
            // Static helper copy such as "file name" can exist before the
            // upload. Bind acceptance to a changed provider-owned receipt
            // state, rather than rejecting every status when helper copy is
            // present in the initial owner text.
            const hasCountReceiptTransition = /total\s+1\s+file\s+selected/.test(text) &&
              !/total\s+1\s+file\s+selected/.test(beforeText);
            const hasStatusReceiptTransition =
              /(?:uploaded|attached|remove|replace|success)/.test(text) &&
              !/(?:uploaded|attached|remove|replace|success)/.test(beforeText);
            const hasCommittedReceipt = hasCountReceiptTransition || hasStatusReceiptTransition;
            return (hasExpectedFilename || hasCommittedReceipt) && text !== beforeText;
          });
        }, { expectedFilename: filename, beforeText: ripplingReceiptBefore }).catch(() => false);
        if (visibleAcknowledgement) break;
        if (attempt < 29) await this.page.waitForTimeout(100);
      }
      if (!visibleAcknowledgement) {
        const diagnostic = await locator.evaluate((element, args) => {
          const input = element as HTMLInputElement;
          const { expectedPath, beforeText } = args as { expectedPath: string; beforeText: string };
          const expectedName = expectedPath.split(/[\\/]/).pop()?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
          const owner = element.parentElement?.closest("[data-testid='resume'], [data-field-path], [role='button'], label, div") ?? element.parentElement;
          const text = (owner?.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
          const ownerMarker = owner ? `${owner.getAttribute("data-testid") ?? ""} ${owner.getAttribute("data-field-path") ?? ""} ${owner.getAttribute("role") ?? ""} ${owner.className ?? ""}`.toLowerCase() : "";
          const visible = (candidate: Element): boolean => {
            for (let current: Element | null = candidate; current; current = current.parentElement) {
              const style = window.getComputedStyle(current);
              const className = typeof current.className === "string" ? current.className : "";
              if (current.getAttribute("aria-hidden") === "true" || /(?:screen-reader-only|sr-only|visually-hidden|visuallyHidden)/i.test(className)) return false;
              if (style.display === "none" || style.visibility === "hidden") return false;
            }
            return true;
          };
          const visibleReceipt = Boolean(owner && Array.from(owner.querySelectorAll("*")).some((candidate) =>
            visible(candidate) && /(?:total\s+1\s+file\s+selected|uploaded|attached|remove|replace|success|file[-_ ]?name)/i.test(candidate.textContent ?? ""),
          ));
          const textOf = (candidate: Element): string => {
            const walker = document.createTreeWalker(candidate, NodeFilter.SHOW_TEXT);
            let value = "";
            let node: Node | null;
            while ((node = walker.nextNode())) {
              if (node.parentElement && visible(node.parentElement)) value += ` ${node.textContent ?? ""}`;
            }
            return value.replace(/\s+/g, " ").trim().toLowerCase();
          };
          const ownerVisibleText = owner ? textOf(owner) : "";
          const visibleExactFilename = Boolean(expectedName && ownerVisibleText.includes(expectedName));
          const visibleStatus = /(?:total\s+1\s+file\s+selected|uploaded|attached|remove|replace|success)/i.test(ownerVisibleText);
          const initialStatus = /(?:total\s+1\s+file\s+selected|uploaded|attached|remove|replace|success)/i.test(beforeText);
          return {
            inputPresent: element instanceof HTMLInputElement,
            fileCount: input.files?.length ?? 0,
            canonicalIdentity: /(?:input-resume|resume|résumé)/i.test(`${element.id} ${element.getAttribute("data-testid") ?? ""} ${ownerMarker}`),
            ownerPresent: Boolean(owner),
            ownerMarker: /(?:resume|résumé|dropzone|upload|file)/i.test(ownerMarker),
            receiptKind: /total\s+1\s+file\s+selected/i.test(text) ? "count" : /(?:uploaded|attached|remove|replace|success|file[-_ ]?name)/i.test(text) ? "status" : "none",
            visibleReceipt,
            exactFilenameVisible: Boolean(expectedName && text.includes(expectedName)),
            visibleExactFilename,
            visibleStatus,
            initialStatus,
            priorExactFilenameVisible: Boolean(expectedName && beforeText.includes(expectedName)),
            receiptChanged: text !== beforeText,
          };
        }, { expectedPath: path, beforeText: ripplingReceiptBefore }).catch(() => ({ inputPresent: false, fileCount: 0, canonicalIdentity: false, ownerPresent: false, ownerMarker: false, receiptKind: "unavailable", visibleReceipt: false, exactFilenameVisible: false, visibleExactFilename: false, visibleStatus: false, initialStatus: false, priorExactFilenameVisible: false, receiptChanged: false }));
        throw new Error(`The uploaded resume was not committed by the form; upload-diagnostic:i=${diagnostic.inputPresent ? 1 : 0},f=${Math.min(9, diagnostic.fileCount)},c=${diagnostic.canonicalIdentity ? 1 : 0},o=${diagnostic.ownerPresent ? 1 : 0},m=${diagnostic.ownerMarker ? 1 : 0},r=${diagnostic.receiptKind.slice(0, 1)},v=${diagnostic.visibleReceipt ? 1 : 0},x=${diagnostic.exactFilenameVisible ? 1 : 0},X=${diagnostic.visibleExactFilename ? 1 : 0},S=${diagnostic.visibleStatus ? 1 : 0},I=${diagnostic.initialStatus ? 1 : 0},p=${diagnostic.priorExactFilenameVisible ? 1 : 0},d=${diagnostic.receiptChanged ? 1 : 0}`);
      }
    }
    // A FileList only proves that the browser input accepted bytes. Ashby's
    // React form can still reject or remount that input without showing the
    // attachment to the applicant. Require the provider-owned visible
    // filename/status before treating the resume as uploaded.
    const isAshbyCanonicalResume = await locator.evaluate((element) =>
      element instanceof HTMLInputElement && element.id === "_systemfield_resume",
    ).catch(() => false);
    if (isVerifiedAshbyFormUrl(this.page.url()) && isAshbyCanonicalResume) {
      const filename = path.split(/[\\/]/).pop() ?? path;
      let visibleAcknowledgement = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        visibleAcknowledgement = await locator.evaluate((element, expectedFilename) => {
          const normalize = (value: string | null | undefined) =>
            (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
          const expected = normalize(expectedFilename);
          const owner = element.closest("[data-field-path], .ashby-application-form-field-entry") ?? element.parentElement;
          if (!owner) return false;
          const visible = (candidate: Element): boolean => {
            for (let current: Element | null = candidate; current; current = current.parentElement) {
              const style = window.getComputedStyle(current);
              if (style.display === "none" || style.visibility === "hidden") return false;
            }
            return true;
          };
          const visibleText = (candidate: Element): string => {
            const walker = document.createTreeWalker(candidate, NodeFilter.SHOW_TEXT);
            let text = "";
            let node: Node | null;
            while ((node = walker.nextNode())) {
              const parent = node.parentElement;
              if (parent && visible(parent)) text += ` ${node.textContent ?? ""}`;
            }
            return text;
          };
          // Do not inspect the field container itself: its textContent can
          // include a hidden/template receipt from another React branch.
          const candidates = Array.from(owner.querySelectorAll("*"))
            .filter(visible);
          return candidates.some((candidate) => {
            const text = normalize(visibleText(candidate));
            const accessible = normalize(candidate.getAttribute("aria-label"));
            const title = normalize(candidate.getAttribute("title"));
            const className = normalize(candidate.getAttribute("class"));
            const metadata = `${accessible} ${title} ${text}`;
            if (expected && metadata.includes(expected)) return true;
            // Some Ashby revisions render a shortened filename but expose a
            // stable upload/remove status in the provider-owned file element.
            return !(candidate instanceof HTMLInputElement) &&
              /(?:file[-_ ]?name|uploaded|attached|remove|replace|success)/.test(className) &&
              /(?:uploaded|attached|remove|replace|success)/.test(metadata) &&
              text.length > 0;
          });
        }, filename).catch(() => false);
        if (visibleAcknowledgement) break;
        if (attempt < 19) await this.page.waitForTimeout(50);
      }
      if (!visibleAcknowledgement) {
        throw new Error(`Ashby accepted the resume input but did not show a provider-confirmed uploaded filename or status.`);
      }
    }
  }

  private async readCustomSelection(locator?: Locator): Promise<string | null> {
    const target = locator ?? await this.resolveSelectLocator();
    if (await target.count() === 0) return null;
    const inputValue = await target.inputValue({ timeout: 2_000 }).catch(() => "");
    if (inputValue.trim()) {
      const matchedFromInput = this.options?.find((option) =>
        greenhouseOptionMatches(option.label, option.value, inputValue));
      return matchedFromInput?.value ?? inputValue.trim();
    }
    const candidate = await target.evaluate((element) => {
      // Greenhouse deployments place the input, value renderer, and hidden
      // selected option at slightly different depths. Walk a bounded set of
      // ancestors and accept only the widget's explicit committed markers.
      const roots: Element[] = [];
      let currentRoot: Element | null = element;
      for (let depth = 0; currentRoot && depth < 8; depth += 1, currentRoot = currentRoot.parentElement) roots.push(currentRoot);
      const selectedValue = roots.map((root) => root.querySelector(".select__single-value")?.textContent).find(Boolean);
      const selectedOption = roots.map((root) => root.querySelector('[role="option"][aria-selected="true"]')?.textContent).find(Boolean);
      const selectedDataValue = roots.map((root) => root.querySelector('[aria-selected="true"][data-value], [aria-selected="true"][value]')?.getAttribute("data-value") ?? root.querySelector('[aria-selected="true"][value]')?.getAttribute("value")).find(Boolean);
      const hiddenValue = roots.map((root) => root.querySelector('input[type="hidden"][value]')?.getAttribute("value")).find(Boolean);
      const ariaValue = element.getAttribute("aria-valuetext");
      const activeDescendant = element.getAttribute("aria-activedescendant")
        ? document.getElementById(element.getAttribute("aria-activedescendant")!)?.textContent
        : null;
      // Rippling's portal combobox is a div and reflects the committed label
      // as its own text rather than in a descendant of the control's parent.
      // Include it only as a candidate; the caller still exact-matches it to
      // the verified option list before accepting it.
      const controlText = element.textContent;
      const dataValues: (string | null)[] = [];
      let current: Element | null = element;
      for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
        dataValues.push(current.getAttribute("data-value"));
      }
      // Greenhouse deployments vary where the controlled value is reflected.
      // The caller accepts these only after exact option matching.
      return [selectedValue, selectedOption, selectedDataValue, hiddenValue, ariaValue, activeDescendant, controlText, ...dataValues]
        .map((value) => value?.replace(/\s+/g, " ").trim() ?? "")
        .find(Boolean) ?? null;
    }, undefined, { timeout: 2_000 }).catch(() => null);
    if (!candidate) return null;
    const matchedOption = this.options?.find((option) =>
      greenhouseOptionMatches(option.label, option.value, candidate));
    return matchedOption?.value ?? candidate;
  }

  async readValue(): Promise<string | boolean | null> {
    if (this.type === "checkbox") {
      const locator = this.locator();
      const role = (await locator.getAttribute("role").catch(() => null))?.toLowerCase();
      if (role === "checkbox" || role === "switch") return (await locator.getAttribute("aria-checked").catch(() => null)) === "true";
      return locator.isChecked();
    }
    if (this.type === "radio") {
      const control = this.locator();
      if (this.raw.stableSelectorSource?.startsWith("ashby-yesno-field-path:")) {
        const selected = control.locator('button[data-option][aria-pressed="true"]');
        if (await selected.count() !== 1) return null;
        return (await selected.getAttribute("data-option")) ?? ((await selected.innerText().catch(() => "")).trim() || null);
      }
      if ((await control.getAttribute("role").catch(() => null))?.toLowerCase() === "radio") {
        const group = control.locator('xpath=ancestor-or-self::*[@role="radiogroup"][1]');
        const checked = group.locator('[role="radio"][aria-checked="true"]');
        if (await checked.count() !== 1) return null;
        return (await checked.getAttribute("data-value")) ?? (await checked.getAttribute("value")) ?? (await checked.getAttribute("aria-label")) ?? (await checked.textContent())?.trim() ?? null;
      }
      const owner = control.locator('xpath=ancestor::*[@data-field-path or contains(@class, "ashby-application-form-field-entry")][1]');
      const ownerRadios = owner.locator('input[type="radio"]');
      if (await ownerRadios.count() > 0) {
        for (let index = 0; index < await ownerRadios.count(); index += 1) {
          const candidate = ownerRadios.nth(index);
          const selected = await candidate.evaluate((element) => {
            const input = element as HTMLInputElement;
            if (!input.checked) return null;
            const labels = input.id
              ? Array.from(document.querySelectorAll("label")).filter((label) => label.htmlFor === input.id)
              : [];
            return labels.map((label) => label.textContent ?? "").join(" ").replace(/\s+/g, " ").trim() || input.value || null;
          });
          if (selected) return selected;
        }
      }
      const radios = this.page.locator('input[type="radio"]');
      const count = await radios.count();
      for (let index = 0; index < count; index += 1) {
        const radio = radios.nth(index);
        const state = await radio.evaluate((element, wanted) => {
          const input = element as HTMLInputElement;
          if (input.name !== wanted || !input.checked) return null;
          // Some ATSs (including Ashby forms rendered from boolean choices)
          // give every native radio the generic value `on`.  The associated
          // label is the only stable semantic value in that case. Prefer it
          // whenever present so reinspection can match the inspected option
          // label instead of treating several checked `on` values as
          // ambiguous. For ordinary radios this is equivalent to input.value
          // because the label and value are normally identical.
          const labels = input.id
            ? Array.from(document.querySelectorAll("label")).filter((label) => label.htmlFor === input.id)
            : [];
          const associatedLabel = labels[0] ?? input.closest("label");
          const labelText = associatedLabel?.textContent?.replace(/\s+/g, " ").trim();
          return labelText || input.value || null;
        }, this.raw.groupName ?? "");
        if (state) return state;
      }
      return null;
    }
    if (this.type === "select") {
      const locator = await this.resolveSelectLocator();
      if (await locator.count() === 0) return null;
      const tagName = await locator.evaluate((element) => element.tagName.toLowerCase(), undefined, { timeout: 2_000 }).catch(() => "input");
      if (tagName !== "select") return this.readCustomSelection(locator);
      const nativeValue = await locator.inputValue({ timeout: 2_000 }).catch(() => "");
      return nativeValue.trim() && !isUnselectedNativeOption(nativeValue, this.options) ? nativeValue : null;
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
  private uploadVerificationDiagnostic?: string;
  private uploadVerificationScreenshotPath?: string;

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

  async handoffScreenshot(): Promise<Buffer> {
    if (this.closed) throw new Error("The browser session is closed.");
    return this.page.screenshot({ type: "png", fullPage: false, scale: "css" });
  }

  async handoffControls(): Promise<readonly import("../src/domain/executor").BrowserHandoffControl[]> {
    const humanButtons = this.page.locator('button, [role="button"]');
    const verificationControls: import("../src/domain/executor").BrowserHandoffControl[] = [];
    for (let index = 0; index < await humanButtons.count(); index += 1) {
      const candidate = humanButtons.nth(index);
      if (!(await visibleFormControl(candidate)) || !(await candidate.isEnabled().catch(() => true))) continue;
      const safe = await candidate.evaluate((element) => isSafeHumanVerificationButton(element)).catch(() => false);
      const label = (await candidate.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      if (!safe || !/^\s*(?:verify|click to (?:verify|confirm))\s+(?:that\s+)?you are human[.!]?\s*$/i.test(label)) continue;
      const bounds = await candidate.boundingBox().catch(() => null);
      if (bounds && bounds.width > 0 && bounds.height > 0) verificationControls.push({ id: "verify-human", label: "Verify you are human", bounds });
    }
    if (verificationControls.length === 1) return verificationControls;
    const boundary = await this.detectHumanBoundary();
    if (!boundary || boundary.kind !== "captcha") return [];
    const frames = this.page.locator("iframe");
    const controls: import("../src/domain/executor").BrowserHandoffControl[] = [];
    for (let index = 0; index < await frames.count(); index += 1) {
      const frame = frames.nth(index);
      const src = await frame.getAttribute("src").catch(() => null);
      if (!src || !isAllowedCaptchaFrameUrl(src)) continue;
      const bounds = await frame.boundingBox().catch(() => null);
      if (bounds && bounds.width > 0 && bounds.height > 0) controls.push({ id: "captcha-frame", label: "CAPTCHA verification", bounds });
    }
    return controls.length === 1 ? controls : [];
  }

  async activateHandoffControl(controlId: string, point?: { x: number; y: number }): Promise<void> {
    if (controlId === "verify-human") {
      const controls = await this.handoffControls();
      if (controls.length !== 1 || controls[0]?.id !== "verify-human") throw new Error("The human-verification control is no longer available.");
      const buttons = this.page.locator('button, [role="button"]');
      for (let index = 0; index < await buttons.count(); index += 1) {
        const button = buttons.nth(index);
        if (!(await visibleFormControl(button)) || !(await button.isEnabled().catch(() => true))) continue;
        const safe = await button.evaluate((element) => isSafeHumanVerificationButton(element)).catch(() => false);
        const label = (await button.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        if (safe && /^\s*(?:verify|click to (?:verify|confirm))\s+(?:that\s+)?you are human[.!]?\s*$/i.test(label)) {
          await button.click();
          return;
        }
      }
      throw new Error("The human-verification control is no longer available.");
    }
    if (controlId !== "captcha-frame" || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("Only a verified CAPTCHA frame tap is permitted.");
    const controls = await this.handoffControls();
    const bounds = controls.length === 1 ? controls[0]?.bounds : undefined;
    if (!bounds || point.x < bounds.x || point.y < bounds.y || point.x > bounds.x + bounds.width || point.y > bounds.y + bounds.height) throw new Error("The tap is outside the verified CAPTCHA frame.");
    const submitControls = this.page.locator('button[type="submit"], input[type="submit"]');
    for (let index = 0; index < await submitControls.count(); index += 1) {
      const submitBounds = await submitControls.nth(index).boundingBox().catch(() => null);
      if (submitBounds && point.x >= submitBounds.x && point.x <= submitBounds.x + submitBounds.width && point.y >= submitBounds.y && point.y <= submitBounds.y + submitBounds.height) throw new Error("The CAPTCHA tap overlaps a Submit control.");
    }
    const target = await this.page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName.toLowerCase(), point).catch(() => undefined);
    if (target !== "iframe") throw new Error("The verified tap target is no longer the CAPTCHA iframe.");
    await this.page.mouse.click(point.x, point.y);
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

  /**
   * Re-check the live provider DOM after all other fields have been filled.
   * Ashby can remount its React form (including the file input) during later
   * controlled-field updates, so the FileList observed immediately after
   * setInputFiles is not durable evidence that the applicant can see an
   * attachment. Require the current canonical input and a provider-owned,
   * visible exact filename acknowledgement.
   */
  async verifyUploadedFile(path: string): Promise<boolean> {
    const rippling = isVerifiedRipplingApplicationUrl(this.page.url());
    if (!isVerifiedAshbyApplicationUrl(this.page.url()) && !rippling) return true;
    const expectedFilename = path.split(/[\\/]/).pop() ?? path;
    const expected = expectedFilename.replace(/\s+/g, " ").trim().toLowerCase();
    if (rippling) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const verified = await this.page.evaluate((wanted) => {
          const normalize = (value: string | null | undefined) =>
            (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
          const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
          const described = inputs.map((input) => {
            const nearestOwner = input.parentElement?.closest("[data-testid='resume'], [data-field-path], [role='button'], label, div") ?? input.parentElement;
            const ancestors: Element[] = [];
            for (let current = input.parentElement; current && ancestors.length < 8; current = current.parentElement) ancestors.push(current);
            // Rippling may place the visible filename chip beside the narrow
            // label wrapper. For the canonical input only, widen to the
            // nearest bounded resume section that owns exactly one file input
            // and contains the expected filename; visible-text filtering below
            // still decides whether it is valid evidence.
            const canonicalInput = /(?:^|\s)input-resume(?:\s|$)/i.test(`${input.id} ${input.getAttribute("data-testid") ?? ""}`);
            const owner = ancestors.find((candidate) => {
              const marker = `${candidate.getAttribute("data-testid") ?? ""} ${candidate.getAttribute("data-field-path") ?? ""} ${candidate.className ?? ""} ${candidate.textContent ?? ""}`;
              return candidate.querySelectorAll('input[type="file"]').length === 1 &&
                /(?:resume|résumé|cv)/i.test(marker) &&
                ((canonicalInput && (candidate.getAttribute("data-testid") ?? "").toLowerCase() === "resume") || normalize(candidate.textContent).includes(wanted));
            }) ?? nearestOwner;
            if (!owner) return { input, owner: null, resumeLike: false };
            const identity = `${input.id} ${input.getAttribute("name") ?? ""} ${input.getAttribute("data-testid") ?? ""} ${owner.getAttribute("data-testid") ?? ""} ${owner.getAttribute("data-field-path") ?? ""} ${owner.className ?? ""}`;
            const ownerText = (owner.textContent ?? "").replace(/\s+/g, " ").trim();
            const resumeLike = /(?:resume|résumé|cv|curriculum\s+vitae)/i.test(identity) ||
              /(?:resume|résumé|cv|curriculum\s+vitae)/i.test(ownerText) ||
              (/(?:drop\s+or\s+select)/i.test(ownerText) && /\.docx?|\.pdf/i.test(ownerText) &&
                (owner.getAttribute("data-testid") ?? "").toLowerCase() === "resume");
            return { input, owner, resumeLike };
          });
          const resumeInputs = described.filter((candidate) => candidate.resumeLike);
          if (resumeInputs.length !== 1) return false;
          return resumeInputs.some(({ input, owner }) => {
            if (!owner) return false;
            const visible = (candidate: Element): boolean => {
              for (let current: Element | null = candidate; current; current = current.parentElement) {
                const style = window.getComputedStyle(current);
                const className = typeof current.className === "string" ? current.className : "";
                if (current.getAttribute("aria-hidden") === "true" ||
                  /(?:screen-reader-only|sr-only|visually-hidden|visuallyHidden)/i.test(className) ||
                  style.clip === "rect(0px, 0px, 0px, 0px)" ||
                  style.clipPath === "inset(100%)") return false;
                if (style.display === "none" || style.visibility === "hidden") return false;
              }
              return true;
            };
            if (!visible(owner)) return false;
            const textOf = (candidate: Element): string => {
              const candidateWalker = document.createTreeWalker(candidate, NodeFilter.SHOW_TEXT);
              let candidateText = "";
              let candidateNode: Node | null;
              while ((candidateNode = candidateWalker.nextNode())) {
                if (candidateNode.parentElement && visible(candidateNode.parentElement)) candidateText += ` ${candidateNode.textContent ?? ""}`;
              }
              return normalize(candidateText);
            };
            const walker = document.createTreeWalker(owner, NodeFilter.SHOW_TEXT);
            let text = "";
            let node: Node | null;
            while ((node = walker.nextNode())) {
              if (node.parentElement && visible(node.parentElement)) text += ` ${node.textContent ?? ""}`;
            }
            const receipt = normalize(text);
            const visibleMetadata = Array.from(owner.querySelectorAll("*"))
              .filter((candidate) => visible(candidate) && !(candidate instanceof HTMLInputElement))
              .map((candidate) => `${textOf(candidate)} ${candidate.getAttribute("aria-label") ?? ""} ${candidate.getAttribute("title") ?? ""} ${candidate.getAttribute("data-file-name") ?? ""} ${candidate.getAttribute("data-filename") ?? ""}`)
              .join(" ")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
            // A FileList alone is browser plumbing, not provider-owned UI.
            // Require the current visible receipt/filename rendered by the
            // form so a remounted or screen-reader-only marker cannot pass.
            return receipt.includes(wanted) || visibleMetadata.includes(wanted) ||
              /total\s+1\s+file\s+selected/.test(receipt) &&
              /(?:resume|cv|drop|upload|attach|file)/i.test(`${owner.getAttribute("data-testid") ?? ""} ${owner.className ?? ""} ${receipt}`);
          });
        }, expected).catch(() => false);
        if (verified) return true;
        if (attempt < 19) await this.page.waitForTimeout(50).catch(() => undefined);
      }
      this.uploadVerificationDiagnostic = await this.page.evaluate((wanted) => {
        const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
        const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
        const candidates = inputs.map((input) => {
          const owner = input.parentElement?.closest("[data-testid='resume'], [data-field-path], [role='button'], label, div") ?? input.parentElement;
          const identity = `${input.id} ${input.getAttribute("data-testid") ?? ""} ${owner?.getAttribute("data-testid") ?? ""} ${owner?.className ?? ""}`;
          const ownerText = normalize(owner?.textContent);
          return { input, owner, resumeLike: /(?:resume|résumé|cv|curriculum\s+vitae)/i.test(`${identity} ${ownerText}`) };
        }).filter((candidate) => candidate.resumeLike);
        const visible = (element: Element): boolean => {
          for (let current: Element | null = element; current; current = current.parentElement) {
            const style = window.getComputedStyle(current);
            const className = typeof current.className === "string" ? current.className : "";
            if (current.getAttribute("aria-hidden") === "true" || /(?:screen-reader-only|sr-only|visually-hidden|visuallyHidden)/i.test(className) || style.clip === "rect(0px, 0px, 0px, 0px)" || style.clipPath === "inset(100%)" || style.display === "none" || style.visibility === "hidden") return false;
          }
          return true;
        };
        const textOf = (owner: Element | null): string => {
          if (!owner) return "";
          const walker = document.createTreeWalker(owner, NodeFilter.SHOW_TEXT);
          let text = "";
          let node: Node | null;
          while ((node = walker.nextNode())) if (node.parentElement && visible(node.parentElement)) text += ` ${node.textContent ?? ""}`;
          return normalize(text);
        };
        const candidate = candidates.length === 1 ? candidates[0] : undefined;
        const strictOwnerVisible = Boolean(candidate?.owner && visible(candidate.owner));
        const text = strictOwnerVisible ? textOf(candidate?.owner ?? null) : "";
        let depth = 0;
        for (let current = candidate?.input.parentElement; current && current !== candidate?.owner && depth < 9; current = current.parentElement) depth += 1;
        const marker = candidate?.owner ? /(?:resume|résumé|cv)/i.test(`${candidate.owner.getAttribute("data-testid") ?? ""} ${candidate.owner.className ?? ""}`) : false;
        const sameForm = Boolean(candidate?.input.closest("form") && candidate.owner?.closest("form") === candidate.input.closest("form"));
        return `inputs=${Math.min(9, inputs.length)};resume=${Math.min(9, candidates.length)};files=${candidate?.input instanceof HTMLInputElement ? candidate.input.files?.length ?? 0 : 0};owner=${candidate?.owner ? 1 : 0};strict-owner=${strictOwnerVisible ? 1 : 0};depth=${Math.min(9, depth)};marker=${marker ? 1 : 0};form=${sameForm ? 1 : 0};filename=${text.includes(normalize(wanted)) ? 1 : 0};count=${/total\s+1\s+file\s+selected/.test(text) ? 1 : 0}`;
      }, expected).catch(() => "unavailable");
      const screenshotPath = "/tmp/atelier-rippling-upload-verification.png";
      await this.page.screenshot?.({ path: screenshotPath, fullPage: true })?.then(() => {
        this.uploadVerificationScreenshotPath = screenshotPath;
      }).catch(() => undefined);
      return false;
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const verified = await this.page.evaluate((wanted) => {
        const input = document.querySelector("#_systemfield_resume");
        if (!(input instanceof HTMLInputElement) || input.type.toLowerCase() !== "file") return false;
        const currentFile = input.files?.length === 1 ? input.files[0]?.name ?? "" : "";
        if (currentFile.replace(/\s+/g, " ").trim().toLowerCase() !== wanted) return false;
        const owner = input.closest("[data-field-path], .ashby-application-form-field-entry") ?? input.parentElement;
        if (!owner) return false;
        const visible = (element: Element): boolean => {
          for (let current: Element | null = element; current; current = current.parentElement) {
            const style = window.getComputedStyle(current);
            if (style.display === "none" || style.visibility === "hidden") return false;
          }
          return true;
        };
        const visibleText = (candidate: Element): string => {
          const walker = document.createTreeWalker(candidate, NodeFilter.SHOW_TEXT);
          let text = "";
          let node: Node | null;
          while ((node = walker.nextNode())) {
            const parent = node.parentElement;
            if (parent && visible(parent)) text += ` ${node.textContent ?? ""}`;
          }
          return text;
        };
        if (!visible(owner)) return false;
        const candidates = Array.from(owner.querySelectorAll("*"))
          .filter((candidate) => !(candidate instanceof HTMLInputElement) && visible(candidate));
        return candidates.some((candidate) => {
          const values = [visibleText(candidate), candidate.getAttribute("aria-label"), candidate.getAttribute("title")]
            .map((value) => (value ?? "").replace(/\s+/g, " ").trim().toLowerCase());
          return values.some((value) => value.includes(wanted));
        });
      }, expected).catch(() => false);
      if (verified) return true;
      if (attempt < 19) await this.page.waitForTimeout(50).catch(() => undefined);
    }
    return false;
  }

  currentUrl(): string {
    return this.page.url();
  }

  uploadVerificationDiagnostics(): string | undefined {
    if (!this.uploadVerificationDiagnostic) return undefined;
    return `${this.uploadVerificationDiagnostic}${this.uploadVerificationScreenshotPath ? `;screenshot=${this.uploadVerificationScreenshotPath}` : ""}`;
  }

  async detectUnavailablePage(): Promise<BrowserUnavailablePage | null> {
    const bodyText = await this.page.locator("body").innerText({ timeout: this.timeoutMs }).catch(() => "");
    const title = await this.page.title().catch(() => "");
    return classifyUnavailablePage(bodyText, title);
  }

  async discoverApplicationRoute(company: string, role: string): Promise<BrowserApplicationRouteDiscovery> {
    const boundary = await this.detectHumanBoundary();
    // Public job boards commonly include a harmless "Log in" navigation link.
    // Treat the login boundary as decisive here only when the listing exposes
    // an actual password field; CAPTCHA and other explicit boundaries remain
    // blocking before the Apply click.
    const actualLoginForm = boundary?.kind === "external_login" &&
      boundary.evidence.some((item) => /^password-fields:[1-9]/.test(item));
    if (boundary && (boundary.kind !== "external_login" || actualLoginForm)) {
      return {
        status: "blocked",
        reason: boundary.reason,
        evidence: [`listing-boundary:${boundary.kind}`, "apply:not-clicked"],
      };
    }

    if (!(await this.verifyPageIdentity(company, role))) {
      return {
        status: "blocked",
        reason: "The public listing did not visibly match the expected company and role.",
        evidence: ["listing-identity:unverified", "apply:not-clicked"],
      };
    }

    const controls = this.page.locator('a, button, input[type="button"], input[type="submit"], [role="button"]');
    const candidates: { locator: Locator; key: string }[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < await controls.count(); index += 1) {
      const candidate = controls.nth(index);
      if (!(await visibleFormControl(candidate)) || !(await candidate.isEnabled().catch(() => true))) continue;
      const details = await candidate.evaluate((element) => {
        const labels = [
          element.getAttribute("aria-label"),
          element instanceof HTMLInputElement ? element.value : undefined,
          element instanceof HTMLElement ? element.innerText : undefined,
          element.getAttribute("title"),
        ].map((value) => (value ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
        return {
          labels,
          href: element instanceof HTMLAnchorElement ? element.href : undefined,
          target: element.getAttribute("target") ?? undefined,
          type: element instanceof HTMLButtonElement || element instanceof HTMLInputElement ? element.type.toLowerCase() : undefined,
          insideForm: Boolean(element.closest("form")),
          tagName: element.tagName.toLowerCase(),
        };
      }).catch(() => undefined);
      if (!details || details.insideForm || details.type === "submit" || details.href?.toLowerCase().startsWith("javascript:")) continue;
      const label = details.labels.find((value) => isApplicationDiscoveryControlLabel(value));
      if (!label) continue;
      const key = `${label.toLowerCase()}\u0000${details.href ?? ""}\u0000${details.target ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ locator: candidate, key });
    }

    if (candidates.length === 0) {
      return {
        status: "not_found",
        reason: "No uniquely labelled Apply control was found on the verified listing page.",
        evidence: ["listing-identity:verified", "apply-control:not-found", "apply:not-clicked"],
      };
    }
    if (candidates.length > 1) {
      return {
        status: "ambiguous",
        reason: "More than one distinct Apply control was visible on the listing page.",
        evidence: ["listing-identity:verified", `apply-controls:${Math.min(candidates.length, 9)}`, "apply:not-clicked"],
      };
    }

    const beforeUrl = this.page.url();
    const popupPromise = this.page.waitForEvent("popup", { timeout: Math.min(this.timeoutMs, 1_500) }).catch(() => undefined);
    try {
      await candidates[0]!.locator.click({ noWaitAfter: true });
    } catch {
      return {
        status: "failed",
        reason: "The uniquely identified Apply control could not be activated.",
        evidence: ["listing-identity:verified", "apply-control:unique", "apply:click-failed"],
      };
    }

    const popup = await popupPromise;
    const targetPage = popup ?? this.page;
    await targetPage.waitForLoadState("domcontentloaded", { timeout: Math.min(this.timeoutMs, 3_000) }).catch(() => undefined);
    await targetPage.waitForTimeout(250).catch(() => undefined);
    const afterUrl = targetPage.url();
    if (popup) await popup.close().catch(() => undefined);

    let before: URL;
    let after: URL;
    try {
      before = new URL(beforeUrl);
      after = new URL(afterUrl);
    } catch {
      return {
        status: "failed",
        reason: "The Apply control did not produce a valid HTTPS destination.",
        evidence: ["listing-identity:verified", "apply:clicked", "destination:invalid"],
      };
    }
    if (after.protocol !== "https:") {
      return {
        status: "blocked",
        reason: "The Apply control led to a non-HTTPS destination.",
        evidence: ["listing-identity:verified", "apply:clicked", "destination:non-https"],
      };
    }
    before.hash = "";
    after.hash = "";
    if (before.toString() === after.toString()) {
      return {
        status: "not_found",
        reason: "The Apply control did not navigate to a distinct application destination.",
        evidence: ["listing-identity:verified", "apply:clicked", "destination:unchanged"],
      };
    }
    return {
      status: "resolved",
      applicationUrl: after.toString(),
      evidence: [
        "listing-identity:verified",
        "apply-control:unique",
        "apply:clicked",
        "destination:navigated",
        `destination-host:${after.hostname}`,
      ],
    };
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
      passiveVisibleMarkerCount: 0,
      challengeIframeCount: 0,
      visibleChallengeIframeCount: 0,
      visibleChallengeControlCount: 0,
    }));
    // A completed checkbox can remain inside a cross-origin CAPTCHA iframe.
    // Read only its exposed semantic checked state; never inspect or retain a
    // response token or challenge contents.
    const resolvedChallengeCount = (await Promise.all(this.page.frames().map(async (frame) => {
      if (!/(?:recaptcha|hcaptcha|turnstile|challenges\.cloudflare\.com)/i.test(frame.url())) return 0;
      return frame.locator(
        '[role="checkbox"][aria-checked="true"], .recaptcha-checkbox[aria-checked="true"], input[type="checkbox"]:checked',
      ).count().then((count) => count > 0 ? 1 : 0).catch(() => 0);
    }))).reduce((total, count) => total + count, 0);
    const bodyText = await this.page.locator("body").innerText({ timeout: this.timeoutMs }).catch(() => "");
    const lowerBody = bodyText.toLowerCase();
    this.captchaDiagnostics = classifyCaptchaEvidence({
      ...captchaObservation,
      ...(resolvedChallengeCount > 0 ? { resolvedChallengeCount } : {}),
      markerCount: /protected by\s+recaptcha/i.test(bodyText) ? Math.max(1, captchaObservation.markerCount) : captchaObservation.markerCount,
      // Page-wide text can mention CAPTCHA in hidden guidance or provider
      // infrastructure even when no challenge is shown. Only treat it as
      // decisive when the page also exposes a visible non-passive marker.
      explicitChallengeText: captchaObservation.visibleMarkerCount > (captchaObservation.passiveVisibleMarkerCount ?? 0) &&
        ACTIVE_CAPTCHA_TEXT.test(lowerBody),
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
    await this.revealMatlenApplicationForm();
    await this.revealProtagonaResumeUpload();
    // Rippling (and similar Next.js ATS hosts) hydrate the form client-side; the
    // static document often has zero inputs until React mounts.
    const controlSelector = "input:not([type=\"hidden\"]):not([type=\"submit\"]):not([type=\"button\"]):not([type=\"reset\"]), textarea, select";
    try {
      await this.page.waitForSelector(controlSelector, {
        state: "attached",
        timeout: Math.min(this.timeoutMs, 12_000),
      });
    } catch {
      // Fall through; the empty-field path already becomes an unsupported/human gate.
    }
    // Rippling's privacy questions are often rendered as custom buttons (or
    // divs) with role=combobox. Keep the inspection and action locators on the
    // same control set so repeated generic "Select..." widgets cannot be
    // silently omitted or assigned a positional index from a different set.
    // Rippling's final consent widgets can be semantic ARIA radios/checkboxes
    // without a backing input. Include those controls so the question is not
    // silently omitted from inspection.
    const controls = this.page.locator("input, textarea, select, [role=\"combobox\"], [role=\"radio\"], [role=\"checkbox\"], [role=\"switch\"], .ashby-application-form-input-yesno button[data-option]");
    const raw = await controls.evaluateAll((elements) => elements.flatMap((element, index): InspectedRawField[] => {
      const control = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const ashbyYesNoButton = element.matches(".ashby-application-form-input-yesno button[data-option]")
        ? element as HTMLButtonElement
        : null;
      // Ashby renders some required yes/no questions as two buttons backed by
      // a hidden checkbox. Inspect the visible button pair as one logical
      // radio field; the hidden checkbox is not an actionable form control.
      if (ashbyYesNoButton && ashbyYesNoButton.getAttribute("data-option") !== "yes") return [];
      if (control instanceof HTMLInputElement && ["hidden", "submit", "button", "reset"].includes(control.type.toLowerCase())) {
        return [];
      }
      // Do not discard hidden file inputs: Rippling commonly places the real
      // input behind a visible Resume/CV dropzone and routes setInputFiles()
      // through that input.
      if (control instanceof HTMLInputElement && control.type.toLowerCase() === "file") {
        // retained below; this branch documents the intentional exception
      }
      // Greenhouse uses visually-hidden required inputs as validation mirrors
      // for its custom comboboxes. They are infrastructure, not user fields.
      if (control instanceof HTMLInputElement && (control.classList.contains("requiredInput") || control.className.includes("requiredInput"))) {
        return [];
      }

      const labels = Array.from(document.querySelectorAll("label"));
      // Some Breezy renderers wrap a radio in its label but omit `for`, even
      // when the control has an id. Preserve the option label in that case;
      // the question prompt is carried separately in questionEvidence.
      const associated = control.id
        ? labels.find((label) => label.htmlFor === control.id) ??
          (/^section_[^_]+_question_|^(?:race|gender|vet)_/i.test(control.id) ? labels.find((label) => label.contains(control)) : undefined)
        : labels.find((label) => label.contains(control));
      const descriptorText = (value: string | null | undefined, maximum = 240): string | undefined => {
        const compact = (value ?? "").replace(/\s+/g, " ").replace(/\s*[✱]\s*$/, "").trim();
        return compact ? compact.slice(0, maximum) : undefined;
      };
      const textFrom = (element: Element | null | undefined, maximum = 240): string | undefined =>
        descriptorText(element?.textContent, maximum);
      const fieldset = control.closest("fieldset");
      const legend = textFrom(fieldset?.querySelector("legend"));
      const fieldEntry = element.closest("[data-field-path]");
      const fieldEntryTitle = fieldEntry?.querySelector(".ashby-application-form-question-title");
      const uploadEntry = control instanceof HTMLInputElement && control.type.toLowerCase() === "file"
        ? control.closest(".wpjb-element-input-file")
        : null;
      const uploadEntryLabel = textFrom(uploadEntry?.querySelector("label"));
      const uploadContainer = control instanceof HTMLInputElement && control.type.toLowerCase() === "file"
        ? control.closest('label, [role="button"], [class*="drop" i], [class*="upload" i], [class*="resume" i]')
        : null;
      const uploadContainerLabel = textFrom(uploadContainer);
      const fieldPath = fieldEntry?.getAttribute("data-field-path")?.trim();
      const fieldEntryRequired = Boolean(fieldEntry && Array.from(fieldEntry.querySelectorAll("label")).some((label) =>
        label.className.toString().toLowerCase().includes("required") || label.getAttribute("aria-required") === "true"));
      const labelledByIds = (control.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .map((id) => id.trim())
        .filter(Boolean);
      const ariaLabelledByText = descriptorText(labelledByIds
        .map((id) => document.getElementById(id))
        .map((element) => element?.textContent ?? "")
        .join(" "));
      const ariaLabel = descriptorText(control.getAttribute("aria-label"));
      // Avoid using a whole form section as a question container: sections can
      // contain several unrelated controls. Prefer explicit question/group
      // boundaries and only use generic text as a last-resort fallback.
      // Breezy's generated questions use a plain `.form-group` wrapper (and
      // ids such as `section_<id>_question_<n>` on the controls), rather than
      // an accessible fieldset.  Include those semantic wrappers here so the
      // visible prompt can be associated with the radio group.  Never use the
      // control itself as a question container: its id may contain
      // `_question_`, but it has no prompt text of its own.
      const questionContainerCandidate = control.closest(
        ".application-question, .ashby-application-form-field-entry, .breezy-question, .breezy-question-container, .form-group, [data-question], [data-question-id], [data-testid*=\"question\" i], [class*=\"Question\" i], .question, .field, form [role=\"group\"]",
      );
      const questionContainer = questionContainerCandidate === control
        ? control.parentElement?.closest(
            ".application-question, .ashby-application-form-field-entry, .breezy-question, .breezy-question-container, .form-group, [data-question], [data-question-id], [data-testid*=\"question\" i], [class*=\"Question\" i], .question, .field, form [role=\"group\"]",
          ) ?? null
        : questionContainerCandidate;
      const promptElements = questionContainer
        ? Array.from(questionContainer.querySelectorAll(
            '.application-label .text, [data-qa="question"], [data-qa="question-text"], .question-prompt, .question-label, .field-label, .breezy-question-label, [class*=\"prompt\" i], .ashby-application-form-question-title, label, legend, [data-testid*=\"label\" i]',
          ))
        : [];
      const fallbackPromptElements = questionContainer && promptElements.length === 0
        ? Array.from(questionContainer.querySelectorAll(".application-label, p, span")).filter((element) => {
            const text = textFrom(element);
            if (!text) return false;
            // Prefer the outer text node when a nested span merely repeats it;
            // this keeps a single actual prompt from becoming ambiguous.
            return !Array.from(element.children).some((child) => textFrom(child) === text);
          })
        : [];
      // Ashby radio labels are the answer options themselves. Prefer its
      // explicit question title over the surrounding labels, otherwise the
      // first option (for example "Hispanic or Latino") is mistaken for the
      // question and demographic routing receives the wrong answer.
      const ashbyQuestionTitle = textFrom(fieldEntryTitle);
      const binaryOptionText = new Set(["yes", "no"]);
      const radioGroupName = control instanceof HTMLInputElement && control.type.toLowerCase() === "radio"
        ? control.name
        : undefined;
      const groupControls = radioGroupName
        ? Array.from(document.querySelectorAll(`input[type="radio"][name="${radioGroupName.replace(/"/g, "\\\"")}"]`))
        : control.getAttribute("role") === "radio"
          ? Array.from(control.closest('[role="radiogroup"]')?.querySelectorAll('[role="radio"]') ?? [])
          : [];
      // Breezy can place several questions in one section-level wrapper. Use
      // the highest nearby ancestor containing exactly this logical radio
      // group, so preceding prompt text from the next/previous question is
      // never mixed into this group's descriptor.
      let radioGroupContainer: Element | null = null;
      if (groupControls.length > 1) {
        let cursor: Element | null = control.parentElement;
        for (let depth = 0; cursor && depth < 10; depth += 1, cursor = cursor.parentElement) {
          const matchingControls = radioGroupName
            ? Array.from(cursor.querySelectorAll('input[type="radio"]')).filter((candidate) => (candidate as HTMLInputElement).name === radioGroupName)
            : Array.from(cursor.querySelectorAll('[role="radio"]'));
          if (matchingControls.length > groupControls.length) break;
          if (matchingControls.length === groupControls.length) {
            const allRadioControls = cursor.querySelectorAll('input[type="radio"], [role="radio"]');
            if (allRadioControls.length === groupControls.length) {
              radioGroupContainer = cursor;
              break;
            }
          }
        }
      }
      const promptContainer = radioGroupContainer ?? questionContainer;
      let groupPrecedingPrompt: string | undefined;
      let groupPromptContainer: Element | null = null;
      if (questionContainer) {
        const children = Array.from(questionContainer.children) as Element[];
        const firstGroupControl = groupControls[0];
        const owningChild = firstGroupControl ? children.findIndex((child) => child.contains(firstGroupControl)) : -1;
        for (let index = owningChild - 1; index >= 0 && !groupPrecedingPrompt; index -= 1) {
          const candidate = children[index]!;
          const text = textFrom(candidate);
          if (!text || candidate.querySelector('input, textarea, select, [role="radio"], [role="combobox"]')) continue;
          groupPrecedingPrompt = text;
          groupPromptContainer = questionContainer;
        }
      }
      if (!groupPrecedingPrompt && groupControls[0]) {
        const directPrevious = groupControls[0]!.parentElement?.previousElementSibling;
        const text = textFrom(directPrevious);
        if (text && !directPrevious?.querySelector('input, textarea, select, [role="radio"], [role="combobox"]')) {
          groupPrecedingPrompt = text;
          groupPromptContainer = questionContainer;
        }
      }
      if (groupControls.length > 1) {
        const firstGroupControl = groupControls[0]!;
        // Skip the immediate option wrapper; its preceding sibling may be the
        // rendered answer text ("Yes"/"No"), not the group prompt.
        let groupCursor: Element | null = firstGroupControl.parentElement?.parentElement ?? firstGroupControl.parentElement;
        for (let depth = 0; groupCursor && depth < 10 && !groupPrecedingPrompt; depth += 1, groupCursor = groupCursor.parentElement) {
          const children = Array.from(groupCursor.children) as Element[];
          const owningChild = children.findIndex((child) => child.contains(firstGroupControl));
          if (owningChild < 1) continue;
          for (let index = owningChild - 1; index >= 0; index -= 1) {
            const candidate = children[index]!;
            const text = textFrom(candidate);
            if (!text || candidate.querySelector('input, textarea, select, [role="radio"], [role="combobox"]')) continue;
            groupPrecedingPrompt = text;
            groupPromptContainer = groupCursor;
            break;
          }
        }
      }
      const scopedPromptElements = promptContainer
        ? Array.from(promptContainer.querySelectorAll(
            '.application-label .text, [data-qa="question"], [data-qa="question-text"], .question-prompt, .question-label, .field-label, .breezy-question-label, [class*=\"prompt\" i], .ashby-application-form-question-title, label, legend, [data-testid*=\"label\" i]',
          ))
        : [];
      const scopedFallbackPromptElements = promptContainer && scopedPromptElements.length === 0
        ? Array.from(promptContainer.querySelectorAll(".application-label, p, span, h3, h4")).filter((element) => {
            const text = textFrom(element);
            return Boolean(text) && !element.querySelector('input, textarea, select, [role="radio"], [role="combobox"]') &&
              !Array.from(element.children).some((child) => textFrom(child) === text);
          })
        : [];
      const radioOptionText = new Set(
        groupControls
          .map((candidate) => {
            const linkedInput = candidate as HTMLInputElement;
            const associatedLabel = linkedInput.id
              ? labels.find((label) => label.htmlFor === linkedInput.id)
              : labels.find((label) => label.contains(candidate));
            const optionWrapper = candidate.closest('label, [role="radio"], [data-option], [class*="option" i]');
            const text = textFrom(associatedLabel ?? optionWrapper);
            if (!text || /\?/.test(text)) return undefined;
            const values = [candidate.getAttribute("value"), candidate.getAttribute("data-value"), candidate.getAttribute("aria-label")]
              .filter((value): value is string => Boolean(value))
              .map((value) => value.trim().toLowerCase());
            return values.some((value) => text.toLowerCase() === value || text.toLowerCase().startsWith(`${value} `) || text.toLowerCase().includes(`(${value}`)) ||
              /i\s+don'?t\s+wish|prefer\s+not|decline|no\s+answer/.test(text.toLowerCase())
              ? text.toLowerCase()
              : undefined;
          })
          .filter((value): value is string => Boolean(value)),
      );
      // Breezy sometimes renders the group prompt as an unclassed sibling
      // immediately before the radio-option wrapper. The option labels make
      // the normal label query ambiguous, so collect only nearby text nodes
      // that do not contain a control and remove exact option-label matches.
      const promptSearchContainer = promptContainer ?? groupPromptContainer;
      const breezyPromptCandidates = promptSearchContainer && !ashbyQuestionTitle
        ? Array.from(promptSearchContainer.querySelectorAll("div, p, span, h3, h4")).filter((element) => {
          const text = textFrom(element);
            if (!text || element.matches('input, textarea, select, [role="radio"], [role="combobox"]') || /^(?:search|select(?:\.\.\.)?|choose)$/i.test(text) || element.querySelector('input, textarea, select, [role="radio"], [role="combobox"]')) return false;
            if (radioOptionText.has(text.toLowerCase())) return false;
            return !Array.from(element.children).some((child) => textFrom(child) === text);
          })
            .map((element) => textFrom(element))
            .filter((value): value is string => Boolean(value))
            .slice(0, 4)
        : [];
      const hasOtherRadioGroupsInPromptContainer = Boolean(
        promptContainer &&
        promptContainer.querySelectorAll('input[type="radio"], [role="radio"]').length > groupControls.length,
      );
      const useGroupScopedPrecedingPrompt = Boolean(groupPrecedingPrompt && hasOtherRadioGroupsInPromptContainer);
      const questionContainerPromptCandidates = ashbyQuestionTitle
        ? [ashbyQuestionTitle]
        : [
            ...(useGroupScopedPrecedingPrompt
              ? [groupPrecedingPrompt]
              : [groupPrecedingPrompt, ...scopedPromptElements, ...scopedFallbackPromptElements]),
          ]
            .map((value) => typeof value === "string" ? value : textFrom(value))
            .filter((value): value is string => Boolean(value))
            .concat(promptContainer && !useGroupScopedPrecedingPrompt ? breezyPromptCandidates : [])
            .filter((value, index, values) => values.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) === index)
            .slice(0, 8);
      // Radio labels are often the only labels in a Breezy question wrapper.
      // Do not mistake the first answer option for the question.  Keep this
      // filtering limited to binary controls; other controls may legitimately
      // have a prompt named "Yes" or "No".
      const questionContainerPrompts = (control instanceof HTMLInputElement && control.type.toLowerCase() === "radio") ||
        control.getAttribute("role") === "radio"
        ? questionContainerPromptCandidates.filter((value) => !binaryOptionText.has(value.toLowerCase()) && !radioOptionText.has(value.toLowerCase()))
        : questionContainerPromptCandidates;
      const sectionContainer = control.closest(".section.application-form, .section, .ashby-application-form-section-container");
      const sectionHeading = sectionContainer?.querySelector('h4[data-qa="card-name"]') ?? sectionContainer?.querySelector("h4") ?? sectionContainer?.querySelector("h2");
      const sectionTitle = textFrom(sectionHeading, 160);
      const instructionElement = promptContainer?.querySelector('.application-label .description, [data-qa="description"], .ashby-application-form-question-description');
      const nearbyInstructionText = textFrom(instructionElement, 160);
      const adjacentPrompt = control.previousElementSibling;
      const adjacentPromptText = adjacentPrompt &&
        adjacentPrompt.matches('[data-qa="question"], [data-qa="question-text"], .question-prompt')
        ? textFrom(adjacentPrompt)
        : undefined;
      // Rippling custom questions often expose opaque name/id labels while the
      // real prompt sits on a preceding sibling of an ancestor (for example
      // div.paddingX--16 / div.css-1w8xq0). Walk up a few levels and accept the
      // first preceding node that looks like a prompt and does not contain
      // another form control (so we do not steal the previous question).
      // Keep in sync with extractRipplingAncestorPrompt / looksLike* in
      // ripplingDomHelpers.ts (evaluateAll cannot import modules).
      const controlSelector = "input, textarea, select, [role='combobox'], [role='radio']";
      const ancestorPromptCandidates: RipplingPromptCandidate[] = [];
      let cursor: Element | null = control;
      for (let depth = 0; depth < 10 && cursor; depth += 1) {
        const previous = cursor.previousElementSibling;
        if (previous) {
          ancestorPromptCandidates.push({
            text: textFrom(previous),
            containsControl: Boolean(previous.querySelector(controlSelector)),
          });
        }
        const parent: Element | null = cursor.parentElement;
        if (parent) {
          for (const child of Array.from(parent.children) as Element[]) {
            if (child.contains(control)) break;
            ancestorPromptCandidates.push({
              text: textFrom(child),
              containsControl: Boolean(child.querySelector(controlSelector)),
            });
          }
        }
        cursor = parent;
      }
      const questionEvidence = {
        ...(legend ? { fieldsetLegend: legend } : {}),
        ...(ariaLabelledByText ? { ariaLabelledByText } : {}),
        ...((ariaLabelledByText || ariaLabel) ? { accessibleName: ariaLabelledByText ?? ariaLabel } : {}),
        ...(questionContainerPrompts.length > 0
          ? { questionContainerPrompts }
          : {}),
        ...((adjacentPromptText ?? groupPrecedingPrompt) ? { nearbyPromptText: adjacentPromptText ?? groupPrecedingPrompt } : {}),
        ...(sectionTitle ? { sectionTitle } : {}),
        ...(nearbyInstructionText ? { nearbyInstructionText } : {}),
      };
      const ashbyNativeRadioTitle = control instanceof HTMLInputElement && control.type.toLowerCase() === "radio"
        ? textFrom(fieldEntryTitle)
        : undefined;
      const rawLabel = (
        ashbyNativeRadioTitle ||
        associated?.textContent?.trim() ||
        textFrom(fieldEntryTitle) ||
        uploadEntryLabel ||
        uploadContainerLabel ||
        control.getAttribute("aria-label")?.trim() ||
        control.getAttribute("placeholder")?.trim() ||
        control.getAttribute("name")?.trim() ||
        control.id.trim() ||
        `Field ${index + 1}`
      );
      const semanticRole = control.getAttribute("role")?.toLowerCase();
      const rawType = ashbyYesNoButton
        ? "radio"
        : control instanceof HTMLInputElement
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
          : semanticRole === "checkbox" || semanticRole === "switch"
            ? "checkbox"
          : semanticRole === "radio"
            ? "radio"
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
      const semanticGroup = semanticRole === "radio"
        ? control.closest('[role="radiogroup"]')
        : null;
      const options = ashbyYesNoButton
        ? Array.from(ashbyYesNoButton.closest(".ashby-application-form-input-yesno")?.querySelectorAll("button[data-option]") ?? [])
            .map((option) => ({ label: option.textContent?.trim() || option.getAttribute("data-option") || "", value: option.getAttribute("data-option") || "" }))
            .filter((option) => option.label && option.value)
        : control instanceof HTMLSelectElement
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
          : type === "radio" && semanticGroup
            ? Array.from(semanticGroup.querySelectorAll('[role="radio"]')).map((candidate) => ({
                label: candidate.getAttribute("aria-label")?.trim() || candidate.textContent?.trim() || "",
                value: candidate.getAttribute("data-value")?.trim() || candidate.getAttribute("value")?.trim() || candidate.getAttribute("aria-label")?.trim() || candidate.textContent?.trim() || "",
              })).filter((option) => option.label && option.value)
          : undefined;
      const id = fieldPath || control.id.trim() || control.getAttribute("name")?.trim() || `field-${index + 1}`;
      const providerIdentity = control.getAttribute("data-testid")?.trim() ||
        control.closest("[data-testid]")?.getAttribute("data-testid")?.trim();
      const tagName = control.tagName.toLowerCase();
      const escapeIdentifier = (value: string): string => {
        const escaped = value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
        if (/^[0-9]/.test(value)) return `\\3${value[0]} ${escaped.slice(1)}`;
        if (/^-[0-9]/.test(value)) return `-\\3${value[1]} ${escaped.slice(2)}`;
        if (value === "-") return "\\-";
        return escaped;
      };
      const escapeAttribute = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const uniqueSelector = (selector: string): boolean => document.querySelectorAll(selector).length === 1;
      const structuralSelector = (element: Element): string | undefined => {
        const parts: string[] = [];
        let current: Element | null = element;
        // A full structural path is a last-resort identity for Rippling's
        // repeated/opaque ids. It remains specific to the question's control
        // and is preferable to falling back to a global nth() locator.
        while (current && current !== document.body && current !== document.documentElement && parts.length < 12) {
          const tag = current.tagName.toLowerCase();
          const parent: Element | null = current.parentElement;
          if (!parent) break;
          const sameTag = Array.from(parent.children as HTMLCollectionOf<Element>).filter((child: Element) => child.tagName.toLowerCase() === tag);
          const ordinal = sameTag.indexOf(current) + 1;
          if (ordinal < 1) break;
          parts.unshift(`${tag}:nth-of-type(${ordinal})`);
          current = parent;
        }
        if (parts.length === 0) return undefined;
        const selector = parts.join(" > ");
        return uniqueSelector(selector) ? selector : undefined;
      };
      let stableSelector: string | undefined;
      let stableSelectorSource: string | undefined;
      if (ashbyYesNoButton && fieldPath) {
        const selector = `[data-field-path="${escapeAttribute(fieldPath)}"] .ashby-application-form-input-yesno`;
        if (uniqueSelector(selector)) {
          stableSelector = selector;
          stableSelectorSource = `ashby-yesno-field-path:${fieldPath}`;
        }
      }
      if (control.id.trim()) {
        const controlId = control.id.trim();
        const selector = /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(controlId)
          ? `${tagName}#${escapeIdentifier(controlId)}`
          : `${tagName}[id="${escapeAttribute(controlId)}"]`;
        if (uniqueSelector(selector)) {
          stableSelector = selector;
          stableSelectorSource = `dom-id:${controlId}`;
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
      if (!stableSelector && fieldPath) {
        const roleValue = control.getAttribute("role")?.trim();
        const roleSelector = roleValue ? `[role="${escapeAttribute(roleValue)}"]` : "";
        const selector = `[data-field-path="${escapeAttribute(fieldPath)}"] ${tagName}${roleSelector}`;
        if (uniqueSelector(selector)) {
          stableSelector = selector;
          stableSelectorSource = `dom-field-path:${fieldPath}`;
        }
      }
      if (!stableSelector) {
        const selector = structuralSelector(control);
        if (selector) {
          stableSelector = selector;
          stableSelectorSource = "dom-structure";
        }
      }
      const isFirstRadioInGroup = type !== "radio" ||
        (control instanceof HTMLInputElement && !control.name) ||
        (control instanceof HTMLInputElement
          ? Array.from(document.querySelectorAll('input[type="radio"]')).find((candidate) => (candidate as HTMLInputElement).name === control.name) === control
          : !semanticGroup || semanticGroup.querySelector('[role="radio"]') === control);
      return [{
        index,
        id,
        label: rawLabel,
        type,
        ...(control.getAttribute("role") ? { role: control.getAttribute("role")!.trim() } : {}),
        required: isFirstRadioInGroup && (control.required || control.getAttribute("aria-required") === "true" || fieldEntryRequired ||
          control.closest('[role="radiogroup"]')?.getAttribute("aria-required") === "true"),
        ...(stableSelector ? { stableSelector } : {}),
        ...(stableSelectorSource ? { stableSelectorSource } : {}),
        ...(providerIdentity ? { providerIdentity } : {}),
        ...(options && options.length > 0 ? { options } : {}),
        ...(legend ? { section: legend } : {}),
        ...((control instanceof HTMLInputElement && control.type.toLowerCase() === "radio" && control.name)
          ? { groupName: control.name }
          : ashbyYesNoButton && fieldPath
            ? { groupName: fieldPath }
          : semanticGroup
            ? { groupName: semanticGroup.id || semanticGroup.getAttribute("aria-label") || undefined }
            : {}),
        ...(uploadEntryLabel || uploadContainerLabel ? { explicitFileLabel: true } : {}),
        ...(Object.keys(questionEvidence).length > 0 ? { questionEvidence } : {}),
        ...(ancestorPromptCandidates.length > 0 ? { ripplingPromptCandidates: ancestorPromptCandidates } : {}),
      }];
    }));

    const normalizedRaw = raw.map((item) => {
      const ancestorPromptText = extractRipplingPromptFromCandidates(item.ripplingPromptCandidates ?? []);
      const questionEvidence = !item.questionEvidence?.fieldsetLegend &&
        !item.questionEvidence?.ariaLabelledByText &&
        (item.questionEvidence?.questionContainerPrompts?.length ?? 0) === 0 &&
        ancestorPromptText
        ? {
            ...(item.questionEvidence ?? {}),
            questionContainerPrompts: [ancestorPromptText],
          }
        : item.questionEvidence;
      const normalizedItem = { ...item };
      delete normalizedItem.ripplingPromptCandidates;
      return {
        ...normalizedItem,
        label: (isOpaqueControlLabel(item.label) || (isGenericSelectPrompt(item.label) && !item.explicitFileLabel)) && ancestorPromptText
          ? ancestorPromptText
          : item.label,
        ...(questionEvidence ? { questionEvidence } : {}),
      };
    });

    const fields: LeverBrowserField[] = [];
    const idOccurrences = new Map<string, number>();
    const logicalRadioGroups = new Set<string>();
    // Native radio inputs are emitted once per option by Ashby. Their shared
    // `name` is the browser's logical group identity, while the prompt keeps
    // malformed pages that reuse a name for separate questions distinct.
    const nativeRadioGroups = new Set<string>();
    let ripplingResumeUploadAccepted = false;
    const isRipplingApplication = isVerifiedRipplingApplicationUrl(this.page.url());
    const ripplingResumeUploadCandidates = isRipplingApplication
      ? normalizedRaw.filter((item) => item.type === "file" && (isRipplingResumeUploadLabel(item.label) || isRipplingCanonicalResumeField(item)))
      : [];
    const ripplingStableResumeCandidates = ripplingResumeUploadCandidates.filter(hasRipplingResumeIdentity);
    const ripplingResumeUploadIsAmbiguous = ripplingResumeUploadCandidates.length > 1 &&
      ripplingStableResumeCandidates.length !== 1;
    const hasAshbyResumeField = isVerifiedAshbyFormUrl(this.page.url()) &&
      normalizedRaw.some((item) => item.type === "file" && item.id === "_systemfield_resume");
    for (const item of normalizedRaw) {
      // Ashby's optional resume-autofill upload starts asynchronous parsing
      // and remounts later fields. The canonical Resume control is the actual
      // application attachment; upload there once instead.
      // Ashby exposes an optional resume-autofill input alongside the actual
      // application attachment. Its label is not stable across deployments
      // (and can collapse to an opaque generated id), so once the canonical
      // system resume field is present, never upload to another file input.
      if (hasAshbyResumeField && item.type === "file" && item.id !== "_systemfield_resume") continue;
      if (item.type === "radio" && item.groupName) {
        const prompt = item.questionEvidence?.questionContainerPrompts?.[0]
          ?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
        const groupName = item.groupName.toLowerCase();
        // Ashby has emitted the same optional EEOC gender group twice with
        // different prompt wrappers ("Input gender" and "Gender"). Keep
        // distinct questions safe by requiring the option set to match, but
        // ignore that wrapper text for this canonical provider group.
        const eeocGenderGroup = /__systemfield_eeoc_gender$/.test(groupName);
        const optionSignature = (item.options ?? [])
          .map((option) => `${option.label}\u0000${option.value}`)
          .join("\u0002")
          .toLowerCase();
        const nativeLogicalKey = eeocGenderGroup
          ? `${groupName}\u0001${optionSignature}`
          : `${groupName}\u0001${prompt}`;
        if (nativeRadioGroups.has(nativeLogicalKey)) continue;
        nativeRadioGroups.add(nativeLogicalKey);
      }
      if (item.type === "radio" && item.questionEvidence?.questionContainerPrompts?.length && item.options?.length) {
        const logicalKey = [
          item.questionEvidence.questionContainerPrompts[0],
          ...item.options.map((option) => `${option.label}\u0000${option.value}`),
        ].join("\u0001").toLowerCase();
        if (logicalRadioGroups.has(logicalKey)) continue;
        logicalRadioGroups.add(logicalKey);
      }
      const occurrence = idOccurrences.get(item.id) ?? 0;
      idOccurrences.set(item.id, occurrence + 1);
      const uniqueItem = occurrence === 0
        ? item
        : { ...item, id: `${item.id}--${occurrence + 1}` };
      const enrichedItem = uniqueItem.type === "select" && (!uniqueItem.options || uniqueItem.options.length === 0)
        ? { ...uniqueItem, options: await this.inspectCustomSelectOptions(uniqueItem) }
        : uniqueItem;
      const locator = enrichedItem.stableSelector ? this.page.locator(enrichedItem.stableSelector) : controls.nth(enrichedItem.index);
      const visible = await visibleFormControl(locator);
      const visibleProtagonaResumeWrapper = enrichedItem.type === "file" &&
        enrichedItem.id === "resumator-resume-value" &&
        isVerifiedProtagonaApplicationUrl(this.page.url()) &&
        await visibleFormControl(this.page.locator("#resumator-resume-upload-wrapper"));
      const visibleUpload = enrichedItem.type === "file" && await visibleUploadContainer(locator);
      const isResumeLikeRipplingUpload = isRipplingApplication && enrichedItem.type === "file" &&
        (isRipplingResumeUploadLabel(enrichedItem.label) || isRipplingCanonicalResumeField(enrichedItem));
      // Extension-only labels are not enough to distinguish a resume from a
      // cover letter/additional document. If multiple such controls exist,
      // expose only one with a stable resume identity; otherwise fail closed.
      if (isResumeLikeRipplingUpload && ripplingResumeUploadCandidates.length > 1 &&
        (ripplingResumeUploadIsAmbiguous || !hasRipplingResumeIdentity(enrichedItem))) continue;
      // Rippling can leave a second copy of the same generic dropzone mounted
      // during hydration. Keep the first visible canonical resume control and
      // do not risk treating a second attachment/dropzone as the resume.
      if (isResumeLikeRipplingUpload && ripplingResumeUploadAccepted) continue;
      if (visible || visibleUpload || visibleProtagonaResumeWrapper) {
        fields.push(new PlaywrightLeverBrowserField(this.page, enrichedItem));
        if (isResumeLikeRipplingUpload) ripplingResumeUploadAccepted = true;
      }
    }
    return fields;
  }

  async formActionOrigin(): Promise<string | null> {
    const action = await this.page.locator("form").first().getAttribute("action").catch(() => null);
    if (!action || !action.trim()) return null;
    try {
      return new URL(action, this.page.url()).origin;
    } catch {
      return "invalid-origin";
    }
  }

  async verifyPageIdentity(company: string, role: string): Promise<boolean> {
    const text = (await this.page.locator("body").innerText().catch(() => ""))
      .toLowerCase().replace(/[^a-z0-9]+/g, " ");
    const terms = `${company} ${role}`.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2);
    return terms.length > 0 && terms.every((term) => text.includes(term));
  }

  /** Matlen keeps its application form behind a non-submitting Apply toggle. */
  private async revealMatlenApplicationForm(): Promise<void> {
    if (!isVerifiedMatlenApplicationUrl(this.page.url())) return;
    const formControls = this.page.locator(
      "#wpjb-apply-form input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]), #wpjb-apply-form textarea, #wpjb-apply-form select",
    );
    for (let index = 0; index < await formControls.count(); index += 1) {
      if (await visibleFormControl(formControls.nth(index))) return;
    }
    const toggle = this.page.locator('a.wpjb-form-job-apply[href*="form=apply"]');
    if (await toggle.count() === 0 || !(await visibleFormControl(toggle.first()))) return;
    await toggle.first().click();
    await this.page.waitForTimeout(250).catch(() => undefined);
  }

  /** Protagona keeps its file input behind a non-submitting Attach resume toggle. */
  private async revealProtagonaResumeUpload(): Promise<void> {
    if (!isVerifiedProtagonaApplicationUrl(this.page.url())) return;
    const fileInput = this.page.locator("#resumator-resume-value");
    const uploadWrapper = this.page.locator("#resumator-resume-upload-wrapper");
    if (await fileInput.count() === 0 || await visibleFormControl(uploadWrapper)) return;
    const chooseUpload = this.page.locator("#resumator-choose-upload");
    if (await chooseUpload.count() === 0 || !(await visibleFormControl(chooseUpload))) return;
    await chooseUpload.click();
    await uploadWrapper.waitFor({ state: "visible", timeout: Math.min(this.timeoutMs, 3_000) }).catch(() => undefined);
  }

  /** Opens a custom combobox only to read its visible options; no option is selected. */
  private async inspectCustomSelectOptions(raw: InspectedRawField): Promise<readonly ApplicationFieldOption[] | undefined> {
    if (!raw.stableSelector) return undefined;
    const field = this.page.locator(raw.stableSelector);
    if (!(await visibleFormControl(field))) return undefined;
    let openedWithAshbyToggle = false;
    if (isVerifiedAshbyFormUrl(this.page.url())) {
      // Ashby's autocomplete input is not itself the flyout trigger. Clicking
      // it leaves aria-expanded=false and produces no options; the sibling
      // button in the same data-field-path container opens the authoritative
      // option list. Resolve that button by DOM ownership rather than by a
      // global label, and require exactly one visible candidate.
      const fieldPath = await field.evaluate((element) =>
        element.closest("[data-field-path]")?.getAttribute("data-field-path") ?? null,
      ).catch(() => null);
      if (fieldPath) {
        const buttons = this.page.locator("button");
        const owned: Locator[] = [];
        for (let index = 0; index < await buttons.count(); index += 1) {
          const candidate = buttons.nth(index);
          const candidatePath = await candidate.evaluate((element) =>
            element.closest("[data-field-path]")?.getAttribute("data-field-path") ?? null,
          ).catch(() => null);
          if (candidatePath === fieldPath && await visibleFormControl(candidate)) owned.push(candidate);
        }
        if (owned.length === 1) {
          await owned[0]!.click();
          openedWithAshbyToggle = true;
        }
      }
    }
    if (!openedWithAshbyToggle) {
      const toggle = field
        .locator('xpath=ancestor::div[contains(@class, "select__container")]')
        .getByRole("button", { name: "Toggle flyout" });
      if (await toggle.count() > 0 && await visibleFormControl(toggle.first())) {
        await toggle.first().click();
      } else if (!isVerifiedAshbyFormUrl(this.page.url())) {
        await field.click();
      }
    }
    try {
      // Read only the listbox owned by this combobox (or the single fresh
      // visible portal listbox). Never scrape page-wide options: adjacent
      // Rippling selects can leave their portals mounted during hydration.
      let options: Locator[] = [];
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          const ownership = await field.evaluate((element) =>
            `${element.getAttribute("aria-controls") ?? ""} ${element.getAttribute("aria-owns") ?? ""}`.trim().split(/\s+/).filter(Boolean),
          ).catch(() => [] as string[]);
          if (ownership.length > 1) throw new Error("multiple owned listboxes");
          let listbox: Locator | null = null;
          if (ownership.length === 1) {
            const owned = this.page.locator(`[id="${escapeCssAttribute(ownership[0]!)}"]`);
            if (await owned.count() === 1 && await visibleFormControl(owned)) listbox = owned;
          } else {
            const openListboxes = this.page.locator('[role="listbox"]');
            const visibleListboxes: Locator[] = [];
            for (let index = 0; index < await openListboxes.count(); index += 1) {
              const candidate = openListboxes.nth(index);
              if (await visibleFormControl(candidate)) visibleListboxes.push(candidate);
            }
            if (visibleListboxes.length === 1) listbox = visibleListboxes[0]!;
            else if (visibleListboxes.length > 1) throw new Error("multiple visible listboxes");
          }
          options = listbox ? await (async () => {
            const result: Locator[] = [];
            const rendered = listbox!.locator('[role="option"], .select__option');
            for (let index = 0; index < await rendered.count(); index += 1) {
              const option = rendered.nth(index);
              if (await interactableOption(option)) result.push(option);
            }
            return result;
          })() : [];
        } catch {
          options = [];
        }
        if (options.length > 0) break;
        if (attempt < 19) await this.page.waitForTimeout(50);
      }
      const result: ApplicationFieldOption[] = [];
      const seen = new Set<string>();
      for (const option of options) {
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
    // ApplyToJob/Protagona renders its final control as a deliberately
    // non-submitting input button. Recognize only the exact verified route;
    // the executor still never clicks it under manual submission authority.
    if (isVerifiedProtagonaApplicationUrl(this.page.url())) {
      const protagonaSubmit = this.page.locator(
        'input#resumator-submit-resume, input[type="button"][value="Submit Application"]',
      );
      for (let index = 0; index < await protagonaSubmit.count(); index += 1) {
        const candidate = protagonaSubmit.nth(index);
        if (await visibleFormControl(candidate)) return candidate;
      }
    }
    // Ashby's hosted application form renders its final control outside a
    // native form and without type="submit". Recognize only the stable
    // provider class on a verified Ashby application route, and require the
    // exact visible label so unrelated buttons cannot become submit controls.
    if (isVerifiedAshbyApplicationUrl(this.page.url())) {
      const ashbySubmit = this.page.locator("button.ashby-application-form-submit-button");
      for (let index = 0; index < await ashbySubmit.count(); index += 1) {
        const candidate = ashbySubmit.nth(index);
        if (!(await visibleFormControl(candidate))) continue;
        const text = (await candidate.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        if (text === "Submit Application") return candidate;
      }
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

  private async nativeValidityDiagnostics(): Promise<readonly string[]> {
    const invalidControls = this.page.locator("form :invalid");
    const evidence: string[] = [];
    const invalidCount = await invalidControls.count();
    for (let index = 0; index < invalidCount; index += 1) {
      const candidate = invalidControls.nth(index);
      if (!(await visibleFormControl(candidate))) continue;
      if (evidence.length >= 12) continue;
      const observation = await candidate.evaluate((element): NativeValidityObservation => {
        const validity = (element as HTMLInputElement).validity;
        const flags = ["valueMissing", "typeMismatch", "patternMismatch", "tooLong", "tooShort", "rangeUnderflow", "rangeOverflow", "stepMismatch", "badInput", "customError"]
          .filter((flag) => validity[flag as keyof ValidityState] === true);
        return {
          ordinal: 0,
          tagName: element.tagName,
          type: element.getAttribute("type") ?? undefined,
          flags,
        };
      });
      evidence.push(nativeValidityEvidence({ ...observation, ordinal: evidence.length }));
    }
    if (invalidCount > 12 && evidence.length === 12) evidence.push("invalid-control:additional-visible-controls");
    return evidence;
  }

  async submit(): Promise<BrowserSubmissionResult> {
    const control = await this.submitControl();
    if (!control) return { clicked: false, confirmed: false, evidence: "submit:control-missing" };
    if (await control.isDisabled().catch(() => true) || (await control.getAttribute("aria-disabled").catch(() => null)) === "true") {
      return { clicked: false, confirmed: false, evidence: "submit:control-disabled" };
    }
    const nativeValidity = await this.nativeValidityDiagnostics();
    if (nativeValidity.length > 0) {
      return {
        clicked: false,
        confirmed: false,
        outcome: "rejected",
        reasonCode: "validation-error",
        evidence: `submit:not-clicked; submit:rejected; error:validation-error; ${nativeValidity.join("|")}`,
      };
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
      const postClickBoundary = clicked ? await this.detectHumanBoundary() : null;
      if (postClickBoundary) {
        return {
          clicked: true,
          confirmed: false,
          outcome: "ambiguous",
          reasonCode: "confirmation-missing",
          humanBoundary: postClickBoundary,
          evidence: `submit:clicked; human-boundary:${postClickBoundary.kind}`,
        };
      }
      // Gusto can leave the form in place after a rejected submit. Inspect a
      // bounded set of visible error surfaces, but retain only stable reason
      // codes in the result (never echo their text or field values).
      const diagnosticLocators = this.page.locator(
        '[role="alert"], [aria-live="assertive"], .error, .errors, .field-error, .form-error, [data-testid*="error" i]',
      );
      const reasons = new Set<PostSubmitErrorReason>();
      let diagnosticCount = 0;
      for (let index = 0; index < Math.min(await diagnosticLocators.count(), 12); index += 1) {
        const candidate = diagnosticLocators.nth(index);
        if (!(await visibleFormControl(candidate))) continue;
        diagnosticCount += 1;
        const text = await candidate.innerText().catch(() => "");
        const reason = classifyPostSubmitError(text);
        if (reason) reasons.add(reason);
      }
      const invalidControls = this.page.locator('[aria-invalid="true"], :invalid');
      for (let index = 0; index < Math.min(await invalidControls.count(), 12); index += 1) {
        if (await visibleFormControl(invalidControls.nth(index))) reasons.add("validation-error");
      }
      const rejectedReason = ["upload-error", "validation-error", "server-error"].find((reason) => reasons.has(reason as PostSubmitErrorReason)) as PostSubmitErrorReason | undefined;
      if (clicked && rejectedReason) {
        return {
          clicked: true,
          confirmed: false,
          outcome: "rejected",
          reasonCode: rejectedReason,
          evidence: `submit:clicked; submit:rejected; error:${rejectedReason}; error-surfaces:${diagnosticCount}`,
        };
      }
      return {
        clicked,
        confirmed: false,
        outcome: "ambiguous",
        reasonCode: "confirmation-missing",
        evidence: clicked ? "submit:clicked; confirmation:not-detected" : "submit:not-clicked; confirmation:not-detected",
      };
    }

    const parsed = new URL(afterUrl);
    return {
      clicked: true,
      confirmed: true,
      outcome: "confirmed",
      externalApplicationId: `confirmation:${parsed.hostname}${parsed.pathname}`,
      confirmationOrigin: parsed.origin,
      confirmationUrl: parsed.toString(),
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
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
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
