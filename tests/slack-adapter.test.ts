import { describe, expect, it } from "vitest";
import {
  SlackConfigurationError,
  resolveSlackConfig,
} from "../application-agent/automation/slack/config";
import {
  ACTION_ID,
  SlackNotificationAdapter,
  type SlackInteractionResult,
} from "../application-agent/automation/slack/slackNotificationAdapter";
import type { AttentionEvent } from "../application-agent/src/domain/attention";

const config = {
  botToken: "bot-token-fixture",
  appToken: "app-token-fixture",
  channelId: "C123456",
  allowedUserId: "U123456",
  allowedTeamId: "T123456",
  apiBaseUrl: "https://slack.test/api",
};

function event(status: AttentionEvent["status"] = "open"): AttentionEvent {
  return {
    id: "attention-1",
    type: "needs_input",
    source: "career-agent",
    campaignId: "campaign-1",
    applicationId: "application-1",
    createdAt: "2026-09-01T12:00:00.000Z",
    status,
    title: "Career Agent needs input",
    context: {
      company: "H1",
      role: "Data Engineer",
      section: "Work Authorization",
    },
    question: {
      prompt: "Are you legally eligible to work in the US?",
      kind: "single_choice",
      options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
    },
    blockerType: "unknown_form_field",
  };
}

function response(status: "resolved" | "duplicate" = "resolved") {
  return async () => ({ status });
}

function slackResponse(actionValue = "attention-1|yes", overrides: Record<string, unknown> = {}) {
  return {
    type: "block_actions",
    user: { id: "U123456" },
    team: { id: "T123456" },
    channel: { id: "C123456" },
    actions: [{ action_id: ACTION_ID, value: actionValue }],
    ...overrides,
  };
}

describe("Slack human-attention adapter", () => {
  it("fails safely with an explicit missing-configuration list and no token echo", () => {
    expect(() => resolveSlackConfig({ ATELIER_SLACK_BOT_TOKEN: "bot-token-fixture-secret" })).toThrow(SlackConfigurationError);
    try {
      resolveSlackConfig({ ATELIER_SLACK_BOT_TOKEN: "bot-token-fixture-secret" });
    } catch (error) {
      expect(error).toBeInstanceOf(SlackConfigurationError);
      expect((error as Error).message).toContain("ATELIER_SLACK_APP_TOKEN");
      expect((error as Error).message).not.toContain("bot-token-fixture-secret");
    }
  });

  it("publishes a compact button message without internal blocker IDs", async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    const adapter = new SlackNotificationAdapter({
      config,
      fetcher: async (input, init) => {
        requests.push({ url: String(input), body: typeof init?.body === "string" ? init.body : undefined });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, ts: "1710000000.000001" }),
        } as Response;
      },
    });
    await adapter.publishAttentionEvent(event());
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("https://slack.test/api/chat.postMessage");
    expect(requests[0].body).toContain("Are you legally eligible to work in the US?");
    expect(requests[0].body).toContain("attention-1|yes");
    expect(requests[0].body).not.toContain("blocker-1");
  });

  it("communicates uncertain question context without exposing debug metadata", async () => {
    const requests: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      fetcher: async (_input, init) => {
        requests.push(typeof init?.body === "string" ? init.body : "");
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        } as Response;
      },
    });
    await adapter.publishAttentionEvent({
      ...event(),
      descriptor: { source: "nearby_text", confidence: "uncertain" },
    });
    expect(requests[0]).toContain("context may be uncertain");
    expect(requests[0]).not.toContain("nearby_text");
  });

  it("validates workspace, user, channel, event, and option before invoking core", async () => {
    const responses: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      eventLookup: (eventId) => eventId === "attention-1" ? event() : undefined,
      responseHandler: async (attentionResponse) => {
        responses.push(attentionResponse.selectedOption);
        return { status: "resolved" };
      },
    });
    const unauthorized = await adapter.handleInteraction(slackResponse("attention-1|yes", { user: { id: "U-other" } }));
    const wrongWorkspace = await adapter.handleInteraction(slackResponse("attention-1|yes", { team: { id: "T-other" } }));
    const wrongChannel = await adapter.handleInteraction(slackResponse("attention-1|yes", { channel: { id: "C-other" } }));
    const unknown = await adapter.handleInteraction(slackResponse("unknown|yes"));
    const invalidOption = await adapter.handleInteraction(slackResponse("attention-1|maybe"));
    expect([unauthorized, wrongWorkspace, wrongChannel, unknown, invalidOption].every((result) => result.status === "rejected")).toBe(true);
    expect(responses).toEqual([]);

    const accepted = await adapter.handleInteraction(slackResponse());
    expect(accepted).toEqual({ status: "resolved" });
    expect(responses).toEqual(["yes"]);
  });

  it("rejects closed events and preserves duplicate results from the idempotent core", async () => {
    const calls: string[] = [];
    const closedAdapter = new SlackNotificationAdapter({
      config,
      eventLookup: () => event("resolved"),
      responseHandler: async () => {
        calls.push("unexpected");
        return { status: "resolved" };
      },
    });
    expect((await closedAdapter.handleInteraction(slackResponse())).status).toBe("rejected");
    expect(calls).toEqual([]);

    const duplicateAdapter = new SlackNotificationAdapter({
      config,
      eventLookup: () => event(),
      responseHandler: response("duplicate"),
    });
    const duplicate: SlackInteractionResult = await duplicateAdapter.handleInteraction(slackResponse());
    expect(duplicate).toEqual({ status: "duplicate" });
  });

  it("acks Socket Mode envelopes and routes only interactive block actions", async () => {
    const sent: string[] = [];
    let socket: { onopen?: () => void; onmessage?: (message: { data: unknown }) => void; onerror?: (event: unknown) => void; onclose?: () => void; send(data: string): void; close(): void } | undefined;
    const adapter = new SlackNotificationAdapter({
      config,
      responseHandler: response(),
      fetcher: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, url: "wss://slack.test/socket" }),
      } as Response),
      webSocketFactory: () => {
        const nextSocket = {
          onopen: undefined as (() => void) | undefined,
          onmessage: undefined as ((message: { data: unknown }) => void) | undefined,
          onerror: undefined as ((event: unknown) => void) | undefined,
          onclose: undefined as (() => void) | undefined,
          send: (data: string) => { sent.push(data); },
          close: () => undefined,
        };
        socket = nextSocket;
        queueMicrotask(() => nextSocket.onopen?.());
        return nextSocket;
      },
    });
    await adapter.start();
    expect(socket).toBeDefined();
    await socket?.onmessage?.({
      data: JSON.stringify({
        envelope_id: "envelope-1",
        payload: slackResponse(),
      }),
    });
    expect(sent).toEqual([JSON.stringify({ envelope_id: "envelope-1" })]);
    adapter.stop();
  });
});
