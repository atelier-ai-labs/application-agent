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

afterEach(() => cleanup());
