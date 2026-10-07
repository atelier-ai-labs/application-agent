import { describe, expect, it } from "vitest";
import {
  LeverBrowserExecutor,
  classifyLeverApplicationField,
  isPhoneCountrySelector,
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
  type BrowserUnavailablePage,
  type CareerBlocker,
  type CareerJob,
  type Campaign,
  type CandidateProfile,
  type LeverBrowserField,
  type LeverBrowserSession,
  type LeverBrowserSessionFactory,
  normalizeNumericSalaryValue,
  salaryValuesEqual,
} from "../application-agent/src";
import { isTrustedAutomaticConfirmation } from "../application-agent/src/domain/leverBrowserExecutor";
import {
  classifyCaptchaEvidence,
  classifyUnavailablePage,
  questionDescriptorFromEvidence,
  stableSelectorForControl,
  classifyPostSubmitError,
  nativeValidityEvidence,
  type CaptchaDomObservation,
} from "../application-agent/automation/playwrightLeverBrowserSession";

const capturedAt = "2026-08-30T12:00:00.000Z";
const hostedUrl = "https://jobs.lever.co/h1/post-1";
const applicationUrl = `${hostedUrl}/apply`;

describe("post-submit browser diagnostics", () => {
  it("classifies visible resume and upload failures without retaining their text", () => {
    expect(classifyPostSubmitError("Resume upload failed: file type is not supported")).toBe("upload-error");
    expect(classifyPostSubmitError("Please select a resume before continuing")).toBe("upload-error");
  });

  it("classifies visible required-field failures", () => {
    expect(classifyPostSubmitError("This field is required")).toBe("validation-error");
    expect(classifyPostSubmitError("Please enter a valid phone number")).toBe("validation-error");
  });

  it("does not infer a failure from unrelated page text", () => {
    expect(classifyPostSubmitError("Thanks for visiting our careers page")).toBeNull();
  });

  it("captures only safe native validity identity and flags", () => {
    const evidence = nativeValidityEvidence({
      ordinal: 0,
      tagName: "INPUT",
      type: "tel",
      flags: ["valueMissing", "typeMismatch"],
    });
    expect(evidence).toBe("invalid-control:ordinal-0;kind:input:tel;validity:valueMissing,typeMismatch");
    expect(evidence).not.toContain("candidate");
    expect(evidence).not.toContain("resume.pdf");
  });
});

class FakeField implements LeverBrowserField {
  readonly classification = "unknown" as const;
  readonly id: string;
  readonly label: string;
  readonly type: ApplicationFieldType;
  readonly required: boolean;
  readonly section?: string;
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
    section?: string;
    options?: readonly ApplicationFieldOption[];
    questionDescriptor?: LeverBrowserField["questionDescriptor"];
    current?: string | boolean | null;
  }) {
    this.id = options.id;
    this.label = options.label;
    this.type = options.type as ApplicationFieldType;
    this.required = options.required ?? false;
    this.section = options.section;
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
  unavailablePage?: BrowserUnavailablePage;
  submitControl = true;
  formAction?: string | null;
  resumeVerificationResult?: boolean;
  submitResult: Awaited<ReturnType<LeverBrowserSession["submit"]>> = {
    clicked: true,
    confirmed: true,
    outcome: "confirmed",
    externalApplicationId: "confirmation:test",
    confirmationOrigin: "https://jobs.lever.co",
    confirmationUrl: "https://jobs.lever.co/success/post-1",
    evidence: "submit:clicked; confirmation:url",
  };

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

  async formActionOrigin(): Promise<string | null> {
    return this.formAction ?? null;
  }

  async verifyPageIdentity(): Promise<boolean> {
    return true;
  }

  async verifyUploadedFile(_path: string): Promise<boolean> {
    return this.resumeVerificationResult ?? true;
  }

  async detectUnavailablePage(): Promise<BrowserUnavailablePage | null> {
    return this.unavailablePage ?? null;
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
    return this.submitResult;
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
  it("normalizes currency syntax only for numeric salary controls and verifies the exact amount", async () => {
    expect(normalizeNumericSalaryValue("$100,000")).toBe("100000");
    expect(normalizeNumericSalaryValue("USD 100000.00")).toBe("100000.00");
    expect(normalizeNumericSalaryValue("100k")).toBeUndefined();
    expect(salaryValuesEqual("$100,000", "100000.00")).toBe(true);
    expect(salaryValuesEqual("$100,000", "100001")).toBe(false);

    const salary = new FakeField({ id: "cSalary", label: "Desired Salary", type: "text", required: true });
    const resolved = resolvedCareerBlocker("cSalary", "$100,000");
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(new FakeSession([salary])),
      now: () => capturedAt,
    }).execute(request({ careerJob: careerJob({ blockers: [resolved] }) }));

    expect(result.state).toBe("ready_to_submit");
    expect(salary.current).toBe("100000");
  });

  it("accepts only provider-owned confirmation routes with URL evidence", () => {
    expect(isTrustedAutomaticConfirmation({ clicked: true, confirmed: true, externalApplicationId: "confirmation:jobs.lever.co/success/post-1", confirmationOrigin: "https://jobs.lever.co", confirmationUrl: "https://jobs.lever.co/success/post-1", evidence: "submit:clicked; confirmation:url" }, { provider: "lever", postingId: "post-1", applicationUrl: "https://jobs.lever.co/acme/role/apply" })).toBe(true);
    expect(isTrustedAutomaticConfirmation({ clicked: true, confirmed: true, externalApplicationId: "confirmation:jobs.lever.co/success/post-1", confirmationOrigin: "https://jobs.lever.co", confirmationUrl: "https://jobs.lever.co/success/post-1", evidence: "submit:clicked; confirmation:text" }, { provider: "lever", postingId: "post-1", applicationUrl: "https://jobs.lever.co/acme/role/apply" })).toBe(false);
    expect(isTrustedAutomaticConfirmation({ clicked: true, confirmed: true, externalApplicationId: "confirmation:jobs.lever.co/success/other", confirmationOrigin: "https://jobs.lever.co", confirmationUrl: "https://jobs.lever.co/success/other", evidence: "submit:clicked; confirmation:url" }, { provider: "lever", postingId: "post-1", applicationUrl: "https://jobs.lever.co/acme/role/apply" })).toBe(false);
    expect(isTrustedAutomaticConfirmation({ clicked: true, confirmed: true, externalApplicationId: "confirmation:jobs.lever.co/success/9123", confirmationOrigin: "https://jobs.lever.co", confirmationUrl: "https://jobs.lever.co/success/9123", evidence: "submit:clicked; confirmation:url" }, { provider: "lever", postingId: "123", applicationUrl: "https://jobs.lever.co/acme/role/apply" })).toBe(false);
    expect(isTrustedAutomaticConfirmation({ clicked: true, confirmed: true, externalApplicationId: "confirmation:jobs.lever.co/success/123", confirmationOrigin: "https://jobs.lever.co", confirmationUrl: "https://jobs.lever.co/success?jobId=9123", evidence: "submit:clicked; confirmation:url" }, { provider: "lever", postingId: "123", applicationUrl: "https://jobs.lever.co/acme/role/apply" })).toBe(false);
  });
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

    const ashbyGenerated = stableSelectorForControl({ tagName: "input", id: "9df472d4-generated-radio" });
    expect(ashbyGenerated?.selector).toBe('input[id="9df472d4-generated-radio"]');
    expect(ashbyGenerated?.source).toBe("dom-id:9df472d4-generated-radio");

    const ashbyCombobox = stableSelectorForControl({
      tagName: "input",
      role: "combobox",
      fieldPath: "_systemfield_location",
    });
    expect(ashbyCombobox).toEqual({
      selector: '[data-field-path="_systemfield_location"] input[role="combobox"]',
      source: "dom-field-path:_systemfield_location",
    });
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
      markerCount: 2,
      visibleMarkerCount: 1,
      challengeIframeCount: 1,
      visibleChallengeIframeCount: 1,
      resolvedChallengeCount: 1,
    }))).toMatchObject({
      state: "none",
      resolvedChallengeCount: 1,
      evidenceCategory: "challenge_completed",
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
    expect(classifyCaptchaEvidence(captchaObservation({
      markerCount: 7,
      visibleMarkerCount: 0,
      explicitChallengeText: false,
    }))).toMatchObject({
      state: "infrastructure_present",
      evidenceCategory: "hidden_infrastructure",
    });
  });

  it("classifies strong stale-posting markers without treating them as form blockers", async () => {
    expect(classifyUnavailablePage("Job not found\nView all open positions")).toEqual({
      reasonCode: "posting_not_found",
      evidence: ["posting:job-not-found"],
    });
    expect(classifyUnavailablePage("This position is no longer available")).toEqual({
      reasonCode: "posting_closed",
      evidence: ["posting:closed"],
    });
    expect(classifyUnavailablePage("A normal application form", "Jobs")).toBeNull();

    const session = new FakeSession([]);
    session.unavailablePage = classifyUnavailablePage("Job not found\nView all open positions") ?? undefined;
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      now: () => capturedAt,
    }).execute(request());

    expect(result.state).toBe("failed");
    if (result.state !== "failed") return;
    expect(result.retryable).toBe(false);
    expect(result.inspection?.diagnostic).toMatchObject({
      stage: "controls_inspection",
      reasonCode: "posting_not_found",
    });
    expect(result.inspection?.blockers).toHaveLength(0);
    expect(session.submitClicks).toBe(0);
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

  it("routes source questions to human input and uses the explicit current-company profile fact", async () => {
    expect(classifyLeverApplicationField({ id: "_systemfield_name", label: "Name", type: "text" })).toBe("contact");
    expect(classifyLeverApplicationField({ id: "current_company", label: "Name of current company", type: "text" })).toBe("employment_history");
    const ashbyName = new FakeField({ id: "_systemfield_name", label: "Name", type: "text", required: true });
    const ashbyNameResult = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(new FakeSession([ashbyName])),
      now: () => capturedAt,
    }).execute(request());
    expect(ashbyNameResult.state).toBe("ready_to_submit");
    expect(ashbyName.current).toBe(exampleCandidateProfile.identity.fullName);

    expect(classifyLeverApplicationField({ id: "source", label: "How did you hear about this job?", type: "text" })).toBe("unknown");
    const source = new FakeField({ id: "source", label: "How did you hear about this job?", type: "text", required: true });
    const sourceSession = new FakeSession([source]);
    const staleSourceBlocker: CareerBlocker = {
      ...resolvedCareerBlocker("source", "Reddit careers page"),
      kind: "subjective_answer",
      question: "Why do you want to work here?",
    };
    const sourceResult = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(sourceSession), now: () => capturedAt }).execute(request({ careerJob: careerJob({ blockers: [staleSourceBlocker] }) }));
    expect(sourceResult.state).toBe("requires_human");
    expect(sourceResult.state === "requires_human" && sourceResult.blocker.kind).toBe("unknown_form_field");
    expect(source.current).toBeNull();

    const currentCompany = new FakeField({ id: "current_company", label: "Please provide the name of your current (or most recent) company", type: "text", required: true });
    const companySession = new FakeSession([currentCompany]);
    const profile: CandidateProfile = { ...exampleCandidateProfile, approvedReusableAnswers: { ...exampleCandidateProfile.approvedReusableAnswers, current_company: "Walmart" } };
    const staleCompanyBlocker: CareerBlocker = {
      ...resolvedCareerBlocker("current_company", "Boardroom"),
      kind: "subjective_answer",
      question: "Current or most recent company",
    };
    const companyResult = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(companySession), now: () => capturedAt }).execute({ ...request({ careerJob: careerJob({ blockers: [staleCompanyBlocker] }) }), profile });
    expect(companyResult.state).toBe("ready_to_submit");
    expect(currentCompany.current).toBe("Walmart");
  });

  it("answers the explicit age-of-majority question Yes and keeps employment screening questions human-reviewed", async () => {
    expect(classifyLeverApplicationField({
      id: "age-confirmation",
      label: "Are you eighteen years of age or older?",
      type: "select",
      options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
    })).toBe("legal_attestation");
    expect(classifyLeverApplicationField({
      id: "contact-current-employer",
      label: "May MeridianLink contact your CURRENT or MOST RECENT employer?",
      type: "select",
      options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
    })).toBe("unknown");
    expect(classifyLeverApplicationField({
      id: "termination-history",
      label: "Have you ever been fired or asked to resign to avoid being fired from a job?",
      type: "select",
      options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
    })).toBe("unknown");

    const age = new FakeField({
      id: "age-confirmation",
      label: "Are you eighteen years of age or older?",
      type: "select",
      required: true,
      options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
    });
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(new FakeSession([age])),
    }).execute(request());
    expect(result.state).toBe("ready_to_submit");
    expect(age.current).toBe("yes");
    expect(age.selectCalls).toBe(1);

    const screeningFields = [
      new FakeField({ id: "contact-current-employer", label: "May MeridianLink contact your CURRENT or MOST RECENT employer?", type: "radio", required: true, options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }] }),
      new FakeField({ id: "contact-past-employers", label: "May MeridianLink Contact your PAST employers?", type: "radio", required: true, options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }] }),
      new FakeField({ id: "termination-history", label: "Have you ever been fired or asked to resign to avoid being fired from a job?", type: "radio", required: true, options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }] }),
    ];
    const screeningResult = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(new FakeSession(screeningFields)),
      now: () => capturedAt,
    }).execute(request());
    expect(screeningResult.state).toBe("requires_human");
    expect(screeningResult.state === "requires_human" && screeningResult.blockers).toHaveLength(3);
    expect(screeningFields.every((field) => field.selectCalls === 0)).toBe(true);
  });

  it("uses the approved Internet source answer for discovery prompts but not referrals", async () => {
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      approvedReusableAnswers: {
        ...exampleCandidateProfile.approvedReusableAnswers,
        job_source: "Internet",
      },
    };
    const sourceFields = [
      new FakeField({ id: "heard", label: "How did you hear about us?", type: "text", required: true }),
      new FakeField({ id: "learned", label: "How did you learn about this opportunity?", type: "text", required: true }),
      new FakeField({ id: "discovered", label: "How did you discover this role?", type: "text", required: true }),
    ];
    const sourceResult = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(new FakeSession(sourceFields)),
    }).execute(request({ profile }));
    expect(sourceResult.state).toBe("ready_to_submit");
    expect(sourceFields.map((field) => field.current)).toEqual(["Internet", "Internet", "Internet"]);

    const referral = new FakeField({
      id: "referral",
      label: "Who referred you to this role? Enter their name.",
      type: "text",
      required: true,
    });
    const referralResult = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(new FakeSession([referral])),
    }).execute(request({ profile }));
    expect(referralResult.state).toBe("requires_human");
    expect(referral.current).toBeNull();
  });

  it("lets a resolved source blocker override the reusable Internet default", async () => {
    const source = new FakeField({
      id: "source",
      label: "How did you hear about this job?",
      type: "text",
      required: true,
      questionDescriptor: {
        promptText: "How did you hear about this job?",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    });
    const resolvedSource: CareerBlocker = {
      ...resolvedCareerBlocker("source", "Employee referral"),
      kind: "unknown_form_field",
      question: "How did you hear about this job?",
      evidence: ["question-prompt:How did you hear about this job?"],
    };
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      approvedReusableAnswers: { ...exampleCandidateProfile.approvedReusableAnswers, job_source: "Internet" },
    };
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(new FakeSession([source])),
    }).execute(request({ profile, careerJob: careerJob({ blockers: [resolvedSource] }) }));
    expect(result.state).toBe("ready_to_submit");
    expect(source.current).toBe("Employee referral");
  });

  it("preserves exactly verified prefilled select and checkbox controls", async () => {
    const gender = new FakeField({ id: "430", label: "Gender identity", type: "select", required: true, current: "Male", options: [{ label: "Male", value: "Male" }, { label: "Female", value: "Female" }] });
    const consent = new FakeField({ id: "consent", label: "Demographic consent", type: "checkbox", required: true, current: true });
    const session = new FakeSession([gender, consent]);
    const result = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session) }).execute(request());
    expect(result.state).toBe("ready_to_submit");
    expect(gender.selectCalls).toBe(0);
    expect(consent.checkCalls).toBe(0);
  });

  it("fails closed for empty, mismatched, or ambiguous prefilled controls", async () => {
    const empty = new FakeField({ id: "empty", label: "Gender identity", type: "select", required: true, options: [{ label: "Male", value: "Male" }] });
    const mismatched = new FakeField({ id: "mismatch", label: "Gender identity", type: "select", required: true, current: "Other", options: [{ label: "Male", value: "Male" }] });
    const ambiguous = new FakeField({ id: "ambiguous", label: "Gender identity", type: "select", required: true, current: "Male", options: [{ label: "Male", value: "a" }, { label: "Male", value: "b" }] });
    const session = new FakeSession([empty, mismatched, ambiguous]);
    const result = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session) }).execute(request());
    expect(result.state).toBe("requires_human");
    expect(mismatched.selectCalls).toBe(0);
    expect(ambiguous.selectCalls).toBe(0);
    expect(result.state === "requires_human" && result.blockers?.some((blocker) => blocker.field === "mismatch" && blocker.kind === "unknown_form_field")).toBe(true);
  });

  it("treats Rippling placeholder-only combobox text as unanswered for demographic selects", async () => {
    const options = (labels: string[]) => labels.map((label) => ({ label, value: label }));
    const gender = new FakeField({ id: "field-103", label: "Gender", type: "select", required: true, current: "Select...", options: options(["Male", "Female", "Non-binary", "Choose not to disclose"]) });
    const hispanic = new FakeField({ id: "field-116", label: "Are you Hispanic/Latino?", type: "select", required: true, current: "Choose", options: options(["Yes", "No"]) });
    const veteran = new FakeField({ id: "field-122", label: "Are you a protected veteran?", type: "select", required: true, current: "Please select an option", options: options(["I am a protected veteran", "No, I am not a protected veteran"]) });
    const disability = new FakeField({ id: "field-128", label: "Do you have a disability?", type: "select", required: true, current: "No answer", options: options(["Yes", "No, I do not have a disability"]) });
    const profile = {
      ...exampleCandidateProfile,
      approvedReusableAnswers: {
        ...exampleCandidateProfile.approvedReusableAnswers,
        gender_identity: "Male",
        hispanic_latino: "No",
        veteran_status: "No, I am not a protected veteran",
        disability_status: "No, I do not have a disability",
      },
    };
    const result = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(new FakeSession([gender, hispanic, veteran, disability])) }).execute(request({ profile }));
    expect(result.state).toBe("ready_to_submit");
    expect([gender, hispanic, veteran, disability].map((field) => field.selectCalls)).toEqual([1, 1, 1, 1]);
    expect([gender, hispanic, veteran, disability].map((field) => field.current)).toEqual([
      "Male",
      "No",
      "No, I am not a protected veteran",
      "No, I do not have a disability",
    ]);
    expect(result.state === "ready_to_submit" && result.inspection.fieldsFilled).toContain("field-103");
  });

  it("keeps real unmatched custom-select values fail closed", async () => {
    const field = new FakeField({ id: "field-103", label: "Gender", type: "select", required: true, current: "Unexpected value", options: [{ label: "Male", value: "Male" }] });
    const result = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(new FakeSession([field])) }).execute(request());
    expect(result.state).toBe("requires_human");
    expect(field.selectCalls).toBe(0);
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

  it("uses an inspected authorization prompt to classify a generated yes/no radio", async () => {
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

    expect(classifyLeverApplicationField({
      id: fieldId,
      label: "Yes",
      type: "radio",
      questionDescriptor: {
        promptText: "Are you legally eligible to work in the US?",
        sectionTitle: "Standard Work Authorization - US",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    })).toBe("work_authorization");
    expect(result.state).toBe("requires_human");
    if (result.state !== "requires_human") return;
    expect(result.blocker.kind).toBe("unknown_fact");
    expect(result.blocker.questionProvenance).toBe("ATS_FORM");
    expect(result.blocker.field).toBe(fieldId);
    expect(result.blocker.question).toBe("Are you legally eligible to work in the US?");
    expect(result.blocker.reason).toContain("No verified profile fact");
    expect(result.blocker.evidence).toContain("field-type:radio");
    expect(result.blocker.evidence).toContain("field-required:true");
    expect(result.blocker.evidence).toContain("field-label:Yes");
    expect(result.blocker.evidence).toContain("options:Yes|No");
    expect(result.blocker.evidence).toContain("question-source:question_container");
    expect(result.blocker.evidence).toContain("question-confidence:high");
    expect(session.fields[0].selectCalls).toBe(0);
    expect(session.submitClicks).toBe(0);
  });

  it("auto-selects grounded authorization and sponsorship for generated yes/no radios", async () => {
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      workAuthorization: {
        status: "authorized to work",
        countries: ["United States"],
        sponsorshipRequired: false,
      },
    };
    const authorization = new FakeField({
      id: "question_authorization_yes",
      label: "Yes",
      type: "radio",
      required: true,
      options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
      questionDescriptor: {
        promptText: "Are you currently authorized to work in the United States?",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    });
    const sponsorship = new FakeField({
      id: "question_sponsorship_no",
      label: "No",
      type: "radio",
      required: true,
      options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
      questionDescriptor: {
        promptText: "Will you now or in the future require immigration sponsorship?",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    });
    const session = new FakeSession([authorization, sponsorship]);
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      now: () => capturedAt,
    }).execute({ ...request(), profile });

    expect(result.state).toBe("ready_to_submit");
    expect(authorization.current).toBe("yes");
    expect(sponsorship.current).toBe("no");
    expect(authorization.selectCalls).toBe(1);
    expect(sponsorship.selectCalls).toBe(1);
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

  it("uses the rendered page for a verified direct application independent of ATS brand", async () => {
    const directUrl = "https://careers.example.com/jobs/agent/apply";
    const session = new FakeSession([
      new FakeField({ id: "email", label: "Email", type: "email", required: true }),
      new FakeField({ id: "mystery", label: "What is your favorite color?", type: "text", required: true }),
    ]);
    const directJob = careerJob({
      sourceId: "curated-live",
      sourceRecordId: "curated:agent",
      job: { ...careerJob().job, sourceUrl: directUrl, applicationUrl: directUrl, ats: "Custom" },
      destinationResolution: {
        status: "resolved", actionable: true, destinationUrl: directUrl,
        ats: "Custom", provenance: "official_employer_evidence", attemptedAt: capturedAt, evidence: ["test:official-employer"],
      },
    });
    const directApplication = application({ job: directJob.job });
    const executor = new LeverBrowserExecutor({ provider: "generic", sessionFactory: new FakeSessionFactory(session), now: () => capturedAt });
    const result = await executor.execute(request({ careerJob: directJob, application: directApplication }));
    expect(result.state).toBe("requires_human");
    expect(session.submitClicks).toBe(0);
    expect(executor.supports(request({ careerJob: directJob, application: directApplication }))).toBe(true);
  });

  it("rejects a rendered form action that crosses the verified application origin", async () => {
    const directUrl = "https://careers.example.com/jobs/agent/apply";
    const session = new FakeSession([new FakeField({ id: "email", label: "Email", type: "email", required: true })]);
    session.formAction = "https://collector.example.net";
    const directJob = careerJob({
      sourceId: "curated-live", sourceRecordId: "curated:agent",
      job: { ...careerJob().job, sourceUrl: directUrl, applicationUrl: directUrl, ats: "Custom" },
      destinationResolution: { status: "resolved", actionable: true, destinationUrl: directUrl, ats: "Custom", provenance: "official_employer_evidence", attemptedAt: capturedAt, evidence: ["test"] },
    });
    const result = await new LeverBrowserExecutor({ provider: "generic", sessionFactory: new FakeSessionFactory(session), now: () => capturedAt }).inspect(request({ careerJob: directJob, application: application({ job: directJob.job }) }));
    expect(result.status).toBe("unsupported");
    expect(result.evidence).toContain("navigation:form-action-cross-origin");
    expect(session.submitClicks).toBe(0);
  });

  it("keeps generic direct forms preparation-only even when automatic authority is configured", async () => {
    const directUrl = "https://careers.example.com/jobs/agent/apply";
    const session = new FakeSession([new FakeField({ id: "email", label: "Email", type: "email", required: true })]);
    const directJob = careerJob({ sourceId: "curated-live", sourceRecordId: "curated:agent", job: { ...careerJob().job, sourceUrl: directUrl, applicationUrl: directUrl, ats: "Custom" }, destinationResolution: { status: "resolved", actionable: true, destinationUrl: directUrl, ats: "Custom", provenance: "official_employer_evidence", attemptedAt: capturedAt, evidence: ["test"] } });
    const result = await new LeverBrowserExecutor({ provider: "generic", allowAutomaticSubmission: true, sessionFactory: new FakeSessionFactory(session), now: () => capturedAt }).execute(request({ careerJob: directJob, application: application({ job: directJob.job }), campaign: { ...campaign(), submissionPolicy: { authority: "automatic", requireExplicitApproval: false } } }));
    expect(["ready_to_submit", "requires_human"]).toContain(result.state);
    expect(session.submitClicks).toBe(0);
    expect(result.state === "ready_to_submit" ? result.note : "submit:not-clicked").toMatch(/manual|preparation|submit:not-clicked/i);
  });

  it("supports the exact YouHired route through the existing browser executor and keeps submission closed", async () => {
    const youHiredUrl = "https://youhired.me/job/1932919574/platform-engineer-remote";
    const fields = [new FakeField({ id: "email", label: "Email", type: "email", required: true })];
    const session = new FakeSession(fields);
    const youHiredJob = careerJob({
      sourceId: "curated-live",
      sourceRecordId: "youhired:1932919574",
      job: {
        ...careerJob().job,
        sourceUrl: youHiredUrl,
        applicationUrl: youHiredUrl,
        ats: "Custom",
      },
    });
    const youHiredApplication = application({ job: youHiredJob.job });
    const executor = new LeverBrowserExecutor({
      provider: "auto",
      sessionFactory: new FakeSessionFactory(session),
      now: () => capturedAt,
    });

    expect(executor.supports(request({ careerJob: youHiredJob, application: youHiredApplication }))).toBe(true);
    const result = await executor.execute(request({ careerJob: youHiredJob, application: youHiredApplication }));

    expect(result.state).toBe("ready_to_submit");
    expect(fields[0]?.current).toBe("candidate@example.invalid");
    expect(session.navigations).toBe(1);
    expect(session.submitClicks).toBe(0);
  });

  it("supports the exact Matlen Silver form route through the existing browser executor", async () => {
    const matlenUrl = "https://matlensilver.com/job/azure-engineer-60869931";
    const fields = [
      new FakeField({ id: "applicant_name", label: "Your name", type: "text", required: true }),
      new FakeField({ id: "email", label: "Your e-mail address", type: "email", required: true }),
      new FakeField({ id: "file", label: "Resume attachment", type: "file" }),
    ];
    const session = new FakeSession(fields);
    const base = request();
    const matlenJob = careerJob({
      sourceId: "curated-live",
      sourceRecordId: "matlensilver:60869931",
      destinationResolution: {
        status: "resolved",
        attemptedAt: capturedAt,
        destinationUrl: matlenUrl,
        ats: "Custom",
        actionable: true,
        provenance: "existing_external_application_url",
        evidence: ["curated:explicit-public-posting", "matlensilver:bounded-job-route"],
      },
      job: {
        ...base.careerJob.job,
        company: "Matlen Silver",
        title: "Cloud Engineer",
        sourceUrl: matlenUrl,
        applicationUrl: matlenUrl,
        ats: "Custom",
      },
    });
    const matlenRequest = request({
      careerJob: matlenJob,
      application: application({ job: matlenJob.job }),
    });
    const executor = new LeverBrowserExecutor({
      provider: "auto",
      sessionFactory: new FakeSessionFactory(session),
      resumePaths: { "cloud-platform": "/tmp/synthetic-cloud-platform.pdf" },
      resumeFileExists: () => true,
      now: () => capturedAt,
    });

    expect(executor.supports(matlenRequest)).toBe(true);
    const result = await executor.execute(matlenRequest);

    expect(result.state).toBe("ready_to_submit");
    expect(fields[0]?.current).toBe(exampleCandidateProfile.identity.fullName);
    expect(fields[1]?.current).toBe(exampleCandidateProfile.identity.email);
    expect(fields[2]?.uploadCalls).toEqual(["/tmp/synthetic-cloud-platform.pdf"]);
    expect(session.navigations).toBe(1);
    expect(session.submitClicks).toBe(0);
  });

  it("supports the exact current Protagona route through the existing browser executor", async () => {
    const protagonaUrl = "https://protagona.applytojob.com/apply/YDO63zlPbH/AWS-Cloud-Engineer";
    const fields = [
      new FakeField({ id: "name", label: "Full name", type: "text", required: true }),
      new FakeField({ id: "email", label: "Email", type: "email", required: true }),
      new FakeField({ id: "resume", label: "Resume", type: "file", required: true }),
    ];
    const session = new FakeSession(fields);
    const base = request();
    const protagonaJob = careerJob({
      sourceId: "curated-live",
      sourceRecordId: "protagona:YDO63zlPbH",
      destinationResolution: {
        status: "resolved",
        attemptedAt: capturedAt,
        destinationUrl: protagonaUrl,
        ats: "Custom",
        actionable: true,
        provenance: "existing_external_application_url",
        evidence: ["curated:explicit-public-posting", "protagona:bounded-job-route"],
      },
      job: {
        ...base.careerJob.job,
        company: "Protagona",
        title: "AWS Cloud Engineer",
        sourceUrl: protagonaUrl,
        applicationUrl: protagonaUrl,
        ats: "Custom",
      },
    });
    const protagonaRequest = request({
      careerJob: protagonaJob,
      application: application({ job: protagonaJob.job }),
    });
    const executor = new LeverBrowserExecutor({
      provider: "auto",
      sessionFactory: new FakeSessionFactory(session),
      resumePaths: { "cloud-platform": "/tmp/synthetic-cloud-platform.pdf" },
      resumeFileExists: () => true,
      now: () => capturedAt,
    });

    expect(executor.supports(protagonaRequest)).toBe(true);
    const result = await executor.execute(protagonaRequest);

    expect(result.state).toBe("ready_to_submit");
    expect(fields[0]?.current).toBe(exampleCandidateProfile.identity.fullName);
    expect(fields[1]?.current).toBe(exampleCandidateProfile.identity.email);
    expect(fields[2]?.uploadCalls).toEqual(["/tmp/synthetic-cloud-platform.pdf"]);
    expect(session.navigations).toBe(1);
    expect(session.submitClicks).toBe(0);
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

  it("answers the GC AI narrative prompt and exact gender-identity prompt", async () => {
    const narrative = new FakeField({
      id: "gc-ai-narrative",
      label: "What’s the most interesting problem you’d want to work on here at GC AI, and why does it pull you in?",
      type: "textarea",
      required: true,
      questionDescriptor: {
        promptText: "What’s the most interesting problem you’d want to work on here at GC AI, and why does it pull you in?",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    });
    const gender = new FakeField({
      id: "gender-identity",
      label: "How do you describe your gender identity?",
      type: "radio",
      required: true,
      options: [{ label: "Man", value: "on" }, { label: "Woman", value: "on" }, { label: "Non-Binary", value: "on" }, { label: "Another Gender Identity", value: "on" }, { label: "I prefer not to answer", value: "on" }],
    });
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      approvedReusableAnswers: { ...exampleCandidateProfile.approvedReusableAnswers, gender_identity: "Male" },
    };
    const session = new FakeSession([narrative, gender]);
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      now: () => capturedAt,
    }).execute(request({
      profile,
      application: application({
        job: {
          ...application().job,
          company: "GC AI",
          title: "Member of Technical Staff, Platform Engineering",
          description: "Build platform and infrastructure systems for GC AI.",
        },
        answers: [answer("why_company", "I’m most interested in building the platform layer that makes AI systems reliable in production, with developer tooling, observability, and delivery systems that help engineers move quickly without sacrificing trust. GC AI pulls me in because that problem sits at the intersection of practical platform engineering and real customer impact; subpoena colada.", { policy: "draft_review", status: "drafted" })],
      }),
    }));

    expect(result.state).toBe("ready_to_submit");
    expect(narrative.current).toContain("subpoena colada");
    expect(gender.current).toBe("Man");
    expect(session.submitClicks).toBe(0);
  });

  it("uploads the resume after later controlled fields", async () => {
    const events: string[] = [];
    const resume = new FakeField({ id: "resume", label: "Resume", type: "file", required: true });
    const answerField = new FakeField({ id: "answer", label: "Why are you interested?", type: "textarea", required: true });
    const originalFill = answerField.fill.bind(answerField);
    answerField.fill = async (value: string) => { events.push("fill"); await originalFill(value); };
    const originalUpload = resume.uploadFile.bind(resume);
    resume.uploadFile = async (path: string) => { events.push("upload"); await originalUpload(path); };
    const session = new FakeSession([resume, answerField]);
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      resumePaths: { "cloud-platform": "/tmp/synthetic-cloud-platform.pdf" },
      resumeFileExists: () => true,
      now: () => capturedAt,
    }).execute(request({
      application: application({
        answers: [answer("why_company", "A grounded prepared answer.", { policy: "draft_review", status: "drafted" })],
      }),
    }));

    expect(result.state).toBe("ready_to_submit");
    expect(events).toEqual(["fill", "upload"]);
  });

  it("maps structured location components without copying the candidate name", async () => {
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      profileKind: "private",
      identity: {
        ...exampleCandidateProfile.identity,
        fullName: "Nate Magera",
        location: "Pittsburgh, Pennsylvania, USA",
      },
      location: "Pittsburgh, Pennsylvania, USA",
    };
    const city = new FakeField({ id: "city", label: "City", type: "text" });
    const state = new FakeField({ id: "state", label: "State", type: "text" });
    const postal = new FakeField({ id: "postal", label: "Postal", type: "text" });
    const address = new FakeField({ id: "address", label: "Address", type: "text" });
    const session = new FakeSession([city, state, postal, address]);

    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      now: () => capturedAt,
    }).execute(request({ profile }));

    expect(result.state).toBe("ready_to_submit");
    expect(city.current).toBe("Pittsburgh");
    expect(state.current).toBe("pa");
    expect(postal.current).toBeNull();
    expect(address.current).toBeNull();
    expect(city.current).not.toBe(profile.identity.fullName);
    expect(state.current).not.toBe(profile.identity.fullName);
    expect(postal.current).not.toBe(profile.identity.fullName);
  });

  it("maps explicit street address and postal code only to their matching controls", async () => {
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      profileKind: "private",
      identity: {
        ...exampleCandidateProfile.identity,
        fullName: "Nate Magera",
        location: "Pittsburgh, Pennsylvania, USA",
        streetAddress: "1308 Oakridge Rd, McDonald, PA",
        postalCode: "15057",
      },
      location: "Pittsburgh, Pennsylvania, USA",
    };
    const address = new FakeField({ id: "address", label: "Address", type: "text" });
    const city = new FakeField({ id: "city", label: "City", type: "text" });
    const state = new FakeField({ id: "state", label: "State", type: "text" });
    const postal = new FakeField({ id: "postal", label: "Postal", type: "text" });
    const session = new FakeSession([address, city, state, postal]);

    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      now: () => capturedAt,
    }).execute(request({ profile }));

    expect(result.state).toBe("ready_to_submit");
    expect(address.current).toBe(profile.identity.streetAddress);
    expect(city.current).toBe("Pittsburgh");
    expect(state.current).toBe("pa");
    expect(postal.current).toBe(profile.identity.postalCode);
  });

  it("splits custom-host first and last name controls from opaque stable IDs", async () => {
    const firstName = new FakeField({ id: "resumator-firstname-value", label: "resumator-firstname-value", type: "text", required: true });
    const lastName = new FakeField({ id: "resumator-lastname-value", label: "resumator-lastname-value", type: "text", required: true });
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      profileKind: "private",
      identity: { ...exampleCandidateProfile.identity, fullName: "Nate Magera" },
    };

    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(new FakeSession([firstName, lastName])),
      now: () => capturedAt,
    }).execute(request({
      profile,
      application: application({ answers: [answer("name", "Nate Magera")] }),
    }));

    expect(result.state).toBe("ready_to_submit");
    expect(firstName.current).toBe("Nate");
    expect(lastName.current).toBe("Magera");
    expect(firstName.current).not.toBe(profile.identity.fullName);
    expect(lastName.current).not.toBe(profile.identity.fullName);
  });

  it("keeps referral prompts human-required instead of filling the candidate name", async () => {
    const prompt = "Who referred you to this position? Enter their first and last name here.";
    const referral = new FakeField({
      id: "referral",
      label: prompt,
      type: "text",
      required: true,
      questionDescriptor: {
        promptText: prompt,
        sourceStrategy: "question_container",
        confidence: "high",
      },
    });
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(new FakeSession([referral])),
      now: () => capturedAt,
    }).execute(request());

    expect(result.state).toBe("requires_human");
    if (result.state !== "requires_human") return;
    expect(result.blocker.questionProvenance).toBe("ATS_FORM");
    expect(result.blocker.question).toBe(prompt);
    expect(referral.current).toBeNull();
    expect(referral.fillCalls).toBe(0);
  });

  it("leaves an optional referral prompt blank and continues", async () => {
    const prompt = "Who referred you to this position? Enter their first and last name here.";
    const referral = new FakeField({
      id: "referral",
      label: prompt,
      type: "text",
      required: false,
      questionDescriptor: {
        promptText: prompt,
        sourceStrategy: "question_container",
        confidence: "high",
      },
    });
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(new FakeSession([referral])),
      now: () => capturedAt,
    }).execute(request());

    expect(result.state).toBe("ready_to_submit");
    if (result.state !== "ready_to_submit") return;
    expect(result.inspection.blockers).toHaveLength(0);
    expect(referral.current).toBeNull();
    expect(referral.fillCalls).toBe(0);
  });

  it("selects the actual yes/no options for grounded authorization and sponsorship facts", async () => {
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      profileKind: "private",
      workAuthorization: {
        status: "authorized to work",
        countries: ["United States"],
        sponsorshipRequired: false,
      },
    };
    const authorization = new FakeField({
      id: "work-authorization",
      label: "Are you legally authorized to work in the United States?",
      type: "select",
      required: true,
      options: [
        { label: "-- No answer --", value: "resumator_no_selection" },
        { label: "Yes", value: "Yes" },
        { label: "No", value: "No" },
      ],
      questionDescriptor: {
        promptText: "Are you legally authorized to work in the United States?",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    });
    const sponsorship = new FakeField({
      id: "sponsorship",
      label: "Will you now, or in the future, require immigration sponsorship to work here?",
      type: "select",
      required: true,
      options: [
        { label: "-- No answer --", value: "resumator_no_selection" },
        { label: "Yes", value: "Yes" },
        { label: "No", value: "No" },
      ],
      questionDescriptor: {
        promptText: "Will you now, or in the future, require immigration sponsorship to work here?",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    });
    const session = new FakeSession([authorization, sponsorship]);
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      now: () => capturedAt,
    }).execute(request({ profile }));

    expect(result.state).toBe("ready_to_submit");
    expect(authorization.current).toBe("Yes");
    expect(sponsorship.current).toBe("No");
    expect(sponsorship.current).not.toBe("false");
    expect(session.submitClicks).toBe(0);
  });

  it("routes exact Rippling-style stable facts and authorized acknowledgments without submitting", async () => {
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      profileKind: "private",
      identity: { ...exampleCandidateProfile.identity, fullName: "Nathaniel Magera", phone: "412-480-0379", location: "McDonald, Pennsylvania, USA" },
      workAuthorization: { status: "authorized", countries: ["United States"], sponsorshipRequired: false },
      approvedReusableAnswers: {
        ...exampleCandidateProfile.approvedReusableAnswers,
        current_company: "Walmart",
        sms_consent: "No",
        gender_identity: "Male",
        veteran_status: "No, I am not a protected veteran",
        disability_status: "No, I do not have a disability",
        race_ethnicity: "White",
        hispanic_latino: "No",
      },
    };
    const liveQuestion = (promptText: string): LeverBrowserField["questionDescriptor"] => ({
      promptText,
      sourceStrategy: "question_container",
      confidence: "high",
    });
    const fields = [
      new FakeField({ id: "current_company", label: "Please provide the name of your current (or most recent) company", type: "text", required: true }),
      new FakeField({ id: "phone_country", label: "Phone country", type: "select", required: true, options: [{ label: "+1 US - United States", value: "US" }, { label: "+44 GB - United Kingdom", value: "GB" }, { label: "+33 FR - France", value: "FR" }, { label: "+49 DE - Germany", value: "DE" }, { label: "+61 AU - Australia", value: "AU" }] }),
      new FakeField({ id: "sms", label: "Do you consent to receive SMS/text messages?", type: "select", required: true, options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }] }),
      new FakeField({ id: "opaque_sponsorship_7f", label: "Search", type: "select", required: true, options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }], questionDescriptor: liveQuestion("Do you now or at any time in the future require sponsorship?") }),
      new FakeField({ id: "opaque_ack_8c", label: "Search", type: "text", required: true, questionDescriptor: liveQuestion("Please note: This position does not offer current or future employment visa sponsorship. By typing \"I Acknowledge\" below, you confirm that you understand this position does not offer current or future employment visa sponsorship and that the information you provided above is accurate.") }),
      new FakeField({ id: "signature", label: "I certify the information is accurate. Please sign your full legal name.", type: "text", required: true }),
      new FakeField({ id: "opaque_gender_3a", label: "Search", type: "select", required: true, options: [{ label: "Male", value: "male" }, { label: "Female", value: "female" }], questionDescriptor: liveQuestion("Gender") }),
      new FakeField({ id: "opaque_ethnicity_4b", label: "Search", type: "select", required: true, options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }], questionDescriptor: liveQuestion("Are you Hispanic/Latino?") }),
      new FakeField({ id: "veteran", label: "Are you a protected veteran?", type: "select", required: true, options: [{ label: "I am not a protected veteran", value: "no-veteran" }, { label: "Protected veteran", value: "veteran" }] }),
      new FakeField({ id: "disability", label: "Disability status", type: "select", required: true, options: [{ label: "No, I do not have a disability", value: "no-disability" }, { label: "Yes", value: "yes" }] }),
    ];
    const session = new FakeSession(fields);
    const result = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), now: () => capturedAt }).execute(request({ profile }));
    expect(result.state).toBe("ready_to_submit");
    expect(fields.map((field) => field.current)).toEqual(["Walmart", "US", "no", "no", "I Acknowledge", "Nathaniel Magera", "male", "no", "no-veteran", "no-disability"]);
    expect(session.submitClicks).toBe(0);
  });

  it("defaults optional SMS/text-message consent to No without requiring a profile override", async () => {
    const smsPrompt = "Check Yes or No to indicate your agreement to receive text message updates from Fullthrottle.ai regarding your job application. Frequency may vary. Message and data rates may apply. Reply HELP for assistance. Reply STOP to opt out of future messaging.";
    const sms = new FakeField({
      id: "sms-consent",
      label: "Search",
      type: "select",
      required: true,
      options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
      questionDescriptor: {
        promptText: smsPrompt,
        sourceStrategy: "question_container",
        confidence: "high",
      },
    });
    const session = new FakeSession([sms]);
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      profileKind: "private",
      approvedReusableAnswers: {},
    };

    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
    }).execute(request({ profile }));

    expect(result.state).toBe("ready_to_submit");
    expect(sms.current).toBe("no");
    expect(session.submitClicks).toBe(0);
  });

  it("does not treat ordinary phone or sponsorship questions as SMS consent", async () => {
    const phone = new FakeField({
      id: "phone",
      label: "Phone number for application contact",
      type: "text",
      required: true,
    });
    const sponsorship = new FakeField({
      id: "sponsorship",
      label: "Do you now or in the future require sponsorship?",
      type: "select",
      required: true,
      options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
    });
    const session = new FakeSession([phone, sponsorship]);
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      profileKind: "private",
      identity: { ...exampleCandidateProfile.identity, phone: "412-480-0379" },
      workAuthorization: { status: "authorized", countries: ["United States"], sponsorshipRequired: false },
    };

    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
    }).execute(request({ profile }));

    expect(result.state).toBe("ready_to_submit");
    expect(phone.current).toBe("412-480-0379");
    expect(sponsorship.current).toBe("no");
    expect(session.submitClicks).toBe(0);
  });

  it("does not broaden acknowledgments or narrative experience questions into guesses", async () => {
    const fields = [
      new FakeField({ id: "ack", label: "Please type 'I Acknowledge' or explain any concerns", type: "text", required: true }),
      new FakeField({ id: "aws-years", label: "How many years of production AWS experience do you have?", type: "text", required: true }),
    ];
    const result = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(new FakeSession(fields)), now: () => capturedAt }).execute(request());
    expect(result.state).toBe("requires_human");
    if (result.state !== "requires_human") return;
    expect((result.blockers ?? []).map((blocker) => blocker.kind)).toEqual(expect.arrayContaining(["unknown_form_field", "subjective_answer"]));
    expect(fields.every((field) => field.fillCalls === 0)).toBe(true);
  });

  it("uses an explicitly approved background-check consent only for a willingness question", async () => {
    const backgroundCheck = new FakeField({
      id: "background_check_consent",
      label: "Are you willing to undergo a background check, in accordance with local law/regulations?",
      type: "select",
      required: true,
      options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
    });
    const session = new FakeSession([backgroundCheck]);
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      answerPolicies: { ...exampleCandidateProfile.answerPolicies, background_check: "auto" },
      approvedReusableAnswers: { background_check: "Yes" },
    };

    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
    }).execute(request({ profile }));

    expect(result.state).toBe("ready_to_submit");
    expect(backgroundCheck.current).toBe("yes");
    expect(backgroundCheck.selectCalls).toBe(1);
    expect(session.submitClicks).toBe(0);
  });

  it("does not reuse background-check consent for a historical screening question", async () => {
    const history = new FakeField({
      id: "prior_background_check",
      label: "Have you previously completed a background check?",
      type: "select",
      required: true,
      options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
    });
    const session = new FakeSession([history]);
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      answerPolicies: { ...exampleCandidateProfile.answerPolicies, background_check: "auto" },
      approvedReusableAnswers: { background_check: "Yes" },
    };

    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
    }).execute(request({ profile }));

    expect(result.state).toBe("requires_human");
    expect(history.selectCalls).toBe(0);
  });

  it("does not reuse a generic subjective draft for a distinct employer question", async () => {
    const session = new FakeSession([new FakeField({
      id: "hard-problem",
      label: "Tell us about a difficult problem you solved.",
      type: "textarea",
      required: true,
      questionDescriptor: {
        promptText: "Tell us about a difficult problem you solved.",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    })]);
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      now: () => capturedAt,
    }).execute(request({
      application: application({
        answers: [answer("why_company", "A generic company-interest draft.", { policy: "draft_review", status: "drafted" })],
      }),
    }));

    expect(result.state).toBe("requires_human");
    if (result.state !== "requires_human") return;
    expect(result.blocker).toMatchObject({
      kind: "subjective_answer",
      question: "Tell us about a difficult problem you solved.",
      questionProvenance: "ATS_FORM",
    });
    expect(session.fields[0]?.current).toBeNull();
  });

  it("does not submit a deterministic placeholder for an exact ATS free-text question", async () => {
    const field = new FakeField({
      id: "why-company",
      label: "Why do you want to work here?",
      type: "textarea",
      required: true,
      questionDescriptor: {
        promptText: "Why do you want to work here?",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    });
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(new FakeSession([field])),
      now: () => capturedAt,
    }).execute(request({
      application: application({
        answers: [answer("why_company", "Draft for review: placeholder.", {
          policy: "draft_review",
          status: "drafted",
          provenance: ["job.company:Example", "draft:deterministic-template"],
        })],
      }),
    }));

    expect(result.state).toBe("requires_human");
    expect(field.current).toBeNull();
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

  it("reuses exact prior Ashby privacy and off-site answers after generated ids change", async () => {
    const privacyPrompt = "By continuing, you acknowledge the following: GC AI will collect and use the personal data you provide to us as an applicant for recruitment-related reasons. For a full description of how this information will be used, shared, and protected";
    expect(classifyLeverApplicationField({
      id: "new-privacy-control",
      label: privacyPrompt,
      type: "radio",
      options: [{ label: "Continue", value: "continue" }],
      questionDescriptor: {
        promptText: privacyPrompt,
        sourceStrategy: "question_container",
        confidence: "high",
      },
    })).toBe("legal_attestation");

    const privacy = new FakeField({
      id: "new-privacy-control",
      label: privacyPrompt,
      type: "radio",
      required: true,
      options: [{ label: "Continue", value: "continue" }],
      questionDescriptor: {
        promptText: privacyPrompt,
        sourceStrategy: "question_container",
        confidence: "high",
      },
    });
    const privacyBlocker: CareerBlocker = {
      ...resolvedCareerBlocker("old-generated-privacy-control", "Continue"),
      kind: "unknown_form_field",
      question: "GC AI Privacy Policy",
      evidence: [
        "executor:ashby-browser",
        "field-label:GC AI Privacy Policy",
        "options:Continue",
        "question-prompt:GC AI Privacy Policy",
      ],
    };
    const privacyResult = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(new FakeSession([privacy])),
      now: () => capturedAt,
    }).execute(request({ careerJob: careerJob({ blockers: [privacyBlocker] }) }));
    expect(privacyResult.state).toBe("ready_to_submit");
    expect(privacy.current).toBe("continue");

    const travelPrompt = "Are you able to travel to working sessions and offsites in other hub cities for up to one week per quarter (~10%)?";
    const travel = new FakeField({
      id: "new-offsite-control",
      label: travelPrompt,
      type: "radio",
      required: true,
      options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
      questionDescriptor: {
        promptText: travelPrompt,
        nearbyInstructionText: "We regularly host off-sites, Hackathons, and working sessions to build community and collaborate.",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    });
    const travelBlocker: CareerBlocker = {
      ...resolvedCareerBlocker("old-generated-offsite-control", "yes"),
      kind: "unknown_form_field",
      question: "Required question under \"Location, Travel & Work Authorization\": \"We regularly host off-sites, Hackathons, and working sessions to build community and collaborate.\" — choose Yes or No.",
      evidence: [
        "executor:ashby-browser",
        "options:Yes|No",
        "question-prompt:We regularly host off-sites, Hackathons, and working sessions to build community and collaborate.",
      ],
    };
    const travelResult = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(new FakeSession([travel])),
      now: () => capturedAt,
    }).execute(request({ careerJob: careerJob({ blockers: [travelBlocker] }) }));
    expect(travelResult.state).toBe("ready_to_submit");
    expect(travel.current).toBe("yes");
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
    expect(optionalResult.state).toBe("requires_human");
    expect(optionalResult.state === "requires_human" && optionalResult.blocker.kind).toBe("demographic_disclosure");
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

  it("uses only the matching approved demographic answer and handles consent", async () => {
    const fields = [
      new FakeField({ id: "gender", label: "What gender identity do you most closely identify with?", type: "select", required: true, options: [{ label: "Male", value: "male" }, { label: "Female", value: "female" }] }),
      new FakeField({ id: "transgender", label: "Do you identify as transgender?", type: "select", required: true, options: [{ label: "I don't wish to answer", value: "decline" }, { label: "Yes", value: "yes" }] }),
      new FakeField({ id: "orientation", label: "What is your sexual orientation?", type: "select", required: true, options: [{ label: "I don't wish to answer", value: "decline" }] }),
      new FakeField({ id: "disability", label: "Do you have a disability?", type: "select", required: true, options: [{ label: "I don't wish to answer", value: "decline" }] }),
      new FakeField({ id: "veteran", label: "Are you a protected veteran?", type: "select", required: true, options: [{ label: "I don't wish to answer", value: "decline" }] }),
      new FakeField({ id: "ethnicity", label: "What is your race or ethnicity?", type: "select", required: true, options: [{ label: "I don't wish to answer", value: "decline" }] }),
      new FakeField({ id: "gdpr_demographic_data_consent_given_1", label: "I consent to the processing of demographic data", type: "checkbox", required: true }),
    ];
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      approvedReusableAnswers: {
        ...exampleCandidateProfile.approvedReusableAnswers,
        gender_identity: "Male",
        transgender_status: "I don't wish to answer",
        sexual_orientation: "I don't wish to answer",
        disability_status: "I don't wish to answer",
        veteran_status: "I don't wish to answer",
        race_ethnicity: "I don't wish to answer",
        demographic_consent: "yes",
      },
    };
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(new FakeSession(fields)),
      now: () => capturedAt,
    }).execute(request({ profile }));

    expect(result.state).toBe("ready_to_submit");
    expect(fields.map((field) => field.current)).toEqual(["male", "decline", "decline", "decline", "decline", "decline", true]);
  });

  it("maps the approved age to Ashby's age bracket and the custom gender group to Male", async () => {
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      approvedReusableAnswers: {
        ...exampleCandidateProfile.approvedReusableAnswers,
        age: "37",
        gender_identity: "Male",
      },
    };
    const fields = [
      new FakeField({
        id: "age-question",
        label: "17 or younger",
        type: "radio",
        required: true,
        options: [
          { label: "17 or younger", value: "17 or younger" },
          { label: "18-20", value: "18-20" },
          { label: "21-29", value: "21-29" },
          { label: "30-39", value: "30-39" },
          { label: "40-49", value: "40-49" },
          { label: "50-59", value: "50-59" },
          { label: "60 or older", value: "60 or older" },
          { label: "I prefer not to answer", value: "decline" },
        ],
      }),
      new FakeField({
        id: "custom-gender-question",
        label: "Female",
        type: "radio",
        required: true,
        options: [
          { label: "Female", value: "female" },
          { label: "Male", value: "male" },
          { label: "Non-binary", value: "non-binary" },
          { label: "I prefer not to answer", value: "decline" },
        ],
      }),
    ];
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(new FakeSession(fields)),
      now: () => capturedAt,
    }).execute(request({ profile }));

    expect(result.state).toBe("ready_to_submit");
    expect(fields.map((field) => field.current)).toEqual(["30-39", "male"]);
  });

  it("uses semantic labels when Ashby radio values are all on", async () => {
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      approvedReusableAnswers: {
        ...exampleCandidateProfile.approvedReusableAnswers,
        age: "37",
        gender_identity: "Male",
        race_ethnicity: "White",
        veteran_status: "No, I am not a protected veteran",
      },
    };
    const radio = (id: string, label: string, labels: readonly string[]) => new FakeField({
      id, label, type: "radio", required: true,
      options: labels.map((option) => ({ label: option, value: "on" })),
    });
    const fields = [
      radio("age", "17 or younger", ["17 or younger", "18-20", "21-29", "30-39", "40-49", "50-59", "60 or older", "I prefer not to answer"]),
      radio("gender", "Female", ["Female", "Male", "Non-binary", "I prefer not to answer"]),
      radio("race", "Race", ["Hispanic or Latino", "White (Not Hispanic or Latino)"]),
      radio("veteran", "I identify as one or more of the classifications of protected veteran listed above", ["I identify as one or more of the classifications of protected veteran listed above", "I am not a protected veteran"]),
    ];
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(new FakeSession(fields)),
      now: () => capturedAt,
    }).execute(request({ profile }));
    expect(result.state).toBe("ready_to_submit");
    expect(fields.map((field) => field.current)).toEqual([
      "30-39",
      "Male",
      "White (Not Hispanic or Latino)",
      "I am not a protected veteran",
    ]);
  });

  it("fills Ashby optional demographic checkboxes from the approved profile", async () => {
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      approvedReusableAnswers: {
        ...exampleCandidateProfile.approvedReusableAnswers,
        race_ethnicity: "White",
        hispanic_latino: "No",
      },
    };
    const fields = [
      new FakeField({ id: "race-white", label: "White / Caucasian", section: "Race/Ethnicity", type: "checkbox" }),
      new FakeField({ id: "race-black", label: "Black / African American", section: "Race/Ethnicity", type: "checkbox" }),
      new FakeField({ id: "hispanic", label: "Hispanic or Latino", section: "Ethnicity", type: "checkbox" }),
    ];
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(new FakeSession(fields)),
      now: () => capturedAt,
    }).execute(request({ profile }));

    expect(result.state).toBe("ready_to_submit");
    expect(fields.map((field) => field.current)).toEqual([true, false, false]);
    expect(fields.map((field) => field.checkCalls)).toEqual([1, 1, 1]);
    expect(result.state === "ready_to_submit" && result.inspection.fieldsFilled).toEqual([
      "race-white",
      "race-black",
      "hispanic",
    ]);
  });

  it("does not cross-match an unrecognized demographic prompt", async () => {
    const field = new FakeField({ id: "demographic-other", label: "Which demographic category best describes you?", type: "select", required: true, options: [{ label: "Option A", value: "a" }] });
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(new FakeSession([field])),
      now: () => capturedAt,
    }).execute(request());
    expect(result.state).toBe("requires_human");
    expect(result.state === "requires_human" && result.blocker.kind).toBe("demographic_disclosure");
    expect(field.current).toBeNull();
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

  it("surfaces deterministic post-submit rejection evidence as a corrective blocker", async () => {
    const session = new FakeSession([new FakeField({ id: "email", label: "Email", type: "email", required: true })]);
    session.submitResult = {
      clicked: true,
      confirmed: false,
      outcome: "rejected",
      reasonCode: "upload-error",
      evidence: "submit:clicked; submit:rejected; error:upload-error; error-surfaces:1",
    };
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      allowAutomaticSubmission: true,
      now: () => capturedAt,
    }).execute(request({ campaign: { ...campaign(), submissionPolicy: { authority: "automatic", requireExplicitApproval: false } } }));

    expect(result.state).toBe("requires_human");
    expect(result.state === "requires_human" && result.blocker.reason).toContain("upload-error");
    expect(result.state === "requires_human" && result.blocker.evidence).toContain("submit:rejected");
    expect(session.submitClicks).toBe(1);
  });

  it("keeps a post-click response without confirmation ambiguous", async () => {
    const session = new FakeSession([new FakeField({ id: "email", label: "Email", type: "email", required: true })]);
    session.submitResult = {
      clicked: true,
      confirmed: false,
      outcome: "ambiguous",
      reasonCode: "confirmation-missing",
      evidence: "submit:clicked; confirmation:not-detected",
    };
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      allowAutomaticSubmission: true,
      now: () => capturedAt,
    }).execute(request({ campaign: { ...campaign(), submissionPolicy: { authority: "automatic", requireExplicitApproval: false } } }));

    expect(result.state).toBe("requires_human");
    expect(result.state === "requires_human" && result.blocker.reason).toContain("confirmation could not be established");
    expect(session.submitClicks).toBe(1);
  });

  it("surfaces a post-click human boundary without allowing a retry", async () => {
    const session = new FakeSession([new FakeField({ id: "email", label: "Email", type: "email", required: true })]);
    session.submitResult = {
      clicked: true,
      confirmed: false,
      outcome: "ambiguous",
      reasonCode: "confirmation-missing",
      humanBoundary: {
        kind: "captcha",
        question: "Verify you are human",
        reason: "A visible verification challenge appeared after Submit.",
        evidence: ["captcha-state:active_challenge"],
      },
      evidence: "submit:clicked; human-boundary:captcha",
    };
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      allowAutomaticSubmission: true,
      now: () => capturedAt,
    }).execute(request({ campaign: { ...campaign(), submissionPolicy: { authority: "automatic", requireExplicitApproval: false } } }));

    expect(result.state).toBe("requires_human");
    expect(result.state === "requires_human" && result.blocker.kind).toBe("captcha");
    expect(result.state === "requires_human" && result.blocker.resumeAfterHuman).toBe(false);
    expect(result.state === "requires_human" && result.blocker.evidence).toContain("submit:clicked");
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

  it("classifies Rippling's extension-only resume dropzone as a resume upload", () => {
    expect(classifyLeverApplicationField({
      id: "field-1",
      label: "Drop or select (.doc / .docx / .pdf)",
      type: "file",
    })).toBe("resume_upload");
  });

  it("classifies the canonical accented Rippling Résumé field and reaches the upload decision", async () => {
    expect(classifyLeverApplicationField({
      id: "input-resume",
      label: "Résumé",
      type: "file",
      section: "Résumé",
    })).toBe("resume_upload");

    const field = new FakeField({ id: "input-resume", label: "Résumé", type: "file", required: true });
    const session = new FakeSession([field]);
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      resumePaths: { "cloud-platform": "/tmp/synthetic-cloud-platform.pdf" },
      resumeFileExists: () => true,
      now: () => capturedAt,
    }).execute(request());

    expect(result.state).toBe("ready_to_submit");
    expect(field.uploadCalls).toEqual(["/tmp/synthetic-cloud-platform.pdf"]);
  });

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

  it("does not classify a location control from a surrounding work-authorization section", () => {
    expect(classifyLeverApplicationField({
      id: "field-8",
      label: "Where are you based out of?",
      section: "Location, Travel & Work Authorization",
      type: "select",
      questionDescriptor: {
        promptText: "Location",
        sectionTitle: "Location, Travel & Work Authorization",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    })).toBe("location");
  });

  it("fills a location control from the profile when its section also mentions work authorization", async () => {
    const location = new FakeField({
      id: "field-8",
      label: "Where are you based out of?",
      section: "Location, Travel & Work Authorization",
      type: "select",
      required: true,
      questionDescriptor: {
        promptText: "Location",
        sectionTitle: "Location, Travel & Work Authorization",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    });
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(new FakeSession([location])),
      now: () => capturedAt,
    }).execute(request());

    expect(result.state).toBe("ready_to_submit");
    expect(location.current).toBe(exampleCandidateProfile.identity.location ?? exampleCandidateProfile.location);
  });

  it("retains a committed Ashby location when only the grounded country alias differs", async () => {
    const profile = {
      ...exampleCandidateProfile,
      identity: { ...exampleCandidateProfile.identity, location: "McDonald, Pennsylvania, USA" },
    };
    const location = new FakeField({
      id: "field-12",
      label: "Location",
      type: "select",
      required: true,
      options: [{ label: "McDonald, Pennsylvania, United States", value: "McDonald, Pennsylvania, United States" }],
      current: "McDonald, Pennsylvania, USA",
    });
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(new FakeSession([location])),
      now: () => capturedAt,
    }).execute(request({ profile }));

    expect(result.state).toBe("ready_to_submit");
    expect(location.selectCalls).toBe(0);
    if (result.state !== "ready_to_submit") throw new Error("Expected preparation to be ready_to_submit.");
    expect(result.inspection.fieldsFilled).toContain("field-12");
  });

  it("reselects a grounded Ashby location when reinspection has no options", async () => {
    const postingId = "a3b7147c-f9c5-4dd4-9cf2-e8c183b19162";
    const sourceUrl = `https://jobs.ashbyhq.com/MeridianLink/${postingId}`;
    const applicationUrl = `${sourceUrl}/application`;
    const profile = {
      ...exampleCandidateProfile,
      identity: { ...exampleCandidateProfile.identity, location: "McDonald, Pennsylvania, USA" },
    };
    const location = new FakeField({
      id: "field-12",
      label: "Location",
      type: "select",
      required: true,
      current: "McDonald, Pennsylvania, United States",
    });
    const base = request();
    const ashbyJob = careerJob({
      sourceId: "curated-live",
      sourceRecordId: `MeridianLink:${postingId}`,
      destinationResolution: {
        status: "resolved",
        attemptedAt: capturedAt,
        destinationUrl: applicationUrl,
        ats: "Ashby",
        actionable: true,
        provenance: "recognized_ats_evidence",
        evidence: ["curated:explicit-public-posting"],
      },
      job: { ...base.careerJob.job, sourceUrl, applicationUrl },
    });
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(new FakeSession([location])),
      provider: "auto",
      now: () => capturedAt,
    }).execute(request({
      profile,
      careerJob: ashbyJob,
      application: application({ job: ashbyJob.job }),
    }));

    expect(result.state).toBe("ready_to_submit");
    expect(location.selectCalls).toBe(1);
    if (result.state !== "ready_to_submit") throw new Error("Expected preparation to be ready_to_submit.");
    expect(result.inspection.fieldsFilled).toContain("field-12");
  });

  it("fails closed when Ashby loses the resume after a later React rerender", async () => {
    const postingId = "a3b7147c-f9c5-4dd4-9cf2-e8c183b19162";
    const sourceUrl = `https://jobs.ashbyhq.com/MeridianLink/${postingId}`;
    const applicationUrl = `${sourceUrl}/application`;
    const resume = new FakeField({ id: "_systemfield_resume", label: "Resume", type: "file", required: true });
    const session = new FakeSession([resume]);
    session.resumeVerificationResult = false;
    const base = request();
    const ashbyJob = careerJob({
      sourceId: "curated-live",
      sourceRecordId: `MeridianLink:${postingId}`,
      destinationResolution: {
        status: "resolved",
        attemptedAt: capturedAt,
        destinationUrl: applicationUrl,
        ats: "Ashby",
        actionable: true,
        provenance: "recognized_ats_evidence",
        evidence: ["curated:explicit-public-posting"],
      },
      job: { ...base.careerJob.job, sourceUrl, applicationUrl },
    });
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      provider: "auto",
      resumePaths: { "cloud-platform": "/tmp/synthetic-cloud-platform.pdf" },
      resumeFileExists: () => true,
      now: () => capturedAt,
    }).execute(request({
      careerJob: ashbyJob,
      application: application({ job: ashbyJob.job }),
    }));

    expect(result.state).toBe("requires_human");
    if (result.state !== "requires_human") return;
    expect(result.blocker.kind).toBe("resume_missing");
    expect(result.inspection?.evidence).toContain("resume-verification:missing-after-rerender");
    expect(session.submitClicks).toBe(0);
  });

  it("does not reselect an arbitrary Ashby location when options are unavailable", async () => {
    const postingId = "a3b7147c-f9c5-4dd4-9cf2-e8c183b19162";
    const sourceUrl = `https://jobs.ashbyhq.com/MeridianLink/${postingId}`;
    const applicationUrl = `${sourceUrl}/application`;
    const location = new FakeField({
      id: "field-12",
      label: "Location",
      type: "select",
      required: true,
      current: "New York, New York, United States",
    });
    const base = request();
    const ashbyJob = careerJob({
      sourceId: "curated-live",
      sourceRecordId: `MeridianLink:${postingId}`,
      destinationResolution: {
        status: "resolved",
        attemptedAt: capturedAt,
        destinationUrl: applicationUrl,
        ats: "Ashby",
        actionable: true,
        provenance: "recognized_ats_evidence",
        evidence: ["curated:explicit-public-posting"],
      },
      job: { ...base.careerJob.job, sourceUrl, applicationUrl },
    });
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(new FakeSession([location])),
      provider: "auto",
      now: () => capturedAt,
    }).execute(request({
      careerJob: ashbyJob,
      application: application({ job: ashbyJob.job }),
    }));

    expect(result.state).toBe("requires_human");
    expect(location.selectCalls).toBe(0);
  });

  it("classifies Search selects with international dialing options as location", () => {
    expect(looksLikeInternationalDialingOptions(dialingOptions)).toBe(true);
    expect(isPhoneCountrySelector({
      type: "select",
      label: "Search",
      options: dialingOptions,
    })).toBe(true);
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
    expect(isPhoneCountrySelector({ type: "select", label: "Search", options: truncated })).toBe(true);
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
    expect(isPhoneCountrySelector({
      type: "select",
      label: "Search",
      options: [
        { label: "She/her/hers", value: "She/her/hers" },
        { label: "He/him/his", value: "He/him/his" },
        { label: "They/them/theirs", value: "They/them/theirs" },
        { label: "Ze/hir/hir", value: "Ze/hir/hir" },
        { label: "Prefer not to say", value: "Prefer not to say" },
      ],
    })).toBe(false);
  });

  it("classifies a sparse virtualized dialing row but not an ordinary one-option select", () => {
    const sparse = [{ label: "+247 AC - Ascension Island", value: "+247 AC - Ascension Island" }];
    expect(looksLikeInternationalDialingOptions(sparse)).toBe(true);
    expect(isPhoneCountrySelector({ type: "select", label: "Search", options: sparse })).toBe(true);
    expect(classifyLeverApplicationField({
      id: "field-34",
      label: "Search",
      type: "select",
      options: sparse,
    })).toBe("location");
    expect(looksLikeInternationalDialingOptions([
      { label: "Only option", value: "only-option" },
    ])).toBe(false);
  });

  it("typeahead-fills a sparse Rippling dialing row from the grounded US phone", async () => {
    const phoneCountry = new FakeField({
      id: "field-34",
      label: "Search",
      type: "select",
      required: true,
      options: [{ label: "+247 AC - Ascension Island", value: "+247 AC - Ascension Island" }],
    });
    const session = new FakeSession([phoneCountry]);
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      now: () => capturedAt,
    }).execute(request({
      profile: {
        ...exampleCandidateProfile,
        identity: { ...exampleCandidateProfile.identity, phone: "+1 412 480 0379" },
      },
    }));

    expect(result.state).toBe("ready_to_submit");
    expect(session.submitClicks).toBe(0);
    expect(phoneCountry.selectCalls).toBe(1);
    expect(String(phoneCountry.current)).toMatch(/United States|US/i);
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
    if (result.state !== "ready_to_submit") throw new Error("Expected preparation to be ready_to_submit.");
    expect(session.submitClicks).toBe(0);
    expect(location.current).toBe(exampleCandidateProfile.identity.location ?? exampleCandidateProfile.location);
    expect(String(phoneCountry.current)).toContain("United States");
    expect(result.inspection?.fields.find((field) => field.id === "field-34")).toMatchObject({
      label: "Phone country",
      classification: "location",
    });
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

  it("accepts a grounded USA phone-country value against a Rippling option label", async () => {
    const phoneCountry = new FakeField({
      id: "field-34",
      label: "Search",
      type: "select",
      required: true,
      current: "USA",
      options: dialingOptions.slice(0, 7).concat(dialingOptions.slice(8, 9)),
    });
    const session = new FakeSession([phoneCountry]);
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      now: () => capturedAt,
    }).execute(request());

    expect(result.state).toBe("ready_to_submit");
    expect(session.submitClicks).toBe(0);
    expect(phoneCountry.selectCalls).toBe(0);
    expect(phoneCountry.current).toBe("USA");
  });

  it("treats Rippling phone-country Search placeholder as unanswered and selects US", async () => {
    const phoneCountry = new FakeField({
      id: "field-34",
      label: "Phone country",
      type: "select",
      required: true,
      current: "Search",
      options: dialingOptions,
    });
    const session = new FakeSession([phoneCountry]);
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      now: () => capturedAt,
    }).execute(request({
      profile: {
        ...exampleCandidateProfile,
        identity: { ...exampleCandidateProfile.identity, phone: "+1 412 480 0379", location: "Pittsburgh, PA" },
        location: "Pittsburgh, PA",
      },
    }));

    expect(result.state).toBe("ready_to_submit");
    expect(session.submitClicks).toBe(0);
    expect(phoneCountry.selectCalls).toBe(1);
    expect(String(phoneCountry.current)).toMatch(/United States|US/i);
    if (result.state !== "ready_to_submit") throw new Error("Expected preparation to be ready_to_submit.");
    expect(result.inspection.blockers).toHaveLength(0);
    expect(result.inspection.fieldsFilled).toContain("field-34");
    expect(result.inspection.evidence).toContain("filled:field-34");
  });

  it("supports a verified Workday application destination through the existing browser policy", async () => {
    const workdayPostingUrl = "https://homedepot.wd5.myworkdayjobs.com/en-US/CareerDepot/job/TEXAS---VIRTUAL---TX01/Software-Engineer-II--REMOTE-_Req191434";
    const workdayUrl = `${workdayPostingUrl}/apply`;
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
        sourceUrl: workdayPostingUrl,
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

    const differentJobUrl = "https://homedepot.wd5.myworkdayjobs.com/en-US/CareerDepot/job/TEXAS---VIRTUAL---TX01/Other-Role_Req999999/apply";
    const mismatched = request({
      careerJob: careerJob({
        ...workdayJob,
        job: { ...workdayJob.job, applicationUrl: differentJobUrl },
      }),
    });
    expect(executor.supports(mismatched)).toBe(false);
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
