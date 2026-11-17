import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Ensure loopback test servers bypass any configured HTTP proxy (e.g. in
// sandboxed CI where HTTPS_PROXY=http://127.0.0.1:42131 and NODE_USE_ENV_PROXY=1).
// Without this, fetch("http://127.0.0.1:<port>/...") is routed through the proxy
// and times out.
for (const key of ["NO_PROXY", "no_proxy"] as const) {
  const current = process.env[key];
  const needsLoopback =
    !current || !current.includes("127.0.0.1") || !current.includes("localhost");
  if (needsLoopback) {
    const loopback = "127.0.0.1,localhost";
    process.env[key] = current ? `${current},${loopback}` : loopback;
  }
}

// Tests must never read or write the real agent state in .local/career-agent.
// Code that opens state without naming a file (the browser host's submission
// fences) uses this temporary database instead (2026-11-10).
if (!process.env.ATELIER_CAREER_AGENT_STATE_FILE) {
  process.env.ATELIER_CAREER_AGENT_STATE_FILE = join(mkdtempSync(join(tmpdir(), "career-agent-test-state-")), "state.db");
}

afterEach(() => cleanup());
