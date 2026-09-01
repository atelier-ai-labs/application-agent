import type { CampaignStatus } from "./campaignTypes";

const ALLOWED_CAMPAIGN_TRANSITIONS: Readonly<Record<CampaignStatus, readonly CampaignStatus[]>> = {
  draft: ["active", "failed"],
  active: ["paused", "completed", "failed"],
  paused: ["active", "completed", "failed"],
  completed: [],
  failed: [],
};

export function canTransitionCampaign(
  current: CampaignStatus,
  next: CampaignStatus,
): boolean {
  return ALLOWED_CAMPAIGN_TRANSITIONS[current].includes(next);
}

export function assertCampaignTransition(
  current: CampaignStatus,
  next: CampaignStatus,
): void {
  if (!canTransitionCampaign(current, next)) {
    throw new Error(`Campaign cannot transition from ${current} to ${next}.`);
  }
}
