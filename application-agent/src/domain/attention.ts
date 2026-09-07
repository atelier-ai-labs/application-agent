import type {
  CareerBlocker,
  CareerBlockerKind,
  QuestionProvenance,
} from "./campaignTypes";
import type { JobCompensation } from "./types";

export type AttentionEventType = "needs_input" | "configuration_required";
export type AttentionEventStatus = "open" | "resolved" | "cancelled" | "expired";
export type AttentionQuestionKind = "single_choice" | "free_text";
export type AttentionDeliveryFailureCode = "provider_error" | "unknown";
export type AttentionClosureReason =
  | "legacy_unreplyable_replaced"
  | "legacy_unreplyable_superseded"
  | "reclassified_non_blocking";
export type AttentionConfigurationReason = "missing_resume_family" | "missing_resume_artifact";
export type AttentionDescriptorSource =
  | "fieldset_legend"
  | "aria_labelledby"
  | "question_container"
  | "nearby_text"
  | "unavailable";

export interface AttentionOption {
  id: string;
  label: string;
}

export interface AttentionQuestion {
  prompt: string;
  kind: AttentionQuestionKind;
  options: readonly AttentionOption[];
  /** Safe field label copied from the inspected application control, when available. */
  fieldLabel?: string;
  /** Requiredness copied from the inspected application control, when known. */
  required?: boolean;
}

export interface AttentionEventContext {
  company: string;
  role: string;
  section?: string;
  /** Structured compensation copied from the job posting, never a candidate answer. */
  postingCompensation?: JobCompensation;
}

export interface AttentionDescriptorMetadata {
  source?: AttentionDescriptorSource;
  confidence?: "high" | "medium" | "uncertain";
}

/** Transport-neutral, user-facing human-attention event. */
export interface AttentionEvent {
  id: string;
  type: AttentionEventType;
  source: "career-agent";
  campaignId: string;
  applicationId?: string;
  createdAt: string;
  status: AttentionEventStatus;
  title: string;
  context: AttentionEventContext;
  question?: AttentionQuestion;
  /** Semantic origin; only ATS_FORM may be rendered as an employer question. */
  questionProvenance?: QuestionProvenance;
  blockerType?: CareerBlockerKind;
  message?: string;
  remediation?: string;
  reasonCode?: AttentionConfigurationReason;
  descriptor?: AttentionDescriptorMetadata;
}

export interface AttentionActorIdentity {
  provider: string;
  userId: string;
  workspaceId?: string;
}

/** Explicit human choice for one event; it is never a profile update. */
export interface AttentionResponse {
  eventId: string;
  selectedOption: string;
  actorIdentity: AttentionActorIdentity;
  respondedAt: string;
}

/** Provider delivery metadata needed to correlate a later response after restart. */
export interface AttentionProviderDelivery {
  provider: "slack";
  messageTs: string;
  channelId: string;
  /** Root Slack message timestamp when this delivery is a reply in an application thread. */
  threadTs?: string;
}

/** Internal persistence record. Job/blocker IDs never need to cross Slack. */
export interface PersistedAttentionEvent extends AttentionEvent {
  jobId?: string;
  blockerId?: string;
  descriptorSignature: string;
  publishedAt?: string;
  deliveryFailureCount?: number;
  lastDeliveryFailureAt?: string;
  lastDeliveryFailureCode?: AttentionDeliveryFailureCode;
  providerDelivery?: AttentionProviderDelivery;
  resolvedAt?: string;
  response?: AttentionResponse;
  /** Historical lifecycle metadata kept private to durable state. */
  closureReason?: AttentionClosureReason;
  replacementEventId?: string;
}

export interface NotificationAdapter {
  publishAttentionEvent(event: AttentionEvent): Promise<AttentionProviderDelivery | void>;
  closeAttentionEvent?(event: AttentionEvent): Promise<void>;
}

/** Deterministic adapter used by local acceptance tests. */
export class InMemoryNotificationAdapter implements NotificationAdapter {
  readonly publishedEvents: AttentionEvent[] = [];
  readonly closedEventIds: string[] = [];

  async publishAttentionEvent(event: AttentionEvent): Promise<AttentionProviderDelivery | void> {
    if (!this.publishedEvents.some((candidate) => candidate.id === event.id)) {
      this.publishedEvents.push(clone(event));
    }
  }

  async closeAttentionEvent(event: AttentionEvent): Promise<void> {
    if (!this.closedEventIds.includes(event.id)) this.closedEventIds.push(event.id);
  }
}

export const ATTENTION_EVENT_HISTORY_LIMIT = 64;

const MAX_PROMPT_LENGTH = 240;
const MAX_RESPONSE_LENGTH = 512;
const MAX_CONTEXT_LENGTH = 160;
const MAX_SIGNATURE_LENGTH = 512;
const MAX_DELIVERY_FAILURE_COUNT = 1_000;
const MAX_MESSAGE_LENGTH = 320;
const MAX_REMEDIATION_LENGTH = 320;
const MAX_COMPENSATION_TEXT_LENGTH = 32;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum &&
    !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value);
}

function timestamp(value: unknown): value is string {
  return boundedText(value, 64) && !Number.isNaN(Date.parse(value));
}

function safeString(value: string | undefined, maximum: number): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function safePostingCompensation(value: JobCompensation | undefined): JobCompensation | undefined {
  if (!value) return undefined;
  const minimum = typeof value.minimum === "number" && Number.isFinite(value.minimum) && value.minimum >= 0
    ? value.minimum
    : undefined;
  const maximum = typeof value.maximum === "number" && Number.isFinite(value.maximum) && value.maximum >= 0
    ? value.maximum
    : undefined;
  if (minimum === undefined && maximum === undefined) return undefined;
  const currency = safeString(value.currency, MAX_COMPENSATION_TEXT_LENGTH);
  const period = safeString(value.period, MAX_COMPENSATION_TEXT_LENGTH);
  return {
    ...(minimum !== undefined ? { minimum } : {}),
    ...(maximum !== undefined ? { maximum } : {}),
    ...(currency ? { currency } : {}),
    ...(period ? { period } : {}),
  };
}

const COMPENSATION_PERIOD_LABELS: Readonly<Record<string, string>> = {
  hour: "per hour",
  hourly: "per hour",
  week: "per week",
  weekly: "per week",
  fortnight: "per fortnight",
  fortnightly: "per fortnight",
  month: "per month",
  monthly: "per month",
  year: "per year",
  yearly: "per year",
  annual: "per year",
};

function formatCompensationAmount(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function compensationCurrencyPrefix(currency: string | undefined): string {
  const normalized = currency?.trim().toUpperCase();
  if (normalized === "USD") return "$";
  if (normalized === "EUR") return "€";
  if (normalized === "GBP") return "£";
  if (normalized === "JPY") return "¥";
  return normalized ? `${normalized} ` : "";
}

function compensationPeriodSuffix(period: string | undefined): string {
  if (!period) return "";
  const normalized = period.trim().toLowerCase().replace(/[._-]+/g, " ").replace(/\s+/g, " ");
  return COMPENSATION_PERIOD_LABELS[normalized] ?? `per ${normalized}`;
}

/** Formats only grounded posting compensation; it performs no conversion or annualization. */
export function formatPostedCompensation(value: JobCompensation | undefined): string | undefined {
  const compensation = safePostingCompensation(value);
  if (!compensation) return undefined;
  const prefix = compensationCurrencyPrefix(compensation.currency);
  const suffix = compensationPeriodSuffix(compensation.period);
  const amount = (number: number): string => `${prefix}${formatCompensationAmount(number)}`;
  let display: string;
  if (compensation.minimum !== undefined && compensation.maximum !== undefined) {
    display = `${amount(compensation.minimum)}–${amount(compensation.maximum)}`;
  } else if (compensation.minimum !== undefined) {
    display = `From ${amount(compensation.minimum)}`;
  } else if (compensation.maximum !== undefined) {
    display = `Up to ${amount(compensation.maximum)}`;
  } else {
    return undefined;
  }
  return suffix ? `${display} ${suffix}` : display;
}

function evidenceValue(blocker: CareerBlocker, prefix: string, maximum: number): string | undefined {
  const evidence = blocker.evidence.find((item) => item.startsWith(prefix));
  return safeString(evidence?.slice(prefix.length), maximum);
}

function descriptorMetadata(blocker: CareerBlocker): AttentionDescriptorMetadata | undefined {
  const source = evidenceValue(blocker, "question-source:", 40);
  const safeSource = source === "fieldset_legend" || source === "aria_labelledby" || source === "question_container" ||
    source === "nearby_text" || source === "unavailable" ? source : undefined;
  const rawConfidence = evidenceValue(blocker, "question-confidence:", 20);
  const confidence = rawConfidence === "high" || rawConfidence === "medium" || rawConfidence === "uncertain"
    ? rawConfidence
    : undefined;
  return safeSource || confidence ? { ...(safeSource ? { source: safeSource } : {}), ...(confidence ? { confidence } : {}) } : undefined;
}

function optionId(label: string, index: number): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const base = (slug || "option").slice(0, 24);
  return `${base}-${index + 1}`;
}

function structuredOptions(blocker: CareerBlocker): readonly AttentionOption[] | undefined {
  const raw = evidenceValue(blocker, "options:", 240);
  if (!raw) return undefined;
  const labels = raw.split("|").map((value) => safeString(value, 64)).filter((value): value is string => Boolean(value));
  if (labels.length === 0 || labels.length > 16 || new Set(labels.map((value) => value.toLowerCase())).size !== labels.length) return undefined;
  if (labels.length === 2 && labels.some((value) => value.toLowerCase() === "yes") && labels.some((value) => value.toLowerCase() === "no")) {
    return [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ];
  }
  return labels.map((label, index) => ({ id: optionId(label, index), label }));
}

function fieldLabelFor(blocker: CareerBlocker): string | undefined {
  return evidenceValue(blocker, "field-label:", MAX_CONTEXT_LENGTH) ??
    evidenceValue(blocker, "question-label:", MAX_CONTEXT_LENGTH);
}

function requiredFor(blocker: CareerBlocker): boolean | undefined {
  const value = evidenceValue(blocker, "field-required:", 8);
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function promptFor(blocker: CareerBlocker): string | undefined {
  return evidenceValue(blocker, "question-prompt:", MAX_PROMPT_LENGTH) ??
    safeString(blocker.question, MAX_PROMPT_LENGTH);
}

function sectionFor(blocker: CareerBlocker): string | undefined {
  return evidenceValue(blocker, "question-section:", MAX_CONTEXT_LENGTH) ??
    evidenceValue(blocker, "field-section:", MAX_CONTEXT_LENGTH);
}

function questionMetadata(blocker: CareerBlocker): Pick<AttentionQuestion, "fieldLabel" | "required"> {
  const fieldLabel = fieldLabelFor(blocker);
  const required = requiredFor(blocker);
  return {
    ...(fieldLabel ? { fieldLabel } : {}),
    ...(required !== undefined ? { required } : {}),
  };
}

function questionOptions(blocker: CareerBlocker): readonly AttentionOption[] {
  return structuredOptions(blocker) ?? [];
}

function questionKind(options: readonly AttentionOption[]): AttentionQuestionKind {
  return options.length > 0 ? "single_choice" : "free_text";
}

function questionForBlocker(blocker: CareerBlocker): AttentionQuestion | undefined {
  if (!isHumanAttentionBlockerKind(blocker.kind)) return undefined;
  const prompt = promptFor(blocker);
  if (!prompt || !blocker.context.applicationId) return undefined;
  const options = questionOptions(blocker);
  return {
    prompt,
    kind: questionKind(options),
    options,
    ...questionMetadata(blocker),
  };
}

const CAREER_BLOCKER_KINDS: ReadonlySet<string> = new Set([
  "salary", "sponsorship", "relocation", "travel", "legal_attestation", "demographic_disclosure",
  "unknown_fact", "subjective_answer", "external_login", "captcha", "external_verification",
  "unknown_form_field", "unsupported_widget", "resume_missing", "required_file_missing", "submission_approval", "other",
]);

/**
 * Explicit human-authority categories that can be safely presented as one
 * bounded question. Policy holds, submission gates, and operational failures
 * remain in their existing non-interactive handling paths.
 */
const HUMAN_ATTENTION_BLOCKER_KINDS: ReadonlySet<CareerBlockerKind> = new Set([
  "salary",
  "sponsorship",
  "relocation",
  "travel",
  "legal_attestation",
  "demographic_disclosure",
  "unknown_fact",
  "subjective_answer",
  "external_login",
  "captcha",
  "external_verification",
  "unknown_form_field",
  "unsupported_widget",
  "resume_missing",
  "required_file_missing",
]);

function isHumanAttentionBlockerKind(kind: CareerBlockerKind): boolean {
  return HUMAN_ATTENTION_BLOCKER_KINDS.has(kind);
}

/** Classifies older blockers safely when their explicit provenance is absent. */
export function questionProvenanceForBlocker(
  blocker: Pick<CareerBlocker, "questionProvenance" | "unit" | "evidence">,
): QuestionProvenance {
  if (blocker.questionProvenance) return blocker.questionProvenance;
  if (blocker.evidence.some((item) => item === "executor:lever-browser" || item === "executor:greenhouse-browser" || item.startsWith("field-id:") || item.startsWith("classification:"))) {
    return "ATS_FORM";
  }
  if (blocker.evidence.some((item) => item === "executor:unavailable")) return "CONFIGURATION";
  if (blocker.unit === "application_preparation") return "APPLICATION_PREPARATION";
  if (blocker.unit === "submission" || blocker.unit === "external") return "POLICY";
  return "UNKNOWN";
}

/** Stable safe signature used to reject a response for a changed blocker. */
export function attentionDescriptorSignature(
  blocker: CareerBlocker,
  postingCompensation?: JobCompensation,
): string | undefined {
  const question = questionForBlocker(blocker);
  if (!question) return undefined;
  const normalizedCompensation = blocker.kind === "salary"
    ? safePostingCompensation(postingCompensation)
    : undefined;
  const signature = JSON.stringify({
    blockerType: blocker.kind,
    field: blocker.field,
    prompt: question.prompt,
    questionKind: question.kind,
    fieldLabel: question.fieldLabel,
    required: question.required,
    section: sectionFor(blocker),
    options: question.options.map((option) => option.id),
    questionProvenance: questionProvenanceForBlocker(blocker),
    descriptor: descriptorMetadata(blocker),
    ...(normalizedCompensation ? { postingCompensation: normalizedCompensation } : {}),
  });
  return signature.length <= MAX_SIGNATURE_LENGTH ? signature : undefined;
}

/**
 * Converts only explicit human-required blockers into a bounded
 * human-attention event. It never selects or infers an answer.
 */
export function attentionEventForCareerBlocker(input: {
  campaignId: string;
  jobId: string;
  blocker: CareerBlocker;
  postingCompensation?: JobCompensation;
  createdAt: string;
  createId: (prefix: string) => string;
}): { event: AttentionEvent; record: PersistedAttentionEvent } | undefined {
  const { blocker } = input;
  const question = questionForBlocker(blocker);
  const postingCompensation = blocker.kind === "salary"
    ? safePostingCompensation(input.postingCompensation)
    : undefined;
  const descriptorSignature = attentionDescriptorSignature(blocker, postingCompensation);
  if (!question || !descriptorSignature || !blocker.context.applicationId) return undefined;

  const section = sectionFor(blocker);
  const event: AttentionEvent = {
    id: input.createId("attention"),
    type: "needs_input",
    source: "career-agent",
    campaignId: input.campaignId,
    applicationId: blocker.context.applicationId,
    createdAt: input.createdAt,
    status: "open",
    title: "Career Agent needs input",
    context: {
      company: safeString(blocker.context.company, MAX_CONTEXT_LENGTH) ?? "Company",
      role: safeString(blocker.context.role, MAX_CONTEXT_LENGTH) ?? "Application",
      ...(section ? { section } : {}),
      ...(postingCompensation ? { postingCompensation } : {}),
    },
    question,
    questionProvenance: questionProvenanceForBlocker(blocker),
    blockerType: blocker.kind,
    ...(descriptorMetadata(blocker) ? { descriptor: descriptorMetadata(blocker) } : {}),
  };
  return {
    event,
    record: {
      ...event,
      jobId: input.jobId,
      blockerId: blocker.id,
      descriptorSignature,
    },
  };
}

/**
 * Creates a campaign-level setup notice. It is intentionally not a question
 * response event and therefore never exposes an answer option.
 */
export function attentionEventForConfiguration(input: {
  campaignId: string;
  createdAt: string;
  createId: (prefix: string) => string;
  reasonCode: AttentionConfigurationReason;
}): { event: AttentionEvent; record: PersistedAttentionEvent } {
  const message = input.reasonCode === "missing_resume_artifact"
    ? "I can't prepare applications because no usable local resume artifact is configured for your private profile."
    : "I can't evaluate jobs because your private profile has no resume families.";
  const remediation = input.reasonCode === "missing_resume_artifact"
    ? "Place a PDF or DOCX under .local/career-agent/resumes/ and map it to a resume family, then rerun the campaign."
    : "Add at least one resume family to your local Career Agent profile, then rerun the campaign.";
  const event: AttentionEvent = {
    id: input.createId("attention"),
    type: "configuration_required",
    source: "career-agent",
    campaignId: input.campaignId,
    createdAt: input.createdAt,
    status: "open",
    title: "⚠️ Career Agent needs setup",
    questionProvenance: "CONFIGURATION",
    context: {
      company: "Career Agent",
      role: "Profile setup",
    },
    message,
    remediation,
    reasonCode: input.reasonCode,
  };
  return {
    event,
    record: {
      ...event,
      descriptorSignature: `configuration:${input.reasonCode}`,
    },
  };
}

export function publicAttentionEvent(record: PersistedAttentionEvent): AttentionEvent {
  const {
    jobId: _jobId,
    blockerId: _blockerId,
    descriptorSignature: _descriptorSignature,
    publishedAt: _publishedAt,
    deliveryFailureCount: _deliveryFailureCount,
    lastDeliveryFailureAt: _lastDeliveryFailureAt,
    lastDeliveryFailureCode: _lastDeliveryFailureCode,
    providerDelivery: _providerDelivery,
    resolvedAt: _resolvedAt,
    response: _response,
    closureReason: _closureReason,
    replacementEventId: _replacementEventId,
    ...event
  } = record;
  return clone(event);
}

export function isAttentionOption(value: unknown): value is AttentionOption {
  return Boolean(value && typeof value === "object" &&
    boundedText((value as { id?: unknown }).id, 32) && boundedText((value as { label?: unknown }).label, 64));
}

function isQuestionProvenance(value: unknown): value is QuestionProvenance {
  return value === "ATS_FORM" || value === "APPLICATION_PREPARATION" || value === "POLICY" ||
    value === "CONFIGURATION" || value === "UNKNOWN";
}

function isPostingCompensation(value: unknown): value is JobCompensation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<JobCompensation>;
  const hasAmount = candidate.minimum !== undefined || candidate.maximum !== undefined;
  return hasAmount &&
    (candidate.minimum === undefined || (typeof candidate.minimum === "number" && Number.isFinite(candidate.minimum) && candidate.minimum >= 0)) &&
    (candidate.maximum === undefined || (typeof candidate.maximum === "number" && Number.isFinite(candidate.maximum) && candidate.maximum >= 0)) &&
    (candidate.currency === undefined || boundedText(candidate.currency, MAX_COMPENSATION_TEXT_LENGTH)) &&
    (candidate.period === undefined || boundedText(candidate.period, MAX_COMPENSATION_TEXT_LENGTH));
}

function isAttentionProviderDelivery(value: unknown): value is AttentionProviderDelivery {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AttentionProviderDelivery>;
  return candidate.provider === "slack" &&
    boundedText(candidate.messageTs, 128) &&
    boundedText(candidate.channelId, 128) &&
    (candidate.threadTs === undefined || boundedText(candidate.threadTs, 128));
}

export function isAttentionEvent(value: unknown): value is AttentionEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AttentionEvent>;
  const context = candidate.context;
  const question = candidate.question;
  const common = boundedText(candidate.id, 128) &&
    (candidate.type === "needs_input" || candidate.type === "configuration_required") &&
    candidate.source === "career-agent" &&
    boundedText(candidate.campaignId, 128) &&
    timestamp(candidate.createdAt) &&
    (candidate.status === "open" || candidate.status === "resolved" || candidate.status === "cancelled" || candidate.status === "expired") &&
    boundedText(candidate.title, MAX_CONTEXT_LENGTH) &&
    (candidate.questionProvenance === undefined || isQuestionProvenance(candidate.questionProvenance)) &&
    Boolean(context && typeof context === "object" && boundedText(context.company, MAX_CONTEXT_LENGTH) &&
      boundedText(context.role, MAX_CONTEXT_LENGTH) &&
      (context.section === undefined || boundedText(context.section, MAX_CONTEXT_LENGTH)) &&
      (context.postingCompensation === undefined || isPostingCompensation(context.postingCompensation))) &&
    (candidate.descriptor === undefined || (candidate.descriptor !== null && typeof candidate.descriptor === "object" &&
      (candidate.descriptor.source === undefined || candidate.descriptor.source === "fieldset_legend" ||
        candidate.descriptor.source === "aria_labelledby" || candidate.descriptor.source === "question_container" ||
        candidate.descriptor.source === "nearby_text" || candidate.descriptor.source === "unavailable") &&
      (candidate.descriptor.confidence === undefined || candidate.descriptor.confidence === "high" ||
        candidate.descriptor.confidence === "medium" || candidate.descriptor.confidence === "uncertain")));
  if (!common) return false;
  if (candidate.type === "needs_input") {
    const validQuestion = question && typeof question === "object" && boundedText(question.prompt, MAX_PROMPT_LENGTH) &&
      Array.isArray(question.options) &&
      (question.fieldLabel === undefined || boundedText(question.fieldLabel, MAX_CONTEXT_LENGTH)) &&
      (question.required === undefined || typeof question.required === "boolean") &&
      (question.kind === "free_text"
        ? question.options.length === 0
        : question.kind === "single_choice" && question.options.length > 0 && question.options.every(isAttentionOption));
    return boundedText(candidate.applicationId, 128) && Boolean(validQuestion) &&
      typeof candidate.blockerType === "string" && CAREER_BLOCKER_KINDS.has(candidate.blockerType) &&
      candidate.message === undefined && candidate.remediation === undefined && candidate.reasonCode === undefined;
  }
  return candidate.applicationId === undefined && candidate.question === undefined && candidate.blockerType === undefined &&
    boundedText(candidate.message, MAX_MESSAGE_LENGTH) &&
    boundedText(candidate.remediation, MAX_REMEDIATION_LENGTH) &&
    (candidate.reasonCode === "missing_resume_family" || candidate.reasonCode === "missing_resume_artifact");
}

export function isAttentionResponse(value: unknown): value is AttentionResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AttentionResponse>;
  const actor = candidate.actorIdentity;
  return boundedText(candidate.eventId, 128) &&
    boundedText(candidate.selectedOption, MAX_RESPONSE_LENGTH) &&
    timestamp(candidate.respondedAt) &&
    Boolean(actor && typeof actor === "object" && boundedText(actor.provider, 32) && boundedText(actor.userId, 128) &&
      (actor.workspaceId === undefined || boundedText(actor.workspaceId, 128)));
}

export function isPersistedAttentionEvent(value: unknown): value is PersistedAttentionEvent {
  if (!isAttentionEvent(value)) return false;
  const candidate = value as Partial<PersistedAttentionEvent>;
  const internalCareerLink = candidate.type === "needs_input"
    ? boundedText(candidate.jobId, 128) && boundedText(candidate.blockerId, 128)
    : candidate.jobId === undefined && candidate.blockerId === undefined;
  return internalCareerLink &&
    boundedText(candidate.descriptorSignature, MAX_SIGNATURE_LENGTH) &&
    (candidate.publishedAt === undefined || timestamp(candidate.publishedAt)) &&
    (candidate.deliveryFailureCount === undefined ||
      (Number.isInteger(candidate.deliveryFailureCount) && candidate.deliveryFailureCount >= 0 && candidate.deliveryFailureCount <= MAX_DELIVERY_FAILURE_COUNT)) &&
    (candidate.lastDeliveryFailureAt === undefined || timestamp(candidate.lastDeliveryFailureAt)) &&
    (candidate.lastDeliveryFailureCode === undefined || candidate.lastDeliveryFailureCode === "provider_error" || candidate.lastDeliveryFailureCode === "unknown") &&
    (candidate.providerDelivery === undefined || isAttentionProviderDelivery(candidate.providerDelivery)) &&
    (candidate.resolvedAt === undefined || timestamp(candidate.resolvedAt)) &&
    (candidate.response === undefined || (isAttentionResponse(candidate.response) && candidate.response.eventId === candidate.id)) &&
    (candidate.closureReason === undefined || candidate.closureReason === "legacy_unreplyable_replaced" || candidate.closureReason === "legacy_unreplyable_superseded" || candidate.closureReason === "reclassified_non_blocking") &&
    (candidate.replacementEventId === undefined || boundedText(candidate.replacementEventId, 128));
}
