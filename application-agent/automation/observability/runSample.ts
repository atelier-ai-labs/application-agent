import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatMetricsLogLines } from "../../src/domain/prepMetrics";
import { generateSampleMetricsReport } from "./generateSampleMetrics";

const outPath = process.env.OBSERVABILITY_SAMPLE_OUT?.trim()
  || resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/observability/metrics-sample.json");

const report = generateSampleMetricsReport();
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
for (const line of formatMetricsLogLines(report)) console.log(line);
console.log(`[observability] wrote ${outPath}`);
console.log(
  `[observability] quote: latency p50=${report.quote.endToEndP50LatencyMs}ms mean=${report.quote.endToEndMeanLatencyMs}ms | $/prep=${report.quote.costPerPrepUsd} | attention=${report.quote.humanAttentionRate} | prepareSuccess=${report.quote.prepareSuccessRate}`,
);
