/**
 * Pure Rippling DOM helpers for field-prompt extraction and remount recovery.
 *
 * The ancestor-prompt walk inside playwrightLeverBrowserSession.inspectFields
 * (evaluateAll) must stay browser-serializable, so that copy is inlined there.
 * Keep extractRipplingAncestorPrompt / looksLike* in sync with that walk.
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

/**
 * Walk a few ancestors for a preceding sibling that looks like a Rippling
 * custom-question prompt (e.g. div.paddingX--16) without containing another
 * form control (so stacked questions do not steal each other's prompts).
 * Keep in sync with the evaluateAll walk in playwrightLeverBrowserSession.
 */
export function extractRipplingAncestorPrompt(control: Element): string | undefined {
  let cursor: Element | null = control;
  for (let depth = 0; depth < 6 && cursor; depth += 1) {
    const previous = cursor.previousElementSibling;
    if (previous && !previous.querySelector(CONTROL_SELECTOR)) {
      const candidate = textFrom(previous);
      if (looksLikePromptText(candidate)) {
        return candidate.replace(/\s*[✱*]\s*$/, "").trim();
      }
    }
    const parent: Element | null = cursor.parentElement;
    if (parent) {
      for (const child of Array.from(parent.children) as Element[]) {
        if (child.contains(control)) break;
        if (child.querySelector(CONTROL_SELECTOR)) continue;
        const candidate = textFrom(child);
        if (looksLikePromptText(candidate)) {
          return candidate.replace(/\s*[✱*]\s*$/, "").trim();
        }
      }
    }
    cursor = parent;
  }
  return undefined;
}

/** Manhattan distance uniqueness margin for Rippling Search remount recovery. */
export const SEARCH_NEAR_PHONE_MARGIN_PX = 24;

/**
 * Return the index of the uniquely nearest point to `anchor`, or null when
 * empty / ambiguous (runner-up within marginPx of the best distance).
 */
export function pickNearestUniqueByDistance(
  anchor: { x: number; y: number },
  points: readonly { x: number; y: number }[],
  marginPx: number,
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
  if (runnerUp && runnerUp.distance - best.distance < marginPx) {
    return null;
  }
  return best.index;
}
