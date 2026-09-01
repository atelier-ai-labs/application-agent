import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createPlaywrightLeverBrowserExecutor } from "../createLeverBrowserExecutor";
import type { ApplicationExecutor } from "../../src/domain/executor";
import type { ExecutionHostRequest } from "../../src/domain/executionHostTypes";
import { isExecutionHostRequest } from "../../src/domain/executionHostValidation";
import {
  isJobDiscoveryHostRequest,
  parseJobDiscoveryResponse,
  type JobDiscoveryProvider,
} from "../../src/domain/jobDiscovery";
import { BraveSearchDiscoveryProvider } from "../../src/domain/braveSearchDiscoveryProvider";
import {
  isJobTrackerResult,
  isJobTrackerSyncRequest,
  UnavailableJobTracker,
  type JobTracker,
} from "../../src/domain/tracker";
import { ExecutionHostRegistryError, ExecutionSessionRegistry, type ExecutionSessionRegistryOptions } from "./sessionRegistry";
import { createConfiguredGoogleSheetsJobTracker } from "../googleSheetsJobTracker";
import {
  DEFAULT_EXECUTION_ALLOWED_ORIGINS,
  resolveExecutionHostConfig,
  resolveResumePathsFromEnv,
  type ExecutionHostEnvironment,
} from "./config";

export interface ExecutionHostServerOptions extends Partial<Omit<ExecutionSessionRegistryOptions, "executor">> {
  executor?: ApplicationExecutor;
  tracker?: JobTracker;
  discoveryProvider?: JobDiscoveryProvider;
  registry?: ExecutionSessionRegistry;
  host?: string;
  port?: number;
  allowedOrigins?: readonly string[];
  maxBodyBytes?: number;
  allowNonLoopback?: boolean;
}

export interface ExecutionHostServer {
  server: Server;
  registry: ExecutionSessionRegistry;
  host: string;
  port: number;
  allowedOrigins: readonly string[];
  close(): Promise<void>;
}

const DEFAULT_ALLOWED_ORIGINS = DEFAULT_EXECUTION_ALLOWED_ORIGINS;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function safeError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  return message.replace(/\s+/g, " ").trim().slice(0, 500) || fallback;
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Execution host allowed origins must be exact HTTP origins.");
  }
  return url.origin;
}

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function setCommonHeaders(response: ServerResponse, origin: string | undefined, allowedOrigins: readonly string[]): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (origin && allowedOrigins.includes(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Vary", "Origin");
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  origin: string | undefined,
  allowedOrigins: readonly string[],
): void {
  setCommonHeaders(response, origin, allowedOrigins);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function errorStatus(error: unknown): number {
  if (error instanceof ExecutionHostRegistryError) {
    if (error.code === "not_found") return 404;
    if (error.code === "capacity" || error.code === "conflict" || error.code === "state") return 409;
    if (error.code === "payload_too_large") return 413;
    return 400;
  }
  return 500;
}

async function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    throw new ExecutionHostRegistryError("Request body exceeds the local execution host limit.", "payload_too_large");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBodyBytes) {
      throw new ExecutionHostRegistryError("Request body exceeds the local execution host limit.", "payload_too_large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ExecutionHostRegistryError("Request body must be valid JSON.", "invalid_request");
  }
}

function requestOrigin(request: IncomingMessage): string | undefined {
  const origin = request.headers.origin;
  return typeof origin === "string" ? origin : undefined;
}

function routeParts(pathname: string): readonly string[] {
  try {
    return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    throw new ExecutionHostRegistryError("Execution route contains an invalid identifier.", "invalid_request");
  }
}

export function createExecutionHostServer(options: ExecutionHostServerOptions): ExecutionHostServer {
  const host = options.host ?? "127.0.0.1";
  const allowNonLoopback = options.allowNonLoopback === true && process.env.ATELIER_EXECUTION_ALLOW_NON_LOOPBACK === "true";
  if (!isLoopback(host) && !allowNonLoopback) {
    throw new Error("The execution host must bind to loopback unless ATELIER_EXECUTION_ALLOW_NON_LOOPBACK=true is explicitly set.");
  }
  const port = options.port ?? 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Execution host port is invalid.");
  const maxBodyBytes = options.maxBodyBytes ?? 1_024 * 1_024;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) throw new Error("Execution host body limit is invalid.");
  const allowedOrigins = [...new Set((options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS).map(normalizeOrigin))];
  if (allowedOrigins.length === 0) throw new Error("At least one exact execution host origin is required.");

  const registry = options.registry ?? new ExecutionSessionRegistry({
    executor: options.executor ?? (() => { throw new Error("An application executor is required."); })(),
    ...(options.now ? { now: options.now } : {}),
    ...(options.createId ? { createId: options.createId } : {}),
    ...(options.maxConcurrent !== undefined ? { maxConcurrent: options.maxConcurrent } : {}),
    ...(options.sessionTimeoutMs !== undefined ? { sessionTimeoutMs: options.sessionTimeoutMs } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const tracker = options.tracker ?? new UnavailableJobTracker(
    "Google Sheets tracker is not configured; no canonical tracker write occurred.",
  );

  const server = createServer(async (request, response) => {
    const origin = requestOrigin(request);
    if (origin && !allowedOrigins.includes(origin)) {
      sendJson(response, 403, { error: "This origin is not allowed to use the local execution host." }, undefined, allowedOrigins);
      return;
    }
    setCommonHeaders(response, origin, allowedOrigins);

    try {
      const url = new URL(request.url ?? "/", `http://${host}`);
      const parts = routeParts(url.pathname);
      if (request.method === "OPTIONS") {
        const knownRoute = (parts.length === 1 && parts[0] === "health") ||
          (parts[0] === "career-agent" && (parts[1] === "executions" || parts[1] === "tracker-sync" || parts[1] === "discovery"));
        if (knownRoute) {
          sendJson(response, 204, {}, origin, allowedOrigins);
          return;
        }
        sendJson(response, 404, { error: "Route not found." }, origin, allowedOrigins);
        return;
      }

      if (request.method === "GET" && parts.length === 1 && parts[0] === "health") {
        sendJson(response, 200, { ok: true, mode: "real_local" }, origin, allowedOrigins);
        return;
      }

      if (parts[0] === "career-agent" && parts[1] === "discovery") {
        if (request.method !== "POST" || parts.length !== 2) {
          sendJson(response, 404, { error: "Route not found." }, origin, allowedOrigins);
          return;
        }
        const body = await readJsonBody(request, maxBodyBytes);
        if (!isJobDiscoveryHostRequest(body)) {
          throw new ExecutionHostRegistryError("Broad discovery requires validated search criteria.", "invalid_request");
        }
        if (!options.discoveryProvider) {
          sendJson(response, 200, {
            status: "not_configured",
            reason: "No broad discovery provider is configured for the trusted local host.",
            references: [],
          }, origin, allowedOrigins);
          return;
        }
        try {
          const discovered = await options.discoveryProvider.discover(body.criteria, {
            now: body.now ?? new Date().toISOString(),
            maxResults: body.maxResults ?? 50,
          });
          const normalized = parseJobDiscoveryResponse(
            discovered,
            options.discoveryProvider.id,
            body.now ?? new Date().toISOString(),
            body.maxResults ?? 50,
          );
          sendJson(response, 200, normalized, origin, allowedOrigins);
        } catch (error) {
          sendJson(response, 200, {
            status: "failed",
            reason: safeError(error, "The broad discovery provider failed."),
            warnings: [safeError(error, "The broad discovery provider failed.")],
            references: [],
          }, origin, allowedOrigins);
        }
        return;
      }

      if (parts[0] === "career-agent" && parts[1] === "tracker-sync") {
        if (request.method !== "POST" || parts.length !== 2) {
          sendJson(response, 404, { error: "Route not found." }, origin, allowedOrigins);
          return;
        }
        const body = await readJsonBody(request, maxBodyBytes);
        if (!isJobTrackerSyncRequest(body)) {
          throw new ExecutionHostRegistryError("Tracker sync requires a validated applied application request.", "invalid_request");
        }
        if (body.context.sourceMode !== "live" || body.update.proofMode === "simulated") {
          throw new ExecutionHostRegistryError("The real tracker host accepts live, non-simulated application evidence only.", "invalid_request");
        }
        const result = await tracker.recordApplied(body.update, body.context);
        if (!isJobTrackerResult(result)) {
          throw new ExecutionHostRegistryError("The tracker returned a malformed result.", "state");
        }
        sendJson(response, 200, result, origin, allowedOrigins);
        return;
      }

      if (parts[0] !== "career-agent" || parts[1] !== "executions") {
        sendJson(response, 404, { error: "Route not found." }, origin, allowedOrigins);
        return;
      }

      if (request.method === "POST" && parts.length === 2) {
        const body = await readJsonBody(request, maxBodyBytes);
        if (!isExecutionHostRequest(body)) {
          throw new ExecutionHostRegistryError("Execution start requires a valid campaign, career job, application packet, and profile.", "invalid_request");
        }
        sendJson(response, 202, registry.start(body), origin, allowedOrigins);
        return;
      }

      const executionId = parts[2];
      if (!executionId) {
        sendJson(response, 404, { error: "Execution route requires an ID." }, origin, allowedOrigins);
        return;
      }
      if (request.method === "GET" && parts.length === 3) {
        sendJson(response, 200, registry.get(executionId), origin, allowedOrigins);
        return;
      }
      if (request.method === "POST" && parts.length === 4 && parts[3] === "resume") {
        const body = await readJsonBody(request, maxBodyBytes);
        if (body !== undefined && !isExecutionHostRequest(body)) {
          throw new ExecutionHostRegistryError("Execution resume requires the current validated application request when a body is supplied.", "invalid_request");
        }
        sendJson(response, 202, registry.resume(executionId, body as ExecutionHostRequest | undefined), origin, allowedOrigins);
        return;
      }
      if (request.method === "POST" && parts.length === 4 && parts[3] === "cancel") {
        sendJson(response, 200, await registry.cancel(executionId), origin, allowedOrigins);
        return;
      }
      sendJson(response, 404, { error: "Route not found." }, origin, allowedOrigins);
    } catch (error) {
      sendJson(response, errorStatus(error), { error: safeError(error, "The local execution host could not complete the request.") }, origin, allowedOrigins);
    }
  });

  return {
    server,
    registry,
    host,
    port,
    allowedOrigins,
    close: async () => {
      await registry.closeAll();
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    },
  };
}

export interface ConfiguredExecutionHostOptions {
  env?: ExecutionHostEnvironment;
  now?: () => string;
  logger?: ExecutionSessionRegistryOptions["logger"];
}

export function createConfiguredExecutionHostServer(
  options: ConfiguredExecutionHostOptions = {},
): ExecutionHostServer {
  const config = resolveExecutionHostConfig(options.env ?? process.env);
  const executor = createPlaywrightLeverBrowserExecutor({
    headless: config.headless,
    timeoutMs: config.browserTimeoutMs,
    ...(Object.keys(config.resumePaths).length > 0 ? { resumePaths: config.resumePaths } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return createExecutionHostServer({
    executor,
    discoveryProvider: new BraveSearchDiscoveryProvider({
      ...config.braveSearch,
      ...(options.now ? { now: () => options.now?.() ?? new Date().toISOString() } : {}),
    }),
    tracker: createConfiguredGoogleSheetsJobTracker(options.env ?? process.env),
    host: config.host,
    port: config.port,
    allowedOrigins: config.allowedOrigins,
    allowNonLoopback: config.allowNonLoopback,
    maxConcurrent: config.maxConcurrent,
    sessionTimeoutMs: config.sessionTimeoutMs,
    ...(options.now ? { now: options.now } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
}

export { DEFAULT_ALLOWED_ORIGINS, readJsonBody, resolveExecutionHostConfig, resolveResumePathsFromEnv };
