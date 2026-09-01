export type ApiRequestErrorKind =
  | "not-configured"
  | "invalid-url"
  | "timeout"
  | "http"
  | "network"
  | "malformed-json";

export class ApiRequestError extends Error {
  readonly kind: ApiRequestErrorKind;
  readonly status?: number;

  constructor(kind: ApiRequestErrorKind, message: string, status?: number) {
    super(message);
    this.name = "ApiRequestError";
    this.kind = kind;
    this.status = status;
  }
}

export interface RequestJsonOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function validHttpUrl(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export async function requestJson(
  endpoint: string,
  { signal, timeoutMs = 8_000, fetchImpl = fetch }: RequestJsonOptions = {},
): Promise<unknown> {
  if (!endpoint.trim()) {
    throw new ApiRequestError("not-configured", "API endpoint not configured");
  }

  if (!validHttpUrl(endpoint)) {
    throw new ApiRequestError("invalid-url", "Configured endpoint is not a valid HTTP URL");
  }

  const controller = new AbortController();
  let didTimeout = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const abortFromCaller = () => controller.abort();
  signal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    const response = await Promise.race([
      fetchImpl(endpoint, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      }),
      new Promise<Response>((_, reject) => {
        timeoutId = setTimeout(() => {
          didTimeout = true;
          controller.abort();
          reject(new ApiRequestError("timeout", "Project API request timed out"));
        }, timeoutMs);
      }),
    ]);

    if (!response.ok) {
      throw new ApiRequestError(
        "http",
        `Project API returned HTTP ${response.status}`,
        response.status,
      );
    }

    try {
      return await response.json();
    } catch {
      throw new ApiRequestError("malformed-json", "Project API returned invalid JSON");
    }
  } catch (error) {
    if (error instanceof ApiRequestError) {
      throw error;
    }

    if (didTimeout) {
      throw new ApiRequestError("timeout", "Project API request timed out");
    }

    if (signal?.aborted) {
      throw new ApiRequestError("network", "Project API request was cancelled");
    }

    throw new ApiRequestError("network", "Project API unreachable");
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    signal?.removeEventListener("abort", abortFromCaller);
  }
}
