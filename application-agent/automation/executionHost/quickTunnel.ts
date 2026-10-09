import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

export interface QuickTunnelOptions {
  enabled: boolean;
  viewerPort: number;
  command?: string;
  startupTimeoutMs?: number;
  restartBackoffMs?: number;
  maxRestartBackoffMs?: number;
  signal?: AbortSignal;
  onOriginChange?: (origin: string | undefined) => void | Promise<void>;
  spawnProcess?: (command: string, args: readonly string[]) => ChildProcessByStdio<null, Readable, Readable>;
}

export interface QuickTunnel {
  readonly publicOrigin: string | undefined;
  stop(): Promise<void>;
}

export function parseQuickTunnelOrigin(output: string): string | undefined {
  const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return match?.[0];
}

/** Optional dev/test relay. It only targets the isolated viewer port. */
export async function startQuickTunnel(options: QuickTunnelOptions): Promise<QuickTunnel | undefined> {
  if (!options.enabled) return undefined;
  if (!Number.isInteger(options.viewerPort) || options.viewerPort <= 0) throw new Error("Quick Tunnel viewer port must be positive.");
  const command = options.command ?? "cloudflared";
  const args = ["tunnel", "--url", `http://127.0.0.1:${options.viewerPort}`, "--no-autoupdate"] as const;
  const spawnProcess = options.spawnProcess ?? ((childCommand: string, childArgs: readonly string[]) =>
    spawn(childCommand, childArgs, { stdio: ["ignore", "pipe", "pipe"] }));
  const timeoutMs = options.startupTimeoutMs ?? 15_000;
  const restartBackoffMs = Math.max(50, options.restartBackoffMs ?? 500);
  const maxRestartBackoffMs = Math.max(restartBackoffMs, options.maxRestartBackoffMs ?? 10_000);
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  let origin: string | undefined;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let restartDelay = restartBackoffMs;
  let stopping = false;
  let restartScheduled = false;
  let generation = 0;
  if (options.signal?.aborted) throw new Error("Cloudflare Quick Tunnel startup was cancelled.");
  const notifyOrigin = (next: string | undefined): void => {
    origin = next;
    try { void Promise.resolve(options.onOriginChange?.(next)).catch(() => undefined); } catch { /* callbacks cannot take down the host */ }
  };
  const scheduleRestart = (): void => {
    if (stopping || restartScheduled) return;
    restartScheduled = true;
    const delay = restartDelay;
    restartDelay = Math.min(maxRestartBackoffMs, restartDelay * 2);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      restartScheduled = false;
      void launch(false).catch(() => scheduleRestart());
    }, delay);
  };
  const launch = async (initial: boolean): Promise<string | undefined> => {
    const currentGeneration = ++generation;
    let output = "";
    let ready = false;
    const process = spawnProcess(command, args);
    child = process;
    return await new Promise<string | undefined>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!ready && currentGeneration === generation && !stopping) {
          try { process.kill(); } catch { /* best effort */ }
          const error = new Error("Cloudflare Quick Tunnel did not provide a public URL in time.");
          if (initial) finish(error); else { notifyOrigin(undefined); scheduleRestart(); finish(); }
        }
      }, timeoutMs);
      const finish = (error?: Error, value?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const abort = (): void => {
        if (settled) return;
        try { process.kill(); } catch { /* best effort */ }
        if (initial) finish(new Error("Cloudflare Quick Tunnel startup was cancelled."));
        else finish();
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      const onData = (chunk: Buffer): void => {
        output += chunk.toString("utf8");
        const parsed = parseQuickTunnelOrigin(output);
        if (!parsed || ready || currentGeneration !== generation) return;
        ready = true;
        restartDelay = restartBackoffMs;
        notifyOrigin(parsed);
        if (initial) finish(undefined, parsed);
      };
      process.stdout.on("data", onData);
      process.stderr.on("data", onData);
      process.once("error", (error) => {
        if (ready || currentGeneration !== generation || stopping) return;
        const failure = error instanceof Error ? error : new Error("Cloudflare Quick Tunnel failed to start.");
        if (initial) finish(failure); else { notifyOrigin(undefined); scheduleRestart(); finish(); }
      });
      process.once("exit", (code) => {
        if (currentGeneration !== generation || stopping) return;
        if (!ready) {
          const failure = new Error(code === 0 ? "Cloudflare Quick Tunnel exited before becoming ready." : "Cloudflare Quick Tunnel exited before becoming ready.");
          if (initial) finish(failure); else { notifyOrigin(undefined); scheduleRestart(); finish(); }
          return;
        }
        notifyOrigin(undefined);
        scheduleRestart();
      });
      if (options.signal?.aborted) abort();
    });
  };
  try {
    await launch(true);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // Keep the supervisor alive even if cloudflared is unavailable or cannot
    // connect during startup. Later attempts use the same bounded backoff.
    notifyOrigin(undefined);
    scheduleRestart();
  }
  return {
    get publicOrigin() { return origin; },
    stop: async () => {
      stopping = true;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = undefined;
      generation += 1;
      notifyOrigin(undefined);
      try { if (child && !child.killed) child.kill(); } catch { /* best effort */ }
    },
  };
}
