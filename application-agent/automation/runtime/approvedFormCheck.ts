import type { ExecutionReviewEntry } from "../../src/domain/executor";

/**
 * Compares the form you approved (the "ready to submit" card) with the same
 * form after the agent reopened and refilled it (2026-11-17).
 *
 * Why: a browser window closes after a few hours, so a Submit tap can come
 * after the form it showed you is gone. The agent reopens the posting and fills
 * it again from the same saved answers, but it only clicks Submit when the
 * refill matches what you saw. Anything new, missing or different means the
 * employer changed the form, or the agent would answer differently now. In
 * that case you get a fresh card to look at instead of a submission.
 *
 * One kind of change is allowed: a date that moved (the start date is set to
 * two weeks after the day the agent applies, so it shifts by a day or two).
 */
export interface ApprovedFormCheck {
  matches: boolean;
  /** Plain-language list of what differs, field labels only (no values). */
  differences: string[];
  /** Dates that moved; allowed, but mentioned in the Slack reply. */
  movedDates: string[];
}

const DATE_LIKE = [
  /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/,
  /^\d{4}-\d{2}-\d{2}$/,
  /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2},? \d{4}$/i,
  /^\d{1,2} (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{4}$/i,
];

const looksLikeDate = (value: string) => DATE_LIKE.some((pattern) => pattern.test(value.trim()));
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

/** Groups values by label, keeping order, so a label used twice still lines up. */
function byLabel(entries: readonly ExecutionReviewEntry[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const entry of entries) {
    const label = normalize(entry.label);
    grouped.set(label, [...(grouped.get(label) ?? []), normalize(entry.value)]);
  }
  return grouped;
}

export function compareApprovedForm(
  approved: readonly ExecutionReviewEntry[],
  refilled: readonly ExecutionReviewEntry[],
): ApprovedFormCheck {
  const before = byLabel(approved);
  const after = byLabel(refilled);
  const differences: string[] = [];
  const movedDates: string[] = [];
  for (const [label, values] of before) {
    const now = after.get(label) ?? [];
    for (let index = 0; index < Math.max(values.length, now.length); index += 1) {
      const was = values[index];
      const is = now[index];
      if (was === is) continue;
      if (was === undefined) differences.push(`"${label}" is new on the form`);
      else if (is === undefined) differences.push(`"${label}" is no longer filled in`);
      else if (looksLikeDate(was) && looksLikeDate(is)) movedDates.push(label);
      else differences.push(`"${label}" would now be filled in differently`);
    }
  }
  for (const label of after.keys()) {
    if (!before.has(label)) differences.push(`"${label}" is new on the form`);
  }
  return { matches: differences.length === 0, differences, movedDates };
}
