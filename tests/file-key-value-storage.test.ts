// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileKeyValueStorage } from "../application-agent/automation/runtime/fileKeyValueStorage";
import { DurableSubmissionAuthority } from "../application-agent/automation/executionHost/submissionAuthority";

const directories: string[] = [];
function location() {
  const directory = mkdtempSync(join(tmpdir(), "career-storage-test-"));
  directories.push(directory);
  return { directory, path: join(directory, "state.json") };
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("durable local state failures", () => {
  it.each(["not-json", '{"version":2,"values":{}}', '{"version":1,"values":{"jobs":3}}'])
    ("refuses to reset invalid existing state: %s", (raw) => {
      const { path } = location();
      writeFileSync(path, raw);
      expect(() => new FileKeyValueStorage(path)).toThrow(/Career Agent state/);
      expect(readFileSync(path, "utf8")).toBe(raw);
    });

  it("propagates read errors instead of creating an empty workspace", () => {
    const { path } = location();
    mkdirSync(path);
    expect(() => new FileKeyValueStorage(path)).toThrow("could not be read");
  });

  it("retains saved memory on failed replacements and removals, cleans temporary files, and can retry", () => {
    const { path, directory } = location();
    const storage = new FileKeyValueStorage(path);
    storage.setItem("jobs", "original");
    const original = readFileSync(path, "utf8");
    renameSync(path, `${path}.backup`);
    mkdirSync(path); // Deterministic rename failure, including when tests run as root.
    expect(() => storage.setItem("jobs", "unsaved")).toThrow();
    expect(storage.getItem("jobs")).toBe("original");
    expect(() => storage.removeItem("jobs")).toThrow();
    expect(storage.getItem("jobs")).toBe("original");
    expect(readFileSync(`${path}.backup`, "utf8")).toBe(original);
    expect(readdirSync(directory).some((entry) => entry.includes(".tmp-"))).toBe(false);
    rmSync(path, { recursive: true });
    renameSync(`${path}.backup`, path);
    storage.setItem("jobs", "saved");
    expect(new FileKeyValueStorage(path).getItem("jobs")).toBe("saved");
    storage.removeItem("jobs");
    expect(new FileKeyValueStorage(path).getItem("jobs")).toBeNull();
  });

  it("round-trips special map keys without losing them during parsing", () => {
    const { path } = location();
    const storage = new FileKeyValueStorage(path);
    storage.setItem("__proto__", "value");
    expect(new FileKeyValueStorage(path).getItem("__proto__")).toBe("value");
  });

  it("re-enters the same async lock for a synchronous fence transaction without losing updates", async () => {
    const { path } = location();
    const storage = new FileKeyValueStorage(path);
    const authority = new DurableSubmissionAuthority("nested-lock-worker", { storage });
    await storage.withExclusiveLockAsync(async () => {
      storage.setItem("career-state", "before-fence");
      const fence = authority.claim("application-nested", "job-nested", "2026-09-25T00:00:00.000Z");
      authority.beforeClick(fence, "2026-09-25T00:00:01.000Z");
      authority.markUnknown(fence, "2026-09-25T00:00:02.000Z");
      storage.setItem("career-state", "after-fence");
      await Promise.resolve();
    });
    const persisted = new FileKeyValueStorage(path);
    expect(persisted.getItem("career-state")).toBe("after-fence");
    expect(new DurableSubmissionAuthority("nested-lock-worker", { storage: persisted }).get("application-nested", "job-nested")?.state).toBe("unknown");
  });
});
