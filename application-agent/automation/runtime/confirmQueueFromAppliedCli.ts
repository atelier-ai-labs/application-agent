import { loadEnv } from "vite";
import { GoogleSheetsJobQueue } from "../googleSheetsJobQueue";
import { createConfiguredGoogleSheetsTransport } from "../googleSheetsJobTracker";
import { createConfiguredBackgroundCareerAgentRuntime } from "./careerAgentRuntime";

const loaded = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
for (const [key, value] of Object.entries(loaded)) if (process.env[key] === undefined) process.env[key] = value;

const campaignId = process.env.ATELIER_CAREER_AGENT_CAMPAIGN_ID?.trim();
const jobId = process.env.ATELIER_CAREER_AGENT_JOB_ID?.trim();
const applicationId = process.env.ATELIER_CAREER_AGENT_APPLICATION_ID?.trim();
const queueJobId = process.env.ATELIER_CAREER_AGENT_QUEUE_JOB_ID?.trim();
const spreadsheetId = process.env.ATELIER_GOOGLE_SHEET_ID?.trim();
const spreadsheetName = process.env.ATELIER_GOOGLE_SHEET_NAME?.trim();
if (!campaignId || !jobId || !applicationId || !queueJobId || !spreadsheetId || !spreadsheetName) throw new Error("Exact career, queue, and spreadsheet IDs are required.");

const runtime = createConfiguredBackgroundCareerAgentRuntime(process.env);
const job = runtime.service.getJob(jobId);
const application = runtime.service.getApplication(applicationId);
if (job.campaignId !== campaignId || job.applicationId !== applicationId || job.status !== "applied" || application.status !== "applied" || !job.manualSubmissionConfirmation || !application.manualSubmissionConfirmation) {
  throw new Error("The career job and application lack matching successful manual confirmation.");
}
const queue = new GoogleSheetsJobQueue({ spreadsheetId, spreadsheetName, sheetTab: process.env.ATELIER_GOOGLE_SHEET_QUEUE_TAB?.trim() || "Application Queue", timeoutMs: 10_000 }, createConfiguredGoogleSheetsTransport(process.env));
const current = await queue.get(queueJobId);
if (current.company !== job.job.company || current.role !== job.job.title) throw new Error("The queue role does not match the confirmed career job.");
if (current.status !== "Confirmed") {
  await queue.update(queueJobId, { status: "Confirmed", confirmationEvidence: `User observed Ashby confirmation: application successfully submitted (${job.manualSubmissionConfirmation.confirmedAt})`, lastError: "" });
}
console.log(`[career-agent-queue] ${queueJobId}: Confirmed`);
