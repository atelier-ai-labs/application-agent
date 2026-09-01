import { loadEnv } from "vite";
import { resolveSlackConfig, SlackConfigurationError } from "./config";
import { SlackNotificationAdapter } from "./slackNotificationAdapter";

const localEnv = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
for (const [key, value] of Object.entries(localEnv)) {
  if (process.env[key] === undefined) process.env[key] = value;
}

try {
  const adapter = new SlackNotificationAdapter({
    config: resolveSlackConfig(process.env),
  });
  await adapter.start();
  console.log("[career-agent-slack] Socket Mode listener started; no routine activity notifications are enabled.");
  console.log("[career-agent-slack] A Career Agent runtime must inject the response handler; no answer is applied by this transport alone.");
  const shutdown = () => {
    adapter.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error) {
  const message = error instanceof SlackConfigurationError
    ? error.message
    : "The Career Agent Slack listener could not start; credentials and responses were not sent.";
  console.error(`[career-agent-slack] ${message}`);
  process.exitCode = 1;
}
