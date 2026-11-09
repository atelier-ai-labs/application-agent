import { describe, expect, it } from "vitest";
import { greenhouseEmbedApplicationUrl, isVerifiedGreenhouseEmbedUrl } from "../application-agent/src/domain/greenhouseJobSource";
import { classifyLeverApplicationField, isGreenhouseClosedPostingRedirect, isTrustedAutomaticConfirmation, isTruthfulnessCertification } from "../application-agent/src/domain/leverBrowserExecutor";
import { OPTIONAL_ANSWER_SKIPPED } from "../application-agent/src/domain/executor";
import {
  greenhouseLocationOptionMatches,
  greenhouseOptionMatches,
  typedPlaceMatchesOption,
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
  readonly fullPrompt?: string;
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
    fullPrompt?: string;
    current?: string | boolean | null;
  }) {
    this.id = options.id;
    this.label = options.label;
    this.type = options.type;
    this.required = options.required ?? false;
    this.options = options.options;
    this.questionDescriptor = options.questionDescriptor;
    this.fullPrompt = options.fullPrompt;
    this.current = options.current ?? null;
  }

  async fill(value: string): Promise<void> {
    this.fillCalls += 1;
    this.current = value;
  }

  selectContexts: unknown[] = [];

  async select(value: string, context?: unknown): Promise<void> {
    this.selectCalls += 1;
    this.selectContexts.push(context);
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
  it("matches a typed place to the full typeahead option (Ramp's payroll location)", () => {
    expect(typedPlaceMatchesOption("Pittsburgh, Pennsylvania, United States", "Pittsburgh, PA")).toBe(true);
    expect(typedPlaceMatchesOption("Palo Alto, California, United States", "Pittsburgh, PA")).toBe(false);
    expect(typedPlaceMatchesOption("Pittsburgh, Kansas, United States", "Pittsburgh, PA")).toBe(false);
    expect(typedPlaceMatchesOption("Austin, Texas, United States", "Austin, TX, USA")).toBe(true);
    // Not a place: plain answers keep exact matching only.
    expect(typedPlaceMatchesOption("Yes, I consent", "Yes")).toBe(false);
  });

  it("maps a grounded US location to the Greenhouse country option without guessing a candidate fact", async () => {
    expect(greenhouseOptionMatches("United States+1", null, "United States")).toBe(true);
    expect(greenhouseOptionMatches("Male", "male", "Male")).toBe(true);
    expect(greenhouseOptionMatches("I don't wish to answer", "prefer_not_to_say", "I don't wish to answer")).toBe(true);
    expect(greenhouseOptionMatches("McDonald, Pennsylvania, United States", null, "McDonald")).toBe(false);
    expect(greenhouseOptionMatches("North McDonald, Pennsylvania, United States", null, "McDonald")).toBe(false);
    expect(greenhouseLocationOptionMatches("McDonald, PA, United States", "McDonald", "McDonald, Pennsylvania, United States")).toBe(true);
    expect(greenhouseLocationOptionMatches("McDonald, TN, United States", "McDonald", "McDonald, Pennsylvania, United States")).toBe(false);
    expect(greenhouseLocationOptionMatches("McDonald, Pennsylvania, United States", "McDonald", "McDonald, Pennsylvania, United States")).toBe(true);
    expect(greenhouseLocationOptionMatches("McDonald, Pennsylvania, United States", "McDonald, Pennsylvania, USA", "McDonald, Pennsylvania, USA")).toBe(true);
    expect(greenhouseLocationOptionMatches("McDonald, Tennessee, United States", "McDonald, Pennsylvania, USA", "McDonald, Pennsylvania, USA")).toBe(false);
    // Country-only questions (Upstart's "What is your current location?").
    expect(greenhouseLocationOptionMatches("United States", "United States", "McDonald, Pennsylvania, USA")).toBe(true);
    expect(greenhouseLocationOptionMatches("Canada", "Canada", "McDonald, Pennsylvania, USA")).toBe(false);
    expect(greenhouseLocationOptionMatches("United States +1", "United States +1", "McDonald, Pennsylvania, USA")).toBe(true);
    expect(greenhouseLocationOptionMatches("Canada +1", "Canada +1", "McDonald, Pennsylvania, USA")).toBe(false);
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

  it("fills the start date as two weeks after the day it applies, in the format the box asks for", async () => {
    const field = (id: string, label: string) => new FakeField({ id, label, type: "text", required: true,
      questionDescriptor: { promptText: label, sourceStrategy: "question_container", confidence: "high" } });
    const run = async (workPreferences: CandidateProfile["workPreferences"], label: string, now: string) => {
      const start = field("question_start", label);
      const session = new FakeSession([start]);
      const base = request(session);
      await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse", now: () => now })
        .execute({ ...base, profile: { ...exampleCandidateProfile, workPreferences } });
      return start.current;
    };
    const notice = { ...exampleCandidateProfile.workPreferences, availabilityStartDate: "2026-10-01", availabilityNoticeDays: 14 };
    expect(await run(notice, "Earliest available start date", "2026-11-05T17:00:00.000Z")).toBe("2026-11-19");
    expect(await run(notice, "When can you start? (MM/DD/YYYY)", "2026-11-05T17:00:00.000Z")).toBe("11/19/2026");
    // Across a month end, and a later application gets a later date.
    expect(await run(notice, "Earliest available start date", "2026-12-20T17:00:00.000Z")).toBe("2027-01-03");
    // Without the setting, the fixed profile date is used as before.
    expect(await run({ ...notice, availabilityNoticeDays: undefined }, "Earliest available start date", "2026-11-05T17:00:00.000Z")).toBe("2026-10-01");
  });

  it("types the posted-range midpoint into a salary box as a plain number", async () => {
    const salary = new FakeField({ id: "question_salary", label: "What are you compensation expectations for this position?", type: "text", required: true,
      questionDescriptor: { promptText: "What are you compensation expectations for this position?", sourceStrategy: "question_container", confidence: "high" } });
    const session = new FakeSession([salary]);
    const base = request(session);
    const result = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" }).execute({
      ...base,
      application: { ...base.application, answers: [{ id: "answer:salary_expectations", field: "salary_expectations", question: "Expected compensation", policy: "ask", value: "140000", status: "resolved", provenance: ["profile:workPreferences.salaryStrategy=posting_midpoint"] }] },
    });
    expect(result.state).toBe("ready_to_submit");
    expect(salary.current).toBe("140000");
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

  it("fills explicit work authorization and sponsorship facts for binary controls", async () => {
    const profile = {
      ...exampleCandidateProfile,
      workAuthorization: {
        status: "authorized",
        countries: ["United States"],
        sponsorshipRequired: false,
      },
    } satisfies CandidateProfile;
    const authorization = new FakeField({
      id: "authorized",
      label: "Yes",
      type: "select",
      required: true,
      options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
      questionDescriptor: {
        promptText: "Are you legally authorized to work in the United States?",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    });
    const sponsorship = new FakeField({
      id: "sponsorship",
      label: "No",
      type: "select",
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
      provider: "greenhouse",
      now: () => capturedAt,
    }).execute({ ...request(session), profile });

    expect(result.state).toBe("ready_to_submit");
    expect(authorization.current).toBe("yes");
    expect(sponsorship.current).toBe("no");
    expect(session.submitChecks).toBe(1);
  });

  it("answers Temporal's 'in this location' question with the choice that folds in sponsorship, and fills legal names", async () => {
    // Temporal (2026-11-08): both were asked in Slack.
    const profile = {
      ...exampleCandidateProfile,
      identity: { ...exampleCandidateProfile.identity, fullName: "Nathaniel Magera" },
      workAuthorization: { status: "authorized", countries: ["United States"], sponsorshipRequired: false },
    } satisfies CandidateProfile;
    const choices = [
      { label: "Yes, and I will not require sponsorship now or in the future", value: "a" },
      { label: "Yes, but I will require sponsorship now or in the future to maintain work authorization", value: "b" },
      { label: "No, I am not currently authorized to work in this location", value: "c" },
    ];
    const authorization = new FakeField({
      id: "authorized-here", label: "Are you legally authorized to work in this location?", type: "select", required: true, options: choices,
      questionDescriptor: { promptText: "Are you legally authorized to work in this location?", sourceStrategy: "question_container", confidence: "high" },
    });
    const legal = (id: string, label: string) => new FakeField({ id, label, type: "text", required: true,
      questionDescriptor: { promptText: label, sectionTitle: "Application Information", sourceStrategy: "question_container", confidence: "high" } });
    const first = legal("a1529799-27e4", "Legal First Name");
    const last = legal("9b5a508c-09ca", "Legal Last Name");
    const session = new FakeSession([first, last, authorization]);
    const result = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse", now: () => capturedAt })
      .execute({ ...request(session), profile });

    expect(result.state).toBe("ready_to_submit");
    expect(authorization.current).toBe("a");
    expect(first.current).toBe("Nathaniel");
    expect(last.current).toBe("Magera");

    // Someone who needs sponsorship gets the other Yes.
    const needs = new FakeField({
      id: "authorized-here-2", label: "Are you legally authorized to work in this location?", type: "select", required: true, options: choices,
      questionDescriptor: { promptText: "Are you legally authorized to work in this location?", sourceStrategy: "question_container", confidence: "high" },
    });
    const second = new FakeSession([needs]);
    await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(second), provider: "greenhouse", now: () => capturedAt })
      .execute({ ...request(second), profile: { ...profile, workAuthorization: { ...profile.workAuthorization, sponsorshipRequired: true } } });
    expect(needs.current).toBe("b");
  });

  it("does not reuse United States authorization for a different country", async () => {
    const profile = {
      ...exampleCandidateProfile,
      workAuthorization: {
        status: "authorized",
        countries: ["United States"],
        sponsorshipRequired: false,
      },
    } satisfies CandidateProfile;
    const authorization = new FakeField({
      id: "authorized-canada",
      label: "Yes",
      type: "select",
      required: true,
      options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
      questionDescriptor: {
        promptText: "Are you legally authorized to work in Canada?",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    });
    const session = new FakeSession([authorization]);
    const result = await new LeverBrowserExecutor({
      sessionFactory: new FakeSessionFactory(session),
      provider: "greenhouse",
      now: () => capturedAt,
    }).execute({ ...request(session), profile });

    expect(result.state).toBe("requires_human");
    expect(authorization.selectCalls).toBe(0);
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

  it("selects the grounded country in Greenhouse's phone-country dropdown", async () => {
    const options = ["United States +1", "Afghanistan +93", "Canada +1", "Albania +355", "Algeria +213", "Andorra +376"].map((label) => ({ label, value: label }));
    const country = new FakeField({ id: "country", label: "Country*", type: "select", required: true, options,
      questionDescriptor: { promptText: "Phone", sectionTitle: "Phone", sourceStrategy: "fieldset_legend", confidence: "high" } });
    const session = new FakeSession([country]);
    const base = request(session);
    const profile: CandidateProfile = { ...exampleCandidateProfile, identity: { ...exampleCandidateProfile.identity, location: "McDonald, Pennsylvania, USA" } };
    const result = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" }).execute({ ...base, profile });

    expect(result.state).toBe("ready_to_submit");
    expect(country.current).toBe("United States +1");
  });

  it("uses the newest answer when a question was asked again", async () => {
    const full = "I learned about Upstart through this job posting or from a recruiter";
    const prompt = "Before applying, how familiar were you with Upstart?*";
    const familiar = new FakeField({ id: "question_67832269", label: prompt, type: "select", required: true,
      options: ["I was already familiar with Upstart", full].map((label) => ({ label, value: label })),
      questionDescriptor: { promptText: prompt, sourceStrategy: "question_container", confidence: "high" } });
    const session = new FakeSession([familiar]);
    const base = request(session);
    const answered = (id: string, value: string, resolvedAt: string): CareerJob["blockers"][number] => ({
      id, kind: "unknown_form_field", unit: "submission", field: "question_67832269", question: "Before applying, how familiar were you with Upstart?*",
      context: { jobId: base.careerJob.id, company: "Upstart", role: "DevOps Engineer II" }, reason: "test", evidence: [`question-prompt:${prompt}`], status: "resolved", createdAt: capturedAt, resolvedAt, value,
    });
    const result = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" }).execute({
      ...base,
      careerJob: { ...base.careerJob, blockers: [answered("older", full.slice(0, 64), "2026-11-02T01:16:49.205Z"), answered("newer", full, "2026-11-02T01:29:43.583Z")] },
    });

    expect(result.state).toBe("ready_to_submit");
    expect(familiar.current).toBe(full);
  });

  it("fills the race question Greenhouse reveals after Hispanic/Latino is answered", async () => {
    const hispanic = new FakeField({ id: "hispanic_ethnicity", label: "Are you Hispanic/Latino?*", type: "select", required: true,
      options: ["Yes", "No", "Decline To Self Identify"].map((label) => ({ label, value: label })) });
    const race = new FakeField({ id: "race", label: "Please identify your race*", type: "select", required: true,
      options: ["Asian", "Black or African American", "White", "Decline To Self Identify"].map((label) => ({ label, value: label })) });
    const session = new FakeSession([hispanic]);
    session.inspectFields = async () => hispanic.current === "No" ? [hispanic, race] : [hispanic];
    const base = request(session);
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      approvedReusableAnswers: { ...exampleCandidateProfile.approvedReusableAnswers, hispanic_latino: "No", race_ethnicity: "White" },
    };
    const result = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" }).execute({ ...base, profile });

    expect(result.state).toBe("ready_to_submit");
    expect(hispanic.current).toBe("No");
    expect(race.current).toBe("White");
  });

  it("trusts Greenhouse's embed confirmation only for the same board and posting", () => {
    const target = { provider: "greenhouse" as const, site: "upstart", postingId: "8030908", applicationUrl: "https://job-boards.greenhouse.io/upstart/jobs/8030908" };
    const confirmation = (url: string) => ({
      clicked: true, confirmed: true, externalApplicationId: `confirmation:${url}`, confirmationOrigin: "https://job-boards.greenhouse.io",
      confirmationUrl: url, evidence: "submit:clicked; confirmation:url; security-code:entered",
    });
    expect(isTrustedAutomaticConfirmation(confirmation("https://job-boards.greenhouse.io/embed/job_app/confirmation?for=upstart&token=8030908"), target)).toBe(true);
    expect(isTrustedAutomaticConfirmation(confirmation("https://job-boards.greenhouse.io/embed/job_app/confirmation?for=upstart&token=1111111"), target)).toBe(false);
    expect(isTrustedAutomaticConfirmation(confirmation("https://job-boards.greenhouse.io/embed/job_app/confirmation?for=other&token=8030908"), target)).toBe(false);
  });

  it("answers how-did-you-hear from the ranked list and previous employment with No", async () => {
    const yesNo = ["Yes", "No"].map((label) => ({ label, value: label }));
    const source = new FakeField({ id: "question_67832270", label: "Before applying, how did you hear about Kapitus?*", type: "select", required: true,
      options: ["LinkedIn job post", "Indeed", "Another job site", "Other"].map((label) => ({ label, value: label })) });
    const employed = new FakeField({ id: "question_67832271", label: "Have you been employed by Kapitus before?*", type: "select", required: true, options: yesNo });
    const session = new FakeSession([source, employed]);
    const base = request(session);
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      approvedReusableAnswers: { ...exampleCandidateProfile.approvedReusableAnswers, job_source: "Another job site|Job board|Internet" },
    };
    const result = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" }).execute({ ...base, profile });

    expect(result.state).toBe("ready_to_submit");
    expect(source.current).toBe("Another job site");
    expect(employed.current).toBe("No");
  });

  it("asks instead of answering No when the company is in the work history", async () => {
    const employed = new FakeField({ id: "question_1", label: "Have you been employed by Kapitus before?*", type: "select", required: true,
      options: ["Yes", "No"].map((label) => ({ label, value: label })) });
    const session = new FakeSession([employed]);
    const base = request(session);
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      employmentHistory: [...exampleCandidateProfile.employmentHistory, { ...exampleCandidateProfile.employmentHistory[0]!, id: "kapitus", employer: "Kapitus" }],
    };
    const result = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" }).execute({ ...base, profile });

    expect(result.state).toBe("requires_human");
    expect(employed.current).toBeNull();
  });

  it("accepts a multi-select's picked chip only when it is the agent's own answer", async () => {
    const run = async (current: string) => {
      // The picked option is no longer listed in the menu once it is a chip.
      const all = ["Man", "Non-binary", "Woman", "I don't wish to answer"];
      const gender = new FakeField({ id: "4016404008", label: "How would you describe your gender identity?", type: "select", required: true, current,
        options: all.filter((label) => label !== current).map((label) => ({ label, value: label })) });
      const session = new FakeSession([gender]);
      const base = request(session);
      const profile: CandidateProfile = {
        ...exampleCandidateProfile,
        approvedReusableAnswers: { ...exampleCandidateProfile.approvedReusableAnswers, gender_identity: "Male" },
      };
      return new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" }).execute({ ...base, profile });
    };
    expect((await run("Man")).state).toBe("ready_to_submit");
    expect((await run("Woman")).state).toBe("requires_human");
  });

  it("answers whether the candidate is based in the U.S. from the profile location", async () => {
    const run = async (location: string) => {
      const field = new FakeField({ id: "based", label: "This role is open to remote candidates based in the United States. Are you currently based in the U.S?", type: "select", required: true,
        options: ["Yes", "No"].map((label) => ({ label, value: label })) });
      const session = new FakeSession([field]);
      const base = request(session);
      const profile: CandidateProfile = { ...exampleCandidateProfile, identity: { ...exampleCandidateProfile.identity, location } };
      const result = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" }).execute({ ...base, profile });
      return { state: result.state, value: field.current };
    };
    expect(await run("McDonald, Pennsylvania, USA")).toEqual({ state: "ready_to_submit", value: "Yes" });
    expect((await run("Toronto, Ontario, Canada")).state).toBe("requires_human");
  });

  it("picks the work-from state and confirms a listed hiring state from the profile location", async () => {
    const stateOptions = ["Ontario, Canada", "Philippines", "Arizona (AZ)", "Pennsylvania (PA)", "Virginia (VA)", "West Virginia (WV)", "Washington D.C. (DC)", "Location not listed"];
    const run = async (location: string, hiringStates: string) => {
      const workFrom = new FakeField({ id: "work-from", label: "Thumbtack currently supports remote work in a number of locations across the United States, Ontario and the Philippines. Using the drop down list below, please select the location you intend to work from. If you are not currently located in or able to work from a location listed below, please select \"Location not listed.\"", type: "select", required: true,
        options: stateOptions.map((label) => ({ label, value: label })) });
      const listed = new FakeField({ id: "listed", label: `We are currently hiring remote candidates in the following states: ${hiringStates}. Please confirm whether or not you live in one of these states`, type: "radio", required: true,
        options: ["Yes", "No"].map((label) => ({ label, value: label })) });
      const session = new FakeSession([workFrom, listed]);
      const base = request(session);
      const profile: CandidateProfile = { ...exampleCandidateProfile, identity: { ...exampleCandidateProfile.identity, location } };
      const result = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" }).execute({ ...base, profile });
      // The state option is an exact listed choice, never matched as the full home address.
      expect(workFrom.selectContexts.every((context) => context === undefined)).toBe(true);
      return { state: result.state, values: [workFrom.current, listed.current] };
    };
    expect(await run("Pittsburgh, Pennsylvania, USA", "California, Colorado, District of Columbia (DC), Ohio, Pennsylvania, Texas and Wisconsin"))
      .toEqual({ state: "ready_to_submit", values: ["Pennsylvania (PA)", "Yes"] });
    expect((await run("Morgantown, WV", "California, Virginia and Ohio")).values).toEqual(["West Virginia (WV)", null]);
    expect((await run("Pittsburgh, Pennsylvania, USA", "California, Colorado and Ohio")).state).toBe("requires_human");
  });

  it("answers Ashby's Race question despite its Hispanic or Latino definitions, and city-and-state location", async () => {
    const race = new FakeField({ id: "_systemfield_eeoc_race", label: "Race", type: "radio",
      questionDescriptor: { promptText: "Race", nearbyInstructionText: "Hispanic or Latino - A person of Cuban, Mexican, Puerto Rican, South or Central American, or other Spanish culture or origin regardless of race.White (Not Hispa", sourceStrategy: "question_container", confidence: "high" },
      options: ["Hispanic or Latino", "White (Not Hispanic or Latino)", "Black or African American (Not Hispanic or Latino)", "Asian (Not Hispanic or Latino)", "Decline to self-identify"].map((label) => ({ label, value: "on" })) });
    const cityState = new FakeField({ id: "827d49ed-f528-40d9-a303-d638cc7fc974", label: "Current location (city, state)", type: "text", required: true });
    const session = new FakeSession([race, cityState]);
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      identity: { ...exampleCandidateProfile.identity, location: "McDonald, Pennsylvania, USA" },
      approvedReusableAnswers: { ...exampleCandidateProfile.approvedReusableAnswers, race_ethnicity: "White" },
    };
    const result = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" }).execute({ ...request(session), profile });
    expect([race.current, cityState.current]).toEqual(["White (Not Hispanic or Latino)", "McDonald, PA"]);
    expect(result.state).toBe("ready_to_submit");
  });

  it("reads a long hiring-state question past the 240-character label bound", async () => {
    const full = "We are currently hiring remote candidates in the following states: California, Colorado, Connecticut, District of Columbia (DC), Florida, Georgia, Illinois, Indiana, Maryland, Massachusetts, Michigan, New Hampshire, New Jersey, New York, North Carolina, Ohio, Pennsylvania, Rhode Island, South Carolina, Tennessee, Texas, Utah, Virginia, Washington and Wisconsin. Please confirm whether or not you live in one of these states";
    const listed = new FakeField({ id: "listed", label: full.slice(0, 240), fullPrompt: full, type: "radio", required: true, options: ["Yes", "No"].map((label) => ({ label, value: label })) });
    const session = new FakeSession([listed]);
    const profile: CandidateProfile = { ...exampleCandidateProfile, identity: { ...exampleCandidateProfile.identity, location: "Pittsburgh, Pennsylvania, USA" } };
    const result = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" }).execute({ ...request(session), profile });
    expect({ state: result.state, value: listed.current }).toEqual({ state: "ready_to_submit", value: "Yes" });
  });

  it("answers Phantom's work region, city-and-country location, and an unmatched how-did-you-hear with Other", async () => {
    const region = new FakeField({ id: "bdb788f2", label: "We currently support remote work from North America, South America, and Europe. Which of these three locations will you be working from?", type: "radio", required: true,
      options: ["North America", "South America", "Europe", "Other"].map((label) => ({ label, value: label })) });
    const cityCountry = new FakeField({ id: "work-location", label: "Anticipated Work Location (City, Country)", type: "text", required: true });
    const heard = new FakeField({ id: "993e2ba3", label: "How did you hear about Phantom?", type: "select", required: true,
      options: ["Phantom User", "Phantom Employee", "Cryptocurrency Jobs", "Other", "LinkedIn - Employee Post", "Twitter - Phantom Tweet"].map((label) => ({ label, value: label })) });
    const session = new FakeSession([region, cityCountry, heard]);
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      identity: { ...exampleCandidateProfile.identity, location: "McDonald, Pennsylvania, USA" },
      approvedReusableAnswers: { ...exampleCandidateProfile.approvedReusableAnswers, job_source: "Another job site|Job board" },
    };
    const result = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" }).execute({ ...request(session), profile });
    expect([region.current, cityCountry.current, heard.current]).toEqual(["North America", "McDonald, United States", "Other"]);
    expect(result.state).toBe("ready_to_submit");
  });

  it("never pours a prepared answer into an unrelated question (skills into a clearance box, your name into a reference)", async () => {
    const clearance = new FakeField({ id: "question_13062993007", label: "Do you currently hold an active security clearance? If yes, please provide details. *", type: "text", required: true });
    const referrer = new FakeField({ id: "question_referrer", label: "Were you referred by a Kapitus employee? If yes, please provide the employee's full name.", type: "text", required: true });
    const refEmail = new FakeField({ id: "cards[r][field3]", label: "Email Address", type: "text", required: true, questionDescriptor: { sectionTitle: "References", promptText: "Email Address", sourceStrategy: "question_container", confidence: "high" } });
    const session = new FakeSession([clearance, referrer, refEmail]);
    const base = request(session);
    const answers = [
      { id: "answer:name", field: "name", question: "Full name", policy: "auto", value: "Nathaniel Magera", status: "resolved", provenance: ["profile:name"] },
      { id: "answer:verified_skills", field: "verified_skills", question: "Verified skills", policy: "auto", value: "Terraform, Python (FastAPI), TypeScript", status: "resolved", provenance: ["profile:verified_skills"] },
      { id: "answer:employment_history", field: "employment_history", question: "Employment history", policy: "auto", value: "Team Lead at Walmart", status: "resolved", provenance: ["profile:employment_history"] },
    ] as Application["answers"];
    await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" })
      .execute({ ...base, application: { ...base.application, answers } });
    expect([clearance.current, referrer.current, refEmail.current]).toEqual([null, null, null]);
  });

  it("checks the 'I certify my information is true' box but still asks about anything that signs away more", async () => {
    const certify = "I hereby certify that all information I have provided in this application is true, complete and correct to the best of my knowledge. I understand that any misrepresentation, omission or falsification may disqualify me from further consideration or may result in termination of employment if discovered later. *";
    const truthful = new FakeField({ id: "question_13062997007[]_35634078007", label: "I Acknowledge", type: "checkbox", required: true, fullPrompt: certify });
    const arbitration = new FakeField({ id: "arb", label: "I Agree", type: "checkbox", required: true,
      fullPrompt: "I certify that the information in my application is true and complete, and I agree to resolve any dispute through binding arbitration." });
    const signature = new FakeField({ id: "sig", label: "I certify that my answers are true and correct. Type your full name as your electronic signature.", type: "text", required: true });
    const session = new FakeSession([truthful]);
    await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" }).execute(request(session));
    expect(truthful.current).toBe(true);
    const arbitrationSession = new FakeSession([arbitration]);
    const asked = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(arbitrationSession), provider: "greenhouse" }).execute(request(arbitrationSession));
    expect(arbitration.current).toBeNull();
    expect(asked.state).not.toBe("ready_to_submit");
    expect(isTruthfulnessCertification(certify)).toBe(true);
    expect(isTruthfulnessCertification(signature.label)).toBe(false);
    expect(isTruthfulnessCertification("I certify the information is accurate and I authorize a background check.")).toBe(false);
  });

  it("treats Greenhouse's redirect to the board with ?error=true as a closed posting", async () => {
    class RedirectingSession extends FakeSession {
      override async navigate(): Promise<void> { await super.navigate("https://job-boards.greenhouse.io/kapitus?error=true"); }
    }
    const session = new RedirectingSession([]);
    const result = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" }).execute(request(session));
    expect(result.state).toBe("failed");
    expect("inspection" in result ? result.inspection?.evidence : []).toContain("posting:unavailable");
    expect(isGreenhouseClosedPostingRedirect("https://job-boards.greenhouse.io/kapitus?error=true", "kapitus")).toBe(true);
    expect(isGreenhouseClosedPostingRedirect("https://job-boards.greenhouse.io/kapitus/jobs/4390052009", "kapitus")).toBe(false);
    expect(isGreenhouseClosedPostingRedirect("https://job-boards.greenhouse.io/other?error=true", "kapitus")).toBe(false);
  });

  it("uses the candidate's answer for a question whose page exposes no prompt text (Sparksoft clearance loop)", async () => {
    const label = "Do you currently hold an active security clearance? If yes, please provide details. *";
    const answered = (fieldLabel: string) => ({
      id: "career-blocker-clearance", kind: "unknown_form_field", unit: "submission", questionProvenance: "ATS_FORM",
      field: "question_13063270007", question: label, reason: "The field could not be classified safely; no value was guessed.",
      evidence: ["executor:greenhouse-browser", "field-id:question_13063270007", "field-type:text", `field-label:${fieldLabel}`, "field-required:true", "classification:unknown", "question-source:unavailable"],
      resumeAfterHuman: true, status: "resolved", value: "No", createdAt: capturedAt, resolvedAt: capturedAt,
    }) as unknown as CareerJob["blockers"][number];
    const run = async (fieldLabel: string) => {
      const clearance = new FakeField({ id: "question_13063270007", label, type: "text", required: true });
      const session = new FakeSession([clearance]);
      const base = request(session);
      await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" })
        .execute({ ...base, careerJob: { ...base.careerJob, blockers: [answered(fieldLabel)] } });
      return clearance.current;
    };
    expect(await run(label)).toBe("No");
    // A different question on the same control id is not the answered one.
    expect(await run("Do you currently hold a professional license? *")).toBeNull();
  });

  it("answers Instructure's citizen status, residence, +1 phone and text-message consent from the profile", async () => {
    const radio = (id: string, label: string, options: string[]) => new FakeField({ id, label, type: "radio", required: true,
      options: options.map((option) => ({ label: option, value: "on" })), questionDescriptor: { promptText: label, sourceStrategy: "question_container", confidence: "high" } });
    const phone = new FakeField({ id: "992441f2", label: "Phone", type: "tel", required: true,
      questionDescriptor: { promptText: "Phone", nearbyInstructionText: "Please include your international country code starting with '+' (e.g., +1 555-123-4567 or +44 20 7946 0912).", sourceStrategy: "question_container", confidence: "high" } });
    const sms = new FakeField({ id: "992441f2--2", label: "Phone", type: "radio", required: true,
      options: [{ label: "Yes - I consent to receiving text messages", value: "given" }, { label: "No - I do not consent to receiving text messages", value: "notGiven" }] });
    const status = radio("0d6a9b73", "What is your current work authorization status in the country where this position is located?",
      ["Citizen", "Permanent resident / indefinite right to work", "Temporary visa with employer-specific authorization", "Temporary visa with open / transferable work authorization", "I am not currently authorized to work in this country"]);
    const reside = radio("624c4b82", "Do you currently reside in the country where this position is located?",
      ["Yes", "No, but I plan to relocate at my own expense", "No, and I would require employer support to relocate"]);
    const run = async (profile: CandidateProfile, location: string) => {
      for (const field of [phone, sms, status, reside]) field.current = null;
      const session = new FakeSession([phone, sms, status, reside]);
      const base = request(session);
      await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" })
        .execute({ ...base, profile, careerJob: { ...base.careerJob, job: { ...base.careerJob.job, location } } });
      return [phone.current, sms.current, status.current, reside.current];
    };
    const citizen: CandidateProfile = {
      ...exampleCandidateProfile,
      identity: { ...exampleCandidateProfile.identity, phone: "412-480-0379", location: "McDonald, Pennsylvania, USA" },
      workAuthorization: { status: "authorized", countries: ["United States"], sponsorshipRequired: false, citizenship: ["United States"] },
    };
    expect(await run(citizen, "Remote — U.S.")).toEqual(["+1 412-480-0379", "notGiven", "Citizen", "Yes"]);
    // Citizenship is never inferred from work authorization, and a non-US job's country is not assumed.
    const authorizedOnly: CandidateProfile = { ...citizen, workAuthorization: { status: "authorized", countries: ["United States"], sponsorshipRequired: false } };
    expect((await run(authorizedOnly, "Remote — U.S."))[2]).toBeNull();
    expect((await run(citizen, "Toronto, Canada")).slice(2)).toEqual([null, null]);
  });

  it("answers a U.S.-citizens-only Yes/No from profile citizenship, never from work authorization", async () => {
    const label = "Due to federal contract and security requirements, this position is open to U.S. citizens only. Are you a U.S. citizen?";
    const field = new FakeField({ id: "db581cf5", label, type: "radio", required: true,
      options: [{ label: "Yes", value: "on" }, { label: "No", value: "on" }], questionDescriptor: { promptText: label, sourceStrategy: "question_container", confidence: "high" } });
    const run = async (workAuthorization: CandidateProfile["workAuthorization"]) => {
      field.current = null;
      const session = new FakeSession([field]);
      const base = request(session);
      await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" })
        .execute({ ...base, profile: { ...exampleCandidateProfile, workAuthorization } });
      return field.current;
    };
    expect(await run({ status: "authorized", countries: ["United States"], sponsorshipRequired: false, citizenship: ["United States"] })).toBe("Yes");
    expect(await run({ status: "authorized", countries: ["United States"], sponsorshipRequired: false })).toBeNull();
  });

  it("fills D.A. Davidson-style education and employment cards without misplacing values", async () => {
    const card = (id: string, sectionTitle: string, promptText: string, type: "text" | "textarea" = "text") =>
      new FakeField({ id: `cards[c][${id}]`, label: promptText, type, required: true, questionDescriptor: { sectionTitle, promptText, sourceStrategy: "question_container", confidence: "high" } });
    const institution = card("field1", "Education", "Institution Name");
    const schoolLocation = card("field2", "Education", "Location of Institution (City, State, Country)");
    const degree = card("field3", "Education", "Degree or Certification Earned");
    const attendStart = card("field4", "Education", "Attendance Start Date (MM/YYYY)");
    const training = card("field6", "Education", "Additional Training or Certifications", "textarea");
    const employerPhone = card("field2b", "Employment", "Employer Phone Number");
    const employmentStart = card("field5b", "Employment", "Employment Start Date (MM/YYYY)");
    const referenceEmail = card("field3r", "References", "Email Address");
    const referencePhone = card("field4r", "References", "Phone Number");
    const fields = [institution, schoolLocation, degree, attendStart, training, employerPhone, employmentStart, referenceEmail, referencePhone];
    const session = new FakeSession(fields);
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      workPreferences: { ...exampleCandidateProfile.workPreferences, availabilityStartDate: "2026-10-01" },
      education: [{ id: "ptc", institution: "Pittsburgh Technical College", degree: "Associate of Science", field: "Information Technology", completionDate: "2013", provenance: "test" }],
      employmentHistory: [{ id: "ntt", employer: "NTT Security", title: "Security Analyst", location: null, startDate: "2014-03", endDate: "2018-12", provenance: "test" } as never],
    };
    await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" }).execute({ ...request(session), profile });
    expect([institution.current, degree.current, employmentStart.current]).toEqual(["Pittsburgh Technical College", "Associate of Science", "03/2014"]);
    // The profile holds none of these; the candidate's own location, availability date,
    // field of study, employer name, email, and phone must not stand in for them.
    expect([schoolLocation, attendStart, training, employerPhone, referenceEmail, referencePhone].map((field) => field.current)).toEqual([null, null, null, null, null, null]);
  });

  it("answers immigration-law work authorization, highest education, and current-employee questions from the profile", async () => {
    const select = (id: string, label: string, options: readonly string[]) =>
      new FakeField({ id, label, type: "select", required: true, options: options.map((option) => ({ label: option, value: option })) });
    const authorized = select("auth", "Are you presently authorized under U.S. immigration laws to work in the United States?*", ["Yes", "No"]);
    const education = select("edu", "Please select your highest completed level of education.*", ["High School or equivalent", "Some College", "Associate's Degree", "Bachelor's Degree", "Master's Degree", "Doctorate"]);
    const current = select("current", "Are you a current Kapitus employee? If yes, please apply via our Internal Job Board.*", ["Yes", "No"]);
    const session = new FakeSession([authorized, education, current]);
    const base = request(session);
    const profile: CandidateProfile = {
      ...exampleCandidateProfile,
      workAuthorization: { status: "authorized", countries: ["United States"], sponsorshipRequired: false },
      education: [{ id: "ptc", institution: "Pittsburgh Technical College", degree: "Associate of Science", field: "Information Technology", completionDate: "2013", provenance: "test" }],
    };
    const result = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" }).execute({ ...base, profile });

    expect(result.state).toBe("ready_to_submit");
    expect([authorized.current, education.current, current.current]).toEqual(["Yes", "Associate's Degree", "No"]);
  });

  it("accepts a location typeahead's own spelling and a shortened company name", async () => {
    // The typeahead commits "McDonald, PA, USA" for "McDonald, Pennsylvania, USA".
    class TypeaheadField extends FakeField {
      override async fill(_value: string): Promise<void> { this.fillCalls += 1; this.current = "McDonald, PA, USA"; }
    }
    const location = new TypeaheadField({ id: "location-input", label: "Current location", type: "text", required: true });
    const current = new FakeField({ id: "current", label: "Are you a current Kapi employee? If yes, please apply internally.*", type: "select", required: true,
      options: ["Yes", "No"].map((label) => ({ label, value: label })) });
    const session = new FakeSession([location, current]);
    const base = request(session);
    const profile: CandidateProfile = { ...exampleCandidateProfile, identity: { ...exampleCandidateProfile.identity, location: "McDonald, Pennsylvania, USA" } };
    const result = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" }).execute({
      ...base,
      profile,
      careerJob: { ...base.careerJob, job: { ...base.careerJob.job, company: "Kapi Capital" } },
    });

    expect(result.state).toBe("ready_to_submit");
    expect(location.current).toBe("McDonald, PA, USA");
    expect(current.current).toBe("No");
  });

  it("asks an optional essay question once, and leaves it blank after SKIP", async () => {
    const prompt = "We understand that applicants don’t always have all the preferred requirements. Please highlight which requirement you have the least experience in.";
    const essay = () => new FakeField({ id: "question_essay", label: prompt, type: "textarea", required: false,
      questionDescriptor: { promptText: prompt, sourceStrategy: "question_container", confidence: "high" } });
    const other = new FakeField({ id: "anything", label: "Is there anything else you would like us to know about you? Please share.", type: "textarea", required: false });

    const first = essay();
    const firstSession = new FakeSession([first, other]);
    const asked = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(firstSession), provider: "greenhouse" }).execute(request(firstSession));
    expect(asked.state).toBe("requires_human");
    expect(asked.state === "requires_human" && asked.blocker.kind).toBe("subjective_answer");
    expect(asked.state === "requires_human" && asked.blocker.field).toBe("question_essay");

    const second = essay();
    const secondSession = new FakeSession([second]);
    const base = request(secondSession);
    const skipped = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(secondSession), provider: "greenhouse" }).execute({
      ...base,
      careerJob: { ...base.careerJob, blockers: [{
        id: "skip", kind: "subjective_answer", unit: "submission", field: "question_essay", question: prompt,
        context: { jobId: base.careerJob.id, company: "Kapitus", role: "Engineer" }, reason: "optional", evidence: [],
        status: "resolved", createdAt: capturedAt, resolvedAt: capturedAt, value: OPTIONAL_ANSWER_SKIPPED,
      }] },
    });
    expect(skipped.state).toBe("ready_to_submit");
    expect(second.current).toBeNull();
    expect(second.fillCalls).toBe(0);
  });

  it("treats a question that mentions résumés as a question, not the résumé upload", () => {
    // Temporal (2026-11-09): the file path was typed into this essay box.
    const prompt = "We know resumes only tell part of the story. Choose one to share with us (150 words max) Tell us something we won't learn from your resume.";
    expect(classifyLeverApplicationField({ id: "q1", label: prompt, type: "textarea", questionDescriptor: { promptText: prompt, sourceStrategy: "question_container", confidence: "high" } }))
      .toBe("free_text");
    expect(classifyLeverApplicationField({ id: "q2", label: "Anything not on your resume you'd like us to know?", type: "text" })).not.toBe("resume_upload");
    // The real upload controls still are.
    expect(classifyLeverApplicationField({ id: "resume", label: "Resume/CV", type: "file" })).toBe("resume_upload");
    expect(classifyLeverApplicationField({ id: "resume_text", label: "Resume", type: "text" })).toBe("resume_upload");
  });

  it("asks short optional essay prompts too, but not follow-ups or short facts", async () => {
    // Temporal and ElevenLabs (2026-11-08): these were left blank because they were under 60 characters.
    const asks = ["What made you decide to apply?", "What makes you excited about the ElevenLabs mission?", "Finally, tell us about a hard problem in your past!"];
    for (const prompt of asks) {
      const field = new FakeField({ id: "question_short", label: prompt, type: "textarea", required: false,
        questionDescriptor: { promptText: prompt, sourceStrategy: "question_container", confidence: "high" } });
      const session = new FakeSession([field]);
      const result = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" }).execute(request(session));
      expect(result.state, prompt).toBe("requires_human");
      expect(result.state === "requires_human" && result.blocker.kind, prompt).toBe("subjective_answer");
    }
    const leaves = ["If other, please specify below", "Name Pronunciation", "Preferred Pronouns", "How did you hear about us?"];
    for (const prompt of leaves) {
      const field = new FakeField({ id: "question_short", label: prompt, type: "textarea", required: false,
        questionDescriptor: { promptText: prompt, sourceStrategy: "question_container", confidence: "high" } });
      const session = new FakeSession([field]);
      const result = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" }).execute(request(session));
      expect(result.state, prompt).toBe("ready_to_submit");
      expect(field.fillCalls, prompt).toBe(0);
    }
  });

  it("answers a location-preference checkbox group with Remote only", async () => {
    const descriptor = { promptText: "Location Preference", sectionTitle: "Application questions", sourceStrategy: "question_container", confidence: "high" } as const;
    const options = ["Burlingame, CA", "Austin, TX", "Remote"].map((label, index) =>
      new FakeField({ id: `question_67832267[]_${index}`, label, type: "checkbox", required: true, questionDescriptor: descriptor }));
    const session = new FakeSession(options);
    const result = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" }).execute(request(session));

    expect(result.state).toBe("ready_to_submit");
    expect(options.map((field) => field.current === true)).toEqual([false, false, true]);
  });

  it("opens the same posting's embed form when the hosted page redirects to the employer's site", async () => {
    const firstName = new FakeField({ id: "first_name", label: "First Name", type: "text", required: true });
    const session = new FakeSession([firstName]);
    const visited: string[] = [];
    const navigate = session.navigate.bind(session);
    session.navigate = async (url: string) => {
      visited.push(url);
      // careers.example.com plays the employer site that the hosted page redirects to.
      await navigate(url.includes("/embed/job_app") ? url : "https://careers.example.com/jobs?gh_jid=1");
    };
    const result = await new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "greenhouse" }).execute(request(session));

    expect(result.state).toBe("ready_to_submit");
    expect(visited).toEqual([applicationUrl, greenhouseEmbedApplicationUrl("kapitus", new URL(applicationUrl).pathname.split("/").pop()!)]);
    expect(isVerifiedGreenhouseEmbedUrl(session.currentUrl(), "kapitus", new URL(applicationUrl).pathname.split("/").pop()!)).toBe(true);
    expect(isVerifiedGreenhouseEmbedUrl("https://job-boards.greenhouse.io/embed/job_app?for=other&token=1", "kapitus", "1")).toBe(false);
  });

  it("rejects a Greenhouse-looking URL without independent destination verification", () => {
    const session = new FakeSession([]);
    const executor = new LeverBrowserExecutor({ sessionFactory: new FakeSessionFactory(session), provider: "auto" });
    const unverified = request(session);
    unverified.careerJob.destinationResolution = undefined;
    expect(executor.supports(unverified)).toBe(false);
    const curated = request(session);
    curated.careerJob.sourceId = "curated-live";
    curated.careerJob.sourceRecordId = "greenhouse:kapitus:4390052009";
    expect(executor.supports({
      ...curated,
      careerJob: {
        ...curated.careerJob,
        job: { ...curated.careerJob.job, sourceUrl: "https://job-boards.greenhouse.io/kapitus/jobs/4390052010" },
      },
    })).toBe(false);
    expect(executor.supports({
      ...curated,
      careerJob: {
        ...curated.careerJob,
        job: { ...curated.careerJob.job, sourceUrl: "https://job-boards.greenhouse.io/other-board/jobs/4390052009" },
      },
    })).toBe(false);
  });
});
