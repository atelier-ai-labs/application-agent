import { useEffect, useState } from "react";
import { adapters } from "../departments/adapters";
import type { DepartmentAdapter } from "../departments/adapters/types";
import { requestJson } from "../lib/api";
import type {
  DepartmentConfig,
  DepartmentMetric,
  DepartmentSnapshot,
} from "../types/department";

export const CACHE_FRESH_MS = 60_000;
export const RETRY_COOLDOWN_MS = 30_000;

export type DepartmentResourceStatus = "loading" | "success" | "error";

export interface DepartmentResource {
  status: DepartmentResourceStatus;
  data: DepartmentSnapshot | null;
  errorMessage: string | null;
  isRefreshing: boolean;
}

interface CacheEntry {
  snapshot: DepartmentSnapshot;
  storedAt: number;
  lastAttemptAt: number;
  errorMessage: string | null;
  promise?: Promise<DepartmentSnapshot>;
}

export type AdapterRegistry = Readonly<Record<string, DepartmentAdapter>>;

const cache = new Map<string, CacheEntry>();

function staleSnapshot(snapshot: DepartmentSnapshot): DepartmentSnapshot {
  const metric: DepartmentMetric = {
    ...snapshot.metric,
    state: snapshot.metric.state === "live" ? "stale" : snapshot.metric.state,
  };

  return {
    ...snapshot,
    metric,
  };
}

function fallbackSnapshot(config: DepartmentConfig, now: string): DepartmentSnapshot {
  return {
    metric: {
      label: config.metricLabel,
      value: null,
      state: "unavailable",
      source: config.dataSourceLabel,
      note: "No current data",
    },
    activities: [],
    fetchedAt: now,
  };
}

function cacheIsFresh(entry: CacheEntry, now: number): boolean {
  return now - entry.storedAt < CACHE_FRESH_MS && !entry.errorMessage;
}

function shouldRetry(entry: CacheEntry | undefined, now: number): boolean {
  return !entry || now - entry.lastAttemptAt >= RETRY_COOLDOWN_MS;
}

export function clearDepartmentCache(departmentId?: string): void {
  if (departmentId) {
    cache.delete(departmentId);
    return;
  }

  cache.clear();
}

export async function loadDepartmentSnapshot(
  config: DepartmentConfig,
  registry: AdapterRegistry = adapters,
): Promise<DepartmentSnapshot> {
  const adapter = registry[config.adapterId];
  if (!adapter) {
    throw new Error(`No adapter registered for ${config.adapterId}`);
  }

  return adapter.getSnapshot({
    apiBaseUrl: config.apiBaseUrl,
    now: () => new Date().toISOString(),
    requestJson: (endpoint, signal) => requestJson(endpoint, { signal }),
  });
}

export function useDepartmentData(
  config: DepartmentConfig,
  options: { registry?: AdapterRegistry } = {},
): DepartmentResource {
  const registry = options.registry ?? adapters;
  const [resource, setResource] = useState<DepartmentResource>(() => {
    const entry = cache.get(config.id);
    if (!entry) {
      return {
        status: "loading",
        data: null,
        errorMessage: null,
        isRefreshing: false,
      };
    }

    return {
      status: entry.errorMessage ? "error" : "success",
      data: entry.errorMessage ? staleSnapshot(entry.snapshot) : entry.snapshot,
      errorMessage: entry.errorMessage,
      isRefreshing: Boolean(entry.promise),
    };
  });

  useEffect(() => {
    let cancelled = false;
    const now = Date.now();
    let entry = cache.get(config.id);

    if (entry && cacheIsFresh(entry, now)) {
      setResource({
        status: "success",
        data: entry.snapshot,
        errorMessage: null,
        isRefreshing: false,
      });
      return () => {
        cancelled = true;
      };
    }

    if (entry && !shouldRetry(entry, now)) {
      setResource({
        status: entry.errorMessage ? "error" : "success",
        data: staleSnapshot(entry.snapshot),
        errorMessage: entry.errorMessage,
        isRefreshing: Boolean(entry.promise),
      });
      return () => {
        cancelled = true;
      };
    }

    if (entry?.promise) {
      setResource({
        status: "loading",
        data: entry.snapshot,
        errorMessage: null,
        isRefreshing: true,
      });
    } else {
      setResource({
        status: entry ? "success" : "loading",
        data: entry
          ? staleSnapshot(entry.snapshot)
          : fallbackSnapshot(config, new Date().toISOString()),
        errorMessage: null,
        isRefreshing: Boolean(entry),
      });
    }

    if (!entry?.promise) {
      const promise = loadDepartmentSnapshot(config, registry);
      entry = {
        snapshot: entry?.snapshot ?? fallbackSnapshot(config, new Date().toISOString()),
        storedAt: entry?.storedAt ?? now,
        lastAttemptAt: now,
        errorMessage: null,
        promise,
      };
      cache.set(config.id, entry);
    }

    const activePromise = entry.promise;
    if (!activePromise) {
      return () => {
        cancelled = true;
      };
    }

    activePromise
      .then((snapshot) => {
        if (cancelled) {
          return;
        }

        const nextEntry: CacheEntry = {
          snapshot,
          storedAt: Date.now(),
          lastAttemptAt: Date.now(),
          errorMessage: null,
        };
        cache.set(config.id, nextEntry);
        setResource({
          status: "success",
          data: snapshot,
          errorMessage: null,
          isRefreshing: false,
        });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Project API unreachable";
        const previous = cache.get(config.id);
        const snapshot = previous?.snapshot ?? fallbackSnapshot(config, new Date().toISOString());
        const nextEntry: CacheEntry = {
          snapshot,
          storedAt: previous?.storedAt ?? Date.now(),
          lastAttemptAt: Date.now(),
          errorMessage: message,
        };
        cache.set(config.id, nextEntry);

        if (!cancelled) {
          setResource({
            status: "error",
            data: staleSnapshot(snapshot),
            errorMessage: message,
            isRefreshing: false,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [config, registry]);

  return resource;
}
