import type { CandidateProfile, JobPosting, TailoredResume } from "./types";

/** A small, bounded private-profile excerpt supplied to a local answer model. */
export interface CandidateAnswerEvidence {
  id: string;
  source: string;
  text: string;
}

export interface ApplicationAnswerDraftRequest {
  question: string;
  field?: string;
  job: JobPosting;
  profile: CandidateProfile;
  resume?: TailoredResume | null;
}

/** A grounded local-model answer; campaign policy decides whether it may be used automatically. */
export interface GroundedApplicationAnswerDraft {
  answer: string;
  evidence: readonly string[];
  provider: "ollama";
}

export type ApplicationAnswerDraftGenerator = (
  request: ApplicationAnswerDraftRequest,
) => Promise<GroundedApplicationAnswerDraft | undefined>;

const STOP_WORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "could",
  "describe",
  "did",
  "do",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "problem",
  "solve",
  "solved",
  "tell",
  "that",
  "the",
  "this",
  "to",
  "was",
  "what",
  "when",
  "with",
  "you",
  "your",
]);

const MAX_EVIDENCE_ITEMS = 6;
const MAX_EVIDENCE_TEXT_LENGTH = 900;
const MAX_EVIDENCE_SOURCE_LENGTH = 160;

export function isBroadMotivationQuestion(question: string): boolean {
  return /\b(?:your story|looking for a new role|looking for a role|motivat(?:ion|ed)|career goals?|why are you looking)\b/i.test(question);
}

function bounded(value: string, maximum: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maximum);
}

function tokens(value: string): readonly string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9+#./-]+/g, " ")
        .split(/\s+/)
        .map((token) => token.replace(/^[./-]+|[./-]+$/g, ""))
        .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)),
    ),
  ];
}

function sectionText(content: string | readonly string[]): string {
  return typeof content === "string" ? content : content.join(" ");
}

function addEvidence(target: CandidateAnswerEvidence[], id: string, source: string, text: string): void {
  const safeId = bounded(id, 96);
  if (target.some((item) => item.id === safeId)) return;
  const safeText = bounded(text, MAX_EVIDENCE_TEXT_LENGTH);
  if (!safeText) return;
  target.push({
    id: safeId,
    source: bounded(source, MAX_EVIDENCE_SOURCE_LENGTH),
    text: safeText,
  });
}

/**
 * Selects a small deterministic set of private evidence records for one exact
 * ATS question. It is intentionally lexical and local; no profile-wide index
 * or external retrieval service is introduced.
 */
export function retrieveCandidateAnswerEvidence(request: ApplicationAnswerDraftRequest): readonly CandidateAnswerEvidence[] {
  const queryTokens = new Set(
    tokens([request.question, request.job.title, ...request.job.requiredSkills, ...request.job.preferredSkills].join(" ")),
  );
  if (queryTokens.size === 0) return [];

  const candidates: CandidateAnswerEvidence[] = [];
  for (const record of request.profile.employmentHistory) {
    addEvidence(
      candidates,
      `employment:${record.id}`,
      `Employment history — ${record.title} at ${record.employer}`,
      `${record.title} at ${record.employer}. ${record.bullets.join(" ")} Verified skills: ${record.verifiedSkills.join(", ")}.`,
    );
  }
  for (const project of request.profile.projects) {
    addEvidence(
      candidates,
      `project:${project.id}`,
      `Project — ${project.name}`,
      `${project.name}. ${project.description} ${project.bullets.join(" ")} Verified skills: ${project.verifiedSkills.join(", ")}.`,
    );
  }
  for (const education of request.profile.education) {
    addEvidence(
      candidates,
      `education:${education.id}`,
      `Education — ${education.institution}`,
      `${education.degree}${education.field ? ` in ${education.field}` : ""} at ${education.institution}.`,
    );
  }
  for (const certification of request.profile.certifications) {
    addEvidence(
      candidates,
      `certification:${certification.id}`,
      `Certification — ${certification.name}`,
      `${certification.name} issued by ${certification.issuer}.`,
    );
  }
  for (const skill of request.profile.skills) {
    addEvidence(candidates, `skill:${skill}`, "Verified profile skills", skill);
  }
  for (const answer of Object.entries(request.profile.approvedReusableAnswers)) {
    addEvidence(candidates, `approved-answer:${answer[0]}`, `Approved answer — ${answer[0]}`, answer[1]);
  }
  for (const section of request.resume?.sections ?? []) {
    addEvidence(candidates, `resume:${section.kind}`, `Mapped resume — ${section.title}`, sectionText(section.content));
  }
  if (request.resume?.summary) {
    addEvidence(candidates, "resume:summary", "Mapped resume — Summary", request.resume.summary);
  }

  const ranked = candidates
    .map((candidate, index) => {
      const candidateTokens = new Set(tokens(candidate.text));
      let score = 0;
      for (const token of queryTokens) {
        if (candidateTokens.has(token)) score += 1;
      }
      return { candidate, score, index };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, MAX_EVIDENCE_ITEMS)
    .map((item) => item.candidate);

  if (!isBroadMotivationQuestion(request.question)) return ranked;

  // Broad story prompts often contain too few lexical clues to retrieve a
  // useful project. Prefer bounded employment/project/resume records and keep
  // standalone skill records out of this context: otherwise a model can
  // incorrectly attach a profile-wide skill to an employer it did not support.
  // The final grounding checks still require every named fact to remain tied
  // to the supplied evidence.
  const personalRecords = candidates
    .filter((candidate) => /^(?:Employment history|Project|Mapped resume)\b/.test(candidate.source))
    .slice(0, 2);
  if (personalRecords.length > 0) return personalRecords;
  return ranked
    .filter((candidate, index, values) => values.findIndex((item) => item.id === candidate.id) === index)
    .slice(0, MAX_EVIDENCE_ITEMS);
}
