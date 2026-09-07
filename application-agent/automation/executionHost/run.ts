import { loadEnv } from "vite";
import { createConfiguredExecutionHostServer } from "./server";

// Vite loads `.env.local` for the browser process, while this is a separate
// Node process. Read the same local files here without overwriting explicit
// shell environment values (which remain the higher-precedence configuration).
const localEnv = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
for (const [key, value] of Object.entries(localEnv)) {
  if (process.env[key] === undefined) process.env[key] = value;
}

const host = createConfiguredExecutionHostServer({
  logger: (entry) => {
    const suffix = entry.reason ? ` · ${entry.reason}` : "";
    console.log(`[career-agent-executor] ${entry.event} ${entry.executionId} ${entry.status}${suffix}`);
  },
});

host.server.listen(host.port, host.host, () => {
  console.log(`[career-agent-executor] listening on http://${host.host}:${host.port}`);
  console.log(`[career-agent-executor] automatic submission authority: ${process.env.ATELIER_EXECUTION_SUBMISSION_AUTHORITY?.trim() || "never"}`);
});

const shutdown = () => {
  void host.close().finally(() => process.exit(0));
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
