import { describe, expect, it } from "vitest";
import {
  ApplicationService,
  DeterministicModelClient,
  InMemoryApplicationRepository,
  InMemoryCareerRepository,
  JobTracker,
  JobTrackerResult,
  CareerAgentService,
  exampleCandidateProfile,
  jobDedupeKeys,
  normalizeJobPosting,
  type CandidateProfile,
  type CareerJob,
  type JobTrackerSyncContext,
  type JobTrackerUpdate,
} from "../application-agent/src";

const at = "2026-08-31T15:30:00.000Z";

function privateProfile(): CandidateProfile {
  const profile = JSON.parse(JSON.stringify(exampleCandidateProfile)) as CandidateProfile;
  profile.profileKind = "private";
  profile.answerPolicies = Object.fromEntries(
    Object.keys(profile.answerPolicies).map((field) => [field, "auto"]),
  ) as CandidateProfile["answerPolicies"];
  profile.approvedReusableAnswers = {
    why_company: "Approved local answer.",
    cover_letter: "Approved local cover letter.",
    salary_expectations: "USD 150000",
    relocation: "No relocation required.",
    travel: "Up to 10% travel.",
    sponsorship: "No sponsorship required.",
    demographic_disclosure: "No disclosure.",
    legal_attestations: "Reviewed in local test.",
  };
  return profile;
}

class RecordingTracker implements JobTracker {
  readonly id = "recording-tracker";
  calls: Array<{ update: JobTrackerUpdate; context?: JobTrackerSyncContext }> = [];
  fail = false;

  async recordApplied(update: JobTrackerUpdate, context?: JobTrackerSyncContext): Promise<JobTrackerResult> {
    this.calls.push({ update, context });
    if (this.fail) return { ok: false, simulated: false, error: "Tracker unavailable." };
    return { ok: true, simulated: false, trackerRecordId: "row-2" };
  }
}

async function readyFixture(tracker: JobTracker = new RecordingTracker()) {
  const profile = privateProfile();
  const applicationRepository = new InMemoryApplicationRepository();
  const careerRepository = new InMemoryCareerRepository();
  const applicationService = new ApplicationService(applicationRepository, profile, new DeterministicModelClient(), {
    now: () => at,
    createId: (prefix) => `${prefix}-test`,
  });
  const service = new CareerAgentService(profile, {
    applicationService,
    careerRepository,
    tracker,
  }, {
    now: () => at,
    createId: (prefix) => `${prefix}-test`,
  });
  const campaign = service.createCampaign({
    name: "Manual tracker test",
    goal: "Confirm before recording downstream state.",
    searchSources: ["lever:acme"],
    searchCriteria: { roleLanes: [], locations: [], remoteOnly: false, employmentTypes: [] },
    submissionPolicy: { authority: "never", requireExplicitApproval: false },
  });
  const job = normalizeJobPosting({
    companyHint: "Acme Cloud",
    titleHint: "Cloud Platform Engineer",
    sourceUrl: "https://jobs.lever.co/acme/post-1",
    applicationUrl: "https://jobs.lever.co/acme/post-1/apply",
    rawText: "Acme Cloud\nCloud Platform Engineer\nLocation: Remote\n\nBuild cloud systems.\n\nRequired qualifications\n- Azure",
  }, at);
  const application = await applicationService.prepareFromNormalizedJob(job, false);
  const careerJob: CareerJob = {
    id: "career-job-test",
    campaignId: campaign.id,
    isExample: false,
    sourceMode: "live",
    actionability: "actionable",
    fingerprint: "source:lever:acme:id:post-1",
    sourceId: "lever:acme",
    sourceRecordId: "post-1",
    dedupeKeys: jobDedupeKeys(job, "post-1", "lever:acme"),
    job,
    discoveredAt: at,
    fit: application.fit,
    applicationId: application.id,
    status: "ready_to_submit",
    blockers: [],
    createdAt: at,
    updatedAt: at,
  };
  careerRepository.saveJob(careerJob);
  return { service, applicationService, careerRepository, campaign, careerJob, tracker };
}

describe("manual applied state and tracker sync", () => {
  it("does not write the tracker when a packet only reaches ready_to_submit", async () => {
    const tracker = new RecordingTracker();
    const fixture = await readyFixture(tracker);
    expect(fixture.applicationService.getApplication(fixture.careerJob.applicationId!).status).toBe("ready_for_review");
    expect(tracker.calls).toHaveLength(0);
    expect(fixture.service.getJob(fixture.careerJob.id).status).toBe("ready_to_submit");
  });

  it("requires explicit confirmation, applies first, then syncs the tracker", async () => {
    const tracker = new RecordingTracker();
    const fixture = await readyFixture(tracker);
    const applied = await fixture.service.confirmManualApplication(fixture.campaign.id, fixture.careerJob.id);

    expect(applied.status).toBe("applied");
    expect(applied.manualSubmissionConfirmation?.mode).toBe("manual");
    expect(applied.submissionProof).toBeUndefined();
    expect(applied.trackerSync).toMatchObject({ status: "synced", attempt: 1, trackerRecordId: "row-2", requestCount: 1, successCount: 1, failureCount: 0 });
    expect(fixture.applicationService.getApplication(fixture.careerJob.applicationId!).status).toBe("applied");
    expect(tracker.calls).toHaveLength(1);
    expect(tracker.calls[0].update.proofMode).toBe("manual");
    expect(tracker.calls[0].context?.applicationStatus).toBe("applied");

    const eventTypes = fixture.service.listEvents(fixture.campaign.id).map((event) => event.type);
    expect(eventTypes.indexOf("application.applied")).toBeGreaterThanOrEqual(0);
    expect(eventTypes.indexOf("application.applied")).toBeLessThan(eventTypes.indexOf("tracker.update_started"));
    expect(eventTypes.indexOf("tracker.update_started")).toBeLessThan(eventTypes.indexOf("tracker.updated"));
    expect(eventTypes).not.toContain("application.submitted");
  });

  it("keeps Applied truth when the tracker fails and retries only the downstream sync", async () => {
    const tracker = new RecordingTracker();
    tracker.fail = true;
    const fixture = await readyFixture(tracker);
    const failed = await fixture.service.confirmManualApplication(fixture.campaign.id, fixture.careerJob.id);
    expect(failed.status).toBe("applied");
    expect(failed.trackerSync).toMatchObject({ status: "failed", attempt: 1, requestCount: 1, successCount: 0, failureCount: 1 });
    expect(fixture.applicationService.getApplication(fixture.careerJob.applicationId!).status).toBe("applied");
    expect(fixture.service.snapshot(fixture.campaign.id).counts.needsYou).toBe(1);

    tracker.fail = false;
    const retried = await fixture.service.retryTrackerSync(fixture.campaign.id, fixture.careerJob.id);
    expect(retried.status).toBe("applied");
    expect(retried.trackerSync).toMatchObject({ status: "synced", attempt: 2, trackerRecordId: "row-2", requestCount: 1, successCount: 1, failureCount: 0 });
    expect(tracker.calls).toHaveLength(2);
    expect(fixture.service.listEvents(fixture.campaign.id).filter((event) => event.type === "application.applied")).toHaveLength(1);
    expect(fixture.service.listEvents(fixture.campaign.id).some((event) => event.type === "tracker.retry_started" && event.metadata?.attempt === "2")).toBe(true);
  });

  it("does not turn confirmation into a second application or a tracker write on idempotent retry", async () => {
    const tracker = new RecordingTracker();
    const fixture = await readyFixture(tracker);
    await fixture.service.confirmManualApplication(fixture.campaign.id, fixture.careerJob.id);
    const second = await fixture.service.confirmManualApplication(fixture.campaign.id, fixture.careerJob.id);
    expect(second.status).toBe("applied");
    expect(tracker.calls).toHaveLength(1);
    expect(fixture.service.listEvents(fixture.campaign.id).filter((event) => event.type === "application.applied")).toHaveLength(1);
  });
});
