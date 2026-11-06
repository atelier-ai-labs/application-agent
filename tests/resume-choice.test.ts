import { describe, expect, it } from "vitest";
import {
  ApplicationService, CareerAgentService, DeterministicModelClient, InMemoryApplicationRepository, InMemoryCareerRepository,
  InMemoryNotificationAdapter, UnavailableApplicationExecutor, exampleCandidateProfile,
  type CandidateProfile, type JobIntakeInput,
} from "../application-agent/src";
import { ResumeFamilyTieError, assessFit } from "../application-agent/src/domain/fit";
import { normalizeJobPosting } from "../application-agent/src/domain/job";
import { isPersistedAttentionEvent } from "../application-agent/src/domain/attention";
import { applyResumeChoiceToSheets } from "../application-agent/automation/resumeChoiceSheets";
import type { GoogleSheetValueRange } from "../application-agent/automation/googleSheetsJobTracker";

const capturedAt = "2026-11-06T22:30:00.000Z";

/** Two résumés that a posting naming "golang" and "svelte" matches equally. */
function tiedProfile(): CandidateProfile {
  const profile = JSON.parse(JSON.stringify(exampleCandidateProfile)) as CandidateProfile;
  profile.resumeFamilies = profile.resumeFamilies
    .filter((family) => family.id === "cloud-platform" || family.id === "frontend-software")
    .map((family) => ({ ...family, focusKeywords: family.id === "cloud-platform" ? ["golang"] : ["svelte"] }));
  return profile;
}

const posting: JobIntakeInput = {
  companyHint: "Span", titleHint: "Software Engineer",
  sourceUrl: "https://jobs.ashbyhq.com/span.app/0709", applicationUrl: "https://jobs.ashbyhq.com/span.app/0709/application",
  rawText: "Span\nSoftware Engineer\nLocation: Remote - United States\nEmployment type: Full-time\n\nBuild services in golang and svelte.\n\nRequired qualifications\n- Python\n",
};

function setup() {
  const profile = tiedProfile();
  const notifications = new InMemoryNotificationAdapter();
  const careerRepository = new InMemoryCareerRepository();
  let id = 0;
  const createId = (prefix: string) => `${prefix}-tie-${(id += 1)}`;
  const service = new CareerAgentService(profile, {
    applicationService: new ApplicationService(new InMemoryApplicationRepository(), profile, new DeterministicModelClient(), { now: () => capturedAt, createId }),
    careerRepository, executor: new UnavailableApplicationExecutor(), notificationAdapter: notifications,
  }, { now: () => capturedAt, createId });
  const campaign = service.createCampaign({
    name: "Tie", goal: "Pick a résumé.", searchSources: [], searchCriteria: { roleLanes: [], remoteOnly: false, employmentTypes: [] },
    fitPolicy: { strong: "pursue", good: "pursue", stretch: "pursue", weak: "pursue" },
    applicationPolicy: { autoPrepare: true, allowGroundedDrafts: false, approvedResumeFamilies: [] },
    submissionPolicy: { authority: "simulated", requireExplicitApproval: false }, dailyApplicationLimit: 5,
  });
  service.activateCampaign(campaign.id);
  return { service, campaign, notifications, careerRepository };
}

const tap = (eventId: string, option: string) => ({ eventId, selectedOption: option, actorIdentity: { provider: "slack", userId: "nate" }, respondedAt: capturedAt });

describe("résumé ties", () => {
  it("are broken by the tracker's Resume Version, and only ties are", () => {
    const profile = tiedProfile();
    const job = normalizeJobPosting(posting, capturedAt);
    expect(() => assessFit(job, profile)).toThrow(ResumeFamilyTieError);
    try { assessFit(job, profile); } catch (error) { expect((error as ResumeFamilyTieError).tiedFamilies).toEqual(["cloud-platform", "frontend-software"]); }
    expect(assessFit(job, profile, { preferredResumeFamily: "frontend-software" }).recommendedResumeFamily).toBe("frontend-software");
    // A hint outside the tie does not settle it.
    expect(() => assessFit(job, profile, { preferredResumeFamily: "ai-platform-agentic" })).toThrow(ResumeFamilyTieError);
    // A clear winner ignores the hint.
    const clear = normalizeJobPosting({ ...posting, rawText: posting.rawText.replace("golang and svelte", "golang") }, capturedAt);
    expect(assessFit(clear, profile).recommendedResumeFamily).toBe("cloud-platform");
    expect(assessFit(clear, profile, { preferredResumeFamily: "frontend-software" }).recommendedResumeFamily).toBe("cloud-platform");
  });

  it("hold the job and ask once in Slack; a tap records the résumé and the next run uses it", async () => {
    const { service, campaign, notifications, careerRepository } = setup();
    const held = await service.processCuratedJob(campaign.id, { ...posting, queueSelected: true });
    expect(held.status).toBe("held");
    expect(held.decisionReason).toMatch(/^Résumé choice needed/);
    // The queue worker keeps a held job in Needs Input unless its reason reads as a policy skip.
    expect(held.decisionReason).not.toMatch(/location|fit|policy|contract|1099|freelance|task-based|unsupported|not eligible/i);
    const asked = notifications.publishedEvents.filter((event) => event.type === "resume_choice");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.question?.options.map((option) => option.id)).toEqual(["cloud-platform", "frontend-software"]);
    const stored = careerRepository.getCampaign(campaign.id)?.attentionEvents?.find((event) => event.id === asked[0]!.id);
    expect(stored && isPersistedAttentionEvent(stored)).toBe(true);

    // Seeing the job again before the tap does not ask a second time.
    await service.processCuratedJob(campaign.id, { ...posting, queueSelected: true });
    expect(notifications.publishedEvents.filter((event) => event.type === "resume_choice")).toHaveLength(1);

    const result = await service.resolveAttentionResponse(tap(asked[0]!.id, "frontend-software"));
    expect(result.status).toBe("resolved");
    expect(result.careerJob.queueResumeFamily).toBe("frontend-software");
    expect(result.event.answerUsed).toBe("Frontend / Software");
    expect((await service.resolveAttentionResponse(tap(asked[0]!.id, "frontend-software"))).status).toBe("duplicate");
    await expect(service.resolveAttentionResponse(tap(asked[0]!.id, "cloud-platform"))).rejects.toThrow(/different choice/);

    // The runtime writes the choice to the Sheet; the next run passes it back as the Resume Version.
    const next = await service.processCuratedJob(campaign.id, { ...posting, queueSelected: true, resumeFamily: "frontend-software" });
    expect(next.status).not.toBe("held");
    expect(next.fit?.recommendedResumeFamily).toBe("frontend-software");
  });

  it("need no question when the Resume Version already names one of them", async () => {
    const { service, campaign, notifications } = setup();
    const job = await service.processCuratedJob(campaign.id, { ...posting, queueSelected: true, resumeFamily: "cloud-platform" });
    expect(job.status).not.toBe("held");
    expect(job.fit?.recommendedResumeFamily).toBe("cloud-platform");
    expect(notifications.publishedEvents.filter((event) => event.type === "resume_choice")).toHaveLength(0);
  });

  it("write the choice to the tracker and queue rows and put the queue row back to Ready", async () => {
    const writes: GoogleSheetValueRange[] = [];
    const rows = [
      ["Company", "Role", "Job Link", "Status", "Resume Version"],
      ["Other", "Engineer", "https://x.invalid/1", "Researching", "cloud-platform"],
      ["Span", "Software Engineer", "https://jobs.ashbyhq.com/Span.app/0709", "Researching", "agentic-ai"],
    ];
    const transport = {
      getSpreadsheetMetadata: async () => ({ spreadsheetId: "s", title: "T", sheets: [] }),
      getValues: async () => rows,
      updateValues: async (_id: string, data: readonly GoogleSheetValueRange[]) => { writes.push(...data); return { updatedCells: data.length }; },
    };
    const calls: unknown[] = [];
    const queue = {
      list: async () => [
        { jobId: "q-span", company: "Span", role: "Software Engineer", jobLink: "https://jobs.ashbyhq.com/span.app/0709/application", status: "Needs Input" },
        { jobId: "q-done", company: "Span", role: "Software Engineer", jobLink: "https://jobs.ashbyhq.com/span.app/0709", status: "Confirmed" },
      ] as never,
      enrich: async (jobId: string, context: unknown) => { calls.push(["enrich", jobId, context]); return {} as never; },
      update: async (jobId: string, update: unknown) => { calls.push(["update", jobId, update]); return {} as never; },
    };
    const note = await applyResumeChoiceToSheets({
      transport, spreadsheetId: "s", trackerTab: "Job Tracker", queue, company: "Span", role: "Software Engineer",
      links: ["https://jobs.ashbyhq.com/span.app/0709/application"], resumeFamily: "frontend-software",
    });
    expect(note).toBe("queued for the next run");
    expect(writes).toEqual([{ range: "'Job Tracker'!E3", values: [["frontend-software"]] }]);
    expect(calls).toEqual([
      ["enrich", "q-span", { resumeVersion: "frontend-software" }],
      ["update", "q-span", { status: "Ready", lastError: "", workerId: "", leaseUntil: "", attemptId: "" }],
    ]);
  });
});
