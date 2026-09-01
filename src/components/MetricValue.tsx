import { formatMetricValue } from "../lib/format";

export function MetricValue({
  value,
  loading = false,
  className = "",
}: {
  value: string | number | null;
  loading?: boolean;
  className?: string;
}) {
  return (
    <span className={`metric-value ${loading ? "is-loading" : ""} ${className}`.trim()}>
      {loading ? <span className="metric-loading-bar" aria-label="Loading" /> : formatMetricValue(value)}
    </span>
  );
}
