import type { ExecutionHostRequest } from "../../src/domain/executionHostTypes";
import {
  isVerifiedLeverApplicationUrl,
  isVerifiedLeverHostedUrl,
  leverSourceId,
} from "../../src/domain/leverJobSource";
import {
  isVerifiedGreenhouseApplicationUrl,
  isVerifiedGreenhouseHostedUrl,
} from "../../src/domain/greenhouseJobSource";
import {
  classifyJobUrl,
  isVerifiedAshbyHostedUrl,
  isVerifiedAshbyApplicationUrl,
  isVerifiedRipplingHostedUrl,
  isVerifiedRipplingApplicationUrl,
  ripplingApplicationUrl,
  isVerifiedWorkdayApplicationUrl,
  isVerifiedWorkdayHostedUrl,
  workdayPostingId,
  isVerifiedYouHiredApplicationUrl,
  isVerifiedMatlenApplicationUrl,
  isVerifiedProtagonaApplicationUrl,
  isVerifiedGustoHostedUrl,
  isVerifiedGustoApplicationUrl,
  gustoPostingId,
  matlenPostingId,
  protagonaPostingId,
  youHiredPostingId,
} from "../../src/domain/jobUrlClassifier";
import { isExecutionHostRequest } from "../../src/domain/executionHostValidation";

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Server-side trust checks for the intentionally narrow local execution API.
 * The browser client may send a valid-looking request, but it is never trusted
 * until this function has revalidated the entire packet and its provider URL.
 */
export function trustedExecutionRequestReason(value: unknown): string | undefined {
  if (!isExecutionHostRequest(value)) return "The execution request does not match the persisted domain contracts.";
  const request = value as ExecutionHostRequest;
  const { campaign, careerJob, application, profile } = request;

  if (request.mode !== "real_local") return "Only real_local preparation mode is supported by this host.";
  if (campaign.id !== careerJob.campaignId) return "The career job does not belong to the selected campaign.";
  if (!careerJob.applicationId || careerJob.applicationId !== application.id) {
    return "The application packet is not attached to the selected career job.";
  }
  if (application.status !== "ready_for_review") {
    return "Only an application packet ready for review may be opened in the browser.";
  }
  if (application.isExample || careerJob.isExample) {
    return "Live browser preparation cannot use an example application or job.";
  }
  if (application.blockers.some((blocker) => blocker.status === "open")) {
    return "The application packet still has unresolved preparation blockers.";
  }
  if (!application.fit || !application.resume) {
    return "A reviewable application must contain grounded fit and resume outputs before browser preparation.";
  }
  if (!["preparing", "needs_input", "ready_to_submit", "failed"].includes(careerJob.status)) {
    return "Only a prepared, blocked, or retryable career job may be opened in the browser.";
  }
  if (careerJob.sourceMode !== "live" || careerJob.actionability !== "actionable") {
    return "The browser host requires a live actionable posting.";
  }
  if (profile.profileKind !== "private") {
    return "A private/local candidate profile is required before opening a live application form.";
  }

  if (!careerJob.job.sourceUrl || !careerJob.job.applicationUrl) {
    return "The posting does not contain both its source and application URLs.";
  }
  if (application.job.sourceUrl !== careerJob.job.sourceUrl || application.job.applicationUrl !== careerJob.job.applicationUrl) {
    return "The application packet URL provenance does not match the career job.";
  }
  if (application.job.company !== careerJob.job.company || application.job.title !== careerJob.job.title) {
    return "The application packet role does not match the career job.";
  }

  try {
    if (new URL(careerJob.job.applicationUrl).protocol !== "https:") {
      return "The application URL must use HTTPS.";
    }
  } catch {
    return "The application URL is not syntactically valid.";
  }
  const sourceId = nonEmpty(careerJob.sourceId) ?? "";
  const applicationClassification = classifyJobUrl(careerJob.job.applicationUrl);
  if (sourceId.startsWith("lever:")) {
    const postingId = nonEmpty(careerJob.sourceRecordId);
    if (!postingId) return "The posting is missing its verified Lever source identity.";
    let site: string;
    try {
      site = leverSourceId(sourceId.slice("lever:".length)).slice("lever:".length);
    } catch {
      return "The Lever SITE identifier is invalid.";
    }
    if (!isVerifiedLeverHostedUrl(careerJob.job.sourceUrl, site, postingId)) {
      return "The posting URL is not the verified Lever hosted URL for this provider ID.";
    }
    if (!isVerifiedLeverApplicationUrl(careerJob.job.applicationUrl, site, postingId)) {
      return "The application URL is not the verified Lever /apply path for this provider ID.";
    }
    return undefined;
  }

  if (applicationClassification.kind === "lever" &&
    applicationClassification.siteIdentifier &&
    applicationClassification.postingIdentifier &&
    isVerifiedLeverHostedUrl(
      careerJob.job.sourceUrl,
      applicationClassification.siteIdentifier,
      applicationClassification.postingIdentifier,
    ) &&
    isVerifiedLeverApplicationUrl(
      careerJob.job.applicationUrl,
      applicationClassification.siteIdentifier,
      applicationClassification.postingIdentifier,
    )) {
    const resolution = careerJob.destinationResolution;
    const destinationMatches = resolution?.status === "resolved" &&
      resolution.actionable === true &&
      resolution.ats === "Lever" &&
      resolution.destinationUrl === careerJob.job.applicationUrl;
    const directLeverSource = nonEmpty(careerJob.sourceRecordId) === applicationClassification.postingIdentifier;
    if (!destinationMatches && !directLeverSource) {
      return "The Lever destination is not independently verified for this posting.";
    }
    return undefined;
  }

  if (applicationClassification.kind === "greenhouse" &&
    applicationClassification.siteIdentifier && applicationClassification.postingIdentifier) {
    const curatedGreenhouse = sourceId === "curated-live";
    if ((curatedGreenhouse && !isVerifiedGreenhouseHostedUrl(
      careerJob.job.sourceUrl,
      applicationClassification.siteIdentifier,
      applicationClassification.postingIdentifier,
    )) || !isVerifiedGreenhouseApplicationUrl(
      careerJob.job.applicationUrl,
      applicationClassification.siteIdentifier,
      applicationClassification.postingIdentifier,
    )) {
      return "The Greenhouse source and application URLs are not the same verified posting.";
    }
    if (!curatedGreenhouse && !careerJob.destinationResolution && !sourceId.startsWith("greenhouse:")) {
      return "The Greenhouse destination is not independently verified for this posting.";
    }
    const expectedSourceRecordId = curatedGreenhouse
      ? `greenhouse:${applicationClassification.siteIdentifier}:${applicationClassification.postingIdentifier}`
      : sourceId.startsWith("greenhouse:") ? applicationClassification.postingIdentifier : undefined;
    if (expectedSourceRecordId !== undefined && careerJob.sourceRecordId !== expectedSourceRecordId) {
      return "The Greenhouse source provenance does not match the verified posting identity.";
    }
    return undefined;
  }

  if (applicationClassification.kind === "rippling" &&
    applicationClassification.siteIdentifier &&
    applicationClassification.postingIdentifier &&
    isVerifiedRipplingApplicationUrl(
      careerJob.job.applicationUrl,
      applicationClassification.siteIdentifier,
      applicationClassification.postingIdentifier,
    )) {
    const resolution = careerJob.destinationResolution;
    const destinationMatches = resolution?.status === "resolved" &&
      resolution.actionable === true &&
      resolution.ats === "Rippling" &&
      (resolution.destinationUrl === careerJob.job.applicationUrl ||
        ripplingApplicationUrl(resolution.destinationUrl) === ripplingApplicationUrl(careerJob.job.applicationUrl));
    const directRipplingSource = Boolean(careerJob.sourceRecordId) &&
      careerJob.sourceRecordId === `${applicationClassification.siteIdentifier}:${applicationClassification.postingIdentifier}` &&
      isVerifiedRipplingHostedUrl(
        careerJob.job.sourceUrl,
        applicationClassification.siteIdentifier,
        applicationClassification.postingIdentifier,
      );
    if (!destinationMatches && !directRipplingSource) {
      return "The Rippling destination is not independently verified for this posting.";
    }
    return undefined;
  }

  if (applicationClassification.kind === "ashby" &&
    applicationClassification.siteIdentifier &&
    applicationClassification.postingIdentifier &&
    isVerifiedAshbyHostedUrl(
      careerJob.job.sourceUrl,
      applicationClassification.siteIdentifier,
      applicationClassification.postingIdentifier,
    ) &&
    isVerifiedAshbyApplicationUrl(
      careerJob.job.applicationUrl,
      applicationClassification.siteIdentifier,
      applicationClassification.postingIdentifier,
    )) {
    const resolution = careerJob.destinationResolution;
    const destinationMatches = resolution?.status === "resolved" &&
      resolution.actionable === true &&
      resolution.ats === "Ashby" &&
      resolution.destinationUrl === careerJob.job.applicationUrl;
    const directAshbySource = nonEmpty(careerJob.sourceRecordId) ===
      `${applicationClassification.siteIdentifier}:${applicationClassification.postingIdentifier}`;
    if (!destinationMatches && !directAshbySource) {
      return "The Ashby destination is not independently verified for this posting.";
    }
    return undefined;
  }

  if (applicationClassification.kind === "workday" &&
    applicationClassification.siteIdentifier &&
    isVerifiedWorkdayApplicationUrl(careerJob.job.applicationUrl, applicationClassification.siteIdentifier)) {
    const sourcePostingId = workdayPostingId(careerJob.job.sourceUrl);
    const applicationPostingId = workdayPostingId(careerJob.job.applicationUrl);
    if (!isVerifiedWorkdayHostedUrl(careerJob.job.sourceUrl, applicationClassification.siteIdentifier) ||
      !sourcePostingId || sourcePostingId !== applicationPostingId) {
      return "The Workday source and application URLs are not the same verified posting.";
    }
    const resolution = careerJob.destinationResolution;
    const destinationMatches = resolution?.status === "resolved" &&
      resolution.actionable === true &&
      resolution.ats === "Workday" &&
      resolution.destinationUrl === careerJob.job.applicationUrl &&
      workdayPostingId(resolution.destinationUrl) === applicationPostingId;
    if (!destinationMatches) {
      return "The Workday destination is not independently verified for this posting.";
    }
    return undefined;
  }

  if (isVerifiedYouHiredApplicationUrl(careerJob.job.applicationUrl)) {
    const postingId = youHiredPostingId(careerJob.job.applicationUrl);
    const resolution = careerJob.destinationResolution;
    const destinationMatches = resolution?.status === "resolved" &&
      resolution.actionable === true &&
      resolution.ats === "Custom" &&
      resolution.destinationUrl === careerJob.job.applicationUrl;
    const directCuratedSource = sourceId === "curated-live" &&
      Boolean(postingId) &&
      careerJob.sourceRecordId === `youhired:${postingId}` &&
      careerJob.job.sourceUrl === careerJob.job.applicationUrl;
    if (!destinationMatches && !directCuratedSource) {
      return "The YouHired destination is not independently verified for this posting.";
    }
    return undefined;
  }

  if (isVerifiedMatlenApplicationUrl(careerJob.job.applicationUrl)) {
    const postingId = matlenPostingId(careerJob.job.applicationUrl);
    const resolution = careerJob.destinationResolution;
    const destinationMatches = resolution?.status === "resolved" &&
      resolution.actionable === true &&
      resolution.ats === "Custom" &&
      resolution.destinationUrl === careerJob.job.applicationUrl;
    const directCuratedSource = sourceId === "curated-live" &&
      Boolean(postingId) &&
      careerJob.sourceRecordId === `matlensilver:${postingId}` &&
      careerJob.job.sourceUrl === careerJob.job.applicationUrl;
    if (!destinationMatches && !directCuratedSource) {
      return "The Matlen Silver destination is not independently verified for this posting.";
    }
    if (!postingId || careerJob.job.sourceUrl !== careerJob.job.applicationUrl) {
      return "The Matlen Silver source and application URL must be the same verified job route.";
    }
    return undefined;
  }

  if (isVerifiedProtagonaApplicationUrl(careerJob.job.applicationUrl)) {
    const postingId = protagonaPostingId(careerJob.job.applicationUrl);
    const resolution = careerJob.destinationResolution;
    const destinationMatches = resolution?.status === "resolved" &&
      resolution.actionable === true &&
      resolution.ats === "Custom" &&
      resolution.destinationUrl === careerJob.job.applicationUrl;
    const directCuratedSource = sourceId === "curated-live" &&
      Boolean(postingId) &&
      careerJob.sourceRecordId === `protagona:${postingId}` &&
      careerJob.job.sourceUrl === careerJob.job.applicationUrl;
    if (!destinationMatches && !directCuratedSource) {
      return "The Protagona destination is not independently verified for this posting.";
    }
    if (!postingId || careerJob.job.sourceUrl !== careerJob.job.applicationUrl) {
      return "The Protagona source and application URL must be the same verified job route.";
    }
    return undefined;
  }

  if (isVerifiedGustoApplicationUrl(careerJob.job.applicationUrl)) {
    const postingId = gustoPostingId(careerJob.job.applicationUrl);
    const resolution = careerJob.destinationResolution;
    const destinationMatches = resolution?.status === "resolved" &&
      resolution.actionable === true &&
      resolution.ats === "Custom" &&
      resolution.destinationUrl === careerJob.job.applicationUrl;
    const directCuratedSource = sourceId === "curated-live" &&
      Boolean(postingId) &&
      careerJob.sourceRecordId === `gusto:${postingId}` &&
      isVerifiedGustoHostedUrl(careerJob.job.sourceUrl) &&
      gustoPostingId(careerJob.job.sourceUrl) === postingId;
    if (!destinationMatches && !directCuratedSource) {
      return "The Gusto destination is not independently verified for this posting.";
    }
    if (!postingId || !isVerifiedGustoHostedUrl(careerJob.job.sourceUrl) ||
      gustoPostingId(careerJob.job.sourceUrl) !== postingId) {
      return "The Gusto posting and application URLs do not match the same verified posting.";
    }
    return undefined;
  }

  // Unknown ATS/direct forms are admitted only after the destination resolver
  // records explicit official-employer evidence for this exact URL. Aggregator
  // links never satisfy this branch because they do not produce this provenance.
  if (applicationClassification.kind === "custom") {
    const resolution = careerJob.destinationResolution;
    if (resolution?.status === "resolved" && resolution.actionable === true &&
      resolution.ats === "Custom" && resolution.provenance === "official_employer_evidence" &&
      resolution.destinationUrl === careerJob.job.applicationUrl) {
      return undefined;
    }
    return "The direct application destination lacks independently verified official-employer evidence; the posting does not have a supported verified application destination.";
  }

  return "The posting does not have a supported verified application destination.";
}

export function assertTrustedExecutionRequest(value: unknown): asserts value is ExecutionHostRequest {
  const reason = trustedExecutionRequestReason(value);
  if (reason) throw new Error(reason);
}
