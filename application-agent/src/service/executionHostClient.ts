import type {
  ExecutionHostRequest,
  ExecutionHostSnapshot,
} from "../domain/executionHostTypes";
import { isExecutionHostSnapshot } from "../domain/executionHostValidation";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ExecutionHostClientOptions {
  baseUrl?: string;
  fetcher?: Fetcher;
  timeoutMs?: number;
}

export class ExecutionHostUnavailableError extends Error {
  constructor(message = "The local real browser executor is unavailable.") {
    super(message);
    this.name = "ExecutionHostUnavailableError";
  }
}

export class ExecutionHostResponseError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "ExecutionHostResponseError";
  }
}

function defaultBaseUrl(): string {
  return import.meta.env.VITE_EXECUTION_HOST_BASE_URL?.trim() || "http://127.0.0.1:8787";
}

function normalizedBaseUrl(value: string): string {
  const base = value.trim().replace(/\/+$/, "");
  try {
    const url = new URL(base);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw new Error("Execution host base URL must be an HTTP(S) URL.");
  }
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && !Array.isArray(body) && "error" in body && typeof body.error === "string") {
      return body.error;
    }
  } catch {
    // Fall through to a status-only message.
  }
  return `The execution host returned HTTP ${response.status}.`;
}

export class HttpExecutionHostClient {
  private readonly baseUrl: string;
  private readonly fetcher: Fetcher;
  private readonly timeoutMs: number;

  constructor(options: ExecutionHostClientOptions = {}) {
    this.baseUrl = normalizedBaseUrl(options.baseUrl ?? defaultBaseUrl());
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("Execution host client timeout must be positive.");
  }

  start(request: ExecutionHostRequest): Promise<ExecutionHostSnapshot> {
    return this.call("/career-agent/executions", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  get(executionId: string): Promise<ExecutionHostSnapshot> {
    return this.call(`/career-agent/executions/${encodeURIComponent(executionId)}`, { method: "GET" });
  }

  resume(executionId: string, request?: ExecutionHostRequest): Promise<ExecutionHostSnapshot> {
    return this.call(`/career-agent/executions/${encodeURIComponent(executionId)}/resume`, {
      method: "POST",
      ...(request ? { body: JSON.stringify(request) } : {}),
    });
  }

  cancel(executionId: string): Promise<ExecutionHostSnapshot> {
    return this.call(`/career-agent/executions/${encodeURIComponent(executionId)}/cancel`, { method: "POST" });
  }

  private async call(
    path: string,
    init: RequestInit,
  ): Promise<ExecutionHostSnapshot> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetcher(`${this.baseUrl}${path}`, {
          ...init,
          ...(init.body !== undefined ? {
            headers: {
              "Content-Type": "application/json",
              ...(init.headers ?? {}),
            },
          } : init.headers ? { headers: init.headers } : {}),
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new ExecutionHostUnavailableError("The local real browser executor timed out or is not running.");
        }
        throw new ExecutionHostUnavailableError("The local real browser executor could not be reached.");
      }

      if (!response.ok) {
        throw new ExecutionHostResponseError(await errorMessage(response), response.status);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ExecutionHostResponseError("The execution host returned malformed JSON.", response.status);
      }
      if (!isExecutionHostSnapshot(body)) {
        throw new ExecutionHostResponseError("The execution host returned a malformed execution snapshot.", response.status);
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }
}
