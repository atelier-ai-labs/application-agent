import type { DepartmentActivity, DepartmentSnapshot } from "../../types/department";
import type { DepartmentAdapter } from "./types";
import {
  apiUrl,
  isArray,
  isRecord,
  sourceFromEndpoint,
  stringValue,
  syntheticFrom,
  timestampFrom,
  unavailableSnapshot,
} from "./utils";

const METRIC_LABEL = "Latest experiment Sharpe";
const EXPERIMENTS_PATH = "api/experiments";

interface ExperimentSummary {
  experiment_id: string;
  symbol: string;
  strategy: string;
  parameters: Record<string, unknown>;
  requested_start: string | null;
  requested_end: string | null;
  actual_start: string;
  actual_end: string;
  initial_capital: number;
  total_return: number | null;
  benchmark: string;
  created_at: string | null;
  package_version: string | null;
}

interface ExperimentDetail {
  specification: Record<string, unknown>;
  actual_start: string;
  actual_end: string;
  states: readonly unknown[];
  trades: readonly unknown[];
  metrics: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function nullableTimestamp(value: unknown): value is string | null {
  return value === null || timestampFrom(value) !== undefined;
}

function finiteNumeric(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nullableNumber(value: unknown): value is number | null {
  return value === null || finiteNumeric(value);
}

function isExperimentSummary(value: unknown): value is ExperimentSummary {
  if (!isRecord(value)) {
    return false;
  }

  return (
    nonEmptyString(value.experiment_id) &&
    nonEmptyString(value.symbol) &&
    nonEmptyString(value.strategy) &&
    isRecord(value.parameters) &&
    nullableString(value.requested_start) &&
    nullableString(value.requested_end) &&
    nonEmptyString(value.actual_start) &&
    nonEmptyString(value.actual_end) &&
    finiteNumeric(value.initial_capital) &&
    nullableNumber(value.total_return) &&
    nonEmptyString(value.benchmark) &&
    hasOwn(value, "created_at") &&
    nullableTimestamp(value.created_at) &&
    nullableString(value.package_version)
  );
}

function isExperimentList(payload: unknown): payload is readonly ExperimentSummary[] {
  return isArray(payload) && payload.every(isExperimentSummary);
}

function isExperimentDetail(payload: unknown): payload is ExperimentDetail {
  if (!isRecord(payload)) {
    return false;
  }

  const specification = payload.specification;
  const metrics = payload.metrics;
  const metadata = payload.metadata;

  return (
    isRecord(specification) &&
    nonEmptyString(specification.name) &&
    nonEmptyString(payload.actual_start) &&
    nonEmptyString(payload.actual_end) &&
    isArray(payload.states) &&
    isArray(payload.trades) &&
    isRecord(metrics) &&
    hasOwn(metrics, "sharpe_ratio") &&
    nullableNumber(metrics.sharpe_ratio) &&
    (metadata === undefined || isRecord(metadata)) &&
    (metadata === undefined ||
      !hasOwn(metadata, "created_at") ||
      nullableTimestamp(metadata.created_at))
  );
}

function sharpeFrom(detail: ExperimentDetail): number | undefined {
  return finiteNumeric(detail.metrics.sharpe_ratio)
    ? detail.metrics.sharpe_ratio
    : undefined;
}

function activityFrom(
  summary: ExperimentSummary,
  detail: ExperimentDetail,
  observedAt: string | undefined,
  state: "live" | "synthetic",
  source: string,
): readonly DepartmentActivity[] {
  const strategy = stringValue(detail.specification.name) ?? summary.strategy;

  return [
    {
      label: "Latest experiment",
      value: `${strategy} · ${summary.experiment_id}`,
      observedAt,
      state,
      source,
    },
  ];
}

export const quantIntelligenceAdapter: DepartmentAdapter = {
  id: "quant-intelligence",
  async getSnapshot({ apiBaseUrl, now, requestJson }): Promise<DepartmentSnapshot> {
    if (!apiBaseUrl) {
      return unavailableSnapshot(
        METRIC_LABEL,
        "API base URL not configured",
        "Quant Intelligence API",
        now,
      );
    }

    const listEndpoint = apiUrl(apiBaseUrl, EXPERIMENTS_PATH);
    const source = sourceFromEndpoint(listEndpoint);
    const listPayload = await requestJson(listEndpoint);

    if (!isExperimentList(listPayload)) {
      return unavailableSnapshot(
        METRIC_LABEL,
        "Response did not match the Quant experiment summary schema",
        source,
        now,
      );
    }

    if (listPayload.length === 0) {
      return unavailableSnapshot(METRIC_LABEL, "No experiment found", source, now);
    }

    // The Quant API already returns summaries newest-first by created_at.
    // Keep that canonical ordering instead of reimplementing experiment semantics here.
    const latest = listPayload[0];
    const detailEndpoint = apiUrl(
      apiBaseUrl,
      `${EXPERIMENTS_PATH}/${encodeURIComponent(latest.experiment_id)}`,
    );
    const detailPayload = await requestJson(detailEndpoint);

    if (!isExperimentDetail(detailPayload)) {
      return unavailableSnapshot(
        METRIC_LABEL,
        "Latest experiment detail did not match the Quant result schema",
        source,
        now,
      );
    }

    const sharpe = sharpeFrom(detailPayload);
    if (sharpe === undefined) {
      return unavailableSnapshot(
        METRIC_LABEL,
        "Latest experiment did not include a numeric Sharpe ratio",
        source,
        now,
      );
    }

    const metadata = detailPayload.metadata;
    const metadataExperimentId = metadata ? stringValue(metadata.experiment_id) : undefined;
    if (metadataExperimentId && metadataExperimentId !== latest.experiment_id) {
      return unavailableSnapshot(
        METRIC_LABEL,
        "Latest experiment detail did not match the selected experiment",
        source,
        now,
      );
    }

    const observedAt = timestampFrom(metadata?.created_at, latest.created_at);
    const isSynthetic = syntheticFrom(detailPayload, metadata);
    const state = isSynthetic ? "synthetic" : "live";

    return {
      metric: {
        label: METRIC_LABEL,
        value: sharpe,
        state,
        observedAt,
        source,
        note: isSynthetic
          ? "The project API identified this result as synthetic."
          : `Canonical persisted experiment ${latest.experiment_id}.`,
      },
      activities: activityFrom(latest, detailPayload, observedAt, state, source),
      fetchedAt: now(),
    };
  },
};

export function isQuantResponse(payload: unknown): boolean {
  return isExperimentList(payload) || isExperimentDetail(payload);
}
