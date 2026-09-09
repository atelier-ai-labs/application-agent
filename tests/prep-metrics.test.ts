import { describe, expect, it } from "vitest";
import {
  ExecutionTraceBuilder,
  createExecutionNodeTrace,
} from "../application-agent/src/domain/executionTrace";
import {
  formatMetricsLogLines,
  normalizePrepPipelineStage,
  prepTraceIdFor,
  summarizePrepMetrics,
} from "../application-agent/src/domain/prepMetrics";
import {
  buildSyntheticDryRunTraces,
  generateSampleMetricsReport,
} from "../application-agent/automation/observability/generateSampleMetrics";

const now = "2026-09-08T17:00:00.000Z";

describe("prep metrics observability", () => {
  it("normalizes existing stage vocabulary onto the Week-2 pipeline", () => {
    expect(normalizePrepPipelineStage("scout.total")).toBe("scout");
    expect(normalizePrepPipelineStage("job.fit")).toBe("fit");
    expect(normalizePrepPipelineStage("preparation.total")).toBe("prepare");
    expect(normalizePrepPipelineStage("preparation.blocker-evaluation")).toBe("needs_input");
    expect(normalizePrepPipelineStage("ready_to_submit")).toBe("ready_to_submit");
    expect(normalizePrepPipelineStage("execution.policy-check")).toBe("ready_to_submit");
  });

  it("correlates one application-prep via runId + jobId / prepTraceId", () => {
    const runId = "run-a";
    const jobId = "job-1";
    const prepTraceId = prepTraceIdFor(runId, jobId);
    const builder = new ExecutionTraceBuilder(runId, "campaign_run", () => now, now);
    builder.add(createExecutionNodeTrace({
      nodeId: "scout.fetch-and-reduce",
      nodeKind: "external_io",
      startedAt: now,
      completedAt: "2026-09-08T17:00:01.000Z",
      durationMs: 1_000,
      outcome: "success",
      metadata: { stage: "scout.total", jobId, prepTraceId },
    }));
    builder.add(createExecutionNodeTrace({
      nodeId: "job.fit.1",
      nodeKind: "judgment",
      startedAt: "2026-09-08T17:00:01.000Z",
      completedAt: "2026-09-08T17:00:02.000Z",
      durationMs: 1_000,
      outcome: "success",
      inputTokens: 100,
      outputTokens: 20,
      metadata: { stage: "job.fit", jobId, prepTraceId },
    }));
    builder.add(createExecutionNodeTrace({
      nodeId: "preparation.total.1",
      nodeKind: "judgment",
      startedAt: "2026-09-08T17:00:02.000Z",
      completedAt: "2026-09-08T17:00:03.500Z",
      durationMs: 1_500,
      outcome: "success",
      inputTokens: 200,
      outputTokens: 40,
      metadata: { stage: "preparation.total", jobId, prepTraceId },
    }));
    builder.add(createExecutionNodeTrace({
      nodeId: "execution.ready.1",
      nodeKind: "deterministic",
      startedAt: "2026-09-08T17:00:03.500Z",
      completedAt: "2026-09-08T17:00:03.700Z",
      durationMs: 200,
      outcome: "success",
      metadata: { stage: "ready_to_submit", jobId, prepTraceId },
    }));

    const report = summarizePrepMetrics([builder.finish("2026-09-08T17:00:03.700Z")], {
      generatedAt: now,
      source: "execution_traces",
    });
    expect(report.applicationPrepCount).toBe(1);
    expect(report.quote.prepareSuccessRate).toBe(1);
    expect(report.quote.humanAttentionRate).toBe(0);
    expect(report.tokens.input).toBe(300);
    expect(report.tokens.output).toBe(60);
    expect(report.stages.map((stage) => stage.stage)).toEqual([
      "scout",
      "fit",
      "prepare",
      "ready_to_submit",
    ]);
    expect(JSON.stringify(report)).not.toMatch(/@|password|phone|ssn/i);
  });

  it("computes attention + prepare-success rates across synthetic dry-run traces", () => {
    const traces = buildSyntheticDryRunTraces();
    expect(traces).toHaveLength(5);
    const report = generateSampleMetricsReport();
    expect(report.source).toBe("synthetic_dry_run");
    expect(report.applicationPrepCount).toBe(5);
    expect(report.quote.humanAttentionRate).toBe(0.4);
    expect(report.quote.prepareSuccessRate).toBe(0.8);
    expect(report.quote.costPerPrepUsd).toBeGreaterThan(0);
    expect(report.quote.endToEndP50LatencyMs).toBeGreaterThan(0);
    const lines = formatMetricsLogLines(report);
    expect(lines.some((line) => line.includes("$/application-prep="))).toBe(true);
    expect(JSON.stringify(report)).not.toContain("Alex Example");
    expect(JSON.stringify(traces)).not.toMatch(/gmail\.com|password/i);
  });
});
