import { describe, expect, it } from "vitest";
import { compareApprovedForm } from "../application-agent/automation/runtime/approvedFormCheck";

const approved = [
  { label: "Full name", value: "Nate Example" },
  { label: "Resume", value: "file attached" },
  { label: "Are you authorized to work in the US?", value: "Yes" },
  { label: "Earliest start date", value: "12/01/2026" },
];

describe("compareApprovedForm", () => {
  it("matches an identical refill, ignoring spacing", () => {
    const refill = approved.map((entry) => ({ ...entry, value: ` ${entry.value}  ` }));
    expect(compareApprovedForm(approved, refill)).toEqual({ matches: true, differences: [], movedDates: [] });
  });

  it("allows a start date that moved, and says so", () => {
    const refill = approved.map((entry) => entry.label === "Earliest start date" ? { ...entry, value: "12/03/2026" } : entry);
    expect(compareApprovedForm(approved, refill)).toEqual({ matches: true, differences: [], movedDates: ["Earliest start date"] });
  });

  it("refuses a changed answer, a new question and a dropped one", () => {
    const refill = [
      { label: "Full name", value: "Nate Example" },
      { label: "Resume", value: "file attached" },
      { label: "Are you authorized to work in the US?", value: "No" },
      { label: "Do you know anyone who works here?", value: "No" },
    ];
    const check = compareApprovedForm(approved, refill);
    expect(check.matches).toBe(false);
    expect(check.differences).toEqual([
      "\"Are you authorized to work in the US?\" would now be filled in differently",
      "\"Earliest start date\" is no longer filled in",
      "\"Do you know anyone who works here?\" is new on the form",
    ]);
  });

  it("lines up a label used twice by position", () => {
    const twice = [{ label: "Link", value: "https://github.com/x" }, { label: "Link", value: "https://x.dev" }];
    expect(compareApprovedForm(twice, twice).matches).toBe(true);
    expect(compareApprovedForm(twice, [twice[0]!]).differences).toEqual(["\"Link\" is no longer filled in"]);
  });
});
