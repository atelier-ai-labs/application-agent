import { loadEnv } from "vite";
import { createConfiguredBackgroundCareerAgentRuntime } from "./careerAgentRuntime";

const loaded = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
for (const [key, value] of Object.entries(loaded)) if (process.env[key] === undefined) process.env[key] = value;

const campaignId = process.env.ATELIER_CAREER_AGENT_CAMPAIGN_ID?.trim();
const jobId = process.env.ATELIER_CAREER_AGENT_JOB_ID?.trim();
const applicationId = process.env.ATELIER_CAREER_AGENT_APPLICATION_ID?.trim();
if (!campaignId || !jobId || !applicationId) {
  throw new Error("Campaign, job, and application IDs are required.");
}
if (process.env.ATELIER_CAREER_AGENT_CONFIRMED_MESSAGE !== "Your application was successfully submitted. We'll contact you if there are next steps.") {
  throw new Error("The exact successful Ashby confirmation message is required.");
}

const runtime = createConfiguredBackgroundCareerAgentRuntime(process.env);
const storage = runtime.stateStorage;
if (!storage || !("withExclusiveLockAsync" in storage) || typeof storage.withExclusiveLockAsync !== "function") {
  throw new Error("The configured runtime must use file-backed state for confirmation commands.");
}
const applied = await storage.withExclusiveLockAsync(async () => {
  const job = runtime.service.getJob(jobId);
  if (job.campaignId !== campaignId || job.applicationId !== applicationId) {
    throw new Error("The campaign, job, and application IDs do not match.");
  }
  return runtime.confirmManualApplication(campaignId, jobId);
});
console.log(`[career-agent-confirmation] ${jobId}: ${applied.status}; tracker ${applied.trackerSync?.status ?? "unavailable"}`);
