import { runDiscoverJobsCommand } from "./discoverJobs";

void runDiscoverJobsCommand().catch((error) => {
  console.error(`[career-agent-discover] ${error instanceof Error ? error.message : "Discovery failed."}`);
  process.exitCode = 1;
});
