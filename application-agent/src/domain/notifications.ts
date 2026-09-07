import type { CareerEventType } from "./campaignTypes";
import type { HumanAttentionCategory } from "./executionTrace";

const ATTENTION_EVENTS: ReadonlySet<CareerEventType> = new Set([
  "campaign.failed",
  "campaign.review_needed",
  "job.held",
  "application.needs_input",
  "application.execution_paused",
  "application.ready_to_submit",
  "application.failed",
  "application.execution_failed",
  "tracker.failed",
]);

export function isAttentionWorthyEvent(type: CareerEventType): boolean {
  return ATTENTION_EVENTS.has(type);
}

/**
 * Maps existing attention events to a stable category. The mapping uses only
 * bounded event metadata; it does not inspect candidate answers or page data.
 */
export function attentionCategoryForEvent(
  type: CareerEventType,
  metadata?: Readonly<Record<string, string>>,
): HumanAttentionCategory | undefined {
  if (!isAttentionWorthyEvent(type)) return undefined;
  const hint = Object.values(metadata ?? {}).join(" ").toLowerCase();
  if (type === "application.ready_to_submit") return "manual_submission";
  if (type === "tracker.failed") return hint.includes("auth") || hint.includes("config")
    ? "tracker_auth"
    : "tracker_failure";
  if (type === "tracker.retry_started") return "tracker_failure";
  if (type === "job.held") return "policy_decision";
  if (type === "campaign.failed" || type === "application.failed" || type === "application.execution_failed") {
    return "operational_failure";
  }
  if (type === "campaign.review_needed") {
    if (hint.includes("tracker")) return hint.includes("auth") || hint.includes("config") ? "tracker_auth" : "tracker_failure";
    if (hint.includes("provider_configuration") || hint.includes("configuration") || hint.includes("profile") || hint.includes("resume_family")) {
      return "provider_configuration";
    }
    if (hint.includes("policy") || hint.includes("cap") || hint.includes("hold") || hint.includes("reject")) return "policy_decision";
    if (hint.includes("preparation") || hint.includes("unknown")) return "candidate_fact_missing";
    return "operational_failure";
  }
  if (hint.includes("captcha")) return "captcha";
  if (hint.includes("mfa")) return "mfa";
  if (hint.includes("login") || hint.includes("auth")) return "login";
  if (hint.includes("resume") || hint.includes("file")) return "resume_artifact_missing";
  if (hint.includes("subjective") || hint.includes("cover") || hint.includes("why")) return "subjective_answer";
  if (hint.includes("unsupported") || hint.includes("form") || hint.includes("widget")) return "unsupported_field";
  if (hint.includes("submission")) return "manual_submission";
  return "candidate_fact_missing";
}

export function eventLabel(type: CareerEventType): string {
  const label = type.replace(/\./g, " · ").replace(/_/g, " ");
  return label.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}
