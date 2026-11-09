import { describe, expect, it } from "vitest";
import {
  ApplicationService, CareerAgentService, DeterministicModelClient, InMemoryApplicationRepository, InMemoryCareerRepository,
  InMemoryNotificationAdapter, UnavailableApplicationExecutor, exampleCandidateProfile,
  type CandidateProfile, type JobIntakeInput,
} from "../application-agent/src";

const capturedAt = "2026-11-09T15:30:00.000Z";
const posting: JobIntakeInput = {
  companyHint: "Mercury", titleHint: "Software Engineer - Product",
  sourceUrl: "https://job-boards.greenhouse.io/mercury/jobs/6101145004", applicationUrl: "https://job-boards.greenhouse.io/mercury/jobs/6101145004",
  rawText: "Mercury\nSoftware Engineer - Product\nLocation: Remote - United States\nEmployment type: Full-time\n\nBuild product features in TypeScript and React.\n\nRequired qualifications\n- TypeScript\n- React\n",
};

function setup() {
  const profile = JSON.parse(JSON.stringify(exampleCandidateProfile)) as CandidateProfile;
  // Like Nate's profile: authorization is known, so only the five generic placeholders remain.
  profile.workAuthorization = { status: "authorized", countries: ["United States"], sponsorshipRequired: false };
  profile.answerPolicies = { ...profile.answerPolicies, sponsorship: "auto" };
  const notifications = new InMemoryNotificationAdapter();
  let id = 0;
  const createId = (prefix: string) => `${prefix}-ph-${(id += 1)}`;
  const service = new CareerAgentService(profile, {
    applicationService: new ApplicationService(new InMemoryApplicationRepository(), profile, new DeterministicModelClient(), { now: () => capturedAt, createId }),
    careerRepository: new InMemoryCareerRepository(), executor: new UnavailableApplicationExecutor(), notificationAdapter: notifications,
  }, { now: () => capturedAt, createId });
  const campaign = service.createCampaign({
    name: "Placeholders", goal: "Apply.", searchSources: [], searchCriteria: { roleLanes: [], remoteOnly: false, employmentTypes: [] },
    fitPolicy: { strong: "pursue", good: "pursue", stretch: "pursue", weak: "pursue" },
    applicationPolicy: { autoPrepare: true, allowGroundedDrafts: false, approvedResumeFamilies: [] },
    submissionPolicy: { authority: "never", requireExplicitApproval: false }, dailyApplicationLimit: 5,
  });
  service.activateCampaign(campaign.id);
  return { service, campaign, notifications };
}

const placeholderPrompts = ["Expected compensation", "Willingness to relocate", "Travel requirements", "Demographic disclosure", "Legal attestations"];
const asked = (notifications: InMemoryNotificationAdapter) => notifications.publishedEvents
  .flatMap((event) => [event.question?.prompt, ...(event.batch ?? []).map((item) => item.prompt)])
  .filter((prompt): prompt is string => placeholderPrompts.includes(prompt ?? ""));

describe("generic preparation placeholders", () => {
  it("are not posted to Slack for a queue job, whose real form questions replace them", async () => {
    const queued = setup();
    const job = await queued.service.processCuratedJob(queued.campaign.id, { ...posting, queueSelected: true });
    expect(job.blockers.some((blocker) => blocker.status === "open" && blocker.field === "legal_attestations")).toBe(true);
    expect(asked(queued.notifications)).toEqual([]);

    // Outside the queue they are still the real questions, so they are asked.
    const direct = setup();
    await direct.service.processCuratedJob(direct.campaign.id, posting);
    expect(asked(direct.notifications).length).toBeGreaterThan(0);
  });
});
