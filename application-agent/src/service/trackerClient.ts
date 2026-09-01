import {
  isJobTrackerResult,
  isJobTrackerSyncRequest,
  type JobTracker,
  type JobTrackerResult,
  type JobTrackerSyncContext,
  type JobTrackerUpdate,
} from "../domain/tracker";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface TrackerClientOptions {
  baseUrl?: string;
  fetcher?: Fetcher;
  timeoutMs?: number;
}

export class TrackerHostUnavailableError extends Error {
  constructor(message = "The local Google Sheets tracker host is unavailable.") {
    super(message);
    this.name = "TrackerHostUnavailableError";
  }
}

export class TrackerHostResponseError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = "TrackerHostResponseError";
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
    throw new Error("Tracker host base URL must be an HTTP(S) URL.");
  }
}

async function responseError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && !Array.isArray(body) && "error" in body && typeof body.error === "string") {
      return body.error;
    }
  } catch {
    // Fall through to a status-only message.
  }
  return `The tracker host returned HTTP ${response.status}.`;
}

/** Typed browser client for the narrow local tracker-sync route. */
export class HttpGoogleSheetsJobTracker implements JobTracker {
  public readonly id = "google-sheets-local-host";
  private readonly baseUrl: string;
  private readonly fetcher: Fetcher;
  private readonly timeoutMs: number;

  constructor(options: TrackerClientOptions = {}) {
    this.baseUrl = normalizedBaseUrl(options.baseUrl ?? defaultBaseUrl());
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("Tracker host client timeout must be positive.");
  }

  async recordApplied(update: JobTrackerUpdate, context?: JobTrackerSyncContext): Promise<JobTrackerResult> {
    if (!context || !isJobTrackerSyncRequest({ mode: "google_sheets", context, update })) {
      return {
        ok: false,
        simulated: false,
        error: "Tracker sync requires a validated applied application context.",
      };
    }
    return this.call({ mode: "google_sheets", context, update });
  }

  private async call(request: {
    mode: "google_sheets";
    context: JobTrackerSyncContext;
    update: JobTrackerUpdate;
  }): Promise<JobTrackerResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetcher(`${this.baseUrl}/career-agent/tracker-sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new TrackerHostUnavailableError("The local Google Sheets tracker host timed out or is not running.");
        }
        throw new TrackerHostUnavailableError("The local Google Sheets tracker host could not be reached.");
      }
      if (!response.ok) throw new TrackerHostResponseError(await responseError(response), response.status);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new TrackerHostResponseError("The tracker host returned malformed JSON.", response.status);
      }
      if (!isJobTrackerResult(body)) {
        throw new TrackerHostResponseError("The tracker host returned a malformed tracker result.", response.status);
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }
}
