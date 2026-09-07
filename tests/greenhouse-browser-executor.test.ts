import { describe, expect, it } from "vitest";
import {
  greenhouseOptionMatches,
} from "../application-agent/automation/playwrightLeverBrowserSession";

import {
  LeverBrowserExecutor,
  exampleCandidateProfile,
  normalizeJobPosting,
  type Application,
  type ApplicationAnswer,
  type ApplicationExecutionRequest,
  type ApplicationFieldOption,
  type ApplicationFieldType,
  type CareerJob,
  type Campaign,
  type CandidateProfile,
  type LeverBrowserField,
  type LeverBrowserSession,
  type LeverBrowserSessionFactory,
} from "../application-agent/src";

const capturedAt = "2026-09-04T12:00:00.000Z";
const sourceUrl = "https://himalayas.app/jobs/kapitus/software-engineer-ii-engineering";
const applicationUrl = "https://job-boards.greenhouse.io/kapitus/jobs/4390052009";

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
  uploadCalls = 0;
  selectCalls = 0;

  constructor(options: {
    id: string;
    label: string;
    type: ApplicationFieldType;
    required?: boolean;
    options?: readonly ApplicationFieldOption[];
    questionDescriptor?: LeverBrowserField["questionDescriptor"];
    current?: string | boolean | null;
  }) {
    this.id = options.id;
    this.label = options.label;
    this.type = options.type;
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
    this.current = value;
  }

  async uploadFile(_path: string): Promise<void> {
    this.uploadCalls += 1;
    this.current = "uploaded";
  }

  async readValue(): Promise<string | boolean | null> {
    return this.current;
  }
}

class FakeSession implements LeverBrowserSession {
  private url = "";
  readonly fields: readonly FakeField[];
  readonly boundary: Awaited<ReturnType<LeverBrowserSession["detectHumanBoundary"]>>;
  submitChecks = 0;

  constructor(
    fields: readonly FakeField[],
    boundary: Awaited<ReturnType<LeverBrowserSession["detectHumanBoundary"]>> = null,
  ) {
    this.fields = fields;
    this.boundary = boundary;
  }

  async navigate(url: string): Promise<void> {
    this.url = url;
  }

  currentUrl(): string {
    return this.url;
  }

  async inspectFields(): Promise<readonly LeverBrowserField[]> {
    return this.fields;
  }

  async detectHumanBoundary() {
    return this.boundary;
  }

  async hasSubmitControl(): Promise<boolean> {
    this.submitChecks += 1;
    return true;
  }

  async submit() {
    return {
      clicked: true,
      confirmed: true,
      externalApplicationId: "confirmation:test",
      evidence: "submit:clicked; confirmation:text",
    };
  }

  async close(): Promise<void> {
    // The browser host owns lifecycle; this fixture has no external handle.
  }
}

class FakeSessionFactory implements LeverBrowserSessionFactory {
  constructor(readonly session: FakeSession) {}

  async open(): Promise<LeverBrowserSession> {
    return this.session;
  }
}

function request(session: FakeSession): ApplicationExecutionRequest {
  const job = normalizeJobPosting({
    companyHint: "Kapitus",
    titleHint: "Software Engineer II - Engineering",
    sourceUrl,
    applicationUrl,
    rawText: "Kapitus\nSoftware Engineer II - Engineering\nRemote - US\nBuild software.",
  }, capturedAt);
  const application: Application = {
    id: "application-kapitus-greenhouse",
    isExample: false,
    job,
    fit: null,
    resume: { familyId: "cloud-platform" } as Application["resume"],
    answers: [],
    blockers: [],
    status: "ready_for_review",
    createdAt: capturedAt,
    updatedAt: capturedAt,
  };
  const careerJob: CareerJob = {
    id: "career-job-kapitus-greenhouse",
    campaignId: "campaign-greenhouse",
    isExample: false,
    sourceMode: "live",
    actionability: "actionable",
    fingerprint: "himalayas:kapitus-greenhouse",
    sourceId: "himalayas-live",
    sourceRecordId: "kapitus-himalayas-guid",
    destinationResolution: {
      status: "resolved",
      attemptedAt: capturedAt,
      destinationUrl: applicationUrl,
      ats: "Greenhouse",
      actionable: true,
      provenance: "recognized_ats_evidence",
      evidence: ["official destination evidence"],
    },
    job,
    discoveredAt: capturedAt,
    fit: null,
    applicationId: application.id,
    status: "preparing",
    blockers: [],
    createdAt: capturedAt,
    updatedAt: capturedAt,
  };
  return {
    campaign: {
      id: careerJob.campaignId,
      applicationPolicy: { allowGroundedDrafts: true },
      submissionPolicy: { authority: "never", requireExplicitApproval: false },
    } as Campaign,
    careerJob,
    application,
    profile: exampleCandidateProfile,
    now: capturedAt,
  };
}

describe("Greenhouse destination execution through the existing browser policy", () => {
  it("maps a grounded US location to the Greenhouse country option without guessing a candidate fact", async () => {
    expect(greenhouseOptionMatches("United States+1", null, "United States")).toBe(true);
    expect(greenhouseOptionMatches("United States+1", null, "Canada")).toBe(false);

    const country = new FakeField({ id: "country", label: "Country", type: "select", required: true });
    const session = new FakeSession([country]);
    const base = request(session);
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      identity: { ...exampleCandidateProfile.identity, location: "Example City, USA" },
    };
    const executor = new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" });
    const result = await executor.execute({
      ...base,
      profile,
      application: {
        ...base.application,
        answers: [{
          id: "answer:location",
          field: "location",
          question: "location",
          policy: "auto",
          value: "Example City, USA",
          status: "resolved",
          provenance: ["test:location"],
        }],
      },
    });

    expect(result.state).toBe("ready_to_submit");
    expect(country.current).toBe("United States");
  });

  it("maps a grounded US location to the Greenhouse state option without using the full location", async () => {
    const state = new FakeField({
      id: "question_state",
      label: "What state do you currently reside in?",
      type: "select",
      required: true,
      options: [{ label: "Pennsylvania", value: "Pennsylvania" }],
    });
    const session = new FakeSession([state]);
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      identity: { ...exampleCandidateProfile.identity, location: "Example City, Pennsylvania, USA" },
    };
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      provider: "greenhouse",
    }).execute({ ...request(session), profile, application: { ...request(session).application, answers: [] } });

    expect(result.state).toBe("ready_to_submit");
    expect(state.current).toBe("Pennsylvania");
  });

  it("maps a custom Greenhouse state combobox to its two-letter option value", async () => {
    const state = new FakeField({
      id: "question_state",
      label: "What state do you currently reside in?",
      type: "select",
      required: true,
    });
    const session = new FakeSession([state]);
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      identity: { ...exampleCandidateProfile.identity, location: "Example City, Pennsylvania, USA" },
    };
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      provider: "greenhouse",
    }).execute({ ...request(session), profile, application: { ...request(session).application, answers: [] } });

    expect(result.state).toBe("ready_to_submit");
    expect(state.current).toBe("pa");
  });

  it("does not derive a preferred name from the legal full name, but accepts an explicit profile preferred name", async () => {
    const preferredName = new FakeField({ id: "preferred_name", label: "Preferred First Name", type: "text" });
    const session = new FakeSession([preferredName]);
    const executor = new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" });
    const base = request(session);
    const genericNameAnswer: ApplicationAnswer = {
      id: "answer:name",
      field: "name",
      question: "name",
      policy: "auto",
      value: "Example Candidate",
      status: "resolved",
      provenance: ["test:name"],
    };

    await executor.execute({
      ...base,
      application: { ...base.application, answers: [genericNameAnswer] },
    });
    expect(preferredName.current).toBeNull();

    const explicit = new FakeField({ id: "preferred_name", label: "Preferred First Name", type: "text" });
    const explicitSession = new FakeSession([explicit]);
    const explicitExecutor = new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(explicitSession),
      provider: "greenhouse",
    });
    const explicitProfile: CandidateProfile = {
      ...exampleCandidateProfile,
      identity: { ...exampleCandidateProfile.identity, preferredName: "Alex" },
    };
    await explicitExecutor.execute({ ...base, profile: explicitProfile, application: { ...base.application, answers: [] } });
    expect(explicit.current).toBe("Alex");
  });

  it("uploads only the uniquely classified resume control, never a cover-letter file or shifted combobox", async () => {
    const resume = new FakeField({ id: "resume", label: "Attach", type: "file", required: true });
    const coverLetter = new FakeField({ id: "cover_letter", label: "Attach", type: "file" });
    const school = new FakeField({
      id: "school--0",
      label: "School",
      type: "select",
      options: [{ label: "Example University", value: "example-university" }],
    });
    const session = new FakeSession([resume, coverLetter, school]);
    const executor = new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      provider: "greenhouse",
      resumePaths: { "cloud-platform": "/private/test-resume.pdf" },
      resumeFileExists: () => true,
    });

    const result = await executor.execute(request(session));

    expect(result.state).toBe("ready_to_submit");
    expect(resume.uploadCalls).toBe(1);
    expect(coverLetter.uploadCalls).toBe(0);
    expect(school.selectCalls).toBe(1);
    expect(school.current).toBe("example-university");
  });

  it("does not use an unrelated prepared answer for a consequential work-authorization field", async () => {
    const authorization = new FakeField({
      id: "work_authorization",
      label: "Are you legally authorized to work in the United States?",
      type: "select",
      required: true,
      options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
    });
    const session = new FakeSession([authorization]);
    const base = request(session);
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      provider: "greenhouse",
    }).execute({
      ...base,
      application: {
        ...base.application,
        answers: [{
          id: "answer:employment_history",
          field: "employment_history",
          question: "Employment history",
          policy: "auto",
          value: "Prepared employment summary",
          status: "resolved",
          provenance: ["test:employment_history"],
        }],
      },
    });

    expect(result.state).toBe("requires_human");
    expect(authorization.selectCalls).toBe(0);
  });

  it("leaves a non-boolean travel value for the actual custom Greenhouse question", async () => {
    const travel = new FakeField({
      id: "question_travel",
      label: "Are you open to travel?",
      type: "select",
      required: true,
      questionDescriptor: {
        promptText: "Are you open to travel?",
        sourceStrategy: "aria_labelledby",
        confidence: "high",
      },
    });
    const session = new FakeSession([travel]);
    const base = request(session);
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      provider: "greenhouse",
    }).execute({
      ...base,
      application: {
        ...base.application,
        answers: [{
          id: "answer:travel",
          field: "travel",
          question: "Travel requirements",
          policy: "ask",
          value: "none",
          status: "resolved",
          provenance: ["test:travel"],
        }],
      },
    });

    expect(result.state).toBe("requires_human");
    expect(travel.selectCalls).toBe(0);
    expect(result.state === "requires_human" && result.blocker.questionProvenance).toBe("ATS_FORM");
  });

  it("accepts a verified destination-enriched Greenhouse job while retaining Himalayas provenance", () => {
    const session = new FakeSession([]);
    const executor = new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "auto" });
    const executionRequest = request(session);
    expect(executor.id).toBe("application-browser-executor");
    expect(executor.supports(executionRequest)).toBe(true);
    expect(executionRequest.careerJob.sourceId).toBe("himalayas-live");
    expect(executionRequest.careerJob.job.sourceUrl).toBe(sourceUrl);
    expect(executionRequest.careerJob.job.applicationUrl).toBe(applicationUrl);
  });

  it("preserves Greenhouse fields, options, requiredness, safe filling, and resume upload without submitting", async () => {
    const firstName = new FakeField({ id: "first_name", label: "First Name", type: "text", required: true });
    const resume = new FakeField({ id: "resume", label: "Resume/CV", type: "file", required: true });
    const workAuthorization = new FakeField({
      id: "question_work_authorization",
      label: "Yes",
      type: "select",
      required: true,
      options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
      questionDescriptor: {
        promptText: "Are you legally authorized to work for any employer in the U.S.?",
        sectionTitle: "Application questions",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    });
    const session = new FakeSession([firstName, resume, workAuthorization]);
    const executor = new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      provider: "greenhouse",
      resumePaths: { "cloud-platform": "/private/test-resume.pdf" },
      resumeFileExists: () => true,
      now: () => capturedAt,
    });

    const result = await executor.execute(request(session));

    expect(result.state).toBe("requires_human");
    if (result.state !== "requires_human") return;
    expect(result.blocker.questionProvenance).toBe("ATS_FORM");
    expect(result.blocker.question).toBe("Are you legally authorized to work for any employer in the U.S.?");
    expect(result.blocker.evidence).toContain("executor:greenhouse-browser");
    expect(result.inspection?.fields.find((field) => field.id === workAuthorization.id)).toMatchObject({
      type: "select",
      required: true,
      options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
    });
    expect(firstName.fillCalls).toBe(1);
    expect(resume.uploadCalls).toBe(1);
    expect(session.submitChecks).toBe(0);
    expect(result.inspection?.evidence).toContain("submit:not-clicked");
  });

  it("stops at an active human-verification boundary before any field action", async () => {
    const firstName = new FakeField({ id: "first_name", label: "First Name", type: "text", required: true });
    const session = new FakeSession([firstName], {
      kind: "captcha",
      question: "Complete the CAPTCHA in the browser",
      reason: "A visible CAPTCHA requires human action.",
      evidence: ["captcha-state:active_challenge"],
    });
    const executor = new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      provider: "auto",
      now: () => capturedAt,
    });

    const result = await executor.execute(request(session));

    expect(result.state).toBe("requires_human");
    if (result.state !== "requires_human") return;
    expect(result.blocker.kind).toBe("captcha");
    expect(result.blocker.questionProvenance).toBe("POLICY");
    expect(firstName.fillCalls).toBe(0);
    expect(session.submitChecks).toBe(0);
  });

  it("rejects a Greenhouse-looking URL without independent destination verification", () => {
    const session = new FakeSession([]);
    const executor = new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "auto" });
    const unverified = request(session);
    unverified.careerJob.destinationResolution = undefined;
    expect(executor.supports(unverified)).toBe(false);
  });
});
