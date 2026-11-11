import { loadEnv } from "vite";
import { PlaywrightLeverBrowserSessionFactory } from "../playwrightLeverBrowserSession";
import { LocalStorageCareerRepository } from "../../src/persistence/careerRepository";
import { openStateStorage } from "../runtime/stateStorage";
import { classifyJobUrl } from "../../src/domain/jobUrlClassifier";
import { DEFAULT_FORM_SNAPSHOT_DIR, FormSnapshotStore, snapshotField } from "./formSnapshot";

/**
 * `npm run career-agent:capture -- --url <application url> [--company X --role Y]`
 * or `-- --from-history` (every job the agent has opened before).
 *
 * Opens each form in a hidden browser and only reads it: nothing is typed,
 * no file is uploaded, and nothing is submitted. Closed postings are skipped.
 */
interface Target { url: string; company?: string; role?: string; applicationId: string }

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function applicationPage(url: string): string {
  const kind = classifyJobUrl(url).kind;
  if (kind === "ashby" && !/\/application\/?$/.test(url)) return `${url.replace(/\/+$/, "")}/application`;
  if (kind === "lever" && !/\/apply\/?$/.test(url)) return `${url.replace(/\/+$/, "")}/apply`;
  return url;
}

export async function runCaptureCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const loaded = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
  for (const [name, value] of Object.entries(loaded)) if (process.env[name] === undefined) process.env[name] = value;
  const env = process.env as Record<string, string | undefined>;
  const store = new FormSnapshotStore(env.ATELIER_FORM_SNAPSHOT_DIR?.trim() || DEFAULT_FORM_SNAPSHOT_DIR);
  const existing = new Set(store.list().map((snapshot) => snapshot.url));
  const targets: Target[] = [];
  const url = flag(argv, "--url");
  if (url) targets.push({ url: applicationPage(url), applicationId: `capture-${Date.now()}`, ...(flag(argv, "--company") ? { company: flag(argv, "--company") } : {}), ...(flag(argv, "--role") ? { role: flag(argv, "--role") } : {}) });
  if (argv.includes("--from-history")) {
    const jobs = new LocalStorageCareerRepository(openStateStorage()).listJobs().filter((job) => job.applicationId);
    for (const job of jobs) {
      const source = job.destinationResolution?.destinationUrl ?? job.job.applicationUrl ?? job.job.sourceUrl;
      if (!source) continue;
      const page = applicationPage(source);
      if (!page || existing.has(page) || targets.some((target) => target.url === page)) continue;
      // Rippling needs an Apply click first; its forms are saved during live runs instead.
      if (!["ashby", "lever", "greenhouse"].includes(classifyJobUrl(page).kind)) continue;
      targets.push({ url: page, company: job.job.company, role: job.job.title, applicationId: job.applicationId! });
    }
  }
  if (targets.length === 0) { console.log("Nothing to capture (pass --url or --from-history; forms already saved are skipped)."); return; }

  const factory = new PlaywrightLeverBrowserSessionFactory({ headless: true, timeoutMs: 20_000 });
  let saved = 0;
  for (const target of targets) {
    const label = `${target.company ?? "?"} — ${target.role ?? "?"}`;
    const session = await factory.open(target.applicationId);
    try {
      await session.navigate(target.url);
      const unavailable = await session.detectUnavailablePage?.();
      if (unavailable) { console.log(`- ${label}: posting closed`); continue; }
      const fields = await session.inspectFields();
      if (fields.length === 0) { console.log(`- ${label}: no form found`); continue; }
      store.save({ version: 1, applicationId: target.applicationId, url: target.url, capturedAt: new Date().toISOString(), ...(target.company ? { company: target.company } : {}), ...(target.role ? { role: target.role } : {}), fields: fields.map(snapshotField) });
      saved += 1;
      console.log(`+ ${label}: ${fields.length} fields`);
    } catch (error) {
      console.log(`- ${label}: ${error instanceof Error ? error.message.split("\n")[0]!.slice(0, 120) : "failed"}`);
    } finally {
      await session.close().catch(() => undefined);
    }
  }
  console.log(`Saved ${saved} form snapshot${saved === 1 ? "" : "s"} to ${store.directory}.`);
}

await runCaptureCli();
