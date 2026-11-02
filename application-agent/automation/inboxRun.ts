import { runInboxCommand } from "./inboxMonitor";

void runInboxCommand().catch((error) => {
  console.error(`[career-agent-inbox] ${error instanceof Error ? error.message : "Inbox check failed."}`);
  process.exitCode = 1;
});
