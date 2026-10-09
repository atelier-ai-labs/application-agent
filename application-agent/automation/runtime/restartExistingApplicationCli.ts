import { loadEnv } from "vite";
import { createConfiguredBackgroundCareerAgentRuntime } from "./careerAgentRuntime";

const loaded = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
for (const [key, value] of Object.entries(loaded)) if (process.env[key] === undefined) process.env[key] = value;

const campaignId = process.env.ATELIER_CAREER_AGENT_CAMPAIGN_ID?.trim();
const jobId = process.env.ATELIER_CAREER_AGENT_JOB_ID?.trim();
const applicationId = process.env.ATELIER_CAREER_AGENT_APPLICATION_ID?.trim();
if (!campaignId || !jobId || !applicationId) {
  throw new Error("ATELIER_CAREER_AGENT_CAMPAIGN_ID, ATELIER_CAREER_AGENT_JOB_ID, and ATELIER_CAREER_AGENT_APPLICATION_ID are required.");
}

const runtime = createConfiguredBackgroundCareerAgentRuntime(process.env);
const storage = runtime.stateStorage;
if (!storage || !("withExclusiveLockAsync" in storage) || typeof storage.withExclusiveLockAsync !== "function") {
  throw new Error("The configured runtime must use file-backed state for restart commands.");
}
const corrected = await storage.withExclusiveLockAsync(() =>
  runtime.restartExistingApplication(campaignId, jobId, applicationId),
);
console.log(`[career-agent-restart] restarted existing application ${applicationId}; current status ${corrected.status}`);
