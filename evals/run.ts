/**
 * CLI entry: `npm run test:evals` → vite-node evals/run.ts
 * Soft-exit by default so CI can report baseline without blocking merges.
 * Set EVALS_FAIL_ON_ERROR=1 to exit non-zero when any task fails.
 */

import { formatSuiteReport, runEvalSuite } from "./runner";

async function main(): Promise<void> {
  const report = await runEvalSuite();
  const text = formatSuiteReport(report);
  console.log(text);

  const failOnError = process.env.EVALS_FAIL_ON_ERROR === "1";
  if (failOnError && report.failedCount > 0) {
    process.exitCode = 1;
    return;
  }

  // Soft gate: always exit 0 unless EVALS_FAIL_ON_ERROR=1.
  process.exitCode = 0;
}

main().catch((error: unknown) => {
  console.error("evals harness crashed:", error);
  process.exitCode = 1;
});
