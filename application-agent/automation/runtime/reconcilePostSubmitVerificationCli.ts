import { loadEnv } from "vite";
import { HttpExecutionHostClient } from "../../src/service/executionHostClient";
import { createConfiguredBackgroundCareerAgentRuntime } from "./careerAgentRuntime";
import { assertPostSubmitVerificationSnapshot } from "./reconcilePostSubmitVerification";
import { assertTrustedExecutionHostBaseUrl } from "./submitPreparedApplicationPreflight";

const loaded = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
for (const [key, value] of Object.entries(loaded)) if (process.env[key] === undefined) process.env[key] = value;

const campaignId = process.env.ATELIER_CAREER_AGENT_CAMPAIGN_ID?.trim();
const jobId = process.env.ATELIER_CAREER_AGENT_JOB_ID?.trim();
const applicationId = process.env.ATELIER_CAREER_AGENT_APPLICATION_ID?.trim();
const executionId = process.env.ATELIER_CAREER_AGENT_EXECUTION_ID?.trim();
if (!campaignId || !jobId || !applicationId || !executionId) {
  throw new Error("Campaign, job, application, and execution IDs are required.");
}
const baseUrl = process.env.ATELIER_EXECUTION_HOST_BASE_URL?.trim();
if (!baseUrl) throw new Error("ATELIER_EXECUTION_HOST_BASE_URL is required.");
assertTrustedExecutionHostBaseUrl(baseUrl);

const runtime = createConfiguredBackgroundCareerAgentRuntime({ ...process.env, ATELIER_EXECUTION_HOST_BASE_URL: baseUrl });
const storage = runtime.stateStorage;
if (!storage || !("withExclusiveLockAsync" in storage) || typeof storage.withExclusiveLockAsync !== "function") {
  throw new Error("The configured runtime must use file-backed state for reconciliation commands.");
}
const host = new HttpExecutionHostClient({ baseUrl });

const reconciled = await storage.withExclusiveLockAsync(async () => {
  const job = runtime.service.getJob(jobId);
  if (job.campaignId !== campaignId || job.applicationId !== applicationId || job.execution?.hostExecutionId !== executionId) {
    throw new Error("The persisted campaign, job, application, and execution IDs do not match.");
  }
  const snapshot = await host.get(executionId);
  assertPostSubmitVerificationSnapshot(snapshot, { campaignId, jobId, applicationId, executionId });
  return runtime.service.recordExecutionHostSnapshot(campaignId, jobId, snapshot);
});

// Publish through the configured Slack adapter without starting the runtime
// continuation loop. Starting the full runtime could resume unrelated resolved
// attention events; this recovery path must never resume or retry a submit.
await runtime.service.publishNextAttentionEvent(campaignId, jobId);
console.log(`[career-agent-reconcile] ${executionId}: ${reconciled.status}; target-job Slack attention published`);
