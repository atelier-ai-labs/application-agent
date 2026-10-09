import { loadEnv } from "vite";
import { createConfiguredBackgroundCareerAgentRuntime } from "./careerAgentRuntime";

const loaded = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
for (const [key, value] of Object.entries(loaded)) if (process.env[key] === undefined) process.env[key] = value;

const campaignId = process.env.ATELIER_CAREER_AGENT_CAMPAIGN_ID?.trim();
const jobId = process.env.ATELIER_CAREER_AGENT_JOB_ID?.trim();
const applicationId = process.env.ATELIER_CAREER_AGENT_APPLICATION_ID?.trim();
if (!campaignId || !jobId || !applicationId) throw new Error("Campaign, job, and application IDs are required.");

const runtime = createConfiguredBackgroundCareerAgentRuntime(process.env);
const storage = runtime.stateStorage;
if (!storage || !("withExclusiveLockAsync" in storage) || typeof storage.withExclusiveLockAsync !== "function") {
  throw new Error("The configured runtime must use file-backed state for tracker retries.");
}
const result = await storage.withExclusiveLockAsync(async () => {
  const job = runtime.service.getJob(jobId);
  if (job.campaignId !== campaignId || job.applicationId !== applicationId || job.status !== "applied" || !job.manualSubmissionConfirmation) {
    throw new Error("The IDs do not match an explicitly confirmed applied job.");
  }
  if (job.trackerSync?.status !== "failed") throw new Error("The tracker is not awaiting a retry.");
  return runtime.service.retryTrackerSync(campaignId, jobId);
});
console.log(`[career-agent-tracker] ${jobId}: ${result.trackerSync?.status ?? "unavailable"}`);
