import type {
  CareerBlocker,
  CareerBlockerKind,
} from "./campaignTypes";

export type AttentionEventType = "needs_input";
export type AttentionEventStatus = "open" | "resolved" | "cancelled" | "expired";
export type AttentionQuestionKind = "single_choice";
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
}

export interface AttentionEventContext {
  company: string;
  role: string;
  section?: string;
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
  applicationId: string;
  createdAt: string;
  status: AttentionEventStatus;
  title: string;
  context: AttentionEventContext;
  question: AttentionQuestion;
  blockerType: CareerBlockerKind;
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

/** Internal persistence record. Job/blocker IDs never need to cross Slack. */
export interface PersistedAttentionEvent extends AttentionEvent {
  jobId: string;
  blockerId: string;
  descriptorSignature: string;
  publishedAt?: string;
  resolvedAt?: string;
  response?: AttentionResponse;
}

export interface NotificationAdapter {
  publishAttentionEvent(event: AttentionEvent): Promise<void>;
  closeAttentionEvent?(event: AttentionEvent): Promise<void>;
}

/** Deterministic adapter used by local acceptance tests. */
export class InMemoryNotificationAdapter implements NotificationAdapter {
  readonly publishedEvents: AttentionEvent[] = [];
  readonly closedEventIds: string[] = [];

  async publishAttentionEvent(event: AttentionEvent): Promise<void> {
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
const MAX_CONTEXT_LENGTH = 160;
const MAX_SIGNATURE_LENGTH = 512;

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

function binaryOptions(blocker: CareerBlocker): readonly AttentionOption[] | undefined {
  const raw = evidenceValue(blocker, "options:", 80);
  if (!raw) return undefined;
  const labels = raw.split("|").map((value) => safeString(value, 32)).filter((value): value is string => Boolean(value));
  if (labels.length !== 2 || new Set(labels.map((value) => value.toLowerCase())).size !== 2) return undefined;
  if (!labels.some((value) => value.toLowerCase() === "yes") || !labels.some((value) => value.toLowerCase() === "no")) return undefined;
  return [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ];
}

function promptFor(blocker: CareerBlocker): string {
  return evidenceValue(blocker, "question-prompt:", MAX_PROMPT_LENGTH) ??
    "The employer form asks a required Yes/No question, but its exact prompt was not exposed.";
}

const CAREER_BLOCKER_KINDS: ReadonlySet<string> = new Set([
  "salary", "sponsorship", "relocation", "travel", "legal_attestation", "demographic_disclosure",
  "unknown_fact", "subjective_answer", "external_login", "captcha", "external_verification",
  "unknown_form_field", "unsupported_widget", "resume_missing", "required_file_missing", "submission_approval", "other",
]);

/** Stable safe signature used to reject a response for a changed blocker. */
export function attentionDescriptorSignature(blocker: CareerBlocker): string | undefined {
  const options = binaryOptions(blocker);
  if (blocker.kind !== "unknown_form_field" || !options) return undefined;
  const signature = JSON.stringify({
    blockerType: blocker.kind,
    prompt: promptFor(blocker),
    section: evidenceValue(blocker, "question-section:", MAX_CONTEXT_LENGTH),
    options: options.map((option) => option.id),
    descriptor: descriptorMetadata(blocker),
  });
  return signature.length <= MAX_SIGNATURE_LENGTH ? signature : undefined;
}

/**
 * Converts only the observed bounded binary unknown-field blocker into a
 * human-attention event. It never selects or infers an answer.
 */
export function attentionEventForCareerBlocker(input: {
  campaignId: string;
  jobId: string;
  blocker: CareerBlocker;
  createdAt: string;
  createId: (prefix: string) => string;
}): { event: AttentionEvent; record: PersistedAttentionEvent } | undefined {
  const { blocker } = input;
  const options = binaryOptions(blocker);
  const descriptorSignature = attentionDescriptorSignature(blocker);
  if (!options || !descriptorSignature || !blocker.context.applicationId) return undefined;

  const section = evidenceValue(blocker, "question-section:", MAX_CONTEXT_LENGTH);
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
    },
    question: {
      prompt: promptFor(blocker),
      kind: "single_choice",
      options,
    },
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

export function publicAttentionEvent(record: PersistedAttentionEvent): AttentionEvent {
  const {
    jobId: _jobId,
    blockerId: _blockerId,
    descriptorSignature: _descriptorSignature,
    publishedAt: _publishedAt,
    resolvedAt: _resolvedAt,
    response: _response,
    ...event
  } = record;
  return clone(event);
}

export function isAttentionOption(value: unknown): value is AttentionOption {
  return Boolean(value && typeof value === "object" &&
    boundedText((value as { id?: unknown }).id, 32) && boundedText((value as { label?: unknown }).label, 64));
}

export function isAttentionEvent(value: unknown): value is AttentionEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AttentionEvent>;
  const context = candidate.context;
  const question = candidate.question;
  return boundedText(candidate.id, 128) &&
    candidate.type === "needs_input" &&
    candidate.source === "career-agent" &&
    boundedText(candidate.campaignId, 128) &&
    boundedText(candidate.applicationId, 128) &&
    timestamp(candidate.createdAt) &&
    (candidate.status === "open" || candidate.status === "resolved" || candidate.status === "cancelled" || candidate.status === "expired") &&
    boundedText(candidate.title, MAX_CONTEXT_LENGTH) &&
    Boolean(context && typeof context === "object" && boundedText(context.company, MAX_CONTEXT_LENGTH) &&
      boundedText(context.role, MAX_CONTEXT_LENGTH) &&
      (context.section === undefined || boundedText(context.section, MAX_CONTEXT_LENGTH))) &&
    Boolean(question && typeof question === "object" && boundedText(question.prompt, MAX_PROMPT_LENGTH) &&
      question.kind === "single_choice" && Array.isArray(question.options) && question.options.length > 0 &&
      question.options.every(isAttentionOption)) &&
    typeof candidate.blockerType === "string" && CAREER_BLOCKER_KINDS.has(candidate.blockerType) &&
    (candidate.descriptor === undefined || (candidate.descriptor !== null && typeof candidate.descriptor === "object" &&
      (candidate.descriptor.source === undefined || candidate.descriptor.source === "fieldset_legend" ||
        candidate.descriptor.source === "aria_labelledby" || candidate.descriptor.source === "question_container" ||
        candidate.descriptor.source === "nearby_text" || candidate.descriptor.source === "unavailable") &&
      (candidate.descriptor.confidence === undefined || candidate.descriptor.confidence === "high" ||
        candidate.descriptor.confidence === "medium" || candidate.descriptor.confidence === "uncertain")));
}

export function isAttentionResponse(value: unknown): value is AttentionResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AttentionResponse>;
  const actor = candidate.actorIdentity;
  return boundedText(candidate.eventId, 128) &&
    boundedText(candidate.selectedOption, 32) &&
    timestamp(candidate.respondedAt) &&
    Boolean(actor && typeof actor === "object" && boundedText(actor.provider, 32) && boundedText(actor.userId, 128) &&
      (actor.workspaceId === undefined || boundedText(actor.workspaceId, 128)));
}

export function isPersistedAttentionEvent(value: unknown): value is PersistedAttentionEvent {
  if (!isAttentionEvent(value)) return false;
  const candidate = value as Partial<PersistedAttentionEvent>;
  return boundedText(candidate.jobId, 128) &&
    boundedText(candidate.blockerId, 128) &&
    boundedText(candidate.descriptorSignature, MAX_SIGNATURE_LENGTH) &&
    (candidate.publishedAt === undefined || timestamp(candidate.publishedAt)) &&
    (candidate.resolvedAt === undefined || timestamp(candidate.resolvedAt)) &&
    (candidate.response === undefined || (isAttentionResponse(candidate.response) && candidate.response.eventId === candidate.id));
}
