import { describe, expect, it, vi } from "vitest";
import { ApiRequestError, requestJson } from "../src/lib/api";

describe("requestJson", () => {
  it("turns a slow request into a timeout error", async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined));

    await expect(
      requestJson("https://project.example.test/data", {
        timeoutMs: 5,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ kind: "timeout" } satisfies Partial<ApiRequestError>);
  });

  it("turns non-2xx responses into a safe API error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, { status: 503, statusText: "Unavailable" }),
    );

    await expect(
      requestJson("https://project.example.test/data", { fetchImpl }),
    ).rejects.toMatchObject({ kind: "http", status: 503 });
  });

  it("rejects invalid URLs before making a request", async () => {
    const fetchImpl = vi.fn();

    await expect(requestJson("javascript:alert(1)", { fetchImpl })).rejects.toMatchObject({
      kind: "invalid-url",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
