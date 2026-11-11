const YEARS = String.raw`(?:years?|yrs?)`;
const REQUIRED_YEARS_PATTERNS = [
  // "at least 10+ years", "minimum 5+ years", "a minimum of 3 years"
  new RegExp(String.raw`\b(?:at least|minimum(?: of)?|min\.?|no less than)\s+(\d{1,2})\+?\s*${YEARS}\b`, "g"),
  // "5+ years", "3-5 years", "3 to 5 years", "4 years of professional experience"
  new RegExp(String.raw`\b(\d{1,2})\s*(?:\+|(?:-|–|—|to)\s*\d{1,2}\s*\+?)?\s*${YEARS}\b`, "g"),
];

/**
 * The most years of experience a posting says it requires ("Successful
 * applicants have at least 10+ years of experience", Gusto, 2026-11-10). Only
 * counts sentences that mention experience, ignores "nice to have" lines, and
 * a range counts as its low end.
 */
export function requiredYearsOfExperience(description: string | undefined): number | undefined {
  if (!description) return undefined;
  let most: number | undefined;
  for (const sentence of description.split(/(?<=[.!?;])\s+|\n+/)) {
    const text = sentence.toLowerCase();
    if (!/\bexperience\b/.test(text) || /\bnice to have\b|\bbonus\b|\ba plus\b|\bof age\b|\byears old\b/.test(text)) continue;
    for (const pattern of REQUIRED_YEARS_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const years = Number(match[1]);
        if (years > 0 && years <= 30) most = Math.max(most ?? 0, years);
      }
    }
  }
  return most;
}
