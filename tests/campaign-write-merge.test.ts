// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { CareerAgentService, exampleCandidateProfile } from "../application-agent/src";
import { LocalStorageCareerRepository, mergeCampaignWrite } from "../application-agent/src/persistence/careerRepository";
import { SqliteKeyValueStorage } from "../application-agent/automation/runtime/sqliteKeyValueStorage";
import { attentionEventForCareerBlocker, type PersistedAttentionEvent } from "../application-agent/src/domain/attention";
import type { Campaign } from "../application-agent/src/domain/campaignTypes";

const at = "2026-11-17T20:27:14.000Z";
let counter = 0;
function question(id: string, campaignId = "campaign-1", jobId = "career-job-twilio"): PersistedAttentionEvent {
  const created = attentionEventForCareerBlocker({
    campaignId, jobId, createdAt: at, createId: () => `unused-${(counter += 1)}`,
    blocker: {
      id: "career-blocker-guidelines", kind: "unknown_form_field", unit: "submission", questionProvenance: "ATS_FORM", field: "ack2",
      status: "open", createdAt: at, question: "Acknowledge", reason: "r", resumeAfterHuman: true,
      context: { jobId, applicationId: "application-twilio", company: "Twilio", role: "Software Engineer L3" },
      evidence: ["field-id:ack2", "field-type:checkbox", "field-label:Acknowledge", "question-prompt:By checking this box, I confirm I have read the Candidate AI Responsible Use Policy."],
    },
  })!;
  return { ...created.record, id };
}

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function campaignIn(repository: LocalStorageCareerRepository): Campaign {
  const service = new CareerAgentService({ ...exampleCandidateProfile }, { careerRepository: repository }, { now: () => at, createId: (prefix) => `${prefix}-1` });
  return service.createCampaign({
    name: "Merge", goal: "Keep every question.", searchSources: [],
    searchCriteria: { roleLanes: [], searchQueries: [], locations: [], remoteOnly: false, employmentTypes: [], excludedSeniorities: [], excludedCompanies: [] },
    applicationPolicy: { autoPrepare: true, allowGroundedDrafts: false, approvedResumeFamilies: [] },
    submissionPolicy: { authority: "never", requireExplicitApproval: false }, dailyApplicationLimit: 3,
  });
}

describe("saving a campaign keeps questions another writer added (Twilio, 2026-11-17)", () => {
  it("keeps both questions when two writers save from the same starting copy", () => {
    const dir = mkdtempSync(join(tmpdir(), "campaign-merge-")); directories.push(dir);
    const listener = new LocalStorageCareerRepository(new SqliteKeyValueStorage(join(dir, "state.db")));
    const boardLoop = new LocalStorageCareerRepository(new SqliteKeyValueStorage(join(dir, "state.db")));
    const created = campaignIn(listener);
    if (!listener.getCampaign(created.id)) listener.saveCampaign(created);
    const listenerCopy = listener.getCampaign(created.id)!;
    const boardCopy = boardLoop.getCampaign(created.id)!;
    listener.saveCampaign({ ...listenerCopy, attentionEvents: [...(listenerCopy.attentionEvents ?? []), question("attention-next-question", created.id)] });
    boardLoop.saveCampaign({ ...boardCopy, attentionEvents: [...(boardCopy.attentionEvents ?? []), question("attention-replacement", created.id)] });
    expect(listener.getCampaign(created.id)!.attentionEvents!.map((event) => event.id)).toEqual(["attention-next-question", "attention-replacement"]);
  });

  it("never reopens an answered question from an older copy, and keeps its Slack delivery", () => {
    const base = { id: "campaign-1" } as Campaign;
    const posted = { ...question("q1"), publishedAt: at, providerDelivery: { provider: "slack" as const, channelId: "C1", messageTs: "1.1" } };
    const answered = { ...posted, status: "resolved" as const, resolvedAt: at };
    expect(mergeCampaignWrite({ ...base, attentionEvents: [answered] }, { ...base, attentionEvents: [posted] }).attentionEvents).toEqual([answered]);
    const unpublishedCopy = question("q1");
    expect(mergeCampaignWrite({ ...base, attentionEvents: [posted] }, { ...base, attentionEvents: [unpublishedCopy] }).attentionEvents![0])
      .toMatchObject({ publishedAt: at, providerDelivery: { messageTs: "1.1" } });
    expect(mergeCampaignWrite({ ...base, attentionEvents: [posted] }, { ...base, attentionEvents: [answered] }).attentionEvents).toEqual([answered]);
  });
});
