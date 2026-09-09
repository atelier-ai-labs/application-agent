import type { ExecutionRunTrace } from "./executionTrace";
import {
  DEFAULT_TOKEN_PRICING_USD_PER_1M,
  PREP_PIPELINE_STAGES,
  normalizePrepPipelineStage,
  prepTraceIdFor,
  type MetricsReport,
  type PricingAssumptions,
  type StageLatencyStats,
  type SummarizePrepMetricsOptions,
} from "./prepMetricsTypes";

export * from "./prepMetricsTypes";

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low]!;
  const weight = rank - low;
  return sorted[low]! * (1 - weight) + sorted[high]! * weight;
}

function roundMs(value: number): number {
  return Math.max(0, Math.round(value));
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  pricing: PricingAssumptions,
  nodeEstimatedCostSum: number,
): number {
  if (nodeEstimatedCostSum > 0) return roundUsd(nodeEstimatedCostSum);
  const fromTokens =
    (inputTokens / 1_000_000) * pricing.inputUsdPer1M +
    (outputTokens / 1_000_000) * pricing.outputUsdPer1M;
  return roundUsd(fromTokens);
}

interface PrepUnit {
  prepTraceId: string;
  runId: string;
  stageDurations: Map<string, number[]>;
  stageInputTokens: Map<string, number>;
  stageOutputTokens: Map<string, number>;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  hadNeedsInput: boolean;
  prepareSucceeded: boolean;
  endToEndMs: number;
}

function resolvePrepTraceId(runId: string, metadata: Readonly<Record<string, string>> | undefined): string {
  if (metadata?.prepTraceId) return metadata.prepTraceId;
  if (metadata?.jobId) return prepTraceIdFor(runId, metadata.jobId);
  return prepTraceIdFor(runId, "campaign");
}

function collectPrepUnits(traces: readonly ExecutionRunTrace[]): PrepUnit[] {
  const units = new Map<string, PrepUnit>();

  for (const trace of traces) {
    for (const node of trace.nodes) {
      const prepTraceId = resolvePrepTraceId(trace.runId, node.metadata);
      let unit = units.get(prepTraceId);
      if (!unit) {
        unit = {
          prepTraceId,
          runId: trace.runId,
          stageDurations: new Map(),
          stageInputTokens: new Map(),
          stageOutputTokens: new Map(),
          inputTokens: 0,
          outputTokens: 0,
          estimatedCost: 0,
          hadNeedsInput: false,
          prepareSucceeded: false,
          endToEndMs: 0,
        };
        units.set(prepTraceId, unit);
      }

      const pipelineStage = normalizePrepPipelineStage(node.metadata?.stage ?? node.nodeId);
      const duration = node.exclusiveDurationMs ?? node.durationMs;
      const bucket = unit.stageDurations.get(pipelineStage) ?? [];
      bucket.push(duration);
      unit.stageDurations.set(pipelineStage, bucket);

      const nodeIn = node.inputTokens ?? 0;
      const nodeOut = node.outputTokens ?? 0;
      unit.stageInputTokens.set(pipelineStage, (unit.stageInputTokens.get(pipelineStage) ?? 0) + nodeIn);
      unit.stageOutputTokens.set(pipelineStage, (unit.stageOutputTokens.get(pipelineStage) ?? 0) + nodeOut);
      unit.inputTokens += nodeIn;
      unit.outputTokens += nodeOut;
      unit.estimatedCost += node.estimatedCost ?? 0;

      if (
        pipelineStage === "needs_input" ||
        node.humanAttentionRequired === true ||
        node.outcome === "blocked" ||
        node.nodeKind === "human_gate"
      ) {
        unit.hadNeedsInput = true;
      }
      if (pipelineStage === "ready_to_submit" && (node.outcome === "success" || node.outcome === "partial")) {
        unit.prepareSucceeded = true;
      }
      if (
        pipelineStage === "prepare" &&
        node.outcome === "success" &&
        node.metadata?.stage === "preparation.total"
      ) {
        // preparation.total success without a later blocker still counts toward prepare path;
        // final prepareSuccess prefers ready_to_submit when present.
        if (!unit.hadNeedsInput) unit.prepareSucceeded = true;
      }
    }

    // Attribute campaign-level human attention when a unit is campaign-scoped.
    if (trace.humanAttentionEvents > 0) {
      for (const unit of units.values()) {
        if (unit.runId === trace.runId && unit.prepTraceId.endsWith(":campaign")) {
          unit.hadNeedsInput = true;
        }
      }
    }
  }

  for (const unit of units.values()) {
    let total = 0;
    for (const durations of unit.stageDurations.values()) {
      total += durations.reduce((sum, value) => sum + value, 0);
    }
    // Prefer scout+fit+prepare+needs_input+ready wall when present.
    const pipelineTotal = PREP_PIPELINE_STAGES.reduce((sum, stage) => {
      const values = unit.stageDurations.get(stage) ?? [];
      return sum + values.reduce((inner, value) => inner + value, 0);
    }, 0);
    unit.endToEndMs = pipelineTotal > 0 ? pipelineTotal : total;
    // If we saw needs_input, prepare success means we still reached ready_to_submit.
    if (unit.hadNeedsInput && !(unit.stageDurations.get("ready_to_submit")?.length)) {
      unit.prepareSucceeded = false;
    }
  }

  return [...units.values()];
}

function stageStats(units: readonly PrepUnit[]): StageLatencyStats[] {
  const stages = new Map<string, { durations: number[]; input: number; output: number }>();

  for (const unit of units) {
    for (const [stage, durations] of unit.stageDurations) {
      const entry = stages.get(stage) ?? { durations: [], input: 0, output: 0 };
      entry.durations.push(...durations);
      entry.input += unit.stageInputTokens.get(stage) ?? 0;
      entry.output += unit.stageOutputTokens.get(stage) ?? 0;
      stages.set(stage, entry);
    }
  }

  const ordered = [
    ...PREP_PIPELINE_STAGES.filter((stage) => stages.has(stage)),
    ...[...stages.keys()].filter((stage) => !(PREP_PIPELINE_STAGES as readonly string[]).includes(stage)).sort(),
  ];

  return ordered.map((stage) => {
    const entry = stages.get(stage);
    const durations = [...(entry?.durations ?? [])].sort((a, b) => a - b);
    const sampleCount = durations.length;
    const sum = durations.reduce((total, value) => total + value, 0);
    return {
      stage,
      sampleCount,
      meanMs: sampleCount === 0 ? 0 : roundMs(sum / sampleCount),
      maxMs: sampleCount === 0 ? 0 : roundMs(Math.max(...durations)),
      p50Ms: roundMs(percentile(durations, 50)),
      p95Ms: roundMs(percentile(durations, 95)),
      totalInputTokens: entry?.input ?? 0,
      totalOutputTokens: entry?.output ?? 0,
    };
  });
}

/**
 * Summarize one or more execution traces into a portfolio-friendly metrics
 * report: per-stage latency, tokens, $/prep, human-attention rate, prepare-success.
 */
export function summarizePrepMetrics(
  traces: readonly ExecutionRunTrace[],
  options: SummarizePrepMetricsOptions = {},
): MetricsReport {
  const pricing: PricingAssumptions = {
    inputUsdPer1M: options.pricing?.inputUsdPer1M ?? DEFAULT_TOKEN_PRICING_USD_PER_1M.input,
    outputUsdPer1M: options.pricing?.outputUsdPer1M ?? DEFAULT_TOKEN_PRICING_USD_PER_1M.output,
    modelLabel: options.pricing?.modelLabel ?? DEFAULT_TOKEN_PRICING_USD_PER_1M.modelLabel,
    ...(options.pricing?.notes ? { notes: options.pricing.notes } : {
      notes: "Uses node.estimatedCost when present; otherwise input/output token rates above.",
    }),
  };

  const units = collectPrepUnits(traces);
  const inputTokens = units.reduce((sum, unit) => sum + unit.inputTokens, 0);
  const outputTokens = units.reduce((sum, unit) => sum + unit.outputTokens, 0);
  const nodeEstimatedCost = units.reduce((sum, unit) => sum + unit.estimatedCost, 0);
  const estimatedCostUsd = estimateCostUsd(inputTokens, outputTokens, pricing, nodeEstimatedCost);
  const applicationPrepCount = Math.max(units.length, 0);
  const needsInputCount = units.filter((unit) => unit.hadNeedsInput).length;
  const prepareSuccessCount = units.filter((unit) => unit.prepareSucceeded).length;
  const humanAttentionRate = applicationPrepCount === 0 ? 0 : needsInputCount / applicationPrepCount;
  const prepareSuccessRate = applicationPrepCount === 0 ? 0 : prepareSuccessCount / applicationPrepCount;
  const endToEnd = units.map((unit) => unit.endToEndMs).sort((a, b) => a - b);
  const endToEndMean = endToEnd.length === 0 ? 0 : endToEnd.reduce((sum, value) => sum + value, 0) / endToEnd.length;
  const costPerPrep = applicationPrepCount === 0 ? 0 : estimatedCostUsd / applicationPrepCount;

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    source: options.source ?? "execution_traces",
    runCount: traces.length,
    applicationPrepCount,
    stages: stageStats(units),
    tokens: {
      input: inputTokens,
      output: outputTokens,
      estimatedCostUsd,
    },
    costPerApplicationPrepUsd: roundUsd(costPerPrep),
    humanAttentionRate: Math.round(humanAttentionRate * 1000) / 1000,
    prepareSuccessRate: Math.round(prepareSuccessRate * 1000) / 1000,
    pricingAssumptions: pricing,
    quote: {
      endToEndMeanLatencyMs: roundMs(endToEndMean),
      endToEndP50LatencyMs: roundMs(percentile(endToEnd, 50)),
      endToEndP95LatencyMs: roundMs(percentile(endToEnd, 95)),
      costPerPrepUsd: roundUsd(costPerPrep),
      humanAttentionRate: Math.round(humanAttentionRate * 1000) / 1000,
      prepareSuccessRate: Math.round(prepareSuccessRate * 1000) / 1000,
    },
  };
}

/** Compact log lines suitable for CLI / campaign-runtime stdout. */
export function formatMetricsLogLines(report: MetricsReport): string[] {
  const lines = [
    `[observability] runs=${report.runCount} applicationPreps=${report.applicationPrepCount}`,
    `[observability] latency mean=${report.quote.endToEndMeanLatencyMs}ms p50=${report.quote.endToEndP50LatencyMs}ms p95=${report.quote.endToEndP95LatencyMs}ms`,
    `[observability] tokens in=${report.tokens.input} out=${report.tokens.output} estimatedCostUsd=${report.tokens.estimatedCostUsd}`,
    `[observability] $/application-prep=${report.quote.costPerPrepUsd} (pricing: ${report.pricingAssumptions.modelLabel}; in $${report.pricingAssumptions.inputUsdPer1M}/1M out $${report.pricingAssumptions.outputUsdPer1M}/1M)`,
    `[observability] humanAttentionRate=${report.quote.humanAttentionRate} prepareSuccessRate=${report.quote.prepareSuccessRate}`,
  ];
  for (const stage of report.stages) {
    lines.push(
      `[observability] stage=${stage.stage} n=${stage.sampleCount} mean=${stage.meanMs}ms p50=${stage.p50Ms}ms p95=${stage.p95Ms}ms max=${stage.maxMs}ms`,
    );
  }
  return lines;
}
