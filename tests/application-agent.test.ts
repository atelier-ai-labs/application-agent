import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANSWER_POLICIES,
  ApplicationService,
  InMemoryApplicationRepository,
  JobIntakeError,
  SubmissionDisabledError,
  assessFit,
  blockersFromAnswers,
  buildDraftAnswer,
  createApplicationEvent,
  exampleCandidateProfile,
  isApplication,
  isCandidateProfile,
  isJobPosting,
  normalizeJobPosting,
  pastedJobPostingIngestor,
  prepareApplicationAnswers,
  tailorResume,
  type Application,
  type ApplicationEvent,
  type CandidateProfile,
  type JobPosting,
  type KeyValueStorage,
} from "../application-agent/src";
import {
  APPLICATIONS_STORAGE_KEY,
  EVENTS_STORAGE_KEY,
  LocalStorageApplicationRepository,
} from "../application-agent/src/persistence/applicationRepository";

const capturedAt = "2026-08-30T12:00:00.000Z";

const postingInput = {
  companyHint: "Northstar Cloud",
  titleHint: "Senior Platform Engineer",
  sourceUrl: "https://jobs.example.test/northstar/platform",
  applicationUrl: "https://jobs.example.test/northstar/platform/apply",
  rawText: `Northstar Cloud
Senior Platform Engineer
Location: Remote - United States
Employment type: Full-time

Build dependable platform services and developer workflows for internal product teams.

Required qualifications
- AWS
- Kubernetes
- Python
- Observability

Preferred qualifications
- Terraform
- GitHub Actions
`,
};

function cloneExampleProfile(): CandidateProfile {
  return JSON.parse(JSON.stringify(exampleCandidateProfile)) as CandidateProfile;
}

describe("candidate profile optional application facts", () => {
  it("keeps older profiles valid when optional facts are absent and validates explicit URLs", () => {
    const olderProfile = cloneExampleProfile() as CandidateProfile & {
      identity: CandidateProfile["identity"] & Record<string, unknown>;
      workPreferences: CandidateProfile["workPreferences"] & Record<string, unknown>;
    };
    delete olderProfile.identity.linkedinUrl;
    delete olderProfile.identity.websiteUrl;
    delete olderProfile.workPreferences.preferredWorkLocation;
    delete olderProfile.workPreferences.availabilityStartDate;

    expect(isCandidateProfile(olderProfile)).toBe(true);
    expect(isCandidateProfile({
      ...olderProfile,
      identity: { ...olderProfile.identity, linkedinUrl: "candidate.example/linkedin" },
    })).toBe(false);
    expect(isCandidateProfile({
      ...olderProfile,
      identity: { ...olderProfile.identity, linkedinUrl: "https://www.linkedin.com/in/example-candidate" },
      workPreferences: {
        ...olderProfile.workPreferences,
        preferredWorkLocation: "Remote",
        availabilityStartDate: "2026-10-01",
      },
    })).toBe(true);
  });
});

function canonicalPosting(overrides: Partial<JobPosting> = {}): JobPosting {
  return {
    company: "Northstar Cloud",
    title: "Senior Platform Engineer",
    description: postingInput.rawText,
    requiredSkills: ["AWS", "Kubernetes", "Python"],
    preferredSkills: ["Terraform"],
    capturedAt,
    ...overrides,
  };
}

function runtime() {
  let tick = 0;
  let sequence = 0;
  const base = Date.parse(capturedAt);
  return {
    now: () => new Date(base + tick++ * 1_000).toISOString(),
    createId: (prefix: string) => `${prefix}-${++sequence}`,
  };
}

class MapStorage implements KeyValueStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("Application Agent job intake and grounding", () => {
  it("normalizes valid pasted job content and keeps provenance fields", async () => {
    const job = normalizeJobPosting(postingInput, capturedAt);

    expect(job).toMatchObject({
      company: "Northstar Cloud",
      title: "Senior Platform Engineer",
      sourceUrl: postingInput.sourceUrl,
      applicationUrl: postingInput.applicationUrl,
      location: "Remote - United States",
      remoteStatus: "remote",
      employmentType: "full time",
      seniority: "senior",
      requiredSkills: ["AWS", "Kubernetes", "Python", "Observability"],
      preferredSkills: ["Terraform", "GitHub Actions"],
      capturedAt,
    });
    expect(isJobPosting(job)).toBe(true);
    await expect(pastedJobPostingIngestor.ingest(postingInput, capturedAt)).resolves.toEqual(job);
  });

  it("rejects malformed or ambiguous job intake instead of fabricating fields", () => {
    expect(() => normalizeJobPosting({ rawText: "Too short" }, capturedAt)).toThrow(JobIntakeError);
    expect(() => normalizeJobPosting({
      rawText: postingInput.rawText,
      companyHint: "Northstar Cloud",
      titleHint: "Senior Platform Engineer",
      sourceUrl: "javascript:alert(1)",
    }, capturedAt)).toThrow("Source URL must be an http or https URL");
    expect(isJobPosting({ ...canonicalPosting(), title: 42 })).toBe(false);
  });

  it("assesses fit qualitatively, flags unsupported qualifications, and routes a resume family", () => {
    const fit = assessFit(canonicalPosting({
      requiredSkills: ["AWS", "Kubernetes", "Go"],
      preferredSkills: ["Terraform"],
    }), exampleCandidateProfile);

    expect(fit.classification).toBe("stretch");
    expect(fit.strongMatches).toEqual(expect.arrayContaining(["AWS", "Kubernetes", "Terraform"]));
    expect(fit.unsupportedRequiredQualifications).toEqual(["Go"]);
    expect(fit.meaningfulGaps).toContain("Required: Go");
    expect(fit.recommendedResumeFamily).toBe("cloud-platform");
    expect(fit.applicationRecommendation).toBe("proceed_with_review");
    expect(fit).not.toHaveProperty("score");
  });

  it("routes frontend roles to the verified frontend family and fails closed when it is absent", () => {
    const frontend = assessFit(canonicalPosting({ company: "Reddit", title: "Frontend Engineer, Ads", requiredSkills: ["React", "TypeScript"] }), exampleCandidateProfile);
    expect(frontend.recommendedResumeFamily).toBe("frontend-software");

    const cloudOnly = { ...exampleCandidateProfile, resumeFamilies: exampleCandidateProfile.resumeFamilies.filter((family) => family.id === "cloud-platform") };
    expect(() => assessFit(canonicalPosting({ company: "Reddit", title: "Frontend Engineer, Ads", requiredSkills: ["React"] }), cloudOnly)).toThrow("No verified frontend/software resume family");
  });

  it("routes an AI platform posting by dominant role signals, not supporting cloud keywords", () => {
    const fit = assessFit(canonicalPosting({
      title: "AI Platform Engineer",
      description: "Build production APIs and microservices for Bedrock AgentCore and Strands agents with observability.",
      requiredSkills: ["AWS", "Terraform", "CloudFormation"],
      preferredSkills: ["LLM", "agentic systems"],
    }), exampleCandidateProfile);
    expect(fit.recommendedResumeFamily).toBe("ai-platform-agentic");
  });

  it("fails closed when configured families tie on the posting focus", () => {
    const profile = cloneExampleProfile();
    const cloud = profile.resumeFamilies.find((family) => family.id === "cloud-platform")!;
    profile.resumeFamilies = [cloud, { ...cloud, label: "Cloud / Platform (alternate)" }];
    expect(() => assessFit(canonicalPosting({ title: "Cloud Engineer", description: "Build cloud services.", requiredSkills: [], preferredSkills: [] }), profile)).toThrow(/ties between/);
  });

  it("matches explicit technologies inside bounded compound skill labels", () => {
    const profile = cloneExampleProfile();
    profile.skills = [
      "Python (Django)",
      "React / TypeScript / JavaScript",
      "Node.js (Express)",
      "SQL (PostgreSQL)",
    ];
    profile.employmentHistory = [];
    profile.projects = [];

    const fit = assessFit(canonicalPosting({
      requiredSkills: ["Python", "React", "TypeScript", "JavaScript", "Node.js", "SQL", "PostgreSQL"],
      preferredSkills: [],
    }), profile);

    expect(fit.classification).toBe("strong");
    expect(fit.strongMatches).toEqual([
      "Python",
      "React",
      "TypeScript",
      "JavaScript",
      "Node.js",
      "SQL",
      "PostgreSQL",
    ]);
    expect(fit.unsupportedRequiredQualifications).toEqual([]);
  });

  it("does not tokenize narrative profile text as a skill", () => {
    const profile = cloneExampleProfile();
    profile.skills = ["Built Python systems"];
    profile.employmentHistory = [];
    profile.projects = [];

    const fit = assessFit(canonicalPosting({
      requiredSkills: ["Python"],
      preferredSkills: [],
    }), profile);

    expect(fit.classification).toBe("weak");
    expect(fit.strongMatches).toEqual([]);
    expect(fit.unsupportedRequiredQualifications).toEqual(["Python"]);
  });

  it("tailors only verified material and keeps section provenance", () => {
    const job = canonicalPosting({ requiredSkills: ["AWS", "Kubernetes", "Go"] });
    const fit = assessFit(job, exampleCandidateProfile);
    const resume = tailorResume(job, exampleCandidateProfile, fit, capturedAt);
    const rendered = resume.sections
      .flatMap((section) => typeof section.content === "string" ? [section.content] : section.content)
      .join(" ");

    expect(resume.familyId).toBe("cloud-platform");
    expect(rendered).toContain("AWS");
    expect(rendered).not.toContain("Go");
    expect(resume.sections.every((section) => section.provenance.length > 0)).toBe(true);
    expect(resume.sections.find((section) => section.kind === "experience")?.content)
      .toEqual(exampleCandidateProfile.employmentHistory[0].bullets);
  });
});

describe("Application Agent answer policy", () => {
  it("honors AUTO, DRAFT_REVIEW, ASK, and NEVER_AUTO distinctly", async () => {
    const profile = cloneExampleProfile();
    const job = canonicalPosting();
    const fit = assessFit(job, profile);
    const resume = tailorResume(job, profile, fit, capturedAt);
    const answers = await prepareApplicationAnswers(
      job,
      profile,
      fit,
      resume,
      async (context) => buildDraftAnswer(context),
    );
    const byField = new Map(answers.map((answer) => [answer.field, answer]));

    expect(byField.get("name")).toMatchObject({ policy: "auto", status: "resolved", value: "Example Candidate" });
    expect(byField.get("why_company")).toMatchObject({ policy: "draft_review", status: "drafted" });
    expect(byField.get("why_company")?.provenance).toEqual(expect.arrayContaining(["job.company:Northstar Cloud"]));
    expect(byField.get("salary_expectations")).toMatchObject({ policy: "ask", status: "needs_input" });
    expect(byField.get("demographic_disclosure")).toMatchObject({ policy: "never_auto", status: "blocked" });

    const blockers = blockersFromAnswers(answers);
    expect(blockers.map((blocker) => blocker.field)).toEqual(expect.arrayContaining([
      "salary_expectations",
      "relocation",
      "travel",
      "sponsorship",
      "demographic_disclosure",
      "legal_attestations",
    ]));
    expect(DEFAULT_ANSWER_POLICIES.legal_attestations).toBe("never_auto");
  });

  it("uses an explicitly configured sponsorship fact without turning it into a guessed answer", async () => {
    const profile = cloneExampleProfile();
    profile.workAuthorization = {
      status: "authorized",
      countries: ["United States"],
      sponsorshipRequired: false,
    };
    profile.answerPolicies = {
      ...profile.answerPolicies,
      sponsorship: "auto",
    };
    const job = canonicalPosting();
    const fit = assessFit(job, profile);
    const resume = tailorResume(job, profile, fit, capturedAt);
    const answers = await prepareApplicationAnswers(
      job,
      profile,
      fit,
      resume,
      async (context) => buildDraftAnswer(context),
    );
    const sponsorship = answers.find((answer) => answer.field === "sponsorship");

    expect(sponsorship).toMatchObject({
      policy: "auto",
      status: "resolved",
      value: "No",
      provenance: ["profile:workAuthorization.sponsorshipRequired"],
    });
    expect(blockersFromAnswers(answers).some((blocker) => blocker.field === "sponsorship")).toBe(false);
  });
});

describe("Application Agent lifecycle, events, and persistence", () => {
  it("prepares a packet, surfaces blockers, reaches ready_for_review only after explicit input, and never submits", async () => {
    const repository = new InMemoryApplicationRepository();
    const service = new ApplicationService(
      repository,
      cloneExampleProfile(),
      undefined,
      runtime(),
    );

    let application = await service.prepareFromIntake({ ...postingInput, isExample: true });
    expect(application.status).toBe("needs_input");
    expect(application.isExample).toBe(true);
    expect(application.fit).not.toBeNull();
    expect(application.resume?.familyId).toBe("cloud-platform");
    expect(application.blockers.length).toBeGreaterThan(0);

    for (const blocker of application.blockers.filter((candidate) => candidate.status === "open")) {
      application = service.resolveHumanField(application.id, blocker.id, `Explicit answer for ${blocker.field}`);
    }

    expect(application.status).toBe("ready_for_review");
    expect(application.blockers.every((blocker) => blocker.status === "resolved")).toBe(true);
    await expect(service.submitApplication(application.id, {
      approved: true,
      approvedAt: capturedAt,
    })).rejects.toBeInstanceOf(SubmissionDisabledError);
    expect(service.getApplication(application.id).status).toBe("ready_for_review");

    const eventTypes = service.listEvents(application.id).map((event) => event.type);
    expect(eventTypes).toEqual([
      "application.created",
      "application.evaluated",
      "application.prepared",
      "application.needs_input",
      "application.ready_for_review",
    ]);
  });

  it("allows career-only demographic controls to reopen under the aggregate application blocker", async () => {
    const repository = new InMemoryApplicationRepository();
    const service = new ApplicationService(repository, cloneExampleProfile(), undefined, runtime());
    let application = await service.prepareFromIntake({ ...postingInput, isExample: true });
    for (const blocker of application.blockers.filter((candidate) => candidate.status === "open")) {
      application = service.resolveHumanField(application.id, blocker.id, `Explicit answer for ${blocker.field}`);
    }
    const reopened = service.reopenFieldsForManualHandoff(application.id, ["430", "431", "gdpr_demographic_data_consent_given_1"]);
    expect(reopened.status).toBe("ready_for_review");
    expect(reopened.blockers.every((blocker) => blocker.status === "resolved")).toBe(true);
    expect(reopened.blockers.find((blocker) => blocker.field === "demographic_disclosure")?.value).toBe("Explicit answer for demographic_disclosure");
    expect(() => service.reopenFieldsForManualHandoff(application.id, ["unknown-browser-field"]))
      .toThrow("A requested manual field is missing or not resolved.");
  });

  it("round-trips independent application records and events through replaceable storage", () => {
    const storage = new MapStorage();
    const repository = new LocalStorageApplicationRepository(storage);
    const first: Application = {
      id: "application-one",
      isExample: false,
      job: canonicalPosting(),
      fit: null,
      resume: null,
      answers: [],
      blockers: [],
      status: "discovered",
      createdAt: capturedAt,
      updatedAt: capturedAt,
    };
    const second: Application = { ...first, id: "application-two", job: canonicalPosting({ company: "Other Cloud" }) };
    const event: ApplicationEvent = createApplicationEvent(
      first.id,
      "application.created",
      { now: () => capturedAt, createId: () => "event-one" },
    );

    repository.saveApplication(first);
    repository.saveApplication(second);
    repository.appendEvent(event);

    const reloaded = new LocalStorageApplicationRepository(storage);
    expect(reloaded.listApplications()).toHaveLength(2);
    expect(reloaded.getApplication(first.id)).toEqual(first);
    expect(reloaded.getApplication(second.id)?.job.company).toBe("Other Cloud");
    expect(reloaded.listEvents(first.id)).toEqual([event]);
    expect(JSON.parse(storage.getItem(APPLICATIONS_STORAGE_KEY) ?? "null")).toHaveLength(2);
    expect(JSON.parse(storage.getItem(EVENTS_STORAGE_KEY) ?? "null")).toHaveLength(1);
    expect(isApplication(reloaded.getApplication(first.id))).toBe(true);
  });
});
