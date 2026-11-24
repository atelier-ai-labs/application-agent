import type {
  DepartmentActivity,
  DepartmentMetric,
  DepartmentSnapshot,
} from "../../types/department";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function timestampFrom(...values: unknown[]): string | undefined {
  for (const value of values) {
    const candidate = stringValue(value);
    if (candidate && !Number.isNaN(Date.parse(candidate))) {
      return candidate;
    }
  }

  return undefined;
}

export function sourceFromEndpoint(endpoint?: string): string {
  if (!endpoint) {
    return "Project API endpoint";
  }

  try {
    return new URL(endpoint).hostname;
  } catch {
    return "Project API";
  }
}

export function apiUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\/+/, ""), normalizedBase).toString();
}

export function syntheticFrom(...values: unknown[]): boolean {
  return values.some((value) => {
    if (!isRecord(value)) {
      return value === true;
    }

    return (
      value.synthetic === true ||
      value.dataType === "synthetic" ||
      value.kind === "synthetic" ||
      (isRecord(value.provenance) &&
        (value.provenance.synthetic === true || value.provenance.kind === "synthetic"))
    );
  });
}

export function unavailableSnapshot(
  label: string,
  note: string,
  source: string,
  now: () => string,
): DepartmentSnapshot {
  const metric: DepartmentMetric = {
    label,
    value: null,
    state: "unavailable",
    source,
    note,
  };

  const activities: readonly DepartmentActivity[] = [];

  return {
    metric,
    activities,
    fetchedAt: now(),
  };
}
