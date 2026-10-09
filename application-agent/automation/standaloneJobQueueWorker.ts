import { GoogleSheetsJobQueue, QUEUE_DESTINATION_INPUT_MARKER, type ClaimedSheetJob, type GoogleSheetsJobQueueConfig } from "./googleSheetsJobQueue";
import type { GoogleSheetsApiTransport } from "./googleSheetsJobTracker";
import type { CareerJob } from "../src/domain/campaignTypes";
import {
  classifyJobUrl,
  gustoPostingId,
  isVerifiedAshbyApplicationUrl,
  isVerifiedAshbyHostedUrl,
  isVerifiedGustoApplicationUrl,
  isVerifiedGustoHostedUrl,
  isVerifiedMatlenApplicationUrl,
  isVerifiedProtagonaApplicationUrl,
  isVerifiedRipplingApplicationUrl,
  isVerifiedRipplingHostedUrl,
  isVerifiedWorkdayApplicationUrl,
  isVerifiedWorkdayHostedUrl,
  matlenPostingId,
  protagonaPostingId,
  workdayPostingId,
  isVerifiedYouHiredApplicationUrl,
  youHiredPostingId,
} from "../src/domain/jobUrlClassifier";
import { isVerifiedGreenhouseApplicationUrl, isVerifiedGreenhouseHostedUrl } from "../src/domain/greenhouseJobSource";
import { isVerifiedLeverApplicationUrl, isVerifiedLeverHostedUrl } from "../src/domain/leverJobSource";
import { isContractRole } from "../src/domain/policies";
import type { ApplicationRouteDiscoveryInput } from "./applicationRouteDiscovery";
import type { BrowserApplicationRouteDiscovery } from "../src/domain/executor";

export interface StandaloneJobProcessor {
  process(job: ClaimedSheetJob): Promise<{ status: "Needs Input" | "Ready to Submit" | "Submitted" | "Confirmed" | "Expired" | "Skipped" | "Failed"; proofId?: string; confirmationEvidence?: string; error?: string }>;
}

export interface StandaloneWorkerResult { claimed?: string; status?: string; error?: string; idle: boolean; }
export interface StandaloneJobQueueTickOptions {
  targetJobId?: string;
  allowTargetReadyToSubmit?: boolean;
  /** Polling may retry the row currently waiting for a human response. The
   * processor must remain idempotent; this is what lets a Slack answer resume
   * the same queue row before the worker advances to the next one. */
  allowNeedsInputRetry?: boolean;
  heartbeatMs?: number;
  setIntervalFn?: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
}

/** Ashby queue rows commonly store the direct /application URL. The career
 * service still needs the paired public posting URL for identity verification. */
export function deriveQueuePostingUrl(jobLink: string): string {
  const classification = classifyJobUrl(jobLink);
  if (!["lever", "rippling", "ashby", "workday", "custom"].includes(classification.kind)) return jobLink;
  try {
    const url = new URL(jobLink);
    if (classification.kind === "custom" && isVerifiedGustoApplicationUrl(jobLink)) {
      url.pathname = url.pathname.replace(/\/applicants\/new\/?$/i, "");
    } else if (["lever", "rippling"].includes(classification.kind) && /\/apply\/?$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/apply\/?$/i, "");
    } else if (classification.kind === "ashby" && /\/application\/?$/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/application\/?$/i, "");
    } else if (classification.kind === "workday") {
      const applyIndex = url.pathname.toLowerCase().indexOf("/apply");
      if (applyIndex < 0) return jobLink;
      url.pathname = url.pathname.slice(0, applyIndex);
    } else return jobLink;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return jobLink;
  }
}

/** Ashby queue rows may contain the public posting route; make its form route explicit. */
export function deriveQueueApplicationUrl(jobLink: string): string {
  const classification = classifyJobUrl(jobLink);
  if (!["lever", "rippling", "ashby", "workday", "custom"].includes(classification.kind)) return jobLink;
  try {
    const url = new URL(jobLink);
    if (classification.kind === "custom" && isVerifiedGustoHostedUrl(jobLink)) {
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/applicants/new`;
    } else if (classification.kind === "lever" || classification.kind === "rippling") {
      if (/\/apply\/?$/i.test(url.pathname)) return url.toString();
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/apply`;
    } else if (classification.kind === "ashby") {
      if (/\/application\/?$/i.test(url.pathname)) return url.toString();
      if (url.pathname.split("/").filter(Boolean).length !== 2) return jobLink;
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/application`;
    } else if (classification.kind === "workday") {
      if (/\/apply(?:\/|$)/i.test(url.pathname)) return url.toString();
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/apply`;
    } else return jobLink;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return jobLink;
  }
}

/**
 * Validate the URL pair before invoking the career service. Queue input can
 * come from a daily-hunt tracker and may contain an aggregator/listing URL;
 * those are review items, not system failures and must never reach a browser.
 */
export function queueDestinationPreflightReason(job: Pick<ClaimedSheetJob, "jobLink">): string | undefined {
  const sourceUrl = deriveQueuePostingUrl(job.jobLink);
  const applicationUrl = deriveQueueApplicationUrl(job.jobLink);
  const classification = classifyJobUrl(applicationUrl);
  const source = classifyJobUrl(sourceUrl);
  if (!classification.canonicalUrl || !source.canonicalUrl || classification.kind === "unknown") {
    return "Needs review: the queue link is not a valid supported application URL.";
  }
  if (classification.kind === "lever" && classification.siteIdentifier && classification.postingIdentifier &&
    isVerifiedLeverHostedUrl(source.canonicalUrl, classification.siteIdentifier, classification.postingIdentifier) &&
    isVerifiedLeverApplicationUrl(classification.canonicalUrl, classification.siteIdentifier, classification.postingIdentifier)) return undefined;
  if (classification.kind === "greenhouse" && classification.siteIdentifier && classification.postingIdentifier &&
    isVerifiedGreenhouseHostedUrl(source.canonicalUrl, classification.siteIdentifier, classification.postingIdentifier) &&
    isVerifiedGreenhouseApplicationUrl(classification.canonicalUrl, classification.siteIdentifier, classification.postingIdentifier)) return undefined;
  if (classification.kind === "rippling" && classification.siteIdentifier && classification.postingIdentifier &&
    isVerifiedRipplingHostedUrl(source.canonicalUrl, classification.siteIdentifier, classification.postingIdentifier) &&
    isVerifiedRipplingApplicationUrl(classification.canonicalUrl, classification.siteIdentifier, classification.postingIdentifier)) return undefined;
  if (classification.kind === "ashby" && classification.siteIdentifier && classification.postingIdentifier &&
    isVerifiedAshbyHostedUrl(source.canonicalUrl, classification.siteIdentifier, classification.postingIdentifier) &&
    isVerifiedAshbyApplicationUrl(classification.canonicalUrl, classification.siteIdentifier, classification.postingIdentifier)) return undefined;
  if (classification.kind === "workday" && classification.siteIdentifier &&
    isVerifiedWorkdayHostedUrl(source.canonicalUrl, classification.siteIdentifier) &&
    isVerifiedWorkdayApplicationUrl(classification.canonicalUrl, classification.siteIdentifier) &&
    workdayPostingId(source.canonicalUrl) === workdayPostingId(classification.canonicalUrl)) return undefined;
  if (isVerifiedYouHiredApplicationUrl(classification.canonicalUrl) && source.canonicalUrl === classification.canonicalUrl && youHiredPostingId(classification.canonicalUrl)) return undefined;
  if (isVerifiedMatlenApplicationUrl(classification.canonicalUrl) && source.canonicalUrl === classification.canonicalUrl && matlenPostingId(classification.canonicalUrl)) return undefined;
  if (isVerifiedProtagonaApplicationUrl(classification.canonicalUrl) && source.canonicalUrl === classification.canonicalUrl && protagonaPostingId(classification.canonicalUrl)) return undefined;
  if (isVerifiedGustoApplicationUrl(classification.canonicalUrl) && isVerifiedGustoHostedUrl(source.canonicalUrl) && gustoPostingId(source.canonicalUrl) === gustoPostingId(classification.canonicalUrl)) return undefined;
  return "Needs review: this listing is not an executable verified Lever, Greenhouse, Rippling, Ashby, Workday, YouHired, Matlen Silver, Protagona, or Gusto application route. The queue will not open it automatically.";
}

/**
 * Polling must survive a transient Sheets/processor failure. The underlying
 * tick still owns all claim, lease, proof, and submission-authority checks;
 * this boundary only prevents one failed invocation from terminating --poll.
 */
export async function runStandaloneJobQueuePollTick(
  queue: GoogleSheetsJobQueue,
  processor: StandaloneJobProcessor,
  workerId: string,
  now = new Date(),
): Promise<StandaloneWorkerResult> {
  try {
    return await runStandaloneJobQueueTick(queue, processor, workerId, now, { allowNeedsInputRetry: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 500) : "Standalone queue polling failed.";
    return { status: "Failed", error: reason, idle: false };
  }
}

export interface CareerServiceQueueBoundary {
  processCuratedJob(campaignId: string, input: { companyHint?: string; titleHint?: string; sourceUrl: string; applicationUrl: string; rawText: string; description: string; isExample?: boolean; queueSelected?: boolean; resumeFamily?: string; queueFit?: string; queuePriority?: string }): Promise<CareerJob>;
  processCuratedJobThroughHost?(campaignId: string, input: { companyHint?: string; titleHint?: string; sourceUrl: string; applicationUrl: string; rawText: string; description: string; isExample?: boolean; queueSelected?: boolean; resumeFamily?: string; queueFit?: string; queuePriority?: string }): Promise<CareerJob>;
  discoverApplicationRoute?(input: ApplicationRouteDiscoveryInput): Promise<BrowserApplicationRouteDiscovery>;
  getApplication?(applicationId: string): { submissionProof?: { externalApplicationId: string } };
}

function recoverableBrowserInteractionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /select option .*not uniquely verified/i.test(message) ||
    /verified option .*could not be committed/i.test(message);
}

/** Opt-in adapter from a claimed row to the existing career-service boundary. */
export function createCareerServiceQueueProcessor(service: CareerServiceQueueBoundary, campaignId: string): StandaloneJobProcessor {
  return {
    async process(job) {
      let sourceUrl = deriveQueuePostingUrl(job.jobLink);
      let applicationUrl = deriveQueueApplicationUrl(job.jobLink);
      let discoveredApplicationUrl: string | undefined;
      const destinationReason = queueDestinationPreflightReason(job);
      if (destinationReason) {
        if (!service.discoverApplicationRoute) {
          return {
            status: "Needs Input",
            error: `${QUEUE_DESTINATION_INPUT_MARKER} Needs Input — ${destinationReason.replace(/^Needs review:\s*/i, "")} Update this tracker row with a verified application URL before retrying.`,
          };
        }
        let discovery: BrowserApplicationRouteDiscovery;
        try {
          discovery = await service.discoverApplicationRoute({
            jobId: job.jobId,
            company: job.company,
            role: job.role,
            sourceUrl: job.jobLink,
          });
        } catch {
          return {
            status: "Needs Input",
            error: `${QUEUE_DESTINATION_INPUT_MARKER} Needs Input — the listing could not be inspected for a safe Apply link. Update this tracker row with a verified application URL before retrying.`,
          };
        }
        if (discovery.status !== "resolved" || !discovery.applicationUrl) {
          const reason = discovery.reason ?? "the listing did not produce one safe, supported application destination";
          return {
            status: "Needs Input",
            error: `${QUEUE_DESTINATION_INPUT_MARKER} Needs Input — ${reason} Update this tracker row with a verified application URL before retrying.`,
          };
        }
        const discoveredJob = { ...job, jobLink: discovery.applicationUrl };
        const discoveredReason = queueDestinationPreflightReason(discoveredJob);
        if (discoveredReason) {
          const destinationEvidence = discovery.evidence
            .filter((item) => item.startsWith("destination-host:"))
            .slice(0, 1)
            .join("; ");
          return {
            status: "Needs Input",
            error: `${QUEUE_DESTINATION_INPUT_MARKER} Needs Input — the Apply link led to a destination the agent could not verify as a supported application route${destinationEvidence ? ` (${destinationEvidence})` : ""}. Update this tracker row with a verified application URL before retrying.`,
          };
        }
        discoveredApplicationUrl = discovery.applicationUrl;
        sourceUrl = deriveQueuePostingUrl(discovery.applicationUrl);
        applicationUrl = deriveQueueApplicationUrl(discovery.applicationUrl);
      }
      const groundedEmploymentType = job.description?.match(/^Employment Type:\s*(.+)$/im)?.[1];
      if (isContractRole({ employmentType: groundedEmploymentType, description: job.description ?? "" })) return { status: "Skipped", error: "Contract, 1099, freelance, or task-based roles are excluded by candidate policy." };
      const context = [job.location ? `Location: ${job.location}` : "", job.resumeVersion ? `Resume Version: ${job.resumeVersion}` : "", job.priority ? `Priority: ${job.priority}` : "", job.fit ? `Fit: ${job.fit}` : "", job.description ?? ""].filter(Boolean).join("\n");
      const input = {
        company: job.company,
        title: job.role,
        sourceUrl,
        applicationUrl,
        companyHint: job.company,
        titleHint: job.role,
        rawText: `${job.role} at ${job.company}\n${job.jobLink}${discoveredApplicationUrl ? `\nDiscovered application route: ${discoveredApplicationUrl}` : ""}${context ? `\n${context}` : ""}`,
        description: context || `${job.role} at ${job.company}`,
        queueSelected: true,
        ...(job.resumeVersion ? { resumeFamily: job.resumeVersion } : {}),
        ...(job.fit ? { queueFit: job.fit } : {}),
        ...(job.priority ? { queuePriority: job.priority } : {}),
      };
      let careerJob: CareerJob;
      try {
        careerJob = await (service.processCuratedJobThroughHost ?? service.processCuratedJob).call(service, campaignId, input);
      } catch (error) {
        if (recoverableBrowserInteractionError(error)) {
          return { status: "Needs Input", error: "Browser select verification needs human review before this application can continue." };
        }
        throw error;
      }
      if (careerJob.status === "failed") {
        if (recoverableBrowserInteractionError(careerJob.decisionReason)) {
          return { status: "Needs Input", error: "Browser select verification needs human review before this application can continue." };
        }
        return { status: "Failed", error: careerJob.decisionReason ?? "Career application processing failed." };
      }
      if (careerJob.status === "rejected") return { status: "Skipped", error: careerJob.decisionReason ?? "The career service rejected this posting." };
      if (careerJob.status === "held") {
        const reason = careerJob.decisionReason ?? "Career job remains held for review.";
        if (/location|fit|policy|contract|1099|freelance|task-based|unsupported|not eligible/i.test(reason)) return { status: "Skipped", error: reason };
        return { status: "Needs Input", error: reason };
      }
      const executionStatus = careerJob.execution?.status;
      if (executionStatus === "submitted") {
        const proofId = careerJob.applicationId ? service.getApplication?.(careerJob.applicationId)?.submissionProof?.externalApplicationId : undefined;
        return proofId ? { status: "Submitted", proofId } : { status: "Failed", error: "Browser execution reported submitted without deterministic proof." };
      }
      if (executionStatus === "needs_input" || executionStatus === "waiting_for_human" || careerJob.status === "needs_input") return { status: "Needs Input", ...(executionStatus === "failed" ? { error: "Browser execution failed before a safe queue state; retry may be required." } : {}) };
      if (executionStatus === "failed" || executionStatus === "cancelled" || executionStatus === "closed") {
        const hasOpenHumanBlocker = careerJob.blockers.some((blocker) => blocker.status === "open");
        return hasOpenHumanBlocker
          ? { status: "Needs Input", error: "Browser execution ended with an open human blocker; Slack input is required before this application can continue." }
          : { status: "Failed", error: careerJob.decisionReason ?? "Browser execution failed before a deterministic submission state; the queue will stop for repair and retry." };
      }
      if (executionStatus !== "ready_to_submit") return { status: "Needs Input", error: "Browser execution did not reach a verified ready-to-submit state." };
      return { status: "Ready to Submit" };
    },
  };
}

/** One bounded polling tick. A scheduler may call this repeatedly. */
export async function runStandaloneJobQueueTick(
  queue: GoogleSheetsJobQueue,
  processor: StandaloneJobProcessor,
  workerId: string,
  now = new Date(),
  options: StandaloneJobQueueTickOptions = {},
): Promise<StandaloneWorkerResult> {
  const claimed = await queue.claimNext(workerId, now, options.targetJobId, options.allowTargetReadyToSubmit === true, options.allowNeedsInputRetry === true);
  if (!claimed) {
    if (options.targetJobId === undefined) {
      const firstBlocker = (await queue.list()).find((item) =>
        !["Confirmed", "Expired", "Skipped", "Failed"].includes(item.status) &&
        !(item.status === "Ready" || item.status === "Claimed" || item.status === "Applying" || item.status === "Needs Input" && options.allowNeedsInputRetry === true && !item.lastError?.includes(QUEUE_DESTINATION_INPUT_MARKER)),
      );
      if (firstBlocker?.status === "Needs Input") return { status: firstBlocker.status, error: firstBlocker.lastError, idle: false };
    }
    return { idle: true };
  }
  try {
    const renewed = await queue.renew(claimed.jobId, workerId, claimed.attemptId, now);
    await queue.update(claimed.jobId, { status: "Applying", workerId, leaseUntil: renewed.leaseUntil, attemptId: claimed.attemptId });
    const heartbeatMs = options.heartbeatMs ?? Math.max(1, Math.floor(queue.leaseDurationMs / 3));
    if (!Number.isInteger(heartbeatMs) || heartbeatMs <= 0) throw new Error("Standalone queue heartbeat interval must be positive.");
    const setIntervalFn = options.setIntervalFn ?? ((callback, delayMs) => setInterval(callback, delayMs));
    const clearIntervalFn = options.clearIntervalFn ?? ((handle) => clearInterval(handle));
    let heartbeatError: Error | undefined;
    let heartbeatInFlight: Promise<void> | undefined;
    const beat = () => {
      if (heartbeatInFlight || heartbeatError) return;
      heartbeatInFlight = queue.renew(claimed.jobId, workerId, claimed.attemptId).then(() => undefined).catch((error) => {
        heartbeatError = error instanceof Error ? error : new Error("Standalone queue lease heartbeat failed.");
      }).finally(() => { heartbeatInFlight = undefined; });
    };
    const heartbeat = setIntervalFn(beat, heartbeatMs);
    let result;
    try {
      result = await processor.process(claimed);
    } finally {
      clearIntervalFn(heartbeat);
      if (heartbeatInFlight) await heartbeatInFlight;
    }
    if (heartbeatError) throw heartbeatError;
    await queue.renew(claimed.jobId, workerId, claimed.attemptId);
    const updated = await queue.update(claimed.jobId, { status: result.status, workerId, attemptId: claimed.attemptId, ...(result.proofId ? { proofId: result.proofId } : {}), ...(result.confirmationEvidence ? { confirmationEvidence: result.confirmationEvidence } : {}), ...(result.error ? { lastError: result.error } : {}) });
    return { claimed: claimed.jobId, status: updated.status, idle: false };
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 500) : "Standalone job processing failed.";
    const current = await queue.get(claimed.jobId).catch(() => undefined);
    if (current?.workerId === workerId && current.attemptId === claimed.attemptId) await queue.update(claimed.jobId, { status: "Failed", workerId, attemptId: claimed.attemptId, lastError: reason });
    else throw error;
    return { claimed: claimed.jobId, status: "Failed", idle: false };
  }
}

export function createStandaloneGoogleSheetsWorker(config: GoogleSheetsJobQueueConfig, transport: GoogleSheetsApiTransport): GoogleSheetsJobQueue {
  return new GoogleSheetsJobQueue(config, transport);
}
