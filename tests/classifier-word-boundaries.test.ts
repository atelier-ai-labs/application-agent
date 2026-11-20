import { describe, expect, it } from "vitest";
import { classifyLeverApplicationField } from "../application-agent/src/domain/leverBrowserExecutor";

// Short keywords only match whole words (ported from PR #7, 2026-11-20).
const classify = (label: string, id = "q", type = "text") => classifyLeverApplicationField({ id, label, type });

describe("classifier word boundaries", () => {
  it("does not match keywords hidden inside other words", () => {
    expect(classify("How do you embrace feedback from your team?", "q", "textarea")).not.toBe("demographic");
    expect(classify("Describe a time you had to trace a production bug", "q", "textarea")).not.toBe("demographic");
    expect(classify("Is it advisable to rewrite legacy systems? Explain.", "q", "textarea")).not.toBe("sponsorship");
  });

  it("still matches the real questions", () => {
    expect(classify("Race")).toBe("demographic");
    expect(classify("How would you describe your racial/ethnic background?")).toBe("demographic");
    expect(classify("Will you require visa sponsorship?")).toBe("sponsorship");
    expect(classify("Are you willing to travel up to 25%?")).toBe("travel");
    expect(classify("Are you open to relocation?")).toBe("relocation");
  });

  it("reads ids with underscores as separate words", () => {
    expect(classify("", "question_race")).toBe("demographic");
  });
});
