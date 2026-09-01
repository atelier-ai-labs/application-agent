import type { CareerEventType } from "./campaignTypes";

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

export function eventLabel(type: CareerEventType): string {
  const label = type.replace(/\./g, " · ").replace(/_/g, " ");
  return label.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}
