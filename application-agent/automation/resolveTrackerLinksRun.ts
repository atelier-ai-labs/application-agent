import { runResolveTrackerLinksCommand } from "./resolveTrackerLinksCli";

void runResolveTrackerLinksCommand().catch((error) => {
  console.error(`[career-agent-links] ${error instanceof Error ? error.message : "Link resolution failed."}`);
  process.exitCode = 1;
});
