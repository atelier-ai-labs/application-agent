import { describe, expect, it } from "vitest";
import { attentionEventForCareerBlocker, isPersistedAttentionEvent } from "../application-agent/src/domain/attention";
import { LocalStorageCareerRepository } from "../application-agent/src/persistence/careerRepository";
import type { CareerBlocker } from "../application-agent/src/domain/campaignTypes";
import { CareerAgentService } from "../application-agent/src/service/careerAgentService";
import {
  ApplicationService, DeterministicModelClient, InMemoryApplicationRepository, InMemoryJobTracker, JobScout,
  SimulatedApplicationExecutor, exampleCandidateProfile,
} from "../application-agent/src";
import type { KeyValueStorage } from "../application-agent/src/persistence/storage";

class MemoryStorage implements KeyValueStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

// Latitude AI (2026-11-10): a multiple-choice human check, asked every minute.
const humanCheck: CareerBlocker = {
  id: "blocker-latitude",
  kind: "subjective_answer",
  unit: "submission",
  questionProvenance: "ATS_FORM",
  field: "question_70303357",
  question: "Human verification: Which of the following is not a primary color?*",
  reason: "A required field is still empty after the safe fill pass.",
  evidence: [
    "executor:greenhouse-browser", "field-id:question_70303357", "field-type:select", "field-required:true",
    "classification:unknown", "options:Red|Purple|Yellow|Blue",
    "question-prompt:Human verification: Which of the following is not a primary color?*", "question-source:aria_labelledby", "question-confidence:high",
  ],
  resumeAfterHuman: true,
  context: { jobId: "job-latitude", applicationId: "application-latitude", company: "Latitude AI", role: "Software Engineer II" },
  status: "open",
  createdAt: "2026-11-09T22:39:08.448Z",
} as CareerBlocker;
const wrongDraft = { answer: "The primary colors are red, blue, and green.", evidence: ["Mapped resume — Verified skills"], provider: "ollama" as const };

describe("drafts only on free-text questions", () => {
  it("leaves the draft off a multiple-choice question, so the saved question stays valid", () => {
    const generated = attentionEventForCareerBlocker({
      campaignId: "campaign-1", jobId: "job-latitude", blocker: humanCheck, draft: wrongDraft,
      createdAt: humanCheck.createdAt, createId: (prefix) => `${prefix}-1`,
    })!;
    expect(generated.record.question?.kind).toBe("single_choice");
    expect(generated.record.draft).toBeUndefined();
    expect(isPersistedAttentionEvent(generated.record)).toBe(true);
  });

  it("keeps a saved question whose only problem is its draft", () => {
    const generated = attentionEventForCareerBlocker({
      campaignId: "campaign-1", jobId: "job-latitude", blocker: humanCheck,
      createdAt: humanCheck.createdAt, createId: (prefix) => `${prefix}-1`,
    })!;
    const stale = { ...generated.record, draft: wrongDraft };
    expect(isPersistedAttentionEvent(stale)).toBe(false);
    const storage = new MemoryStorage();
    const repository = new LocalStorageCareerRepository(storage);
    let sequence = 0;
    const clock = { now: () => "2026-11-10T12:00:00.000Z", createId: (prefix: string) => `${prefix}-${++sequence}` };
    const applicationService = new ApplicationService(new InMemoryApplicationRepository(), exampleCandidateProfile, new DeterministicModelClient(), clock);
    const campaign = new CareerAgentService(exampleCandidateProfile, {
      applicationService, careerRepository: repository, scout: new JobScout({}, clock.now),
      executor: new SimulatedApplicationExecutor(), tracker: new InMemoryJobTracker(),
    }, clock).createCampaign({
      name: "Draft fit", goal: "Keep questions.", searchSources: [], searchCriteria: { roleLanes: ["engineer"], remoteOnly: true, employmentTypes: [] },
      applicationPolicy: { autoPrepare: true, allowGroundedDrafts: true, approvedResumeFamilies: [] },
      submissionPolicy: { authority: "never", requireExplicitApproval: false }, dailyApplicationLimit: 3,
    } as never);
    // An older build saved the question with its draft.
    const raw = JSON.parse(storage.getItem("atelier.application-agent.campaigns.v0")!);
    raw[0].attentionEvents = [stale];
    storage.setItem("atelier.application-agent.campaigns.v0", JSON.stringify(raw));
    const loaded = repository.getCampaign(campaign.id)!;
    expect(loaded.attentionEvents?.map((event) => event.id)).toEqual([generated.record.id]);
    expect(loaded.attentionEvents?.[0]?.draft).toBeUndefined();
  });
});
