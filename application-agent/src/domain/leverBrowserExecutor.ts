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
  isVerifiedRipplingHostedUrl,
  isVerifiedRipplingApplicationUrl,
  ripplingApplicationUrl,
} from "./jobUrlClassifier";
import { monotonicNow } from "./executionTrace";

export interface LeverBrowserExecutorOptions {
  sessionFactory: LeverBrowserSessionFactory;
  /** Defaults to Lever for backwards compatibility; auto accepts verified ATS destinations. */
  provider?: "lever" | "greenhouse" | "rippling" | "auto";
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
  provider: "lever" | "greenhouse" | "rippling";
  site: string;
  postingId: string;
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

export function classifyLeverApplicationField(
  field: Pick<LeverBrowserField, "id" | "label" | "section" | "type">,
): ApplicationFieldClassification {
  const text = fieldText(field);
  const factField = profileFactField(field);
  if (hasPhrase(text, /resume|cv|curriculum vitae/)) return "resume_upload";
  if (hasPhrase(text, /demographic|gender identity|race|ethnicity|veteran|disability|voluntary self/)) return "demographic";
  if (hasPhrase(text, /legal|attest|certif(?:y|ication)|agree to|authorize|terms|accurate and complete/)) return "legal_attestation";
  if (hasPhrase(text, /work authorization|authorized to work|legally authorized|right to work|eligible to work/)) return "work_authorization";
  if (hasPhrase(text, /sponsor|visa|immigration status/)) return "sponsorship";
  if (hasPhrase(text, /salary|compensation|pay expectation|desired pay/)) return "salary";
  if (hasPhrase(text, /relocat/)) return "relocation";
  if (hasPhrase(text, /travel/)) return "travel";
  if (hasPhrase(text, /education|degree|university|college|school|major|study/)) return "education";
  if (hasPhrase(text, /why|interest|motivat|cover letter|tell us|anything else|additional information/)) return "free_text";
  if (factField) return factField;
  if (hasPhrase(text, /employ|employer|company|work history|job history|position held|job title|occupation|start date|end date/)) return "employment_history";
  if (hasPhrase(text, /location|city|state|country|address|postal|zip/)) return "location";
  if (hasPhrase(text, /first name|given name|last name|family name|surname|full name|email|e-mail|phone|telephone|mobile|linkedin|portfolio|website/)) return "contact";
  if (field.type === "textarea") return "free_text";
  return "unknown";
}

function descriptor(field: LeverBrowserField): ApplicationFieldDescriptor {
  const id = nonEmpty(field.id) ?? nonEmpty(field.label) ?? "unknown-field";
  const label = nonEmpty(field.label) ?? id;
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
): Extract<ApplicationExecutorResult, { state: "failed" }> {
  return {
    state: "failed",
    reason,
    retryable: true,
    ...(observed ? { inspection: { ...observed, status: "failed", updatedAt: now } } : {
      inspection: inspection("failed", [], startedAt, now, {
        evidence: ["executor:lever-browser", "execution-failed"],
      }),
    }),
  };
}

function isAnswerValuePresent(value: AnswerValue | undefined): value is AnswerValue {
  return value !== undefined && (typeof value !== "string" || value.trim().length > 0);
}

function valueAsString(value: AnswerValue | undefined): string | undefined {
  if (!isAnswerValuePresent(value)) return undefined;
  return typeof value === "string" ? value.trim() : String(value);
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

function employmentForField(field: ApplicationFieldDescriptor, profile: CandidateProfile | undefined) {
  if (!profile) return undefined;
  const text = fieldText(field);
  if (hasPhrase(text, /current (?:company|employer)|present (?:company|employer)/)) {
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

function groundedStateFromLocation(value: string | null | undefined): string | undefined {
  const parts = value?.split(",").map((part) => part.trim()).filter(Boolean) ?? [];
  if (parts.length < 2) return undefined;
  const country = parts.at(-1);
  if (!country || !/^(?:us|u\.s\.?|usa|u\.s\.a\.?|united states|united states of america)$/i.test(country)) {
    return undefined;
  }
  return nonEmpty(parts.at(-2));
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
  const direct = answers.find((answer) => aliases.has(answer.field));
  if (direct) return direct;

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
    (blocker) => blocker.status === "resolved" && isAnswerValuePresent(blocker.value),
  );
  const exact = candidates.find((blocker) => blocker.field === field.id);
  if (exact && careerBlockerMatchesField(exact, field)) return exact.value;
  const byQuestion = candidates.find((blocker) => normalized(blocker.question) === normalized(field.label));
  return byQuestion && careerBlockerMatchesField(byQuestion, field) ? byQuestion.value : undefined;
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
  const fromBlocker = resolvedCareerValue(field, request);
  if (isAnswerValuePresent(fromBlocker)) return { value: fromBlocker, explicit: true };
  const factField = profileFactField(field);
  if (factField) {
    const answer = usableAnswer(
      request.application.answers.find((candidate) => profileFactAnswerAliases(factField).includes(candidate.field)),
      request,
    );
    return answer;
  }
  // A generic `name` answer must never be reused for an optional preferred-name
  // field. Only an explicit profile preferredName may fill it automatically.
  if (isPreferredNameField(field)) return { explicit: false };
  // Preparation may contain a full location answer. Country/state controls
  // need the grounded component, not the full city/state string.
  if (field.classification === "location" && hasPhrase(fieldText(field), /\b(?:country|states?)\b/)) {
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
    if (hasPhrase(text, /email|e-mail/)) return profile.identity.email ?? undefined;
    if (hasPhrase(text, /phone|telephone|mobile/)) return profile.identity.phone ?? undefined;
    if (hasPhrase(text, /last name|family name|surname/)) return name.last;
    if (hasPhrase(text, /first name|given name/)) return name.first;
    return name.full;
  }
  if (field.classification === "location") {
    if (hasPhrase(text, /\bcountry\b/)) {
      return groundedCountryFromLocation(profile.identity.location ?? profile.location);
    }
    if (hasPhrase(text, /listed states we hire in/)) {
      return groundedStateEligibilityFromLocation(text, profile.identity.location ?? profile.location);
    }
    if (hasPhrase(text, /\bstates?\b/)) {
      const state = groundedStateFromLocation(profile.identity.location ?? profile.location);
      if (!state) return undefined;
      return field.options && field.options.length > 0
        ? state
        : US_STATE_ABBREVIATIONS[normalized(state)] ?? state;
    }
    return profile.identity.location ?? profile.location ?? undefined;
  }
  if (factField === "desired_work_location") return profile.workPreferences.preferredWorkLocation ?? undefined;
  if (factField === "start_availability") return profile.workPreferences.availabilityStartDate ?? undefined;
  if (field.classification === "employment_history") {
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
  if (field.classification === "work_authorization") return profile.workAuthorization.status ?? undefined;
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
  const option = field.options.find((candidate) => {
    const labels = [normalized(candidate.value), normalized(candidate.label)];
    return desiredAliases.some((alias) => labels.includes(alias)) ||
      // Greenhouse's phone-country control appends the dialing code to the
      // grounded country name (for example, "United States +1"). Preserve
      // exact option selection while accepting that display form.
      labels.some((label) => desiredAliases.some((alias) =>
        label.startsWith(`${alias}+`) || label.startsWith(`${alias} +`))) ||
      booleanAliases.some((alias) => labels.includes(alias));
  });
  return option?.value;
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
      return field.required
        ? { explicit: false, blocker: formBlocker(field, "Demographic disclosures are never selected automatically; provide an explicit response.", "demographic_disclosure", "ATS_FORM", executor) }
        : { explicit: false, leaveUntouched: true };
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

function providerLabel(provider: TrustedTarget["provider"]): string {
  if (provider === "greenhouse") return "Greenhouse";
  if (provider === "rippling") return "Rippling";
  return "Lever";
}

function executorEvidenceLabel(provider: TrustedTarget["provider"]): string {
  if (provider === "greenhouse") return "greenhouse-browser";
  if (provider === "rippling") return "rippling-browser";
  return "lever-browser";
}

function sameApplicationPage(value: string, target: TrustedTarget): boolean {
  try {
    const url = new URL(value);
    if (target.provider === "greenhouse") {
      return url.protocol === "https:" && isVerifiedGreenhouseApplicationUrl(url.toString(), target.site, target.postingId);
    }
    if (target.provider === "rippling") {
      return url.protocol === "https:" && isVerifiedRipplingApplicationUrl(url.toString()) &&
        classifyJobUrl(url.toString()).siteIdentifier === target.site &&
        classifyJobUrl(url.toString()).postingIdentifier === target.postingId &&
        url.pathname.endsWith("/apply");
    }
    return url.protocol === "https:" && isVerifiedLeverApplicationUrl(url.toString(), target.site, target.postingId);
  } catch {
    return false;
  }
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
      destination.kind === "greenhouse" ? "greenhouse" :
        destination.kind === "rippling" ? "rippling" : undefined
    : configuredProvider;

  if (provider === "lever") {
    if (!sourceId.startsWith("lever:")) return { reason: "Only verified Lever postings are supported by this executor." };
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

  if (provider === "greenhouse") {
    if (destination.kind !== "greenhouse" || !destination.siteIdentifier || !destination.postingIdentifier) {
      return { reason: "The application URL is not a verified Greenhouse application route." };
    }
    const resolution = job.destinationResolution;
    const destinationMatches = resolution?.status === "resolved" &&
      resolution.actionable === true &&
      resolution.ats === "Greenhouse" &&
      resolution.destinationUrl === posting.applicationUrl;
    const directGreenhouseSource = sourceId.startsWith("greenhouse:") &&
      Boolean(job.sourceRecordId) &&
      isVerifiedGreenhouseHostedUrl(posting.sourceUrl, sourceId.slice("greenhouse:".length), job.sourceRecordId ?? "");
    if (!destinationMatches && !directGreenhouseSource) {
      return { reason: "The Greenhouse destination is not independently verified for this posting." };
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
        options.provider === "rippling" ? "rippling-browser-executor" : "lever-browser-executor";
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

  async execute(request: ApplicationExecutionRequest): Promise<ApplicationExecutorResult> {
    const startedAt = this.now();
    const observed = await this.inspectForm(request, startedAt, "executor");
    if (observed.inspection.status === "failed") {
      return failedResult(
        observed.inspection.evidence.find((item) => item.startsWith("error:"))?.slice("error:".length) ?? `${providerLabel(observed.target.provider)} form inspection failed.`,
        startedAt,
        this.now(),
        observed.inspection,
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

    for (const field of observed.fields) {
      const fieldDescriptor = descriptor(field);
      let current: string | boolean | null | undefined;
      try {
        current = field.readValue ? await field.readValue() : undefined;
      } catch {
        current = undefined;
      }
      if (meaningfulCurrentValue(current)) {
        fieldsFilled.add(fieldDescriptor.id);
        if (fieldDescriptor.classification === "resume_upload") {
          resumeUsed = request.application.resume?.familyId;
        }
        continue;
      }

      if (this.options.allowedFieldClassifications && !this.options.allowedFieldClassifications.includes(fieldDescriptor.classification)) {
        if (fieldDescriptor.required) blockers.push(formBlocker(fieldDescriptor,
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
        } else if (fieldDescriptor.type === "checkbox") {
          const checked = checkboxValue(decision.value);
          if (checked === undefined) throw new Error("Checkbox value was not boolean.");
          await field.setChecked(checked);
        } else if (fieldDescriptor.type === "select" || fieldDescriptor.type === "radio") {
          const selected = valueAsString(decision.value);
          if (!selected) throw new Error("Selected option was empty.");
          await field.select(selected);
        } else {
          const value = valueAsString(decision.value);
          if (!value) throw new Error("Text value was empty.");
          await field.fill(value);
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
        ));
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

    const submissionCapable = this.executionMode(request) === "submission_capable";
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
        submitted = await observed.session.submit();
      } catch (error) {
        return failedResult(
          `The verified Submit control could not be activated: ${safeBrowserDiagnosticMessage(error, "browser submission failed")}`,
          startedAt,
          this.now(),
          { ...readyInspection, status: "failed", updatedAt: this.now() },
        );
      }
      if (!submitted.confirmed || !submitted.externalApplicationId) {
        const blocker: CareerBlockerDraft = {
          kind: "external_verification",
          unit: "submission",
          questionProvenance: "POLICY",
          field: "submission-confirmation",
          question: "Verify whether the application was submitted",
          reason: submitted.clicked
            ? "The verified Submit control was activated, but the employer confirmation could not be established deterministically. Do not submit again until the result is verified."
            : "The browser did not produce a deterministic submission confirmation.",
          evidence: [
            "submit:confirmation-missing",
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
            this.options.provider === "rippling" ? "rippling" : "lever",
          site: "unknown",
          postingId: "unknown",
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
      const boundary = await state.session.detectHumanBoundary();
      boundaries = { ...boundaries, controlsInspectionStarted: true };
      currentStage = "controls_inspection";
      const rawFields = await state.session.inspectFields();
      boundaries = { ...boundaries, controlsInspectionCompleted: true };
      domInspectionCount += 1;
      mergeSessionDiagnostics(state.session);
      const descriptors = rawFields.map(descriptor);
      const baseEvidence = [
        `executor:${executorEvidenceLabel(target.provider)}`,
        `source:live/${target.provider}`,
        `${target.provider === "greenhouse" ? "greenhouse-board" : target.provider === "rippling" ? "rippling-org" : "lever-site"}:${target.site}`,
        `provider-job-id:${target.postingId}`,
        "navigation:verified",
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
