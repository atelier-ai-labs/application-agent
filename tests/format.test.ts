import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "../src/lib/format";

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-11-20T12:00:00Z");

  it("treats a timestamp slightly ahead of this clock as recent, not missing", () => {
    expect(formatRelativeTime("2026-11-20T12:00:30Z", now)).toBe("just now");
  });

  it("still says when a timestamp is missing or unreadable", () => {
    expect(formatRelativeTime(undefined, now)).toBe("Timestamp not supplied");
    expect(formatRelativeTime("nope", now)).toBe("Timestamp unavailable");
  });

  it("formats past times", () => {
    expect(formatRelativeTime("2026-11-20T11:58:00Z", now)).toBe("2m ago");
  });
});
