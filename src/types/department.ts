export type DepartmentStatus = "LIVE" | "IN DEVELOPMENT" | "PAUSED";

export type DepartmentMetricState =
  | "live"
  | "stale"
  | "unavailable"
  | "synthetic";

export type DepartmentCapability =
  | "viewRepo"
  | "openDeployment"
  | "askAgent"
  | "runExperiment"
  | "inspectCI"
  | "openWorkspace"
  | "delegateToCodex"
  | "reviewResults";

export interface DepartmentMetric {
  label: string;
  value: string | number | null;
  state: DepartmentMetricState;
  observedAt?: string;
  source?: string;
  note?: string;
}

export interface DepartmentActivity {
  label: string;
  value: string;
  state?: DepartmentMetricState;
  observedAt?: string;
  source?: string;
}

export interface DepartmentSnapshot {
  metric: DepartmentMetric;
  activities: readonly DepartmentActivity[];
  fetchedAt: string;
}

export interface DepartmentConfig {
  id: string;
  name: string;
  shortName: string;
  description: string;
  status: DepartmentStatus;
  metricLabel: string;
  repositoryUrl: string | null;
  deploymentUrl: string | null;
  techStack: readonly string[];
  adapterId: string;
  dataSourceLabel: string;
  /** Service root used by the department adapter for known read-only paths. */
  apiBaseUrl?: string;
  capabilities: readonly DepartmentCapability[];
}
