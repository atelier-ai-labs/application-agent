/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { AgentAlerts, crashLoopAlert, dailyRunAlerts, failedRunAlert, formatAlerts, modelHealthAlert } from "../application-agent/automation/runtime/agentAlerts";
import { failedDailyPhases, runDailyCycle, type CommandResult } from "../application-agent/automation/dailyCycle";
import type { KeyValueStorage } from "../application-agent/src/persistence/storage";

function memoryStorage(): KeyValueStorage {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } } as KeyValueStorage;
}

describe("agent alerts (2026-11-18)", () => {
  it("reads a phase's real reason from stderr and names an expired Google login (the 11-16 failure)", async () => {
    const auth = "[career-agent-discover] Google Sheets authorization expired or was revoked; run npm run career-agent:google-auth again.";
    const failed: CommandResult = { code: 1, stdout: "", stderr: `(node:1) ExperimentalWarning: SQLite is an experimental feature\n${auth}\n` };
    const record = await runDailyCycle({ run: async () => failed, hostCapacity: async () => undefined }, { phases: ["discover", "inbox"] });
    expect("error" in record.discovered! && record.discovered.error).toContain("authorization expired");
    const alerts = dailyRunAlerts(failedDailyPhases(record), []);
    expect(alerts.map((alert) => alert.key)).toEqual(["daily:google-login"]);
    expect(alerts[0]!.detail).toMatch(/Job search.*Inbox check/);
    expect(alerts[0]!.action).toContain("npm run career-agent:google-auth");
  });

  it("collects a dead job source from the job search, but not one odd posting", async () => {
    const ok: CommandResult = { code: 0, stdout: "0 added to the tracker\n", stderr: [
      "[career-agent-discover] source problem: themuse-live: The Muse request for Flexible / Remote page 0 failed with HTTP 404.",
      "[career-agent-discover] source problem: ashby:openai: Skipped an Ashby posting without an id or title.",
    ].join("\n") };
    const record = await runDailyCycle({ run: async () => ok, hostCapacity: async () => undefined }, { phases: ["discover"] });
    expect(record.sourceProblems).toEqual(["themuse-live: The Muse request for Flexible / Remote page 0 failed with HTTP 404."]);
    expect(dailyRunAlerts([], record.sourceProblems!)).toMatchObject([{ key: "source:themuse-live", title: "A job source isn't working: themuse-live" }]);
  });

  it("posts each alert once a day, and a quiet day posts nothing", async () => {
    const posted: string[] = [];
    let now = new Date("2026-11-18T22:00:00Z");
    const alerts = new AgentAlerts({ publishInfoNotice: async (text) => { posted.push(text); } }, memoryStorage(), () => now);
    const login = dailyRunAlerts([{ phase: "discovered", label: "Job search", error: "Google Sheets authorization expired or was revoked" }], []);
    expect(await alerts.raise(login)).toHaveLength(1);
    expect(await alerts.raise(login)).toHaveLength(0);
    expect(await alerts.raise([])).toHaveLength(0);
    now = new Date("2026-11-19T23:00:00Z");
    expect(await alerts.raise(login)).toHaveLength(1);
    expect(posted).toHaveLength(2);
    expect(posted[0]).toMatch(/^\*The application agent needs your attention\*\n\n⚠️ \*The Google login expired\*/);
  });

  it("alerts on a stuck run, but not on the normal 4-hour window close", () => {
    expect(failedRunAlert({ executionId: "e1", company: "CircleCI", role: "Software Engineer", reason: "The browser got stuck while filling First name (no progress for 5 minutes), and again after a retry, so the agent stopped. Nothing was submitted." }))
      .toMatchObject({ key: "run:e1", title: "CircleCI — Software Engineer stopped" });
    expect(failedRunAlert({ executionId: "e2", company: "Phantom", role: "Backend", reason: "The local browser execution session timed out; no application was submitted." })).toBeUndefined();
    expect(formatAlerts([failedRunAlert({ executionId: "e3", company: "X", role: "Y", reason: "The browser crashed." })!])).toContain("Nothing was submitted.");
  });

  it("spots a listener crash loop and a local model that has stopped answering", () => {
    const now = new Date("2026-11-18T22:00:00Z");
    const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
    expect(crashLoopAlert([minutesAgo(12), minutesAgo(6), minutesAgo(1)], now)?.key).toBe("listener:crash-loop");
    expect(crashLoopAlert([minutesAgo(50), minutesAgo(1)], now)).toBeUndefined();
    const timeouts = [5, 20, 40].map((minutes) => ({ at: minutesAgo(minutes), outcome: "timeout" }));
    expect(modelHealthAlert(timeouts, now)?.key).toBe("model:not-answering");
    expect(modelHealthAlert([...timeouts, { at: minutesAgo(2), outcome: "matched:C1@0.90" }], now)).toBeUndefined();
    expect(modelHealthAlert(timeouts.slice(0, 2), now)).toBeUndefined();
  });
});
