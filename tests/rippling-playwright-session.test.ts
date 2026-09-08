/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
import { PlaywrightLeverBrowserSession } from "../application-agent/automation/playwrightLeverBrowserSession";

class DomLocator {
  constructor(private readonly elements: readonly Element[]) {}

  async count(): Promise<number> {
    return this.elements.length;
  }

  async evaluateAll<R>(callback: (elements: Element[]) => R): Promise<R> {
    return callback([...this.elements]);
  }

  async isVisible(): Promise<boolean> {
    return this.elements.length > 0;
  }
}

class DomPage {
  setDefaultTimeout(): void {}

  async waitForSelector(): Promise<void> {}

  locator(selector: string): DomLocator {
    return new DomLocator(Array.from(document.querySelectorAll(selector)));
  }
}

function sessionForDocument(): PlaywrightLeverBrowserSession {
  return new PlaywrightLeverBrowserSession(
    new DomPage() as unknown as Page,
    {} as BrowserContext,
    {} as Browser,
    5_000,
    {},
  );
}

describe("Rippling Playwright DOM integration", () => {
  it("uses the production inspectFields callback to extract an opaque custom prompt", async () => {
    document.body.innerHTML = `
      <form>
        <div class="question-block">
          <div class="paddingX--16">What is your expected salary? ✱</div>
          <div class="field-wrap">
            <input id="opaqueSalaryABC1" name="opaqueSalaryABC1" type="text" required>
          </div>
        </div>
      </form>
    `;

    const fields = await sessionForDocument().inspectFields();
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      id: "opaqueSalaryABC1",
      label: "What is your expected salary?",
      required: true,
      questionDescriptor: {
        promptText: "What is your expected salary?",
        sourceStrategy: "question_container",
        confidence: "high",
      },
    });
  });
});
