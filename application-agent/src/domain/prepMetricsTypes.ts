/**
 * Stable application-prep pipeline stages for correlating one prep across
 * scout → fit → prepare → needs_input → ready_to_submit.
 * Existing node metadata.stage values (scout.*, job.fit, preparation.*, …)
 * normalize into this vocabulary via {@link normalizePrepPipelineStage}.
 */
export const PREP_PIPELINE_STAGES = [
  "scout",
  "fit",
  "prepare",
  "needs_input",
  "ready_to_submit",
] as const;

export type PrepPipelineStage = (typeof PREP_PIPELINE_STAGES)[number];

/**
 * Documented pricing table for estimated $/application-prep.
 * Dry-run / local deterministic paths often report 0 tokens; live LLM nodes
 * should populate inputTokens/outputTokens (or estimatedCost) on the trace.
 *
 * Assumptions (USD per 1M tokens), approximate mid-2026 small-model rates:
 * - input:  $0.15 / 1M tokens
 * - output: $0.60 / 1M tokens
 * Override via {@link PricingAssumptions} when summarizing live runs.
 */
export const DEFAULT_TOKEN_PRICING_USD_PER_1M = {
  input: 0.15,
  output: 0.6,
  modelLabel: "default-small-llm (documented assumption)",
} as const;

export interface PricingAssumptions {
  /** USD per 1M input tokens. */
  inputUsdPer1M: number;
  /** USD per 1M output tokens. */
  outputUsdPer1M: number;
  modelLabel: string;
  notes?: string;
}

export interface StageLatencyStats {
  stage: PrepPipelineStage | string;
  sampleCount: number;
  meanMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface MetricsReport {
  generatedAt: string;
  source: "synthetic_dry_run" | "execution_traces";
  runCount: number;
  /** Distinct prepTraceId / (runId+jobId) application-prep units. */
  applicationPrepCount: number;
  stages: readonly StageLatencyStats[];
  tokens: {
    input: number;
    output: number;
    estimatedCostUsd: number;
  };
  /** Mean estimated LLM cost per application-prep unit. */
  costPerApplicationPrepUsd: number;
  /**
   * Fraction of application-prep units that recorded a needs_input /
   * human-attention outcome (needs_input count / total preps).
   */
  humanAttentionRate: number;
  /**
   * Fraction of application-prep units that reached prepare success
   * (ready_to_submit or successful preparation without open blocker).
   */
  prepareSuccessRate: number;
  pricingAssumptions: PricingAssumptions;
  /** One-line portfolio quotes. */
  quote: {
    endToEndMeanLatencyMs: number;
    endToEndP50LatencyMs: number;
    endToEndP95LatencyMs: number;
    costPerPrepUsd: number;
    humanAttentionRate: number;
    prepareSuccessRate: number;
  };
}

export interface SummarizePrepMetricsOptions {
  pricing?: Partial<PricingAssumptions>;
  generatedAt?: string;
  source?: MetricsReport["source"];
}

/** Build a stable prep correlation id from campaign runId + job id. */
export function prepTraceIdFor(runId: string, jobId: string): string {
  return `${runId}:${jobId}`;
}

/** Convenience metadata for measure() calls: stage + job correlation ids. */
export function prepStageMetadata(
  runId: string,
  jobId: string,
  stage: string,
  extra: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  return {
    stage,
    jobId,
    prepTraceId: prepTraceIdFor(runId, jobId),
    ...extra,
  };
}

/**
 * Map existing ExecutionTrace metadata.stage values onto the Week-2 pipeline
 * vocabulary. Unknown stages pass through unchanged for diagnostics.
 */
export function normalizePrepPipelineStage(stage: string | undefined): PrepPipelineStage | string {
  if (!stage) return "unknown";
  const value = stage.trim().toLowerCase();
  if (value === "scout" || value.startsWith("scout.")) return "scout";
  if (value === "fit" || value === "job.fit") return "fit";
  // Blocker / needs_input before preparation.* so preparation.blocker-* maps correctly.
  if (
    value === "needs_input" ||
    value === "blocker" ||
    value.includes("blocker") ||
    value.includes("needs_input") ||
    value === "campaign.readiness"
  ) {
    return "needs_input";
  }
  if (
    value === "prepare" ||
    value === "preparation" ||
    value.startsWith("preparation.") ||
    value === "job.application-create" ||
    value === "job.application-evaluate" ||
    value === "job.pursuit-policy" ||
    value === "job.hard-filter" ||
    value === "job.persist-discovered" ||
    value === "job.total"
  ) {
    return "prepare";
  }
  if (
    value === "ready_to_submit" ||
    value.startsWith("execution.") ||
    value === "tracker.sync" ||
    value === "tracker.retry"
  ) {
    return "ready_to_submit";
  }
  return stage;
}
