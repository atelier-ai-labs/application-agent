import type { DepartmentMetric } from "../types/department";
import { formatRelativeTime } from "../lib/format";
import { MetricStatePill } from "./StatusPill";

interface DataProvenanceProps {
  metric: DepartmentMetric;
  fetchedAt?: string;
  isRefreshing?: boolean;
  className?: string;
}

export function DataProvenance({
  metric,
  fetchedAt,
  isRefreshing = false,
  className = "",
}: DataProvenanceProps) {
  const timestamp = metric.observedAt ?? fetchedAt;
  const timeLabel = metric.observedAt
    ? `observed ${formatRelativeTime(metric.observedAt)}`
    : fetchedAt
      ? `fetched ${formatRelativeTime(fetchedAt)}`
      : "timestamp not supplied";

  return (
    <div className={`data-provenance ${className}`.trim()}>
      <MetricStatePill state={metric.state} compact />
      <span className="provenance-time">{timeLabel}</span>
      {metric.source ? <span className="provenance-source">Source: {metric.source}</span> : null}
      {isRefreshing ? <span className="refreshing-label">Refreshing</span> : null}
    </div>
  );
}
