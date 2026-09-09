# Week-2 observability (application-prep metrics)

Operational telemetry for one application-prep run across the pipeline:

`scout → fit → prepare → needs_input/blocker → ready_to_submit`

This builds on the existing `ExecutionTraceBuilder` in
`application-agent/src/domain/executionTrace.ts` (stage summaries, human-attention
events, optional token/cost fields). Traces remain **operational only** — no
profile content, answers, cookies, or page HTML.

## How to read the sample artifact

Open [`observability/metrics-sample.json`](./observability/metrics-sample.json).

1. **`quote`** — portfolio one-liners: end-to-end latency (mean / p50 / p95),
   `$/application-prep`, human-attention rate, prepare-success rate.
2. **`stages[]`** — per-pipeline-stage latency (`meanMs`, `p50Ms`, `p95Ms`,
   `maxMs`) plus token totals where LLM-ish nodes recorded them.
3. **`tokens`** — aggregate input/output tokens and `estimatedCostUsd`.
4. **`pricingAssumptions`** — documented USD-per-1M rates used when nodes lack
   `estimatedCost` (default small-model table in `prepMetricsTypes.ts`).
5. **`humanAttentionRate`** — `needs_input` prep units ÷ total application-prep
   units (correlated by `prepTraceId` = `runId:jobId`).
6. **`prepareSuccessRate`** — prep units that reached `ready_to_submit` (or
   successful preparation without an open blocker) ÷ total units.

Correlation: every node should carry `metadata.stage` (existing vocabulary such
as `scout.total`, `job.fit`, `preparation.total`, …) and preferably
`metadata.jobId`. Use `prepStageMetadata(runId, jobId, stage)` when measuring
nodes. The summarizer normalizes stages into the Week-2 pipeline list and joins
one prep with `metadata.prepTraceId` or `runId + jobId`.

Live campaign runs also emit the same log lines from
`application-agent/automation/runtime/run.ts` when
`ATELIER_CAREER_AGENT_RUN_ON_START=true` and a trace is present.

## Generate / refresh the sample (offline)

```bash
npm run observability:sample
# alias:
npm run test:observability
```

Runs `application-agent/automation/observability/runSample.ts` (synthetic traces from `generateSampleMetrics.ts`):
synthetic dry-run traces only (fake example job ids, no Playwright, no live
submit). Writes `docs/observability/metrics-sample.json` and prints log lines.

## Unit test

```bash
npx vitest run tests/prep-metrics.test.ts
```

## Constraints unchanged

- HITL submit stays fail-closed (`authority: "never"` paths untouched).
- No new ATS adapters, no Datadog, no secrets/PII in sample artifacts.
