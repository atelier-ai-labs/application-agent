// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  attentionEventForCareerBlocker,
  formatPostedCompensation,
  isAttentionEvent,
  LocalStorageCareerRepository,
  normalizeJobPosting,
  parseHimalayasResponse,
  parseRemotiveResponse,
  type CareerBlocker,
  type CareerJob,
  type JobCompensation,
  type KeyValueStorage,
  type JobPosting,
} from "../application-agent/src";
import {
  SlackNotificationAdapter,
} from "../application-agent/automation/slack/slackNotificationAdapter";

const capturedAt = "2026-09-04T12:00:00.000Z";

const slackConfig = {
  botToken: "bot-token-fixture",
  appToken: "app-token-fixture",
  channelId: "C123456",
  allowedUserId: "U123456",
  allowedTeamId: "T123456",
  apiBaseUrl: "https://slack.test/api",
};

function salaryBlocker(): CareerBlocker {
  return {
    id: "blocker-salary-1",
    kind: "salary",
    unit: "application_preparation",
    field: "salary_expectations",
    question: "What are your salary expectations?",
    context: {
      jobId: "job-salary-1",
      applicationId: "application-salary-1",
      company: "Example Cloud Co",
      role: "Platform Engineer",
    },
    reason: "The application requires an explicit candidate salary answer.",
    evidence: [],
    status: "open",
    createdAt: capturedAt,
    resumeAfterHuman: true,
  };
}

function salaryEvent(compensation?: JobCompensation) {
  const generated = attentionEventForCareerBlocker({
    campaignId: "campaign-salary-1",
    jobId: "job-salary-1",
    blocker: salaryBlocker(),
    ...(compensation ? { postingCompensation: compensation } : {}),
    createdAt: capturedAt,
    createId: (prefix) => `${prefix}-salary-1`,
  });
  if (!generated) throw new Error("salary attention fixture was not generated");
  return generated.event;
}

async function slackPayload(event: ReturnType<typeof salaryEvent>): Promise<string> {
  let payload = "";
  const adapter = new SlackNotificationAdapter({
    config: slackConfig,
    fetcher: async (_input, init) => {
      payload = typeof init?.body === "string" ? init.body : "";
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, ts: "1710000000.000001" }),
      } as Response;
    },
  });
  await adapter.publishAttentionEvent(event);
  return payload;
}

function himalayasJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Platform Engineer",
    companyName: "Example Cloud Co",
    employmentType: "Full Time",
    seniority: ["Mid-level"],
    currency: "USD",
    salaryPeriod: "annual",
    minSalary: 85000,
    maxSalary: 120000,
    locationRestrictions: [{ alpha2: "US", name: "United States" }],
    timezoneRestrictions: ["UTC-5"],
    categories: ["Infrastructure"],
    parentCategories: ["Engineering"],
    description: "Build dependable platform services for product teams. Required qualifications: Kubernetes.",
    applicationLink: "https://jobs.example.com/platform/apply",
    guid: "himalayas-salary-1",
    ...overrides,
  };
}

class MapStorage implements KeyValueStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

function durableJob(job: JobPosting): CareerJob {
  return {
    id: "career-job-salary-1",
    campaignId: "campaign-salary-1",
    isExample: false,
    sourceMode: "live",
    actionability: "discoverable_only",
    fingerprint: "salary-fingerprint",
    sourceId: "himalayas-live",
    sourceRecordId: "himalayas-salary-1",
    dedupeKeys: ["himalayas:himalayas-salary-1"],
    sourceObservations: [],
    job,
    discoveredAt: capturedAt,
    fit: null,
    status: "needs_input",
    blockers: [],
    createdAt: capturedAt,
    updatedAt: capturedAt,
  };
}

describe("grounded salary context", () => {
  it("does not turn technical acronyms or experience ranges into compensation", () => {
    const job = normalizeJobPosting({
      companyHint: "D.A. Davidson & Co.",
      titleHint: "Azure Cloud Engineer",
      rawText: `D.A. Davidson & Co.
Azure Cloud Engineer
Build and operate Azure platform services.
Requirements: 3-5+ years of hands-on Microsoft Azure experience, including AKS.
`,
    }, capturedAt);

    expect(job.compensation).toBeUndefined();
  });

  it("parses an explicit compensation line without widening into arbitrary posting text", () => {
    const job = normalizeJobPosting({
      companyHint: "Example Cloud Co",
      titleHint: "Platform Engineer",
      rawText: `Example Cloud Co
Platform Engineer
Build dependable platform services.
Compensation: USD 95,000-120,000 per year
Requirements: 3-5+ years of platform engineering experience.
`,
    }, capturedAt);

    expect(job.compensation).toEqual({ minimum: 95000, maximum: 120000, currency: "USD", period: "annual" });
  });

  it("prefers trusted structured compensation supplied at intake", () => {
    const job = normalizeJobPosting({
      companyHint: "D.A. Davidson & Co.",
      titleHint: "Azure Cloud Engineer",
      compensation: { minimum: 95000, maximum: 120000, currency: "USD", period: "annual" },
      rawText: `D.A. Davidson & Co.
Azure Cloud Engineer
Build and operate Azure platform services.
Requirements: 3-5+ years of hands-on Microsoft Azure experience, including AKS.
`,
    }, capturedAt);

    expect(job.compensation).toEqual({ minimum: 95000, maximum: 120000, currency: "USD", period: "annual" });
  });

  it("formats ranges, one-sided bounds, currency, and pay periods without conversion", () => {
    expect(formatPostedCompensation({ minimum: 85000, maximum: 120000, currency: "USD", period: "annual" }))
      .toBe("$85,000–$120,000 per year");
    expect(formatPostedCompensation({ minimum: 95000, currency: "USD", period: "annual" }))
      .toBe("From $95,000 per year");
    expect(formatPostedCompensation({ maximum: 60, currency: "USD", period: "hourly" }))
      .toBe("Up to $60 per hour");
    expect(formatPostedCompensation({ minimum: 60, currency: "USD", period: "hourly" }))
      .toBe("From $60 per hour");
    expect(formatPostedCompensation({ minimum: 70000, maximum: 90000, currency: "CAD", period: "monthly" }))
      .toBe("CAD 70,000–CAD 90,000 per month");
  });

  it("renders salary context as posted compensation and keeps the answer request separate", async () => {
    const event = salaryEvent({ minimum: 85000, maximum: 120000, currency: "USD", period: "annual" });
    expect(isAttentionEvent(event)).toBe(true);
    expect(event.context.postingCompensation).toEqual({ minimum: 85000, maximum: 120000, currency: "USD", period: "annual" });
    expect(event.question).not.toHaveProperty("value");
    const payload = await slackPayload(event);
    expect(payload).toContain("The job posting lists compensation of $85,000–$120,000 per year.");
    expect(payload).toContain("Career Agent needs this candidate fact before application execution:");
    expect(payload).not.toContain("Application question:");
    expect(payload).toContain("What are your salary expectations?");
    expect(payload).toContain("What should I enter?");
    expect(payload).not.toContain("Your expected salary is");
  });

  it.each([
    [{ minimum: 95000, currency: "USD", period: "annual" }, "From $95,000 per year"],
    [{ maximum: 60, currency: "USD", period: "hourly" }, "Up to $60 per hour"],
  ] as const)("renders one-sided posted compensation safely", async (compensation, expected) => {
    const payload = await slackPayload(salaryEvent(compensation));
    expect(payload).toContain(`The job posting lists compensation of ${expected}.`);
  });

  it("states clearly when the posting has no usable compensation", async () => {
    const event = salaryEvent();
    expect(event.context.postingCompensation).toBeUndefined();
    const payload = await slackPayload(event);
    expect(payload).toContain("No compensation range was found in the job posting.");
    expect(payload).not.toContain("$0");
  });

  it("leaves unrelated attention messages unchanged even when job context has compensation", async () => {
    const base = salaryEvent();
    const unrelated = {
      ...base,
      blockerType: "unknown_fact" as const,
      context: {
        ...base.context,
        postingCompensation: { minimum: 85000, maximum: 120000, currency: "USD", period: "annual" },
      },
      question: {
        prompt: "What candidate fact should I provide?",
        kind: "free_text" as const,
        options: [],
      },
    };
    const payload = await slackPayload(unrelated);
    expect(payload).not.toContain("job posting lists compensation");
    expect(payload).not.toContain("No compensation range was found");
    expect(payload).toContain("What candidate fact should I provide?");
  });

  it("persists normalized job compensation across repository reload", () => {
    const storage = new MapStorage();
    const posting: JobPosting = {
      company: "Example Cloud Co",
      title: "Platform Engineer",
      compensation: { minimum: 85000, maximum: 120000, currency: "USD", period: "annual" },
      description: "Build dependable platform services.",
      requiredSkills: ["Kubernetes"],
      preferredSkills: [],
      capturedAt,
    };
    new LocalStorageCareerRepository(storage).saveJob(durableJob(posting));
    const reloaded = new LocalStorageCareerRepository(storage).getJob("career-job-salary-1");
    expect(reloaded?.job.compensation).toEqual(posting.compensation);
  });

  it("carries Himalayas normalized salary into the attention context", () => {
    const parsed = parseHimalayasResponse({ jobs: [himalayasJob()] }, capturedAt);
    const job = normalizeJobPosting(parsed.listings[0].input, capturedAt);
    expect(job.compensation).toEqual({ minimum: 85000, maximum: 120000, currency: "USD", period: "annual" });
    const event = salaryEvent(job.compensation);
    expect(event.context.postingCompensation).toEqual(job.compensation);
  });

  it("keeps Remotive hourly salary structured and hourly", () => {
    const result = parseRemotiveResponse({
      jobs: [{
        id: 77,
        url: "https://remotive.com/jobs/platform-77",
        title: "Platform Engineer",
        company_name: "Example Cloud Co",
        salary: "$60/hour",
        description: "Build dependable platform services. Required qualifications: Kubernetes.",
      }],
    }, {
      roleLanes: ["Platform Engineer"],
      searchQueries: [],
      locations: [],
      remoteOnly: true,
      employmentTypes: [],
      excludedSeniorities: [],
      excludedCompanies: [],
    }, capturedAt, 10);
    const job = normalizeJobPosting(result.listings[0].input, capturedAt);
    expect(job.compensation).toEqual({ minimum: 60, currency: "USD", period: "hourly" });
  });
});
