import type { ApplicationStatus } from "./types";

const ALLOWED_TRANSITIONS: Readonly<Record<ApplicationStatus, readonly ApplicationStatus[]>> = {
  discovered: ["evaluated", "failed"],
  evaluated: ["preparing", "failed"],
  preparing: ["needs_input", "ready_for_review", "failed"],
  needs_input: ["needs_input", "ready_for_review", "failed"],
  ready_for_review: ["applied", "failed"],
  applied: [],
  failed: ["discovered"],
};

export function canTransition(
  current: ApplicationStatus,
  next: ApplicationStatus,
): boolean {
  return ALLOWED_TRANSITIONS[current].includes(next);
}

export function assertTransition(
  current: ApplicationStatus,
  next: ApplicationStatus,
): void {
  if (!canTransition(current, next)) {
    throw new Error(`Application cannot transition from ${current} to ${next}.`);
  }
}
