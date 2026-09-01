import type { DepartmentMetricState, DepartmentStatus } from "../types/department";
import { stateClass, stateLabel } from "../lib/format";

interface MetricStatePillProps {
  state: DepartmentMetricState;
  compact?: boolean;
}

export function MetricStatePill({ state, compact = false }: MetricStatePillProps) {
  return (
    <span className={`state-pill ${stateClass(state)} ${compact ? "is-compact" : ""}`}>
      <span className="state-dot" />
      {stateLabel(state)}
    </span>
  );
}

export function DepartmentStatusPill({ status }: { status: DepartmentStatus }) {
  const className = status === "LIVE" ? "status-live" : status === "PAUSED" ? "status-paused" : "status-development";

  return <span className={`department-status ${className}`}>{status}</span>;
}
