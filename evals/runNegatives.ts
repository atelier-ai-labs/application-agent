/**
 * Fail-audit CLI: `npm run test:evals:negatives`
 * Loads only evals/golden/negative/*.json and REQUIRES each fixture to FAIL.
 * Exit 1 if any known-bad fixture unexpectedly PASSES (grader always-pass regression).
 * Writes evals/negative-baseline.json for CI proof.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatSuiteReport,
  runEvalSuite,
  writeBaselineArtifact,
} from "./runner";

const here = path.dirname(fileURLToPath(import.meta.url));
const negativesDir = path.join(here, "golden", "negative");
const negativeBaselinePath = path.join(here, "negative-baseline.json");

async function main(): Promise<void> {
  const report = await runEvalSuite({ fixturesDir: negativesDir });
  const artifact = await writeBaselineArtifact(report, negativeBaselinePath);
  const text = formatSuiteReport(report);
  console.log(text);
  console.log(`Wrote ${artifact.summaryLine}`);
  console.log("Negative baseline artifact: evals/negative-baseline.json");

  const unexpectedPasses = report.tasks.filter((task) => task.passed);
  if (report.fixtureCount === 0) {
    console.error("fail-audit: no negative fixtures found under evals/golden/negative/");
    process.exitCode = 1;
    return;
  }

  if (unexpectedPasses.length > 0) {
    console.error("fail-audit FAILED: known-bad fixtures unexpectedly PASSED:");
    for (const task of unexpectedPasses) {
      console.error(`  - ${task.id} (${task.kind}) score=${task.score}`);
    }
    console.error("A grader may be always-pass; harden mocks/deterministics before trusting baseline.");
    process.exitCode = 1;
    return;
  }

  console.log(
    `fail-audit OK: ${report.failedCount}/${report.fixtureCount} known-bad fixtures correctly FAILED ` +
      `(0 unexpected passes).`,
  );
  process.exitCode = 0;
}

main().catch((error: unknown) => {
  console.error("evals negatives harness crashed:", error);
  process.exitCode = 1;
});
