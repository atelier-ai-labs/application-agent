import { loadEnv } from "vite";
import { runStandaloneJobQueueCommand } from "./standaloneJobQueue";

const loaded = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
for (const [key, value] of Object.entries(loaded)) if (process.env[key] === undefined) process.env[key] = value;
void runStandaloneJobQueueCommand().catch((error) => {
  console.error(`[career-agent-queue] ${error instanceof Error ? error.message : "Queue command failed."}`);
  process.exitCode = 1;
});
