import type {
  AttentionEvent,
  AttentionResponse,
  NotificationAdapter,
} from "../../src/domain/attention";
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
  fetcher?: Fetcher;
  webSocketFactory?: SlackWebSocketFactory;
  socketOpenTimeoutMs?: number;
}

interface SlackApiResponse {
  ok?: boolean;
  error?: unknown;
  url?: unknown;
  ts?: unknown;
}

const ACTION_ID = "career_agent_attention_option";

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

function eventMessage(event: AttentionEvent): {
  text: string;
  blocks: readonly Record<string, unknown>[];
} {
  const section = event.context.section ? `\n\n*${markdownText(event.context.section, 160)}*` : "";
  const uncertainty = event.descriptor?.confidence === "uncertain"
    ? "\n\n_The question context may be uncertain; review it before answering._"
    : "";
  const question = `${markdownText(event.question.prompt, 240)}${uncertainty}`;
  const text = `${markdownText(event.title, 160)}\n${markdownText(event.context.company, 160)} — ${markdownText(event.context.role, 200)}${section}\n\n${question}`;
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
          text: `*${markdownText(event.context.company, 160)}* — ${markdownText(event.context.role, 200)}${section}\n\n${question}`,
        },
      },
      {
        type: "actions",
        elements: event.question.options.map((option) => ({
          type: "button",
          action_id: ACTION_ID,
          text: { type: "plain_text", text: safeText(option.label, 64) },
          value: `${event.id}|${option.id}`,
        })),
      },
    ],
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
 * only Socket Mode button actions from the configured workspace/user/channel.
 */
export class SlackNotificationAdapter implements NotificationAdapter {
  private readonly config: SlackNotificationConfig;
  private readonly responseHandler?: SlackAttentionResponseHandler;
  private readonly eventLookup?: (eventId: string) => AttentionEvent | undefined;
  private readonly fetcher: Fetcher;
  private readonly webSocketFactory: SlackWebSocketFactory;
  private readonly socketOpenTimeoutMs: number;
  private readonly messageTimestamps = new Map<string, string>();
  private socket?: SlackWebSocket;

  constructor(options: SlackNotificationAdapterOptions) {
    this.config = options.config;
    this.responseHandler = options.responseHandler;
    this.eventLookup = options.eventLookup;
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.socketOpenTimeoutMs = options.socketOpenTimeoutMs ?? 10_000;
    if (!Number.isInteger(this.socketOpenTimeoutMs) || this.socketOpenTimeoutMs <= 0) {
      throw new Error("Slack Socket Mode connection timeout must be positive.");
    }
  }

  async publishAttentionEvent(event: AttentionEvent): Promise<void> {
    if (event.type !== "needs_input" || event.status !== "open") return;
    const message = eventMessage(event);
    const result = await this.callApi("chat.postMessage", this.config.botToken, {
      channel: this.config.channelId,
      text: message.text,
      blocks: message.blocks,
    });
    if (typeof result.ts === "string" && result.ts.trim()) this.messageTimestamps.set(event.id, result.ts.trim());
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
    this.messageTimestamps.delete(event.id);
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
    if (!text || text.length > 64_000) return;
    let envelope: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      const payload = responsePayload(parsed);
      if (!payload) return;
      envelope = payload;
    } catch {
      return;
    }
    const envelopeId = stringValue(envelope.envelope_id, 256);
    if (envelopeId && this.socket) this.socket.send(JSON.stringify({ envelope_id: envelopeId }));
    const payload = responsePayload(envelope.payload);
    if (!payload || payload.type !== "block_actions") return;
    await this.handleInteraction(payload);
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
    if (!action || action.action_id !== ACTION_ID) return { status: "rejected", reason: "unexpected_action" };
    const rawValue = stringValue(action.value, 256);
    if (!rawValue) return { status: "rejected", reason: "missing_action_value" };
    const separator = rawValue.lastIndexOf("|");
    if (separator <= 0 || separator === rawValue.length - 1) return { status: "rejected", reason: "malformed_action_value" };
    const eventId = rawValue.slice(0, separator);
    const selectedOption = rawValue.slice(separator + 1);
    const event = this.eventLookup?.(eventId);
    if (this.eventLookup && (!event || event.status !== "open")) return { status: "rejected", reason: "unknown_or_closed_event" };
    if (event && !event.question.options.some((option) => option.id === selectedOption)) {
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
