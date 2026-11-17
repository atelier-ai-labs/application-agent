import {
  LeverBrowserExecutor,
  type LeverBrowserExecutorOptions,
} from "../src/domain/leverBrowserExecutor";
import { PlaywrightLeverBrowserSessionFactory, type PlaywrightLeverBrowserOptions } from "./playwrightLeverBrowserSession";
import { isUsableResumeArtifact } from "./resume/resumeArtifact";
import { FormSnapshotStore, recordingSessionFactory } from "./formSnapshots/formSnapshot";

export interface CreatePlaywrightLeverExecutorOptions extends PlaywrightLeverBrowserOptions {
  /** The existing browser policy can target a supported ATS or infer a verified destination. */
  provider?: "lever" | "greenhouse" | "rippling" | "ashby" | "workday" | "youhired" | "matlensilver" | "protagona" | "gusto" | "vaia" | "auto";
  resumePaths?: LeverBrowserExecutorOptions["resumePaths"];
  now?: LeverBrowserExecutorOptions["now"];
  allowedFieldClassifications?: LeverBrowserExecutorOptions["allowedFieldClassifications"];
  /** Explicit server-side opt-in; campaign authority must also be automatic. */
  allowAutomaticSubmission?: boolean;
  /** Folder where the first read of each real form is saved for replay; omit to save none. */
  formSnapshotDir?: string;
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
    securityCodeProvider,
    formSnapshotDir,
  } = options;
  const sessions = new PlaywrightLeverBrowserSessionFactory({ headless, slowMo, timeoutMs, ...(securityCodeProvider ? { securityCodeProvider } : {}) });
  return new LeverBrowserExecutor({
    sessionFactory: formSnapshotDir ? recordingSessionFactory(sessions, new FormSnapshotStore(formSnapshotDir)) : sessions,
    ...(provider ? { provider } : {}),
    ...(resumePaths ? { resumePaths } : {}),
    resumeFileExists: fileExists,
    ...(now ? { now } : {}),
    ...(allowedFieldClassifications ? { allowedFieldClassifications } : {}),
    ...(allowAutomaticSubmission !== undefined ? { allowAutomaticSubmission } : {}),
  });
}
