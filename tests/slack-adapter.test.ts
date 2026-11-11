import { describe, expect, it } from "vitest";
import { SlackConfigurationError, resolveSlackConfig } from "../application-agent/automation/slack/config";
import {
  ACTION_ID,
  SlackNotificationAdapter,
  type SlackDiagnosticLogger,
  type SlackInteractionResult,
} from "../application-agent/automation/slack/slackNotificationAdapter";
import type { AttentionEvent, AttentionProviderDelivery, PersistedAttentionEvent } from "../application-agent/src/domain/attention";

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
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
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

function persistedFreeTextEvent(status: AttentionEvent["status"] = "open", delivery?: AttentionProviderDelivery): PersistedAttentionEvent {
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

const SUBMIT_IDS = {
  campaign: "campaign-83493d54-f0c4-416d-92ec-3d78848ce38c",
  job: "career-job-5031ff6a-36f0-4216-8364-00242349e2af",
  application: "application-2db1933e-dcd8-453f-9423-88dc0e0f5846",
};

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

function diagnosticCapture(): {
  infos: string[];
  warnings: string[];
  logger: SlackDiagnosticLogger;
} {
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
    expect(() =>
      resolveSlackConfig({
        ATELIER_SLACK_BOT_TOKEN: "bot-token-fixture-secret",
      }),
    ).toThrow(SlackConfigurationError);
    try {
      resolveSlackConfig({
        ATELIER_SLACK_BOT_TOKEN: "bot-token-fixture-secret",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(SlackConfigurationError);
      expect((error as Error).message).toContain("ATELIER_SLACK_APP_TOKEN");
      expect((error as Error).message).not.toContain("bot-token-fixture-secret");
    }
  });

  it("reports only a sanitized Slack API error code without exposing the token", async () => {
    const adapter = new SlackNotificationAdapter({
      config,
      fetcher: async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ ok: false, error: "invalid_auth" }),
        }) as Response,
    });

    const failure = await adapter.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Slack apps.connections.open was not accepted (invalid_auth).");
    expect((failure as Error).message).not.toContain(config.appToken);
  });

  it("publishes a compact button message without internal blocker IDs", async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    const adapter = new SlackNotificationAdapter({
      config,
      fetcher: async (input, init) => {
        requests.push({
          url: String(input),
          body: typeof init?.body === "string" ? init.body : undefined,
        });
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

  it("links the job posting under the title, and only a safe https link", async () => {
    // ElevenLabs (2026-11-10): the questions came with no way to read the job.
    const bodies: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      fetcher: async (_input, init) => {
        bodies.push(typeof init?.body === "string" ? init.body : "");
        return { ok: true, status: 200, json: async () => ({ ok: true, ts: "1710000000.000002" }) } as Response;
      },
    });
    const base = event();
    await adapter.publishAttentionEvent({ ...base, context: { ...base.context, postingUrl: "https://jobs.ashbyhq.com/elevenlabs/123" } });
    const blocks = JSON.parse(bodies[0]!).blocks as { type: string; elements?: { text: string }[] }[];
    expect(blocks[1]).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: "<https://jobs.ashbyhq.com/elevenlabs/123|View the job posting>" }] });
    await adapter.publishAttentionEvent({ ...base, id: "attention-2", context: { ...base.context, postingUrl: "javascript:alert(1)" } });
    expect(bodies[1]).not.toContain("View the job posting");
  });

  it("renders unique option-scoped action IDs and accepts each matching option", async () => {
    const requests: string[] = [];
    const responses: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      eventLookup: (eventId) => (eventId === "attention-1" ? event() : undefined),
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

    const blocks = JSON.parse(requests[0]).blocks as Array<{
      type: string;
      elements?: Array<{ action_id?: string }>;
    }>;
    const actionIds = blocks.find((block) => block.type === "actions")?.elements?.map((element) => element.action_id);
    expect(actionIds).toEqual([`${ACTION_ID}_0`, `${ACTION_ID}_1`]);
    expect(new Set(actionIds).size).toBe(2);

    await expect(
      adapter.handleInteraction(
        slackResponse("attention-1|yes", {
          actions: [{ action_id: `${ACTION_ID}_0`, value: "attention-1|yes" }],
        }),
      ),
    ).resolves.toEqual({ status: "resolved" });
    await expect(
      adapter.handleInteraction(
        slackResponse("attention-1|no", {
          actions: [{ action_id: `${ACTION_ID}_1`, value: "attention-1|no" }],
        }),
      ),
    ).resolves.toEqual({ status: "resolved" });
    expect(responses).toEqual(["yes", "no"]);
  });

  it("posts a résumé choice with one button per résumé and routes the tap", async () => {
    const choice: AttentionEvent = {
      id: "attention-resume-1", type: "resume_choice", source: "career-agent", campaignId: "campaign-1",
      createdAt: "2026-11-06T22:30:00.000Z", status: "open", title: "📄 Which résumé should I use?", questionProvenance: "POLICY",
      context: { company: "Span", role: "Platform Engineer" },
      question: { prompt: "This posting matches Cloud / Platform and AI Platform / Agentic equally.", kind: "single_choice",
        options: [{ id: "cloud-platform", label: "Cloud / Platform" }, { id: "ai-platform-agentic", label: "AI Platform / Agentic" }] },
    };
    const requests: string[] = [];
    const responses: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      eventLookup: (eventId) => (eventId === choice.id ? choice : undefined),
      responseHandler: async (input) => { responses.push(input.selectedOption); return { status: "resolved" }; },
      fetcher: async (_url, init) => { requests.push(String(init?.body ?? "")); return new Response(JSON.stringify({ ok: true, ts: "1700000000.000100" }), { status: 200 }); },
    });
    const delivery = await adapter.publishAttentionEvent(choice);
    expect(delivery).toMatchObject({ messageTs: "1700000000.000100" });
    const body = JSON.parse(requests[0]!) as { text: string; blocks: Array<{ type: string; elements?: Array<{ text: { text: string }; value: string }> }> };
    expect(body.text).toContain("Span");
    expect(body.blocks.find((block) => block.type === "actions")?.elements?.map((element) => element.text.text)).toEqual(["Cloud / Platform", "AI Platform / Agentic"]);
    await expect(adapter.handleInteraction(slackResponse("attention-resume-1|ai-platform-agentic", {
      actions: [{ action_id: `${ACTION_ID}_1`, value: "attention-resume-1|ai-platform-agentic" }],
    }))).resolves.toEqual({ status: "resolved" });
    await expect(adapter.handleInteraction(slackResponse("attention-resume-1|frontend-software"))).resolves.toEqual({ status: "rejected", reason: "invalid_option" });
    expect(responses).toEqual(["ai-platform-agentic"]);
  });

  it("keeps the legacy action ID compatible while rejecting unscoped or mismatched generated IDs", async () => {
    const adapter = new SlackNotificationAdapter({
      config,
      eventLookup: (eventId) => (eventId === "attention-1" ? event() : undefined),
      responseHandler: response(),
    });
    await expect(adapter.handleInteraction(slackResponse("attention-1|yes"))).resolves.toEqual({ status: "resolved" });
    await expect(
      adapter.handleInteraction(
        slackResponse("attention-1|yes", {
          actions: [{ action_id: `${ACTION_ID}_1`, value: "attention-1|yes" }],
        }),
      ),
    ).resolves.toEqual({ status: "rejected", reason: "invalid_option" });
    await expect(
      adapter.handleInteraction(
        slackResponse("attention-1|yes", {
          actions: [{ action_id: `${ACTION_ID}_x`, value: "attention-1|yes" }],
        }),
      ),
    ).resolves.toEqual({ status: "rejected", reason: "unexpected_action" });
    await expect(
      adapter.handleInteraction(
        slackResponse("attention-1|yes", {
          actions: [{ action_id: "unrelated_action", value: "attention-1|yes" }],
        }),
      ),
    ).resolves.toEqual({ status: "rejected", reason: "unexpected_action" });
  });

  it("posts a pre-submit review with one confirm-gated Submit button for the exact application", async () => {
    const requests: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      fetcher: async (_input, init) => {
        requests.push(typeof init?.body === "string" ? init.body : "");
        return { ok: true, status: 200, json: async () => ({ ok: true, ts: "1710000000.000010" }) } as Response;
      },
    });
    // The card's ts lets the Waiting on you board link to it.
    await expect(adapter.publishSubmissionReview({
      campaignId: SUBMIT_IDS.campaign, jobId: SUBMIT_IDS.job, applicationId: SUBMIT_IDS.application,
      company: "Changeis, Inc.", role: "Junior Cloud Engineer", resumeFamily: "cloud-platform",
      filled: [{ label: "ZIP code", value: "15057" }], leftBlank: ["Street (optional)"],
    })).resolves.toBe("1710000000.000010");
    const body = JSON.parse(requests[0]!);
    expect(JSON.stringify(body)).toContain("ZIP code");
    expect(JSON.stringify(body)).toContain("15057");
    const button = body.blocks.find((block: { type: string }) => block.type === "actions").elements[0];
    expect(button.action_id).toBe("career_agent_submit_prepared");
    expect(button.value).toBe(`${SUBMIT_IDS.campaign}|${SUBMIT_IDS.job}|${SUBMIT_IDS.application}`);
    expect(button.confirm.confirm.text).toBe("Submit");
    await expect(adapter.publishSubmissionReview({
      campaignId: "campaign-x", jobId: SUBMIT_IDS.job, applicationId: SUBMIT_IDS.application, company: "A", role: "B", filled: [], leftBlank: [],
    })).rejects.toThrow("exact campaign");
  });

  it("runs the Submit approval only for the configured user and an exact target, removing the button first", async () => {
    const requests: string[] = [];
    const approvals: unknown[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      fetcher: async (_input, init) => {
        requests.push(typeof init?.body === "string" ? init.body : "");
        return { ok: true, status: 200, json: async () => ({ ok: true, ts: "1710000000.000010" }) } as Response;
      },
      submissionApprovalHandler: async (approval) => {
        approvals.push(approval);
        return { submitted: true, message: "Submitted: Changeis, Inc. — Junior Cloud Engineer." };
      },
    });
    const value = `${SUBMIT_IDS.campaign}|${SUBMIT_IDS.job}|${SUBMIT_IDS.application}`;
    const click = (overrides: Record<string, unknown> = {}) => slackResponse(value, {
      actions: [{ action_id: "career_agent_submit_prepared", value }],
      container: { message_ts: "1710000000.000010" },
      ...overrides,
    });

    await expect(adapter.handleInteraction(click({ user: { id: "U999999" } }))).resolves.toMatchObject({ status: "rejected", reason: "unauthorized_user" });
    await expect(adapter.handleInteraction(click({ channel: { id: "C999999" } }))).resolves.toMatchObject({ status: "rejected", reason: "unexpected_channel" });
    await expect(adapter.handleInteraction(slackResponse("campaign-x|y|z", { actions: [{ action_id: "career_agent_submit_prepared", value: "campaign-x|y|z" }] })))
      .resolves.toMatchObject({ status: "rejected", reason: "malformed_action_value" });
    expect(approvals).toHaveLength(0);

    await expect(adapter.handleInteraction(click())).resolves.toEqual({ status: "resolved" });
    expect(approvals).toEqual([{ campaignId: SUBMIT_IDS.campaign, jobId: SUBMIT_IDS.job, applicationId: SUBMIT_IDS.application, actorIdentity: { provider: "slack", userId: "U123456", workspaceId: "T123456" } }]);
    // First update removes the button before the click; the second reports the result.
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain("Submitting");
    expect(requests[0]).not.toContain("career_agent_submit_prepared");
    expect(requests[1]).toContain("Submitted: Changeis");
  });

  it("reports a refused Submit approval without claiming success", async () => {
    const requests: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      fetcher: async (_input, init) => {
        requests.push(typeof init?.body === "string" ? init.body : "");
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      },
      submissionApprovalHandler: async () => { throw new Error("Submit requires the retained real local execution to be ready_to_submit."); },
    });
    const value = `${SUBMIT_IDS.campaign}|${SUBMIT_IDS.job}|${SUBMIT_IDS.application}`;
    await expect(adapter.handleInteraction(slackResponse(value, { actions: [{ action_id: "career_agent_submit_prepared", value }], container: { message_ts: "1.2" } })))
      .resolves.toMatchObject({ status: "rejected", reason: "submission_refused" });
    expect(requests.at(-1)).toContain("Not submitted");
  });

  it("posts a link-only queue handoff notice and rejects non-HTTPS links", async () => {
    const requests: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      fetcher: async (_input, init) => {
        requests.push(typeof init?.body === "string" ? init.body : "");
        return { ok: true, status: 200, json: async () => ({ ok: true, ts: "1710000000.000009" }) } as Response;
      },
    });
    await adapter.publishQueueHandoffNotice({ jobId: "tracker-url:1", company: "Acme <Corp>", role: "Engineer", url: "https://builtin.com/job/engineer/1", reason: "The listing site requires you to log in or create an account before applying." });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("https://builtin.com/job/engineer/1");
    expect(requests[0]).toContain("Acme &lt;Corp&gt;");
    expect(requests[0]).toContain("did not sign in, create an account, or fill anything");
    expect(requests[0]).not.toContain('"type":"actions"');
    await expect(adapter.publishQueueHandoffNotice({ jobId: "x", company: "A", role: "B", url: "http://insecure.example/job", reason: "r" })).rejects.toThrow("HTTPS");
    expect(requests).toHaveLength(1);
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

  it("tells the user an optional free-text question can be skipped", async () => {
    const requests: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      fetcher: async (_input, init) => {
        requests.push(typeof init?.body === "string" ? init.body : "");
        return { ok: true, status: 200, json: async () => ({ ok: true, ts: "1710000000.000003" }) } as Response;
      },
    });
    const event = freeTextEvent();
    await adapter.publishAttentionEvent({ ...event, question: { ...event.question!, required: false } });
    expect(requests[0]).toContain("This question is optional: reply SKIP to leave it blank.");
  });

  it("asks to attach a dropped résumé instead of asking for a text answer", async () => {
    const requests: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      fetcher: async (_input, init) => {
        requests.push(typeof init?.body === "string" ? init.body : "");
        return { ok: true, status: 200, json: async () => ({ ok: true, ts: "1710000000.000004" }) } as Response;
      },
    });
    const event = freeTextEvent();
    await adapter.publishAttentionEvent({ ...event, blockerType: "resume_missing", question: { ...event.question!, prompt: "Résumé", required: false } });
    expect(requests[0]).toContain("the page dropped it");
    expect(requests[0]).toContain("then reply DONE");
    expect(requests[0]).toContain("reply SKIP to continue without a résumé");
    expect(requests[0]).not.toContain("one grounded answer");
  });

  it("reannounces one buried open question as a fresh top-level message", async () => {
    const requests: string[] = [];
    let sequence = 1;
    const adapter = new SlackNotificationAdapter({
      config,
      fetcher: async (_input, init) => {
        requests.push(typeof init?.body === "string" ? init.body : "");
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, ts: `1710000000.00000${sequence++}` }),
        } as Response;
      },
    });
    const original = await adapter.publishAttentionEvent(event());
    const reannounced = await adapter.reannounceAttentionEvent(event());
    expect(original?.messageTs).toBe("1710000000.000001");
    expect(reannounced?.messageTs).toBe("1710000000.000002");
    expect(JSON.parse(requests[1]).thread_ts).toBeUndefined();
  });

  it("renders a local answer draft as review material and keeps approval explicit", async () => {
    const requests: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      fetcher: async (_input, init) => {
        requests.push(typeof init?.body === "string" ? init.body : "");
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, ts: "1710000000.000006" }),
        } as Response;
      },
    });
    await adapter.publishAttentionEvent({
      ...freeTextEvent(),
      question: {
        prompt: "Tell us about a difficult technical problem you solved.",
        kind: "free_text",
        options: [],
      },
      blockerType: "subjective_answer",
      draft: {
        answer: "I improved service observability by adding runbooks and operational checks.",
        evidence: ["Employment history — Platform Engineer at Example Labs"],
        provider: "ollama",
      },
    });
    expect(requests[0]).toContain("Application question:");
    expect(requests[0]).toContain("Tell us about a difficult technical problem you solved.");
    expect(requests[0]).toContain("Suggested answer generated locally for your review (not submitted):");
    expect(requests[0]).toContain("I improved service observability by adding runbooks and operational checks.");
    expect(requests[0]).toContain("Tap *Approve draft* (or reply APPROVE) to use this draft, or reply with your edited answer.");
    expect(requests[0]).not.toContain("Your answer is");
    // The word it asks for is a button too.
    const blocks = JSON.parse(requests[0]!).blocks as { type: string; elements?: { action_id: string; value: string; text: { text: string } }[] }[];
    const actions = blocks.find((block) => block.type === "actions");
    expect(actions?.elements?.map((element) => [element.action_id, element.text.text])).toEqual([["career_agent_quick_reply_APPROVE", "Approve draft"]]);
  });

  it("updates an existing Slack attention message in place when a draft is backfilled", async () => {
    const requests: { input: string; body: string }[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      fetcher: async (input, init) => {
        requests.push({ input: String(input), body: typeof init?.body === "string" ? init.body : "" });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, ts: "1710000000.000007" }),
        } as Response;
      },
    });
    const original = {
      ...freeTextEvent(),
      id: "attention-backfill-1",
      question: {
        prompt: "Please tell us your story, what has you looking for a new role?",
        kind: "free_text" as const,
        options: [],
      },
      blockerType: "subjective_answer" as const,
    };
    await adapter.publishAttentionEvent(original);
    await adapter.updateAttentionEvent({
      ...original,
      draft: {
        answer: "I am looking for a role where I can keep growing as an engineer.",
        evidence: ["Employment history — Platform Engineer at Example Labs"],
        provider: "ollama",
      },
    });

    expect(requests).toHaveLength(2);
    expect(requests[0].input).toContain("chat.postMessage");
    expect(requests[1].input).toContain("chat.update");
    expect(requests[1].body).toContain("I am looking for a role where I can keep growing as an engineer.");
    expect(requests[1].body).toContain("Tap *Approve draft* (or reply APPROVE) to use this draft, or reply with your edited answer.");
    expect(requests[1].body).not.toContain("chat.postMessage");
  });

  it("keeps the exact accepted answer visible when closing an attention message", async () => {
    const requests: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      fetcher: async (_input, init) => {
        requests.push(typeof init?.body === "string" ? init.body : "");
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, ts: "1710000000.000008" }),
        } as Response;
      },
    });
    const event = { ...freeTextEvent(), id: "attention-answer-used-1" };
    await adapter.publishAttentionEvent(event);
    await adapter.closeAttentionEvent({
      ...event,
      status: "resolved",
      answerUsed: "I am looking for a role where I can keep growing as an engineer.",
    });

    expect(requests[1]).toContain("Answer used in application");
    expect(requests[1]).toContain("I am looking for a role where I can keep growing as an engineer.");
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

  it("keeps internal field labels out of Slack while preserving the exact question, optionality, and options", async () => {
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
      context: {
        company: "H1",
        role: "Data Engineer",
        section: "Voluntary Self-Identification",
      },
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
    expect(requests[0]).not.toContain("Field label: Race / Ethnicity");
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
        requests.push({
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        sequence += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, ts: `1710000000.00000${sequence}` }),
        } as Response;
      },
    });
    const first = freeTextEvent();
    const second = {
      ...freeTextEvent(),
      id: "attention-free-text-2",
      question: {
        ...freeTextEvent().question!,
        prompt: "Why do you want this role?",
      },
    };
    const otherApplication = {
      ...second,
      id: "attention-free-text-3",
      applicationId: "application-2",
    };

    const firstDelivery = await adapter.publishAttentionEvent(first);
    const secondDelivery = await adapter.publishAttentionEvent(second);
    const otherDelivery = await adapter.publishAttentionEvent(otherApplication);

    expect(JSON.parse(requests[0].body ?? "{}").thread_ts).toBeUndefined();
    expect(JSON.parse(requests[1].body ?? "{}").thread_ts).toBe("1710000000.000001");
    expect(JSON.parse(requests[2].body ?? "{}").thread_ts).toBeUndefined();
    expect(firstDelivery).toEqual({
      provider: "slack",
      messageTs: "1710000000.000001",
      channelId: "C123456",
    });
    expect(secondDelivery).toEqual({
      provider: "slack",
      messageTs: "1710000000.000002",
      channelId: "C123456",
      threadTs: "1710000000.000001",
    });
    expect(otherDelivery).toEqual({
      provider: "slack",
      messageTs: "1710000000.000003",
      channelId: "C123456",
    });
    expect(requests[1].body).toContain("Why do you want this role?");
    expect(requests[1].body).not.toContain("H1 — Data Engineer");
  });

  it("publishes CAPTCHA handoffs as one fresh top-level alert and routes DONE", async () => {
    const requests: string[] = [];
    const responses: string[] = [];
    const captchaEvent: AttentionEvent = {
      ...freeTextEvent(),
      id: "attention-captcha-1",
      blockerType: "captcha",
      question: { prompt: "Verify you are human", kind: "free_text", options: [] },
    };
    const adapter = new SlackNotificationAdapter({
      config,
      eventLookup: (eventId) => eventId === captchaEvent.id ? captchaEvent : undefined,
      responseHandler: async ({ selectedOption }) => {
        responses.push(selectedOption);
        return { status: "resolved" };
      },
      fetcher: async (_input, init) => {
        requests.push(typeof init?.body === "string" ? init.body : "");
        return { ok: true, status: 200, json: async () => ({ ok: true, ts: "1710000000.000099" }) } as Response;
      },
      handoffUrlForApplication: async () => "https://sample.trycloudflare.com/handoff#token=redacted",
    });

    await adapter.publishAttentionEvent(captchaEvent);
    await adapter.publishAttentionEvent(captchaEvent);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0]).thread_ts).toBeUndefined();
    expect(JSON.parse(requests[0]).text).toContain("reply DONE");
    // The handoff link is view-only; the message sends the user to the real window.
    expect(JSON.parse(requests[0]).text).toContain("agent's Chromium window");
    expect(JSON.parse(requests[0]).text).toContain("works on your phone");
    expect(JSON.parse(requests[0]).text).toContain("Open the protected browser handoff");
    expect(JSON.parse(requests[0]).text).not.toContain("open local browser");
    expect(JSON.parse(requests[0]).text).not.toContain("No interactive browser link is provided");
    expect(JSON.parse(requests[0]).unfurl_links).toBe(false);
    expect(JSON.parse(requests[0]).unfurl_media).toBe(false);

    await adapter.handleSocketEnvelope(JSON.stringify(messageEnvelope({
      thread_ts: "1710000000.000099",
      text: "DONE",
    })));
    expect(responses).toEqual(["DONE"]);
  });

  it("offers Done / Skip as buttons where the message asks for the word, and shows the tap right away", async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const responses: string[] = [];
    const captchaEvent: AttentionEvent = {
      ...freeTextEvent(), id: "attention-captcha-2", blockerType: "captcha",
      question: { prompt: "Verify you are human", kind: "free_text", options: [] },
    };
    const optionalEvent: AttentionEvent = {
      ...freeTextEvent(), id: "attention-optional-2", blockerType: "subjective_answer",
      question: { prompt: "What made you decide to apply?", kind: "free_text", options: [], required: false },
    };
    const events = new Map([captchaEvent, optionalEvent].map((event) => [event.id, event]));
    const adapter = new SlackNotificationAdapter({
      config,
      eventLookup: (eventId) => events.get(eventId),
      responseHandler: async ({ selectedOption }) => { responses.push(selectedOption); return { status: "resolved" }; },
      fetcher: async (input, init) => {
        requests.push({ url: String(input), body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") });
        return { ok: true, status: 200, json: async () => ({ ok: true, ts: `1710000000.0001${requests.length}` }) } as Response;
      },
      handoffUrlForApplication: async () => "https://sample.trycloudflare.com/handoff#token=redacted",
    });
    const buttons = (body: Record<string, unknown>) => ((body.blocks as { type: string; elements?: { action_id: string }[] }[])
      .find((block) => block.type === "actions")?.elements ?? []).map((element) => element.action_id);

    await adapter.publishAttentionEvent(captchaEvent);
    expect(buttons(requests[0]!.body)).toEqual(["career_agent_quick_reply_DONE"]);
    await adapter.publishAttentionEvent(optionalEvent);
    expect(buttons(requests[1]!.body)).toEqual(["career_agent_quick_reply_SKIP"]);

    // A word the message didn't offer is refused; the offered one goes through like a typed reply.
    expect(await adapter.handleInteraction(slackResponse("attention-captcha-2|APPROVE", { actions: [{ action_id: "career_agent_quick_reply_APPROVE", value: "attention-captcha-2|APPROVE" }] })))
      .toEqual({ status: "rejected", reason: "invalid_option" });
    expect(await adapter.handleInteraction(slackResponse("", { actions: [{ action_id: "career_agent_quick_reply_DONE", value: "attention-captcha-2|DONE" }] })))
      .toEqual({ status: "resolved" });
    expect(responses).toEqual(["DONE"]);
    const update = requests.find((request) => request.url.endsWith("chat.update"));
    expect(JSON.stringify(update?.body)).toContain("You chose *Done*");
    expect(buttons(update!.body)).toEqual([]);
  });

  it("does not post a human-verification alert when its configured handoff URL is unavailable", async () => {
    const requests: string[] = [];
    const captchaEvent: AttentionEvent = {
      ...freeTextEvent(),
      id: "attention-captcha-no-handoff",
      blockerType: "captcha",
      question: { prompt: "Verify you are human", kind: "free_text", options: [] },
    };
    const adapter = new SlackNotificationAdapter({
      config,
      fetcher: async (_input, init) => {
        requests.push(typeof init?.body === "string" ? init.body : "");
        return { ok: true, status: 200, json: async () => ({ ok: true, ts: "1710000000.000099" }) } as Response;
      },
      handoffUrlForApplication: async () => undefined,
    });

    await expect(adapter.publishAttentionEvent(captchaEvent)).rejects.toThrow(
      "Slack human-verification handoff URL could not be created",
    );
    expect(requests).toHaveLength(0);
  });

  it("updates the handoff with an expired-session warning without claiming success", async () => {
    const requests: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      fetcher: async (input, init) => {
        requests.push(`${String(input)} ${typeof init?.body === "string" ? init.body : ""}`);
        return { ok: true, status: 200, json: async () => ({ ok: true, ts: "1710000000.000100" }) } as Response;
      },
    });
    const captchaEvent: AttentionEvent = {
      ...freeTextEvent(),
      id: "attention-expired-1",
      blockerType: "captcha",
      question: { prompt: "Verify you are human", kind: "free_text", options: [] },
    };
    await adapter.publishAttentionEvent(captchaEvent);
    await adapter.publishExpiredSessionNotice(captchaEvent);
    expect(requests[1]).toContain("chat.update");
    expect(requests[1]).toContain("session expired");
    expect(requests[1]).toContain("No application submission was retried");
    expect(requests[1]).not.toContain("application received");
  });

  it("starts the next answered blocker at a fresh top-level root after a stale review", async () => {
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
          json: async () => ({ ok: true, ts: `1710000000.00001${sequence}` }),
        } as Response;
      },
    });

    await adapter.publishAttentionEvent(freeTextEvent());
    adapter.startFreshApplicationReview("application-1");
    await adapter.publishAttentionEvent({
      ...freeTextEvent(),
      id: "attention-free-text-next",
      question: { ...freeTextEvent().question!, prompt: "How many years of experience do you have?" },
    });

    expect(JSON.parse(requests[0].body ?? "{}").thread_ts).toBeUndefined();
    expect(JSON.parse(requests[1].body ?? "{}").thread_ts).toBeUndefined();
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
      fetcher: async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, ts: "1710000000.000011" }),
        }) as Response,
    });
    await expect(adapter.publishAttentionEvent(freeTextEvent())).resolves.toEqual({
      provider: "slack",
      messageTs: "1710000000.000011",
      channelId: "C123456",
    });
  });

  it("answers a reply in a non-question thread instead of ignoring it silently", async () => {
    const requests: Record<string, unknown>[] = [];
    const responses: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      eventLookup: () => freeTextEvent(),
      responseHandler: async () => {
        responses.push("unexpected");
        return { status: "resolved" };
      },
      fetcher: async (_input, init) => {
        requests.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
        return { ok: true, status: 200, json: async () => ({ ok: true, ts: "1710000000.000002" }) } as Response;
      },
    });
    await adapter.publishAttentionEvent(freeTextEvent());
    // "skip" posted under a different message (a review or "not confirmed" notice).
    await adapter.handleSocketEnvelope(JSON.stringify(messageEnvelope({ thread_ts: "1710000000.999999", text: "skip" })));

    expect(responses).toEqual([]);
    const reply = requests.at(-1)!;
    expect(reply.thread_ts).toBe("1710000000.999999");
    expect(String(reply.text)).toContain("couldn't match this reply");
    expect(String(reply.text)).toContain("What compensation do you expect for this role?");
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
      fetcher: async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        }) as Response,
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
      eventLookup: (eventId) => (eventId === "attention-1" ? event() : undefined),
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
      providerDelivery: {
        provider: "slack",
        messageTs: "1710000000.000001",
        channelId: "C123456",
      },
      publishedAt: "2026-09-01T12:00:01.000Z",
    });

    await expect(adapter.handleInteraction(slackResponse())).resolves.toEqual({
      status: "resolved",
    });
    expect(responses).toEqual(["attention-1:yes"]);
  });

  it("routes a thread reply to a durable event when the service lookup is stale", async () => {
    const durableEvents: PersistedAttentionEvent[] = [];
    const responses: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      eventLookup: () => undefined,
      persistedAttentionEventsLookup: () => durableEvents,
      responseHandler: async ({ eventId, selectedOption }) => {
        responses.push(`${eventId}:${selectedOption}`);
        return { status: "resolved" };
      },
    });
    durableEvents.push(persistedFreeTextEvent("open", {
      provider: "slack",
      messageTs: "1710000000.000003",
      threadTs: "1710000000.000002",
      channelId: "C123456",
    }));

    await adapter.handleSocketEnvelope(JSON.stringify(messageEnvelope({ text: "USD 150000 base salary" })));
    expect(responses).toEqual(["attention-free-text-1:USD 150000 base salary"]);
  });

  it("posts every question for an application in one numbered message and routes the numbered reply", async () => {
    const requests: string[] = [];
    const responses: string[] = [];
    const batchEvent: AttentionEvent = {
      ...event(),
      id: "attention-batch-1",
      context: { company: "Kapitus", role: "Software Engineer II" },
      question: { prompt: "Do you hold an active security clearance?", kind: "single_choice", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
      batch: [
        { prompt: "Do you hold an active security clearance?", kind: "single_choice", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] },
        { prompt: "Which city will you work from?", kind: "free_text", options: [] },
        { prompt: "Pronouns", kind: "free_text", options: [], required: false },
      ],
    };
    const adapter = new SlackNotificationAdapter({
      config,
      eventLookup: (eventId) => (eventId === batchEvent.id ? batchEvent : undefined),
      responseHandler: async (attentionResponse) => { responses.push(attentionResponse.selectedOption); return { status: "resolved" }; },
      fetcher: async (_input, init) => {
        requests.push(typeof init?.body === "string" ? init.body : "");
        return { ok: true, status: 200, json: async () => ({ ok: true, ts: "1710000000.000002" }) } as Response;
      },
    });
    await adapter.publishAttentionEvent(batchEvent);
    const posted = JSON.parse(requests[0]!) as { text: string; blocks: unknown[] };
    expect(posted.text).toContain("3 questions for this application");
    expect(posted.text).toMatch(/\*1\.\* Do you hold an active security clearance\?\n\s+Choices: Yes · No/);
    expect(posted.text).toContain("*3.* Pronouns _(optional)_");
    expect(posted.text).toContain("Reply once in this thread with numbered answers");
    expect(JSON.stringify(posted.blocks)).not.toContain("\"actions\"");
    // Question 1 is a choice, but a typed numbered reply still reaches the agent.
    await adapter.handleSocketEnvelope(JSON.stringify(messageEnvelope({ text: "1. No\n2. Pittsburgh, PA\n3. SKIP" })));
    expect(responses).toEqual(["1. No\n2. Pittsburgh, PA\n3. SKIP"]);
  });

  it("routes an authorized free-text thread reply through the existing response core", async () => {
    const responses: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      eventLookup: (eventId) => (eventId === "attention-free-text-1" ? freeTextEvent() : undefined),
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
    await adapter.handleSocketEnvelope(
      JSON.stringify({
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
      }),
    );
    expect(responses).toEqual(["USD 150000 base salary"]);
  });

  it("routes an authorized rich-text thread reply when Slack omits top-level text", async () => {
    const responses: string[] = [];
    const adapter = new SlackNotificationAdapter({
      config,
      eventLookup: (eventId) => (eventId === "attention-free-text-1" ? freeTextEvent() : undefined),
      responseHandler: async ({ selectedOption }) => {
        responses.push(selectedOption);
        return { status: "resolved" };
      },
      fetcher: async (_input, _init) =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, ts: "1710000000.000002" }),
        }) as Response,
    });
    await adapter.publishAttentionEvent(freeTextEvent());
    await adapter.handleSocketEnvelope(
      JSON.stringify(
        messageEnvelope({
          text: "",
          blocks: [
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [{ type: "text", text: "AWS Lambda, ECS, and S3" }],
                },
              ],
            },
            { type: "actions", elements: [{ action_id: "ignored_metadata", value: "not-an-answer" }] },
          ],
        }),
      ),
    );
    expect(responses).toEqual(["AWS Lambda, ECS, and S3"]);
  });

  it("does not treat file or attachment metadata as a rich-text answer", async () => {
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
      fetcher: async (_input, _init) =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, ts: "1710000000.000002" }),
        }) as Response,
    });
    await adapter.publishAttentionEvent(freeTextEvent());
    await adapter.handleSocketEnvelope(
      JSON.stringify(
        messageEnvelope({
          text: "",
          blocks: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "not used" }] }] }],
          files: [{ id: "F123" }],
        }),
      ),
    );
    expect(responses).toEqual([]);
    expect(diagnostics.infos).toContain("ignored: message contains files or attachments");
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
      eventLookup: (eventId) => (eventId === "attention-free-text-1" ? freeTextEvent() : undefined),
      responseHandler: async (attentionResponse) => {
        responses.push(attentionResponse.selectedOption);
        return { status: "resolved" };
      },
      fetcher: async (_input, _init) =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, ts: "1710000000.000002" }),
        }) as Response,
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
      fetcher: async (_input, _init) =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, ts: "1710000000.000002" }),
        }) as Response,
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
      eventLookup: (eventId) => (eventId === "attention-free-text-1" ? { ...freeTextEvent(), status: "resolved" } : undefined),
      responseHandler: async () => {
        responses.push("unexpected");
        return { status: "resolved" };
      },
      fetcher: async (_input, _init) =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, ts: "1710000000.000002" }),
        }) as Response,
    });
    await adapter.publishAttentionEvent(freeTextEvent());
    await adapter.handleSocketEnvelope(JSON.stringify(messageEnvelope({ thread_ts: threadTs })));
    expect(responses).toEqual([]);
    expect(diagnostics.infos).toContain(diagnostic);
  });

  it("correlates a thread after adapter recreation when the durable timestamp is hydrated", async () => {
    const diagnostics = diagnosticCapture();
    const responses: string[] = [];
    const fetcher = async (_input: RequestInfo | URL, _init?: RequestInit) =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, ts: "1710000000.000002" }),
      }) as Response;
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
      eventLookup: (eventId) => (eventId === second.id ? second : undefined),
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
      {
        ...persistedFreeTextEvent("resolved", firstDelivery),
        applicationId: "application-1",
      },
      {
        ...persistedFreeTextEvent("open", secondDelivery),
        id: second.id,
        applicationId: "application-1",
      },
    ]);
    await adapter.handleSocketEnvelope(JSON.stringify(messageEnvelope({ thread_ts: "1710000000.000041" })));
    expect(responses).toEqual([second.id]);

    const third = {
      ...second,
      id: "attention-free-text-3",
      question: { ...second.question!, prompt: "What is your notice period?" },
    };
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
      providerDelivery: {
        ...legacy.providerDelivery!,
        messageTs: "1710000000.000060",
      },
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

    const next = {
      ...freeTextEvent(),
      id: "attention-free-text-next",
      applicationId: legacy.applicationId,
    };
    const delivery = await adapter.publishAttentionEvent(next);

    expect(JSON.parse(requests[0]).thread_ts).toBe("1710000000.000062");
    expect(delivery).toMatchObject({ threadTs: "1710000000.000062" });
  });

  it("starts a fresh top-level root after stale history and correlates later replies to it", async () => {
    const requests: string[] = [];
    let sequence = 70;
    const adapter = new SlackNotificationAdapter({
      config,
      fetcher: async (_input, init) => {
        requests.push(typeof init?.body === "string" ? init.body : "");
        sequence += 1;
        return { ok: true, status: 200, json: async () => ({ ok: true, ts: `1710000000.0000${sequence}` }) } as Response;
      },
    });
    const historical = persistedFreeTextEvent("resolved", {
      provider: "slack",
      messageTs: "1710000000.000061",
      threadTs: "1710000000.000062",
      channelId: "C123456",
    });
    adapter.hydratePublishedAttentionEvents([historical]);
    adapter.startFreshApplicationReview("application-1");

    const first = await adapter.publishAttentionEvent({ ...freeTextEvent(), id: "attention-fresh-1" });
    const second = await adapter.publishAttentionEvent({ ...freeTextEvent(), id: "attention-fresh-2" });

    expect(JSON.parse(requests[0]).thread_ts).toBeUndefined();
    expect(first).toMatchObject({ messageTs: "1710000000.000071", channelId: "C123456" });
    expect(JSON.parse(requests[1]).thread_ts).toBe("1710000000.000071");
    expect(second).toMatchObject({ threadTs: "1710000000.000071", channelId: "C123456" });
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
      eventLookup: (eventId) =>
        eventId === first.id ? freeTextEvent() : eventId === second.id ? { ...freeTextEvent(), id: second.id } : undefined,
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
    adapter.hydratePublishedAttentionEvents([
      persistedFreeTextEvent(status, {
        provider: "slack",
        messageTs: "1710000000.000002",
        channelId: "C123456",
      }),
    ]);
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
      eventLookup: (eventId) =>
        eventId === first.id ? freeTextEvent() : eventId === second.id ? { ...freeTextEvent(), id: second.id } : undefined,
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
      {
        ...second,
        providerDelivery: {
          ...second.providerDelivery!,
          messageTs: first.providerDelivery!.messageTs,
        },
      },
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
      fetcher: async (_input, _init) =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, ts: "1710000000.000002" }),
        }) as Response,
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
    let socket:
      | {
          onopen?: () => void;
          onmessage?: (message: { data: unknown }) => void;
          onerror?: (event: unknown) => void;
          onclose?: () => void;
          send(data: string): void;
          close(): void;
        }
      | undefined;
    const adapter = new SlackNotificationAdapter({
      config,
      responseHandler: response(),
      fetcher: async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, url: "wss://slack.test/socket" }),
        }) as Response,
      webSocketFactory: () => {
        const nextSocket = {
          onopen: undefined as (() => void) | undefined,
          onmessage: undefined as ((message: { data: unknown }) => void) | undefined,
          onerror: undefined as ((event: unknown) => void) | undefined,
          onclose: undefined as (() => void) | undefined,
          send: (data: string) => {
            sent.push(data);
          },
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

  it("treats Slack disconnect control envelopes as normal lifecycle traffic", async () => {
    const diagnostics = diagnosticCapture();
    const adapter = new SlackNotificationAdapter({
      config,
      diagnosticLogger: diagnostics.logger,
    });

    await adapter.handleSocketEnvelope(
      JSON.stringify({
        type: "disconnect",
        reason: "refresh_requested",
      }),
    );

    expect(diagnostics.warnings).toEqual([]);
    expect(diagnostics.infos).toContain("received Socket Mode disconnect (refresh_requested)");
  });

  it("reconnects after Slack closes the Socket Mode connection", async () => {
    const diagnostics = diagnosticCapture();
    let socketCount = 0;
    const sockets: Array<{ onopen?: () => void; onerror?: (event: unknown) => void; onclose?: () => void; send(data: string): void; close(): void }> = [];
    const adapter = new SlackNotificationAdapter({
      config,
      diagnosticLogger: diagnostics.logger,
      socketReconnectDelayMs: 1,
      fetcher: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, url: "wss://slack.test/socket" }),
      }) as Response,
      webSocketFactory: () => {
        socketCount += 1;
        const socket = {
          onopen: undefined as (() => void) | undefined,
          onerror: undefined as ((event: unknown) => void) | undefined,
          onclose: undefined as (() => void) | undefined,
          send: () => undefined,
          close: () => undefined,
        };
        sockets.push(socket);
        queueMicrotask(() => socket.onopen?.());
        return socket;
      },
    });

    await adapter.start();
    sockets[0]?.onclose?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(socketCount).toBe(2);
    expect(diagnostics.warnings).toContain("Slack Socket Mode connection closed; reconnecting.");
    adapter.stop();
  });

  it("reconnects when Slack reports an established-socket error or disconnect envelope", async () => {
    let socketCount = 0;
    const sockets: Array<{ onopen?: () => void; onerror?: (event: unknown) => void; onclose?: () => void; send(data: string): void; close(): void }> = [];
    const adapter = new SlackNotificationAdapter({
      config,
      socketReconnectDelayMs: 1,
      fetcher: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, url: "wss://slack.test/socket" }) }) as Response,
      webSocketFactory: () => {
        socketCount += 1;
        const socket = {
          onopen: undefined as (() => void) | undefined,
          onerror: undefined as ((event: unknown) => void) | undefined,
          onclose: undefined as (() => void) | undefined,
          send: () => undefined,
          close: () => undefined,
        };
        sockets.push(socket);
        queueMicrotask(() => socket.onopen?.());
        return socket;
      },
    });

    await adapter.start();
    sockets[0]?.onerror?.(new Error("socket reset"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(socketCount).toBe(2);

    await adapter.handleSocketEnvelope(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(socketCount).toBe(3);
    adapter.stop();
  });
});
