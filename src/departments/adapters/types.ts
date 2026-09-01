import type { DepartmentSnapshot } from "../../types/department";

export interface AdapterRequestContext {
  apiBaseUrl?: string;
  now: () => string;
  requestJson: (endpoint: string, signal?: AbortSignal) => Promise<unknown>;
}

export interface DepartmentAdapter {
  id: string;
  getSnapshot: (context: AdapterRequestContext) => Promise<DepartmentSnapshot>;
}
