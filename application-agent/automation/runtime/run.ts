import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv } from "vite";
import {
  createConfiguredBackgroundCareerAgentRuntime,
  type BackgroundCareerAgentEnvironment,
} from "./careerAgentRuntime";

// Keep server-side runtime configuration in the same local env files as the
// existing Node host, while explicit shell variables retain precedence.
const localEnv = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
for (const [key, value] of Object.entries(localEnv)) {
  if (process.env[key] === undefined) process.env[key] = value;
}

let runtime: ReturnType<typeof createConfiguredBackgroundCareerAgentRuntime> | undefined;
let shuttingDown = false;

function booleanValue(value: string | undefined, fallback: boolean, label: string): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${label} must be true or false.`);
}

async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await runtime?.stop();
  process.exitCode = exitCode;
}

try {
  runtime = createConfiguredBackgroundCareerAgentRuntime(process.env as BackgroundCareerAgentEnvironment);
  await runtime.start();

  let campaignId = process.env.ATELIER_CAREER_AGENT_CAMPAIGN_ID?.trim() || undefined;
  if (!campaignId && booleanValue(process.env.ATELIER_CAREER_AGENT_CREATE_CAMPAIGN, false, "ATELIER_CAREER_AGENT_CREATE_CAMPAIGN")) {
    const input = runtime.defaultCampaignInput;
    if (!input) throw new Error("The configured runtime has no default live campaign input.");
    const campaign = runtime.createCampaign(input);
    campaignId = campaign.id;
    console.log(`[career-agent-runtime] created campaign ${campaign.id} in durable local state`);
  }

  const dailyHuntFile = process.env.ATELIER_CAREER_AGENT_DAILY_HUNT_FILE?.trim();
  if (dailyHuntFile) {
    if (!campaignId) {
      throw new Error("ATELIER_CAREER_AGENT_CAMPAIGN_ID is required when ATELIER_CAREER_AGENT_DAILY_HUNT_FILE is set.");
    }
    const campaign = runtime.service.getCampaign(campaignId);
    if (campaign.status === "draft") runtime.service.activateCampaign(campaignId);
    let message: string;
    try {
      message = readFileSync(resolve(dailyHuntFile), "utf8");
    } catch {
      throw new Error("The configured Daily job hunt file could not be read.");
    }
    const result = await runtime.processDailyHuntMessage(campaignId, message);
    console.log(`[career-agent-runtime] daily hunt processed: ${result.processed} accepted, ${result.skipped} skipped`);
    if (booleanValue(process.env.ATELIER_CAREER_AGENT_EXIT_AFTER_DAILY_HUNT, false, "ATELIER_CAREER_AGENT_EXIT_AFTER_DAILY_HUNT")) {
      await shutdown(0);
      process.exit(0);
    }
  }

  if (booleanValue(process.env.ATELIER_CAREER_AGENT_RUN_ON_START, false, "ATELIER_CAREER_AGENT_RUN_ON_START")) {
    if (!campaignId) {
      throw new Error("ATELIER_CAREER_AGENT_CAMPAIGN_ID is required when ATELIER_CAREER_AGENT_RUN_ON_START=true.");
    }
    const campaign = runtime.service.getCampaign(campaignId);
    if (campaign.status === "draft") runtime.service.activateCampaign(campaignId);
    const result = await runtime.runCampaign(campaignId);
    console.log(`[career-agent-runtime] campaign ${campaignId} completed: ${result.attentionRequired} item(s) need attention`);
  }

  console.log(`[career-agent-runtime] durable state: ${runtime.stateFilePath ?? "injected storage"}`);
  console.log("[career-agent-runtime] Slack attention listener is active; routine discovery activity remains quiet.");
  process.once("SIGINT", () => { void shutdown(0); });
  process.once("SIGTERM", () => { void shutdown(0); });
} catch (error) {
  const message = error instanceof Error ? error.message : "The background Career Agent runtime could not start.";
  console.error(`[career-agent-runtime] ${message}`);
  await shutdown(1);
}
