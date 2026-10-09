import { loadEnv } from "vite";
import { createConfiguredExecutionHostServer } from "./server";
import { startQuickTunnel } from "./quickTunnel";
import { createHandoffReannouncementQueue } from "./handoffReannouncementQueue";
import { createConfiguredBackgroundCareerAgentRuntime } from "../runtime/careerAgentRuntime";

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
let quickTunnel: Awaited<ReturnType<typeof startQuickTunnel>>;
let quickTunnelStartup: Promise<void> | undefined;
const quickTunnelAbort = new AbortController();
let reannounceRuntime: ReturnType<typeof createConfiguredBackgroundCareerAgentRuntime> | undefined;
const reannounceQueue = createHandoffReannouncementQueue();
let tunnelGeneration = 0;

async function reannounceEligibleHandoff(): Promise<void> {
  const campaignId = process.env.ATELIER_CAREER_AGENT_CAMPAIGN_ID?.trim();
  const jobId = process.env.ATELIER_CAREER_AGENT_JOB_ID?.trim();
  if (!campaignId || !jobId) return;
  try {
    reannounceRuntime ??= createConfiguredBackgroundCareerAgentRuntime(process.env);
    const findEligibleEvent = () => {
      (reannounceRuntime!.stateStorage as { reload?: () => void } | undefined)?.reload?.();
      const campaign = reannounceRuntime!.service.getCampaign(campaignId);
      const job = reannounceRuntime!.service.getJob(jobId);
      return (campaign.attentionEvents ?? []).find((candidate) => {
        if (candidate.status !== "open" || !candidate.publishedAt || candidate.jobId !== jobId || candidate.applicationId !== job.applicationId) return false;
        const blocker = job.blockers.find((item) => item.id === candidate.blockerId);
        return blocker?.status === "open" && blocker.kind === "external_verification" && blocker.unit === "submission" && blocker.field === "submission-confirmation" && blocker.resumeAfterHuman === false;
      });
    };
    const event = findEligibleEvent();
    if (!event || findEligibleEvent()?.id !== event.id) return;
    await reannounceRuntime.service.reannounceAttentionEvent(campaignId, event.id);
  } catch {
    // Tunnel recovery must not take down the execution host; the next
    // reconnect will retry the exact eligible event.
    console.error("[career-agent-handoff] unable to reannounce the protected handoff event");
  }
}

host.server.listen(host.port, host.host, () => {
  console.log(`[career-agent-executor] listening on http://${host.host}:${host.port}`);
  console.log(`[career-agent-executor] automatic submission authority: ${process.env.ATELIER_EXECUTION_SUBMISSION_AUTHORITY?.trim() || "never"}`);
  if (host.handoffViewer) {
    void host.handoffViewer.listen().then((port) => {
      console.log(`[career-agent-handoff] listening on http://${host.handoffViewer?.host}:${port}`);
      if (process.env.ATELIER_HANDOFF_QUICK_TUNNEL_ENABLED === "true") {
        const loopbackOrigin = host.handoffViewer?.getPublicOrigin();
        const thisTunnelGeneration = ++tunnelGeneration;
        quickTunnelStartup = startQuickTunnel({
          enabled: true,
          viewerPort: port,
          signal: quickTunnelAbort.signal,
          onOriginChange: (origin) => {
            if (thisTunnelGeneration !== tunnelGeneration || quickTunnelAbort.signal.aborted) return;
            host.handoffViewer?.setPublicOrigin(origin ?? loopbackOrigin ?? `http://127.0.0.1:${port}`);
            if (!origin) {
              reannounceQueue.invalidate();
              return;
            }
            reannounceQueue.enqueue(origin, async (expectedOrigin) => {
              if (thisTunnelGeneration !== tunnelGeneration || quickTunnelAbort.signal.aborted || host.handoffViewer?.getPublicOrigin() !== expectedOrigin) return;
              await reannounceEligibleHandoff();
            });
          },
        }).then((tunnel) => {
          quickTunnel = tunnel;
          if (tunnel?.publicOrigin) host.handoffViewer?.setPublicOrigin(tunnel.publicOrigin);
        }).catch((error) => {
          if (!quickTunnelAbort.signal.aborted) throw error;
        });
        return quickTunnelStartup;
      }
      return undefined;
    }).catch((error) => {
      console.error(`[career-agent-handoff] failed to listen: ${error instanceof Error ? error.message : "unknown error"}`);
    });
  }
});

const shutdown = () => {
  quickTunnelAbort.abort();
  tunnelGeneration += 1;
  reannounceQueue.invalidate();
  void Promise.allSettled([quickTunnelStartup, quickTunnel?.stop()]).then(() => host.close()).finally(() => process.exit(0));
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
