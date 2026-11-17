import { runCheckOpenCommand } from "./postingLiveness";

void runCheckOpenCommand().catch((error) => {
  console.error(`[career-agent-open] ${error instanceof Error ? error.message : "The open-posting check failed."}`);
  process.exitCode = 1;
});
