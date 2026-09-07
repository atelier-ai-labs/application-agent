import type {
  AttentionEvent,
  AttentionResponse,
  AttentionProviderDelivery,
  NotificationAdapter,
  PersistedAttentionEvent,
} from "../../src/domain/attention";
import { formatPostedCompensation } from "../../src/domain/attention";
import type { SlackNotificationConfig } from "./config";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface SlackWebSocket {
  onopen?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: unknown) => void;
  onclose?: () => void;
  send(data: string): void;
  close(): void;
}

type SlackWebSocketFactory = (url: string) => SlackWebSocket;

export interface SlackInteractionResult {
  status: "resolved" | "duplicate" | "rejected" | "ignored";
  reason?: string;
}

export type SlackAttentionResponseHandler = (response: AttentionResponse) => Promise<{
  status: "resolved" | "duplicate";
}>;

export interface SlackNotificationAdapterOptions {
  config: SlackNotificationConfig;
  responseHandler?: SlackAttentionResponseHandler;
  eventLookup?: (eventId: string) => AttentionEvent | undefined;
  persistedAttentionEventsLookup?: () => readonly PersistedAttentionEvent[] | Promise<readonly PersistedAttentionEvent[]>;
  fetcher?: Fetcher;
  webSocketFactory?: SlackWebSocketFactory;
  socketOpenTimeoutMs?: number;
  diagnosticLogger?: SlackDiagnosticLogger;
}

export interface SlackDiagnosticLogger {
  info(message: string): void;
  warn(message: string): void;
}

interface SlackApiResponse {
  ok?: boolean;
  error?: unknown;
  url?: unknown;
  ts?: unknown;
}

const ACTION_ID = "career_agent_attention_option";
const GENERATED_ACTION_ID_PATTERN = new RegExp(`^${ACTION_ID}_([0-9]+)$`);

function actionIdForOption(index: number): string {
  return `${ACTION_ID}_${index}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function safeText(value: string, maximum = 240): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maximum);
}

function markdownText(value: string, maximum = 240): string {
  return safeText(value, maximum).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function defaultWebSocketFactory(url: string): SlackWebSocket {
  const constructor = (globalThis as unknown as {
    WebSocket?: new (target: string) => SlackWebSocket;
  }).WebSocket;
  if (!constructor) throw new Error("The Node runtime does not provide WebSocket support for Slack Socket Mode.");
  return new constructor(url);
}

function responseData(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  return "";
}

function eventMessage(event: AttentionEvent, renderOptions: { threadReply?: boolean } = {}): {
  text: string;
  blocks: readonly Record<string, unknown>[];
} {
  if (event.type === "configuration_required") {
    const message = event.message ?? "Career Agent requires configuration before it can continue.";
    const remediation = event.remediation ?? "Review the local Career Agent configuration and rerun the campaign.";
    const text = `${markdownText(event.title, 160)}\n\n${markdownText(message, 320)}\n\n${markdownText(remediation, 320)}`;
    return {
      text,
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: safeText(event.title, 150) },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${markdownText(message, 320)}\n\n${markdownText(remediation, 320)}`,
          },
        },
      ],
    };
  }
  if (!event.question) throw new Error("An interactive attention event requires a question.");
  const section = event.context.section ? `\n\n*${markdownText(event.context.section, 160)}*` : "";
  const fieldLabel = event.question.fieldLabel
    ? `Field label: ${markdownText(event.question.fieldLabel, 160)}`
    : "";
  const requiredness = event.question.required === true
    ? "Required field."
    : event.question.required === false
      ? "Optional field."
      : "";
  const uncertainty = event.descriptor?.confidence === "uncertain"
    ? "\n\n_The question context may be uncertain; review it before answering._"
    : "";
  const question = `${markdownText(event.question.prompt, 240)}${uncertainty}`;
  const postedCompensation = event.blockerType === "salary"
    ? formatPostedCompensation(event.context.postingCompensation)
    : undefined;
  const salaryContext = event.blockerType === "salary"
    ? postedCompensation
      ? `The job posting lists compensation of ${postedCompensation}.`
      : "No compensation range was found in the job posting."
    : "";
  const answerOptions = event.question.kind === "single_choice" && event.question.options.length > 0
    ? `Options: ${event.question.options.map((option) => markdownText(option.label, 64)).join(" / ")}`
    : "";
  const questionFraming = event.questionProvenance === "ATS_FORM"
    ? "Application question:"
    : event.questionProvenance === "APPLICATION_PREPARATION"
      ? "Career Agent needs this candidate fact before application execution:"
      : event.questionProvenance === "POLICY"
        ? "Career Agent needs your review before continuing:"
        : "Career Agent needs clarification before continuing:";
  const questionDetails = [
    event.questionProvenance === "ATS_FORM" ? fieldLabel : "",
    event.questionProvenance === "ATS_FORM" ? requiredness : "",
    salaryContext,
    `${questionFraming}\n\"${question}\"`,
    answerOptions,
    event.blockerType === "salary" ? "What should I enter?" : "",
  ].filter(Boolean).join("\n\n");
  const replyInstruction = event.question.kind === "free_text"
    ? "\n\nReply in this Slack thread with one grounded answer."
    : "";
  const threadReply = renderOptions.threadReply === true;
  const text = threadReply
    ? `${questionDetails}${replyInstruction}`
    : `${markdownText(event.title, 160)}\n${markdownText(event.context.company, 160)} — ${markdownText(event.context.role, 200)}${section}\n\n${questionDetails}${replyInstruction}`;
  const blocks: Record<string, unknown>[] = threadReply
    ? [{
      type: "section",
      text: { type: "mrkdwn", text: `${questionDetails}${replyInstruction}` },
    }]
    : [
      {
        type: "header",
        text: { type: "plain_text", text: safeText(event.title, 150) },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${markdownText(event.context.company, 160)}* — ${markdownText(event.context.role, 200)}${section}\n\n${questionDetails}${replyInstruction}`,
        },
      },
    ];
  if (event.question.kind === "single_choice" && event.question.options.length > 0) {
    blocks.push({
      type: "actions",
      elements: event.question.options.map((option, index) => ({
        type: "button",
        action_id: actionIdForOption(index),
        text: { type: "plain_text", text: safeText(option.label, 64) },
        value: `${event.id}|${option.id}`,
      })),
    });
  }
  return {
    text,
    blocks,
  };
}

function responsePayload(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum
    ? value.trim()
    : undefined;
}

/**
 * Server-only Slack adapter. It publishes small Block Kit messages and accepts
 * only Socket Mode button actions or thread replies from the configured
 * workspace/user/channel.
 */
export class SlackNotificationAdapter implements NotificationAdapter {
  private readonly config: SlackNotificationConfig;
  private readonly responseHandler?: SlackAttentionResponseHandler;
  private readonly eventLookup?: (eventId: string) => AttentionEvent | undefined;
  private readonly persistedAttentionEventsLookup?: SlackNotificationAdapterOptions["persistedAttentionEventsLookup"];
  private readonly fetcher: Fetcher;
  private readonly webSocketFactory: SlackWebSocketFactory;
  private readonly socketOpenTimeoutMs: number;
  private readonly diagnosticLogger: SlackDiagnosticLogger;
  private readonly messageTimestamps = new Map<string, string>();
  /** Transport-local application conversation state; core remains Slack-agnostic. */
  private readonly applicationThreadRoots = new Map<string, { threaded: Set<string>; topLevel: Set<string> }>();
  private readonly threadEventIds = new Map<string, Set<string>>();
  /** Latest durable event snapshots used when a listener started before publication. */
  private readonly publishedAttentionEvents = new Map<string, PersistedAttentionEvent>();
  private socket?: SlackWebSocket;

  constructor(options: SlackNotificationAdapterOptions) {
    this.config = options.config;
    this.responseHandler = options.responseHandler;
    this.eventLookup = options.eventLookup;
    this.persistedAttentionEventsLookup = options.persistedAttentionEventsLookup;
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.socketOpenTimeoutMs = options.socketOpenTimeoutMs ?? 10_000;
    this.diagnosticLogger = options.diagnosticLogger ?? {
      info: (message) => console.info(`[career-agent-slack] ${message}`),
      warn: (message) => console.warn(`[career-agent-slack] ${message}`),
    };
    if (!Number.isInteger(this.socketOpenTimeoutMs) || this.socketOpenTimeoutMs <= 0) {
      throw new Error("Slack Socket Mode connection timeout must be positive.");
    }
  }

  async publishAttentionEvent(event: AttentionEvent): Promise<AttentionProviderDelivery | void> {
    if (event.status !== "open") return;
    const threadTs = event.applicationId ? this.applicationRootForPublishing(event.applicationId) : undefined;
    const message = eventMessage(event, { threadReply: Boolean(threadTs) });
    const result = await this.callApi("chat.postMessage", this.config.botToken, {
      channel: this.config.channelId,
      text: message.text,
      blocks: message.blocks,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    const timestamp = typeof result.ts === "string" && result.ts.trim() ? result.ts.trim() : undefined;
    if (event.type === "needs_input" && !timestamp) {
      throw new Error("Slack chat.postMessage did not return a message timestamp.");
    }
    if (!timestamp) return;
    this.rememberMessageTimestamp(event.id, timestamp);
    const rootTs = threadTs ?? timestamp;
    if (event.applicationId) {
      this.rememberApplicationRoot(event.applicationId, rootTs, Boolean(threadTs));
      this.rememberThreadEvent(rootTs, event.id);
    }
    return {
      provider: "slack",
      messageTs: timestamp,
      channelId: this.config.channelId,
      ...(threadTs ? { threadTs } : {}),
    };
  }

  async closeAttentionEvent(event: AttentionEvent): Promise<void> {
    const timestamp = this.messageTimestamps.get(event.id);
    if (!timestamp) return;
    await this.callApi("chat.update", this.config.botToken, {
      channel: this.config.channelId,
      ts: timestamp,
      text: `${safeText(event.title, 150)} — resolved`,
      blocks: [],
    });
    this.forgetMessageTimestamp(event.id);
  }

  /** Hydrates durable application threads and open event message correlations before Socket Mode starts. */
  hydratePublishedAttentionEvents(events: readonly PersistedAttentionEvent[]): number {
    this.messageTimestamps.clear();
    this.applicationThreadRoots.clear();
    this.threadEventIds.clear();
    this.publishedAttentionEvents.clear();
    const hydrated = this.indexPublishedAttentionEvents(events);
    this.diagnosticLogger.info(`hydrated ${hydrated} published attention event${hydrated === 1 ? "" : "s"}`);
    return hydrated;
  }

  private indexPublishedAttentionEvents(events: readonly PersistedAttentionEvent[]): number {
    let hydrated = 0;
    for (const event of events) {
      const delivery = event.providerDelivery;
      if (!delivery || delivery.provider !== "slack" || delivery.channelId !== this.config.channelId) continue;
      this.publishedAttentionEvents.set(event.id, event);
      if (event.publishedAt && event.type === "needs_input" && event.status === "open") {
        this.rememberMessageTimestamp(event.id, delivery.messageTs);
        hydrated += 1;
      }
      if (event.applicationId && event.type === "needs_input") {
        const rootTs = delivery.threadTs ?? delivery.messageTs;
        this.rememberApplicationRoot(event.applicationId, rootTs, Boolean(delivery.threadTs));
        if (event.status === "open") this.rememberThreadEvent(rootTs, event.id);
      }
    }
    return hydrated;
  }

  private async refreshPublishedAttentionEvents(): Promise<void> {
    if (!this.persistedAttentionEventsLookup) return;
    try {
      this.indexPublishedAttentionEvents(await this.persistedAttentionEventsLookup());
    } catch {
      this.diagnosticLogger.warn("ignored: durable attention lookup failed");
    }
  }

  async start(): Promise<void> {
    if (this.socket) throw new Error("The Slack Socket Mode listener is already running.");
    const result = await this.callApi("apps.connections.open", this.config.appToken);
    const url = stringValue(result.url, 2_000);
    if (!url || !url.startsWith("wss://")) throw new Error("Slack did not return a valid Socket Mode URL.");
    const socket = this.webSocketFactory(url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Slack Socket Mode connection timed out."));
      }, this.socketOpenTimeoutMs);
      socket.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("Slack Socket Mode connection failed."));
      };
    }).catch((error) => {
      this.socket = undefined;
      socket.close();
      throw error;
    });
    socket.onmessage = (message) => {
      void this.handleSocketEnvelope(message.data);
    };
  }

  stop(): void {
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  async handleSocketEnvelope(raw: unknown): Promise<void> {
    const text = responseData(raw);
    if (!text || text.length > 64_000) {
      this.diagnosticLogger.warn("ignored: empty or oversized Socket Mode envelope");
      return;
    }
    let envelope: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      const payload = responsePayload(parsed);
      if (!payload) {
        this.diagnosticLogger.warn("ignored: malformed Socket Mode envelope");
        return;
      }
      envelope = payload;
    } catch {
      this.diagnosticLogger.warn("ignored: malformed Socket Mode envelope");
      return;
    }
    const envelopeId = stringValue(envelope.envelope_id, 256);
    if (envelopeId && this.socket) this.socket.send(JSON.stringify({ envelope_id: envelopeId }));
    if (envelope.type === "hello") return;
    const payload = responsePayload(envelope.payload);
    if (!payload) {
      this.diagnosticLogger.warn("ignored: Socket Mode envelope had no payload");
      return;
    }
    if (payload.type === "block_actions") {
      await this.handleInteraction(payload);
      return;
    }
    if (payload.type === "event_callback") {
      await this.handleMessageEvent(payload);
      return;
    }
    this.diagnosticLogger.info(`ignored: wrong event type ${stringValue(payload.type, 64) ?? "unknown"}`);
  }

  private async handleMessageEvent(payload: Record<string, unknown>): Promise<void> {
    const message = responsePayload(payload.event);
    if (!message) {
      this.diagnosticLogger.warn("ignored: event callback had no event payload");
      return;
    }
    const messageType = stringValue(message.type, 64);
    if (messageType !== "message") {
      this.diagnosticLogger.info(`ignored: wrong event type ${messageType ?? "unknown"}`);
      return;
    }
    const channelType = stringValue(message.channel_type, 32);
    this.diagnosticLogger.info(`received message event${channelType ? ` (${channelType})` : ""}`);
    if (message.subtype !== undefined || message.bot_id !== undefined) {
      this.diagnosticLogger.info("ignored: bot/self or subtype message");
      return;
    }
    const userId = stringValue(message.user, 128);
    const channelId = stringValue(message.channel, 128);
    const threadTs = stringValue(message.thread_ts, 128);
    const text = stringValue(message.text, 512);
    const teamId = stringValue(payload.team_id, 128) ?? stringValue(message.team, 128);
    if (!userId) {
      this.diagnosticLogger.info("ignored: message had no user");
      return;
    }
    if (userId !== this.config.allowedUserId) {
      this.diagnosticLogger.info("ignored: wrong user");
      return;
    }
    if (!channelId || channelId !== this.config.channelId) {
      this.diagnosticLogger.info("ignored: wrong channel");
      return;
    }
    if (this.config.allowedTeamId && teamId !== this.config.allowedTeamId) {
      this.diagnosticLogger.info("ignored: wrong workspace");
      return;
    }
    if (!threadTs) {
      this.diagnosticLogger.info("ignored: message is not a thread reply");
      return;
    }
    if (!text) {
      this.diagnosticLogger.info("ignored: empty thread reply");
      return;
    }
    if (!this.responseHandler || !this.eventLookup) {
      this.diagnosticLogger.warn("ignored: Slack response handler is not ready");
      return;
    }

    await this.refreshPublishedAttentionEvents();
    const eventIds = this.threadEventIds.get(threadTs);
    if (!eventIds) {
      this.diagnosticLogger.info("ignored: unmatched thread");
      return;
    }
    const events = [...eventIds]
      .map((eventId) => this.eventLookup?.(eventId))
      .filter((event): event is AttentionEvent => Boolean(event));
    const openEvents = events.filter((event) => event.status === "open" && event.type === "needs_input");
    if (openEvents.length > 1) {
      this.diagnosticLogger.info("ignored: ambiguous thread");
      return;
    }
    if (openEvents.length === 0) {
      if (events.some((event) => event.status !== "open")) {
        this.diagnosticLogger.info("ignored: attention event already resolved or stale");
      } else {
        this.diagnosticLogger.info("ignored: attention event not found");
      }
      return;
    }
    const event = openEvents[0];
    if (event.type !== "needs_input" || !event.question || event.question.kind !== "free_text") {
      this.diagnosticLogger.info("ignored: attention event is not a free-text input");
      return;
    }
    const eventId = event.id;
    try {
      const result = await this.responseHandler({
        eventId,
        selectedOption: text,
        actorIdentity: {
          provider: "slack",
          userId,
          ...(teamId ? { workspaceId: teamId } : {}),
        },
        respondedAt: new Date().toISOString(),
      });
      this.diagnosticLogger.info(`accepted response for attention event (${result.status})`);
    } catch {
      this.diagnosticLogger.warn("attention response handling or resume failed");
    }
  }

  private rememberApplicationRoot(applicationId: string, rootTs: string, threaded: boolean): void {
    const roots = this.applicationThreadRoots.get(applicationId) ?? { threaded: new Set<string>(), topLevel: new Set<string>() };
    (threaded ? roots.threaded : roots.topLevel).add(rootTs);
    this.applicationThreadRoots.set(applicationId, roots);
  }

  private applicationRootForPublishing(applicationId: string): string | undefined {
    const roots = this.applicationThreadRoots.get(applicationId);
    if (!roots) return undefined;
    if (roots.threaded.size === 1) return [...roots.threaded][0];
    if (roots.threaded.size > 1) return undefined;
    return roots.topLevel.size === 1 ? [...roots.topLevel][0] : undefined;
  }

  private rememberThreadEvent(rootTs: string, eventId: string): void {
    const eventIds = this.threadEventIds.get(rootTs) ?? new Set<string>();
    eventIds.add(eventId);
    this.threadEventIds.set(rootTs, eventIds);
  }

  private rememberMessageTimestamp(eventId: string, timestamp: string): void {
    this.messageTimestamps.set(eventId, timestamp);
  }

  private forgetMessageTimestamp(eventId: string): void {
    this.messageTimestamps.delete(eventId);
  }

  async handleInteraction(payload: unknown): Promise<SlackInteractionResult> {
    const body = responsePayload(payload);
    if (!body || body.type !== "block_actions") return { status: "ignored", reason: "unsupported_payload" };
    const user = responsePayload(body.user);
    const team = responsePayload(body.team);
    const channel = responsePayload(body.channel);
    const userId = stringValue(user?.id, 128);
    const teamId = stringValue(team?.id, 128);
    const channelId = stringValue(channel?.id, 128);
    if (!userId || userId !== this.config.allowedUserId) return { status: "rejected", reason: "unauthorized_user" };
    if (this.config.allowedTeamId && teamId !== this.config.allowedTeamId) return { status: "rejected", reason: "unauthorized_workspace" };
    if (channelId !== this.config.channelId) return { status: "rejected", reason: "unexpected_channel" };
    if (!this.responseHandler || !Array.isArray(body.actions) || body.actions.length !== 1) {
      return { status: "rejected", reason: "listener_not_ready" };
    }
    const action = responsePayload(body.actions[0]);
    if (!action) return { status: "rejected", reason: "unexpected_action" };
    const actionId = typeof action.action_id === "string" && action.action_id.length <= 255
      ? action.action_id
      : undefined;
    if (!actionId) return { status: "rejected", reason: "unexpected_action" };
    const generatedAction = actionId.match(GENERATED_ACTION_ID_PATTERN);
    if (actionId !== ACTION_ID && !generatedAction) return { status: "rejected", reason: "unexpected_action" };
    const optionIndex = generatedAction ? Number(generatedAction[1]) : undefined;
    if (generatedAction && (!Number.isSafeInteger(optionIndex) || String(optionIndex) !== generatedAction[1])) {
      return { status: "rejected", reason: "unexpected_action" };
    }
    const rawValue = stringValue(action.value, 256);
    if (!rawValue) return { status: "rejected", reason: "missing_action_value" };
    const separator = rawValue.lastIndexOf("|");
    if (separator <= 0 || separator === rawValue.length - 1) return { status: "rejected", reason: "malformed_action_value" };
    const eventId = rawValue.slice(0, separator);
    const selectedOption = rawValue.slice(separator + 1);
    // A publication can happen after the Socket Mode listener starts (for
    // example, another runtime instance may persist and publish the event).
    // Refresh durable correlations before resolving a button action so the
    // first click is not rejected as unknown or stale.
    await this.refreshPublishedAttentionEvents();
    const event = this.eventLookup?.(eventId) ?? this.publishedAttentionEvents.get(eventId);
    if (!event || event.status !== "open") return { status: "rejected", reason: "unknown_or_closed_event" };
    if (event && (event.type !== "needs_input" || !event.question)) {
      return { status: "rejected", reason: "non_interactive_event" };
    }
    if (optionIndex !== undefined && (!event?.question || event.question.kind !== "single_choice" || !event.question.options[optionIndex])) {
      return { status: "rejected", reason: "unexpected_action" };
    }
    if (event?.type === "needs_input" && event.question && !event.question.options.some((option) => option.id === selectedOption)) {
      return { status: "rejected", reason: "invalid_option" };
    }
    if (optionIndex !== undefined && event?.question?.options[optionIndex]?.id !== selectedOption) {
      return { status: "rejected", reason: "invalid_option" };
    }
    try {
      const result = await this.responseHandler({
        eventId,
        selectedOption,
        actorIdentity: {
          provider: "slack",
          userId,
          ...(teamId ? { workspaceId: teamId } : {}),
        },
        respondedAt: new Date().toISOString(),
      });
      return { status: result.status };
    } catch {
      return { status: "rejected", reason: "attention_response_rejected" };
    }
  }

  private async callApi(method: string, token: string, body?: Readonly<Record<string, unknown>>): Promise<SlackApiResponse> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.apiBaseUrl}/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error(`Slack ${method} request failed.`);
    }
    if (!response.ok) throw new Error(`Slack ${method} returned HTTP ${response.status}.`);
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new Error(`Slack ${method} returned malformed JSON.`);
    }
    const result = responsePayload(data) as SlackApiResponse | undefined;
    if (!result?.ok) throw new Error(`Slack ${method} was not accepted.`);
    return clone(result);
  }
}

export { ACTION_ID };
