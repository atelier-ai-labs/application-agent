import {
  parseJobDiscoveryResponse,
  type JobDiscoveryBatch,
  type JobDiscoveryProvider,
} from "../domain/jobDiscovery";
import type { SearchCriteria } from "../domain/campaignTypes";
import type { DiscoveryContext } from "../domain/scout";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface JobDiscoveryHostClientOptions {
  baseUrl?: string;
  fetcher?: Fetcher;
  timeoutMs?: number;
  id?: string;
}
export class JobDiscoveryHostUnavailableError extends Error {
  constructor(message = "The local broad-discovery host is unavailable.") {
    super(message);
    this.name = "JobDiscoveryHostUnavailableError";
  }
}

export class JobDiscoveryHostResponseError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = "JobDiscoveryHostResponseError";
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
    throw new Error("Discovery host base URL must be an HTTP(S) URL.");
  }
}

async function responseError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && !Array.isArray(body) && "error" in body && typeof body.error === "string") {
      return body.error;
    }
  } catch {
    // Use the status below when the host did not return JSON.
  }
  return `The discovery host returned HTTP ${response.status}.`;
}

export class HttpJobDiscoveryProvider implements JobDiscoveryProvider {
  public readonly id: string;
  public readonly mode = "live" as const;
  private readonly baseUrl: string;
  private readonly fetcher: Fetcher;
  private readonly timeoutMs: number;

  constructor(options: JobDiscoveryHostClientOptions = {}) {
    this.id = options.id?.trim() || "brave-search-live";
    this.baseUrl = normalizedBaseUrl(options.baseUrl ?? defaultBaseUrl());
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Discovery host client timeout must be positive.");
    }
  }

  async discover(criteria: SearchCriteria, context?: DiscoveryContext): Promise<JobDiscoveryBatch> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new JobDiscoveryHostUnavailableError("The local broad-discovery host timed out or is not running."));
      }, this.timeoutMs);
    });
    try {
      let response: Response;
      try {
        response = await Promise.race([
          this.fetcher(`${this.baseUrl}/career-agent/discovery`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              criteria,
              ...(context?.maxResults !== undefined ? { maxResults: context.maxResults } : {}),
              ...(context?.now ? { now: context.now } : {}),
            }),
            signal: controller.signal,
          }),
          timeoutPromise,
        ]);
      } catch (error) {
        if (error instanceof JobDiscoveryHostUnavailableError) throw error;
        if (error instanceof Error && error.name === "AbortError") {
          throw new JobDiscoveryHostUnavailableError("The local broad-discovery host timed out or is not running.");
        }
        throw new JobDiscoveryHostUnavailableError("The local broad-discovery host could not be reached.");
      }
      if (!response.ok) throw new JobDiscoveryHostResponseError(await responseError(response), response.status);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new JobDiscoveryHostResponseError("The discovery host returned malformed JSON.", response.status);
      }
      return parseJobDiscoveryResponse(
        body,
        this.id,
        context?.now ?? new Date().toISOString(),
        context?.maxResults ?? 50,
      );
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }
}
