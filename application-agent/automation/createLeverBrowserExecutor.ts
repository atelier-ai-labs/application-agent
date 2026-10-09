import {
  LeverBrowserExecutor,
  type LeverBrowserExecutorOptions,
} from "../src/domain/leverBrowserExecutor";
import { PlaywrightLeverBrowserSessionFactory, type PlaywrightLeverBrowserOptions } from "./playwrightLeverBrowserSession";
import { isUsableResumeArtifact } from "./resume/resumeArtifact";

export interface CreatePlaywrightLeverExecutorOptions extends PlaywrightLeverBrowserOptions {
  /** The existing browser policy can target a supported ATS or infer a verified destination. */
  provider?: "lever" | "greenhouse" | "rippling" | "ashby" | "workday" | "youhired" | "matlensilver" | "protagona" | "gusto" | "auto";
  resumePaths?: LeverBrowserExecutorOptions["resumePaths"];
  now?: LeverBrowserExecutorOptions["now"];
  allowedFieldClassifications?: LeverBrowserExecutorOptions["allowedFieldClassifications"];
  /** Explicit server-side opt-in; campaign authority must also be automatic. */
  allowAutomaticSubmission?: boolean;
}

async function fileExists(path: string): Promise<boolean> {
  return isUsableResumeArtifact(path);
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
    provider,
    resumePaths,
    now,
    allowedFieldClassifications,
    allowAutomaticSubmission,
  } = options;
  return new LeverBrowserExecutor({
    sessionFactory: new PlaywrightLeverBrowserSessionFactory({ headless, slowMo, timeoutMs }),
    ...(provider ? { provider } : {}),
    ...(resumePaths ? { resumePaths } : {}),
    resumeFileExists: fileExists,
    ...(now ? { now } : {}),
    ...(allowedFieldClassifications ? { allowedFieldClassifications } : {}),
    ...(allowAutomaticSubmission !== undefined ? { allowAutomaticSubmission } : {}),
  });
}
