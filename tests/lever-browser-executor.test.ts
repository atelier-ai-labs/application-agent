import { describe, expect, it } from "vitest";
import {
  LeverBrowserExecutor,
  classifyLeverApplicationField,
  exampleCandidateProfile,
  isExecutionInspection,
  BrowserExecutionDiagnosticError,
  safeBrowserDiagnosticMessage,
  type Application,
  type ApplicationAnswer,
  type ApplicationExecutionRequest,
  type ApplicationFieldOption,
  type ApplicationFieldType,
  type BrowserCaptchaDiagnostics,
  type CareerBlocker,
  type CareerJob,
  type Campaign,
  type LeverBrowserField,
  type LeverBrowserSession,
  type LeverBrowserSessionFactory,
} from "../application-agent/src";
import {
  classifyCaptchaEvidence,
  questionDescriptorFromEvidence,
  type CaptchaDomObservation,
} from "../application-agent/automation/playwrightLeverBrowserSession";

const capturedAt = "2026-08-30T12:00:00.000Z";
const hostedUrl = "https://jobs.lever.co/h1/post-1";
const applicationUrl = `${hostedUrl}/apply`;

class FakeField implements LeverBrowserField {
  readonly classification = "unknown" as const;
  readonly id: string;
  readonly label: string;
  readonly type: ApplicationFieldType;
  readonly required: boolean;
  readonly options?: readonly ApplicationFieldOption[];
  readonly questionDescriptor?: LeverBrowserField["questionDescriptor"];
  current: string | boolean | null;
  fillCalls = 0;
  selectCalls = 0;
  checkCalls = 0;
  uploadCalls: string[] = [];

  constructor(options: {
    id: string;
    label: string;
    type: ApplicationFieldType | string;
    required?: boolean;
    options?: readonly ApplicationFieldOption[];
    questionDescriptor?: LeverBrowserField["questionDescriptor"];
    current?: string | boolean | null;
  }) {
    this.id = options.id;
    this.label = options.label;
    this.type = options.type as ApplicationFieldType;
    this.required = options.required ?? false;
    this.options = options.options;
    this.questionDescriptor = options.questionDescriptor;
    this.current = options.current ?? null;
  }

  async fill(value: string): Promise<void> {
    this.fillCalls += 1;
    this.current = value;
  }

  async select(value: string): Promise<void> {
    this.selectCalls += 1;
    this.current = value;
  }

  async setChecked(value: boolean): Promise<void> {
    this.checkCalls += 1;
    this.current = value;
  }

  async uploadFile(path: string): Promise<void> {
    this.uploadCalls.push(path);
    this.current = path;
  }

  async readValue(): Promise<string | boolean | null> {
    return this.current;
  }
}

class FakeSession implements LeverBrowserSession {
  url = "";
  navigations = 0;
  closeCalls = 0;
  submitClicks = 0;
  boundary: Awaited<ReturnType<LeverBrowserSession["detectHumanBoundary"]>> = null;
  captchaDiagnostics?: BrowserCaptchaDiagnostics;
  submitControl = true;

  constructor(readonly fields: FakeField[]) {}

  async navigate(url: string): Promise<void> {
    this.navigations += 1;
    this.url = url;
  }

  currentUrl(): string {
    return this.url;
  }

  async inspectFields(): Promise<readonly LeverBrowserField[]> {
    return this.fields;
  }

  async detectHumanBoundary() {
    if (this.captchaDiagnostics && (this.captchaDiagnostics.state === "active_challenge" || this.captchaDiagnostics.state === "uncertain")) {
      return {
        kind: "captcha" as const,
        question: "Complete the CAPTCHA in the browser",
        reason: "A visible or uncertain CAPTCHA boundary requires human action.",
        evidence: [`captcha-state:${this.captchaDiagnostics.state}`],
      };
    }
    return this.boundary;
  }

  diagnostics() {
    return this.captchaDiagnostics ? { captcha: this.captchaDiagnostics } : {};
  }

  async hasSubmitControl(): Promise<boolean> {
    return this.submitControl;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class FakeSessionFactory implements LeverBrowserSessionFactory {
  opens = 0;

  constructor(readonly session: FakeSession) {}

  async open(): Promise<LeverBrowserSession> {
    this.opens += 1;
    return this.session;
  }
}

class ThrowingSessionFactory implements LeverBrowserSessionFactory {
  constructor(private readonly failure: unknown) {}

  async open(): Promise<LeverBrowserSession> {
    throw this.failure;
  }
}

function campaign(): Campaign {
  return {
    id: "campaign-1",
    name: "Test campaign",
    goal: "Prepare grounded applications.",
    status: "active",
    searchCriteria: {
      roleLanes: ["engineer"],
      locations: [],
      remoteOnly: false,
      employmentTypes: [],
      excludedSeniorities: [],
      excludedCompanies: [],
    },
    searchSources: ["lever:h1"],
    fitPolicy: { strong: "pursue", good: "pursue", stretch: "hold", weak: "reject" },
    applicationPolicy: { autoPrepare: true, allowGroundedDrafts: true, approvedResumeFamilies: [] },
    submissionPolicy: { authority: "approval_required", requireExplicitApproval: true },
    dailyApplicationLimit: 3,
    reviewConditions: { unusualTerms: true, authenticationRequired: true, unknownFacts: true, subjectiveAnswers: true },
    stopConditions: { stopOnAcceptedOffer: true, systemicFailureLimit: 3 },
    consecutiveSystemicFailures: 0,
    createdAt: capturedAt,
    updatedAt: capturedAt,
  };
}

function answer(
  field: string,
  value: string | boolean | number | undefined,
  options: Partial<ApplicationAnswer> = {},
): ApplicationAnswer {
  return {
    id: `answer:${field}`,
    field,
    question: field,
    policy: "auto",
    ...(value === undefined ? {} : { value }),
    status: "resolved",
    provenance: [`test:${field}`],
    ...options,
  };
}

function application(overrides: Partial<Application> = {}): Application {
  const job = {
    company: "H1",
    title: "Cloud Platform Engineer",
    sourceUrl: hostedUrl,
    applicationUrl,
    location: "Remote",
    remoteStatus: "remote",
    description: "Build dependable cloud systems for a technical team.",
    requiredSkills: ["AWS"],
    preferredSkills: [],
    capturedAt,
  };
  return {
    id: "application-1",
    isExample: false,
    job,
    fit: null,
    resume: {
      familyId: "cloud-platform",
      familyLabel: "Cloud / Platform",
      summary: "Grounded platform resume.",
      sections: [],
      generatedAt: capturedAt,
    },
    answers: [],
    blockers: [],
    status: "ready_for_review",
    createdAt: capturedAt,
    updatedAt: capturedAt,
    ...overrides,
  };
}

function careerJob(overrides: Partial<CareerJob> = {}): CareerJob {
  const job = application().job;
  return {
    id: "career-job-1",
    campaignId: "campaign-1",
    isExample: false,
    sourceMode: "live",
    actionability: "actionable",
    fingerprint: "source:lever:h1:id:post-1",
    sourceId: "lever:h1",
    sourceRecordId: "post-1",
    job,
    discoveredAt: capturedAt,
    fit: null,
    status: "ready_to_submit",
    blockers: [],
    createdAt: capturedAt,
    updatedAt: capturedAt,
    ...overrides,
  };
}

function request(overrides: Partial<ApplicationExecutionRequest> = {}): ApplicationExecutionRequest {
  return {
    campaign: campaign(),
    careerJob: careerJob(),
    application: application(),
    now: capturedAt,
    profile: exampleCandidateProfile,
    ...overrides,
  };
}

function resolvedCareerBlocker(field: string, value: string | boolean | number): CareerBlocker {
  return {
    id: "career-blocker-1",
    kind: "salary",
    unit: "submission",
    field,
    question: "Expected salary",
    context: {
      jobId: "career-job-1",
      applicationId: "application-1",
      company: "H1",
      role: "Cloud Platform Engineer",
      sourceUrl: hostedUrl,
      applicationUrl,
    },
    reason: "Input was required.",
    evidence: ["test"],
    status: "resolved",
    createdAt: capturedAt,
    resolvedAt: capturedAt,
    value,
    resumeAfterHuman: true,
  };
}

describe("LeverBrowserExecutor", () => {
  const captchaObservation = (overrides: Partial<CaptchaDomObservation> = {}): CaptchaDomObservation => ({
    markerCount: 0,
    visibleMarkerCount: 0,
    challengeIframeCount: 0,
    visibleChallengeIframeCount: 0,
    visibleChallengeControlCount: 0,
    explicitChallengeText: false,
    ...overrides,
  });

  it("classifies CAPTCHA evidence without treating marker presence as an active challenge", () => {
    expect(classifyCaptchaEvidence(captchaObservation())).toMatchObject({
      state: "none",
      evidenceCategory: "no_markers",
    });
    expect(classifyCaptchaEvidence(captchaObservation({ markerCount: 5 }))).toMatchObject({
      state: "infrastructure_present",
      evidenceCategory: "hidden_infrastructure",
    });
    expect(classifyCaptchaEvidence(captchaObservation({
      markerCount: 1,
      visibleMarkerCount: 1,
      challengeIframeCount: 1,
      visibleChallengeIframeCount: 1,
    }))).toMatchObject({
      state: "active_challenge",
      evidenceCategory: "visible_challenge_iframe",
    });
    expect(classifyCaptchaEvidence(captchaObservation({
      markerCount: 1,
      visibleMarkerCount: 1,
      visibleChallengeControlCount: 1,
    }))).toMatchObject({
      state: "active_challenge",
      evidenceCategory: "visible_challenge_control",
    });
    expect(classifyCaptchaEvidence(captchaObservation({
      markerCount: 1,
      visibleMarkerCount: 1,
    }))).toMatchObject({
      state: "uncertain",
      evidenceCategory: "visible_marker_ambiguous",
    });
    expect(classifyCaptchaEvidence(captchaObservation({
      markerCount: 3,
      explicitChallengeText: true,
    }))).toMatchObject({
      state: "active_challenge",
      evidenceCategory: "explicit_challenge_text",
    });
  });

  it("records hidden CAPTCHA infrastructure without creating a human gate", async () => {
    const session = new FakeSession([new FakeField({ id: "email", label: "Email", type: "email", required: true })]);
    session.captchaDiagnostics = classifyCaptchaEvidence(captchaObservation({ markerCount: 5 }));
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      now: () => capturedAt,
    }).inspect(request());

    expect(result.status).toBe("inspected");
    expect(result.blockers).toHaveLength(0);
    expect(result.captcha).toMatchObject({ state: "infrastructure_present", markerCount: 5, visibleMarkerCount: 0 });
    expect(result.evidence).toContain("captcha-state:infrastructure_present");
  });

  it.each([
    ["active_challenge", "active_challenge"],
    ["uncertain", "uncertain"],
  ] as const)("preserves the human gate for %s CAPTCHA evidence", async (state, expectedState) => {
    const session = new FakeSession([new FakeField({ id: "email", label: "Email", type: "email", required: true })]);
    session.captchaDiagnostics = {
      state,
      markerCount: 1,
      visibleMarkerCount: state === "active_challenge" ? 1 : 1,
      challengeIframeCount: state === "active_challenge" ? 1 : 0,
      visibleChallengeIframeCount: state === "active_challenge" ? 1 : 0,
      evidenceCategory: state === "active_challenge" ? "visible_challenge_iframe" : "visible_marker_ambiguous",
    };
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      now: () => capturedAt,
    }).inspect(request());

    expect(result.status).toBe("needs_input");
    expect(result.blockers[0]?.kind).toBe("captcha");
    expect(result.captcha?.state).toBe(expectedState);
  });

  it("extracts high-confidence question context from explicit associations", () => {
    expect(questionDescriptorFromEvidence({
      fieldsetLegend: "Are you authorized to work in the United States?",
      sectionTitle: "Work authorization",
      nearbyInstructionText: "Choose one.",
    })).toMatchObject({
      promptText: "Are you authorized to work in the United States?",
      sectionTitle: "Work authorization",
      nearbyInstructionText: "Choose one.",
      sourceStrategy: "fieldset_legend",
      confidence: "high",
    });
    expect(questionDescriptorFromEvidence({
      ariaLabelledByText: "What is your preferred work location?",
      accessibleName: "What is your preferred work location?",
    })).toMatchObject({
      promptText: "What is your preferred work location?",
      sourceStrategy: "aria_labelledby",
      confidence: "high",
    });
    expect(questionDescriptorFromEvidence({
      questionContainerPrompts: ["Are you legally eligible to work in the US?"],
      sectionTitle: "Standard Work Authorization - US",
    })).toMatchObject({
      promptText: "Are you legally eligible to work in the US?",
      sectionTitle: "Standard Work Authorization - US",
      sourceStrategy: "question_container",
      confidence: "high",
    });
  });

  it("does not promote unrelated or ambiguous nearby text to an authoritative prompt", () => {
    const unrelated = questionDescriptorFromEvidence({
      sectionTitle: "General application",
      nearbyInstructionText: "Unrelated navigation text",
    });
    expect(unrelated).toMatchObject({ sourceStrategy: "unavailable", confidence: "uncertain" });
    expect(unrelated?.promptText).toBeUndefined();

    const ambiguous = questionDescriptorFromEvidence({
      questionContainerPrompts: ["First possible question", "Second possible question"],
    });
    expect(ambiguous).toMatchObject({ sourceStrategy: "unavailable", confidence: "uncertain" });
    expect(ambiguous?.promptText).toBeUndefined();

    expect(questionDescriptorFromEvidence({
      nearbyPromptText: "Possibly related question text",
    })).toMatchObject({
      promptText: "Possibly related question text",
      sourceStrategy: "nearby_text",
      confidence: "uncertain",
    });
  });

  it("bounds question context and never copies a candidate field value", async () => {
    const descriptor = questionDescriptorFromEvidence({
      questionContainerPrompts: ["Q".repeat(300)],
      sectionTitle: "S".repeat(200),
      nearbyInstructionText: "I".repeat(200),
    });
    expect(descriptor?.promptText).toHaveLength(240);
    expect(descriptor?.sectionTitle).toHaveLength(160);
    expect(descriptor?.nearbyInstructionText).toHaveLength(160);

    const candidateValue = "candidate@example.invalid";
    const session = new FakeSession([new FakeField({
      id: "cards_unknown__field0_",
      label: "Yes",
      type: "radio",
      required: true,
      current: candidateValue,
      options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
      questionDescriptor: descriptor,
    })]);
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      now: () => capturedAt,
    }).inspect(request());
    expect(result.status).toBe("inspected");
    expect(JSON.stringify(result)).not.toContain(candidateValue);
  });

  it("validates bounded question descriptors while keeping older inspections loadable", async () => {
    const descriptor = questionDescriptorFromEvidence({
      questionContainerPrompts: ["Which work location do you prefer?"],
    });
    const session = new FakeSession([new FakeField({
      id: "location",
      label: "Location",
      type: "text",
      questionDescriptor: descriptor,
    })]);
    const inspection = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      now: () => capturedAt,
    }).inspect(request());
    expect(isExecutionInspection(inspection)).toBe(true);
    expect(isExecutionInspection({
      ...inspection,
      fields: inspection.fields.map(({ questionDescriptor: _questionDescriptor, ...field }) => field),
    })).toBe(true);
    expect(isExecutionInspection({
      ...inspection,
      fields: [{
        ...inspection.fields[0],
        questionDescriptor: {
          ...descriptor,
          promptText: "Q".repeat(241),
        },
      }],
    })).toBe(false);
  });

  it("preserves an ambiguous generated yes/no radio control as an actionable human blocker", async () => {
    const fieldId = "cards_1d794e0f-e60d-479b-9c6e-2b60b82b13aa__field0_";
    const session = new FakeSession([new FakeField({
      id: fieldId,
      label: "Yes",
      type: "radio",
      required: true,
      options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
      questionDescriptor: {
        promptText: "Are you legally eligible to work in the US?",
        sectionTitle: "Standard Work Authorization - US",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    })]);
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      now: () => capturedAt,
    }).execute(request());

    expect(classifyLeverApplicationField({ id: fieldId, label: "Yes", type: "radio" })).toBe("unknown");
    expect(result.state).toBe("requires_human");
    if (result.state !== "requires_human") return;
    expect(result.blocker.kind).toBe("unknown_form_field");
    expect(result.blocker.field).toBe(fieldId);
    expect(result.blocker.question).toBe(`Required question under "Standard Work Authorization - US": "Are you legally eligible to work in the US?" — choose Yes or No.`);
    expect(result.blocker.reason).toContain("no value was guessed");
    expect(result.blocker.evidence).toContain("field-type:radio");
    expect(result.blocker.evidence).toContain("field-required:true");
    expect(result.blocker.evidence).toContain("options:Yes|No");
    expect(result.blocker.evidence).toContain("question-source:question_container");
    expect(result.blocker.evidence).toContain("question-confidence:high");
    expect(session.fields[0].selectCalls).toBe(0);
    expect(session.submitClicks).toBe(0);
  });

  it("does not apply a resolved unknown-field answer after the inspected question changes", async () => {
    const fieldId = "cards_question__field0_";
    const blocker: CareerBlocker = {
      ...resolvedCareerBlocker(fieldId, "yes"),
      kind: "unknown_form_field",
      question: 'Required application question: "Original question" — choose Yes or No.',
      evidence: [
        "executor:lever-browser",
        `field-id:${fieldId}`,
        "field-type:radio",
        "field-required:true",
        "classification:unknown",
        "options:Yes|No",
        "question-prompt:Original question",
        "question-source:question_container",
        "question-confidence:high",
      ],
    };
    const session = new FakeSession([new FakeField({
      id: fieldId,
      label: "Yes",
      type: "radio",
      required: true,
      options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
      questionDescriptor: {
        promptText: "Changed question",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    })]);
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      now: () => capturedAt,
    }).execute(request({ careerJob: careerJob({ blockers: [blocker] }) }));

    expect(result.state).toBe("requires_human");
    expect(session.fields[0].selectCalls).toBe(0);
    expect(result.state === "requires_human" ? result.blocker.reason : "").toContain("no value was guessed");
  });

  it("records a typed browser-launch diagnostic without leaking sensitive error text", async () => {
    const failure = new BrowserExecutionDiagnosticError({
      stage: "browser_launch",
      reasonCode: "browser_launch_failed",
      message: "Executable failed for https://jobs.lever.co/h1/post-1/apply?token=secret candidate@example.test Authorization: Bearer top-secret Cookie: session=private",
      boundaries: { browserLaunched: false, contextCreated: false, pageCreated: false },
    });
    const result = await new LeverBrowserExecutor({
      sessionFactory: new ThrowingSessionFactory(failure),
      now: () => capturedAt,
    }).inspect(request());

    expect(result.status).toBe("failed");
    expect(result.diagnostic).toMatchObject({
      stage: "browser_launch",
      reasonCode: "browser_launch_failed",
    });
    expect(result.diagnostic?.message).not.toContain("candidate@example.test");
    expect(result.diagnostic?.message).not.toContain("token=secret");
    expect(result.diagnostic?.message).not.toContain("top-secret");
    expect(result.diagnostic?.message).not.toContain("session=private");
    expect(result.boundaries).toMatchObject({
      browserLaunched: false,
      contextCreated: false,
      pageCreated: false,
      preflightInspectionStarted: true,
      preflightInspectionCompleted: true,
      controlsInspectionStarted: false,
      controlsInspectionCompleted: false,
    });
  });

  it("preserves navigation diagnostics and identifies control-inspection failures", async () => {
    const navigationSession = new FakeSession([]);
    navigationSession.navigate = async () => {
      throw new BrowserExecutionDiagnosticError({
        stage: "navigation",
        reasonCode: "navigation_timeout",
        message: "The Lever application page timed out.",
        boundaries: {
          browserLaunched: true,
          contextCreated: true,
          pageCreated: true,
          navigationStarted: true,
          navigationCompleted: false,
          domReady: false,
        },
        navigation: {
          targetHost: "jobs.lever.co",
          outcome: "failed",
        },
      });
    };
    const navigationResult = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(navigationSession),
      now: () => capturedAt,
    }).inspect(request());
    expect(navigationResult.diagnostic).toMatchObject({ stage: "navigation", reasonCode: "navigation_timeout" });
    expect(navigationResult.navigation).toMatchObject({ targetHost: "jobs.lever.co", outcome: "failed" });
    expect(navigationResult.boundaries).toMatchObject({
      browserLaunched: true,
      navigationStarted: true,
      navigationCompleted: false,
      domReady: false,
      preflightInspectionCompleted: true,
    });

    const controlsSession = new FakeSession([]);
    controlsSession.inspectFields = async () => {
      throw new Error("DOM inspection failed for https://jobs.lever.co/h1/post-1/apply?token=secret");
    };
    const controlsResult = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(controlsSession),
      now: () => capturedAt,
    }).inspect(request());
    expect(controlsResult.diagnostic).toMatchObject({ stage: "controls_inspection", reasonCode: "inspection_failed" });
    expect(controlsResult.diagnostic?.message).not.toContain("token=secret");
    expect(controlsResult.boundaries).toMatchObject({
      preflightInspectionStarted: true,
      preflightInspectionCompleted: true,
      controlsInspectionStarted: true,
      controlsInspectionCompleted: false,
    });
  });

  it("rejects non-actionable or untrusted postings before opening a browser", async () => {
    const factory = new FakeSessionFactory(new FakeSession([]));
    const executor = new LeverBrowserExecutor({ sessionFactory: factory, now: () => capturedAt });

    const result = await executor.execute(request({
      careerJob: careerJob({ actionability: "discoverable_only" }),
    }));

    expect(result.state).toBe("unsupported");
    expect(factory.opens).toBe(0);
    expect(executor.supports(request())).toBe(true);
    expect(executor.supports(request({ careerJob: careerJob({ job: { ...careerJob().job, applicationUrl: "https://example.com/apply" } }) }))).toBe(false);
  });

  it("inspects and fills safe contact, text, select, checkbox, and resume fields without submitting", async () => {
    const fields = [
      new FakeField({ id: "first-name", label: "First name", type: "text", required: true }),
      new FakeField({ id: "last-name", label: "Last name", type: "text", required: true }),
      new FakeField({ id: "email", label: "Email", type: "email", required: true }),
      new FakeField({ id: "phone", label: "Phone", type: "tel" }),
      new FakeField({ id: "why", label: "Why are you interested in this company?", type: "textarea", required: true }),
      new FakeField({
        id: "sponsorship",
        label: "Will you require sponsorship?",
        type: "select",
        required: true,
        options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
      }),
      new FakeField({ id: "updates", label: "Marketing consent", type: "checkbox" }),
      new FakeField({ id: "resume", label: "Resume", type: "file", required: true }),
    ];
    const session = new FakeSession(fields);
    const factory = new FakeSessionFactory(session);
    const result = await new LeverBrowserExecutor({
      sessionFactory: factory,
      resumePaths: { "cloud-platform": "/tmp/safe-example-resume.pdf" },
      resumeFileExists: () => true,
      now: () => capturedAt,
    }).execute(request({
      application: application({
        answers: [
          answer("why_company", "A grounded prepared answer.", { policy: "draft_review", status: "drafted" }),
          answer("sponsorship", false),
          answer("marketing", true),
        ],
      }),
    }));

    expect(result.state).toBe("ready_to_submit");
    if (result.state !== "ready_to_submit") return;
    expect(result.inspection.fields.map((field) => field.classification)).toEqual([
      "contact", "contact", "contact", "contact", "free_text", "sponsorship", "unknown", "resume_upload",
    ]);
    expect(fields[0].current).toBe("Example");
    expect(fields[1].current).toBe("Candidate");
    expect(fields[2].current).toBe("candidate@example.invalid");
    expect(fields[3].current).toBe("+1 555 0100");
    expect(fields[4].current).toBe("A grounded prepared answer.");
    expect(fields[5].current).toBe("no");
    expect(fields[6].current).toBe(true);
    expect(fields[7].uploadCalls).toEqual(["/tmp/safe-example-resume.pdf"]);
    expect(session.submitClicks).toBe(0);
    expect(result.inspection.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.inspection.domInspectionCount).toBe(1);
    expect(result.inspection.evidence).toContain("submit:not-clicked");
    expect(result.inspection.evidence).toContain("submission:manual-only");
    expect(result.inspection.boundaries).toMatchObject({
      executorInspectionStarted: true,
      executorInspectionCompleted: true,
      controlsInspectionStarted: true,
      controlsInspectionCompleted: true,
    });
  });

  it("stops on an unresolved ASK field and resumes the same session without refilling completed fields", async () => {
    const fields = [
      new FakeField({ id: "first-name", label: "First name", type: "text", required: true }),
      new FakeField({ id: "email", label: "Email", type: "email", required: true }),
      new FakeField({ id: "salary", label: "Expected salary", type: "text", required: true }),
    ];
    const session = new FakeSession(fields);
    const factory = new FakeSessionFactory(session);
    const executor = new LeverBrowserExecutor({ sessionFactory: factory, now: () => capturedAt });

    const first = await executor.execute(request());
    expect(first.state).toBe("requires_human");
    if (first.state !== "requires_human") return;
    expect(first.inspection?.durationMs).toBeGreaterThanOrEqual(0);
    expect(first.inspection?.domInspectionCount).toBe(1);
    expect(first.blocker.kind).toBe("salary");
    expect(fields[0].fillCalls).toBe(1);
    expect(fields[1].fillCalls).toBe(1);
    expect(fields[2].fillCalls).toBe(0);

    const second = await executor.execute(request({
      careerJob: careerJob({ blockers: [resolvedCareerBlocker("salary", "USD 150000")] }),
    }));
    expect(second.state).toBe("ready_to_submit");
    if (second.state !== "ready_to_submit") return;
    expect(second.inspection.durationMs).toBeGreaterThanOrEqual(0);
    expect(second.inspection.domInspectionCount).toBe(1);
    expect(factory.opens).toBe(1);
    expect(session.navigations).toBe(1);
    expect(fields[0].fillCalls).toBe(1);
    expect(fields[1].fillCalls).toBe(1);
    expect(fields[2].fillCalls).toBe(1);
    expect(session.submitClicks).toBe(0);
  });

  it("does not fabricate missing facts and handles policy-sensitive demographic/legal fields conservatively", async () => {
    const requiredDemographic = new FakeSession([
      new FakeField({ id: "gender", label: "Gender identity", type: "select", required: true, options: [{ label: "Option", value: "option" }] }),
    ]);
    const demographicResult = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(requiredDemographic), now: () => capturedAt }).execute(request());
    expect(demographicResult.state).toBe("requires_human");
    expect(demographicResult.state === "requires_human" && demographicResult.blocker.kind).toBe("demographic_disclosure");

    const optionalDemographic = new FakeSession([
      new FakeField({ id: "gender", label: "Gender identity", type: "select", required: false, options: [{ label: "Option", value: "option" }] }),
    ]);
    const optionalResult = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(optionalDemographic), now: () => capturedAt }).execute(request());
    expect(optionalResult.state).toBe("ready_to_submit");
    expect(optionalDemographic.fields[0].current).toBeNull();

    const legal = new FakeSession([
      new FakeField({ id: "certify", label: "I certify that the information is accurate", type: "checkbox", required: true }),
    ]);
    const legalResult = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(legal), now: () => capturedAt }).execute(request());
    expect(legalResult.state).toBe("requires_human");
    expect(legalResult.state === "requires_human" && legalResult.blocker.kind).toBe("legal_attestation");
    expect(legal.fields[0].checkCalls).toBe(0);

    const unknown = new FakeSession([
      new FakeField({ id: "years", label: "Years of experience with an unlisted system", type: "text", required: true }),
    ]);
    const unknownResult = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(unknown), now: () => capturedAt }).execute(request());
    expect(unknownResult.state).toBe("requires_human");
    expect(unknownResult.state === "requires_human" && unknownResult.blocker.kind).toBe("unknown_form_field");
    expect(unknown.fields[0].fillCalls).toBe(0);
  });

  it("returns resume and widget blockers, and recognizes authentication boundaries", async () => {
    const missingResume = new FakeSession([
      new FakeField({ id: "resume", label: "Resume", type: "file", required: true }),
    ]);
    const resumeResult = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(missingResume), now: () => capturedAt }).execute(request());
    expect(resumeResult.state).toBe("requires_human");
    expect(resumeResult.state === "requires_human" && resumeResult.blocker.kind).toBe("resume_missing");

    const unsupported = new FakeSession([
      new FakeField({ id: "address", label: "Address widget", type: "date", required: true }),
    ]);
    const unsupportedResult = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(unsupported), now: () => capturedAt }).execute(request());
    expect(unsupportedResult.state).toBe("requires_human");
    expect(unsupportedResult.state === "requires_human" && unsupportedResult.blocker.kind).toBe("unsupported_widget");

    const boundary = new FakeSession([]);
    boundary.boundary = {
      kind: "external_login",
      question: "Authenticate in the browser",
      reason: "A login is required.",
      evidence: ["password-fields:1"],
    };
    const boundaryResult = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(boundary), now: () => capturedAt }).execute(request());
    expect(boundaryResult.state).toBe("requires_human");
    expect(boundaryResult.state === "requires_human" && boundaryResult.blocker.kind).toBe("external_login");
    expect(boundary.submitClicks).toBe(0);
  });

  it("requires a visible submit control for ready_to_submit but never activates it", async () => {
    const session = new FakeSession([
      new FakeField({ id: "email", label: "Email", type: "email", required: true }),
    ]);
    session.submitControl = false;
    const result = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), now: () => capturedAt }).execute(request());
    expect(result.state).toBe("unsupported");
    expect(result.state === "unsupported" && result.blocker?.kind).toBe("unsupported_widget");
    expect(session.submitClicks).toBe(0);
  });
});
