import type {
  ApplicationExecutionRequest,
  ApplicationExecutor,
  ApplicationFieldClassification,
  ApplicationFieldDescriptor,
  ApplicationFieldOption,
  ApplicationFieldType,
  BrowserHumanBoundary,
  BrowserCaptchaDiagnostics,
  BrowserExecutionBoundaryState,
  BrowserExecutionDiagnostic,
  BrowserExecutionDiagnosticStage,
  BrowserNavigationDiagnostics,
  ExecutionInspection,
  LeverBrowserField,
  LeverBrowserSession,
  LeverBrowserSessionFactory,
  ApplicationExecutorResult,
  ApplicationExecutorMode,
  BrowserSubmissionResult,
} from "./executor";
import {
  BrowserExecutionDiagnosticError,
  browserDiagnosticForError,
  safeBrowserDiagnosticMessage,
} from "./executor";
import type {
  CareerBlocker,
  CareerBlockerDraft,
  QuestionProvenance,
  CareerJob,
} from "./campaignTypes";
import type {
  AnswerValue,
  ApplicationAnswer,
  CandidateProfile,
  JobPosting,
  ResumeFamilyId,
} from "./types";
import {
  isVerifiedLeverApplicationUrl,
  isVerifiedLeverHostedUrl,
  leverSourceId,
} from "./leverJobSource";
import {
  isVerifiedGreenhouseApplicationUrl,
  isVerifiedGreenhouseHostedUrl,
} from "./greenhouseJobSource";
import {
  classifyJobUrl,
  isVerifiedAshbyHostedUrl,
  isVerifiedAshbyApplicationUrl,
  isVerifiedRipplingHostedUrl,
  isVerifiedRipplingApplicationUrl,
  ripplingApplicationUrl,
  isVerifiedWorkdayApplicationUrl,
  isVerifiedWorkdayHostedUrl,
  workdayPostingId,
  isVerifiedYouHiredApplicationUrl,
  isVerifiedMatlenApplicationUrl,
  isVerifiedProtagonaApplicationUrl,
  isVerifiedGustoHostedUrl,
  isVerifiedGustoApplicationUrl,
  gustoPostingId,
  matlenPostingId,
  protagonaPostingId,
  youHiredPostingId,
} from "./jobUrlClassifier";
import { DETERMINISTIC_DRAFT_PROVENANCE } from "./answers";
import { monotonicNow } from "./executionTrace";

export interface LeverBrowserExecutorOptions {
  sessionFactory: LeverBrowserSessionFactory;
  /** Defaults to Lever for backwards compatibility; auto accepts verified ATS destinations. */
  provider?: "lever" | "greenhouse" | "rippling" | "ashby" | "workday" | "youhired" | "matlensilver" | "protagona" | "gusto" | "generic" | "auto";
  /** Local/private resume artifacts keyed by the selected family. Never persisted by the domain. */
  resumePaths?: Partial<Record<ResumeFamilyId, string>>;
  /** The concrete host may check a path before the browser attempts upload. */
  resumeFileExists?: (path: string) => boolean | Promise<boolean>;
  /** Optional host-side restriction for a bounded preparation-only run. */
  allowedFieldClassifications?: readonly ApplicationFieldClassification[];
  /** Server-only capability gate; campaign policy must independently be automatic. */
  allowAutomaticSubmission?: boolean;
  now?: () => string;
}

interface SessionState {
  session: LeverBrowserSession;
  navigated: boolean;
}

interface TrustedTarget {
  provider: "lever" | "greenhouse" | "rippling" | "ashby" | "workday" | "youhired" | "matlensilver" | "protagona" | "gusto" | "generic";
  site: string;
  postingId?: string;
  applicationUrl: string;
}

interface ObservedForm {
  target: TrustedTarget;
  session: LeverBrowserSession;
  fields: readonly LeverBrowserField[];
  inspection: ExecutionInspection;
}

type InspectionPhase = "preflight" | "executor";

function initialBoundaryState(phase: InspectionPhase): BrowserExecutionBoundaryState {
  return {
    browserLaunched: false,
    contextCreated: false,
    pageCreated: false,
    navigationStarted: false,
    navigationCompleted: false,
    domReady: false,
    preflightInspectionStarted: phase === "preflight",
    preflightInspectionCompleted: false,
    controlsInspectionStarted: false,
    controlsInspectionCompleted: false,
    executorStarted: false,
    executorInspectionStarted: phase === "executor",
    executorInspectionCompleted: false,
    browserClosed: false,
  };
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

interface FieldDecision {
  value?: AnswerValue;
  explicit: boolean;
  /** Optional fields may remain untouched. Required fields become blockers. */
  leaveUntouched?: boolean;
  blocker?: CareerBlockerDraft;
}

const SUPPORTED_FIELD_TYPES: ReadonlySet<ApplicationFieldType> = new Set([
  "text",
  "email",
  "tel",
  "textarea",
  "select",
  "radio",
  "checkbox",
  "file",
]);

function defaultNow(): string {
  return new Date().toISOString();
}

function safeErrorMessage(error: unknown, fallback: string): string {
  return safeBrowserDiagnosticMessage(error, fallback);
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalized(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizedTokens(value: string): readonly string[] {
  return normalized(value)
    .split(/[^a-z0-9+#/.]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function fieldText(field: Pick<LeverBrowserField, "id" | "label" | "section">): string {
  return normalized([field.id, field.label, field.section].filter(Boolean).join(" "));
}

function inspectedPromptText(field: Pick<LeverBrowserField, "id" | "label" | "section">): string {
  const contextualField = field as Pick<LeverBrowserField, "id" | "label" | "section"> & {
    questionDescriptor?: {
      promptText?: string;
      accessibleName?: string;
      nearbyInstructionText?: string;
      sectionTitle?: string;
    };
  };
  return normalized([
    field.id,
    field.label,
    field.section,
    contextualField.questionDescriptor?.promptText,
    contextualField.questionDescriptor?.accessibleName,
    contextualField.questionDescriptor?.nearbyInstructionText,
    contextualField.questionDescriptor?.sectionTitle,
  ].filter(Boolean).join(" "));
}

/**
 * Text that describes this control itself, excluding surrounding section
 * headings. Section headings provide useful context but must not classify a
 * location control as work authorization merely because both appear in one
 * form section.
 */
function directFieldPromptText(field: Pick<LeverBrowserField, "id" | "label" | "section">): string {
  const contextualField = field as Pick<LeverBrowserField, "id" | "label" | "section"> & {
    questionDescriptor?: {
      promptText?: string;
      accessibleName?: string;
      nearbyInstructionText?: string;
    };
  };
  return normalized([
    field.id,
    field.label,
    contextualField.questionDescriptor?.promptText,
    contextualField.questionDescriptor?.accessibleName,
    contextualField.questionDescriptor?.nearbyInstructionText,
  ].filter(Boolean).join(" "));
}

type ProfileFactField = "linkedin" | "website" | "desired_work_location" | "start_availability";

function profileFactField(field: Pick<LeverBrowserField, "id" | "label" | "section">): ProfileFactField | undefined {
  const text = inspectedPromptText(field).replace(/[_-]+/g, " ");
  if (hasPhrase(text, /linkedin|linked in/)) return "linkedin";
  if (hasPhrase(text, /website|personal site|web site/)) return "website";
  if (hasPhrase(text, /(?:desired|preferred|target) (?:work )?location|location preference|where do you prefer to work|where would you like to work/)) {
    return "desired_work_location";
  }
  if (hasPhrase(text, /employ|employer|company|work history|job history|position held|job title|occupation/)) return undefined;
  if (hasPhrase(text, /(?:available|availability|start|commence|join|begin).{0,24}(?:date|when)|(?:date|when).{0,24}(?:available|availability|start|commence|join|begin)/)) {
    return "start_availability";
  }
  return undefined;
}

function isReferralField(field: Pick<LeverBrowserField, "id" | "label" | "section">): boolean {
  return hasPhrase(inspectedPromptText(field), /\b(?:referred|referral|recruiter)\b/);
}

/**
 * A background-check willingness preference is a narrowly scoped, explicit
 * candidate answer. It must not cover historical screening questions or other
 * legal attestations merely because they mention a background check.
 */
function isBackgroundCheckConsentField(field: Pick<LeverBrowserField, "id" | "label" | "section">): boolean {
  const text = directFieldPromptText(field);
  return /\bbackground\s+(?:check|screen(?:ing)?|investigation)\b/.test(text) &&
    /\b(?:willing|consent|agree|undergo|submit|authorize|required)\b/.test(text);
}

/**
 * SMS/text-message opt-in is an optional communications preference, not a
 * phone-number or work-authorization fact. The candidate has explicitly
 * opted out, so this narrow rule always supplies No for these prompts.
 */
function isSmsConsentField(field: Pick<LeverBrowserField, "id" | "label" | "section">): boolean {
  const text = directFieldPromptText(field);
  return /\b(?:sms|text\s*messages?|text-message)\b/.test(text) &&
    /\b(?:consent|agree(?:ment)?|opt\s*(?:in|out)|receive|updates?|messages?)\b/.test(text);
}

/**
 * Age-of-majority screening is a stable candidate fact supplied by the user.
 * Keep this narrower than general legal attestations so an unrelated legal
 * question can never inherit the affirmative answer.
 */
function isAgeRequirementField(field: Pick<LeverBrowserField, "id" | "label" | "section">): boolean {
  const text = directFieldPromptText(field);
  return /\b(?:eighteen|18)\s+(?:years?|yrs?)\s+(?:of\s+age\s+)?or\s+older\b/.test(text) ||
    /\b(?:at\s+least\s+eighteen|18\s+or\s+older)\b/.test(text);
}

/** These are personal screening questions, not employment-history fields. */
function isEmploymentScreeningQuestion(field: Pick<LeverBrowserField, "id" | "label" | "section">): boolean {
  const text = directFieldPromptText(field);
  return /\bmay\s+.+\bcontact\b.+\b(?:current|most\s+recent|past|former)\s+employer\b/.test(text) ||
    /\b(?:fired|terminated|asked\s+to\s+resign)\b/.test(text);
}

function approvedDemographicValueForField(
  field: Pick<LeverBrowserField, "id" | "label" | "section" | "options">,
  profile: CandidateProfile,
): string | undefined {
  const text = inspectedPromptText(field);
  const approved = profile.approvedReusableAnswers;
  // Test the more specific gender-adjacent category first so a transgender
  // prompt can never consume the general gender identity answer.
  if (/\btransgender\b|\btrans\s*gender\b|\btrans status\b/.test(text)) return approved.transgender_status?.trim();
  if (/\bsexual orientation\b|\bsexuality\b/.test(text)) return approved.sexual_orientation?.trim();
  if (/\bdisability\b|\bdisabled\b/.test(text)) return approved.disability_status?.trim();
  if (/\b(?:protected\s+)?veteran\b|\bmilitary service\b/.test(text)) return approved.veteran_status?.trim();
  if (/\bhow do you describe your gender identity\b/.test(text)) return approved.gender_identity?.trim();
  // Ashby can expose a second, custom gender question whose inspected label is
  // only the currently rendered option (for example "Female"). The option
  // vocabulary is the stable signal in that shape; only consume it when the
  // entire group is recognizably a gender choice.
  const genderOptions = field.options?.map((option) => normalized(option.label)).filter(Boolean) ?? [];
  if (genderOptions.some((option) => option === "male") &&
    genderOptions.some((option) => option === "female") &&
    genderOptions.some((option) => option === "non-binary" || option === "nonbinary")) {
    return approved.gender_identity?.trim();
  }
  // Hispanic/Latino is an ethnicity subtype, not the general race/ethnicity
  // answer. Check it before the broader race matcher so the White answer can
  // never be consumed by this control.
  if (/\bhispanic\b|\blatino\b|\blatina\b|\blatinx\b/.test(text)) return approved.hispanic_latino?.trim();
  if (/\brace\b|\bethnic(?:ity| origin)?\b/.test(text)) return approved.race_ethnicity?.trim();
  if (/\bdemographic\b.{0,32}\b(?:consent|data)\b|\b(?:consent|data)\b.{0,32}\bdemographic\b/.test(text)) {
    return approved.demographic_consent?.trim();
  }
  if (/\bgender identity\b|\bwhat(?: is|’s|'s) your gender\b|\bgender\b/.test(text)) return approved.gender_identity?.trim();
  return undefined;
}

/**
 * Ashby sometimes renders voluntary race/ethnicity questions as one checkbox
 * per option instead of a single select.  In that shape the approved answer
 * is the state of the option, not the checkbox's literal value.  Only map
 * controls with an unambiguous demographic option label; unrelated optional
 * checkboxes remain untouched.
 */
function approvedDemographicCheckboxValueForField(
  field: Pick<LeverBrowserField, "id" | "label" | "section">,
  profile: CandidateProfile,
): boolean | undefined {
  const text = inspectedPromptText(field);
  const approved = profile.approvedReusableAnswers;
  const optionText = normalized([field.id, field.label].filter(Boolean).join(" "));

  const hispanic = approved.hispanic_latino?.trim();
  if (hispanic && /\bhispanic\b|\blatino\b|\blatina\b|\blatinx\b/.test(optionText)) {
    return checkboxValue(hispanic) === true
      ? /\bhispanic\b|\blatino\b|\blatina\b|\blatinx\b/.test(optionText)
      : false;
  }

  const race = normalized(approved.race_ethnicity ?? "");
  if (!race || !/\brace\b|\bethnic|\bcaucasian\b|\bwhite\b|\bblack\b|\basian\b|\bnative\b|\bislander\b|\bmiddle eastern\b/.test(text)) {
    return undefined;
  }
  const raceOption =
    /\bwhite\b|\bcaucasian\b/.test(optionText) ? "white" :
    /\bblack\b|\bafrican american\b/.test(optionText) ? "black" :
    /\basian\b/.test(optionText) ? "asian" :
    /\bnative american\b|\balaska native\b/.test(optionText) ? "native american" :
    /\bnative hawaiian\b|\bpacific islander\b/.test(optionText) ? "pacific islander" :
    /\bmiddle eastern\b|\bnorth african\b/.test(optionText) ? "middle eastern" :
    undefined;
  if (!raceOption) return undefined;
  return race.includes(raceOption) || (raceOption === "white" && race.includes("caucasian"));
}

/**
 * Job-discovery questions have one explicit reusable answer. Keep this
 * separate from referral questions: a referral name/contact must never be
 * answered with the generic source value.
 */
function approvedJobSourceValueForField(
  field: Pick<LeverBrowserField, "id" | "label" | "section">,
  profile: CandidateProfile,
): string | undefined {
  const text = inspectedPromptText(field);
  if (isReferralField(field)) return undefined;
  if (!/\bhow did you (?:hear|learn)\b|\bwhere did you hear\b|\bhow did you discover\b|\b(?:job|role|opportunity) source\b|\bsource of (?:this )?(?:job|role|opportunity)\b/.test(text)) {
    return undefined;
  }
  return profile.approvedReusableAnswers.job_source?.trim();
}

/**
 * Ashby renders age as a required radio group of brackets. The inspected
 * control label may be only the first option, so recognize the complete
 * bracket vocabulary and map the explicit profile age to its unique bracket.
 */
function approvedAgeBracketValueForField(
  field: Pick<LeverBrowserField, "id" | "label" | "section" | "options">,
  profile: CandidateProfile,
): string | undefined {
  const age = Number.parseInt(profile.approvedReusableAnswers.age?.trim() ?? "", 10);
  if (!Number.isInteger(age) || age < 0 || age > 130 || !field.options?.length) return undefined;
  const options = field.options.map((option) => ({
    option,
    label: normalized(option.label),
  }));
  const hasAgeBrackets = options.some(({ label }) => /^(?:17 or younger|18\s*[-–]\s*20|21\s*[-–]\s*29|30\s*[-–]\s*39|40\s*[-–]\s*49|50\s*[-–]\s*59|60 or older)$/.test(label));
  if (!hasAgeBrackets) return undefined;
  const matches = options.filter(({ label }) => {
    const range = label.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (range) return age >= Number(range[1]) && age <= Number(range[2]);
    if (label === "17 or younger") return age <= 17;
    if (label === "60 or older") return age >= 60;
    return false;
  });
  if (matches.length !== 1) return undefined;
  const selected = matches[0]!.option;
  const duplicateValue = options.filter(({ option }) =>
    normalized(option.value) === normalized(selected.value),
  ).length > 1;
  return duplicateValue || normalized(selected.value) === "on"
    ? selected.label
    : (selected.value || selected.label);
}

function approvedAcknowledgmentValueForField(
  field: Pick<LeverBrowserField, "id" | "label" | "section">,
  profile: CandidateProfile,
): string | undefined {
  const text = directFieldPromptText(field);
  if (isExactAcknowledgmentPrompt(text)) return "I Acknowledge";
  if (/(?:certif|attest|acknowledg|legal|agree)/i.test(text) &&
    /\b(?:sign|signature|full\s+legal\s+name)\b/i.test(text)) {
    return profile.identity.fullName?.trim() || undefined;
  }
  return undefined;
}

/** Ashby can expose a privacy-policy continuation as a radio control whose
 * prompt is the privacy notice itself rather than an explicit "I acknowledge"
 * text-entry instruction. It is still a legal attestation, never a generic
 * free-text question. */
function isPrivacyAcknowledgmentPrompt(text: string): boolean {
  const lower = normalized(text);
  return /\backnowledge\b/.test(lower) &&
    /\bpersonal data\b/.test(lower) &&
    /\b(?:privacy|recruitment|collect and use)\b/.test(lower) &&
    /\b(?:by continuing|continue)\b/.test(lower);
}

/** A previously resolved Ashby off-site question may reappear with a new
 * generated control id and a more explicit travel prompt on reinspection. */
function isOffsiteTravelPrompt(text: string): boolean {
  const lower = normalized(text);
  return /\boff[- ]?sites?\b/.test(lower) &&
    /\b(?:working sessions?|hackathons?|hub cities?)\b/.test(lower) &&
    /\b(?:travel|quarter)\b/.test(lower);
}

function isExactAcknowledgmentPrompt(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("i acknowledge") &&
    /(?:please\s+type|by\s+typing|type\s+['\"]?i acknowledge)/.test(lower) &&
    !lower.includes("or explain");
}

function hasPhrase(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

/** Preferred names require an explicit profile fact; fullName is never a fallback. */
export function isPreferredNameField(
  field: Pick<LeverBrowserField, "id" | "label" | "section">,
): boolean {
  const text = fieldText(field).replace(/[_-]+/g, " ");
  return /\bpreferred(?: first| given)? name\b/.test(text);
}

/** Rippling/Greenhouse phone-country widgets expose many "+<code> … Country" options. */
export function looksLikeInternationalDialingOptions(
  options: readonly ApplicationFieldOption[] | undefined,
): boolean {
  if (!options || options.length === 0) return false;
  // Rippling virtualizes this list and can expose only the first visible row
  // during inspection.  A sparse sample is safe to classify only when every
  // observed label has the full, distinctive dialing-code shape; this keeps a
  // normal one-option select fail-closed.
  if (options.length < 5) {
    return options.every((option) =>
      /^\+\d{1,4}\s+[A-Z]{2}\s+-\s+\S/i.test(`${option.label} ${option.value}`.trim()),
    );
  }
  let dialing = 0;
  for (const option of options) {
    const sample = `${option.label} ${option.value}`.trim();
    if (/^\+\d{1,4}\b/.test(sample) || (/\b\+\d{1,4}\b/.test(sample) && /[A-Z]{2}\s*-/.test(sample))) {
      dialing += 1;
    }
  }
  return dialing / options.length >= 0.6;
}

/**
 * Rippling renders the phone-country control as a generic Search select when
 * its question association is unavailable. The option vocabulary is the
 * authoritative, value-free signal for this control; keep this separate from
 * ordinary location questions so callers can preserve the distinction in
 * diagnostics without widening the answer policy.
 */
export function isPhoneCountrySelector(
  field: Pick<LeverBrowserField, "type" | "label"> & {
    options?: readonly ApplicationFieldOption[];
  },
): boolean {
  return field.type === "select" && looksLikeInternationalDialingOptions(field.options);
}

function optionMatchesCountryLabel(label: string, country: string): boolean {
  const nLabel = normalized(label);
  const nCountry = normalized(country);
  if (!nLabel || !nCountry) return false;
  if (nLabel === nCountry) return true;
  if (nLabel.startsWith(`${nCountry}+`) || nLabel.startsWith(`${nCountry} +`)) return true;
  if (nLabel.endsWith(` - ${nCountry}`) || nLabel.endsWith(`-${nCountry}`) || nLabel.endsWith(` ${nCountry}`)) return true;
  if (nLabel.includes(` - ${nCountry}`)) return true;
  return false;
}

function isAmbiguousYesNoControl(
  field: Pick<LeverBrowserField, "label" | "type">,
): boolean {
  if (field.type !== "radio") return false;
  const label = normalized(field.label);
  return label === "yes" || label === "no";
}

function binaryQuestionClassification(
  field: Pick<LeverBrowserField, "id" | "label" | "section" | "type"> & {
    questionDescriptor?: LeverBrowserField["questionDescriptor"];
  },
): ApplicationFieldClassification | undefined {
  if (!isAmbiguousYesNoControl(field)) return undefined;
  const prompt = directFieldPromptText(field);
  if (hasPhrase(prompt, /work authorization|authorized to work|legally authorized|right to work|eligible to work/)) {
    return "work_authorization";
  }
  if (hasPhrase(prompt, /sponsor|visa|immigration status/)) return "sponsorship";
  return undefined;
}

export function classifyLeverApplicationField(
  field: Pick<LeverBrowserField, "id" | "label" | "section" | "type"> & {
    options?: readonly ApplicationFieldOption[];
    questionDescriptor?: LeverBrowserField["questionDescriptor"];
  },
): ApplicationFieldClassification {
  // Prefer inspected prompt/accessible text over opaque DOM labels (Rippling
  // often exposes "Search" / "textbox" / random ids as the control label).
  // Most generated Yes/No radios expose only the option label as their DOM
  // label. Use the inspected prompt only for the two explicit authorization
  // facts already represented in the profile; arbitrary binary questions stay
  // conservative and human-required.
  const binaryClassification = binaryQuestionClassification(field);
  if (binaryClassification) return binaryClassification;
  const smsConsent = isSmsConsentField(field);
  if (isAgeRequirementField(field)) return "legal_attestation";
  if (isEmploymentScreeningQuestion(field)) return "unknown";
  const text = isAmbiguousYesNoControl(field) && !smsConsent ? fieldText(field) : directFieldPromptText(field);
  const factField = profileFactField(field);
  const compactId = field.id.toLowerCase().replace(/[^a-z0-9]/g, "");
  // Ashby exposes the canonical applicant name control as this exact
  // generated system field. Keep this mapping deliberately narrower than
  // ordinary "name" text so employer/referral/name questions cannot consume
  // the candidate's full name.
  if (field.id.trim().toLowerCase() === "_systemfield_name") return "contact";
  if (compactId.includes("firstname") || compactId.includes("lastname")) return "contact";
  if (isPhoneCountrySelector(field)) return "location";
  if (hasPhrase(text, /resume|résumé|cv|curriculum vitae/)) return "resume_upload";
  // Rippling's native resume dropzone exposes only its accepted extensions
  // ("Drop or select (.doc / .docx / .pdf)") and no Resume/CV text.
  if (field.type === "file" && hasPhrase(text, /drop\s+or\s+select|\.docx?|\.pdf/)) return "resume_upload";
  if (field.type === "file" && hasPhrase(text, /attachment|file upload|upload (?:a )?file|upload (?:a )?document/)) return "resume_upload";
  const genderOptions = field.options?.map((option) => normalized(option.label)).filter(Boolean) ?? [];
  if (hasPhrase(text, /demographic|\bgender\b|transgender|sexual orientation|sexuality|race|ethnicity|hispanic|latino|veteran|disability|voluntary self/) ||
    (genderOptions.includes("male") && genderOptions.includes("female") && genderOptions.some((option) => option === "non-binary" || option === "nonbinary"))) return "demographic";
  if (hasPhrase(text, /how did you hear|how did you learn|where did you hear|how did you discover|(?:job|role|opportunity) source|source of (?:this )?(?:job|role|opportunity)/)) return "unknown";
  if (smsConsent) return "legal_attestation";
  // Referral details are not contact identity. The phrase "first and last
  // name" in a referral prompt must never cause the candidate's own name to
  // be copied into that field.
  if (isReferralField(field)) return "unknown";
  if (hasPhrase(text, /work authorization|authorized to work|legally authorized|right to work|eligible to work/)) return "work_authorization";
  if (isExactAcknowledgmentPrompt(text) || isPrivacyAcknowledgmentPrompt(text)) return "legal_attestation";
  // The visa disclaimer contains sponsorship language but is a legal
  // acknowledgment, not the candidate's sponsorship-required answer.
  if (hasPhrase(text, /sponsor|visa|immigration status/)) return "sponsorship";
  if (hasPhrase(text, /\blegal\b|attest|certif(?:y|ication)|agree to|authorize|terms|accurate and complete|sign your name for acknowledgement/)) return "legal_attestation";
  if (hasPhrase(text, /\bmost interesting problem\b|\byour take\b|\bwhy does it pull you in\b/)) return "free_text";
  if (hasPhrase(text, /\b(?:ai|ml|machine\s+learning|aws|terraform|cloudformation|startup|early[ -]stage|production)\b/)) return "free_text";
  if (hasPhrase(text, /salary|compensation|pay expectation|desired pay|desired annual compensation/)) return "salary";
  if (hasPhrase(text, /relocat/)) return "relocation";
  if (hasPhrase(text, /travel/)) return "travel";
  if (hasPhrase(text, /education|degree|university|college|school|major|study/)) return "education";
  if (hasPhrase(text, /why|interest|motivat|cover letter|tell us|anything else|additional information/)) return "free_text";
  if (factField) return factField;
  if (hasPhrase(text, /employ|employer|company|work history|job history|position held|job title|occupation|start date|end date/)) return "employment_history";
  // Contact (incl. email/e-mail) must win over bare "address" in location (e.g. "Email address").
  if (hasPhrase(text, /first name|given name|last name|family name|surname|full name|your name|applicant name|email|e-mail|phone|telephone|mobile|linkedin|portfolio|website/)) return "contact";
  if (hasPhrase(text, /location|city|state|country|address|postal|zip|phone country|dialing code|country code/)) return "location";
  // Opaque widget labels with a real question prompt are treated by prompt semantics above;
  // remaining long free-response prompts stay free_text rather than unknown.
  const prompt = field.questionDescriptor?.promptText?.trim();
  if (!isAmbiguousYesNoControl(field) && prompt && prompt.length >= 24 && /[?]/.test(prompt)) return "free_text";
  if (field.type === "textarea") return "free_text";
  return "unknown";
}

function descriptor(field: LeverBrowserField): ApplicationFieldDescriptor {
  const id = nonEmpty(field.id) ?? nonEmpty(field.label) ?? "unknown-field";
  const rawLabel = nonEmpty(field.label) ?? id;
  // Rippling's phone-country combobox has no usable question association and
  // exposes only the generic placeholder "Search". Make the safe inferred
  // role visible in inspection evidence while leaving the underlying control
  // identity and option values untouched.
  const label = isPhoneCountrySelector(field) && /^(?:search|select)$/i.test(rawLabel)
    ? "Phone country"
    : rawLabel;
  return {
    id,
    label,
    type: field.type,
    required: field.required,
    ...(field.options && field.options.length > 0 ? { options: field.options.map((option) => ({ ...option })) } : {}),
    ...(field.section ? { section: field.section } : {}),
    ...(field.sourceSelector ? { sourceSelector: field.sourceSelector } : {}),
    ...(field.questionDescriptor ? {
      questionDescriptor: { ...field.questionDescriptor },
    } : {}),
    classification: classifyLeverApplicationField({ ...field, id, label }),
  };
}

function fieldEvidence(field: ApplicationFieldDescriptor, executor = "lever-browser"): string[] {
  return [
    `executor:${executor}`,
    `field-id:${field.id}`,
    `field-type:${field.type}`,
    ...(nonEmpty(field.label) ? [`field-label:${field.label}`] : []),
    `field-required:${field.required}`,
    `classification:${field.classification}`,
    ...(field.options && field.options.length > 0
      ? [`options:${field.options.map((option) => option.label).join("|")}`]
      : []),
    ...(field.section ? [`field-section:${field.section}`] : []),
    ...(field.sourceSelector ? [`field-source-selector:${field.sourceSelector}`] : []),
    ...(field.questionDescriptor?.promptText ? [`question-prompt:${field.questionDescriptor.promptText}`] : []),
    ...(field.questionDescriptor?.sectionTitle ? [`question-section:${field.questionDescriptor.sectionTitle}`] : []),
    ...(field.questionDescriptor ? [`question-source:${field.questionDescriptor.sourceStrategy}`] : []),
    ...(field.questionDescriptor ? [`question-confidence:${field.questionDescriptor.confidence}`] : []),
    ...(field.questionDescriptor?.nearbyInstructionText
      ? [`question-instruction:${field.questionDescriptor.nearbyInstructionText}`]
      : []),
  ];
}

function blockerQuestion(field: ApplicationFieldDescriptor): string {
  const labels = field.options?.map((option) => normalized(option.label)) ?? [];
  const isUnlabeledBinaryRadio = field.type === "radio" &&
    labels.length === 2 &&
    labels.includes("yes") &&
    labels.includes("no") &&
    (normalized(field.label) === "yes" || normalized(field.label) === "no");
  const questionDescriptor = field.questionDescriptor;
  if (field.classification === "unknown" && isUnlabeledBinaryRadio && questionDescriptor?.promptText) {
    if (questionDescriptor.confidence === "high") {
      return questionDescriptor.sectionTitle
        ? `Required question under "${questionDescriptor.sectionTitle}": "${questionDescriptor.promptText}" — choose Yes or No.`
        : `Required application question: "${questionDescriptor.promptText}" — choose Yes or No.`;
    }
    return `Required Yes/No application question. Nearby text may be: "${questionDescriptor.promptText}". Please answer manually.`;
  }
  if (questionDescriptor?.promptText) return questionDescriptor.promptText;
  return isUnlabeledBinaryRadio
    ? `Required yes/no application question (control ${field.id}); the question text was not exposed.`
    : field.label;
}

function blockerKind(
  classification: ApplicationFieldClassification,
): CareerBlockerDraft["kind"] {
  switch (classification) {
    case "salary": return "salary";
    case "sponsorship": return "sponsorship";
    case "relocation": return "relocation";
    case "travel": return "travel";
    case "demographic": return "demographic_disclosure";
    case "legal_attestation": return "legal_attestation";
    case "free_text": return "subjective_answer";
    case "resume_upload": return "resume_missing";
    case "unknown": return "unknown_form_field";
    default: return "unknown_fact";
  }
}

function formBlocker(
  field: ApplicationFieldDescriptor,
  reason: string,
  kind = blockerKind(field.classification),
  questionProvenance: QuestionProvenance = "ATS_FORM",
  executor = "lever-browser",
): CareerBlockerDraft {
  return {
    kind,
    unit: "submission",
    questionProvenance,
    field: field.id,
    question: blockerQuestion(field),
    reason,
    evidence: fieldEvidence(field, executor),
    resumeAfterHuman: true,
  };
}

function boundaryBlocker(boundary: BrowserHumanBoundary, executor = "lever-browser"): CareerBlockerDraft {
  return {
    kind: boundary.kind,
    unit: "external",
    questionProvenance: "POLICY",
    question: boundary.question,
    reason: boundary.reason,
    evidence: [`executor:${executor}`, ...boundary.evidence],
    resumeAfterHuman: true,
  };
}

function postClickBoundaryBlocker(boundary: BrowserHumanBoundary, executor = "lever-browser"): CareerBlockerDraft {
  return {
    kind: boundary.kind,
    unit: "external",
    questionProvenance: "POLICY",
    question: boundary.question,
    reason: boundary.reason,
    evidence: [`executor:${executor}`, "submit:clicked", ...boundary.evidence],
    resumeAfterHuman: false,
  };
}

function inspection(
  status: ExecutionInspection["status"],
  fields: readonly ApplicationFieldDescriptor[],
  startedAt: string,
  updatedAt: string,
  values: {
    fieldsFilled?: readonly string[];
    unresolvedFields?: readonly string[];
    blockers?: readonly CareerBlockerDraft[];
    resumeUsed?: string;
    evidence?: readonly string[];
    durationMs?: number;
    domInspectionCount?: number;
    boundaries?: BrowserExecutionBoundaryState;
    navigation?: BrowserNavigationDiagnostics;
    diagnostic?: BrowserExecutionDiagnostic;
    captcha?: BrowserCaptchaDiagnostics;
  } = {},
): ExecutionInspection {
  return {
    status,
    fields,
    fieldsFilled: values.fieldsFilled ?? [],
    unresolvedFields: values.unresolvedFields ?? [],
    blockers: values.blockers ?? [],
    ...(values.resumeUsed ? { resumeUsed: values.resumeUsed } : {}),
    evidence: values.evidence ?? [],
    ...(values.durationMs !== undefined ? { durationMs: Math.max(0, Math.round(values.durationMs)) } : {}),
    ...(values.domInspectionCount !== undefined ? { domInspectionCount: Math.max(0, Math.round(values.domInspectionCount)) } : {}),
    ...(values.boundaries ? { boundaries: values.boundaries } : {}),
    ...(values.navigation ? { navigation: values.navigation } : {}),
    ...(values.diagnostic ? { diagnostic: values.diagnostic } : {}),
    startedAt,
    updatedAt,
  };
}

function inspectionTelemetry(base: ExecutionInspection | undefined): Pick<
  ExecutionInspection,
  "durationMs" | "domInspectionCount" | "boundaries" | "navigation" | "diagnostic"
  | "captcha"
> {
  return {
    ...(base?.durationMs !== undefined ? { durationMs: base.durationMs } : {}),
    ...(base?.domInspectionCount !== undefined ? { domInspectionCount: base.domInspectionCount } : {}),
    ...(base?.boundaries ? { boundaries: base.boundaries } : {}),
    ...(base?.navigation ? { navigation: base.navigation } : {}),
    ...(base?.diagnostic ? { diagnostic: base.diagnostic } : {}),
    ...(base?.captcha ? { captcha: base.captcha } : {}),
  };
}

function unsupportedResult(
  reason: string,
  startedAt: string,
  now: string,
  blocker?: CareerBlockerDraft,
  base?: ExecutionInspection,
): Extract<ApplicationExecutorResult, { state: "unsupported" }> {
  const inspectionResult = inspection(
    "unsupported",
    base?.fields ?? [],
    base?.startedAt ?? startedAt,
    now,
    {
      ...(blocker ? { blockers: [blocker], unresolvedFields: blocker.field ? [blocker.field] : [] } : {}),
      ...(base ? { fieldsFilled: base.fieldsFilled, unresolvedFields: base.unresolvedFields } : {}),
      ...(base ? inspectionTelemetry(base) : {}),
      evidence: [...(base?.evidence ?? ["executor:lever-browser"]), `unsupported:${reason}`],
    },
  );
  return { state: "unsupported", reason, ...(blocker ? { blocker } : {}), inspection: inspectionResult };
}

function failedResult(
  reason: string,
  startedAt: string,
  now: string,
  observed?: ExecutionInspection,
  retryable = true,
  preSubmit = false,
): Extract<ApplicationExecutorResult, { state: "failed" }> {
  const inspectionResult = observed
    ? { ...observed, status: "failed" as const, updatedAt: now, ...(preSubmit ? { evidence: [...new Set([...observed.evidence, "submit:not-clicked"])] } : {}) }
    : inspection("failed", [], startedAt, now, {
        evidence: ["executor:lever-browser", "execution-failed", ...(preSubmit ? ["submit:not-clicked"] : [])],
      });
  return {
    state: "failed",
    reason,
    retryable,
    inspection: inspectionResult,
  };
}

function isAnswerValuePresent(value: AnswerValue | undefined): value is AnswerValue {
  return value !== undefined && (typeof value !== "string" || value.trim().length > 0);
}

function valueAsString(value: AnswerValue | undefined): string | undefined {
  if (!isAnswerValuePresent(value)) return undefined;
  return typeof value === "string" ? value.trim() : String(value);
}

/**
 * Breezy's numeric salary control rejects currency punctuation (and some
 * deployments expose its committed value without that punctuation). Keep the
 * candidate's authorized amount exact while normalizing only the presentation
 * syntax accepted by a numeric input.
 */
export function normalizeNumericSalaryValue(value: string): string | undefined {
  const compact = value.replace(/\bUSD\b/gi, "").replace(/[\s$,]/g, "").trim();
  return /^\d+(?:\.\d{1,2})?$/.test(compact) ? compact : undefined;
}

export function salaryValuesEqual(expected: string, committed: string): boolean {
  const normalizedExpected = normalizeNumericSalaryValue(expected);
  const normalizedCommitted = normalizeNumericSalaryValue(committed);
  if (!normalizedExpected || !normalizedCommitted) return false;
  const [expectedWhole, expectedFraction = ""] = normalizedExpected.split(".");
  const [committedWhole, committedFraction = ""] = normalizedCommitted.split(".");
  return expectedWhole === committedWhole && expectedFraction.padEnd(2, "0") === committedFraction.padEnd(2, "0");
}

function splitFullName(value: string | undefined): { first?: string; last?: string; full?: string } {
  const full = nonEmpty(value);
  if (!full) return {};
  const parts = full.split(/\s+/);
  return {
    full,
    first: parts[0],
    ...(parts.length > 1 ? { last: parts.slice(1).join(" ") } : {}),
  };
}

function structuredNamePart(field: Pick<LeverBrowserField, "id" | "label" | "section">): "first" | "last" | undefined {
  const compactId = field.id.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (compactId.includes("firstname")) return "first";
  if (compactId.includes("lastname")) return "last";
  const text = fieldText(field);
  if (hasPhrase(text, /\bfirst name\b|\bgiven name\b/)) return "first";
  if (hasPhrase(text, /\blast name\b|\bfamily name\b|\bsurname\b/)) return "last";
  return undefined;
}

function employmentForField(field: ApplicationFieldDescriptor, profile: CandidateProfile | undefined) {
  if (!profile) return undefined;
  const text = fieldText(field);
  if (hasPhrase(text, /\b(?:current|present|most recent)\b.{0,24}\b(?:company|employer)\b/)) {
    return profile.employmentHistory.find((employment) => employment.endDate === null);
  }
  return profile.employmentHistory.length === 1 ? profile.employmentHistory[0] : undefined;
}

function firstEducation(profile: CandidateProfile | undefined) {
  return profile?.education[0];
}

function groundedCountryFromLocation(value: string | null | undefined): string | undefined {
  const location = nonEmpty(value);
  if (!location) return undefined;
  const country = location.split(",").map((part) => part.trim()).filter(Boolean).at(-1);
  if (!country) return undefined;
  if (/^(?:us|u\.s\.?|usa|u\.s\.a\.?|united states|united states of america)$/i.test(country)) {
    return "United States";
  }
  return country;
}

/**
 * Phone-country controls need a country source that does not depend on the
 * candidate's display location. Prefer an explicitly approved phone-country
 * answer, then the international dialing prefix on the verified phone fact.
 * This helper is intentionally limited to the US aliases/prefix currently
 * represented by the profile; it never guesses a country from an area code.
 */
function groundedPhoneCountryFromProfile(profile: CandidateProfile): string | undefined {
  const approved = profile.approvedReusableAnswers.phone_country ??
    profile.approvedReusableAnswers.phone_country_code;
  if (approved && /^(?:\+?1|us|u\.s\.?|usa|u\.s\.a\.?|united states|united states of america)$/i.test(approved.trim())) {
    return "United States";
  }
  if (/^\s*\+1(?:\b|[\s().-])/.test(profile.identity.phone ?? "")) return "United States";
  return undefined;
}

function groundedStateFromLocation(value: string | null | undefined): string | undefined {
  const parts = value?.split(",").map((part) => part.trim()).filter(Boolean) ?? [];
  if (parts.length < 2) return undefined;
  const country = parts.at(-1);
  if (!country || !/^(?:us|u\.s\.?|usa|u\.s\.a\.?|united states|united states of america)$/i.test(country)) {
    return undefined;
  }
  return nonEmpty(parts.at(-2)?.replace(/\b\d{5}(?:-\d{4})?\b/g, "").trim());
}

function groundedCityFromLocation(value: string | null | undefined): string | undefined {
  const parts = value?.split(",").map((part) => part.trim()).filter(Boolean) ?? [];
  if (parts.length < 3) return undefined;
  const country = parts.at(-1);
  const state = parts.at(-2);
  if (!country || !state || !/^(?:us|u\.s\.?|usa|u\.s\.a\.?|united states|united states of america)$/i.test(country)) {
    return undefined;
  }
  const normalizedState = normalized(state);
  if (!US_STATE_ABBREVIATIONS[normalizedState] && !/^[a-z]{2}$/i.test(state)) return undefined;
  return nonEmpty(parts[0]);
}

function groundedPostalFromLocation(value: string | null | undefined): string | undefined {
  return value?.match(/\b\d{5}(?:-\d{4})?\b/)?.[0];
}

const US_STATE_ABBREVIATIONS: Readonly<Record<string, string>> = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca",
  colorado: "co", connecticut: "ct", delaware: "de", florida: "fl", georgia: "ga",
  hawaii: "hi", idaho: "id", illinois: "il", indiana: "in", iowa: "ia",
  kansas: "ks", kentucky: "ky", louisiana: "la", maine: "me", maryland: "md",
  massachusetts: "ma", michigan: "mi", minnesota: "mn", mississippi: "ms",
  missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv", "new hampshire": "nh",
  "new jersey": "nj", "new mexico": "nm", "new york": "ny", "north carolina": "nc",
  "north dakota": "nd", ohio: "oh", oklahoma: "ok", oregon: "or", pennsylvania: "pa",
  "rhode island": "ri", "south carolina": "sc", "south dakota": "sd", tennessee: "tn",
  texas: "tx", utah: "ut", vermont: "vt", virginia: "va", washington: "wa",
  "west virginia": "wv", wisconsin: "wi", wyoming: "wy",
};

function groundedStateEligibilityFromLocation(
  fieldTextValue: string,
  location: string | null | undefined,
): string | undefined {
  const state = groundedStateFromLocation(location);
  if (!state) return undefined;
  const normalizedState = normalized(state);
  const abbreviation = US_STATE_ABBREVIATIONS[normalizedState];
  if (!abbreviation) return undefined;
  const listedCodes: readonly string[] = fieldTextValue.match(/\b[a-z]{2}\b/g) ?? [];
  return listedCodes.includes(abbreviation) || fieldTextValue.includes(normalizedState) ? "Yes" : "No";
}

function groundedWorkAuthorizationValue(
  field: ApplicationFieldDescriptor,
  profile: CandidateProfile,
): AnswerValue | undefined {
  const status = nonEmpty(profile.workAuthorization.status);
  if (!status) return undefined;
  const prompt = inspectedPromptText(field);
  const isUnitedStates = (value: string): boolean =>
    /\bunited states(?: of america)?\b|\bu\.s\.?\b|\busa\b|\bus\b/.test(normalized(value));
  const workCountry = prompt.match(/\bwork in (?:the )?([a-z][a-z .'-]*?)(?:\?|$)/)?.[1]?.trim();
  if (workCountry && !profile.workAuthorization.countries.some((country) =>
    isUnitedStates(workCountry) ? isUnitedStates(country) : normalized(country) === normalized(workCountry))) {
    return undefined;
  }
  const asksUnitedStates = isUnitedStates(prompt);
  if (asksUnitedStates && !profile.workAuthorization.countries.some(isUnitedStates)) {
    return undefined;
  }
  const normalizedStatus = normalized(status);
  const isAffirmative = /^(?:yes|true|authorized|eligible|permitted|lawfully authorized)$/.test(normalizedStatus) ||
    /(?:authorized|eligible|permitted) to work/.test(normalizedStatus);
  if ((field.type === "select" || field.type === "radio" || field.type === "checkbox") && isAffirmative) {
    return field.type === "checkbox" ? true : "Yes";
  }
  return status;
}

function groundedDatePart(value: string | null | undefined, part: "month" | "year"): string | undefined {
  const match = value?.match(/\b(\d{4})[-/]\s*(\d{1,2})\b/);
  if (!match) return undefined;
  if (part === "year") return match[1];
  const month = Number(match[2]);
  if (month < 1 || month > 12) return undefined;
  return ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][month - 1];
}

function answerAliases(classification: ApplicationFieldClassification, text: string): readonly string[] {
  switch (classification) {
    case "salary": return ["salary_expectations"];
    case "sponsorship": return ["sponsorship"];
    case "relocation": return ["relocation"];
    case "travel": return ["travel"];
    case "free_text":
      return hasPhrase(text, /cover letter/) ? ["cover_letter"] : ["why_company", "cover_letter"];
    case "contact":
      if (hasPhrase(text, /email|e-mail/)) return ["email"];
      if (hasPhrase(text, /phone|telephone|mobile/)) return ["phone"];
      if (hasPhrase(text, /location|city|state|country/)) return ["location"];
      return ["name"];
    case "employment_history": return ["employment_history"];
    case "location": return ["location"];
    default: return [];
  }
}

function profileFactAnswerAliases(factField: ProfileFactField): readonly string[] {
  switch (factField) {
    case "linkedin": return ["linkedin", "linkedin_url", "linkedinUrl"];
    case "website": return ["website", "website_url", "websiteUrl", "personal_website"];
    case "desired_work_location": return ["preferred_work_location", "preferredWorkLocation", "desired_work_location"];
    case "start_availability": return ["availability_start_date", "availabilityStartDate", "start_availability", "available_start_date"];
  }
}

function answerForField(
  field: ApplicationFieldDescriptor,
  answers: readonly ApplicationAnswer[],
): ApplicationAnswer | undefined {
  const text = normalized(`${field.id} ${field.label}`);
  const aliases = new Set(answerAliases(field.classification, text));
  const direct = answers.find((answer) => aliases.has(answer.field) &&
    (field.classification !== "free_text" || subjectiveAnswerMatchesPrompt(field, answer)));
  if (direct) return direct;

  // Free-text drafts are question-specific. Once the exact prompt has been
  // inspected, never let loose token matching reuse a generic draft for a
  // different behavioral or personalized employer question.
  if (field.classification === "free_text") return undefined;

  // Consequential categories may only use their exact answer alias (and the
  // resolved blocker path); loose token matching can cross-match unrelated
  // prepared answers such as employment summaries.
  if (["work_authorization", "sponsorship", "salary", "relocation", "travel", "demographic", "legal_attestation"].includes(field.classification)) {
    return undefined;
  }

  const tokens = normalizedTokens(text);
  return answers.find((answer) => {
    const answerText = normalized(`${answer.field} ${answer.question ?? ""}`);
    return tokens.length > 0 && tokens.some((token) => answerText.includes(token));
  });
}

function subjectiveAnswerMatchesPrompt(
  field: ApplicationFieldDescriptor,
  answer: ApplicationAnswer,
): boolean {
  const prompt = normalized(field.questionDescriptor?.promptText ?? field.label);
  const preparedQuestion = normalized(answer.question ?? "");
  if (!prompt) return false;
  if (preparedQuestion && preparedQuestion === prompt) return true;
  if (answer.field === "cover_letter") return /\bcover\s+letter\b/.test(prompt);
  if (answer.field === "why_company") {
    return /\bmost interesting problem\b/.test(prompt) ||
      /why.{0,40}(?:company|work|interested|interests|join)|(?:company|work).{0,40}why/i.test(prompt);
  }
  return false;
}

function blockerEvidenceValue(blocker: CareerBlocker, prefix: string): string | undefined {
  return blocker.evidence.find((item) => item.startsWith(prefix))?.slice(prefix.length).trim() || undefined;
}

/** Do not reuse an explicit answer when the freshly inspected unknown control changed. */
function careerBlockerMatchesField(blocker: CareerBlocker, field: ApplicationFieldDescriptor): boolean {
  if (blocker.kind !== "unknown_form_field") return true;
  const expectedPrompt = blockerEvidenceValue(blocker, "question-prompt:");
  const actualPrompt = field.questionDescriptor?.promptText;
  if (!expectedPrompt || !actualPrompt || normalized(expectedPrompt) !== normalized(actualPrompt)) return false;

  const expectedSection = blockerEvidenceValue(blocker, "question-section:");
  if (expectedSection) {
    const actualSection = field.questionDescriptor?.sectionTitle ?? field.section;
    if (!actualSection || normalized(expectedSection) !== normalized(actualSection)) return false;
  }

  const rawExpectedOptions = blockerEvidenceValue(blocker, "options:");
  if (rawExpectedOptions !== undefined) {
    const expectedOptions = rawExpectedOptions
      .split("|")
      .map((option) => normalized(option))
      .filter(Boolean);
    const actualOptions = field.options?.map((option) => normalized(option.label)).filter(Boolean) ?? [];
    // Greenhouse React comboboxes can expose their option list during the
    // first inspection and hide it until the control is opened on resume.
    // An empty later list is therefore not evidence that the question
    // changed; a different non-empty list still is.
    if (actualOptions.length > 0 &&
      (expectedOptions.length !== actualOptions.length ||
        expectedOptions.some((option) => !actualOptions.includes(option)))) return false;
  }
  return true;
}

function resolvedCareerValue(
  field: ApplicationFieldDescriptor,
  request: ApplicationExecutionRequest,
): AnswerValue | undefined {
  const candidates = request.careerJob.blockers.filter(
    (blocker) => blocker.status === "resolved" && isAnswerValuePresent(blocker.value) &&
      (field.classification !== "unknown" || blocker.kind === "unknown_form_field"),
  );
  const exact = candidates.find((blocker) => blocker.field === field.id);
  if (exact && careerBlockerMatchesField(exact, field)) return exact.value;
  const byQuestion = candidates.find((blocker) => normalized(blocker.question) === normalized(field.label));
  if (byQuestion && careerBlockerMatchesField(byQuestion, field)) return byQuestion.value;

  // Ashby regenerates control ids between sessions. These two narrow semantic
  // bridges reuse only an already-resolved answer for the same inspected
  // option family and employer prompt, never a generic profile fact.
  const optionLabels = field.options?.map((option) => normalized(option.label)).filter(Boolean) ?? [];
  const blockerText = (blocker: CareerBlocker): string => normalized(
    [blocker.question, ...blocker.evidence].filter(Boolean).join(" "),
  );
  if (isPrivacyAcknowledgmentPrompt(directFieldPromptText(field)) && optionLabels.includes("continue")) {
    const privacy = candidates.find((blocker) =>
      normalized(valueAsString(blocker.value)) === "continue" &&
      /\b(?:privacy|personal data|acknowledg)\b/.test(blockerText(blocker)) &&
      /options:continue\b/.test(blockerText(blocker)),
    );
    if (privacy) return privacy.value;
  }
  if (field.classification === "travel" &&
    isOffsiteTravelPrompt(directFieldPromptText(field)) &&
    optionLabels.includes("yes") && optionLabels.includes("no")) {
    const offsite = candidates.find((blocker) =>
      (blocker.kind === "unknown_form_field" || blocker.kind === "travel") &&
      /\boff[- ]?sites?\b|\bworking sessions?\b|\bhackathons?\b/.test(blockerText(blocker)) &&
      (normalized(valueAsString(blocker.value)) === "yes" || normalized(valueAsString(blocker.value)) === "no") &&
      /options:yes\|no\b/.test(blockerText(blocker)),
    );
    if (offsite) return offsite.value;
  }
  return undefined;
}

function usableAnswer(
  answer: ApplicationAnswer | undefined,
  request: ApplicationExecutionRequest,
): { value?: AnswerValue; explicit: boolean } {
  if (!answer || !isAnswerValuePresent(answer.value)) return { explicit: false };
  if (answer.status === "resolved") return { value: answer.value, explicit: true };
  if (
    answer.status === "drafted" &&
    request.campaign.applicationPolicy.allowGroundedDrafts &&
    (answer.provenance?.length ?? 0) > 0 &&
    !answer.provenance?.includes(DETERMINISTIC_DRAFT_PROVENANCE) &&
    answer.policy !== "never_auto"
  ) {
    return { value: answer.value, explicit: false };
  }
  return { explicit: false };
}

function explicitValueForField(
  field: ApplicationFieldDescriptor,
  request: ApplicationExecutionRequest,
): { value?: AnswerValue; explicit: boolean } {
  if (request.profile && isExactAcknowledgmentPrompt(inspectedPromptText(field))) {
    return { value: "I Acknowledge", explicit: true };
  }
  if (request.profile && isSmsConsentField(field)) {
    return { value: "No", explicit: true };
  }
  if (field.classification === "employment_history" &&
    /\b(?:current|present|most recent)\b.{0,24}\b(?:company|employer)\b/.test(fieldText(field))) {
    const approvedCompany = request.profile?.approvedReusableAnswers.current_company?.trim();
    if (approvedCompany) return { value: approvedCompany, explicit: true };
  }
  const fromBlocker = resolvedCareerValue(field, request);
  if (isAnswerValuePresent(fromBlocker)) return { value: fromBlocker, explicit: true };
  if (request.profile && isAgeRequirementField(field)) {
    return { value: "Yes", explicit: true };
  }
  if (request.profile) {
    const ageBracket = approvedAgeBracketValueForField(field, request.profile);
    if (ageBracket) return { value: ageBracket, explicit: true };
    if (field.classification === "demographic" && field.type === "checkbox") {
      const checkboxValueForField = approvedDemographicCheckboxValueForField(field, request.profile);
      if (checkboxValueForField !== undefined) return { value: checkboxValueForField, explicit: true };
    }
    const approvedSource = approvedJobSourceValueForField(field, request.profile);
    if (approvedSource) return { value: approvedSource, explicit: true };
  }
  if (field.classification === "legal_attestation" && request.profile) {
    const acknowledgment = approvedAcknowledgmentValueForField(field, request.profile);
    if (acknowledgment) return { value: acknowledgment, explicit: true };
  }
  if (isBackgroundCheckConsentField(field) && request.profile?.answerPolicies.background_check === "auto") {
    const approved = request.profile.approvedReusableAnswers.background_check?.trim();
    if (approved) return { value: approved, explicit: true };
  }
  if (field.classification === "demographic" && request.profile) {
    const approved = approvedDemographicValueForField(field, request.profile);
    if (approved) return { value: approved, explicit: true };
  }
  const factField = profileFactField(field);
  if (factField) {
    const answer = usableAnswer(
      request.application.answers.find((candidate) => profileFactAnswerAliases(factField).includes(candidate.field)),
      request,
    );
    return answer;
  }
  // A generic preparation `name` answer is a full name and must not override
  // the structured first/last profile mapping on custom application hosts.
  if (field.classification === "contact" && structuredNamePart(field)) return { explicit: false };
  // A generic `name` answer must never be reused for an optional preferred-name
  // field. Only an explicit profile preferredName may fill it automatically.
  if (isPreferredNameField(field)) return { explicit: false };
  // Preparation may contain a full location answer. Country/state controls
  // need the grounded component, not the full city/state string.
  if (field.classification === "location" && looksLikeInternationalDialingOptions(field.options)) {
    // Dialing-code country lists need the grounded country component, not a full city string.
    return { explicit: false };
  }
  if (field.classification === "location" && hasPhrase(inspectedPromptText(field), /\b(?:country|states?)\b/)) {
    return { explicit: false };
  }
  // A generic preparation location answer is not a city, state, postal code,
  // or street address. Those components must come from explicit structured
  // profile/resume data or remain human-required.
  if (field.classification === "location" && hasPhrase(inspectedPromptText(field), /\bcity\b|\bpostal\b|\bzip\b|\baddress\b|\bstreet\b/)) {
    return { explicit: false };
  }
  // Prepared education/employment summaries are not field-level answers. Let
  // the profile record (when present) supply the exact employer/school/date
  // value, and otherwise leave the control for human review.
  if (field.classification === "employment_history" || field.classification === "education") {
    return { explicit: false };
  }
  // The inspected control did not match a known semantic class. Prepared
  // answer token matching is too broad to be safe for such a field.
  if (field.classification === "unknown" && field.questionDescriptor?.promptText) return { explicit: false };
  const answer = usableAnswer(answerForField(field, request.application.answers), request);
  // Greenhouse custom travel comboboxes do not expose their options until
  // opened. Do not send a free-form/stale travel value into an unknown option
  // set; a grounded Yes/No answer remains safe to use.
  if (field.classification === "travel" && (!field.options || field.options.length === 0) &&
    answer.value !== undefined && booleanAnswer(answer.value) === undefined) {
    return { explicit: false };
  }
  return answer;
}

function profileValueForField(
  field: ApplicationFieldDescriptor,
  profile: CandidateProfile | undefined,
): AnswerValue | undefined {
  if (!profile) return undefined;
  const text = fieldText(field);
  const factField = profileFactField(field);
  if (isPreferredNameField(field)) return profile.identity.preferredName ?? undefined;
  if (factField === "linkedin") return profile.identity.linkedinUrl ?? undefined;
  if (factField === "website") return profile.identity.websiteUrl ?? undefined;
  if (factField === "desired_work_location") return profile.workPreferences.preferredWorkLocation ?? undefined;
  if (factField === "start_availability") {
    const availability = profile.workPreferences.availabilityStartDate;
    if (hasPhrase(text, /\byear\b/)) return groundedDatePart(availability, "year");
    if (hasPhrase(text, /\bmonth\b/)) return groundedDatePart(availability, "month");
    return availability ?? undefined;
  }
  const name = splitFullName(profile.identity.fullName ?? undefined);
  if (field.classification === "contact") {
    // Some custom application hosts expose only opaque/stable IDs and render
    // the visible prompt in a non-label element. Prefer those exact identity
    // markers before falling back to the human-readable descriptor so a
    // first/last control can never receive the full name by accident.
    const namePart = structuredNamePart(field);
    if (namePart === "first") return name.first;
    if (namePart === "last") return name.last;
    if (hasPhrase(text, /email|e-mail/)) return profile.identity.email ?? undefined;
    if (hasPhrase(text, /phone|telephone|mobile/)) return profile.identity.phone ?? undefined;
    if (hasPhrase(text, /last name|family name|surname/)) return name.last;
    if (hasPhrase(text, /first name|given name/)) return name.first;
    return name.full;
  }
  if (field.classification === "location") {
    const location = profile.identity.location ?? profile.location;
    if (isPhoneCountrySelector(field)) {
      return groundedPhoneCountryFromProfile(profile) ?? groundedCountryFromLocation(location);
    }
    if (hasPhrase(inspectedPromptText(field), /\bcountry\b|phone country|dialing code|country code/) || hasPhrase(text, /\bcountry\b/)) {
      return groundedCountryFromLocation(location);
    }
    if (hasPhrase(text, /listed states we hire in/)) {
      return groundedStateEligibilityFromLocation(text, location);
    }
    if (hasPhrase(text, /\bstates?\b/)) {
      const state = groundedStateFromLocation(location);
      if (!state) return undefined;
      const normalizedState = normalized(state);
      if (!US_STATE_ABBREVIATIONS[normalizedState] && !/^[a-z]{2}$/i.test(state)) return undefined;
      return field.options && field.options.length > 0
        ? state
        : US_STATE_ABBREVIATIONS[normalizedState] ?? state;
    }
    if (hasPhrase(text, /\bcity\b/)) return groundedCityFromLocation(location);
    if (hasPhrase(text, /\bpostal\b|\bzip\b/)) {
      return profile.identity.postalCode ?? groundedPostalFromLocation(location);
    }
    if (hasPhrase(text, /\baddress\b|\bstreet\b/)) return profile.identity.streetAddress ?? undefined;
    return location ?? undefined;
  }
  if (factField === "desired_work_location") return profile.workPreferences.preferredWorkLocation ?? undefined;
  if (factField === "start_availability") return profile.workPreferences.availabilityStartDate ?? undefined;
  if (field.classification === "employment_history") {
    if (hasPhrase(text, /\b(?:current|present|most recent)\b.{0,24}\b(?:company|employer)\b/)) {
      const approvedCompany = profile.approvedReusableAnswers.current_company?.trim();
      if (approvedCompany) return approvedCompany;
    }
    const employment = employmentForField(field, profile);
    if (!employment) return undefined;
    if (hasPhrase(text, /\bmonth\b/)) {
      return groundedDatePart(hasPhrase(text, /end|to date/) ? employment.endDate : employment.startDate, "month");
    }
    if (hasPhrase(text, /\byear\b/)) {
      return groundedDatePart(hasPhrase(text, /end|to date/) ? employment.endDate : employment.startDate, "year");
    }
    if (hasPhrase(text, /employer|company/)) return employment.employer;
    if (hasPhrase(text, /job title|position|role|occupation/)) return employment.title;
    if (hasPhrase(text, /start date|started|from/)) return employment.startDate;
    if (hasPhrase(text, /end date|ended|to date/)) return employment.endDate ?? undefined;
    return undefined;
  }
  if (field.classification === "education") {
    const education = firstEducation(profile);
    if (!education) return undefined;
    if (hasPhrase(text, /\bmonth\b/)) return groundedDatePart(education.completionDate, "month");
    if (hasPhrase(text, /\byear\b/)) return groundedDatePart(education.completionDate, "year");
    if (hasPhrase(text, /university|college|school|institution/)) return education.institution;
    if (hasPhrase(text, /degree/)) return education.degree;
    if (hasPhrase(text, /major|field|study/)) return education.field ?? undefined;
    if (hasPhrase(text, /completion|graduat/)) return education.completionDate ?? undefined;
    return undefined;
  }
  if (field.classification === "sponsorship") {
    if (profile.workAuthorization.sponsorshipRequired === null) return undefined;
    return profile.workAuthorization.sponsorshipRequired;
  }
  if (field.classification === "work_authorization") return groundedWorkAuthorizationValue(field, profile);
  if (field.classification === "relocation") return profile.workPreferences.relocation ?? undefined;
  if (field.classification === "travel") {
    const value = profile.workPreferences.travel ?? undefined;
    return (!field.options || field.options.length === 0) && booleanAnswer(value) === undefined ? undefined : value;
  }
  return undefined;
}

function optionValue(
  field: ApplicationFieldDescriptor,
  value: AnswerValue,
): string | undefined {
  if (!field.options || field.options.length === 0) return valueAsString(value);
  const desired = normalized(valueAsString(value));
  const desiredAliases = field.classification === "location" && /\bstate\b/.test(fieldText(field))
    ? [
        desired,
        US_STATE_ABBREVIATIONS[desired],
        Object.entries(US_STATE_ABBREVIATIONS).find(([, abbreviation]) => abbreviation === desired)?.[0],
      ].filter((alias): alias is string => Boolean(alias))
    : [desired];
  const booleanAliases = typeof value === "boolean"
    ? value ? ["yes", "true"] : ["no", "false"]
    : [];
  const demographicAliases = field.classification === "demographic"
    ? (() => {
        const candidate = normalized(valueAsString(value));
        if (/not\s+a\s+protected\s+veteran|do\s+not\s+have\s+(?:a\s+)?disability|no\b/.test(candidate)) return ["no", "false"];
        if (/protected\s+veteran|have\s+(?:a\s+)?disability|yes\b/.test(candidate)) return ["yes", "true"];
        return [];
      })()
    : [];
  const demographicTextAliases = field.classification === "demographic"
    ? (() => {
        const candidate = normalized(valueAsString(value));
        if (candidate === "white" || candidate === "caucasian") return ["white", "caucasian"];
        return [];
      })()
    : [];
  const demographicGenderAliases = field.classification === "demographic"
    ? (() => {
        const candidate = normalized(valueAsString(value));
        if (candidate === "male") return ["male", "man"];
        if (candidate === "female") return ["female", "woman"];
        if (candidate === "non-binary" || candidate === "nonbinary") return ["non-binary", "nonbinary"];
        return [];
      })()
    : [];
  const smsAliases = isSmsConsentField(field) && desired === "no"
    ? ["no", "false"]
    : [];
  const matches = field.options.filter((candidate) => {
    const labels = [normalized(candidate.value), normalized(candidate.label)];
    const rawLabels = [candidate.value, candidate.label];
    return desiredAliases.some((alias) => labels.includes(alias)) ||
      demographicAliases.some((alias) => labels.includes(alias)) ||
      demographicTextAliases.some((alias) => labels.some((label) => label === alias || label.startsWith(`${alias} `) || label.includes(`/${alias}`))) ||
      demographicGenderAliases.some((alias) => labels.includes(alias)) ||
      smsAliases.some((alias) => labels.includes(alias)) ||
      (demographicAliases.includes("no") && labels.some((label) => /not\s+(?:a\s+)?protected\s+veteran|do\s+not\s+have\s+(?:a\s+)?disability/.test(label))) ||
      // Greenhouse's phone-country control appends the dialing code to the
      // grounded country name (for example, "United States +1"). Preserve
      // exact option selection while accepting that display form.
      labels.some((label) => desiredAliases.some((alias) =>
        label.startsWith(`${alias}+`) || label.startsWith(`${alias} +`))) ||
      // Rippling dialing lists look like "+1 US - United States".
      rawLabels.some((label) => desiredAliases.some((alias) => optionMatchesCountryLabel(label, alias))) ||
      booleanAliases.some((alias) => labels.includes(alias));
  });
  // Ashby native radios frequently give every option the same value (`on`).
  // Returning that opaque value lets the browser click the first radio in the
  // group. Return the unique semantic label instead, and fail closed when the
  // answer still maps to more than one option.
  if (matches.length === 0 && looksLikeInternationalDialingOptions(field.options)) {
    const query = valueAsString(value);
    return query || undefined;
  }
  if (matches.length !== 1) return undefined;
  const option = matches[0];
  const valueIsDuplicated = field.options.filter((candidate) =>
    normalized(candidate.value) === normalized(option.value),
  ).length > 1;
  if (option?.value) return valueIsDuplicated || normalized(option.value) === "on" ? option.label : option.value;
  // Rippling phone-country Search widgets often expose only a virtualized
  // slice of dialing options during inspection. When the grounded country is
  // missing from that sample, return it as a typeahead query so the browser
  // session can filter and commit the real option.
  if (looksLikeInternationalDialingOptions(field.options)) {
    const query = valueAsString(value);
    return query || undefined;
  }
  return undefined;
}

function checkboxValue(value: AnswerValue | undefined): boolean | undefined {
  if (typeof value === "boolean") return value;
  const text = normalized(valueAsString(value));
  if (text === "yes" || text === "true") return true;
  if (text === "no" || text === "false") return false;
  return undefined;
}

function booleanAnswer(value: AnswerValue | undefined): boolean | undefined {
  if (typeof value === "boolean") return value;
  const text = normalized(valueAsString(value));
  if (text === "yes" || text === "true") return true;
  if (text === "no" || text === "false") return false;
  return undefined;
}

function missingFieldDecision(
  field: ApplicationFieldDescriptor,
  reason: string,
  kind?: CareerBlockerDraft["kind"],
  executor = "lever-browser",
): FieldDecision {
  if (!field.required) return { explicit: false, leaveUntouched: true };
  return { explicit: false, blocker: formBlocker(field, reason, kind, "ATS_FORM", executor) };
}

function decisionForField(
  field: ApplicationFieldDescriptor,
  request: ApplicationExecutionRequest,
  resumePath: string | undefined,
  executor = "lever-browser",
): FieldDecision {
  const explicit = explicitValueForField(field, request);
  const profileValue = profileValueForField(field, request.profile);
  const supplied = explicit.value !== undefined ? explicit : { value: profileValue, explicit: false };
  const text = fieldText(field);

  if (!SUPPORTED_FIELD_TYPES.has(field.type)) {
    return field.required
      ? { explicit: false, blocker: formBlocker(field, "This required field uses a widget the executor does not safely support.", "unsupported_widget", "ATS_FORM", executor) }
      : { explicit: false, leaveUntouched: true };
  }

  if (field.classification === "demographic") {
    if (!explicit.explicit) {
      return { explicit: false, blocker: formBlocker(field, "Demographic disclosures require an explicit stable value or user response; none is available.", "demographic_disclosure", "ATS_FORM", executor) };
    }
  }

  if (field.classification === "legal_attestation") {
    if (!explicit.explicit) {
      return field.required
        ? { explicit: false, blocker: formBlocker(field, "A legal or certification commitment requires human review before it can be accepted.", "legal_attestation", "ATS_FORM", executor) }
        : { explicit: false, leaveUntouched: true };
    }
  }

  if (field.classification === "resume_upload") {
    if (!resumePath) {
      return missingFieldDecision(field, "The selected resume family has no local resume artifact configured.", "resume_missing", executor);
    }
    return { value: resumePath, explicit: true };
  }

  if (supplied.value === undefined) {
    if (isReferralField(field)) {
      return missingFieldDecision(
        field,
        "Referral details require a human answer; the candidate's own name must not be guessed.",
        "unknown_form_field",
        executor,
      );
    }
    const kind = field.classification === "free_text"
      ? "subjective_answer"
      : field.classification === "unknown"
        ? "unknown_form_field"
        : undefined;
    return missingFieldDecision(
      field,
      field.classification === "free_text"
        ? "No grounded prepared answer is available for this subjective question."
        : field.classification === "unknown"
          ? "The field could not be classified safely; no value was guessed."
          : "No verified profile fact or explicitly resolved answer is available.",
      kind,
      executor,
    );
  }

  if (field.type === "checkbox") {
    const checked = checkboxValue(supplied.value);
    if (checked === undefined) {
      return field.required
        ? { explicit: false, blocker: formBlocker(field, "The checkbox value is not an explicit boolean answer.", "unknown_form_field", "ATS_FORM", executor) }
        : { explicit: false, leaveUntouched: true };
    }
    return { value: checked, explicit: supplied.explicit };
  }

  if (field.type === "select" || field.type === "radio") {
    const selected = optionValue(field, supplied.value);
    if (!selected) {
      return field.required
        ? {
            explicit: false,
            blocker: formBlocker(field, "The verified answer does not exactly match one of the provider's available options.", "unknown_form_field", "ATS_FORM", executor),
          }
        : { explicit: false, leaveUntouched: true };
    }
    return { value: selected, explicit: supplied.explicit };
  }

  if (field.classification === "unknown" && !field.required) {
    return { explicit: false, leaveUntouched: true };
  }

  const stringValue = valueAsString(supplied.value);
  if (!stringValue) {
    return missingFieldDecision(field, "The verified value was empty; no replacement was invented.", undefined, executor);
  }
  return { value: stringValue, explicit: supplied.explicit };
}

function meaningfulCurrentValue(value: string | boolean | null | undefined): boolean {
  return typeof value === "boolean"
    ? value
    : value !== null && value !== undefined && value.trim().length > 0;
}

/** Rippling div comboboxes expose their unanswered state as visible text
 * rather than an empty value. Treat only exact placeholder-only phrases as
 * empty; a real unmatched value must still trigger the fail-closed blocker. */
function isUnansweredCustomSelectValue(
  field: ApplicationFieldDescriptor,
  value: string | boolean | null | undefined,
): boolean {
  if ((field.type !== "select" && field.type !== "radio") || typeof value !== "string") return false;
  const normalizedValue = value
    .replace(/[.…]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  // Rippling's phone-country combobox uses its generic `Search` placeholder
  // as the visible value before a country is chosen.  Treat that placeholder
  // as empty only for the positively identified dialing-code selector; other
  // Search selects may contain a real, user-entered value and must remain
  // fail-closed.
  if (normalizedValue === "search" && isPhoneCountrySelector(field)) return true;
  return new Set([
    "select",
    "select one",
    "select an option",
    "please select",
    "please select one",
    "please select an option",
    "choose",
    "choose one",
    "choose an option",
    "please choose",
    "please choose one",
    "please choose an option",
    "no answer",
  ]).has(normalizedValue);
}

/** Ashby can render a committed location with a country alias different from
 * the inspected option snapshot (for example `USA` vs `United States`).
 * Accept that alias only when the current value and exactly one inspected
 * option both match the same fully grounded profile location. */
function groundedLocationValueMatches(
  current: string,
  options: readonly ApplicationFieldOption[],
  groundedLocation: string,
): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
  const aliases: Readonly<Record<string, readonly string[]>> = {
    us: ["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america"],
    usa: ["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america"],
    "u.s.": ["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america"],
    "u.s.a.": ["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america"],
    "united states": ["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america"],
    "united states of america": ["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america"],
  };
  const parts = (value: string): string[] => value.split(",").map(normalize).filter(Boolean);
  const grounded = parts(groundedLocation);
  const sameGroundedPlace = (candidate: string): boolean => {
    const candidateParts = parts(candidate);
    if (grounded.length < 2 || candidateParts.length < 2 || candidateParts[0] !== grounded[0]) return false;
    return grounded.slice(1).every((part, index) => {
      const candidatePart = candidateParts[index + 1];
      if (!candidatePart) return false;
      if (normalize(part) === normalize(candidatePart)) return true;
      return (aliases[normalize(part)] ?? [normalize(part)]).includes(normalize(candidatePart));
    });
  };
  if (!sameGroundedPlace(current)) return false;
  const matchingOptions = options.filter((option) => sameGroundedPlace(option.label) || sameGroundedPlace(option.value));
  return matchingOptions.length === 1;
}

function groundedLocationStringsMatch(current: string, groundedLocation: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
  const aliases: Readonly<Record<string, readonly string[]>> = {
    us: ["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america"],
    usa: ["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america"],
    "u.s.": ["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america"],
    "u.s.a.": ["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america"],
    "united states": ["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america"],
    "united states of america": ["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america"],
  };
  const parts = (value: string) => value.split(",").map(normalize).filter(Boolean);
  const grounded = parts(groundedLocation);
  const currentParts = parts(current);
  if (grounded.length < 2 || currentParts.length < 2 || currentParts[0] !== grounded[0]) return false;
  return grounded.slice(1).every((part, index) => {
    const candidate = currentParts[index + 1];
    if (!candidate) return false;
    return normalize(part) === candidate || (aliases[normalize(part)] ?? [normalize(part)]).includes(candidate);
  });
}

/** Existing select/radio values are trusted only when one exact inspected
 * option (or exactly one checkbox checked state) verifies them. */
function verifiedCommittedCurrentValue(
  field: ApplicationFieldDescriptor,
  current: string | boolean | null | undefined,
  groundedLocation?: string,
): boolean {
  if (field.type === "checkbox") return current === true;
  if (field.type !== "select" && field.type !== "radio") return meaningfulCurrentValue(current);
  if (typeof current !== "string" || !current.trim() || !field.options?.length) return false;
  const value = normalized(current);
  const matches = field.options.filter((option) =>
    normalized(option.value) === value || normalized(option.label) === value,
  );
  const distinctMatches = new Set(matches.map((option) => `${normalized(option.value)}\u0000${normalized(option.label)}`));
  if (distinctMatches.size === 1) return true;
  if (field.classification === "location" && groundedLocation &&
    groundedLocationValueMatches(current, field.options, groundedLocation)) return true;
  if (!isPhoneCountrySelector(field) || !groundedLocation) return false;
  const country = groundedCountryFromLocation(groundedLocation);
  if (!country) return false;
  const countryOptions = field.options.filter((option) =>
    optionMatchesCountryLabel(option.label, country) || optionMatchesCountryLabel(option.value, country),
  );
  if (countryOptions.length !== 1) return false;
  const countryAliases = /^(?:us|u\.s\.?|usa|u\.s\.a\.?|united states|united states of america)$/i.test(country)
    ? new Set(["us", "usa", "united states", "united states of america"])
    : new Set([normalized(country)]);
  return countryAliases.has(value) ||
    (country === "United States" && /^(?:\+1\b|\+1\s+us\b|us\s*-?\s*united states\b)/i.test(current.trim())) ||
    normalized(countryOptions[0]!.value) === value ||
    normalized(countryOptions[0]!.label) === value;
}

function providerLabel(provider: TrustedTarget["provider"]): string {
  if (provider === "generic") return "direct application";
  if (provider === "greenhouse") return "Greenhouse";
  if (provider === "rippling") return "Rippling";
  if (provider === "ashby") return "Ashby";
  if (provider === "workday") return "Workday";
  if (provider === "youhired") return "YouHired";
  if (provider === "matlensilver") return "Matlen Silver";
  if (provider === "protagona") return "Protagona";
  if (provider === "gusto") return "Gusto";
  return "Lever";
}

function executorEvidenceLabel(provider: TrustedTarget["provider"]): string {
  if (provider === "generic") return "page-first-browser";
  if (provider === "greenhouse") return "greenhouse-browser";
  if (provider === "rippling") return "rippling-browser";
  if (provider === "ashby") return "ashby-browser";
  if (provider === "workday") return "workday-browser";
  if (provider === "youhired") return "youhired-browser";
  if (provider === "matlensilver") return "matlen-browser";
  if (provider === "protagona") return "protagona-browser";
  if (provider === "gusto") return "gusto-browser";
  return "lever-browser";
}

function sameApplicationPage(value: string, target: TrustedTarget): boolean {
  try {
    const url = new URL(value);
    if (target.provider === "generic") {
      return url.protocol === "https:" && url.toString() === new URL(target.applicationUrl).toString();
    }
    if (target.provider === "greenhouse") {
      return url.protocol === "https:" && isVerifiedGreenhouseApplicationUrl(url.toString(), target.site, target.postingId ?? "");
    }
    if (target.provider === "rippling") {
      return url.protocol === "https:" && isVerifiedRipplingApplicationUrl(url.toString()) &&
        classifyJobUrl(url.toString()).siteIdentifier === target.site &&
        classifyJobUrl(url.toString()).postingIdentifier === target.postingId &&
        url.pathname.endsWith("/apply");
    }
    if (target.provider === "ashby") {
      return url.protocol === "https:" && isVerifiedAshbyApplicationUrl(
        url.toString(),
        target.site,
        target.postingId,
      );
    }
    if (target.provider === "workday") {
      return url.protocol === "https:" && isVerifiedWorkdayApplicationUrl(url.toString(), target.site) &&
        workdayPostingId(url.toString()) === target.postingId;
    }
    if (target.provider === "youhired") {
      return url.protocol === "https:" && isVerifiedYouHiredApplicationUrl(url.toString()) &&
        youHiredPostingId(url.toString()) === target.postingId;
    }
    if (target.provider === "matlensilver") {
      return url.protocol === "https:" && isVerifiedMatlenApplicationUrl(url.toString()) &&
        matlenPostingId(url.toString()) === target.postingId;
    }
    if (target.provider === "protagona") {
      return url.protocol === "https:" && isVerifiedProtagonaApplicationUrl(url.toString()) &&
        protagonaPostingId(url.toString()) === target.postingId;
    }
    if (target.provider === "gusto") {
      return url.protocol === "https:" && isVerifiedGustoApplicationUrl(url.toString()) &&
        gustoPostingId(url.toString()) === target.postingId;
    }
    return url.protocol === "https:" && isVerifiedLeverApplicationUrl(url.toString(), target.site, target.postingId ?? "");
  } catch {
    return false;
  }
}

/** Automatic proof requires a provider-owned confirmation route, not generic text. */
export function isTrustedAutomaticConfirmation(
  result: BrowserSubmissionResult,
  target: Pick<TrustedTarget, "provider" | "applicationUrl" | "postingId">,
): boolean {
  if (!result.confirmed || !result.externalApplicationId || !result.confirmationOrigin || !result.confirmationUrl || !target.postingId) return false;
  let expected: URL;
  let observed: URL;
  try {
    expected = new URL(target.applicationUrl);
    observed = new URL(result.confirmationUrl);
  } catch {
    return false;
  }
  if (observed.origin !== expected.origin || result.confirmationOrigin !== observed.origin || !/confirmation|success|thank[-_]?you/i.test(observed.pathname)) return false;
  const decodedSegments = observed.pathname.split("/").filter(Boolean).map((segment) => {
    try { return decodeURIComponent(segment); } catch { return ""; }
  });
  const correlationKeys = new Set(["job", "jobId", "posting", "postingId", "gh_jid", "lever_job_id"]);
  const correlatedQuery = [...observed.searchParams.entries()].some(([key, value]) =>
    correlationKeys.has(key) && value === target.postingId,
  );
  if (!decodedSegments.includes(target.postingId) && !correlatedQuery) return false;
  if (!result.evidence.includes("submit:clicked; confirmation:url")) return false;
  const providerHost = observed.hostname.toLowerCase();
  if (target.provider === "ashby" && !providerHost.endsWith("ashbyhq.com")) return false;
  if (target.provider === "lever" && !providerHost.endsWith("lever.co")) return false;
  if (target.provider === "greenhouse" && !/(?:greenhouse.io|greenhouse.com)$/.test(providerHost)) return false;
  return true;
}

function trustedTarget(
  request: ApplicationExecutionRequest,
  configuredProvider: LeverBrowserExecutorOptions["provider"] = "lever",
): { target?: TrustedTarget; reason?: string } {
  const job = request.careerJob;
  const posting = job.job;
  if (job.sourceMode !== "live") return { reason: "The executor requires explicit live source provenance." };
  if (job.actionability !== "actionable") return { reason: "The posting is discovery-only and has no verified application endpoint." };
  if (!posting.applicationUrl || !posting.sourceUrl) return { reason: "The posting is missing a verified hosted or application URL." };
  if (request.application.job.applicationUrl !== posting.applicationUrl || request.application.job.sourceUrl !== posting.sourceUrl) {
    return { reason: "The application packet provenance does not match the career posting." };
  }
  try {
    const applicationUrl = new URL(posting.applicationUrl);
    if (applicationUrl.protocol !== "https:") return { reason: "The application URL is not HTTPS." };
  } catch {
    return { reason: "The application URL is not syntactically valid." };
  }

  const sourceId = typeof job.sourceId === "string" ? job.sourceId : "";
  const destination = classifyJobUrl(posting.applicationUrl);
  const provider = configuredProvider === "auto"
    ? sourceId.startsWith("lever:") ? "lever" :
      destination.kind === "lever" ? "lever" :
      destination.kind === "greenhouse" ? "greenhouse" :
      destination.kind === "rippling" ? "rippling" :
      destination.kind === "ashby" ? "ashby" :
      destination.kind === "workday" ? "workday" :
      isVerifiedYouHiredApplicationUrl(posting.applicationUrl) ? "youhired" :
      isVerifiedMatlenApplicationUrl(posting.applicationUrl) ? "matlensilver" :
      isVerifiedProtagonaApplicationUrl(posting.applicationUrl) ? "protagona" :
      isVerifiedGustoApplicationUrl(posting.applicationUrl) ? "gusto" :
      job.destinationResolution?.status === "resolved" && job.destinationResolution.actionable === true ? "generic" : undefined
    : configuredProvider;

  if (provider === "lever") {
    if (sourceId.startsWith("lever:")) {
      if (!job.sourceRecordId) return { reason: "The Lever provider posting ID is missing." };
      const rawSite = sourceId.slice("lever:".length).trim();
      if (!rawSite) return { reason: "The Lever SITE identifier is missing from source provenance." };
      let site: string;
      try {
        site = leverSourceId(rawSite).slice("lever:".length);
      } catch {
        return { reason: "The Lever SITE identifier is invalid." };
      }
      if (!isVerifiedLeverHostedUrl(posting.sourceUrl, site, job.sourceRecordId)) {
        return { reason: "The posting URL is not the verified Lever hosted page for this provider ID." };
      }
      if (!isVerifiedLeverApplicationUrl(posting.applicationUrl, site, job.sourceRecordId)) {
        return { reason: "The application URL is not the verified Lever /apply path for this provider ID." };
      }
      return { target: { provider, site, postingId: job.sourceRecordId, applicationUrl: posting.applicationUrl } };
    }
    if (destination.kind !== "lever" || !destination.siteIdentifier || !destination.postingIdentifier ||
      !isVerifiedLeverHostedUrl(posting.sourceUrl, destination.siteIdentifier, destination.postingIdentifier) ||
      !isVerifiedLeverApplicationUrl(posting.applicationUrl, destination.siteIdentifier, destination.postingIdentifier)) {
      return { reason: "The application does not have a verified Lever posting and application pair." };
    }
    const resolution = job.destinationResolution;
    const destinationMatches = resolution?.status === "resolved" &&
      resolution.actionable === true &&
      resolution.ats === "Lever" &&
      resolution.destinationUrl === posting.applicationUrl;
    const directLeverSource = Boolean(job.sourceRecordId) &&
      job.sourceRecordId === destination.postingIdentifier;
    if (!destinationMatches && !directLeverSource) {
      return { reason: "The Lever destination is not independently verified for this posting." };
    }
    return {
      target: {
        provider,
        site: destination.siteIdentifier,
        postingId: destination.postingIdentifier,
        applicationUrl: posting.applicationUrl,
      },
    };
  }

  if (provider === "greenhouse") {
    if (destination.kind !== "greenhouse" || !destination.siteIdentifier || !destination.postingIdentifier) {
      return { reason: "The application URL is not a verified Greenhouse application route." };
    }
    const curatedGreenhouse = sourceId === "curated-live";
    if ((curatedGreenhouse && !isVerifiedGreenhouseHostedUrl(posting.sourceUrl, destination.siteIdentifier, destination.postingIdentifier)) ||
      !isVerifiedGreenhouseApplicationUrl(posting.applicationUrl, destination.siteIdentifier, destination.postingIdentifier)) {
      return { reason: "The Greenhouse source and application URLs are not the same verified posting." };
    }
    if (!curatedGreenhouse && !job.destinationResolution && !sourceId.startsWith("greenhouse:")) {
      return { reason: "The Greenhouse destination is not independently verified for this posting." };
    }
    const expectedSourceRecordId = curatedGreenhouse
      ? `greenhouse:${destination.siteIdentifier}:${destination.postingIdentifier}`
      : sourceId.startsWith("greenhouse:") ? destination.postingIdentifier : undefined;
    if (expectedSourceRecordId !== undefined && job.sourceRecordId !== expectedSourceRecordId) {
      return { reason: "The Greenhouse source provenance does not match the verified posting identity." };
    }
    return {
      target: {
        provider,
        site: destination.siteIdentifier,
        postingId: destination.postingIdentifier,
        applicationUrl: posting.applicationUrl,
      },
    };
  }

  if (provider === "generic") {
    const resolution = job.destinationResolution;
    if (resolution?.status !== "resolved" || resolution.actionable !== true || resolution.ats !== "Custom" || resolution.provenance !== "official_employer_evidence" || resolution.destinationUrl !== posting.applicationUrl) {
      return { reason: "The direct application destination is not independently verified." };
    }
    return { target: { provider, site: new URL(posting.applicationUrl).hostname, applicationUrl: posting.applicationUrl } };
  }

  if (provider === "rippling") {
    if (destination.kind !== "rippling" || !destination.siteIdentifier || !destination.postingIdentifier) {
      return { reason: "The application URL is not a verified Rippling application route." };
    }
    const resolution = job.destinationResolution;
    const destinationMatches = resolution?.status === "resolved" &&
      resolution.actionable === true &&
      resolution.ats === "Rippling" &&
      (resolution.destinationUrl === posting.applicationUrl ||
        ripplingApplicationUrl(resolution.destinationUrl) === ripplingApplicationUrl(posting.applicationUrl));
    const directRipplingSource = Boolean(job.sourceRecordId) &&
      job.sourceRecordId === `${destination.siteIdentifier}:${destination.postingIdentifier}` &&
      isVerifiedRipplingHostedUrl(posting.sourceUrl, destination.siteIdentifier, destination.postingIdentifier);
    const directRipplingApplication = directRipplingSource &&
      isVerifiedRipplingApplicationUrl(posting.applicationUrl, destination.siteIdentifier, destination.postingIdentifier);
    if (!destinationMatches && !directRipplingApplication) {
      return { reason: "The Rippling destination is not independently verified for this posting." };
    }
    const formUrl = ripplingApplicationUrl(posting.applicationUrl);
    if (!formUrl) return { reason: "The Rippling application form route could not be derived safely." };
    return {
      target: {
        provider,
        site: destination.siteIdentifier,
        postingId: destination.postingIdentifier,
        applicationUrl: formUrl,
      },
    };
  }

  if (provider === "ashby") {
    if (destination.kind !== "ashby" || !destination.siteIdentifier || !destination.postingIdentifier) {
      return { reason: "The application URL is not a verified Ashby application route." };
    }
    if (!isVerifiedAshbyHostedUrl(
      posting.sourceUrl,
      destination.siteIdentifier,
      destination.postingIdentifier,
    ) || !isVerifiedAshbyApplicationUrl(
      posting.applicationUrl,
      destination.siteIdentifier,
      destination.postingIdentifier,
    )) {
      return { reason: "The posting and application URLs are not a verified Ashby pair." };
    }
    const resolution = job.destinationResolution;
    const destinationMatches = resolution?.status === "resolved" &&
      resolution.actionable === true &&
      resolution.ats === "Ashby" &&
      resolution.destinationUrl === posting.applicationUrl;
    const directAshbySource = Boolean(job.sourceRecordId) &&
      job.sourceRecordId === `${destination.siteIdentifier}:${destination.postingIdentifier}`;
    if (!destinationMatches && !directAshbySource) {
      return { reason: "The Ashby destination is not independently verified for this posting." };
    }
    return {
      target: {
        provider,
        site: destination.siteIdentifier,
        postingId: destination.postingIdentifier,
        applicationUrl: posting.applicationUrl,
      },
    };
  }

  if (provider === "workday") {
    if (destination.kind !== "workday" || !destination.siteIdentifier ||
      !isVerifiedWorkdayApplicationUrl(posting.applicationUrl, destination.siteIdentifier)) {
      return { reason: "The application URL is not a verified Workday application route." };
    }
    const postingId = workdayPostingId(posting.applicationUrl);
    if (!postingId || !isVerifiedWorkdayHostedUrl(posting.sourceUrl, destination.siteIdentifier) ||
      workdayPostingId(posting.sourceUrl) !== postingId) {
      return { reason: "The Workday source and application URLs are not the same verified posting." };
    }
    const resolution = job.destinationResolution;
    const destinationMatches = resolution?.status === "resolved" &&
      resolution.actionable === true &&
      resolution.ats === "Workday" &&
      resolution.destinationUrl === posting.applicationUrl &&
      workdayPostingId(resolution.destinationUrl) === postingId;
    if (!destinationMatches) {
      return { reason: "The Workday destination is not independently verified for this posting." };
    }
    return {
      target: {
        provider,
        site: destination.siteIdentifier,
        postingId,
        applicationUrl: posting.applicationUrl,
      },
    };
  }

  if (provider === "youhired") {
    if (!isVerifiedYouHiredApplicationUrl(posting.applicationUrl)) {
      return { reason: "The application URL is not a verified YouHired job route." };
    }
    const postingId = youHiredPostingId(posting.applicationUrl);
    if (!postingId || posting.sourceUrl !== posting.applicationUrl) {
      return { reason: "The YouHired source and application URL must be the same verified job route." };
    }
    const resolution = job.destinationResolution;
    const destinationMatches = resolution?.status === "resolved" &&
      resolution.actionable === true &&
      resolution.ats === "Custom" &&
      resolution.destinationUrl === posting.applicationUrl;
    const directCuratedSource = sourceId === "curated-live" && job.sourceRecordId === `youhired:${postingId}`;
    if (!destinationMatches && !directCuratedSource) {
      return { reason: "The YouHired destination is not independently verified for this posting." };
    }
    return {
      target: {
        provider,
        site: "youhired.me",
        postingId,
        applicationUrl: posting.applicationUrl,
      },
    };
  }

  if (provider === "matlensilver") {
    if (!isVerifiedMatlenApplicationUrl(posting.applicationUrl)) {
      return { reason: "The application URL is not a verified Matlen Silver job route." };
    }
    const postingId = matlenPostingId(posting.applicationUrl);
    if (!postingId || posting.sourceUrl !== posting.applicationUrl) {
      return { reason: "The Matlen Silver source and application URL must be the same verified job route." };
    }
    const resolution = job.destinationResolution;
    const destinationMatches = resolution?.status === "resolved" &&
      resolution.actionable === true &&
      resolution.ats === "Custom" &&
      resolution.destinationUrl === posting.applicationUrl;
    const directCuratedSource = sourceId === "curated-live" && job.sourceRecordId === `matlensilver:${postingId}`;
    if (!destinationMatches && !directCuratedSource) {
      return { reason: "The Matlen Silver destination is not independently verified for this posting." };
    }
    return {
      target: {
        provider,
        site: "matlensilver.com",
        postingId,
        applicationUrl: posting.applicationUrl,
      },
    };
  }

  if (provider === "protagona") {
    if (!isVerifiedProtagonaApplicationUrl(posting.applicationUrl)) {
      return { reason: "The application URL is not the verified Protagona AWS Cloud Engineer route." };
    }
    const postingId = protagonaPostingId(posting.applicationUrl);
    if (!postingId || posting.sourceUrl !== posting.applicationUrl) {
      return { reason: "The Protagona source and application URL must be the same verified job route." };
    }
    const resolution = job.destinationResolution;
    const destinationMatches = resolution?.status === "resolved" &&
      resolution.actionable === true &&
      resolution.ats === "Custom" &&
      resolution.destinationUrl === posting.applicationUrl;
    const directCuratedSource = sourceId === "curated-live" && job.sourceRecordId === `protagona:${postingId}`;
    if (!destinationMatches && !directCuratedSource) {
      return { reason: "The Protagona destination is not independently verified for this posting." };
    }
    return {
      target: {
        provider,
        site: "protagona.applytojob.com",
        postingId,
        applicationUrl: posting.applicationUrl,
      },
    };
  }

  if (provider === "gusto") {
    const postingId = gustoPostingId(posting.applicationUrl);
    if (!postingId || !isVerifiedGustoApplicationUrl(posting.applicationUrl) || !isVerifiedGustoHostedUrl(posting.sourceUrl)) {
      return { reason: "The application URL is not the verified Gusto application route." };
    }
    if (gustoPostingId(posting.sourceUrl) !== postingId) {
      return { reason: "The Gusto posting and application URLs do not match the same verified posting." };
    }
    const resolution = job.destinationResolution;
    const destinationMatches = resolution?.status === "resolved" &&
      resolution.actionable === true &&
      resolution.ats === "Custom" &&
      resolution.destinationUrl === posting.applicationUrl;
    const directCuratedSource = sourceId === "curated-live" && job.sourceRecordId === `gusto:${postingId}`;
    if (!destinationMatches && !directCuratedSource) {
      return { reason: "The Gusto destination is not independently verified for this posting." };
    }
    return {
      target: {
        provider,
        site: "jobs.gusto.com",
        postingId,
        applicationUrl: posting.applicationUrl,
      },
    };
  }

  return { reason: "No supported browser executor is configured for this application destination." };
}

/**
 * Browser-neutral Lever execution policy. The concrete browser implementation
 * only supplies a small session/field surface; this class owns trust checks,
 * grounded mapping, blockers, and the closed Submit lane.
 */
export class LeverBrowserExecutor implements ApplicationExecutor {
  public readonly id: string;
  private readonly sessions = new Map<string, SessionState>();
  private readonly now: () => string;

  constructor(private readonly options: LeverBrowserExecutorOptions) {
    this.now = options.now ?? defaultNow;
    this.id = options.provider === "auto" ? "application-browser-executor" :
      options.provider === "greenhouse" ? "greenhouse-browser-executor" :
        options.provider === "rippling" ? "rippling-browser-executor" :
        options.provider === "ashby" ? "ashby-browser-executor" :
            options.provider === "workday" ? "workday-browser-executor" :
              options.provider === "youhired" ? "youhired-browser-executor" :
              options.provider === "matlensilver" ? "matlen-browser-executor" :
              options.provider === "protagona" ? "protagona-browser-executor" :
                  options.provider === "gusto" ? "gusto-browser-executor" :
                    options.provider === "generic" ? "page-first-browser-executor" : "lever-browser-executor";
  }

  executionMode(request: ApplicationExecutionRequest): ApplicationExecutorMode {
    return this.options.allowAutomaticSubmission === true &&
      request.campaign.submissionPolicy.authority === "automatic"
      ? "submission_capable"
      : "preparation_only";
  }

  supports(request: ApplicationExecutionRequest | CareerJob | JobPosting): boolean {
    if ("careerJob" in request) return trustedTarget(request, this.options.provider).target !== undefined;
    if ("job" in request) return trustedTarget({
      campaign: {} as ApplicationExecutionRequest["campaign"],
      careerJob: request,
      application: { job: request.job } as ApplicationExecutionRequest["application"],
      now: this.now(),
    }, this.options.provider).target !== undefined;
    return false;
  }

  async inspect(request: ApplicationExecutionRequest): Promise<ExecutionInspection> {
    const observed = await this.inspectForm(request, undefined, "preflight");
    return observed.inspection;
  }

  getHandoffBridge(applicationId: string) {
    const state = this.sessions.get(applicationId);
    const session = state?.session;
    if (!session?.handoffScreenshot || !session.handoffControls || !session.activateHandoffControl) return undefined;
    return {
      screenshot: () => session.handoffScreenshot!(),
      controls: () => session.handoffControls!(),
      activate: (controlId: string, point?: { x: number; y: number }) => session.activateHandoffControl!(controlId, point),
    };
  }

  async submitPrepared(request: ApplicationExecutionRequest): Promise<ApplicationExecutorResult> {
    const state = this.sessions.get(request.application.id);
    const target = trustedTarget(request, this.options.provider);
    if (!state || !target.target) {
      return { state: "failed", reason: "The retained prepared browser session is unavailable or the application target is not trusted.", retryable: false };
    }
    const currentUrl = await state.session.currentUrl();
    if (!sameApplicationPage(currentUrl, target.target)) {
      return { state: "failed", reason: "The retained browser session is no longer on the verified application page; no submission click was made.", retryable: false };
    }
    const boundary = await state.session.detectHumanBoundary();
    if (boundary) {
      return { state: "requires_human", blocker: boundaryBlocker(boundary, executorEvidenceLabel(target.target.provider)) };
    }
    if (!(await state.session.hasSubmitControl())) {
      return { state: "failed", reason: "The retained prepared form no longer exposes its verified Submit control; no click was made.", retryable: false };
    }
    let submitted: BrowserSubmissionResult;
    try {
      submitted = await state.session.submit();
    } catch (error) {
      return { state: "failed", reason: safeBrowserDiagnosticMessage(error, "The verified Submit control could not be activated."), retryable: false };
    }
    const expectedOrigin = new URL(target.target.applicationUrl).origin;
    const confirmationBound = submitted.confirmationOrigin !== undefined &&
      submitted.confirmationUrl !== undefined &&
      submitted.confirmationOrigin === expectedOrigin &&
      isTrustedAutomaticConfirmation(submitted, target.target);
    if (!submitted.confirmed || !submitted.externalApplicationId || !confirmationBound) {
      if (submitted.humanBoundary) {
        const blocker = postClickBoundaryBlocker(submitted.humanBoundary, executorEvidenceLabel(target.target.provider));
        return { state: "requires_human", blocker };
      }
      return {
        state: "requires_human",
        blocker: {
          kind: "external_verification",
          unit: "submission",
          questionProvenance: "POLICY",
          field: "submission-confirmation",
          question: "Verify whether the application was submitted",
          reason: submitted.clicked
            ? "The Submit control was activated, but provider confirmation was not deterministic. Do not retry until the result is verified."
            : "The browser did not produce a deterministic submission confirmation.",
          evidence: [submitted.clicked ? "submit:clicked" : "submit:not-clicked", submitted.evidence],
          resumeAfterHuman: false,
        },
      };
    }
    return {
      state: "submitted",
      proof: {
        mode: "external",
        provider: providerLabel(target.target.provider),
        externalApplicationId: submitted.externalApplicationId,
        submittedAt: this.now(),
        evidence: submitted.evidence,
      },
      note: `${providerLabel(target.target.provider)} confirmed the application submission.`,
    };
  }

  async execute(request: ApplicationExecutionRequest): Promise<ApplicationExecutorResult> {
    const startedAt = this.now();
    const observed = await this.inspectForm(request, startedAt, "executor");
    if (observed.inspection.status === "failed") {
      return failedResult(
        observed.inspection.evidence.find((item) => item.startsWith("error:"))?.slice("error:".length) ?? `${providerLabel(observed.target.provider)} form inspection failed.`,
        startedAt,
        this.now(),
        observed.inspection,
        observed.inspection.diagnostic?.reasonCode !== "posting_not_found" &&
          observed.inspection.diagnostic?.reasonCode !== "posting_closed",
        true,
      );
    }
    if (observed.inspection.status === "unsupported") {
      return unsupportedResult(
        observed.inspection.evidence.find((item) => item.startsWith("unsupported:"))?.slice("unsupported:".length) ?? `${providerLabel(observed.target.provider)} form is unsupported.`,
        startedAt,
        this.now(),
        observed.inspection.blockers[0],
        observed.inspection,
      );
    }
    if (observed.inspection.blockers.length > 0) {
      return {
        state: "requires_human",
        blocker: observed.inspection.blockers[0],
        blockers: observed.inspection.blockers,
        inspection: observed.inspection,
      };
    }

    const fieldsFilled = new Set(observed.inspection.fieldsFilled);
    const unresolvedFields = new Set(observed.inspection.unresolvedFields);
    const blockers: CareerBlockerDraft[] = [];
    const evidence = [...observed.inspection.evidence];
    const resumePath = request.application.resume?.familyId
      ? this.options.resumePaths?.[request.application.resume.familyId]
      : undefined;
    let resumeUsed: string | undefined;
    // Rippling keeps the original uploaded resume input mounted alongside a
    // second generic dropzone after hydration. The filename/status label is
    // the durable signal that the primary resume is already present.
    let resumeAlreadyUploaded = observed.fields.some((field) =>
      field.type === "file" && /uploaded\s+successfully/i.test(field.label));

    // Rippling controlled-field updates can remount and clear an attachment.
    // Upload the selected resume after every other field action, then perform
    // the existing provider-owned durability check before reporting ready.
    const orderedFields = [...observed.fields].sort((left, right) =>
      Number(descriptor(left).classification === "resume_upload") -
      Number(descriptor(right).classification === "resume_upload"));
    for (const field of orderedFields) {
      const fieldDescriptor = descriptor(field);
      let current: string | boolean | null | undefined;
      try {
        current = field.readValue ? await field.readValue() : undefined;
      } catch {
        current = undefined;
      }
      const effectiveCurrent = isUnansweredCustomSelectValue(fieldDescriptor, current) ? null : current;
      if (fieldDescriptor.classification === "resume_upload" && /uploaded\s+successfully/i.test(fieldDescriptor.label)) {
        fieldsFilled.add(fieldDescriptor.id);
        resumeAlreadyUploaded = true;
        resumeUsed = request.application.resume?.familyId;
        evidence.push(`resume-existing:${fieldDescriptor.id}`);
        continue;
      }
      if (meaningfulCurrentValue(effectiveCurrent) && verifiedCommittedCurrentValue(
        fieldDescriptor,
        effectiveCurrent,
        request.profile?.identity.location ?? request.profile?.location ?? undefined,
      )) {
        fieldsFilled.add(fieldDescriptor.id);
        if (fieldDescriptor.classification === "resume_upload") {
          resumeUsed = request.application.resume?.familyId;
        }
        continue;
      }
      const groundedLocation = request.profile?.identity.location ?? request.profile?.location ?? undefined;
      // Ashby's location autocomplete can hide its options after a committed
      // value is re-inspected. When the existing value is still positively
      // tied to the grounded profile location, reselect that same value
      // through the normal typeahead/commit path so the browser can re-open
      // and verify the live option. Never use this recovery for another ATS,
      // an arbitrary value, or a control with an available option snapshot.
      if (observed.target.provider === "ashby" &&
        fieldDescriptor.classification === "location" &&
        fieldDescriptor.type === "select" &&
        (!fieldDescriptor.options || fieldDescriptor.options.length === 0) &&
        groundedLocation &&
        typeof effectiveCurrent === "string" &&
        groundedLocationStringsMatch(effectiveCurrent, groundedLocation)) {
        try {
          await field.select(groundedLocation, { groundedLocation });
          const recommitted = field.readValue ? await field.readValue() : undefined;
          if (typeof recommitted === "string" && groundedLocationStringsMatch(recommitted, groundedLocation)) {
            fieldsFilled.add(fieldDescriptor.id);
            evidence.push(`reselected-grounded-location:${fieldDescriptor.id}`);
            continue;
          }
        } catch {
          // Preserve the normal fail-closed blocker below when the live
          // typeahead cannot expose and commit a unique option.
        }
      }
      if (meaningfulCurrentValue(effectiveCurrent) && (fieldDescriptor.type === "select" || fieldDescriptor.type === "radio" || fieldDescriptor.type === "checkbox")) {
        const blocker = formBlocker(fieldDescriptor, "The existing control value did not exactly match one verified option; it was left untouched.", "unknown_form_field", "ATS_FORM", executorEvidenceLabel(observed.target.provider));
        blockers.push(blocker);
        unresolvedFields.add(fieldDescriptor.label);
        continue;
      }

      if (this.options.allowedFieldClassifications && !this.options.allowedFieldClassifications.includes(fieldDescriptor.classification)) {
        if (fieldDescriptor.required || isReferralField(fieldDescriptor)) blockers.push(formBlocker(fieldDescriptor,
          "This field requires human input under the current preparation restrictions.",
          blockerKind(fieldDescriptor.classification), "ATS_FORM", executorEvidenceLabel(observed.target.provider)));
        unresolvedFields.add(fieldDescriptor.label);
        continue;
      }

      const decision = decisionForField(fieldDescriptor, request, resumePath, executorEvidenceLabel(observed.target.provider));
      if (decision.blocker) {
        blockers.push(decision.blocker);
        unresolvedFields.add(fieldDescriptor.label);
        continue;
      }
      if (decision.leaveUntouched || decision.value === undefined) {
        unresolvedFields.add(fieldDescriptor.label);
        continue;
      }

      if (fieldDescriptor.classification === "resume_upload" && resumeAlreadyUploaded) {
        // Never upload the selected resume into a second unlabeled attachment
        // control once the primary Rippling resume is already present.
        evidence.push(`resume-upload-skipped:${fieldDescriptor.id}`);
        unresolvedFields.add(fieldDescriptor.label);
        continue;
      }

      try {
        if (fieldDescriptor.type === "file") {
          const path = valueAsString(decision.value);
          if (!path || (this.options.resumeFileExists && !(await this.options.resumeFileExists(path)))) {
            const blocker = formBlocker(fieldDescriptor, "The configured resume artifact is not available at execution time.", "required_file_missing", "ATS_FORM", executorEvidenceLabel(observed.target.provider));
            if (fieldDescriptor.required) blockers.push(blocker);
            unresolvedFields.add(fieldDescriptor.label);
            continue;
          }
          await field.uploadFile(path);
          resumeUsed = request.application.resume?.familyId;
          evidence.push(`resume-uploaded:${fieldDescriptor.id}`);
        } else if (fieldDescriptor.type === "checkbox") {
          const checked = checkboxValue(decision.value);
          if (checked === undefined) throw new Error("Checkbox value was not boolean.");
          await field.setChecked(checked);
        } else if (fieldDescriptor.type === "select" || fieldDescriptor.type === "radio") {
          const selected = optionValue(fieldDescriptor, decision.value);
          if (!selected) throw new Error("Selected option was empty.");
          await field.select(selected, fieldDescriptor.classification === "location" && request.profile
            ? { groundedLocation: request.profile.identity.location ?? request.profile.location ?? undefined }
            : undefined);
        } else {
          const value = valueAsString(decision.value);
          if (!value) throw new Error("Text value was empty.");
          const isSalary = fieldDescriptor.classification === "salary";
          const fillValue = isSalary ? normalizeNumericSalaryValue(value) : value;
          if (isSalary && !fillValue) throw new Error("The authorized salary value was not a supported numeric amount.");
          await field.fill(fillValue ?? value);
          const committed = field.readValue ? await field.readValue() : undefined;
          const committedMatches = isSalary && typeof committed === "string"
            ? salaryValuesEqual(fillValue ?? value, committed)
            : committed === value;
          if (typeof committed === "string" && !committedMatches) {
            throw new Error(`The value for ${fieldDescriptor.label} was not committed by the form.`);
          }
        }
        fieldsFilled.add(fieldDescriptor.id);
        evidence.push(`filled:${fieldDescriptor.id}`);
      } catch (error) {
        const reason = safeErrorMessage(error, "The field could not be filled.");
        return failedResult(`Could not fill ${fieldDescriptor.label}: ${reason}`, startedAt, this.now(), inspection(
          "failed",
          observed.inspection.fields,
          observed.inspection.startedAt,
          this.now(),
          {
            fieldsFilled: [...fieldsFilled],
            unresolvedFields: [...unresolvedFields],
            blockers,
            ...(resumeUsed ? { resumeUsed } : {}),
            ...inspectionTelemetry(observed.inspection),
            evidence: [...evidence, `error:${reason}`],
          },
        ), true, true);
      }
    }

    // A later React rerender can replace Ashby's canonical file input after
    // upload. Re-inspect provider-owned state before declaring the packet
    // ready; the immediate FileList/upload acknowledgement is not durable.
    if ((observed.target.provider === "ashby" || observed.target.provider === "rippling") && resumePath && resumeUsed && observed.session.verifyUploadedFile) {
      const resumeField = observed.fields.find((field) => descriptor(field).classification === "resume_upload");
      const verified = await observed.session.verifyUploadedFile(resumePath).catch(() => false);
      if (!verified) {
        const fieldDescriptor = resumeField
          ? descriptor(resumeField)
          : {
              id: "_systemfield_resume",
              label: "Resume",
              type: "file" as const,
              required: true,
              classification: "resume_upload" as const,
            };
        unresolvedFields.add(fieldDescriptor.label);
        blockers.push(formBlocker(
          fieldDescriptor,
          `${observed.target.provider === "rippling" ? "Rippling" : "Ashby"} no longer shows the selected resume attached after the form finished rendering; it was left for review.`,
          "resume_missing",
          "ATS_FORM",
          executorEvidenceLabel(observed.target.provider),
        ));
        evidence.push("resume-verification:missing-after-rerender");
        const verificationDiagnostic = observed.session.uploadVerificationDiagnostics?.();
        if (verificationDiagnostic) evidence.push(`resume-verification-diagnostic:${verificationDiagnostic}`);
      } else {
        evidence.push("resume-verification:provider-confirmed-after-rerender");
      }
    }

    // Bookkeeping alone is not sufficient for provider widgets: a rerender
    // can leave a different radio/checkbox selected while the action itself
    // succeeded. Re-read approved demographic controls and require the live
    // value to match the exact intended option before reporting readiness.
    for (const field of observed.fields) {
      const fieldDescriptor = descriptor(field);
      const approvedAge = request.profile ? approvedAgeBracketValueForField(field, request.profile) : undefined;
      if (!request.profile || (fieldDescriptor.classification !== "demographic" && !approvedAge)) continue;
      const decision = decisionForField(fieldDescriptor, request, resumePath, executorEvidenceLabel(observed.target.provider));
      if (decision.value === undefined) continue;
      let current: string | boolean | null | undefined;
      try { current = field.readValue ? await field.readValue() : undefined; } catch { current = undefined; }
      const expected = fieldDescriptor.type === "checkbox"
        ? checkboxValue(decision.value)
        : optionValue(fieldDescriptor, decision.value);
      const matches = fieldDescriptor.type === "checkbox"
        ? expected !== undefined && current === expected
        : typeof current === "string" && typeof expected === "string" &&
          (normalized(current) === normalized(expected) ||
            fieldDescriptor.options?.some((option) => normalized(option.value) === normalized(expected) && normalized(option.label) === normalized(current)) === true);
      if (!matches) {
        unresolvedFields.add(fieldDescriptor.label);
        blockers.push(formBlocker(
          fieldDescriptor,
          "The approved demographic answer was not committed by the form; it was left for review.",
          "unknown_form_field",
          "ATS_FORM",
          executorEvidenceLabel(observed.target.provider),
        ));
      } else {
        const safeValue = typeof current === "boolean" ? String(current) : normalized(current ?? "");
        evidence.push(`verified-demographic:${fieldDescriptor.id}:${safeValue}`);
      }
    }

    const dedupedBlockers = dedupeBlockers(blockers);
    if (dedupedBlockers.length > 0) {
      const blockedInspection = inspection(
        "needs_input",
        observed.inspection.fields,
        observed.inspection.startedAt,
        this.now(),
        {
          fieldsFilled: [...fieldsFilled],
          unresolvedFields: [...unresolvedFields],
          blockers: dedupedBlockers,
          ...(resumeUsed ? { resumeUsed } : {}),
          ...inspectionTelemetry(observed.inspection),
          evidence: [...evidence, "submit:not-clicked"],
        },
      );
      return {
        state: "requires_human",
        blocker: dedupedBlockers[0],
        blockers: dedupedBlockers,
        inspection: blockedInspection,
      };
    }

    for (const field of observed.fields) {
      if (!field.required || !field.readValue) continue;
      let value: string | boolean | null = null;
      try {
        value = await field.readValue();
      } catch {
        value = null;
      }
      if (!meaningfulCurrentValue(value)) {
        const fieldDescriptor = descriptor(field);
        unresolvedFields.add(fieldDescriptor.label);
        const missing = formBlocker(fieldDescriptor, "A required field is still empty after the safe fill pass.", blockerKind(fieldDescriptor.classification), "ATS_FORM", executorEvidenceLabel(observed.target.provider));
        dedupedBlockers.push(missing);
      }
    }
    if (dedupedBlockers.length > 0) {
      const blockedInspection = inspection("needs_input", observed.inspection.fields, observed.inspection.startedAt, this.now(), {
        fieldsFilled: [...fieldsFilled],
        unresolvedFields: [...unresolvedFields],
        blockers: dedupeBlockers(dedupedBlockers),
        ...(resumeUsed ? { resumeUsed } : {}),
        ...inspectionTelemetry(observed.inspection),
        evidence: [...evidence, "submit:not-clicked"],
      });
      return {
        state: "requires_human",
        blocker: blockedInspection.blockers[0],
        blockers: blockedInspection.blockers,
        inspection: blockedInspection,
      };
    }

    if (!(await observed.session.hasSubmitControl())) {
      const blocker = formBlocker({
        id: "submit-control",
        label: "Final Submit control",
        type: "unknown",
        required: true,
        classification: "unknown",
      }, `The expected final Submit control was not found; the page may not be a complete ${providerLabel(observed.target.provider)} application form.`, "unsupported_widget", "POLICY", executorEvidenceLabel(observed.target.provider));
      return unsupportedResult("final Submit control was not detected", startedAt, this.now(), blocker, observed.inspection);
    }

    const currentUrl = await observed.session.currentUrl();
    if (!sameApplicationPage(currentUrl, observed.target)) {
      const blocker = boundaryBlocker({
        kind: "external_verification",
        question: "Verify the application page before review",
        reason: `The browser page changed away from the verified ${providerLabel(observed.target.provider)} application route; no further action was taken.`,
        evidence: ["navigation:unexpected-page", "submit:not-clicked"],
      }, executorEvidenceLabel(observed.target.provider));
      return unsupportedResult(`browser page no longer matches the verified ${providerLabel(observed.target.provider)} application route`, startedAt, this.now(), blocker, observed.inspection);
    }

    const finalBoundary = await observed.session.detectHumanBoundary();
    if (finalBoundary) {
      const blocker = boundaryBlocker(finalBoundary, executorEvidenceLabel(observed.target.provider));
      const blockedInspection = inspection("needs_input", observed.inspection.fields, observed.inspection.startedAt, this.now(), {
        fieldsFilled: [...fieldsFilled],
        unresolvedFields: [...unresolvedFields, finalBoundary.question],
        blockers: [blocker],
        ...(resumeUsed ? { resumeUsed } : {}),
        ...inspectionTelemetry(observed.inspection),
        evidence: [...evidence, ...finalBoundary.evidence, "submit:not-clicked"],
      });
      return { state: "requires_human", blocker, blockers: [blocker], inspection: blockedInspection };
    }

    const submissionCapable = observed.target.provider !== "generic" && this.executionMode(request) === "submission_capable";
    const readyInspection = inspection("inspected", observed.inspection.fields, observed.inspection.startedAt, this.now(), {
      fieldsFilled: [...fieldsFilled],
      unresolvedFields: [...unresolvedFields],
      ...(resumeUsed ? { resumeUsed } : {}),
      ...inspectionTelemetry(observed.inspection),
      evidence: submissionCapable
        ? [...evidence, "navigation:verified", "submit-control:detected", "submission:automatic-enabled"]
        : [...evidence, "navigation:verified", "submit-control:detected", "submit:not-clicked", "submission:manual-only"],
    });

    if (submissionCapable) {
      let submitted;
      try {
        await request.beforeAutomaticSubmission?.();
      } catch (error) {
        return failedResult(
          safeBrowserDiagnosticMessage(error, "Automatic submission ownership was lost before the final click."),
          startedAt,
          this.now(),
          { ...readyInspection, status: "failed", updatedAt: this.now() },
        );
      }
      try {
        submitted = await observed.session.submit();
      } catch (error) {
        if (request.recordAutomaticSubmissionOutcome) {
          await request.recordAutomaticSubmissionOutcome({
            clicked: true,
            confirmed: false,
            outcome: "ambiguous",
            reasonCode: "confirmation-missing",
            evidence: "automatic submission outcome was not deterministically observed",
          });
        }
        return failedResult(
          `The verified Submit control could not be activated: ${safeBrowserDiagnosticMessage(error, "browser submission failed")}`,
          startedAt,
          this.now(),
          { ...readyInspection, status: "failed", updatedAt: this.now() },
        );
      }
      const expectedOrigin = new URL(observed.target.applicationUrl).origin;
      const confirmationBound = submitted.confirmationOrigin !== undefined &&
        submitted.confirmationUrl !== undefined &&
        submitted.confirmationOrigin === expectedOrigin &&
        isTrustedAutomaticConfirmation(submitted, observed.target);
      await request.recordAutomaticSubmissionOutcome?.({
        ...submitted,
        confirmed: submitted.confirmed && confirmationBound,
        outcome: submitted.confirmed && confirmationBound ? submitted.outcome : submitted.clicked ? "ambiguous" : submitted.outcome,
      });
      if (!submitted.confirmed || !submitted.externalApplicationId || !confirmationBound) {
        if (submitted.humanBoundary) {
          const blocker = postClickBoundaryBlocker(submitted.humanBoundary, executorEvidenceLabel(observed.target.provider));
          const blockedInspection = inspection("needs_input", readyInspection.fields, readyInspection.startedAt, this.now(), {
            fieldsFilled: [...fieldsFilled],
            unresolvedFields: ["submission-confirmation"],
            blockers: [blocker],
            ...(resumeUsed ? { resumeUsed } : {}),
            ...inspectionTelemetry(readyInspection),
            evidence: [...readyInspection.evidence, "submit:clicked", ...submitted.humanBoundary.evidence],
          });
          return { state: "requires_human", blocker, blockers: [blocker], inspection: blockedInspection };
        }
        const blocker: CareerBlockerDraft = {
          kind: "external_verification",
          unit: "submission",
          questionProvenance: "POLICY",
          field: "submission-confirmation",
          question: "Verify whether the application was submitted",
          reason: submitted.reasonCode && submitted.reasonCode !== "confirmation-missing"
            ? `The employer form rejected the submission with deterministic ${submitted.reasonCode} evidence. Correct the form issue and verify the application state before attempting another submission.`
            : !confirmationBound
            ? "The employer confirmation could not be established for the verified application route; do not submit again until the result is verified."
            : submitted.clicked
            ? "The verified Submit control was activated, but the employer confirmation could not be established deterministically. Do not submit again until the result is verified."
            : "The browser did not produce a deterministic submission confirmation.",
          evidence: [
            submitted.outcome === "rejected" ? "submit:rejected" : "submit:confirmation-missing",
            ...(submitted.clicked ? ["submit:clicked"] : ["submit:not-clicked"]),
            submitted.evidence,
          ],
          resumeAfterHuman: false,
        };
        const blockedInspection = inspection("needs_input", readyInspection.fields, readyInspection.startedAt, this.now(), {
          fieldsFilled: [...fieldsFilled],
          unresolvedFields: ["submission-confirmation"],
          blockers: [blocker],
          ...(resumeUsed ? { resumeUsed } : {}),
          ...inspectionTelemetry(readyInspection),
          evidence: [...readyInspection.evidence, "submit:confirmation-missing"],
        });
        return { state: "requires_human", blocker, blockers: [blocker], inspection: blockedInspection };
      }
      return {
        state: "submitted",
        proof: {
          mode: "external",
          provider: providerLabel(observed.target.provider),
          externalApplicationId: submitted.externalApplicationId,
          submittedAt: this.now(),
          evidence: submitted.evidence,
        },
        note: `${providerLabel(observed.target.provider)} confirmed the application submission.`,
      };
    }

    return {
      state: "ready_to_submit",
      inspection: { ...readyInspection, status: "inspected" },
      note: `${providerLabel(observed.target.provider)} form prepared. Final submission remains manual; the executor never activates Submit.`,
    };
  }

  async close(applicationId: string): Promise<void> {
    const state = this.sessions.get(applicationId);
    this.sessions.delete(applicationId);
    if (state) await state.session.close();
  }

  private async sessionFor(
    request: ApplicationExecutionRequest,
    target: TrustedTarget,
  ): Promise<SessionState> {
    const key = request.application.id || request.careerJob.id;
    let state = this.sessions.get(key);
    if (!state) {
      const session = await this.options.sessionFactory.open(key);
      state = { session, navigated: false };
      this.sessions.set(key, state);
    }
    if (!state.navigated) {
      await state.session.navigate(target.applicationUrl);
      state.navigated = true;
    }
    const currentUrl = await state.session.currentUrl();
    if (!sameApplicationPage(currentUrl, target)) {
      const diagnostics = state.session.diagnostics?.();
      throw new BrowserExecutionDiagnosticError({
        stage: "navigation",
        reasonCode: "unsupported_page",
        message: `The browser page is not the verified ${providerLabel(target.provider)} application route.`,
        ...(diagnostics?.boundaries ? { boundaries: diagnostics.boundaries } : {}),
        ...(diagnostics?.navigation ? {
          navigation: { ...diagnostics.navigation, outcome: "failed" },
        } : {}),
      });
    }
    return state;
  }

  private async inspectForm(
    request: ApplicationExecutionRequest,
    startedAt = this.now(),
    phase: InspectionPhase = "preflight",
  ): Promise<ObservedForm> {
    const inspectionMonotonicStartedAt = monotonicNow();
    const inspectionStage: BrowserExecutionDiagnosticStage = phase === "preflight"
      ? "preflight_inspection"
      : "executor_inspection";
    let boundaries: BrowserExecutionBoundaryState = initialBoundaryState(phase);
    let navigation: BrowserNavigationDiagnostics | undefined;
    let diagnostic: BrowserExecutionDiagnostic | undefined;
    let captcha: BrowserCaptchaDiagnostics | undefined;
    const targetResult = trustedTarget(request, this.options.provider);
    if (!targetResult.target) {
      const completedBoundaries = phase === "preflight"
        ? { ...boundaries, preflightInspectionCompleted: true }
        : { ...boundaries, executorInspectionCompleted: true };
      const unsupportedDiagnostic: BrowserExecutionDiagnostic = {
        stage: inspectionStage,
        reasonCode: "unsupported_page",
        message: safeBrowserDiagnosticMessage(targetResult.reason, "The application destination is not supported by the browser executor."),
        boundaries: completedBoundaries,
      };
      return {
          target: {
            provider: this.options.provider === "greenhouse" ? "greenhouse" :
              this.options.provider === "rippling" ? "rippling" :
                this.options.provider === "ashby" ? "ashby" :
                  this.options.provider === "workday" ? "workday" :
                  this.options.provider === "youhired" ? "youhired" :
                  this.options.provider === "matlensilver" ? "matlensilver" :
                    this.options.provider === "protagona" ? "protagona" :
                      this.options.provider === "gusto" ? "gusto" :
                        this.options.provider === "generic" ? "generic" : "lever",
          site: "unknown",
          applicationUrl: "",
        },
        session: { currentUrl: () => "", navigate: async () => undefined, inspectFields: async () => [], detectHumanBoundary: async () => null, hasSubmitControl: async () => false, submit: async () => ({ clicked: false, confirmed: false, evidence: "submit:unavailable" }), close: async () => undefined },
        fields: [],
        inspection: inspection("unsupported", [], startedAt, this.now(), {
          evidence: [`unsupported:${targetResult.reason ?? "untrusted application destination"}`],
          durationMs: monotonicNow() - inspectionMonotonicStartedAt,
          domInspectionCount: 0,
          boundaries: completedBoundaries,
          diagnostic: unsupportedDiagnostic,
        }),
      };
    }

    const target = targetResult.target;
    let domInspectionCount = 0;
    const mergeSessionDiagnostics = (session: LeverBrowserSession): void => {
      const sessionDiagnostics = session.diagnostics?.();
      if (!sessionDiagnostics) return;
      boundaries = { ...boundaries, ...(sessionDiagnostics.boundaries ?? {}) };
      navigation = sessionDiagnostics.navigation ?? navigation;
      diagnostic = sessionDiagnostics.diagnostic ?? diagnostic;
      captcha = sessionDiagnostics.captcha ?? captcha;
    };
    const finish = (observed: ObservedForm): ObservedForm => {
      mergeSessionDiagnostics(observed.session);
      const completedBoundaries = phase === "preflight"
        ? { ...boundaries, preflightInspectionCompleted: true }
        : { ...boundaries, executorInspectionCompleted: true };
      const completedDiagnostic = diagnostic
        ? {
            ...diagnostic,
            boundaries: { ...completedBoundaries, ...(diagnostic.boundaries ?? {}) },
            ...(diagnostic.navigation || !navigation ? {} : { navigation }),
          }
        : undefined;
      return {
        ...observed,
        inspection: {
          ...observed.inspection,
          durationMs: monotonicNow() - inspectionMonotonicStartedAt,
          domInspectionCount,
          boundaries: completedBoundaries,
          ...(navigation ? { navigation } : {}),
          ...(completedDiagnostic ? { diagnostic: completedDiagnostic } : {}),
          ...(captcha ? { captcha } : {}),
        },
      };
    };
    let currentStage: BrowserExecutionDiagnosticStage = inspectionStage;
    try {
      const state = await this.sessionFor(request, target);
      mergeSessionDiagnostics(state.session);
      boundaries = { ...boundaries, controlsInspectionStarted: true };
      currentStage = "controls_inspection";
      const commonEvidence = [
        `executor:${executorEvidenceLabel(target.provider)}`,
        `source:live/${target.provider}`,
        `${target.provider === "greenhouse" ? "greenhouse-board" : target.provider === "rippling" ? "rippling-org" : target.provider === "ashby" ? "ashby-org" : target.provider === "workday" ? "workday-tenant" : target.provider === "youhired" ? "youhired-host" : target.provider === "matlensilver" ? "matlensilver-host" : target.provider === "protagona" ? "protagona-host" : target.provider === "gusto" ? "gusto-host" : "lever-site"}:${target.site}`,
        ...(target.postingId ? [`provider-job-id:${target.postingId}`] : []),
        "navigation:verified",
      ];
      const unavailablePage = await state.session.detectUnavailablePage?.();
      if (unavailablePage) {
        diagnostic = {
          stage: "controls_inspection",
          reasonCode: unavailablePage.reasonCode,
          message: unavailablePage.reasonCode === "posting_not_found"
            ? "The verified application posting was not found."
            : "The verified application posting is no longer available.",
        };
        return finish({
          target,
          session: state.session,
          fields: [],
          inspection: inspection("failed", [], startedAt, this.now(), {
            evidence: [...commonEvidence, ...unavailablePage.evidence, "posting:unavailable"],
            diagnostic,
          }),
        });
      }
      if (target.provider === "generic" && !(await state.session.verifyPageIdentity?.(request.careerJob.job.company, request.careerJob.job.title))) {
        const blocker = formBlocker({ id: "application-page", label: "direct application page", type: "unknown", required: true, classification: "unknown" },
          "The rendered page did not visibly identify the expected company and role; preparation stopped.", "unknown_form_field", "POLICY", executorEvidenceLabel(target.provider));
        return finish({ target, session: state.session, fields: [], inspection: inspection("unsupported", [], startedAt, this.now(), {
          blockers: [blocker], unresolvedFields: ["application page identity"], evidence: [...commonEvidence, "navigation:page-identity-unverified", "submit:not-clicked"],
        }) });
      }
      const formActionOrigin = await state.session.formActionOrigin?.();
      if (formActionOrigin) {
        const expectedOrigin = new URL(target.applicationUrl).origin;
        if (formActionOrigin !== expectedOrigin) {
          const blocker = formBlocker({ id: "application-form", label: `${providerLabel(target.provider)} form action`, type: "unknown", required: true, classification: "unknown" },
            "The rendered form submits to an unrelated origin; preparation stopped.", "unknown_form_field", "POLICY", executorEvidenceLabel(target.provider));
          return finish({ target, session: state.session, fields: [], inspection: inspection("unsupported", [], startedAt, this.now(), {
            blockers: [blocker], unresolvedFields: ["application form destination"], evidence: [...commonEvidence, "navigation:form-action-cross-origin", "submit:not-clicked"],
          }) });
        }
      }
      const boundary = await state.session.detectHumanBoundary();
      const rawFields = await state.session.inspectFields();
      boundaries = { ...boundaries, controlsInspectionCompleted: true };
      domInspectionCount += 1;
      mergeSessionDiagnostics(state.session);
      const descriptors = rawFields.map(descriptor);
      const baseEvidence = [
        ...commonEvidence,
        ...(captcha ? captchaEvidence(captcha) : []),
      ];
      if (boundary) {
        const blocker = boundaryBlocker(boundary, executorEvidenceLabel(target.provider));
        return finish({
          target,
          session: state.session,
          fields: rawFields,
          inspection: inspection("needs_input", descriptors, startedAt, this.now(), {
            unresolvedFields: [boundary.question],
            blockers: [blocker],
            evidence: [...baseEvidence, ...boundary.evidence, "submit:not-clicked"],
          }),
        });
      }
      if (descriptors.length === 0) {
        const blocker = formBlocker({
          id: "application-form",
          label: `${providerLabel(target.provider)} application form`,
          type: "unknown",
          required: true,
          classification: "unknown",
        }, "No supported application fields were found on the verified page.", "unknown_form_field", "POLICY", executorEvidenceLabel(target.provider));
        diagnostic = {
          stage: "controls_inspection",
          reasonCode: "unsupported_page",
          message: "No supported application fields were found on the verified page.",
        };
        return finish({
          target,
          session: state.session,
          fields: rawFields,
          inspection: inspection("unsupported", descriptors, startedAt, this.now(), {
            unresolvedFields: [`${providerLabel(target.provider)} application form`],
            blockers: [blocker],
            evidence: [...baseEvidence, "unsupported:form-fields-not-found"],
          }),
        });
      }
      return finish({
        target,
        session: state.session,
        fields: rawFields,
        inspection: inspection("inspected", descriptors, startedAt, this.now(), {
          evidence: [...baseEvidence, `fields-detected:${descriptors.length}`],
        }),
      });
    } catch (error) {
      const derivedDiagnostic = browserDiagnosticForError(
        error,
        currentStage,
        "inspection_failed",
        `${providerLabel(target.provider)} form inspection failed.`,
        {
          boundaries,
          ...(navigation ? { navigation } : {}),
        },
      );
      diagnostic = derivedDiagnostic;
      boundaries = { ...boundaries, ...(derivedDiagnostic.boundaries ?? {}) };
      navigation = derivedDiagnostic.navigation ?? navigation;
      const reason = derivedDiagnostic.message ?? safeErrorMessage(error, `${providerLabel(target.provider)} form inspection failed.`);
      const key = request.application.id || request.careerJob.id;
      const failedSession = this.sessions.get(key);
      this.sessions.delete(key);
      await failedSession?.session.close().catch(() => undefined);
      return finish({
        target,
        session: { currentUrl: () => "", navigate: async () => undefined, inspectFields: async () => [], detectHumanBoundary: async () => null, hasSubmitControl: async () => false, submit: async () => ({ clicked: false, confirmed: false, evidence: "submit:unavailable" }), close: async () => undefined },
        fields: [],
        inspection: inspection("failed", [], startedAt, this.now(), {
          evidence: [`executor:${executorEvidenceLabel(target.provider)}`, `error:${reason}`],
          boundaries,
          ...(navigation ? { navigation } : {}),
          diagnostic,
        }),
      });
    }
  }
}

function dedupeBlockers(blockers: readonly CareerBlockerDraft[]): CareerBlockerDraft[] {
  const values = new Map<string, CareerBlockerDraft>();
  for (const blocker of blockers) {
    const key = `${blocker.kind}|${blocker.unit}|${blocker.field ?? blocker.question}`;
    if (!values.has(key)) values.set(key, blocker);
  }
  return [...values.values()];
}

/** Small factory used by hosts/tests to make an explicit Lever source identity. */
export function isLeverExecutorSourceId(sourceId: string): boolean {
  try {
    return sourceId.startsWith("lever:") && sourceId === leverSourceId(sourceId.slice("lever:".length));
  } catch {
    return false;
  }
}
