import { loadEnv } from "vite";
import { writeApplicationHistoryReport } from "./applicationHistory";

// Entry point for `npm run career-agent:history`.
const loaded = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
for (const [key, value] of Object.entries(loaded)) if (process.env[key] === undefined) process.env[key] = value;

try {
  const { path, report } = writeApplicationHistoryReport();
  const s = report.score;
  console.log(`[career-agent-history] ${s.applications} applications · ${s.reachedSubmit}/${s.started} reached Submit · ${s.fieldsFilled}/${s.fieldsDetected} fields filled · ${s.submitted} submitted (${s.provenByPage} proven by the page)`);
  console.log(`[career-agent-history] wrote ${path}`);
} catch (error) {
  console.error(`[career-agent-history] ${error instanceof Error ? error.message : "History report failed."}`);
  process.exitCode = 1;
}
