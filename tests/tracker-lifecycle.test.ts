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
  type ExecutionHostSnapshot,
  type JobTrackerSyncContext,
  type JobTrackerUpdate,
} from "../application-agent/src";
import { DurableSubmissionAuthority } from "../application-agent/automation/executionHost/submissionAuthority";

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
  return { service, applicationService, applicationRepository, careerRepository, campaign, careerJob, tracker };
}

describe("manual applied state and tracker sync", () => {
  it("does not write the tracker when a packet only reaches ready_to_submit", async () => {
    const tracker = new RecordingTracker();
    const fixture = await readyFixture(tracker);
    expect(fixture.applicationService.getApplication(fixture.careerJob.applicationId!).status).toBe("ready_for_review");
    expect(tracker.calls).toHaveLength(0);
    expect(fixture.service.getJob(fixture.careerJob.id).status).toBe("ready_to_submit");
  });

  it("does not let a stale host snapshot downgrade an Applied packet", async () => {
    const tracker = new RecordingTracker();
    const fixture = await readyFixture(tracker);
    const applied = await fixture.service.confirmManualApplication(fixture.campaign.id, fixture.careerJob.id);
    const staleSnapshot: ExecutionHostSnapshot = {
      id: "stale-host-session",
      mode: "real_local",
      campaignId: fixture.campaign.id,
      jobId: fixture.careerJob.id,
      applicationId: fixture.careerJob.applicationId!,
      status: "ready_to_submit",
      startedAt: at,
      updatedAt: at,
    };

    const persisted = await fixture.service.recordExecutionHostSnapshot(
      fixture.campaign.id,
      fixture.careerJob.id,
      staleSnapshot,
    );

    expect(persisted.status).toBe("applied");
    expect(fixture.service.getApplication(fixture.careerJob.applicationId!).status).toBe("applied");
    expect(tracker.calls).toHaveLength(1);
    expect(fixture.service.listEvents(fixture.campaign.id).filter((event) => event.type === "application.applied")).toHaveLength(1);
    expect(applied.manualSubmissionConfirmation).toEqual(persisted.manualSubmissionConfirmation);
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

  it("can explicitly retract a false manual confirmation without creating submission proof", async () => {
    const tracker = new RecordingTracker();
    const fixture = await readyFixture(tracker);
    await fixture.service.confirmManualApplication(fixture.campaign.id, fixture.careerJob.id);

    const corrected = fixture.service.correctFalseManualSubmissionConfirmation(
      fixture.campaign.id,
      fixture.careerJob.id,
      "The candidate confirmed that the application was not submitted.",
    );

    expect(corrected.status).toBe("ready_to_submit");
    expect(corrected.manualSubmissionConfirmation).toBeUndefined();
    expect(corrected.submissionProof).toBeUndefined();
    expect(corrected.trackerSync).toBeUndefined();
    expect(fixture.applicationService.getApplication(fixture.careerJob.applicationId!).status).toBe("ready_for_review");
    expect(fixture.applicationService.getApplication(fixture.careerJob.applicationId!).manualSubmissionConfirmation).toBeUndefined();
    expect(tracker.calls).toHaveLength(1);
    expect(fixture.service.listEvents(fixture.campaign.id).some((event) =>
      event.type === "application.failed" && event.metadata?.correction === "manual_submission_confirmation_retracted",
    )).toBe(true);
  });

  it("repairs a stale ready-to-submit job with a leftover manual confirmation", async () => {
    const tracker = new RecordingTracker();
    const fixture = await readyFixture(tracker);
    await fixture.service.confirmManualApplication(fixture.campaign.id, fixture.careerJob.id);
    const application = fixture.applicationService.getApplication(fixture.careerJob.applicationId!);
    fixture.applicationRepository.saveApplication({ ...application, status: "ready_for_review" });
    const job = fixture.service.getJob(fixture.careerJob.id);
    fixture.careerRepository.saveJob({ ...job, status: "ready_to_submit" });

    const corrected = fixture.service.correctFalseManualSubmissionConfirmation(fixture.campaign.id, fixture.careerJob.id);

    expect(corrected.status).toBe("ready_to_submit");
    expect(corrected.manualSubmissionConfirmation).toBeUndefined();
    expect(fixture.applicationService.getApplication(fixture.careerJob.applicationId!).status).toBe("ready_for_review");
    expect(fixture.applicationService.getApplication(fixture.careerJob.applicationId!).manualSubmissionConfirmation).toBeUndefined();
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

  it("confirms the same unknown automatic submission only with its durable fence", async () => {
    const tracker = new RecordingTracker();
    const fixture = await readyFixture(tracker);
    const blocker = { id: "submission-confirmation", kind: "external_verification" as const, unit: "submission" as const, field: "submission-confirmation", questionProvenance: "POLICY" as const, question: "Verify whether the application was submitted", context: { jobId: fixture.careerJob.id, applicationId: fixture.careerJob.applicationId, company: fixture.careerJob.job.company, role: fixture.careerJob.job.title }, reason: "Unknown result", evidence: ["submit:clicked"], status: "open" as const, createdAt: at, resumeAfterHuman: false };
    fixture.careerRepository.saveJob({ ...fixture.careerJob, status: "needs_input", blockers: [blocker] });
    const authority = new DurableSubmissionAuthority("test-worker", { stateFile: `/tmp/atelier-manual-confirm-${fixture.careerJob.id}-${Math.random().toString(36).slice(2)}.json` });
    const fence = authority.claim(fixture.careerJob.applicationId!, fixture.careerJob.id, at);
    authority.beforeClick(fence, at);
    authority.markUnknown(fence, at);
    const applied = await fixture.service.confirmManualApplication(fixture.campaign.id, fixture.careerJob.id, authority);
    expect(applied.status).toBe("applied");
    expect(applied.manualSubmissionConfirmation?.mode).toBe("manual");
    expect(applied.blockers.find((candidate) => candidate.id === blocker.id)?.status).toBe("resolved");
    expect(authority.reconcile(fixture.careerJob.applicationId!, fixture.careerJob.id).state).toBe("submitted");
  });

  it("recovers a CAPTCHA-stopped submission only after an explicit no-submission assertion", async () => {
    const fixture = await readyFixture(new RecordingTracker());
    const blocker = { id: "submission-confirmation", kind: "external_verification" as const, unit: "submission" as const, field: "submission-confirmation", questionProvenance: "POLICY" as const, question: "Verify whether the application was submitted", context: { jobId: fixture.careerJob.id, applicationId: fixture.careerJob.applicationId, company: fixture.careerJob.job.company, role: fixture.careerJob.job.title }, reason: "CAPTCHA stopped the click", evidence: ["submit:clicked", "external-verification:captcha"], status: "open" as const, createdAt: at, resumeAfterHuman: false };
    fixture.careerRepository.saveJob({ ...fixture.careerJob, status: "needs_input", blockers: [blocker] });
    const authority = new DurableSubmissionAuthority("test-worker", { stateFile: `/tmp/atelier-recover-${fixture.careerJob.id}-${Math.random().toString(36).slice(2)}.json` });
    const fence = authority.claim(fixture.careerJob.applicationId!, fixture.careerJob.id, at);
    authority.beforeClick(fence, at);
    authority.markUnknown(fence, at);

    const recovered = await fixture.service.recoverUnsubmittedHumanVerification(
      fixture.campaign.id,
      fixture.careerJob.id,
      fixture.careerJob.applicationId!,
      authority,
      { confirmedNotSubmitted: true, reason: "User confirmed the CAPTCHA stopped submission before receipt." },
    );
    expect(recovered.status).toBe("ready_to_submit");
    expect(recovered.blockers[0].status).toBe("resolved");
    expect(fixture.applicationService.getApplication(fixture.careerJob.applicationId!).status).toBe("ready_for_review");
    expect(authority.get(fixture.careerJob.applicationId!, fixture.careerJob.id)?.state).toBe("recovered");
    expect(authority.get(fixture.careerJob.applicationId!, fixture.careerJob.id)?.recovery?.confirmedNotSubmitted).toBe(true);
  });

  it("recovers an already-reopened ready execution without changing or restarting the retained host", async () => {
    const fixture = await readyFixture();
    const blocker = { id: "submission-confirmation", kind: "external_verification" as const, unit: "submission" as const, field: "submission-confirmation", questionProvenance: "POLICY" as const, question: "Verify whether the application was submitted", context: { jobId: fixture.careerJob.id, applicationId: fixture.careerJob.applicationId, company: fixture.careerJob.job.company, role: fixture.careerJob.job.title }, reason: "Unknown result", evidence: ["submit:clicked", "confirmation:not-detected"], status: "resolved" as const, createdAt: at, resolvedAt: at, resumeAfterHuman: false };
    const execution = { status: "ready_to_submit" as const, mode: "real_local" as const, hostExecutionId: "execution-retained", fieldsDetected: [], fieldsFilled: [], unresolvedFields: [], evidence: ["execution-host:real_local", "submit:not-clicked"], startedAt: at, updatedAt: at };
    const attention = { id: "attention-stale", type: "needs_input" as const, source: "career-agent" as const, campaignId: fixture.campaign.id, jobId: fixture.careerJob.id, applicationId: fixture.careerJob.applicationId, createdAt: at, status: "open" as const, title: "Verify submission", context: { company: fixture.careerJob.job.company, role: fixture.careerJob.job.title }, blockerId: blocker.id, descriptorSignature: "submission-confirmation" };
    fixture.careerRepository.saveJob({ ...fixture.careerJob, status: "ready_to_submit", blockers: [blocker], execution });
    fixture.careerRepository.saveCampaign({ ...fixture.campaign, attentionEvents: [attention] });
    const authority = new DurableSubmissionAuthority("test-worker", { stateFile: `/tmp/atelier-reopened-recovery-${Math.random().toString(36).slice(2)}.json` });
    const fence = authority.claim(fixture.careerJob.applicationId!, fixture.careerJob.id, at);
    authority.beforeClick(fence, at);
    authority.markUnknown(fence, at);

    const recovered = await fixture.service.recoverUnsubmittedHumanVerification(
      fixture.campaign.id, fixture.careerJob.id, fixture.careerJob.applicationId!, authority,
      { confirmedNotSubmitted: true, reason: "User confirmed the employer did not receive this submission." },
    );
    expect(recovered.status).toBe("ready_to_submit");
    expect(recovered.execution).toEqual(execution);
    expect(recovered.blockers[0]).toMatchObject({ status: "resolved" });
    expect(fixture.service.listEvents(fixture.campaign.id).at(-1)).toMatchObject({ type: "application.execution_resumed", metadata: { recovery: "user_asserted_not_submitted_after_reopened_human_verification" } });
    expect(fixture.careerRepository.listCampaigns()[0].attentionEvents?.[0].status).toBe("cancelled");
    expect(authority.get(fixture.careerJob.applicationId!, fixture.careerJob.id)?.state).toBe("recovered");
  });

  it("rejects reopened recovery without the retained ready execution or positive no-click evidence", async () => {
    const makeCase = async (execution: CareerJob["execution"]) => {
      const fixture = await readyFixture();
      const blocker = { id: "submission-confirmation", kind: "external_verification" as const, unit: "submission" as const, field: "submission-confirmation", questionProvenance: "POLICY" as const, question: "Verify whether the application was submitted", context: { jobId: fixture.careerJob.id, applicationId: fixture.careerJob.applicationId, company: fixture.careerJob.job.company, role: fixture.careerJob.job.title }, reason: "Unknown result", evidence: ["submit:clicked"], status: "resolved" as const, createdAt: at, resolvedAt: at, resumeAfterHuman: false };
      fixture.careerRepository.saveJob({ ...fixture.careerJob, status: "ready_to_submit", blockers: [blocker], execution });
      const authority = new DurableSubmissionAuthority("test-worker", { stateFile: `/tmp/atelier-reopened-negative-${Math.random().toString(36).slice(2)}.json` });
      const fence = authority.claim(fixture.careerJob.applicationId!, fixture.careerJob.id, at);
      authority.beforeClick(fence, at);
      authority.markUnknown(fence, at);
      await expect(fixture.service.recoverUnsubmittedHumanVerification(fixture.campaign.id, fixture.careerJob.id, fixture.careerJob.applicationId!, authority, { confirmedNotSubmitted: true, reason: "User confirmed the employer did not receive this submission." })).rejects.toThrow(/needs-input job|exact reopened/);
    };
    await makeCase(undefined);
    await makeCase({ status: "ready_to_submit", mode: "real_local", hostExecutionId: "execution-retained", fieldsDetected: [], fieldsFilled: [], unresolvedFields: [], evidence: ["execution-host:real_local"], startedAt: at, updatedAt: at });
  });

  it("retains consumed duplicate-risk authorization across no-submission recovery and permits only one fresh fence", () => {
    const authority = new DurableSubmissionAuthority("test-worker", { stateFile: `/tmp/atelier-consumed-risk-${Math.random().toString(36).slice(2)}.json` });
    const applicationId = "application-consumed-risk";
    const jobId = "job-consumed-risk";
    const first = authority.claim(applicationId, jobId, at);
    authority.beforeClick(first, at);
    authority.markUnknown(first, at);
    const authorized = authority.authorizeDuplicateRiskRetry(applicationId, jobId, {
      confirmedRisk: true,
      reason: "User accepts the possibility of a duplicate submission.",
    }, at);
    const retry = authority.claim(applicationId, jobId, at);
    expect(retry.token).not.toBe(first.token);
    expect(retry.duplicateRiskRetryAuthorization).toEqual(authorized.duplicateRiskRetryAuthorization);
    authority.beforeClick(retry, at);
    authority.markUnknown(retry, at);

    const recovered = authority.recoverUnknownForFreshAttempt(applicationId, jobId, {
      confirmedNotSubmitted: true,
      reason: "User confirmed the employer did not receive this submission.",
    }, at);
    expect(recovered.state).toBe("recovered");
    expect(recovered.duplicateRiskRetryAuthorization).toEqual(authorized.duplicateRiskRetryAuthorization);

    const fresh = authority.claim(applicationId, jobId, at);
    expect(fresh.token).not.toBe(retry.token);
    authority.beforeClick(fresh, at);
    expect(() => authority.claim(applicationId, jobId, at)).toThrow(/cannot be submitted automatically again/);
  });

  it("resumes the same recovery after a crash between fence and job cleanup", async () => {
    const fixture = await readyFixture();
    const blocker = { id: "submission-confirmation", kind: "external_verification" as const, unit: "submission" as const, field: "submission-confirmation", questionProvenance: "POLICY" as const, question: "Verify whether the application was submitted", context: { jobId: fixture.careerJob.id, applicationId: fixture.careerJob.applicationId, company: fixture.careerJob.job.company, role: fixture.careerJob.job.title }, reason: "CAPTCHA stopped the click", evidence: ["submit:clicked", "external-verification:captcha"], status: "open" as const, createdAt: at, resumeAfterHuman: false };
    fixture.careerRepository.saveJob({ ...fixture.careerJob, status: "needs_input", blockers: [blocker] });
    const attention = { id: "attention-crash-recovery", type: "needs_input" as const, source: "career-agent" as const, campaignId: fixture.campaign.id, jobId: fixture.careerJob.id, applicationId: fixture.careerJob.applicationId, createdAt: at, status: "open" as const, title: "Verify submission", context: { company: fixture.careerJob.job.company, role: fixture.careerJob.job.title }, blockerId: blocker.id, descriptorSignature: "submission-confirmation" };
    fixture.careerRepository.saveCampaign({ ...fixture.campaign, attentionEvents: [attention] });
    const authority = new DurableSubmissionAuthority("test-worker", { stateFile: `/tmp/atelier-recover-crash-${fixture.careerJob.id}-${Math.random().toString(36).slice(2)}.json` });
    const fence = authority.claim(fixture.careerJob.applicationId!, fixture.careerJob.id, at);
    authority.beforeClick(fence, at);
    authority.markUnknown(fence, at);
    const assertion = { confirmedNotSubmitted: true as const, reason: "User confirmed the CAPTCHA stopped submission before receipt." };
    const originalSaveCampaign = fixture.careerRepository.saveCampaign.bind(fixture.careerRepository);
    let failOnce = true;
    fixture.careerRepository.saveCampaign = ((campaign) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("injected crash after durable fence recovery");
      }
      originalSaveCampaign(campaign);
    }) as typeof fixture.careerRepository.saveCampaign;

    await expect(fixture.service.recoverUnsubmittedHumanVerification(fixture.campaign.id, fixture.careerJob.id, fixture.careerJob.applicationId!, authority, assertion)).rejects.toThrow("injected crash");
    const recoveredFence = authority.get(fixture.careerJob.applicationId!, fixture.careerJob.id)!;
    expect(recoveredFence.state).toBe("recovered");
    const recoveryAudit = recoveredFence.recovery;
    expect(fixture.service.getJob(fixture.careerJob.id).status).toBe("needs_input");

    const retried = await fixture.service.recoverUnsubmittedHumanVerification(fixture.campaign.id, fixture.careerJob.id, fixture.careerJob.applicationId!, authority, assertion);
    expect(retried.status).toBe("ready_to_submit");
    expect(authority.get(fixture.careerJob.applicationId!, fixture.careerJob.id)?.recovery).toEqual(recoveryAudit);
    expect(fixture.careerRepository.listCampaigns()[0].attentionEvents?.[0].status).toBe("cancelled");
    expect(fixture.service.getJob(fixture.careerJob.id).blockers[0].status).toBe("resolved");
  });

  it("rejects unknown recovery when the blocker, state, fence, or existing proof is not exact", async () => {
    const makeUnknown = async () => {
      const fixture = await readyFixture();
      const blocker = { id: "submission-confirmation", kind: "external_verification" as const, unit: "submission" as const, field: "submission-confirmation", questionProvenance: "POLICY" as const, question: "Verify whether the application was submitted", context: { jobId: fixture.careerJob.id, applicationId: fixture.careerJob.applicationId, company: fixture.careerJob.job.company, role: fixture.careerJob.job.title }, reason: "Unknown result", evidence: ["submit:clicked"], status: "open" as const, createdAt: at, resumeAfterHuman: false };
      fixture.careerRepository.saveJob({ ...fixture.careerJob, status: "needs_input", blockers: [blocker] });
      const authority = new DurableSubmissionAuthority("test-worker", { stateFile: `/tmp/atelier-manual-negative-${Math.random().toString(36).slice(2)}.json` });
      const fence = authority.claim(fixture.careerJob.applicationId!, fixture.careerJob.id, at);
      authority.beforeClick(fence, at);
      authority.markUnknown(fence, at);
      return { fixture, authority, blocker };
    };

    const wrongFence = await makeUnknown();
    expect(() => wrongFence.authority.confirmManual(
      { ...wrongFence.authority.get(wrongFence.fixture.careerJob.applicationId!, wrongFence.fixture.careerJob.id)!, token: "wrong-token" },
      "user-confirmed",
      at,
    )).toThrow();
    await expect(wrongFence.fixture.service.confirmManualApplication(
      wrongFence.fixture.campaign.id,
      wrongFence.fixture.careerJob.id,
      new DurableSubmissionAuthority("other-worker", { stateFile: "/tmp/atelier-manual-missing-fence.json" }),
    )).rejects.toThrow(/fence/);

    const wrongBlocker = await makeUnknown();
    wrongBlocker.fixture.careerRepository.saveJob({ ...wrongBlocker.fixture.careerJob, status: "needs_input", blockers: [{ ...wrongBlocker.blocker, field: "different-field" }] });
    await expect(wrongBlocker.fixture.service.confirmManualApplication(wrongBlocker.fixture.campaign.id, wrongBlocker.fixture.careerJob.id, wrongBlocker.authority)).rejects.toThrow(/prepared or explicitly unknown/);

    const wrongState = await makeUnknown();
    wrongState.fixture.applicationRepository.saveApplication({ ...wrongState.fixture.applicationService.getApplication(wrongState.fixture.careerJob.applicationId!), status: "applied" });
    await expect(wrongState.fixture.service.confirmManualApplication(wrongState.fixture.campaign.id, wrongState.fixture.careerJob.id, wrongState.authority)).rejects.toThrow(/ready for review/);

    for (const proofField of ["jobSubmissionProof", "jobManualConfirmation", "applicationSubmissionProof", "applicationManualConfirmation"] as const) {
      const existing = await makeUnknown();
      const proof = { mode: "external" as const, provider: "test", externalApplicationId: "existing", submittedAt: at, evidence: "existing" };
      const manual = { mode: "manual" as const, confirmedAt: at, evidence: "user_confirmed_successful_manual_submission" as const };
      if (proofField === "jobSubmissionProof" || proofField === "jobManualConfirmation") {
        existing.fixture.careerRepository.saveJob({ ...existing.fixture.careerJob, status: "needs_input", blockers: [existing.blocker], ...(proofField === "jobSubmissionProof" ? { submissionProof: proof } : { manualSubmissionConfirmation: manual }) });
      } else {
        const application = existing.fixture.applicationService.getApplication(existing.fixture.careerJob.applicationId!);
        existing.fixture.applicationRepository.saveApplication({ ...application, ...(proofField === "applicationSubmissionProof" ? { submissionProof: proof } : { manualSubmissionConfirmation: manual }) });
      }
      await expect(existing.fixture.service.confirmManualApplication(existing.fixture.campaign.id, existing.fixture.careerJob.id, existing.authority)).rejects.toThrow(/existing proof/);
      expect(existing.authority.reconcile(existing.fixture.careerJob.applicationId!, existing.fixture.careerJob.id).state).toBe("needs_input");
    }
  });

  it("reopens only a pre-launch submission-authority blocker for preparation-only execution", async () => {
    const fixture = await readyFixture();
    const blocker = { id: "submission-authority", kind: "submission_approval" as const, unit: "submission" as const, field: "submission-authority", questionProvenance: "CONFIGURATION" as const, question: "Enable automatic submission", reason: "Host configuration", evidence: ["submit:not-clicked"], context: { jobId: fixture.careerJob.id, applicationId: fixture.careerJob.applicationId, company: fixture.careerJob.job.company, role: fixture.careerJob.job.title }, status: "open" as const, createdAt: at, resumeAfterHuman: true };
    fixture.careerRepository.saveJob({ ...fixture.careerJob, status: "needs_input", blockers: [blocker], execution: { status: "needs_input", mode: "real_local", hostExecutionId: "blocked-before-launch", fieldsDetected: [], fieldsFilled: [], unresolvedFields: [], evidence: ["execution-host:real_local", "submit:not-clicked"], boundaries: { browserLaunched: false }, startedAt: at, updatedAt: at } });
    const authority = new DurableSubmissionAuthority("prep-worker", { stateFile: `/tmp/atelier-prep-recovery-${Math.random().toString(36).slice(2)}.json` });
    const resumed = fixture.service.resumePreparationOnlyConfigurationBlocker(fixture.campaign.id, fixture.careerJob.id, authority);
    expect(resumed.status).toBe("preparing");
    expect(resumed.execution).toMatchObject({ status: "not_started" });
    expect(resumed.execution?.hostExecutionId).toBeUndefined();
    expect(resumed.blockers[0]).toMatchObject({ status: "resolved", value: "preparation_only_host_override" });

    const rejected = await readyFixture();
    rejected.careerRepository.saveJob({ ...rejected.careerJob, status: "needs_input", blockers: [blocker], execution: { status: "needs_input", mode: "real_local", fieldsDetected: [], fieldsFilled: [], unresolvedFields: [], evidence: ["submit:not-clicked"], boundaries: { browserLaunched: true }, startedAt: at, updatedAt: at } });
    await expect(Promise.resolve().then(() => rejected.service.resumePreparationOnlyConfigurationBlocker(rejected.campaign.id, rejected.careerJob.id, new DurableSubmissionAuthority("prep-worker", { stateFile: `/tmp/atelier-prep-recovery-${Math.random().toString(36).slice(2)}.json` })))).rejects.toThrow(/browser never launched/);
  });
});
