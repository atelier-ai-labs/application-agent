/**
 * Programming languages a posting requires, out of the ones the search
 * excludes (2026-11-17). Figma's Application Platform role asked for
 * "meaningful production Ruby experience", and Nate doesn't work in Ruby; the
 * fit check didn't notice because Ruby isn't one of its skills.
 *
 * A language counts only when a sentence requires it. These don't count:
 * - a nice-to-have ("Ruby is a plus", "bonus", "preferred", "familiarity")
 * - one choice among several ("Java, Kotlin, Python or TypeScript")
 * - "you don't need to be a Ruby specialist"
 * - a mention with no requirement ("the team owns a large Ruby application")
 * A language in the job title always counts.
 */

/** Other names a posting uses for the same language. Bare "Go" is too ambiguous to match. */
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  ruby: ["ruby", "ruby on rails", "rails"],
  go: ["golang"],
  "c#": ["c#", ".net", "dotnet"],
  "c++": ["c++", "cpp"],
};

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function languagePattern(language: string): RegExp {
  const names = ALIASES[language.toLowerCase()] ?? [language.toLowerCase()];
  // Letters on either side would make it part of another word ("Rubymine").
  return new RegExp(`(?<![a-z0-9])(?:${names.map(escape).join("|")})(?![a-z0-9+#])`, "i");
}

const REQUIRES = /\b(?:experience (?:with|in|using|building|writing)|experienced (?:with|in)|proficien\w*|expert\w*|expertise|strong|solid|deep|production|required|requires|must|fluen\w*|hands[- ]on|professional|years? of|background in|working knowledge)\b/;
const OPTIONAL = /\b(?:nice to have|nice-to-have|a plus|is a plus|bonus|preferred|familiarity|exposure|desirable|not required|don['’]t need|do not need|not necessary|optional|willing(?:ness)? to learn|eager to learn|interest in)\b/;
const ALTERNATIVES = /\b(?:or|one of|such as|e\.g\.|any of|similar|equivalent|comparable|languages like)\b/;

export function requiredExcludedLanguages(
  title: string | undefined,
  description: string | undefined,
  excluded: readonly string[] | undefined,
): string[] {
  if (!excluded?.length) return [];
  const found = new Set<string>();
  for (const language of excluded) {
    const pattern = languagePattern(language);
    if (title && pattern.test(title)) {
      found.add(language);
      continue;
    }
    for (const sentence of (description ?? "").split(/(?<=[.!?;])\s+|\n+/)) {
      const text = sentence.toLowerCase();
      if (!pattern.test(text) || OPTIONAL.test(text) || ALTERNATIVES.test(text)) continue;
      if (REQUIRES.test(text)) {
        found.add(language);
        break;
      }
    }
  }
  return [...found];
}
