/**
 * Pure Rippling DOM helpers for field-prompt extraction and remount recovery.
 *
 * The browser callback collects serializable candidates, then the shared
 * candidate selector below applies the prompt rules outside evaluateAll.
 */

const CONTROL_SELECTOR = "input, textarea, select, [role='combobox']";

export function looksLikeOpaqueToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,}$/.test(value) && !/\s/.test(value);
}

export function looksLikePromptText(value: string | undefined): value is string {
  if (!value) return false;
  const trimmed = value.replace(/\s*[✱*]\s*$/, "").trim();
  if (trimmed.length < 2 || trimmed.length > 240) return false;
  if (looksLikeOpaqueToken(trimmed)) return false;
  if (/^(?:search|select(?:\.\.\.)?|textbox|toggle|menu)$/i.test(trimmed)) return false;
  if (/^total \d+ file selected$/i.test(trimmed)) return false;
  return /[A-Za-z]/.test(trimmed);
}

function textFrom(element: Element | null | undefined, maximum = 240): string | undefined {
  const compact = (element?.textContent ?? "").replace(/\s+/g, " ").replace(/\s*[✱]\s*$/, "").trim();
  return compact ? compact.slice(0, maximum) : undefined;
}

export interface RipplingPromptCandidate {
  text?: string;
  containsControl: boolean;
}

/** Select the first safe prompt from the serializable browser-side candidates. */
export function extractRipplingPromptFromCandidates(
  candidates: readonly RipplingPromptCandidate[],
): string | undefined {
  for (const candidate of candidates) {
    if (candidate.containsControl || !looksLikePromptText(candidate.text)) continue;
    return candidate.text.replace(/\s*[✱*]\s*$/, "").trim();
  }
  return undefined;
}

/**
 * Walk a few ancestors for a preceding sibling that looks like a Rippling
 * custom-question prompt (e.g. div.paddingX--16) without containing another
 * form control (so stacked questions do not steal each other's prompts).
 * Keep in sync with the evaluateAll walk in playwrightLeverBrowserSession.
 */
export function extractRipplingAncestorPrompt(control: Element): string | undefined {
  const candidates: RipplingPromptCandidate[] = [];
  let cursor: Element | null = control;
  for (let depth = 0; depth < 6 && cursor; depth += 1) {
    const previous = cursor.previousElementSibling;
    if (previous) {
      candidates.push({
        text: textFrom(previous),
        containsControl: Boolean(previous.querySelector(CONTROL_SELECTOR)),
      });
    }
    const parent: Element | null = cursor.parentElement;
    if (parent) {
      for (const child of Array.from(parent.children) as Element[]) {
        if (child.contains(control)) break;
        candidates.push({
          text: textFrom(child),
          containsControl: Boolean(child.querySelector(CONTROL_SELECTOR)),
        });
      }
    }
    cursor = parent;
  }
  return extractRipplingPromptFromCandidates(candidates);
}

/** Manhattan distance uniqueness margin for Rippling Search remount recovery. */
export const SEARCH_NEAR_PHONE_MARGIN_PX = 24;

/** Do not bind a recovered Search control to a distant, unrelated field. */
export const SEARCH_NEAR_PHONE_MAX_DISTANCE_PX = 240;

/**
 * Return the index of the uniquely nearest point to `anchor`, or null when
 * empty / ambiguous (runner-up within marginPx of the best distance).
 */
export function pickNearestUniqueByDistance(
  anchor: { x: number; y: number },
  points: readonly { x: number; y: number }[],
  marginPx: number,
  maxDistancePx = Number.POSITIVE_INFINITY,
): number | null {
  if (points.length === 0) return null;
  const ranked = points
    .map((point, index) => ({
      index,
      distance: Math.abs(point.y - anchor.y) + Math.abs(point.x - anchor.x),
    }))
    .sort((left, right) => left.distance - right.distance || left.index - right.index);
  const best = ranked[0]!;
  const runnerUp = ranked[1];
  if (best.distance > maxDistancePx) return null;
  if (runnerUp && runnerUp.distance - best.distance < marginPx) {
    return null;
  }
  return best.index;
}
