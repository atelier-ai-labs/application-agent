import { describe, expect, it } from "vitest";
import {
  SlackConfigurationError,
  resolveSlackConfig,
} from "../application-agent/automation/slack/config";
import {
  ACTION_ID,
  SlackNotificationAdapter,
  type SlackDiagnosticLogger,
  type SlackInteractionResult,
} from "../application-agent/automation/slack/slackNotificationAdapter";
import type {
  AttentionEvent,
  AttentionProviderDelivery,
  PersistedAttentionEvent,
} from "../application-agent/src/domain/attention";

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
    questionProvenance: "ATS_FORM",
    question: {
      prompt: "Are you legally eligible to work in the US?",
      kind: "single_choice",
      options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
    },
    blockerType: "unknown_form_field",
  };
}

function configurationEvent(): AttentionEvent {
  return {
    id: "attention-configuration-1",
    type: "configuration_required",
    source: "career-agent",
    campaignId: "campaign-1",
    createdAt: "2026-09-01T12:00:00.000Z",
    status: "open",
    title: "⚠️ Career Agent needs setup",
    questionProvenance: "CONFIGURATION",
    context: { company: "Career Agent", role: "Profile setup" },
    message: "I can't evaluate jobs because your private profile has no resume families.",
    remediation: "Add at least one resume family to your local Career Agent profile, then rerun the campaign.",
    reasonCode: "missing_resume_family",
  };
}

function freeTextEvent(): AttentionEvent {
  return {
    ...event(),
    id: "attention-free-text-1",
    context: { company: "H1", role: "Data Engineer" },
    question: {
      prompt: "What compensation do you expect for this role?",
      kind: "free_text",
      options: [],
    },
    questionProvenance: "ATS_FORM",
    blockerType: "salary",
  };
}

function persistedFreeTextEvent(
  status: AttentionEvent["status"] = "open",
  delivery?: AttentionProviderDelivery,
): PersistedAttentionEvent {
  return {
    ...freeTextEvent(),
    status,
    jobId: "job-1",
    blockerId: "blocker-1",
    descriptorSignature: "salary:question",
    ...(delivery ? { providerDelivery: delivery, publishedAt: "2026-09-01T12:00:01.000Z" } : {}),
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

function diagnosticCapture(): { infos: string[]; warnings: string[]; logger: SlackDiagnosticLogger } {
  const infos: string[] = [];
  const warnings: string[] = [];
  return {
    infos,
    warnings,
    logger: {
      info: (message) => infos.push(message),
      warn: (message) => warnings.push(message),
    },
  };
}

function messageEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    envelope_id: "envelope-message-1",
    payload: {
      type: "event_callback",
      team_id: "T123456",
      event: {
        type: "message",
        user: "U123456",
        channel: "C123456",
        channel_type: "group",
        thread_ts: "1710000000.000002",
        ts: "1710000000.000003",
        text: "USD 150000 base salary",
        ...overrides,
      },
    },
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

  it("renders unique option-scoped action IDs and accepts each matching option", async () => {
    const requests: string[] = [];
    const responses: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      eventLookup: (eventId) => eventId === "attention-1" ? event() : undefined,
      responseHandler: async ({ selectedOption }) => {
        responses.push(selectedOption);
        return { status: "resolved" };
      },
      fetcher: async (_input, init) => {
        requests.push(typeof init?.body === "string" ? init.body : "");
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, ts: "1710000000.000001" }),
        } as Response;
      },
    });
    await adapter.publishAttentionEvent(event());

    const blocks = JSON.parse(requests[0]).blocks as Array<{ type: string; elements?: Array<{ action_id?: string }> }>;
    const actionIds = blocks.find((block) => block.type === "actions")?.elements?.map((element) => element.action_id);
    expect(actionIds).toEqual([`${ACTION_ID}_0`, `${ACTION_ID}_1`]);
    expect(new Set(actionIds).size).toBe(2);

    await expect(adapter.handleInteraction(slackResponse("attention-1|yes", {
      actions: [{ action_id: `${ACTION_ID}_0`, value: "attention-1|yes" }],
    }))).resolves.toEqual({ status: "resolved" });
    await expect(adapter.handleInteraction(slackResponse("attention-1|no", {
      actions: [{ action_id: `${ACTION_ID}_1`, value: "attention-1|no" }],
    }))).resolves.toEqual({ status: "resolved" });
    expect(responses).toEqual(["yes", "no"]);
  });

  it("keeps the legacy action ID compatible while rejecting unscoped or mismatched generated IDs", async () => {
    const adapter = new SlackNotificationAdapter({
      config,
      eventLookup: (eventId) => eventId === "attention-1" ? event() : undefined,
      responseHandler: response(),
    });
    await expect(adapter.handleInteraction(slackResponse("attention-1|yes"))).resolves.toEqual({ status: "resolved" });
    await expect(adapter.handleInteraction(slackResponse("attention-1|yes", {
      actions: [{ action_id: `${ACTION_ID}_1`, value: "attention-1|yes" }],
    }))).resolves.toEqual({ status: "rejected", reason: "invalid_option" });
    await expect(adapter.handleInteraction(slackResponse("attention-1|yes", {
      actions: [{ action_id: `${ACTION_ID}_x`, value: "attention-1|yes" }],
    }))).resolves.toEqual({ status: "rejected", reason: "unexpected_action" });
    await expect(adapter.handleInteraction(slackResponse("attention-1|yes", {
      actions: [{ action_id: "unrelated_action", value: "attention-1|yes" }],
    }))).resolves.toEqual({ status: "rejected", reason: "unexpected_action" });
  });

  it("publishes a bounded free-text question with a clear threaded-reply action", async () => {
    const requests: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      fetcher: async (_input, init) => {
        requests.push(typeof init?.body === "string" ? init.body : "");
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, ts: "1710000000.000002" }),
        } as Response;
      },
    });
    await adapter.publishAttentionEvent(freeTextEvent());
    expect(requests[0]).toContain("What compensation do you expect for this role?");
    expect(requests[0]).toContain("Reply in this Slack thread with one grounded answer.");
    expect(requests[0]).not.toContain('"type":"actions"');
  });

  it("labels preparation questions as Career Agent prerequisites, not employer questions", async () => {
    const requests: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      fetcher: async (_input, init) => {
        requests.push(typeof init?.body === "string" ? init.body : "");
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, ts: "1710000000.000005" }),
        } as Response;
      },
    });
    await adapter.publishAttentionEvent({
      ...freeTextEvent(),
      questionProvenance: "APPLICATION_PREPARATION",
      question: {
        prompt: "What is your general travel preference?",
        kind: "free_text",
        options: [],
      },
      blockerType: "travel",
    });
    expect(requests[0]).toContain("Career Agent needs this candidate fact before application execution:");
    expect(requests[0]).toContain("What is your general travel preference?");
    expect(requests[0]).not.toContain("Application question:");
  });

  it("renders exact field labels, questions, optionality, and structured options", async () => {
    const requests: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      fetcher: async (_input, init) => {
        requests.push(typeof init?.body === "string" ? init.body : "");
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, ts: "1710000000.000004" }),
        } as Response;
      },
    });
    await adapter.publishAttentionEvent({
      ...event(),
      blockerType: "demographic_disclosure",
      context: { company: "H1", role: "Data Engineer", section: "Voluntary Self-Identification" },
      question: {
        prompt: "What is your race or ethnicity?",
        fieldLabel: "Race / Ethnicity",
        required: false,
        kind: "single_choice",
        options: [
          { id: "asian-1", label: "Asian" },
          { id: "black-2", label: "Black or African American" },
          { id: "prefer-not-4", label: "Prefer not to answer" },
        ],
      },
    });
    expect(requests[0]).toContain("Field label: Race / Ethnicity");
    expect(requests[0]).toContain("Optional field.");
    expect(requests[0]).toContain("What is your race or ethnicity?");
    expect(requests[0]).toContain("Options: Asian / Black or African American / Prefer not to answer");
    expect(requests[0]).not.toContain("demographics");
  });

  it("publishes successive blockers for one application in one Slack thread", async () => {
    const requests: Array<{ body?: string }> = [];
    let sequence = 0;
    const adapter = new SlackNotificationAdapter({
      config,
      fetcher: async (_input, init) => {
        requests.push({ body: typeof init?.body === "string" ? init.body : undefined });
        sequence += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, ts: `1710000000.00000${sequence}` }),
        } as Response;
      },
    });
    const first = freeTextEvent();
    const second = { ...freeTextEvent(), id: "attention-free-text-2", question: { ...freeTextEvent().question!, prompt: "Why do you want this role?" } };
    const otherApplication = { ...second, id: "attention-free-text-3", applicationId: "application-2" };

    const firstDelivery = await adapter.publishAttentionEvent(first);
    const secondDelivery = await adapter.publishAttentionEvent(second);
    const otherDelivery = await adapter.publishAttentionEvent(otherApplication);

    expect(JSON.parse(requests[0].body ?? "{}").thread_ts).toBeUndefined();
    expect(JSON.parse(requests[1].body ?? "{}").thread_ts).toBe("1710000000.000001");
    expect(JSON.parse(requests[2].body ?? "{}").thread_ts).toBeUndefined();
    expect(firstDelivery).toEqual({ provider: "slack", messageTs: "1710000000.000001", channelId: "C123456" });
    expect(secondDelivery).toEqual({ provider: "slack", messageTs: "1710000000.000002", channelId: "C123456", threadTs: "1710000000.000001" });
    expect(otherDelivery).toEqual({ provider: "slack", messageTs: "1710000000.000003", channelId: "C123456" });
    expect(requests[1].body).toContain("Why do you want this role?");
    expect(requests[1].body).not.toContain("H1 — Data Engineer");
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
          json: async () => ({ ok: true, ts: "1710000000.000010" }),
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

  it("publishes a configuration notice without interactive answer controls", async () => {
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
    await adapter.publishAttentionEvent(configurationEvent());
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("no resume families");
    expect(requests[0]).toContain("Add at least one resume family");
    expect(requests[0]).not.toContain("actions");
    expect(requests[0]).not.toContain("missing_resume_family");
  });

  it("returns the Slack delivery timestamp for durable persistence", async () => {
    const adapter = new SlackNotificationAdapter({
      config,
      fetcher: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, ts: "1710000000.000011" }),
      } as Response),
    });
    await expect(adapter.publishAttentionEvent(freeTextEvent())).resolves.toEqual({
      provider: "slack",
      messageTs: "1710000000.000011",
      channelId: "C123456",
    });
  });

  it("does not create a correlation timestamp when Slack omits the message timestamp", async () => {
    const diagnostics = diagnosticCapture();
    const responses: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      diagnosticLogger: diagnostics.logger,
      eventLookup: () => freeTextEvent(),
      responseHandler: async () => {
        responses.push("unexpected");
        return { status: "resolved" };
      },
      fetcher: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as Response),
    });
    await expect(adapter.publishAttentionEvent(freeTextEvent())).rejects.toThrow("message timestamp");
    await adapter.handleSocketEnvelope(JSON.stringify(messageEnvelope()));
    expect(responses).toEqual([]);
    expect(diagnostics.infos).toContain("ignored: unmatched thread");
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

  it("refreshes a newly published durable event before accepting its button action", async () => {
    const durableEvents: PersistedAttentionEvent[] = [];
    const responses: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      // Simulate a runtime service that started before another process
      // published the current attention event.
      eventLookup: () => undefined,
      persistedAttentionEventsLookup: () => durableEvents,
      responseHandler: async ({ eventId, selectedOption }) => {
        responses.push(`${eventId}:${selectedOption}`);
        return { status: "resolved" };
      },
    });
    adapter.hydratePublishedAttentionEvents([]);
    durableEvents.push({
      ...event(),
      jobId: "job-1",
      blockerId: "blocker-1",
      descriptorSignature: "form:question",
      providerDelivery: { provider: "slack", messageTs: "1710000000.000001", channelId: "C123456" },
      publishedAt: "2026-09-01T12:00:01.000Z",
    });

    await expect(adapter.handleInteraction(slackResponse())).resolves.toEqual({ status: "resolved" });
    expect(responses).toEqual(["attention-1:yes"]);
  });

  it("routes an authorized free-text thread reply through the existing response core", async () => {
    const responses: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      eventLookup: (eventId) => eventId === "attention-free-text-1" ? freeTextEvent() : undefined,
      responseHandler: async (attentionResponse) => {
        responses.push(attentionResponse.selectedOption);
        return { status: "resolved" };
      },
      fetcher: async (_input, init) => {
        expect(typeof init?.body).toBe("string");
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, ts: "1710000000.000002" }),
        } as Response;
      },
    });
    await adapter.publishAttentionEvent(freeTextEvent());
    await adapter.handleSocketEnvelope(JSON.stringify({
      envelope_id: "envelope-free-text-1",
      payload: {
        type: "event_callback",
        team_id: "T123456",
        event: {
          type: "message",
          user: "U123456",
          channel: "C123456",
          channel_type: "group",
          thread_ts: "1710000000.000002",
          ts: "1710000000.000003",
          text: "USD 150000 base salary",
        },
      },
    }));
    expect(responses).toEqual(["USD 150000 base salary"]);
  });

  it.each([
    ["private", "group"],
    ["public", "channel"],
  ] as const)("accepts an authorized %s-channel thread reply", async (_label, channelType) => {
    const responses: string[] = [];
    const diagnostics = diagnosticCapture();
    const adapter = new SlackNotificationAdapter({
      config,
      diagnosticLogger: diagnostics.logger,
      eventLookup: (eventId) => eventId === "attention-free-text-1" ? freeTextEvent() : undefined,
      responseHandler: async (attentionResponse) => {
        responses.push(attentionResponse.selectedOption);
        return { status: "resolved" };
      },
      fetcher: async (_input, _init) => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, ts: "1710000000.000002" }),
      } as Response),
    });
    await adapter.publishAttentionEvent(freeTextEvent());
    await adapter.handleSocketEnvelope(JSON.stringify(messageEnvelope({ channel_type: channelType })));
    expect(responses).toEqual(["USD 150000 base salary"]);
    expect(diagnostics.infos).toContain(`received message event (${channelType})`);
    expect(diagnostics.infos).toContain("accepted response for attention event (resolved)");
    expect(diagnostics.infos).not.toContain("USD 150000 base salary");
  });

  it.each([
    ["wrong user", { user: "U-other" }, "wrong user"],
    ["wrong channel", { channel: "C-other" }, "wrong channel"],
    ["bot/self message", { bot_id: "B123456" }, "bot/self or subtype message"],
  ] as const)("does not route a %s message", async (_label, messageOverrides, diagnostic) => {
    const responses: string[] = [];
    const diagnostics = diagnosticCapture();
    const adapter = new SlackNotificationAdapter({
      config,
      diagnosticLogger: diagnostics.logger,
      eventLookup: () => freeTextEvent(),
      responseHandler: async () => {
        responses.push("unexpected");
        return { status: "resolved" };
      },
      fetcher: async (_input, _init) => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, ts: "1710000000.000002" }),
      } as Response),
    });
    await adapter.publishAttentionEvent(freeTextEvent());
    await adapter.handleSocketEnvelope(JSON.stringify(messageEnvelope(messageOverrides)));
    expect(responses).toEqual([]);
    expect(diagnostics.infos).toContain(`ignored: ${diagnostic}`);
  });

  it.each([
    ["unmatched thread", "1710000000.999999", "ignored: unmatched thread"],
    ["resolved event", "1710000000.000002", "ignored: attention event already resolved or stale"],
  ] as const)("rejects a %s safely", async (_label, threadTs, diagnostic) => {
    const responses: string[] = [];
    const diagnostics = diagnosticCapture();
    const adapter = new SlackNotificationAdapter({
      config,
      diagnosticLogger: diagnostics.logger,
      eventLookup: (eventId) => eventId === "attention-free-text-1"
        ? { ...freeTextEvent(), status: "resolved" }
        : undefined,
      responseHandler: async () => {
        responses.push("unexpected");
        return { status: "resolved" };
      },
      fetcher: async (_input, _init) => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, ts: "1710000000.000002" }),
      } as Response),
    });
    await adapter.publishAttentionEvent(freeTextEvent());
    await adapter.handleSocketEnvelope(JSON.stringify(messageEnvelope({ thread_ts: threadTs })));
    expect(responses).toEqual([]);
    expect(diagnostics.infos).toContain(diagnostic);
  });

  it("correlates a thread after adapter recreation when the durable timestamp is hydrated", async () => {
    const diagnostics = diagnosticCapture();
    const responses: string[] = [];
    const fetcher = async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, ts: "1710000000.000002" }),
    } as Response);
    const first = new SlackNotificationAdapter({ config, fetcher });
    const delivery = await first.publishAttentionEvent(freeTextEvent());
    expect(delivery).toBeDefined();
    const restarted = new SlackNotificationAdapter({
      config,
      diagnosticLogger: diagnostics.logger,
      eventLookup: () => freeTextEvent(),
      responseHandler: async () => {
        responses.push("resumed");
        return { status: "resolved" };
      },
    });
    restarted.hydratePublishedAttentionEvents([persistedFreeTextEvent("open", delivery as AttentionProviderDelivery)]);
    await restarted.handleSocketEnvelope(JSON.stringify(messageEnvelope()));
    expect(responses).toEqual(["resumed"]);
    expect(diagnostics.infos).toContain("hydrated 1 published attention event");
    expect(diagnostics.infos).toContain("accepted response for attention event (resolved)");
  });

  it("refreshes durable correlations so a newer open event in an existing application thread receives the reply", async () => {
    const rootDelivery: AttentionProviderDelivery = {
      provider: "slack",
      messageTs: "1710000000.000011",
      channelId: "C123456",
    };
    const newerId = "attention-free-text-2";
    const newer = {
      ...persistedFreeTextEvent("open", {
        provider: "slack",
        messageTs: "1710000000.000012",
        threadTs: rootDelivery.messageTs,
        channelId: "C123456",
      }),
      id: newerId,
    } satisfies PersistedAttentionEvent;
    const older = persistedFreeTextEvent("resolved", rootDelivery);
    const durableEvents: PersistedAttentionEvent[] = [older];
    const responses: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      eventLookup: (eventId) => durableEvents.find((candidate) => candidate.id === eventId),
      persistedAttentionEventsLookup: () => durableEvents,
      responseHandler: async ({ eventId }) => {
        responses.push(eventId);
        return { status: "resolved" };
      },
    });
    adapter.hydratePublishedAttentionEvents(durableEvents);

    durableEvents.push(newer);
    await adapter.handleSocketEnvelope(JSON.stringify(messageEnvelope({ thread_ts: rootDelivery.messageTs })));

    expect(responses).toEqual([newerId]);
  });

  it("hydrates a durable application thread and avoids a new root after restart", async () => {
    const firstDelivery: AttentionProviderDelivery = {
      provider: "slack",
      messageTs: "1710000000.000041",
      channelId: "C123456",
    };
    const secondDelivery: AttentionProviderDelivery = {
      provider: "slack",
      messageTs: "1710000000.000042",
      threadTs: "1710000000.000041",
      channelId: "C123456",
    };
    const second = { ...freeTextEvent(), id: "attention-free-text-2" };
    const requests: string[] = [];
    const responses: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      eventLookup: (eventId) => eventId === second.id ? second : undefined,
      responseHandler: async (attentionResponse) => {
        responses.push(attentionResponse.eventId);
        return { status: "resolved" };
      },
      fetcher: async (_input, init) => {
        requests.push(typeof init?.body === "string" ? init.body : "");
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, ts: "1710000000.000043" }),
        } as Response;
      },
    });
    adapter.hydratePublishedAttentionEvents([
      { ...persistedFreeTextEvent("resolved", firstDelivery), applicationId: "application-1" },
      { ...persistedFreeTextEvent("open", secondDelivery), id: second.id, applicationId: "application-1" },
    ]);
    await adapter.handleSocketEnvelope(JSON.stringify(messageEnvelope({ thread_ts: "1710000000.000041" })));
    expect(responses).toEqual([second.id]);

    const third = { ...second, id: "attention-free-text-3", question: { ...second.question!, prompt: "What is your notice period?" } };
    const thirdDelivery = await adapter.publishAttentionEvent(third);
    expect(JSON.parse(requests[0]).thread_ts).toBe("1710000000.000041");
    expect(thirdDelivery).toMatchObject({ threadTs: "1710000000.000041" });
  });

  it("prefers a canonical threaded root over a legacy top-level root after restart", async () => {
    const requests: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      fetcher: async (_input, init) => {
        requests.push(typeof init?.body === "string" ? init.body : "");
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, ts: "1710000000.000063" }),
        } as Response;
      },
    });
    const legacy = persistedFreeTextEvent("resolved", {
      provider: "slack",
      messageTs: "1710000000.000061",
      channelId: "C123456",
    });
    const olderLegacy = {
      ...legacy,
      id: "attention-free-text-legacy-2",
      providerDelivery: { ...legacy.providerDelivery!, messageTs: "1710000000.000060" },
    } satisfies PersistedAttentionEvent;
    const threaded = {
      ...persistedFreeTextEvent("resolved", {
        provider: "slack",
        messageTs: "1710000000.000062",
        threadTs: "1710000000.000062",
        channelId: "C123456",
      }),
      id: "attention-free-text-threaded",
      applicationId: legacy.applicationId,
    } satisfies PersistedAttentionEvent;
    adapter.hydratePublishedAttentionEvents([olderLegacy, legacy, threaded]);

    const next = { ...freeTextEvent(), id: "attention-free-text-next", applicationId: legacy.applicationId };
    const delivery = await adapter.publishAttentionEvent(next);

    expect(JSON.parse(requests[0]).thread_ts).toBe("1710000000.000062");
    expect(delivery).toMatchObject({ threadTs: "1710000000.000062" });
  });

  it("fails safely when one application thread has multiple active blockers", async () => {
    const diagnostics = diagnosticCapture();
    const first = persistedFreeTextEvent("open", {
      provider: "slack",
      messageTs: "1710000000.000051",
      channelId: "C123456",
    });
    const second = {
      ...persistedFreeTextEvent("open", {
        provider: "slack",
        messageTs: "1710000000.000052",
        threadTs: "1710000000.000051",
        channelId: "C123456",
      }),
      id: "attention-free-text-2",
    } satisfies PersistedAttentionEvent;
    const adapter = new SlackNotificationAdapter({
      config,
      diagnosticLogger: diagnostics.logger,
      eventLookup: (eventId) => eventId === first.id ? freeTextEvent() : eventId === second.id ? { ...freeTextEvent(), id: second.id } : undefined,
      responseHandler: async () => ({ status: "resolved" }),
    });
    adapter.hydratePublishedAttentionEvents([first, second]);
    await adapter.handleSocketEnvelope(JSON.stringify(messageEnvelope({ thread_ts: "1710000000.000051" })));
    expect(diagnostics.infos).toContain("ignored: ambiguous thread");
  });

  it.each(["resolved", "cancelled", "expired"] as const)("does not hydrate %s attention events as actionable", async (status) => {
    const diagnostics = diagnosticCapture();
    const responses: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      diagnosticLogger: diagnostics.logger,
      eventLookup: () => freeTextEvent(),
      responseHandler: async () => {
        responses.push("unexpected");
        return { status: "resolved" };
      },
    });
    adapter.hydratePublishedAttentionEvents([persistedFreeTextEvent(status, {
      provider: "slack",
      messageTs: "1710000000.000002",
      channelId: "C123456",
    })]);
    await adapter.handleSocketEnvelope(JSON.stringify(messageEnvelope()));
    expect(responses).toEqual([]);
    expect(diagnostics.infos).toContain("ignored: unmatched thread");
  });

  it("keeps multiple hydrated applications independently correlated and rejects timestamp collisions", async () => {
    const responses: string[] = [];
    const first = persistedFreeTextEvent("open", {
      provider: "slack",
      messageTs: "1710000000.000021",
      channelId: "C123456",
    });
    const second = {
      ...persistedFreeTextEvent("open", {
        provider: "slack",
        messageTs: "1710000000.000022",
        channelId: "C123456",
      }),
      id: "attention-free-text-2",
    } satisfies PersistedAttentionEvent;
    const adapter = new SlackNotificationAdapter({
      config,
      eventLookup: (eventId) => eventId === first.id ? freeTextEvent() : eventId === second.id ? { ...freeTextEvent(), id: second.id } : undefined,
      responseHandler: async (attentionResponse) => {
        responses.push(attentionResponse.eventId);
        return { status: "resolved" };
      },
    });
    adapter.hydratePublishedAttentionEvents([first, second]);
    await adapter.handleSocketEnvelope(JSON.stringify(messageEnvelope({ thread_ts: "1710000000.000021" })));
    await adapter.handleSocketEnvelope(JSON.stringify(messageEnvelope({ thread_ts: "1710000000.000022" })));
    expect(responses).toEqual([first.id, second.id]);

    const collisionDiagnostics = diagnosticCapture();
    const collisionAdapter = new SlackNotificationAdapter({
      config,
      diagnosticLogger: collisionDiagnostics.logger,
      eventLookup: () => freeTextEvent(),
      responseHandler: async () => {
        responses.push("collision");
        return { status: "resolved" };
      },
    });
    collisionAdapter.hydratePublishedAttentionEvents([
      first,
      { ...second, providerDelivery: { ...second.providerDelivery!, messageTs: first.providerDelivery!.messageTs } },
    ]);
    await collisionAdapter.handleSocketEnvelope(JSON.stringify(messageEnvelope({ thread_ts: first.providerDelivery!.messageTs })));
    expect(responses).toEqual([first.id, second.id]);
    expect(collisionDiagnostics.infos).toContain("ignored: ambiguous thread");
  });

  it("persists only bounded Slack delivery metadata, never message body or candidate response", () => {
    const delivery = persistedFreeTextEvent("open", {
      provider: "slack",
      messageTs: "1710000000.000031",
      channelId: "C123456",
    }).providerDelivery!;
    const serialized = JSON.stringify(delivery);
    expect(serialized).toContain("1710000000.000031");
    expect(serialized).toContain("C123456");
    expect(serialized).not.toContain("What compensation");
    expect(serialized).not.toContain("USD 150000");
  });

  it("keeps inbound message bodies out of diagnostics", async () => {
    const diagnostics = diagnosticCapture();
    const privateResponse = "PRIVATE CANDIDATE ANSWER MUST NOT BE LOGGED";
    const adapter = new SlackNotificationAdapter({
      config,
      diagnosticLogger: diagnostics.logger,
      eventLookup: () => freeTextEvent(),
      responseHandler: async () => ({ status: "resolved" }),
      fetcher: async (_input, _init) => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, ts: "1710000000.000002" }),
      } as Response),
    });
    await adapter.publishAttentionEvent(freeTextEvent());
    await adapter.handleSocketEnvelope(JSON.stringify(messageEnvelope({ text: privateResponse })));
    expect([...diagnostics.infos, ...diagnostics.warnings].join("\n")).not.toContain(privateResponse);
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
