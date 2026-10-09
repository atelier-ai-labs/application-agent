import { loadEnv } from "vite";
import {
  createConfiguredBackgroundCareerAgentRuntime,
  type RuntimeNotificationTransport,
} from "./careerAgentRuntime";

const localEnv = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
for (const [key, value] of Object.entries(localEnv)) {
  if (process.env[key] === undefined) process.env[key] = value;
}

const runtime = createConfiguredBackgroundCareerAgentRuntime(process.env);
const internal = runtime as typeof runtime & { notification?: RuntimeNotificationTransport };
const notification = internal.notification;
if (!notification?.start) throw new Error("The configured Slack transport is unavailable.");

// For this one live test, start Socket Mode without publishing unrelated
// durable attention events or replaying unrelated browser continuations.
await notification.hydrate?.(
  runtime.careerRepository.listCampaigns().flatMap((campaign) => campaign.attentionEvents ?? []),
);
await notification.start();
console.log("[career-agent-slack] live-test response listener is active; no pending attention was published.");

const shutdown = async () => {
  await notification.stop?.();
  process.exit(0);
};
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
