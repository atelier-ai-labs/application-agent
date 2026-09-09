/**
 * Offline synthetic dry-run for Week-2 observability sample artifact.
 * No Playwright, no live ATS, no network LLM calls — fake PII only.
 */
import {
  ExecutionTraceBuilder,
  createExecutionNodeTrace,
  type ExecutionNodeKind,
  type ExecutionNodeOutcome,
  type ExecutionRunTrace,
  type HumanAttentionCategory,
} from "../../src/domain/executionTrace";
import {
  prepTraceIdFor,
  summarizePrepMetrics,
  type MetricsReport,
} from "../../src/domain/prepMetrics";

const FIXED_GENERATED_AT = "2026-09-08T18:00:00.000Z";

function iso(base: string, offsetMs: number): string {
  return new Date(Date.parse(base) + offsetMs).toISOString();
}

interface SyntheticNode {
  nodeId: string;
  stage: string;
  durationMs: number;
  nodeKind?: ExecutionNodeKind;
  outcome?: ExecutionNodeOutcome;
  inputTokens?: number;
  outputTokens?: number;
  humanAttentionRequired?: boolean;
  humanAttentionCategory?: HumanAttentionCategory;
}

function buildSyntheticPrepTrace(options: {
  runId: string;
  jobId: string;
  startedAt: string;
  latencies: {
    scout: number;
    fit: number;
    prepare: number;
    needsInput?: number;
    readyToSubmit?: number;
  };
  tokens: { input: number; output: number };
  needsInput: boolean;
  prepareSuccess: boolean;
}): ExecutionRunTrace {
  const { runId, jobId, startedAt, latencies, tokens, needsInput, prepareSuccess } = options;
  const prepTraceId = prepTraceIdFor(runId, jobId);
  const builder = new ExecutionTraceBuilder(runId, "campaign_run", () => startedAt, startedAt);

  const nodes: SyntheticNode[] = [
    {
      nodeId: "scout.fetch-and-reduce",
      stage: "scout.total",
      durationMs: latencies.scout,
      nodeKind: "external_io",
    },
    {
      nodeId: `job.fit.${jobId}`,
      stage: "job.fit",
      durationMs: latencies.fit,
      nodeKind: "judgment",
      inputTokens: Math.floor(tokens.input * 0.35),
      outputTokens: Math.floor(tokens.output * 0.25),
    },
    {
      nodeId: `preparation.total.${jobId}`,
      stage: "preparation.total",
      durationMs: latencies.prepare,
      nodeKind: "judgment",
      inputTokens: Math.ceil(tokens.input * 0.65),
      outputTokens: Math.ceil(tokens.output * 0.75),
    },
  ];

  if (needsInput) {
    nodes.push({
      nodeId: `preparation.blocker-evaluation.${jobId}`,
      stage: "preparation.blocker-evaluation",
      durationMs: latencies.needsInput ?? 400,
      nodeKind: "human_gate",
      outcome: "blocked",
      humanAttentionRequired: true,
      humanAttentionCategory: "candidate_fact_missing",
    });
    builder.setHumanAttentionEvents(1, { candidate_fact_missing: 1 });
  }

  if (prepareSuccess) {
    nodes.push({
      nodeId: `execution.ready.${jobId}`,
      stage: "ready_to_submit",
      durationMs: latencies.readyToSubmit ?? 150,
      nodeKind: "deterministic",
      outcome: "success",
    });
  }

  let cursor = 0;
  for (const node of nodes) {
    const nodeStart = iso(startedAt, cursor);
    cursor += node.durationMs;
    const nodeEnd = iso(startedAt, cursor);
    builder.add(createExecutionNodeTrace({
      nodeId: node.nodeId,
      nodeKind: node.nodeKind ?? "deterministic",
      startedAt: nodeStart,
      completedAt: nodeEnd,
      durationMs: node.durationMs,
      outcome: node.outcome ?? "success",
      metadata: { stage: node.stage, jobId, prepTraceId },
      ...(node.inputTokens !== undefined ? { inputTokens: node.inputTokens } : {}),
      ...(node.outputTokens !== undefined ? { outputTokens: node.outputTokens } : {}),
      ...(node.humanAttentionRequired !== undefined ? { humanAttentionRequired: node.humanAttentionRequired } : {}),
      ...(node.humanAttentionCategory ? { humanAttentionCategory: node.humanAttentionCategory } : {}),
    }));
  }

  return builder.finish(iso(startedAt, cursor));
}

/** Five synthetic application-prep units (fake PII / example jobs only). */
export function buildSyntheticDryRunTraces(): ExecutionRunTrace[] {
  const base = "2026-09-08T17:00:00.000Z";
  return [
    buildSyntheticPrepTrace({
      runId: "run-sample-001",
      jobId: "job-example-platform",
      startedAt: base,
      latencies: { scout: 820, fit: 410, prepare: 1_240, readyToSubmit: 180 },
      tokens: { input: 2_400, output: 680 },
      needsInput: false,
      prepareSuccess: true,
    }),
    buildSyntheticPrepTrace({
      runId: "run-sample-001",
      jobId: "job-example-frontend",
      startedAt: iso(base, 4_000),
      latencies: { scout: 760, fit: 390, prepare: 1_180, needsInput: 520, readyToSubmit: 160 },
      tokens: { input: 2_100, output: 610 },
      needsInput: true,
      prepareSuccess: true,
    }),
    buildSyntheticPrepTrace({
      runId: "run-sample-002",
      jobId: "job-example-data",
      startedAt: iso(base, 12_000),
      latencies: { scout: 910, fit: 455, prepare: 1_520, readyToSubmit: 200 },
      tokens: { input: 2_800, output: 740 },
      needsInput: false,
      prepareSuccess: true,
    }),
    buildSyntheticPrepTrace({
      runId: "run-sample-002",
      jobId: "job-example-infra",
      startedAt: iso(base, 18_000),
      latencies: { scout: 880, fit: 430, prepare: 1_350, needsInput: 610 },
      tokens: { input: 2_250, output: 590 },
      needsInput: true,
      prepareSuccess: false,
    }),
    buildSyntheticPrepTrace({
      runId: "run-sample-003",
      jobId: "job-example-ml",
      startedAt: iso(base, 26_000),
      latencies: { scout: 790, fit: 380, prepare: 1_100, readyToSubmit: 150 },
      tokens: { input: 1_950, output: 520 },
      needsInput: false,
      prepareSuccess: true,
    }),
  ];
}

export function generateSampleMetricsReport(): MetricsReport {
  return summarizePrepMetrics(buildSyntheticDryRunTraces(), {
    generatedAt: FIXED_GENERATED_AT,
    source: "synthetic_dry_run",
    pricing: {
      notes: "Synthetic dry-run: tokens are illustrative estimates for portfolio quoting; no live model billed.",
    },
  });
}
