import { loadEnv } from "vite";
import { createConfiguredBackgroundCareerAgentRuntime } from "./careerAgentRuntime";

const loaded = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
for (const [key, value] of Object.entries(loaded)) if (process.env[key] === undefined) process.env[key] = value;

const campaignId = process.env.ATELIER_CAREER_AGENT_CAMPAIGN_ID?.trim();
const jobId = process.env.ATELIER_CAREER_AGENT_JOB_ID?.trim();
const applicationId = process.env.ATELIER_CAREER_AGENT_APPLICATION_ID?.trim();
const eventId = process.env.ATELIER_CAREER_AGENT_EVENT_ID?.trim();
const selectedOption = process.env.ATELIER_CAREER_AGENT_SELECTED_OPTION?.trim();
if (!campaignId || !jobId || !applicationId || !eventId || !selectedOption) {
  throw new Error(
    "ATELIER_CAREER_AGENT_CAMPAIGN_ID, ATELIER_CAREER_AGENT_JOB_ID, ATELIER_CAREER_AGENT_APPLICATION_ID, ATELIER_CAREER_AGENT_EVENT_ID, and ATELIER_CAREER_AGENT_SELECTED_OPTION are required.",
  );
}

const runtime = createConfiguredBackgroundCareerAgentRuntime(process.env);
const storage = runtime.stateStorage;
if (!storage || !("withExclusiveLockAsync" in storage) || typeof storage.withExclusiveLockAsync !== "function") {
  throw new Error("The configured runtime must use file-backed state for attention recovery.");
}

const result = await storage.withExclusiveLockAsync(async () => {
  const campaign = runtime.service.getCampaign(campaignId);
  const job = runtime.service.getJob(jobId);
  const event = campaign?.attentionEvents?.find((candidate) => candidate.id === eventId);
  if (!campaign || !job || !event) throw new Error("The exact campaign, job, or attention event was not found.");
  if (event.jobId !== jobId || event.applicationId !== applicationId) {
    throw new Error("The attention event does not belong to the exact campaign, job, and application supplied.");
  }
  if (event.status !== "open") throw new Error("The attention event is not open.");
  if (campaign.submissionPolicy.authority !== "never") {
    throw new Error("Attention recovery is fail-closed unless the persisted campaign submission authority is never.");
  }
  if (!event.question || event.question.kind !== "single_choice") {
    throw new Error("The attention event is not a single-choice question.");
  }
  const option = event.question.options.find((candidate) => candidate.id === selectedOption || candidate.label === selectedOption);
  if (!option) throw new Error("The selected option is not an exact option on the attention event.");
  const response = await runtime.service.resolveAttentionResponse({
    eventId,
    selectedOption: option.id,
    actorIdentity: { provider: "manual-recovery", userId: "local-recovery" },
    respondedAt: new Date().toISOString(),
  });
  return response.status;
});

console.log(`[career-agent-attention-recovery] resolved ${eventId}; status ${result}`);
