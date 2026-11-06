import type {
  AttentionEvent,
  AttentionResponse,
  AttentionProviderDelivery,
  NotificationAdapter,
  PersistedAttentionEvent,
  QueueHandoffNotice,
  SubmissionReviewNotice,
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

/** Runs one explicit, human-approved submit of an exact prepared application. */
export type SlackSubmissionApprovalHandler = (approval: {
  campaignId: string;
  jobId: string;
  applicationId: string;
  actorIdentity: { provider: "slack"; userId: string; workspaceId?: string };
}) => Promise<{ submitted: boolean; message: string }>;

export interface SlackNotificationAdapterOptions {
  config: SlackNotificationConfig;
  responseHandler?: SlackAttentionResponseHandler;
  submissionApprovalHandler?: SlackSubmissionApprovalHandler;
  eventLookup?: (eventId: string) => AttentionEvent | undefined;
  persistedAttentionEventsLookup?: () => readonly PersistedAttentionEvent[] | Promise<readonly PersistedAttentionEvent[]>;
  fetcher?: Fetcher;
  webSocketFactory?: SlackWebSocketFactory;
  socketOpenTimeoutMs?: number;
  /** Delay before reconnecting a Socket Mode connection after Slack closes it. */
  socketReconnectDelayMs?: number;
  diagnosticLogger?: SlackDiagnosticLogger;
  /** Resolves a one-time viewer URL for an active CAPTCHA execution. */
  handoffUrlForApplication?: (applicationId: string) => string | Promise<string | undefined> | undefined;
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
const SUBMIT_ACTION_ID = "career_agent_submit_prepared";
const SUBMIT_ACTION_VALUE = /^(campaign-[0-9a-f-]{36})\|(career-job-[0-9a-f-]{36})\|(application-[0-9a-f-]{36})$/;
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

function threadReplyOnly(options: { threadReply?: boolean }): boolean {
  return options.threadReply === true;
}

function markdownText(value: string, maximum = 240): string {
  return safeText(value, maximum).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function defaultWebSocketFactory(url: string): SlackWebSocket {
  const constructor = (
    globalThis as unknown as {
      WebSocket?: new (target: string) => SlackWebSocket;
    }
  ).WebSocket;
  if (!constructor) throw new Error("The Node runtime does not provide WebSocket support for Slack Socket Mode.");
  return new constructor(url);
}

function responseData(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  return "";
}

function eventMessage(
  event: AttentionEvent,
  renderOptions: { threadReply?: boolean; handoffUrl?: string } = {},
): {
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
  const humanVerificationHandoff = event.submissionAlreadyClicked === true || event.blockerType === "captcha" ||
    (event.blockerType === "external_verification" && /verify whether the application was submitted/i.test(event.question.prompt));
  if (humanVerificationHandoff) {
    const postSubmit = event.submissionAlreadyClicked === true || event.blockerType === "external_verification";
    const handoffText = postSubmit
      ? "I clicked Submit, but I couldn't confirm that the employer received the application, so I won't click Submit again."
      : "The open browser needs a human verification step before the application can continue.";
    const instruction = postSubmit
      ? renderOptions.handoffUrl
        ? "Open the link below (works on your phone: tap, type, and scroll the page) or check the agent's Chromium window. If the page says the application was submitted, reply DONE and I'll mark it Applied. Otherwise, reply with what you see."
        : "Check the agent's Chromium window on your computer. If the page says the application was submitted, reply DONE and I'll mark it Applied. Otherwise, reply with what you see."
      : renderOptions.handoffUrl
        // The handoff page forwards taps, typing, and scrolling to the waiting
        // window, so the CAPTCHA can be solved from a phone.
        ? "Solve it from the link below (works on your phone: tap the page, use Zoom in for small tiles) or in the agent's Chromium window, then reply DONE in this thread."
        : "Solve it in the agent's Chromium window on your computer, then reply DONE in this thread. If the browser session has closed, reply DONE and I will report that the session expired without retrying submission.";
    const link = renderOptions.handoffUrl ? `\n\nOpen the protected browser handoff: ${markdownText(renderOptions.handoffUrl, 500)}` : "";
    const text = `${markdownText(event.title, 160)}\n${markdownText(event.context.company, 160)} — ${markdownText(event.context.role, 200)}\n\n${handoffText}\n\n${instruction}${link}`;
    return {
      text,
      blocks: [
        { type: "header", text: { type: "plain_text", text: safeText(event.title, 150) } },
        { type: "section", text: { type: "mrkdwn", text: `${handoffText}\n\n${instruction}${link}` } },
      ],
    };
  }
  // A dropped or missing resume is a file to attach, not a question to answer in text.
  if (event.blockerType === "resume_missing" || event.blockerType === "required_file_missing") {
    const problem = event.blockerType === "resume_missing"
      ? "I attached your résumé, but the page dropped it (sites sometimes clear an upload when the form re-renders), and attaching it again didn't stick."
      : "The résumé file chosen for this application isn't on this computer, so I couldn't attach it.";
    const where = renderOptions.handoffUrl ? "from the link below or in the agent's Chromium window" : "in the agent's Chromium window";
    const optional = event.question.required === false ? " The field is optional: reply SKIP to continue without a résumé." : "";
    const instruction = `Attach your résumé ${where}, then reply DONE in this thread.${optional}`;
    const link = renderOptions.handoffUrl ? `\n\nOpen the protected browser handoff: ${markdownText(renderOptions.handoffUrl, 500)}` : "";
    const body = `${problem}\n\n${instruction}${link}`;
    if (threadReplyOnly(renderOptions)) return { text: body, blocks: [{ type: "section", text: { type: "mrkdwn", text: body } }] };
    const text = `${markdownText(event.title, 160)}\n${markdownText(event.context.company, 160)} — ${markdownText(event.context.role, 200)}\n\n${body}`;
    return {
      text,
      blocks: [
        { type: "header", text: { type: "plain_text", text: safeText(event.title, 150) } },
        { type: "section", text: { type: "mrkdwn", text: body } },
      ],
    };
  }
  const section = event.context.section ? `\n\n*${markdownText(event.context.section, 160)}*` : "";
  const requiredness = event.question.required === true ? "Required field." : event.question.required === false ? "Optional field." : "";
  const uncertainty =
    event.descriptor?.confidence === "uncertain" ? "\n\n_The question context may be uncertain; review it before answering._" : "";
  const question = `${markdownText(event.question.prompt, 240)}${uncertainty}`;
  const postedCompensation = event.blockerType === "salary" ? formatPostedCompensation(event.context.postingCompensation) : undefined;
  const salaryContext =
    event.blockerType === "salary"
      ? postedCompensation
        ? `The job posting lists compensation of ${postedCompensation}.`
        : "No compensation range was found in the job posting."
      : "";
  const answerOptions =
    event.question.kind === "single_choice" && event.question.options.length > 0
      ? `Options: ${event.question.options.map((option) => markdownText(option.label, 200)).join(" / ")}`
      : "";
  const draftReview = event.draft
    ? [
        "Suggested answer generated locally for your review (not submitted):",
        `> ${markdownText(event.draft.answer, 512)}`,
        event.draft.evidence.length > 0 ? `Grounded in: ${event.draft.evidence.map((item) => markdownText(item, 120)).join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n")
    : "";
  const questionFraming =
    event.questionProvenance === "ATS_FORM"
      ? "Application question:"
      : event.questionProvenance === "APPLICATION_PREPARATION"
        ? "Career Agent needs this candidate fact before application execution:"
        : event.questionProvenance === "POLICY"
          ? "Career Agent needs your review before continuing:"
          : "Career Agent needs clarification before continuing:";
  const questionDetails = [
    event.questionProvenance === "ATS_FORM" ? requiredness : "",
    salaryContext,
    `${questionFraming}\n\"${question}\"`,
    answerOptions,
    draftReview,
    event.blockerType === "salary" ? "What should I enter?" : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const optionalNote = event.question.required === false && event.question.kind === "free_text"
    ? " This question is optional: reply SKIP to leave it blank."
    : "";
  const replyInstruction = (event.draft
    ? "\n\nReply APPROVE to use this draft, or reply with your edited answer. The draft is never used without your explicit approval."
    : event.question.kind === "free_text"
      ? "\n\nReply in this Slack thread with one grounded answer."
      : "") + (optionalNote && (event.draft || event.question.kind === "free_text") ? optionalNote : "");
  const threadReply = renderOptions.threadReply === true;
  const text = threadReply
    ? `${questionDetails}${replyInstruction}`
    : `${markdownText(event.title, 160)}\n${markdownText(event.context.company, 160)} — ${markdownText(event.context.role, 200)}${section}\n\n${questionDetails}${replyInstruction}`;
  const blocks: Record<string, unknown>[] = threadReply
    ? [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${questionDetails}${replyInstruction}`,
          },
        },
      ]
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
        // Slack caps button text at 75 characters; the button value is the
        // option id, so the full label is still what reaches the form.
        text: { type: "plain_text", text: safeText(option.label, 75) },
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
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum ? value.trim() : undefined;
}

const RICH_TEXT_CONTAINER_TYPES = new Set([
  "rich_text",
  "rich_text_section",
  "rich_text_list",
  "rich_text_quote",
  "rich_text_preformatted",
]);

/**
 * Slack may omit message.text for user-authored replies and put the visible
 * answer in a rich_text block instead. Only traverse known rich-text
 * containers and text elements; arbitrary block/action metadata is never
 * considered answer content.
 */
function richTextMessageValue(message: Record<string, unknown>, maximum: number): string | undefined {
  const blocks = message.blocks;
  if (!Array.isArray(blocks)) return undefined;
  const parts: string[] = [];

  const collect = (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const node = value as Record<string, unknown>;
    const type = typeof node.type === "string" ? node.type : undefined;
    if (type === "text") {
      if (typeof node.text === "string" && node.text.trim()) parts.push(node.text);
      return;
    }
    if (!type || !RICH_TEXT_CONTAINER_TYPES.has(type)) return;
    const elements = node.elements;
    if (Array.isArray(elements)) elements.forEach(collect);
  };

  blocks.forEach((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return;
    const candidate = block as Record<string, unknown>;
    if (candidate.type === "rich_text") collect(candidate);
  });
  return stringValue(parts.join(" "), maximum);
}

function slackErrorCode(value: unknown): string | undefined {
  const code = stringValue(value, 96);
  return code && /^[A-Za-z0-9_-]+$/.test(code) ? code : undefined;
}

/**
 * Server-only Slack adapter. It publishes small Block Kit messages and accepts
 * only Socket Mode button actions or thread replies from the configured
 * workspace/user/channel.
 */
export class SlackNotificationAdapter implements NotificationAdapter {
  private readonly config: SlackNotificationConfig;
  private readonly responseHandler?: SlackAttentionResponseHandler;
  private readonly submissionApprovalHandler?: SlackSubmissionApprovalHandler;
  private readonly eventLookup?: (eventId: string) => AttentionEvent | undefined;
  private readonly persistedAttentionEventsLookup?: SlackNotificationAdapterOptions["persistedAttentionEventsLookup"];
  private readonly fetcher: Fetcher;
  private readonly webSocketFactory: SlackWebSocketFactory;
  private readonly socketOpenTimeoutMs: number;
  private readonly socketReconnectDelayMs: number;
  private readonly diagnosticLogger: SlackDiagnosticLogger;
  private readonly handoffUrlForApplication?: SlackNotificationAdapterOptions["handoffUrlForApplication"];
  private readonly messageTimestamps = new Map<string, string>();
  /** Transport-local application conversation state; core remains Slack-agnostic. */
  private readonly applicationThreadRoots = new Map<string, { threaded: Set<string>; topLevel: Set<string> }>();
  private readonly threadEventIds = new Map<string, Set<string>>();
  /** Latest durable event snapshots used when a listener started before publication. */
  private readonly publishedAttentionEvents = new Map<string, PersistedAttentionEvent>();
  private socket?: SlackWebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopping = true;

  constructor(options: SlackNotificationAdapterOptions) {
    this.config = options.config;
    this.responseHandler = options.responseHandler;
    this.submissionApprovalHandler = options.submissionApprovalHandler;
    this.eventLookup = options.eventLookup;
    this.persistedAttentionEventsLookup = options.persistedAttentionEventsLookup;
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.socketOpenTimeoutMs = options.socketOpenTimeoutMs ?? 10_000;
    // Slack can briefly retain a Socket Mode connection after a process exits.
    // A one-second reconnect loop turns that cleanup window into a persistent
    // `too_many_websockets` storm, so use a calmer default while keeping tests
    // and callers able to inject a shorter delay.
    this.socketReconnectDelayMs = options.socketReconnectDelayMs ?? 10_000;
    this.diagnosticLogger = options.diagnosticLogger ?? {
      info: (message) => console.info(`[career-agent-slack] ${message}`),
      warn: (message) => console.warn(`[career-agent-slack] ${message}`),
    };
    this.handoffUrlForApplication = options.handoffUrlForApplication;
    if (!Number.isInteger(this.socketOpenTimeoutMs) || this.socketOpenTimeoutMs <= 0) {
      throw new Error("Slack Socket Mode connection timeout must be positive.");
    }
    if (!Number.isInteger(this.socketReconnectDelayMs) || this.socketReconnectDelayMs <= 0) {
      throw new Error("Slack Socket Mode reconnect delay must be positive.");
    }
  }

  async publishAttentionEvent(event: AttentionEvent): Promise<AttentionProviderDelivery | void> {
    if (event.status !== "open") return;
    const alreadyPublished = this.messageTimestamps.get(event.id);
    if (alreadyPublished) {
      const roots = event.applicationId ? this.applicationThreadRoots.get(event.applicationId) : undefined;
      const threadTs = roots && roots.threaded.size === 1 ? [...roots.threaded][0] : undefined;
      return {
        provider: "slack",
        messageTs: alreadyPublished,
        channelId: this.config.channelId,
        ...(threadTs ? { threadTs } : {}),
      };
    }
    const humanVerificationHandoff = event.submissionAlreadyClicked === true || event.blockerType === "captcha" ||
      (event.blockerType === "external_verification" && event.question && /verify whether the application was submitted/i.test(event.question.prompt));
    // A verification handoff is always a fresh top-level alert. This avoids
    // burying the action in an earlier question thread while preserving the
    // durable event/message correlation for restart-safe deduplication.
    const threadTs = event.applicationId && !humanVerificationHandoff ? this.applicationRootForPublishing(event.applicationId) : undefined;
    let handoffUrl: string | undefined;
    if (humanVerificationHandoff && this.handoffUrlForApplication) {
      if (!event.applicationId) {
        throw new Error("Slack human-verification handoff requires an application ID.");
      }
      handoffUrl = await this.handoffUrlForApplication(event.applicationId);
      if (!handoffUrl) {
        throw new Error("Slack human-verification handoff URL could not be created.");
      }
    }
    const message = eventMessage(event, { threadReply: Boolean(threadTs), ...(handoffUrl ? { handoffUrl } : {}) });
    const result = await this.callApi("chat.postMessage", this.config.botToken, {
      channel: this.config.channelId,
      text: message.text,
      blocks: message.blocks,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...(humanVerificationHandoff ? { unfurl_links: false, unfurl_media: false } : {}),
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

  /**
   * Reannounce one exact open event whose previous delivery was buried in a
   * stale thread. The durable event id remains unchanged; only the Slack
   * delivery correlation is replaced.
   */
  async reannounceAttentionEvent(event: AttentionEvent): Promise<AttentionProviderDelivery | void> {
    if (event.status !== "open") return;
    this.messageTimestamps.delete(event.id);
    if (event.applicationId) this.applicationThreadRoots.delete(event.applicationId);
    return this.publishAttentionEvent(event);
  }

  /** Start a new top-level Slack root while leaving historical reply correlations intact. */
  startFreshApplicationReview(applicationId: string): void {
    this.applicationThreadRoots.delete(applicationId);
  }

  async updateAttentionEvent(event: AttentionEvent): Promise<void> {
    const timestamp = this.messageTimestamps.get(event.id);
    if (!timestamp) throw new Error("Slack attention message is not available for update.");
    const rootTs = event.applicationId ? this.applicationRootForPublishing(event.applicationId) : undefined;
    const message = eventMessage(event, { threadReply: Boolean(rootTs && rootTs !== timestamp) });
    await this.callApi("chat.update", this.config.botToken, {
      channel: this.config.channelId,
      ts: timestamp,
      text: message.text,
      blocks: message.blocks,
    });
  }

  async closeAttentionEvent(event: AttentionEvent): Promise<void> {
    const timestamp = this.messageTimestamps.get(event.id);
    if (!timestamp) return;
    const answerUsed = event.answerUsed ? `\n\nAnswer used in application:\n> ${markdownText(event.answerUsed, 512)}` : "";
    await this.callApi("chat.update", this.config.botToken, {
      channel: this.config.channelId,
      ts: timestamp,
      text: `${safeText(event.title, 150)} — resolved${answerUsed}`,
      blocks: answerUsed
        ? [
            {
              type: "header",
              text: { type: "plain_text", text: safeText(event.title, 150) },
            },
            {
              type: "section",
              text: { type: "mrkdwn", text: `Resolved. The following answer was used in the application:${answerUsed}` },
            },
          ]
        : [],
    });
    this.forgetMessageTimestamp(event.id);
  }

  async publishExpiredSessionNotice(event: AttentionEvent): Promise<void> {
    const timestamp = this.messageTimestamps.get(event.id);
    const text = `${safeText(event.title, 150)}\n\nThe local browser session expired or closed before verification could be completed. No application submission was retried. Verify the application status manually in the employer's system; the Career Agent cannot confirm success.`;
    const blocks: Record<string, unknown>[] = [
      { type: "header", text: { type: "plain_text", text: safeText(event.title, 150) } },
      { type: "section", text: { type: "mrkdwn", text: "The local browser session expired or closed before verification could be completed.\n\nNo application submission was retried. Verify the application status manually in the employer's system; the Career Agent cannot confirm success." } },
    ];
    if (timestamp) {
      await this.callApi("chat.update", this.config.botToken, {
        channel: this.config.channelId,
        ts: timestamp,
        text,
        blocks,
      });
      return;
    }
    await this.callApi("chat.postMessage", this.config.botToken, {
      channel: this.config.channelId,
      text,
      blocks,
    });
  }

  /**
   * A reply under one of the agent's own messages that is not an open
   * question (a review or "not confirmed" notice) was silently ignored, so
   * the user waited for nothing. Say so in that thread and list what is open.
   */
  private async pointToOpenQuestions(threadTs: string): Promise<void> {
    // Questions this adapter posted plus those hydrated from durable state.
    const ids = new Set([...this.publishedAttentionEvents.keys(), ...[...this.threadEventIds.values()].flatMap((set) => [...set])]);
    const open = [...ids]
      .map((id) => this.eventLookup?.(id) ?? this.publishedAttentionEvents.get(id))
      .filter((event): event is AttentionEvent => Boolean(event && event.status === "open" && event.type === "needs_input" && event.question))
      .slice(0, 5)
      .map((event) => `• *${markdownText(event.context.company, 80)}*: ${markdownText(event.question!.prompt, 160)}`);
    const text = open.length > 0
      ? `I couldn't match this reply to an open question, so I didn't use it. Reply in the thread of the question you're answering:\n${open.join("\n")}`
      : "I couldn't match this reply to an open question, so I didn't use it. Nothing is waiting on you right now.";
    await this.callApi("chat.postMessage", this.config.botToken, { channel: this.config.channelId, thread_ts: threadTs, text });
  }

  /** Posts an informational message (inbox updates) that asks no question. */
  /** A link to one message in the configured channel, or undefined when Slack will not say. */
  async permalink(messageTs: string): Promise<string | undefined> {
    try {
      const query = new URLSearchParams({ channel: this.config.channelId, message_ts: messageTs });
      const response = await this.fetcher(`${this.config.apiBaseUrl}/chat.getPermalink?${query.toString()}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.config.botToken}` },
      });
      const data = responsePayload(await response.json()) as { ok?: boolean; permalink?: unknown } | undefined;
      return data?.ok && typeof data.permalink === "string" && /^https:\/\//.test(data.permalink) ? data.permalink : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Post the "Waiting on you" board as the newest message, then delete the
   * previous board, so the channel holds exactly one board, near the bottom.
   * Returns the new board's message timestamp.
   */
  async replaceWaitingBoard(board: { text: string; blocks: unknown[] }, previousTs?: string): Promise<string> {
    const result = await this.callApi("chat.postMessage", this.config.botToken, {
      channel: this.config.channelId, text: board.text, blocks: board.blocks, unfurl_links: false, unfurl_media: false,
    });
    const ts = typeof result.ts === "string" && result.ts.trim() ? result.ts.trim() : undefined;
    if (!ts) throw new Error("Slack chat.postMessage did not return a message timestamp.");
    if (previousTs && previousTs !== ts) {
      await this.callApi("chat.delete", this.config.botToken, { channel: this.config.channelId, ts: previousTs }).catch(async () => {
        await this.callApi("chat.update", this.config.botToken, {
          channel: this.config.channelId, ts: previousTs, text: "(An updated Waiting on you board is below.)", blocks: [],
        }).catch(() => undefined);
      });
    }
    return ts;
  }

  async publishInfoNotice(text: string): Promise<void> {
    await this.callApi("chat.postMessage", this.config.botToken, {
      channel: this.config.channelId,
      text: markdownText(text, 3_000),
      unfurl_links: false,
      unfurl_media: false,
    });
  }

  /** Posts a link-only notice for a queue row the agent will not open itself. */
  async publishQueueHandoffNotice(notice: QueueHandoffNotice): Promise<void> {
    let url: URL;
    try {
      url = new URL(notice.url);
    } catch {
      throw new Error("Queue handoff notice requires a valid HTTPS link.");
    }
    if (url.protocol !== "https:") throw new Error("Queue handoff notice requires a valid HTTPS link.");
    const title = "Career Agent needs you to open this application";
    const job = `${markdownText(notice.company, 160)} — ${markdownText(notice.role, 200)}`;
    const body = `${markdownText(notice.reason, 400)}\n\nOpen the listing yourself: ${markdownText(url.toString(), 500)}\n\nThe agent did not sign in, create an account, or fill anything on this page. Queue row: ${markdownText(notice.jobId, 120)}`;
    await this.callApi("chat.postMessage", this.config.botToken, {
      channel: this.config.channelId,
      text: `${title}\n${job}\n\n${body}`,
      blocks: [
        { type: "header", text: { type: "plain_text", text: title } },
        { type: "section", text: { type: "mrkdwn", text: `*${job}*\n\n${body}` } },
      ],
    });
  }

  /** Posts what the agent filled and one explicit Submit button for that exact application. */
  async publishSubmissionReview(notice: SubmissionReviewNotice): Promise<void> {
    const value = `${notice.campaignId}|${notice.jobId}|${notice.applicationId}`;
    if (!SUBMIT_ACTION_VALUE.test(value)) throw new Error("Submission review requires exact campaign, job, and application IDs.");
    const job = `${markdownText(notice.company, 160)} — ${markdownText(notice.role, 200)}`;
    const filled = notice.filled.slice(0, 40)
      .map((entry) => `• ${markdownText(entry.label, 80)}: ${entry.value ? `\`${markdownText(entry.value, 120).replace(/`/g, "'")}\`` : "_(empty)_"}`)
      .join("\n") || "_No filled fields were reported._";
    const blank = notice.leftBlank.length > 0
      ? `Left blank: ${notice.leftBlank.slice(0, 12).map((label) => markdownText(label, 60)).join(", ")}`
      : "Nothing was left blank.";
    const resume = notice.resumeFamily ? `Résumé: *${markdownText(notice.resumeFamily, 60)}*` : "";
    const text = `Ready to submit: ${job}\n\n${filled}\n\n${blank}`;
    await this.callApi("chat.postMessage", this.config.botToken, {
      channel: this.config.channelId,
      text,
      blocks: [
        { type: "header", text: { type: "plain_text", text: "Application ready to submit" } },
        { type: "section", text: { type: "mrkdwn", text: `*${job}*${resume ? `\n${resume}` : ""}` } },
        { type: "section", text: { type: "mrkdwn", text: filled.slice(0, 2900) } },
        { type: "context", elements: [{ type: "mrkdwn", text: blank.slice(0, 2900) }] },
        {
          type: "actions",
          elements: [{
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: "Submit application" },
            action_id: SUBMIT_ACTION_ID,
            value,
            confirm: {
              title: { type: "plain_text", text: "Submit this application?" },
              text: { type: "mrkdwn", text: `The agent will click Submit once for *${job}*. This can't be undone.` },
              confirm: { type: "plain_text", text: "Submit" },
              deny: { type: "plain_text", text: "Cancel" },
            },
          }],
        },
      ],
    });
  }

  private async handleSubmissionApproval(
    body: Record<string, unknown>,
    rawValue: string | undefined,
    actorIdentity: { provider: "slack"; userId: string; workspaceId?: string },
  ): Promise<SlackInteractionResult> {
    const match = rawValue?.match(SUBMIT_ACTION_VALUE);
    if (!match) return { status: "rejected", reason: "malformed_action_value" };
    if (!this.submissionApprovalHandler) return { status: "rejected", reason: "listener_not_ready" };
    const container = responsePayload(body.container);
    const message = responsePayload(body.message);
    const messageTs = stringValue(container?.message_ts, 64) ?? stringValue(message?.ts, 64);
    const update = async (text: string) => {
      if (!messageTs) return;
      await this.callApi("chat.update", this.config.botToken, {
        channel: this.config.channelId,
        ts: messageTs,
        text,
        blocks: [{ type: "section", text: { type: "mrkdwn", text: markdownText(text, 2900) } }],
      }).catch(() => undefined);
    };
    // Remove the button before the browser click so a second tap cannot queue.
    await update("Submitting… the agent is clicking Submit once for this application.");
    try {
      const result = await this.submissionApprovalHandler({ campaignId: match[1]!, jobId: match[2]!, applicationId: match[3]!, actorIdentity });
      await update(result.message);
      return { status: result.submitted ? "resolved" : "rejected", ...(result.submitted ? {} : { reason: "submission_not_completed" }) };
    } catch (error) {
      await update(`Not submitted: ${error instanceof Error ? error.message : "the submission was refused."}`);
      return { status: "rejected", reason: "submission_refused" };
    }
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
        // Cancelled records are retained for auditability, but their old
        // thread must not become the root for a new review after restart.
        // A resolved canonical threaded root remains useful for continuity;
        // an active open event can also anchor the next sequential question.
        if (event.status === "open" || (event.status === "resolved" && Boolean(delivery.threadTs))) {
          const rootTs = delivery.threadTs ?? delivery.messageTs;
          this.rememberApplicationRoot(event.applicationId, rootTs, Boolean(delivery.threadTs));
          this.rememberThreadEvent(rootTs, event.id);
        }
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
    this.stopping = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
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
    socket.onerror = () => {
      this.handleEstablishedSocketFailure(socket, "error");
    };
    socket.onclose = () => {
      this.handleEstablishedSocketFailure(socket, "close");
    };
  }

  stop(): void {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopping || this.socket) return;
      void this.start().catch(() => {
        if (!this.stopping) {
          this.diagnosticLogger.warn("Slack Socket Mode reconnect failed; retrying.");
          this.scheduleReconnect();
        }
      });
    }, this.socketReconnectDelayMs);
  }

  private handleEstablishedSocketFailure(socket: SlackWebSocket, reason: "close" | "error" | "disconnect"): void {
    if (this.socket !== socket || this.stopping) return;
    this.socket = undefined;
    this.diagnosticLogger.warn(`Slack Socket Mode connection ${reason === "close" ? "closed" : reason === "error" ? "errored" : "requested a disconnect"}; reconnecting.`);
    if (reason !== "close") socket.close();
    this.scheduleReconnect();
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
    const envelopeType = stringValue(envelope.type, 64);
    if (envelopeType === "hello") return;
    const payload = responsePayload(envelope.payload);
    if (!payload) {
      if (envelopeType === "disconnect") {
        const reason = stringValue(envelope.reason, 64) ?? "unknown";
        this.diagnosticLogger.info(`received Socket Mode disconnect (${reason})`);
        if (this.socket) this.handleEstablishedSocketFailure(this.socket, "disconnect");
        return;
      }
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
    if ((Array.isArray(message.files) && message.files.length > 0) || (Array.isArray(message.attachments) && message.attachments.length > 0)) {
      this.diagnosticLogger.info("ignored: message contains files or attachments");
      return;
    }
    const userId = stringValue(message.user, 128);
    const channelId = stringValue(message.channel, 128);
    const threadTs = stringValue(message.thread_ts, 128);
    const text = stringValue(message.text, 512) ?? richTextMessageValue(message, 512);
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
      await this.pointToOpenQuestions(threadTs).catch(() => {
        this.diagnosticLogger.warn("could not reply to an unmatched thread");
      });
      return;
    }
    // A listener can receive a reply for an event persisted by another
    // process. Keep the durable snapshot as a fallback when the injected
    // service lookup still has an older in-memory view.
    const events = [...eventIds]
      .map((eventId) => this.eventLookup?.(eventId) ?? this.publishedAttentionEvents.get(eventId))
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
    const roots = this.applicationThreadRoots.get(applicationId) ?? {
      threaded: new Set<string>(),
      topLevel: new Set<string>(),
    };
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
    if (Array.isArray(body.actions) && body.actions.length === 1 && responsePayload(body.actions[0])?.action_id === SUBMIT_ACTION_ID) {
      return this.handleSubmissionApproval(body, stringValue(responsePayload(body.actions[0])?.value, 256), {
        provider: "slack",
        userId,
        ...(teamId ? { workspaceId: teamId } : {}),
      });
    }
    if (!this.responseHandler || !Array.isArray(body.actions) || body.actions.length !== 1) {
      return { status: "rejected", reason: "listener_not_ready" };
    }
    const action = responsePayload(body.actions[0]);
    if (!action) return { status: "rejected", reason: "unexpected_action" };
    const actionId = typeof action.action_id === "string" && action.action_id.length <= 255 ? action.action_id : undefined;
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
    if (
      optionIndex !== undefined &&
      (!event?.question || event.question.kind !== "single_choice" || !event.question.options[optionIndex])
    ) {
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
    if (!result?.ok) {
      const errorCode = slackErrorCode(result?.error);
      throw new Error(`Slack ${method} was not accepted${errorCode ? ` (${errorCode})` : ""}.`);
    }
    return clone(result);
  }
}

export { ACTION_ID };
