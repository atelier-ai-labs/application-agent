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

/** "What interests you about Outmarket?", "Why do you want to join us?", "Why this role?" */
export function isCompanyInterestQuestion(question: string): boolean {
  const text = question.replace(/\s+/g, " ").replace(/\*+\s*$/, "").trim();
  if (/\b(?:what (?:interests|excites|draws|attracts|appeals to) you|why (?:are you|you're) (?:interested|excited|applying)|why (?:do you want to|would you like to|did you apply to) (?:work|join|apply)|why (?:this|our) (?:company|role|team|position)|why (?:do you want|would you like) (?:this|the) (?:role|job|position)|what makes you want to (?:work|join))\b/i.test(text)) return true;
  // "What makes you excited about the ElevenLabs mission?", "What made you decide to apply?"
  if (/\bwhat (?:makes|made|gets|got) you (?:so )?(?:excited|interested|want|decide to apply|apply)\b|\b(?:excited|passionate) (?:about|by) (?:the |our |this |[A-Z][\w&.-]*'?s? )/i.test(text)) return true;
  if (/\b(?:about|for|of) (?:the |our |this )?(?:[A-Z][\w&.-]* )?(?:company'?s? )?mission\b|\bwhy did you (?:decide to )?apply\b/i.test(text)) return true;
  // A short "Why Mercury?" names the company and nothing else.
  return /^why (?!do\b|did\b|are\b|would\b|is\b|should\b|not\b|now\b)[A-Za-z0-9][\w&.' -]{0,40}\?$/i.test(text);
}

/**
 * Topics a posting emphasizes, in the order it mentions them, from a fixed
 * vocabulary. They tell the drafter what the role is about; they are never
 * candidate evidence. Outmarket's draft praised "backend systems using
 * FastAPI" because the model only ever saw the job title.
 */
const EMPHASIS_TERMS: readonly [string, RegExp][] = [
  ["retrieval-augmented generation (RAG)", /\brag\b|retrieval[- ]augmented/i],
  ["embeddings", /\bembeddings?\b/i],
  ["semantic search", /\bsemantic search\b|\bvector (?:search|database|db)s?\b/i],
  ["tool-using AI agents", /\btool[- ](?:using|calling|use)\b|\bagent(?:s|ic)?\b/i],
  ["evaluating model output", /\bevals?\b|\bevaluat(?:e|ing|ion)s? (?:of )?(?:model|llm|ai)|model[- ]output evaluation|\bllm[- ]as[- ]a[- ]judge\b/i],
  ["LLM applications", /\bllms?\b|large language models?|generative ai|\bgenai\b/i],
  ["prompt engineering", /\bprompt(?:s| engineering| design)\b/i],
  ["machine learning models", /\bmachine learning\b|\bml models?\b|\bmodel training\b/i],
  ["MLOps / model deployment", /\bmlops\b|model (?:serving|deployment|inference)/i],
  ["data pipelines", /\b(?:data|etl|elt) pipelines?\b|\betl\b/i],
  ["cloud infrastructure", /\b(?:aws|azure|gcp|google cloud)\b|cloud infrastructure/i],
  ["infrastructure as code", /\bterraform\b|\bcloudformation\b|\bpulumi\b|infrastructure as code/i],
  ["Kubernetes and containers", /\bkubernetes\b|\bk8s\b|\bdocker\b|\bcontainers?\b/i],
  ["CI/CD and developer tooling", /\bci\/cd\b|\bdeveloper (?:tooling|experience|platform)\b|\bdeployment pipelines?\b/i],
  ["observability and reliability", /\bobservability\b|\bsre\b|site reliability|\bon[- ]call\b|\bincident/i],
  ["frontend / React", /\breact\b|\bfront[- ]?end\b|\bui\b/i],
  ["backend APIs", /\bbackend\b|\bapis?\b|\bmicroservices?\b/i],
];

export function postingEmphasis(job: Pick<JobPosting, "title" | "description" | "requiredSkills" | "preferredSkills">, limit = 5): readonly string[] {
  return emphasisIn([job.title, postingBody(job.description), ...job.requiredSkills, ...job.preferredSkills].join("\n"), limit);
}

/** The same topics found in any text, such as the candidate's evidence records. */
export function emphasisIn(text: string, limit = 5): readonly string[] {
  return EMPHASIS_TERMS
    .map(([label, pattern]) => ({ label, at: text.search(pattern) }))
    .filter((item) => item.at >= 0)
    .sort((left, right) => left.at - right.at)
    .slice(0, limit)
    .map((item) => item.label);
}

/** The posting's own words, without the agent's queue metadata lines ("Resume Version: …", "Fit: …"). */
export function postingBody(description: string): string {
  return description
    .split("\n")
    .filter((line) => !/^\s*(?:location|resume version|priority|fit|employment type|discovered application route|https?:)\b/i.test(line))
    .join("\n")
    .replace(/^[^\n]* at [^\n]*\n/, "")
    .trim();
}

const ROLE_HEADING = /^(?:what you(?:'| wi)ll (?:do|work on|be doing)|what you'?ll own|the role|about the (?:role|job|team|position)|in this role|your role|responsibilities|key responsibilities|what we(?:'re| are) looking for|you will|the opportunity|role overview)\b/i;
const BOILERPLATE_HEADING = /^(?:benefits|perks|compensation|salary|pay|equal (?:employment )?opportunity|eeo|our (?:benefits|perks)|location|how we work|life at|why join|what we offer)\b/i;

/**
 * The parts of a posting that answer "why us": the company's own intro or
 * mission (it usually opens the posting) and what the role does. Benefits,
 * pay and legal text are left out. The first 700 characters alone often stop
 * before the role is even described.
 */
export function postingContextForInterest(description: string, maximum = 2_400): string {
  const lines = postingBody(description).split("\n").map((line) => line.trim()).filter(Boolean);
  const heading = (line: string) => line.length <= 60 && !/[.!?]$/.test(line);
  const intro: string[] = [];
  for (const line of lines) {
    if (intro.length > 0 && heading(line) && (ROLE_HEADING.test(line) || BOILERPLATE_HEADING.test(line))) break;
    intro.push(line);
    if (intro.join(" ").length > 1_100) break;
  }
  const roleStart = lines.findIndex((line) => heading(line) && ROLE_HEADING.test(line));
  const role: string[] = [];
  if (roleStart >= 0) {
    for (const line of lines.slice(roleStart)) {
      if (role.length > 0 && heading(line) && BOILERPLATE_HEADING.test(line)) break;
      role.push(line);
      if (role.join(" ").length > 1_200) break;
    }
  }
  const joined = [intro.join(" ").slice(0, 1_100), role.join(" ").slice(0, 1_250)].filter(Boolean).join(" … ");
  return (joined || lines.join(" ")).replace(/\s+/g, " ").slice(0, maximum);
}

/** Same idea, different word: "tool-calling" ~ "tool-using", "eval" ~ "evaluation", "agents" ~ "agent". */
function stem(token: string): string {
  const aliases: Record<string, string> = {
    "tool-using": "tool-calling", "tool-use": "tool-calling", evaluation: "eval", evaluations: "eval", evals: "eval", evaluating: "eval",
    agentic: "agent", agents: "agent", llms: "llm", embedding: "embeddings", retrieval: "rag", "retrieval-augmented": "rag",
  };
  const aliased = aliases[token] ?? token;
  return aliased.length > 4 && aliased.endsWith("s") && !aliased.endsWith("ss") ? aliased.slice(0, -1) : aliased;
}

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
        .filter((token) => token.length >= 3 && !STOP_WORDS.has(token))
        .map(stem),
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
  const companyInterest = isCompanyInterestQuestion(request.question);
  const queryTokens = new Set(
    tokens([
      request.question, request.job.title, ...request.job.requiredSkills, ...request.job.preferredSkills,
      // A "why us" question names almost nothing; what the posting is about decides which project is relevant.
      ...(companyInterest ? [postingBody(request.job.description).slice(0, 4_000)] : []),
    ].join(" ")),
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

  if (companyInterest) {
    // The best one or two projects or jobs for this posting; standalone skill records can't carry a "why us" answer.
    const personal = ranked.filter((candidate) => /^(?:Employment history|Project)\b/.test(candidate.source)).slice(0, 2);
    return personal.length > 0 ? personal : ranked;
  }
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
