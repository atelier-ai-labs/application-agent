import { loadEnv } from "vite";
import { appendDailyRun, DAILY_PHASES, npmScriptRunner, runDailyCycle, type DailyPhase } from "./dailyCycle";
import { resolveSlackConfig } from "./slack/config";
import { SlackNotificationAdapter } from "./slack/slackNotificationAdapter";
import { writeApplicationHistoryReport } from "./applicationHistory";

// Entry point for `npm run career-agent:daily` and the systemd timer.
// `--phases discover,inbox` runs a subset; `--max-starts N` caps new applications.
const loaded = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
for (const [key, value] of Object.entries(loaded)) if (process.env[key] === undefined) process.env[key] = value;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const phases = (flag("--phases")?.split(",").map((phase) => phase.trim()) ?? [...DAILY_PHASES]) as DailyPhase[];
  const unknown = phases.filter((phase) => !DAILY_PHASES.includes(phase));
  if (unknown.length > 0) throw new Error(`Unknown phase: ${unknown.join(", ")} (use ${DAILY_PHASES.join(", ")}).`);
  const maxStartsFlag = flag("--max-starts") ?? process.env.ATELIER_DAILY_MAX_STARTS;
  const maxStarts = maxStartsFlag === undefined ? undefined : Number(maxStartsFlag);
  if (maxStarts !== undefined && (!Number.isInteger(maxStarts) || maxStarts < 0)) throw new Error("--max-starts must be a whole number.");
  const hostUrl = (process.env.ATELIER_EXECUTION_HOST_BASE_URL?.trim() || "http://127.0.0.1:8787").replace(/\/$/, "");
  let slack: SlackNotificationAdapter | undefined;
  try { slack = new SlackNotificationAdapter({ config: resolveSlackConfig(process.env as never) }); } catch { slack = undefined; }

  const record = await runDailyCycle({
    run: npmScriptRunner(),
    async hostCapacity() {
      try {
        const response = await fetch(`${hostUrl}/health`, { signal: AbortSignal.timeout(5_000) });
        const body = await response.json() as { ok?: boolean; activeSessions?: number; maxConcurrent?: number };
        return body.ok ? { active: body.activeSessions ?? 0, max: body.maxConcurrent ?? 1 } : undefined;
      } catch {
        return undefined;
      }
    },
    ...(slack ? { notify: (text: string) => slack!.publishInfoNotice(text) } : {}),
  }, { phases, ...(maxStarts !== undefined ? { maxStarts } : {}) });
  appendDailyRun(record);
  try { writeApplicationHistoryReport(); } catch (error) { console.error(`[career-agent-daily] history report failed: ${error instanceof Error ? error.message : error}`); }
  console.log(`[career-agent-daily] done: ${JSON.stringify(record)}`);
}

void main().catch((error) => {
  console.error(`[career-agent-daily] ${error instanceof Error ? error.message : "Daily run failed."}`);
  process.exitCode = 1;
});
