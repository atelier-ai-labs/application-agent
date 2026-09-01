import { stat } from "node:fs/promises";
import {
  LeverBrowserExecutor,
  type LeverBrowserExecutorOptions,
} from "../src/domain/leverBrowserExecutor";
import { PlaywrightLeverBrowserSessionFactory, type PlaywrightLeverBrowserOptions } from "./playwrightLeverBrowserSession";

export interface CreatePlaywrightLeverExecutorOptions extends PlaywrightLeverBrowserOptions {
  resumePaths?: LeverBrowserExecutorOptions["resumePaths"];
  now?: LeverBrowserExecutorOptions["now"];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Creates the real Node-side executor. Browser state is process-local; no
 * cookies, credentials, or profile data are written by this factory.
 */
export function createPlaywrightLeverBrowserExecutor(
  options: CreatePlaywrightLeverExecutorOptions = {},
): LeverBrowserExecutor {
  const {
    headless,
    slowMo,
    timeoutMs,
    resumePaths,
    now,
  } = options;
  return new LeverBrowserExecutor({
    sessionFactory: new PlaywrightLeverBrowserSessionFactory({ headless, slowMo, timeoutMs }),
    ...(resumePaths ? { resumePaths } : {}),
    resumeFileExists: fileExists,
    ...(now ? { now } : {}),
  });
}
