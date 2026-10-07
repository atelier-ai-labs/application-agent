import { loadEnv } from "vite";
import { createConfiguredBackgroundCareerAgentRuntime } from "./careerAgentRuntime";
import { assertDuplicateRiskRetryAuthorization, assertSubmitPreparedApplicationPreflight, assertTrustedExecutionHostBaseUrl } from "./submitPreparedApplicationPreflight";
import { authorizeThenSubmit } from "./submitPreparedApplicationFlow";

const loaded = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
for (const [key, value] of Object.entries(loaded)) if (process.env[key] === undefined) process.env[key] = value;

const campaignId = process.env.ATELIER_CAREER_AGENT_CAMPAIGN_ID?.trim();
const jobId = process.env.ATELIER_CAREER_AGENT_JOB_ID?.trim();
const applicationId = process.env.ATELIER_CAREER_AGENT_APPLICATION_ID?.trim();
if (!campaignId || !jobId || !applicationId) {
  throw new Error("ATELIER_CAREER_AGENT_CAMPAIGN_ID, ATELIER_CAREER_AGENT_JOB_ID, and ATELIER_CAREER_AGENT_APPLICATION_ID are required.");
}
if (process.env.ATELIER_CAREER_AGENT_SUBMIT_APPROVAL !== "SUBMIT_APPLICATION") {
  throw new Error("Explicit submit approval is required: set ATELIER_CAREER_AGENT_SUBMIT_APPROVAL=SUBMIT_APPLICATION.");
}
const duplicateRiskApproval = process.env.ATELIER_CAREER_AGENT_DUPLICATE_RISK_APPROVAL?.trim();
const duplicateRiskReason = process.env.ATELIER_CAREER_AGENT_DUPLICATE_RISK_REASON?.trim();
const executionHostBaseUrl = process.env.ATELIER_EXECUTION_HOST_BASE_URL?.trim();
if (!executionHostBaseUrl) throw new Error("ATELIER_EXECUTION_HOST_BASE_URL is required for explicit submit.");
assertTrustedExecutionHostBaseUrl(executionHostBaseUrl);

const runtime = createConfiguredBackgroundCareerAgentRuntime({
  ...process.env,
  ATELIER_EXECUTION_HOST_BASE_URL: executionHostBaseUrl,
});
const storage = runtime.stateStorage;
if (!storage || !("withExclusiveLockAsync" in storage) || typeof storage.withExclusiveLockAsync !== "function") {
  throw new Error("The configured runtime must use file-backed state for submit commands.");
}

// Validate the exact target and consume the explicit duplicate-risk
// authorization while holding the state lock. The browser call must happen
// after the lock is released because the host claims the same fence file.
const submitted = await authorizeThenSubmit(storage.withExclusiveLockAsync.bind(storage), () => {
  const job = runtime.service.getJob(jobId);
  const application = runtime.getApplication(applicationId);
  assertSubmitPreparedApplicationPreflight({
    campaignId,
    jobId,
    applicationId,
    job,
    application,
    executionHostBaseUrl,
  });
  const fence = runtime.getSubmissionFence(applicationId, jobId);
  assertDuplicateRiskRetryAuthorization(fence?.state, duplicateRiskApproval, duplicateRiskReason);
  if (fence?.state === "unknown") {
    runtime.authorizeDuplicateRiskRetry(campaignId, jobId, { confirmedRisk: true, reason: duplicateRiskReason! });
  }
}, () => runtime.submitPreparedApplication(campaignId, jobId));
console.log(`[career-agent-submit] ${applicationId}: ${submitted.status}`);
