import type { DepartmentMetricState } from "../types/department";

export function formatMetricValue(value: string | number | null): string {
  if (value === null || value === undefined) {
    return "Unavailable";
  }

  if (typeof value === "number") {
    return new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 2,
    }).format(value);
  }

  return value;
}

export function formatRelativeTime(timestamp: string | undefined, now = Date.now()): string {
  if (!timestamp) {
    return "Timestamp not supplied";
  }

  const time = Date.parse(timestamp);
  if (Number.isNaN(time)) {
    return "Timestamp unavailable";
  }

  const deltaSeconds = Math.floor((now - time) / 1_000);
  if (deltaSeconds < 0) {
    return "Timestamp not supplied";
  }

  if (deltaSeconds < 10) {
    return "just now";
  }

  if (deltaSeconds < 60) {
    return `${deltaSeconds}s ago`;
  }

  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function stateLabel(state: DepartmentMetricState): string {
  switch (state) {
    case "live":
      return "Live";
    case "stale":
      return "Stale";
    case "synthetic":
      return "Synthetic data";
    case "unavailable":
      return "Unavailable";
  }
}

export function stateClass(state: DepartmentMetricState): string {
  return `state-${state}`;
}
