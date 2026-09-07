import { describe, expect, it } from "vitest";
import {
  LeverBrowserExecutor,
  exampleCandidateProfile,
  type Application,
  type ApplicationExecutionRequest,
  type ApplicationFieldOption,
  type ApplicationFieldType,
  type Campaign,
  type CareerJob,
  type JobPosting,
  type LeverBrowserField,
  type LeverBrowserSession,
  type LeverBrowserSessionFactory,
} from "../application-agent/src";

const capturedAt = "2026-09-07T12:00:00.000Z";
const postingUrl = "https://ats.rippling.com/fullthrottle1/jobs/rippling-posting-123";
const formUrl = `${postingUrl}/apply`;

class FakeField implements LeverBrowserField {
  readonly classification = "unknown" as const;
  readonly id: string;
  readonly label: string;
  readonly type: ApplicationFieldType;
  readonly required: boolean;
  readonly options?: readonly ApplicationFieldOption[];
  readonly questionDescriptor?: LeverBrowserField["questionDescriptor"];
  current: string | boolean | null = null;
  fillCalls = 0;

  constructor(options: {
    id: string;
    label: string;
    type: ApplicationFieldType;
    required?: boolean;
    options?: readonly ApplicationFieldOption[];
    questionDescriptor?: LeverBrowserField["questionDescriptor"];
  }) {
    this.id = options.id;
    this.label = options.label;
    this.type = options.type;
    this.required = options.required ?? false;
    this.options = options.options;
    this.questionDescriptor = options.questionDescriptor;
  }

  async fill(value: string): Promise<void> {
    this.fillCalls += 1;
    this.current = value;
  }

  async select(value: string): Promise<void> {
    this.current = value;
  }

  async setChecked(value: boolean): Promise<void> {
    this.current = value;
  }

  async uploadFile(path: string): Promise<void> {
    this.current = path;
  }

  async readValue(): Promise<string | boolean | null> {
    return this.current;
  }
}

class FakeSession implements LeverBrowserSession {
  current = "";
  opens = 0;
  submitClicks = 0;

  constructor(readonly fields: readonly FakeField[]) {}

  async navigate(url: string): Promise<void> {
    this.opens += 1;
    this.current = url;
  }

  currentUrl(): string {
    return this.current;
  }

  async inspectFields(): Promise<readonly LeverBrowserField[]> {
    return this.fields;
  }

  async detectHumanBoundary(): Promise<null> {
    return null;
  }

  async hasSubmitControl(): Promise<boolean> {
    return true;
  }

  async submit() {
    this.submitClicks += 1;
    return { clicked: true, confirmed: true, externalApplicationId: "never-used", evidence: "test-only" };
  }

  async close(): Promise<void> {}
}

class FakeSessionFactory implements LeverBrowserSessionFactory {
  opens = 0;

  constructor(readonly session: FakeSession) {}

  async open(): Promise<LeverBrowserSession> {
    this.opens += 1;
    return this.session;
  }
}

function job(): JobPosting {
  return {
    sourceUrl: postingUrl,
    applicationUrl: postingUrl,
    company: "FullThrottle.ai",
    title: "AI Platform Engineer",
    location: "Remote - United States",
    remoteStatus: "remote",
    employmentType: "Full-time",
    description: "Build platform systems for an AI engineering team.",
    requiredSkills: ["Python", "Kubernetes"],
    preferredSkills: ["AWS"],
    seniority: "mid",
    ats: "Rippling",
    capturedAt,
  };
}

function campaign(): Campaign {
  return {
    id: "campaign-rippling-test",
    name: "Synthetic Rippling campaign",
    goal: "Inspect a selected public posting without submitting.",
    status: "active",
    searchCriteria: {
      roleLanes: ["AI Platform"],
      locations: ["United States"],
      remoteOnly: true,
      employmentTypes: ["Full-time"],
      excludedSeniorities: [],
      excludedCompanies: [],
    },
    searchSources: ["curated-live"],
    fitPolicy: { strong: "pursue", good: "pursue", stretch: "hold", weak: "reject" },
    applicationPolicy: { autoPrepare: true, allowGroundedDrafts: true, approvedResumeFamilies: [] },
    submissionPolicy: { authority: "never", requireExplicitApproval: false },
    dailyApplicationLimit: 3,
    reviewConditions: { unusualTerms: true, authenticationRequired: true, unknownFacts: true, subjectiveAnswers: true },
    stopConditions: { stopOnAcceptedOffer: true, systemicFailureLimit: 3 },
    consecutiveSystemicFailures: 0,
    createdAt: capturedAt,
    updatedAt: capturedAt,
  };
}

function careerJob(currentJob: JobPosting): CareerJob {
  return {
    id: "career-rippling-job",
    campaignId: "campaign-rippling-test",
    isExample: false,
    sourceMode: "live",
    actionability: "actionable",
    fingerprint: "source:curated-live:id:fullthrottle1:rippling-posting-123",
    sourceId: "curated-live",
    sourceRecordId: "fullthrottle1:rippling-posting-123",
    destinationResolution: {
      status: "resolved",
      attemptedAt: capturedAt,
      destinationUrl: postingUrl,
      ats: "Rippling",
      actionable: true,
      provenance: "recognized_ats_evidence",
      evidence: ["curated:explicit-public-posting"],
    },
    job: currentJob,
    discoveredAt: capturedAt,
    fit: null,
    status: "ready_to_submit",
    blockers: [],
    createdAt: capturedAt,
    updatedAt: capturedAt,
  };
}

function application(currentJob: JobPosting): Application {
  return {
    id: "application-rippling-test",
    isExample: false,
    job: currentJob,
    fit: null,
    resume: {
      familyId: "cloud-platform",
      familyLabel: "Cloud / Platform",
      summary: "Synthetic prepared resume.",
      sections: [],
      generatedAt: capturedAt,
    },
    answers: [],
    blockers: [],
    status: "ready_for_review",
    createdAt: capturedAt,
    updatedAt: capturedAt,
  };
}

function request(currentJob: JobPosting): ApplicationExecutionRequest {
  return {
    campaign: campaign(),
    careerJob: careerJob(currentJob),
    application: application(currentJob),
    now: capturedAt,
    profile: exampleCandidateProfile,
  };
}

describe("Rippling browser routing", () => {
  it("derives the verified form route, fills safe contact data, and stops at the first human field", async () => {
    const firstName = new FakeField({ id: "first-name", label: "First name", type: "text", required: true });
    const salary = new FakeField({
      id: "salary-expectations",
      label: "Salary expectations",
      type: "text",
      required: true,
      questionDescriptor: {
        promptText: "What are your salary expectations?",
        sectionTitle: "Application questions",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    });
    const session = new FakeSession([firstName, salary]);
    const factory = new FakeSessionFactory(session);
    const executor = new LeverBrowserExecutor({
      sessionFactory: factory,
      provider: "auto",
      now: () => capturedAt,
    });

    const result = await executor.execute(request(job()));

    expect(executor.supports(request(job()))).toBe(true);
    expect(factory.opens).toBe(1);
    expect(session.current).toBe(formUrl);
    expect(firstName.fillCalls).toBe(1);
    expect(salary.fillCalls).toBe(0);
    expect(result.state).toBe("requires_human");
    if (result.state !== "requires_human") return;
    expect(result.blocker).toMatchObject({
      kind: "salary",
      question: "What are your salary expectations?",
      questionProvenance: "ATS_FORM",
    });
    expect(result.blocker.evidence).toContain("executor:rippling-browser");
    expect(session.submitClicks).toBe(0);
  });
});
