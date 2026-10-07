import { loadEnv } from "vite";
import { createConfiguredBackgroundCareerAgentRuntime } from "./careerAgentRuntime";

const loaded = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
for (const [key, value] of Object.entries(loaded)) if (process.env[key] === undefined) process.env[key] = value;

const campaignId = process.env.ATELIER_CAREER_AGENT_CAMPAIGN_ID?.trim();
const jobId = process.env.ATELIER_CAREER_AGENT_JOB_ID?.trim();
if (!campaignId || !jobId) {
  throw new Error("ATELIER_CAREER_AGENT_CAMPAIGN_ID and ATELIER_CAREER_AGENT_JOB_ID are required.");
}

const runtime = createConfiguredBackgroundCareerAgentRuntime(process.env);
const storage = runtime.stateStorage;
if (!storage || !("withExclusiveLock" in storage) || typeof storage.withExclusiveLock !== "function") {
  throw new Error("The configured runtime must use file-backed state for correction commands.");
}

const reason = process.env.ATELIER_CAREER_AGENT_CORRECTION_REASON?.trim() ||
  "The manual submission confirmation was recorded in error; no application was submitted.";
const corrected = storage.withExclusiveLock(() =>
  runtime.correctFalseManualSubmissionConfirmation(campaignId, jobId, reason),
);
console.log(`[career-agent-correction] corrected ${jobId}; restored status ${corrected.status}`);
