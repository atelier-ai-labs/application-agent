import { createConfiguredGoogleSheetsTransport, type GoogleSheetsEnvironment, type GoogleSheetsApiTransport } from "./googleSheetsJobTracker";
import { GoogleSheetsJobQueue } from "./googleSheetsJobQueue";
import { runStandaloneJobQueuePollTick, runStandaloneJobQueueTick, type StandaloneJobProcessor } from "./standaloneJobQueueWorker";
import { createCareerServiceQueueProcessor } from "./standaloneJobQueueWorker";
import { createConfiguredBackgroundCareerAgentRuntime } from "./runtime/careerAgentRuntime";
import { importTrackerRowsToQueue } from "./googleSheetsJobQueueImport";
import { PlaywrightApplicationRouteDiscoverer } from "./applicationRouteDiscovery";
import { PlaywrightLeverBrowserSessionFactory } from "./playwrightLeverBrowserSession";

function flag(args: readonly string[], name: string): string | undefined { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
function has(args: readonly string[], name: string): boolean { return args.includes(name); }
function positive(value: string | undefined, fallback: number, label: string): number { if (!value) return fallback; const parsed = Number(value); if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`); return parsed; }
function booleanValue(value: string | undefined, fallback: boolean, label: string): boolean { if (value === undefined || value.trim() === "") return fallback; if (value === "true") return true; if (value === "false") return false; throw new Error(`${label} must be true or false.`); }
function shouldContinueQueue(result: { status?: string; idle: boolean }): boolean {
  return !result.idle && ["Skipped", "Submitted", "Confirmed", "Expired"].includes(result.status ?? "");
}

/** Runnable Sheet queue command. The default processor is intentionally a
 * no-op Needs Input boundary until an application processor is injected. */
export async function runStandaloneJobQueueCommand(argv = process.argv.slice(2), env = process.env as GoogleSheetsEnvironment & Record<string, string | undefined>, injectedTransport?: GoogleSheetsApiTransport): Promise<void> {
  const args = [...argv]; const spreadsheetId = flag(args, "--sheet-id")?.trim() || env.ATELIER_GOOGLE_SHEET_ID?.trim(); const spreadsheetName = flag(args, "--sheet-name")?.trim() || env.ATELIER_GOOGLE_SHEET_NAME?.trim();
  // ATELIER_GOOGLE_SHEET_TAB names the source Job Tracker in the shared env.
  // Keep the application queue on its own tab unless explicitly overridden.
  const sheetTab = flag(args, "--tab")?.trim() || env.ATELIER_GOOGLE_SHEET_QUEUE_TAB?.trim() || "Application Queue";
  if (!spreadsheetId || !spreadsheetName) throw new Error("Job queue configuration requires --sheet-id/ATELIER_GOOGLE_SHEET_ID and --sheet-name/ATELIER_GOOGLE_SHEET_NAME.");
  const transport = injectedTransport ?? createConfiguredGoogleSheetsTransport(env);
  const queue = new GoogleSheetsJobQueue({ spreadsheetId, spreadsheetName, sheetTab, timeoutMs: positive(flag(args, "--timeout-ms") || env.ATELIER_GOOGLE_SHEETS_TIMEOUT_MS, 10_000, "timeout"), leaseMs: positive(flag(args, "--lease-ms"), 300_000, "lease") }, transport);
  if (has(args, "--list")) { console.log(JSON.stringify({ sheetTab, jobs: await queue.list() })); return; }
  if (has(args, "--schema-check") || has(args, "--dry-run")) { await queue.list(); console.log(JSON.stringify({ mode: has(args, "--dry-run") ? "dry-run" : "schema-check", sheetTab, writes: false })); return; }
  if (has(args, "--init")) { await queue.initialize(); console.log(JSON.stringify({ mode: "initialized", sheetTab, writes: true })); return; }
  if (has(args, "--import-tracker")) {
    const result = await importTrackerRowsToQueue(queue, transport, spreadsheetId, flag(args, "--tracker-tab")?.trim() || env.ATELIER_GOOGLE_SHEET_TRACKER_TAB?.trim() || "Job Tracker", !has(args, "--import-live"));
    console.log(JSON.stringify({ mode: result.dryRun ? "tracker-import-dry-run" : "tracker-import", ...result }));
    return;
  }
  const workerId = flag(args, "--worker-id")?.trim() || env.ATELIER_JOB_QUEUE_WORKER_ID?.trim() || `worker-${process.pid}`;
  const targetJobId = flag(args, "--job-id")?.trim();
  if (targetJobId !== undefined && !targetJobId) throw new Error("--job-id requires an exact non-empty Job ID.");
  if (targetJobId && has(args, "--poll")) throw new Error("--job-id is supported only for one-shot runs; remove --poll.");
  if (has(args, "--poll") && !(flag(args, "--worker-id")?.trim() || env.ATELIER_JOB_QUEUE_WORKER_ID?.trim())) throw new Error("--poll requires an explicit stable --worker-id or ATELIER_JOB_QUEUE_WORKER_ID; Google Sheets cannot fence multiple active workers automatically.");
  const processorMode = flag(args, "--processor")?.trim() || env.ATELIER_JOB_QUEUE_PROCESSOR?.trim() || "noop";
  let runtime: ReturnType<typeof createConfiguredBackgroundCareerAgentRuntime> | undefined;
  let processor: StandaloneJobProcessor;
  if (processorMode === "career-service") {
    if (!env.ATELIER_CAREER_AGENT_CAMPAIGN_ID?.trim()) throw new Error("The career-service processor requires ATELIER_CAREER_AGENT_CAMPAIGN_ID.");
    const executionHostUrl = flag(args, "--execution-host-url")?.trim() || env.ATELIER_EXECUTION_HOST_BASE_URL?.trim();
    const runtimeEnv = executionHostUrl ? { ...env, ATELIER_EXECUTION_HOST_BASE_URL: executionHostUrl } : env;
    runtime = createConfiguredBackgroundCareerAgentRuntime(runtimeEnv);
    try {
      // The configured runtime owns the single Slack Socket Mode connection.
      // Start it before processing so Needs Input events can be answered, and
      // stop it if startup itself fails so partially opened transports close.
      await runtime.start();
      const routeDiscoveryEnabled = booleanValue(env.ATELIER_CAREER_AGENT_ROUTE_DISCOVERY_ENABLED, true, "ATELIER_CAREER_AGENT_ROUTE_DISCOVERY_ENABLED");
      const routeDiscoverer = routeDiscoveryEnabled
        ? new PlaywrightApplicationRouteDiscoverer(new PlaywrightLeverBrowserSessionFactory({
            headless: booleanValue(env.ATELIER_EXECUTION_HEADLESS, false, "ATELIER_EXECUTION_HEADLESS"),
            timeoutMs: positive(env.ATELIER_EXECUTION_BROWSER_TIMEOUT_MS, 15_000, "ATELIER_EXECUTION_BROWSER_TIMEOUT_MS"),
          }))
        : undefined;
      processor = createCareerServiceQueueProcessor({
        ...runtime,
        ...(routeDiscoverer ? { discoverApplicationRoute: routeDiscoverer.discover.bind(routeDiscoverer) } : {}),
      }, env.ATELIER_CAREER_AGENT_CAMPAIGN_ID.trim());
    } catch (error) {
      await runtime.stop().catch(() => undefined);
      throw error;
    }
  } else if (processorMode === "noop") {
    processor = { async process() { return { status: "Needs Input", error: "No application processor is configured; queue claim was safely returned to human input." }; } };
  } else throw new Error("--processor must be noop or career-service.");
  const once = async (poll = false) => {
    // The daily hunt writes approved roles to Job Tracker. Import them in the
    // same worker cycle so the queue cannot silently lag behind the tracker.
    // Import failures skip processing this cycle; processing stale rows could
    // otherwise make a transient Sheets failure look like a healthy poll.
    let trackerImport: Awaited<ReturnType<typeof importTrackerRowsToQueue>> | undefined;
    if (poll && !has(args, "--skip-tracker-import")) {
      try {
        trackerImport = await importTrackerRowsToQueue(queue, transport, spreadsheetId, flag(args, "--tracker-tab")?.trim() || env.ATELIER_GOOGLE_SHEET_TRACKER_TAB?.trim() || env.ATELIER_GOOGLE_SHEET_TAB?.trim() || "Job Tracker", false);
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 500) : "Tracker import failed.";
        console.log(JSON.stringify({ trackerImport: { status: "Failed", error: reason }, queue: { status: "Failed", error: "Tracker import failed; queue processing skipped for this cycle.", idle: false } }));
        return;
      }
    }
    const maxJobs = poll ? positive(flag(args, "--max-jobs-per-poll") || env.ATELIER_JOB_QUEUE_MAX_JOBS_PER_POLL, 2, "max-jobs-per-poll") : 1;
    for (let index = 0; index < maxJobs; index += 1) {
      const queueResult = poll
        ? await runStandaloneJobQueuePollTick(queue, processor, workerId, new Date())
        : await runStandaloneJobQueueTick(queue, processor, workerId, new Date(), { targetJobId, allowTargetReadyToSubmit: Boolean(targetJobId && processorMode === "career-service") });
      console.log(JSON.stringify({ ...(index === 0 && trackerImport ? { trackerImport } : {}), queue: queueResult }));
      if (!poll || !shouldContinueQueue(queueResult)) break;
    }
  };
  if (!has(args, "--poll")) { try { await once(); } finally { await runtime?.stop(); } return; }
  const intervalMs = positive(flag(args, "--interval-ms") || env.ATELIER_JOB_QUEUE_POLL_INTERVAL_MS, 30_000, "interval"); let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    if (!has(args, "--skip-tracker-import")) await queue.initialize();
    while (!stopping) { await once(true); if (!stopping) await new Promise<void>((resolve) => setTimeout(resolve, intervalMs)); }
  } finally { await runtime?.stop(); }
}
