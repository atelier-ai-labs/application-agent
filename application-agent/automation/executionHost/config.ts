import { resolve, relative, isAbsolute } from "node:path";
import type { ResumeFamilyId } from "../../src/domain/types";
import type { GoogleSheetsEnvironment } from "../googleSheetsJobTracker";

export const DEFAULT_EXECUTION_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
] as const;

export interface ExecutionHostEnvironment extends GoogleSheetsEnvironment {
  ATELIER_EXECUTION_HOST?: string;
  ATELIER_EXECUTION_PORT?: string;
  ATELIER_EXECUTION_ALLOWED_ORIGINS?: string;
  ATELIER_EXECUTION_ALLOW_NON_LOOPBACK?: string;
  ATELIER_EXECUTION_HEADLESS?: string;
  ATELIER_EXECUTION_BROWSER_TIMEOUT_MS?: string;
  ATELIER_EXECUTION_MAX_CONCURRENT?: string;
  ATELIER_EXECUTION_SESSION_TIMEOUT_MS?: string;
  /** Server-only Brave Search configuration; never exposed to Vite. */
  ATELIER_BRAVE_SEARCH_API_KEY?: string;
  ATELIER_BRAVE_SEARCH_API_BASE_URL?: string;
  ATELIER_BRAVE_SEARCH_MAX_QUERIES?: string;
  ATELIER_BRAVE_SEARCH_MAX_RESULTS_PER_QUERY?: string;
  ATELIER_BRAVE_SEARCH_MAX_TOTAL_REFERENCES?: string;
  ATELIER_BRAVE_SEARCH_CACHE_TTL_MS?: string;
  ATELIER_BRAVE_SEARCH_TIMEOUT_MS?: string;
  ATELIER_BRAVE_SEARCH_COUNTRY?: string;
  ATELIER_BRAVE_SEARCH_LANGUAGE?: string;
  ATELIER_RESUME_ROOT?: string;
  ATELIER_RESUME_CLOUD_PLATFORM_PATH?: string;
  ATELIER_RESUME_FRONTEND_SOFTWARE_PATH?: string;
  ATELIER_RESUME_AI_PLATFORM_AGENTIC_PATH?: string;
}

export interface ExecutionHostConfig {
  host: string;
  port: number;
  allowedOrigins: readonly string[];
  allowNonLoopback: boolean;
  headless: boolean;
  browserTimeoutMs: number;
  maxConcurrent: number;
  sessionTimeoutMs: number;
  resumePaths: Partial<Record<ResumeFamilyId, string>>;
  braveSearch: {
    apiKey?: string;
    endpoint?: string;
    maxQueries: number;
    maxResultsPerQuery: number;
    maxTotalReferences: number;
    cacheTtlMs: number;
    timeoutMs: number;
    country?: string;
    searchLanguage?: string;
  };
}

const RESUME_ENV_KEYS: ReadonlyArray<readonly [ResumeFamilyId, keyof ExecutionHostEnvironment]> = [
  ["cloud-platform", "ATELIER_RESUME_CLOUD_PLATFORM_PATH"],
  ["frontend-software", "ATELIER_RESUME_FRONTEND_SOFTWARE_PATH"],
  ["ai-platform-agentic", "ATELIER_RESUME_AI_PLATFORM_AGENTIC_PATH"],
];

function positiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function nonNegativeInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer.`);
  return parsed;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const parsed = positiveInteger(value, fallback, label);
  if (parsed < minimum || parsed > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  return parsed;
}

function booleanValue(value: string | undefined, fallback: boolean, label: string): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${label} must be true or false.`);
}

function originList(value: string | undefined): readonly string[] {
  const values = value === undefined || value.trim() === ""
    ? [...DEFAULT_EXECUTION_ALLOWED_ORIGINS]
    : value.split(",").map((origin) => origin.trim()).filter(Boolean);
  return [...new Set(values)];
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/**
 * Resolve only configured local resume artifacts. Frontend requests never
 * supply paths; this configuration is read by the trusted Node process.
 */
export function resolveResumePathsFromEnv(env: ExecutionHostEnvironment): Partial<Record<ResumeFamilyId, string>> {
  const configured = RESUME_ENV_KEYS
    .map(([family, key]) => [family, env[key]] as const)
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0);
  if (configured.length === 0) return {};
  if (!env.ATELIER_RESUME_ROOT?.trim()) {
    throw new Error("ATELIER_RESUME_ROOT is required when a resume artifact is configured.");
  }
  const root = resolve(env.ATELIER_RESUME_ROOT);
  const paths: Partial<Record<ResumeFamilyId, string>> = {};
  for (const [family, rawPath] of configured) {
    if (!rawPath) continue;
    const candidate = resolve(rawPath);
    if (!isWithinRoot(root, candidate)) {
      throw new Error(`Resume artifact for ${family} must be inside ATELIER_RESUME_ROOT.`);
    }
    paths[family] = candidate;
  }
  return paths;
}

export function resolveExecutionHostConfig(env: ExecutionHostEnvironment): ExecutionHostConfig {
  const host = env.ATELIER_EXECUTION_HOST?.trim() || "127.0.0.1";
  const port = positiveInteger(env.ATELIER_EXECUTION_PORT, 8787, "ATELIER_EXECUTION_PORT");
  if (port > 65_535) throw new Error("ATELIER_EXECUTION_PORT must be between 1 and 65535.");
  const allowNonLoopback = booleanValue(env.ATELIER_EXECUTION_ALLOW_NON_LOOPBACK, false, "ATELIER_EXECUTION_ALLOW_NON_LOOPBACK");
  const headless = booleanValue(env.ATELIER_EXECUTION_HEADLESS, false, "ATELIER_EXECUTION_HEADLESS");
  const browserTimeoutMs = positiveInteger(env.ATELIER_EXECUTION_BROWSER_TIMEOUT_MS, 15_000, "ATELIER_EXECUTION_BROWSER_TIMEOUT_MS");
  const maxConcurrent = positiveInteger(env.ATELIER_EXECUTION_MAX_CONCURRENT, 1, "ATELIER_EXECUTION_MAX_CONCURRENT");
  const sessionTimeoutMs = positiveInteger(env.ATELIER_EXECUTION_SESSION_TIMEOUT_MS, 30 * 60 * 1_000, "ATELIER_EXECUTION_SESSION_TIMEOUT_MS");
  const braveSearchApiKey = env.ATELIER_BRAVE_SEARCH_API_KEY?.trim() || undefined;
  const braveSearchEndpoint = env.ATELIER_BRAVE_SEARCH_API_BASE_URL?.trim() || undefined;
  return {
    host,
    port,
    allowedOrigins: originList(env.ATELIER_EXECUTION_ALLOWED_ORIGINS),
    allowNonLoopback,
    headless,
    browserTimeoutMs,
    maxConcurrent,
    sessionTimeoutMs,
    resumePaths: resolveResumePathsFromEnv(env),
    braveSearch: {
      ...(braveSearchApiKey ? { apiKey: braveSearchApiKey } : {}),
      ...(braveSearchEndpoint ? { endpoint: braveSearchEndpoint } : {}),
      maxQueries: boundedInteger(env.ATELIER_BRAVE_SEARCH_MAX_QUERIES, 3, 1, 10, "ATELIER_BRAVE_SEARCH_MAX_QUERIES"),
      maxResultsPerQuery: boundedInteger(env.ATELIER_BRAVE_SEARCH_MAX_RESULTS_PER_QUERY, 10, 1, 20, "ATELIER_BRAVE_SEARCH_MAX_RESULTS_PER_QUERY"),
      maxTotalReferences: boundedInteger(env.ATELIER_BRAVE_SEARCH_MAX_TOTAL_REFERENCES, 30, 1, 200, "ATELIER_BRAVE_SEARCH_MAX_TOTAL_REFERENCES"),
      cacheTtlMs: nonNegativeInteger(env.ATELIER_BRAVE_SEARCH_CACHE_TTL_MS, 5 * 60 * 1_000, "ATELIER_BRAVE_SEARCH_CACHE_TTL_MS"),
      timeoutMs: positiveInteger(env.ATELIER_BRAVE_SEARCH_TIMEOUT_MS, 8_000, "ATELIER_BRAVE_SEARCH_TIMEOUT_MS"),
      ...(env.ATELIER_BRAVE_SEARCH_COUNTRY?.trim() ? { country: env.ATELIER_BRAVE_SEARCH_COUNTRY.trim() } : {}),
      ...(env.ATELIER_BRAVE_SEARCH_LANGUAGE?.trim() ? { searchLanguage: env.ATELIER_BRAVE_SEARCH_LANGUAGE.trim() } : {}),
    },
  };
}
