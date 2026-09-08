import { describe, expect, it } from "vitest";
import {
  LeverBrowserExecutor,
  classifyLeverApplicationField,
  looksLikeInternationalDialingOptions,
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
  type CandidateProfile,
  type LeverBrowserField,
  type LeverBrowserSession,
  type LeverBrowserSessionFactory,
} from "../application-agent/src";
import {
  classifyCaptchaEvidence,
  questionDescriptorFromEvidence,
  stableSelectorForControl,
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

  async submit() {
    this.submitClicks += 1;
    return {
      clicked: true,
      confirmed: true,
      externalApplicationId: "confirmation:test",
      evidence: "submit:clicked; confirmation:text",
    };
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

  it("binds browser controls by stable DOM identity rather than a shifting position", () => {
    const initial = stableSelectorForControl({ tagName: "input", id: "resume" });
    const afterRerender = stableSelectorForControl({ tagName: "input", id: "resume" });
    const school = stableSelectorForControl({ tagName: "input", id: "school--0" });

    expect(initial).toEqual({ selector: "input#resume", source: "dom-id:resume" });
    expect(afterRerender).toEqual(initial);
    expect(school?.selector).toBe("input#school--0");
    expect(initial?.selector).not.toContain("nth");
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

  it("allows safe preparation with a passive visible badge while withholding consequential answers", async () => {
    const email = new FakeField({ id: "email", label: "Email", type: "email", required: true });
    const salary = new FakeField({ id: "salary", label: "Salary expectations", type: "text", required: true });
    const session = new FakeSession([email, salary]);
    session.captchaDiagnostics = classifyCaptchaEvidence(captchaObservation({ markerCount: 3, visibleMarkerCount: 2, passiveVisibleMarkerCount: 2 }));
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      allowedFieldClassifications: ["contact", "resume_upload"],
    }).execute(request());
    expect(email.fillCalls).toBe(1);
    expect(salary.fillCalls).toBe(0);
    expect(result.state).toBe("requires_human");
    if (result.state === "requires_human") expect(result.blocker.questionProvenance).toBe("ATS_FORM");
    expect(session.submitClicks).toBe(0);
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
    expect(result.blockers[0]?.questionProvenance).toBe("POLICY");
    expect(session.submitClicks).toBe(0);
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
    expect(result.blocker.questionProvenance).toBe("ATS_FORM");
    expect(result.blocker.field).toBe(fieldId);
    expect(result.blocker.question).toBe(`Required question under "Standard Work Authorization - US": "Are you legally eligible to work in the US?" — choose Yes or No.`);
    expect(result.blocker.reason).toContain("no value was guessed");
    expect(result.blocker.evidence).toContain("field-type:radio");
    expect(result.blocker.evidence).toContain("field-required:true");
    expect(result.blocker.evidence).toContain("field-label:Yes");
    expect(result.blocker.evidence).toContain("options:Yes|No");
    expect(result.blocker.evidence).toContain("question-source:question_container");
    expect(result.blocker.evidence).toContain("question-confidence:high");
    expect(session.fields[0].selectCalls).toBe(0);
    expect(session.submitClicks).toBe(0);
  });

  it("does not reuse a prepared answer for an unknown inspected control", async () => {
    const field = new FakeField({
      id: "question_123",
      label: "Yes",
      type: "select",
      required: true,
      options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
      questionDescriptor: {
        promptText: "An employer-specific question",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    });
    const session = new FakeSession([field]);
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      now: () => capturedAt,
    }).execute(request({
      application: application({
        answers: [answer("employment_history", "Prepared employment summary")],
      }),
    }));

    expect(result.state).toBe("requires_human");
    expect(field.selectCalls).toBe(0);
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
    expect(first.blocker.questionProvenance).toBe("ATS_FORM");
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

  it("reuses a resolved free-text ATS answer when the inspected field has no options", async () => {
    const field = new FakeField({
      id: "question-referral",
      label: "Were you referred by a Kapitus employee? If yes, please provide the employee's full name*",
      type: "text",
      required: true,
      questionDescriptor: {
        promptText: "Were you referred by a Kapitus employee? If yes, please provide the employee's full name*",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    });
    const blocker: CareerBlocker = {
      ...resolvedCareerBlocker("question-referral", "No"),
      kind: "unknown_form_field",
      question: field.label,
      evidence: [
        "executor:greenhouse-browser",
        "field-id:question-referral",
        "field-type:text",
        `field-label:${field.label}`,
        "field-required:true",
        "classification:unknown",
        `question-prompt:${field.label}`,
      ],
    };
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(new FakeSession([field])),
      now: () => capturedAt,
    }).execute(request({ careerJob: careerJob({ blockers: [blocker] }) }));

    expect(result.state).toBe("ready_to_submit");
    expect(field.current).toBe("No");
  });

  it("reuses a resolved combobox answer when Greenhouse hides options on resume", async () => {
    const field = new FakeField({
      id: "question-age",
      label: "Are you 18 years of age or older?*",
      type: "select",
      required: true,
      questionDescriptor: {
        promptText: "Are you 18 years of age or older?*",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    });
    const blocker: CareerBlocker = {
      ...resolvedCareerBlocker("question-age", "yes"),
      kind: "unknown_form_field",
      question: field.label,
      evidence: [
        "executor:greenhouse-browser",
        "field-id:question-age",
        "field-type:select",
        `field-label:${field.label}`,
        "field-required:true",
        "classification:unknown",
        "options:Yes|No",
        `question-prompt:${field.label}`,
      ],
    };
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(new FakeSession([field])),
      now: () => capturedAt,
    }).execute(request({ careerJob: careerJob({ blockers: [blocker] }) }));

    expect(result.state).toBe("ready_to_submit");
    expect(field.current).toBe("yes");
  });

  it("does not fabricate missing facts and handles policy-sensitive demographic/legal fields conservatively", async () => {
    const requiredDemographic = new FakeSession([
      new FakeField({ id: "gender", label: "Gender identity", type: "select", required: true, options: [{ label: "Option", value: "option" }] }),
    ]);
    const demographicResult = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(requiredDemographic), now: () => capturedAt }).execute(request());
    expect(demographicResult.state).toBe("requires_human");
    expect(demographicResult.state === "requires_human" && demographicResult.blocker.kind).toBe("demographic_disclosure");
    expect(demographicResult.state === "requires_human" && demographicResult.blocker.questionProvenance).toBe("ATS_FORM");

    const optionalDemographic = new FakeSession([
      new FakeField({ id: "gender", label: "Gender identity", type: "select", required: false, options: [{ label: "Option", value: "option" }] }),
    ]);
    const optionalResult = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(optionalDemographic), now: () => capturedAt }).execute(request());
    expect(optionalResult.state).toBe("ready_to_submit");
    expect(optionalResult.state === "ready_to_submit" && optionalResult.inspection.blockers).toHaveLength(0);
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

  it.each([
    ["LinkedIn URL", "linkedin_url", "LinkedIn URL", "linkedinUrl", "https://www.linkedin.com/in/example-candidate"],
    ["website URL", "website", "Personal website", "websiteUrl", "https://example.com"],
    ["preferred work location", "desired_location", "What is your preferred work location?", "preferredWorkLocation", "Remote - United States"],
    ["available start date", "availability", "When are you available to start?", "availabilityStartDate", "2026-10-01"],
  ] as const)("does not map an unrelated fact into %s, but fills the explicit fact when present", async (_name, id, label, fact, expected) => {
    expect(classifyLeverApplicationField({ id, label, type: "text" })).toBe(
      fact === "linkedinUrl" ? "linkedin" :
        fact === "websiteUrl" ? "website" :
          fact === "preferredWorkLocation" ? "desired_work_location" : "start_availability",
    );
    const absentField = new FakeField({ id, label, type: "text", required: true });
    const absentSession = new FakeSession([absentField]);
    const absentResult = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(absentSession),
      now: () => capturedAt,
    }).execute(request());

    expect(absentResult.state).toBe("requires_human");
    expect(absentField.current).toBeNull();
    expect(absentResult.state === "requires_human" && absentResult.blocker.kind).toBe("unknown_fact");

    const explicitField = new FakeField({ id, label, type: "text", required: true });
    const explicitSession = new FakeSession([explicitField]);
    const explicitProfile: CandidateProfile = {
      ...exampleCandidateProfile,
      identity: {
        ...exampleCandidateProfile.identity,
        ...(fact === "linkedinUrl" ? { linkedinUrl: expected } : {}),
        ...(fact === "websiteUrl" ? { websiteUrl: expected } : {}),
      },
      workPreferences: {
        ...exampleCandidateProfile.workPreferences,
        ...(fact === "preferredWorkLocation" ? { preferredWorkLocation: expected } : {}),
        ...(fact === "availabilityStartDate" ? { availabilityStartDate: expected } : {}),
      },
    };
    const explicitResult = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(explicitSession),
      now: () => capturedAt,
    }).execute(request({ profile: explicitProfile }));

    expect(explicitResult.state).toBe("ready_to_submit");
    expect(explicitField.current).toBe(expected);
  });

  it("maps compound Greenhouse country and availability controls to grounded option values", async () => {
    const fields = [
      new FakeField({
        id: "country",
        label: "Country*",
        type: "select",
        required: true,
        options: [{ label: "United States +1", value: "United States +1" }],
      }),
      new FakeField({
        id: "start-month--0",
        label: "Start date month",
        type: "select",
        options: [{ label: "October", value: "October" }],
      }),
      new FakeField({ id: "start-year--0", label: "Start date year", type: "text" }),
    ];
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      identity: { ...exampleCandidateProfile.identity, location: "Pittsburgh, PA, United States" },
      workPreferences: { ...exampleCandidateProfile.workPreferences, availabilityStartDate: "2026-10-01" },
    };
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(new FakeSession(fields)),
      now: () => capturedAt,
    }).execute(request({ profile }));

    expect(result.state).toBe("ready_to_submit");
    if (result.state !== "ready_to_submit") return;
    expect(isExecutionInspection(result.inspection)).toBe(true);
    expect(fields[0].current).toBe("United States +1");
    expect(fields[1].current).toBe("October");
    expect(fields[2].current).toBe("2026");
  });

  it("matches a grounded full state name to an abbreviated select option", async () => {
    const state = new FakeField({
      id: "question-state",
      label: "What state do you currently reside in?*",
      type: "select",
      required: true,
      options: [{ label: "PA", value: "pa" }],
    });
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      identity: { ...exampleCandidateProfile.identity, location: "Pittsburgh, Pennsylvania, United States" },
    };
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(new FakeSession([state])),
      now: () => capturedAt,
    }).execute(request({ profile }));

    expect(result.state).toBe("ready_to_submit");
    expect(state.current).toBe("pa");
  });

  it("uses the actual inspected controls and preserves job-specific questions", async () => {
    const salary = new FakeSession([new FakeField({
      id: "salary-one",
      label: "Compensation expectation",
      type: "text",
      required: true,
      questionDescriptor: {
        promptText: "What base salary would you expect for this role?",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    })]);
    const salaryResult = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(salary),
      now: () => capturedAt,
    }).execute(request());
    expect(salaryResult.state).toBe("requires_human");
    if (salaryResult.state !== "requires_human") return;
    expect(salaryResult.blockers?.[0]).toMatchObject({
      kind: "salary",
      question: "What base salary would you expect for this role?",
      questionProvenance: "ATS_FORM",
    });

    const travel = new FakeSession([new FakeField({
      id: "travel-two",
      label: "Travel availability",
      type: "select",
      required: true,
      options: [{ label: "None", value: "none" }, { label: "Up to 25%", value: "25" }],
      questionDescriptor: {
        promptText: "How much travel are you willing to do?",
        sourceStrategy: "aria_labelledby",
        confidence: "high",
      },
    })]);
    const travelResult = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(travel),
      now: () => capturedAt,
    }).execute(request());
    expect(travelResult.state).toBe("requires_human");
    if (travelResult.state !== "requires_human") return;
    expect(travelResult.blockers?.[0]).toMatchObject({
      kind: "travel",
      question: "How much travel are you willing to do?",
      questionProvenance: "ATS_FORM",
    });
    expect(travelResult.blockers?.[0]?.question).not.toBe(salaryResult.blockers?.[0]?.question);

    const custom = new FakeSession([new FakeField({
      id: "custom-question",
      label: "Additional information",
      type: "textarea",
      required: true,
      questionDescriptor: {
        promptText: "Tell us about a system you improved recently.",
        sourceStrategy: "nearby_text",
        confidence: "medium",
      },
    })]);
    const customResult = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(custom),
      now: () => capturedAt,
    }).execute(request());
    expect(customResult.state).toBe("requires_human");
    expect(customResult.state === "requires_human" && customResult.blocker).toMatchObject({
      kind: "subjective_answer",
      question: "Tell us about a system you improved recently.",
      questionProvenance: "ATS_FORM",
    });
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

  it("submits only when the campaign and trusted executor both authorize automatic submission", async () => {
    const session = new FakeSession([
      new FakeField({ id: "email", label: "Email", type: "email", required: true }),
    ]);
    const automaticCampaign = {
      ...campaign(),
      submissionPolicy: { authority: "automatic" as const, requireExplicitApproval: false },
    };
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      allowAutomaticSubmission: true,
      now: () => capturedAt,
    }).execute(request({ campaign: automaticCampaign }));

    expect(result.state).toBe("submitted");
    expect(result.state === "submitted" && result.proof.mode).toBe("external");
    expect(session.submitClicks).toBe(1);
  });

  it("never submits an automatic campaign when a required field remains unresolved", async () => {
    const session = new FakeSession([
      new FakeField({ id: "email", label: "Email", type: "email", required: true }),
      new FakeField({ id: "salary", label: "Expected salary", type: "text", required: true }),
    ]);
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      allowAutomaticSubmission: true,
      now: () => capturedAt,
    }).execute(request({
      campaign: { ...campaign(), submissionPolicy: { authority: "automatic", requireExplicitApproval: false } },
    }));

    expect(result.state).toBe("requires_human");
    expect(session.submitClicks).toBe(0);
    expect(result.state === "requires_human" && result.blocker.kind).toBe("salary");
  });
});


describe("Rippling field classification regressions", () => {
  const dialingOptions: ApplicationFieldOption[] = [
    { label: "+247 AC - Ascension Island", value: "+247 AC - Ascension Island" },
    { label: "+376 AD - Andorra", value: "+376 AD - Andorra" },
    { label: "+971 AE - United Arab Emirates", value: "+971 AE - United Arab Emirates" },
    { label: "+93 AF - Afghanistan", value: "+93 AF - Afghanistan" },
    { label: "+1 AG - Antigua & Barbuda", value: "+1 AG - Antigua & Barbuda" },
    { label: "+1 AI - Anguilla", value: "+1 AI - Anguilla" },
    { label: "+355 AL - Albania", value: "+355 AL - Albania" },
    { label: "+374 AM - Armenia", value: "+374 AM - Armenia" },
    { label: "+1 US - United States", value: "+1 US - United States" },
    { label: "+44 GB - United Kingdom", value: "+44 GB - United Kingdom" },
  ];

  it("classifies Location from question prompt when the DOM label is opaque", () => {
    expect(classifyLeverApplicationField({
      id: "field-12",
      label: "textbox",
      type: "text",
      questionDescriptor: {
        promptText: "Location",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    })).toBe("location");
  });

  it("classifies Search selects with international dialing options as location", () => {
    expect(looksLikeInternationalDialingOptions(dialingOptions)).toBe(true);
    expect(classifyLeverApplicationField({
      id: "field-34",
      label: "Search",
      type: "select",
      options: dialingOptions,
    })).toBe("location");
  });

  it("classifies truncated Rippling dialing lists with only 7 sampled options", () => {
    const truncated = dialingOptions.slice(0, 7);
    expect(truncated).toHaveLength(7);
    expect(looksLikeInternationalDialingOptions(truncated)).toBe(true);
    expect(classifyLeverApplicationField({
      id: "field-34",
      label: "Search",
      type: "select",
      options: truncated,
    })).toBe("location");
    expect(looksLikeInternationalDialingOptions([
      { label: "She/her/hers", value: "She/her/hers" },
      { label: "He/him/his", value: "He/him/his" },
      { label: "They/them/theirs", value: "They/them/theirs" },
      { label: "Ze/hir/hir", value: "Ze/hir/hir" },
      { label: "Prefer not to say", value: "Prefer not to say" },
    ])).toBe(false);
  });

  it("classifies opaque custom ids from the question prompt", () => {
    expect(classifyLeverApplicationField({
      id: "73RMCCC5P40",
      label: "73RMCCC5P40",
      type: "text",
      questionDescriptor: {
        promptText: "What is your desired annual compensation?",
        sourceStrategy: "nearby_text",
        confidence: "medium",
      },
    })).toBe("salary");
  });

  it("fills Rippling Location and phone-country controls from profile without submitting", async () => {
    const location = new FakeField({
      id: "field-12",
      label: "textbox",
      type: "text",
      required: true,
      questionDescriptor: {
        promptText: "Location",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    });
    const phoneCountry = new FakeField({
      id: "field-34",
      label: "Search",
      type: "select",
      required: true,
      options: dialingOptions,
    });
    const email = new FakeField({ id: "email", label: "Email", type: "email", required: true });
    const session = new FakeSession([email, location, phoneCountry]);
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      now: () => capturedAt,
    }).execute(request());

    expect(result.state).toBe("ready_to_submit");
    expect(session.submitClicks).toBe(0);
    expect(location.current).toBe(exampleCandidateProfile.identity.location ?? exampleCandidateProfile.location);
    expect(String(phoneCountry.current)).toContain("United States");
  });

  it("typeahead-fills phone-country when the truncated dialing sample omits the grounded country", async () => {
    const truncated = dialingOptions.filter((option) => !/United States/i.test(option.label));
    expect(truncated.some((option) => /United States/i.test(option.label))).toBe(false);
    expect(looksLikeInternationalDialingOptions(truncated)).toBe(true);

    const phoneCountry = new FakeField({
      id: "field-34",
      label: "Search",
      type: "select",
      required: true,
      options: truncated,
    });
    const email = new FakeField({ id: "email", label: "Email", type: "email", required: true });
    const session = new FakeSession([email, phoneCountry]);
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      now: () => capturedAt,
    }).execute(request());

    expect(result.state).toBe("ready_to_submit");
    expect(session.submitClicks).toBe(0);
    expect(phoneCountry.selectCalls).toBe(1);
    expect(String(phoneCountry.current)).toBe(exampleCandidateProfile.identity.location?.split(",").at(-1)?.trim() === "US"
      ? "United States"
      : String(phoneCountry.current));
    expect(String(phoneCountry.current)).toMatch(/United States|US/i);
  });

  it("supports a verified Workday application destination through the existing browser policy", async () => {
    const workdayUrl = "https://homedepot.wd5.myworkdayjobs.com/en-US/CareerDepot/job/TEXAS---VIRTUAL---TX01/Software-Engineer-II--REMOTE-_Req191434/apply";
    const optionalField = new FakeField({ id: "optional-note", label: "Optional note", type: "text" });
    const session = new FakeSession([optionalField]);
    const base = request();
    const workdayJob = careerJob({
      sourceId: "himalayas-live",
      sourceRecordId: "home-depot-workday-job",
      destinationResolution: {
        status: "resolved",
        attemptedAt: capturedAt,
        destinationUrl: workdayUrl,
        ats: "Workday",
        actionable: true,
        provenance: "official_employer_evidence",
        evidence: ["official Workday destination"],
      },
      job: {
        ...base.careerJob.job,
        company: "HOME DEPOT U.S.A., INC.",
        title: "Software Engineer II (REMOTE)",
        sourceUrl: "https://himalayas.app/companies/home-depot-u-s-a-inc/jobs/software-engineer-ii",
        applicationUrl: workdayUrl,
      },
    });
    const workdayRequest = request({
      careerJob: workdayJob,
      application: application({ job: workdayJob.job }),
    });
    const executor = new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      provider: "auto",
    });

    expect(executor.supports(workdayRequest)).toBe(true);
    const result = await executor.execute(workdayRequest);

    expect(result.state).toBe("ready_to_submit");
    expect(session.submitClicks).toBe(0);
  });

  it("supports a directly correlated curated Lever posting through the existing browser policy", async () => {
    const postingId = "885d7a1a-16f6-4326-9d7c-da7404dfd1f5";
    const sourceUrl = `https://jobs.lever.co/mcgovern/${postingId}`;
    const applicationUrl = `${sourceUrl}/apply`;
    const session = new FakeSession([new FakeField({ id: "optional-note", label: "Optional note", type: "text" })]);
    const base = request();
    const leverJob = careerJob({
      sourceId: "curated-live",
      sourceRecordId: postingId,
      destinationResolution: {
        status: "resolved",
        attemptedAt: capturedAt,
        destinationUrl: applicationUrl,
        ats: "Lever",
        actionable: true,
        provenance: "recognized_ats_evidence",
        evidence: ["curated:explicit-public-posting"],
      },
      job: {
        ...base.careerJob.job,
        company: "Patrick J. McGovern Foundation",
        title: "Jr DevOps Engineer",
        sourceUrl,
        applicationUrl,
      },
    });
    const leverRequest = request({
      careerJob: leverJob,
      application: application({ job: leverJob.job }),
    });
    const executor = new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      provider: "auto",
    });

    expect(executor.supports(leverRequest)).toBe(true);
    const result = await executor.execute(leverRequest);

    expect(result.state).toBe("ready_to_submit");
    expect(session.submitClicks).toBe(0);
  });

  it("supports a directly correlated curated Ashby posting through the existing browser policy", async () => {
    const postingId = "3b06208b-34fe-4dda-b409-ee3fd9305cc3";
    const sourceUrl = `https://jobs.ashbyhq.com/Mastra/${postingId}`;
    const applicationUrl = `${sourceUrl}/application`;
    const session = new FakeSession([new FakeField({ id: "optional-note", label: "Optional note", type: "text" })]);
    const base = request();
    const ashbyJob = careerJob({
      sourceId: "curated-live",
      sourceRecordId: `Mastra:${postingId}`,
      destinationResolution: {
        status: "resolved",
        attemptedAt: capturedAt,
        destinationUrl: applicationUrl,
        ats: "Ashby",
        actionable: true,
        provenance: "recognized_ats_evidence",
        evidence: ["curated:explicit-public-posting"],
      },
      job: {
        ...base.careerJob.job,
        company: "Mastra",
        title: "Platform Engineer",
        sourceUrl,
        applicationUrl,
      },
    });
    const ashbyRequest = request({
      careerJob: ashbyJob,
      application: application({ job: ashbyJob.job }),
    });
    const executor = new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      provider: "auto",
    });

    expect(executor.supports(ashbyRequest)).toBe(true);
    const result = await executor.execute(ashbyRequest);

    expect(result.state).toBe("ready_to_submit");
    expect(session.submitClicks).toBe(0);
  });
});
