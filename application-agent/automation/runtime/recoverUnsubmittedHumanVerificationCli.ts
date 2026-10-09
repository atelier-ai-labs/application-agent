import { loadEnv } from "vite";
import { createConfiguredBackgroundCareerAgentRuntime } from "./careerAgentRuntime";

const loaded = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
for (const [key, value] of Object.entries(loaded)) if (process.env[key] === undefined) process.env[key] = value;

const campaignId = process.env.ATELIER_CAREER_AGENT_CAMPAIGN_ID?.trim();
const jobId = process.env.ATELIER_CAREER_AGENT_JOB_ID?.trim();
const applicationId = process.env.ATELIER_CAREER_AGENT_APPLICATION_ID?.trim();
const reason = process.env.ATELIER_CAREER_AGENT_CORRECTION_REASON?.trim();
if (!campaignId || !jobId || !applicationId) {
  throw new Error("ATELIER_CAREER_AGENT_CAMPAIGN_ID, ATELIER_CAREER_AGENT_JOB_ID, and ATELIER_CAREER_AGENT_APPLICATION_ID are required.");
}
if (process.env.ATELIER_CAREER_AGENT_CONFIRMED_NOT_SUBMITTED?.trim().toLowerCase() !== "true") {
  throw new Error("Set ATELIER_CAREER_AGENT_CONFIRMED_NOT_SUBMITTED=true to record the explicit user assertion.");
}
if (!reason || reason.length < 10) {
  throw new Error("ATELIER_CAREER_AGENT_CORRECTION_REASON must explain the no-submission assertion in at least 10 characters.");
}

const runtime = createConfiguredBackgroundCareerAgentRuntime(process.env);
const storage = runtime.stateStorage;
if (!storage || !("withExclusiveLockAsync" in storage) || typeof storage.withExclusiveLockAsync !== "function") {
  throw new Error("The configured runtime must use file-backed state for recovery commands.");
}
const recovered = await storage.withExclusiveLockAsync(() => runtime.recoverUnsubmittedHumanVerification(
  campaignId,
  jobId,
  applicationId,
  { confirmedNotSubmitted: true, reason },
));
console.log(`[career-agent-recovery] recorded no-submission assertion for ${applicationId}; current status ${recovered.status}; no browser action performed`);
