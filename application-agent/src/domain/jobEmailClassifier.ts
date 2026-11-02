/**
 * Sorts an application-related email by its wording. Rejection and interview
 * emails are formulaic, so fixed phrases decide; anything else is "unclear"
 * and goes to the user rather than being guessed. Order matters: rejection
 * emails usually also thank the candidate and sometimes mention interviews.
 */
export type JobEmailKind = "rejection" | "interview" | "received" | "unclear" | "not_job";

export interface JobEmail {
  from: string;
  subject: string;
  text: string;
}

const NOT_JOB = [
  /\bsecurity code\b/,
  /\bjobs? (?:you may be interested in|recommended for you|alert)\b|\bnew jobs? (?:for you|matching)\b/,
  /\bverify your email\b|\bconfirm your email address\b|\breset your password\b/,
];

const REJECTION = [
  /\b(?:decided|chosen|elected) (?:not )?to (?:move forward|proceed|continue|pursue) with (?:others?|another|a different)\b/,
  /\bnot (?:to )?(?:move|moving) forward with your (?:application|candidacy)\b/,
  /\bwill not be (?:moving|proceeding|progressing) (?:forward )?with your\b/,
  /\b(?:we are|we're|we have|we've) (?:decided )?(?:not )?(?:moving|move|moved) forward with other candidates\b/,
  /\b(?:the |this )?(?:position|role) has (?:been|now been) filled\b/,
  /\bno longer (?:considering|being considered|under consideration)\b/,
  /\b(?:have|has) not been selected\b|\bwere not selected\b|\bnot been selected\b/,
  /\bregret to inform\b|\bregrettably\b.{0,80}\b(?:not|others?|another)\b/,
  /\bother candidates whose (?:experience|qualifications|background)\b/,
  /\bunable to (?:move forward|offer you)\b/,
  /\bdecided to (?:pursue|go with) other\b/,
];

const INTERVIEW = [
  /\b(?:schedule|set up|book|arrange|find) (?:a|an|some) (?:time|call|interview|chat|conversation|meeting)\b/,
  /\b(?:would|we'd|i'd) (?:like|love) to (?:invite you|speak with you|chat with you|talk with you|connect with you|schedule|set up|move forward with you)\b/,
  /\bnext (?:step|round|stage)s? (?:in|of) (?:the|our) (?:hiring|interview|recruiting)? ?process\b/,
  /\b(?:phone|recruiter|technical|initial) (?:screen|interview|call)\b/,
  /\binterview (?:invitation|request|with)\b|\binvitation to interview\b/,
  /\byour availability\b|\bwhen are you available\b|\bplease (?:select|choose|pick) a time\b/,
  /\b(?:calendly|goodtime|greenhouse scheduling|ashby scheduling)\b/,
];

const RECEIVED = [
  /\b(?:thank you|thanks) for (?:applying|your application|submitting your application)\b/,
  /\b(?:we(?:'ve| have) |your application (?:has been |was ))?received your application\b|\bapplication (?:has been |was )?received\b/,
  /\bthanks for your interest in (?:the|joining)\b/,
];

function normalize(email: JobEmail): string {
  return `${email.subject}\n${email.text}`.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ");
}

export function classifyJobEmail(email: JobEmail): JobEmailKind {
  const text = normalize(email);
  if (NOT_JOB.some((pattern) => pattern.test(text))) return "not_job";
  if (REJECTION.some((pattern) => pattern.test(text))) return "rejection";
  if (INTERVIEW.some((pattern) => pattern.test(text))) return "interview";
  if (RECEIVED.some((pattern) => pattern.test(text))) return "received";
  return /\b(?:application|applied|applying|candidacy|interview|recruit|position|role)\b/.test(text) ? "unclear" : "not_job";
}
