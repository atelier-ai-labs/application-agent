/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import {
  extractRipplingAncestorPrompt,
  looksLikeOpaqueToken,
  looksLikePromptText,
  pickNearestUniqueByDistance,
  SEARCH_NEAR_PHONE_MARGIN_PX,
} from "../application-agent/automation/ripplingDomHelpers";

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

describe("extractRipplingAncestorPrompt", () => {
  it("extracts a Rippling-like paddingX--16 sibling prompt for an opaque id textbox", () => {
    mount(`
      <div class="question-block">
        <div class="paddingX--16">What is your expected salary? ✱</div>
        <div class="field-wrap">
          <input id="abc12XYZ99" name="abc12XYZ99" type="text" />
        </div>
      </div>
    `);
    const control = document.getElementById("abc12XYZ99")!;
    expect(extractRipplingAncestorPrompt(control)).toBe("What is your expected salary?");
  });

  it("does not steal the previous question prompt when questions are stacked", () => {
    mount(`
      <div class="stack">
        <div class="question-block">
          <div class="paddingX--16">First custom question?</div>
          <div class="field-wrap">
            <input id="opaqueAAAA01" type="text" />
          </div>
        </div>
        <div class="question-block">
          <div class="paddingX--16">Second custom question?</div>
          <div class="field-wrap">
            <input id="opaqueBBBB02" type="text" />
          </div>
        </div>
      </div>
    `);
    const second = document.getElementById("opaqueBBBB02")!;
    expect(extractRipplingAncestorPrompt(second)).toBe("Second custom question?");
    expect(extractRipplingAncestorPrompt(second)).not.toBe("First custom question?");
  });

  it("rejects opaque tokens, Search, and Select as prompts", () => {
    expect(looksLikeOpaqueToken("abc12XYZ99")).toBe(true);
    expect(looksLikeOpaqueToken("What is your salary?")).toBe(false);
    expect(looksLikePromptText("Search")).toBe(false);
    expect(looksLikePromptText("Select...")).toBe(false);
    expect(looksLikePromptText("abc12XYZ99")).toBe(false);
    expect(looksLikePromptText("Expected compensation range")).toBe(true);

    mount(`
      <div>
        <div>Search</div>
        <div>
          <input id="opaqueCCCC03" type="text" />
        </div>
      </div>
    `);
    expect(extractRipplingAncestorPrompt(document.getElementById("opaqueCCCC03")!)).toBeUndefined();
  });
});

describe("pickNearestUniqueByDistance", () => {
  const margin = SEARCH_NEAR_PHONE_MARGIN_PX;

  it("returns the uniquely nearest index when the margin clears the runner-up", () => {
    const phone = { x: 100, y: 200 };
    const points = [
      { x: 400, y: 500 },
      { x: 110, y: 205 },
      { x: 300, y: 200 },
    ];
    expect(pickNearestUniqueByDistance(phone, points, margin)).toBe(1);
  });

  it("returns null when two candidates are within the uniqueness margin", () => {
    const phone = { x: 100, y: 200 };
    const points = [
      { x: 100, y: 210 },
      { x: 108, y: 205 },
    ];
    expect(pickNearestUniqueByDistance(phone, points, margin)).toBeNull();
  });

  it("returns null for an empty candidate list", () => {
    expect(pickNearestUniqueByDistance({ x: 0, y: 0 }, [], margin)).toBeNull();
  });
});
