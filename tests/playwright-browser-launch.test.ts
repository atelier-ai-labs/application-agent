import { describe, expect, it, vi } from "vitest";
import { chromium } from "playwright";
import { PlaywrightLeverBrowserSessionFactory } from "../application-agent/automation/playwrightLeverBrowserSession";

describe("PlaywrightLeverBrowserSessionFactory launch args", () => {
  it("launches chromium with sandbox-disabling args for restricted environments", async () => {
    const launchSpy = vi.spyOn(chromium, "launch").mockResolvedValue({
      newContext: async () => ({
        newPage: async () => ({}) as any,
        close: async () => {},
      }),
      close: async () => {},
    } as any);

    const factory = new PlaywrightLeverBrowserSessionFactory({ headless: true });
    // open() will create context/page, but our mock returns minimal stubs,
    // so it will succeed to browser stage and then create session; we only care about launch args
    try {
      await factory.open("test-app-id");
    } catch {
      // ignore page/context errors, launch spy already captured
    }

    expect(launchSpy).toHaveBeenCalledTimes(1);
    const args = launchSpy.mock.calls[0]?.[0] as any;
    expect(args.headless).toBe(true);
    expect(args.args).toEqual(
      expect.arrayContaining([
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ]),
    );
    launchSpy.mockRestore();
  });

  it("propagates headless false and slowMo to chromium.launch", async () => {
    const launchSpy = vi.spyOn(chromium, "launch").mockResolvedValue({
      newContext: async () => ({
        newPage: async () => ({}) as any,
      }),
      close: async () => {},
    } as any);
    const factory = new PlaywrightLeverBrowserSessionFactory({ headless: false, slowMo: 50 });
    try {
      await factory.open("test-app-id-2");
    } catch {}
    const args = launchSpy.mock.calls[0]?.[0] as any;
    expect(args.headless).toBe(false);
    expect(args.slowMo).toBe(50);
    launchSpy.mockRestore();
  });
});
