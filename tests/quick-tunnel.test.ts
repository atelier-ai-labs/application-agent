import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { parseQuickTunnelOrigin, startQuickTunnel } from "../application-agent/automation/executionHost/quickTunnel";

class FakeTunnelProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  kill(): boolean { this.killed = true; return true; }
}

describe("Cloudflare Quick Tunnel helper", () => {
  it("accepts only trycloudflare HTTPS origins", () => {
    expect(parseQuickTunnelOrigin("INF https://sample-name.trycloudflare.com connected")).toBe("https://sample-name.trycloudflare.com");
    expect(parseQuickTunnelOrigin("https://evil.example.invalid")).toBeUndefined();
  });

  it("does not spawn when disabled", async () => {
    await expect(startQuickTunnel({ enabled: false, viewerPort: 8790 })).resolves.toBeUndefined();
  });

  it("invalidates the origin and restarts an exited connector with bounded backoff", async () => {
    const processes: FakeTunnelProcess[] = [];
    const origins: Array<string | undefined> = [];
    const tunnel = await startQuickTunnel({
      enabled: true,
      viewerPort: 8790,
      restartBackoffMs: 5,
      maxRestartBackoffMs: 10,
      startupTimeoutMs: 100,
      onOriginChange: (origin) => { origins.push(origin); },
      spawnProcess: () => {
        const process = new FakeTunnelProcess();
        processes.push(process);
        if (processes.length === 1) setTimeout(() => process.stderr.emit("data", Buffer.from("INF https://first.trycloudflare.com connected")), 0);
        return process as never;
      },
    });
    expect(processes).toHaveLength(1);
    expect(tunnel?.publicOrigin).toBe("https://first.trycloudflare.com");
    processes[0]!.emit("exit", 1);
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(origins).toEqual(["https://first.trycloudflare.com", undefined]);
    expect(processes).toHaveLength(2);
    processes[1]!.stdout.emit("data", Buffer.from("INF https://second.trycloudflare.com connected"));
    expect(tunnel?.publicOrigin).toBe("https://second.trycloudflare.com");
    await tunnel?.stop();
    processes[1]!.emit("exit", 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(processes).toHaveLength(2);
  });

  it("cancels an in-flight initial connector and kills its child", async () => {
    const controller = new AbortController();
    let process: FakeTunnelProcess | undefined;
    const startup = startQuickTunnel({
      enabled: true,
      viewerPort: 8790,
      startupTimeoutMs: 100,
      signal: controller.signal,
      spawnProcess: () => {
        process = new FakeTunnelProcess();
        return process as never;
      },
    });
    controller.abort();
    await expect(startup).rejects.toThrow(/cancelled/);
    expect(process?.killed).toBe(true);
  });

  it("keeps retrying when the initial connector fails before becoming ready", async () => {
    const processes: FakeTunnelProcess[] = [];
    const origins: Array<string | undefined> = [];
    const tunnel = await startQuickTunnel({
      enabled: true,
      viewerPort: 8790,
      startupTimeoutMs: 100,
      restartBackoffMs: 50,
      maxRestartBackoffMs: 50,
      onOriginChange: (origin) => { origins.push(origin); },
      spawnProcess: () => {
        const process = new FakeTunnelProcess();
        processes.push(process);
        if (processes.length === 1) setTimeout(() => process.emit("error", new Error("connector unavailable")), 0);
        return process as never;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 65));
    expect(processes).toHaveLength(2);
    processes[1]!.stdout.emit("data", Buffer.from("INF https://recovered.trycloudflare.com connected"));
    expect(tunnel?.publicOrigin).toBe("https://recovered.trycloudflare.com");
    expect(origins).toContain("https://recovered.trycloudflare.com");
    await tunnel?.stop();
  });
});
