import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ApplicationService, type ApplicationServiceOptions } from "../../src/service/applicationService";
import {
  CareerAgentService,
  type CareerAgentServiceOptions,
  type LegacyAttentionRepairOptions,
  type LegacyAttentionRepairResult,
} from "../../src/service/careerAgentService";
import type { ApplicationExecutor } from "../../src/domain/executor";
import { UnavailableApplicationExecutor } from "../../src/domain/executor";
import { BraveSearchDiscoveryProvider } from "../../src/domain/braveSearchDiscoveryProvider";
import {
  BoundedApplicationDestinationResolver,
  parseDestinationCandidates,
  StaticDestinationEvidenceLookup,
  type ApplicationDestinationResolver,
} from "../../src/domain/applicationDestinationResolver";
import type { Campaign, CampaignRunResult, CareerJob, CreateCampaignInput } from "../../src/domain/campaignTypes";
import type { DailyHuntProcessingResult } from "../../src/service/careerAgentService";
import { HIMALAYAS_SOURCE_ID, jobSourceConfigId } from "../../src/domain/campaignTypes";
import { AshbyBoardSource } from "../../src/domain/ashbyBoardSource";
import { DEFAULT_DISCOVERY_CONFIG, parseDiscoveryConfig, type DiscoveryConfig } from "../../src/domain/discoveryConfig";
import { MUSE_SOURCE_ID, MuseJobSource } from "../../src/domain/museJobSource";
import type { ExecutionHostRequest, ExecutionHostSnapshot, ExecutionHostStatus } from "../../src/domain/executionHostTypes";
import { createGreenhouseJobSources, DEFAULT_GREENHOUSE_API_BASE_URL, parseGreenhouseBoards } from "../../src/domain/greenhouseJobSource";
import { JobReferenceResolver, JobReferenceSource } from "../../src/domain/jobReferenceResolver";
import {
  createLeverJobSources,
  createLeverJobSource,
  DEFAULT_LEVER_POSTINGS_BASE_URL,
  parseBroadDiscoveryEnabled,
  parseLeverSites,
  createLiveCampaignInput,
} from "../../src/domain/leverJobSource";
import { createRemotiveJobSource, DEFAULT_REMOTIVE_API_BASE_URL } from "../../src/domain/remotiveJobSource";
import { createHimalayasJobSource, DEFAULT_HIMALAYAS_API_BASE_URL } from "../../src/domain/himalayasJobSource";
import { JobScout, type JobSource } from "../../src/domain/scout";
import type { CandidateProfile, JobIntakeInput, ResumeFamilyId } from "../../src/domain/types";
import { parseCandidateProfile } from "../../src/domain/profile";
import type { JobTracker } from "../../src/domain/tracker";
import type { CareerRepository } from "../../src/persistence/careerRepository";
import { LocalStorageCareerRepository } from "../../src/persistence/careerRepository";
import type { ApplicationRepository } from "../../src/persistence/applicationRepository";
import { LocalStorageApplicationRepository } from "../../src/persistence/applicationRepository";
import type { KeyValueStorage } from "../../src/persistence/storage";
import {
  HttpExecutionHostClient,
  ExecutionHostResponseError,
  type ExecutionHostClientOptions,
} from "../../src/service/executionHostClient";
import { createConfiguredGoogleSheetsJobTracker, createConfiguredGoogleSheetsTransport, type GoogleSheetsEnvironment } from "../googleSheetsJobTracker";
import { GoogleSheetsJobQueue } from "../googleSheetsJobQueue";
import { DEFAULT_LEARNED_BOARDS_FILE, loadLearnedBoards } from "../boardLearning";
import { applyResumeChoiceToSheets } from "../resumeChoiceSheets";
import { resolveExecutionHostConfig, resolveResumePathsFromEnv, type ExecutionHostEnvironment } from "../executionHost/config";
import { SlackNotificationAdapter } from "../slack/slackNotificationAdapter";
import { resolveSlackConfig, type SlackEnvironment } from "../slack/config";
import { createPlaywrightLeverBrowserExecutor } from "../createLeverBrowserExecutor";
import { OllamaApplicationAnswerDraftGenerator } from "../answerDraft/ollamaApplicationAnswerDraftGenerator";
import { enrichJobIntake } from "../../src/domain/postingEnrichment";
import { FileAnswerBankStore } from "../answerBank/fileAnswerBankStore";
import { isAwaitingReceipt, matchReceiptToJob } from "../../src/domain/applicationReceipt";
import { renderWaitingBoard, waitingBoardItems, waitingBoardSignature, WAITING_BOARD_RECENT_MS } from "../../src/domain/waitingBoard";
import { gmailInbox, type InboxSource } from "../gmailInbox";
import { createGoogleOAuthAccessTokenProvider, gmailSecurityCodesEnabled, resolveGoogleAuthMode } from "../googleOAuth";
import { createOllamaAnswerBankMatcher } from "../answerBank/ollamaAnswerBankMatcher";
import { isUsableResumeArtifact } from "../resume/resumeArtifact";
import { normalizeJobSearchIntent, type JobSearchIntent } from "../../src/domain/searchIntent";
import { DEFAULT_CAREER_AGENT_STATE_FILE, FileKeyValueStorage } from "./fileKeyValueStorage";
import { assertDuplicateRiskRetryAuthorization, assertSubmitPreparedApplicationPreflight } from "./submitPreparedApplicationPreflight";
import { authorizeThenSubmit } from "./submitPreparedApplicationFlow";
import { attentionDescriptorSignature, type AttentionEvent, type AttentionResponse, type NotificationAdapter, type PersistedAttentionEvent, type QueueHandoffNotice } from "../../src/domain/attention";
import { DurableSubmissionAuthority } from "../executionHost/submissionAuthority";

export interface BackgroundCareerAgentEnvironment extends ExecutionHostEnvironment, SlackEnvironment {
  VITE_REMOTIVE_API_BASE_URL?: string;
  /** Server-only endpoint override for the credential-free Himalayas API. */
  ATELIER_HIMALAYAS_API_BASE_URL?: string;
  VITE_LEVER_SITES?: string;
  VITE_LEVER_API_BASE_URL?: string;
  VITE_GREENHOUSE_BOARDS?: string;
  VITE_GREENHOUSE_API_BASE_URL?: string;
  VITE_BROAD_DISCOVERY_ENABLED?: string;
  VITE_EXECUTION_HOST_BASE_URL?: string;
  ATELIER_EXECUTION_HOST_BASE_URL?: string;
  ATELIER_CAREER_AGENT_STATE_FILE?: string;
  ATELIER_CAREER_AGENT_PROFILE_FILE?: string;
  ATELIER_CAREER_AGENT_SEARCH_INTENT_FILE?: string;
  ATELIER_CAREER_AGENT_DISCOVERY_FILE?: string;
  /** Optional bounded public destination evidence; never read by the browser client. */
  ATELIER_CAREER_AGENT_DESTINATION_EVIDENCE_FILE?: string;
  ATELIER_CAREER_AGENT_BROWSER_ENABLED?: string;
  ATELIER_CAREER_AGENT_CAMPAIGN_ID?: string;
  ATELIER_GOOGLE_SHEET_QUEUE_TAB?: string;
  /** Optional one-shot server-local snapshot of the Daily job hunt report. */
  ATELIER_CAREER_AGENT_DAILY_HUNT_FILE?: string;
  /** Close the process after a one-shot Daily job hunt intake. */
  ATELIER_CAREER_AGENT_EXIT_AFTER_DAILY_HUNT?: string;
  ATELIER_CAREER_AGENT_RUN_ON_START?: string;
  ATELIER_CAREER_AGENT_CREATE_CAMPAIGN?: string;
  ATELIER_CAREER_AGENT_HOST_POLL_INTERVAL_MS?: string;
  ATELIER_CAREER_AGENT_HOST_POLL_TIMEOUT_MS?: string;
  /** Optional server-only local Ollama drafting for exact ATS free-text questions. */
  ATELIER_CAREER_AGENT_ANSWER_DRAFT_MODE?: string;
  ATELIER_CAREER_AGENT_OLLAMA_BASE_URL?: string;
  ATELIER_CAREER_AGENT_OLLAMA_MODEL?: string;
  ATELIER_CAREER_AGENT_ANSWER_BANK?: string;
  ATELIER_CAREER_AGENT_ANSWER_BANK_FILE?: string;
  ATELIER_CAREER_AGENT_OLLAMA_TIMEOUT_MS?: string;
}

export interface RuntimeNotificationTransport {
  adapter: NotificationAdapter;
  hydrate?(events: readonly PersistedAttentionEvent[]): void | Promise<void>;
  start?(): Promise<void>;
  stop?(): void | Promise<void>;
}

/** The Slack adapter's board methods (the in-memory adapter has none). */
interface WaitingBoardPort {
  permalink(messageTs: string): Promise<string | undefined>;
  replaceWaitingBoard(board: { text: string; blocks: unknown[] }, previousTs?: string): Promise<string>;
}

/** The existing execution-host HTTP seam, kept as a narrow runtime port. */
export interface CareerAgentExecutionHostPort {
  start(request: ExecutionHostRequest): Promise<ExecutionHostSnapshot>;
  get(executionId: string): Promise<ExecutionHostSnapshot>;
  resume(executionId: string, request?: ExecutionHostRequest): Promise<ExecutionHostSnapshot>;
  submitManually?(executionId: string, target: { campaignId: string; careerJobId: string; applicationId: string }): Promise<ExecutionHostSnapshot>;
}

export interface BackgroundCareerAgentRuntimeOptions {
  profile: CandidateProfile;
  stateStorage?: KeyValueStorage;
  stateFilePath?: string;
  careerRepository?: CareerRepository;
  applicationRepository?: ApplicationRepository;
  applicationService?: ApplicationService;
  scout?: JobScout;
  destinationResolver?: ApplicationDestinationResolver;
  officialDestinationCandidates?: readonly import("../../src/domain/applicationDestinationResolver").DestinationCandidate[];
  executor?: ApplicationExecutor;
  tracker?: JobTracker;
  notification?: RuntimeNotificationTransport;
  notificationAdapter?: NotificationAdapter;
  executionHost?: CareerAgentExecutionHostPort;
  autoStartHostExecutions?: boolean;
  hostPollIntervalMs?: number;
  hostPollTimeoutMs?: number;
  resumeArtifactAvailable?: (familyId: ResumeFamilyId) => boolean;
  applicationAnswerDraftGenerator?: import("../../src/domain/applicationAnswerDraft").ApplicationAnswerDraftGenerator;
  postingEnricher?: (input: import("../../src/domain/types").JobIntakeInput) => Promise<import("../../src/domain/types").JobIntakeInput>;
  answerBank?: import("../../src/domain/answerBank").AnswerBankStore;
  answerBankMatcher?: import("../../src/domain/answerBank").AnswerBankSemanticMatcher;
  /** Read-only inbox checked for "thanks for applying" emails while a job waits on DONE. */
  receiptInbox?: InboxSource;
  receiptPollIntervalMs?: number;
  defaultCampaignInput?: CreateCampaignInput;
  now?: () => string;
  createId?: CareerAgentServiceOptions["createId"];
  submissionAuthority?: DurableSubmissionAuthority;
  /**
   * Advances the matching Sheet queue row once an application is confirmed
   * applied, so strict queue order does not stall on a submitted row.
   * Returns a short status for the operator, or undefined when nothing matched.
   */
  confirmQueueRow?: (job: CareerJob) => Promise<string | undefined>;
}

export interface BackgroundCareerAgentRuntime {
  readonly stateStorage?: KeyValueStorage;
  readonly stateFilePath?: string;
  readonly careerRepository: CareerRepository;
  readonly applicationRepository: ApplicationRepository;
  readonly service: CareerAgentService;
  readonly defaultCampaignInput?: CreateCampaignInput;
  start(): Promise<void>;
  /** Rebuild the Slack "Waiting on you" board; see the implementation. */
  refreshWaitingBoard(now?: Date): Promise<"posted" | "unchanged" | "unavailable">;
  stop(): Promise<void>;
  createCampaign(input: CreateCampaignInput): Campaign;
  runCampaign(campaignId: string): Promise<CampaignRunResult>;
  processDailyHuntMessage(campaignId: string, message: string): Promise<DailyHuntProcessingResult>;
  publishPendingAttentionEvents(campaignId?: string): Promise<number>;
  reannounceAttentionEvent(campaignId: string, eventId: string): Promise<void>;
  restartAttentionReview(campaignId: string, jobId: string): Promise<void>;
  repairLegacyAttentionEvents(
    campaignId?: string,
    options?: LegacyAttentionRepairOptions,
  ): Promise<LegacyAttentionRepairResult>;
  resolveDestinations(
    campaignId: string,
    jobIds?: readonly string[],
  ): Promise<import("../../src/domain/applicationDestinationResolver").DestinationResolutionRunResult>;
  /** Process one curated posting and reconcile its dedicated browser host run. */
  processCuratedJobThroughHost(campaignId: string, input: JobIntakeInput): Promise<import("../../src/domain/campaignTypes").CareerJob>;
  processCuratedJob(campaignId: string, input: JobIntakeInput): Promise<import("../../src/domain/campaignTypes").CareerJob>;
  /** Confirm an externally verified manual submission through this runtime's durable authority. */
  confirmManualApplication(campaignId: string, jobId: string): Promise<import("../../src/domain/campaignTypes").CareerJob>;
  /** Correct an explicitly identified false manual-submission confirmation. */
  correctFalseManualSubmissionConfirmation(campaignId: string, jobId: string, reason?: string): import("../../src/domain/campaignTypes").CareerJob;
  /** Recover one unknown CAPTCHA boundary only after an explicit no-submission assertion. */
  recoverUnsubmittedHumanVerification(campaignId: string, jobId: string, applicationId: string, input: { confirmedNotSubmitted: true; reason: string }): Promise<import("../../src/domain/campaignTypes").CareerJob>;
  /** Restart the same prepared packet through the local host, never allowing submission. */
  restartExistingApplication(campaignId: string, jobId: string, applicationId: string): Promise<import("../../src/domain/campaignTypes").CareerJob>;
  /** Reprepare a proof-free packet only after its exact aged host session is unavailable. */
  recoverStalePreSubmitApplication(campaignId: string, jobId: string, applicationId: string, executionId: string, hostUnavailable: "not_found" | "closed"): Promise<import("../../src/domain/campaignTypes").CareerJob>;
  /** Perform one explicit action-time submit on the retained prepared host and reconcile proof/tracker state. */
  submitPreparedApplication(campaignId: string, jobId: string): Promise<import("../../src/domain/campaignTypes").CareerJob>;
  /** Record one explicit duplicate-risk authorization for an unknown fence; never submits by itself. */
  authorizeDuplicateRiskRetry(campaignId: string, jobId: string, input: { confirmedRisk: true; reason: string }): import("../executionHost/submissionAuthority").SubmissionFence;
  getSubmissionFence(applicationId: string, jobId: string): import("../executionHost/submissionAuthority").SubmissionFence | undefined;
  resumePreparationOnlyConfigurationBlocker(campaignId: string, jobId: string): import("../../src/domain/campaignTypes").CareerJob;
  getApplication(applicationId: string): import("../../src/domain/types").Application;
  /** Sends a link-only queue notice when the adapter supports it; returns false otherwise. */
  notifyQueueHandoff(notice: QueueHandoffNotice): Promise<boolean>;
  /**
   * One explicit, human-approved submit of an exact prepared application
   * (Slack's Submit button). Same preflight as career-agent:submit-prepared;
   * never authorizes duplicate-risk retries.
   */
  submitFromHumanApproval(campaignId: string, jobId: string, applicationId: string, executionHostBaseUrl: string): Promise<{ submitted: boolean; message: string }>;
  /** Marks the matching queue row Confirmed for an applied job; undefined when none matched. */
  confirmQueueRowForAppliedJob(jobId: string): Promise<string | undefined>;
}

const HOST_ACTIVE_STATUSES: ReadonlySet<ExecutionHostStatus> = new Set(["starting", "inspecting", "executing", "resuming"]);

const HOST_TERMINAL_STATUSES: ReadonlySet<ExecutionHostStatus> = new Set([
  "needs_input",
  "waiting_for_human",
  "ready_to_submit",
  "submitted",
  "failed",
  "cancelled",
  "closed",
]);

function isCaptchaWaiting(snapshot: ExecutionHostSnapshot): boolean {
  return snapshot.status === "waiting_for_human" &&
    snapshot.result?.state === "requires_human" &&
    snapshot.result.blocker.kind === "captcha";
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function booleanValue(value: string | undefined, fallback: boolean, label: string): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${label} must be true or false.`);
}

function valueOrDefault(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

function executionRequestFor(
  service: CareerAgentService,
  profile: CandidateProfile,
  campaignId: string,
  jobId: string,
): ExecutionHostRequest {
  const campaign = service.getCampaign(campaignId);
  const careerJob = service.prepareJobForHostExecution(campaignId, jobId);
  if (!careerJob.applicationId) throw new Error("This career job has no prepared application packet.");
  const application = service.getApplication(careerJob.applicationId);
  return {
    mode: "real_local",
    campaign,
    careerJob,
    application,
    profile,
  };
}

function loadProfileFromFile(filePath: string): CandidateProfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(filePath), "utf8"));
  } catch {
    throw new Error("The configured Career Agent profile file could not be read or parsed.");
  }
  try {
    return parseCandidateProfile(parsed);
  } catch {
    throw new Error("The configured Career Agent profile file does not match the profile schema.");
  }
}

export function loadBackgroundCandidateProfile(
  env: Pick<BackgroundCareerAgentEnvironment, "ATELIER_CAREER_AGENT_PROFILE_FILE">,
): CandidateProfile {
  const path = env.ATELIER_CAREER_AGENT_PROFILE_FILE?.trim();
  if (!path) {
    throw new Error("ATELIER_CAREER_AGENT_PROFILE_FILE is required for the background Career Agent runtime.");
  }
  return loadProfileFromFile(path);
}

export const DEFAULT_CAREER_AGENT_SEARCH_INTENT_FILE = ".local/career-agent/search-intent.json";
export const DEFAULT_CAREER_AGENT_DISCOVERY_FILE = ".local/career-agent/discovery.json";

/** Load the optional source/board choices; without a file the defaults apply. */
export function loadBackgroundDiscoveryConfig(
  env: Pick<BackgroundCareerAgentEnvironment, "ATELIER_CAREER_AGENT_DISCOVERY_FILE">,
): DiscoveryConfig {
  const configuredPath = env.ATELIER_CAREER_AGENT_DISCOVERY_FILE?.trim();
  const path = configuredPath || DEFAULT_CAREER_AGENT_DISCOVERY_FILE;
  if (!existsSync(resolve(path))) {
    if (configuredPath) throw new Error("The configured Career Agent discovery file could not be found.");
    return DEFAULT_DISCOVERY_CONFIG;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch {
    throw new Error("The configured Career Agent discovery file could not be read or parsed.");
  }
  return parseDiscoveryConfig(parsed);
}

/** Load optional server-side user intent without putting it in the client bundle. */
export function loadBackgroundSearchIntent(
  env: Pick<BackgroundCareerAgentEnvironment, "ATELIER_CAREER_AGENT_SEARCH_INTENT_FILE">,
): JobSearchIntent | undefined {
  const configuredPath = env.ATELIER_CAREER_AGENT_SEARCH_INTENT_FILE?.trim();
  const path = configuredPath || DEFAULT_CAREER_AGENT_SEARCH_INTENT_FILE;
  if (!existsSync(resolve(path))) {
    if (configuredPath) throw new Error("The configured Career Agent search intent file could not be found.");
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch {
    throw new Error("The configured Career Agent search intent file could not be read or parsed.");
  }
  try {
    return normalizeJobSearchIntent(parsed as JobSearchIntent);
  } catch {
    throw new Error("The configured Career Agent search intent file does not match the bounded search-intent schema.");
  }
}

export const DEFAULT_CAREER_AGENT_DESTINATION_EVIDENCE_FILE = ".local/career-agent/destination-evidence.json";

/** Load only a small explicit list of public destination evidence records. */
export function loadBackgroundDestinationCandidates(
  env: Pick<BackgroundCareerAgentEnvironment, "ATELIER_CAREER_AGENT_DESTINATION_EVIDENCE_FILE">,
): ReturnType<typeof parseDestinationCandidates> {
  const configuredPath = env.ATELIER_CAREER_AGENT_DESTINATION_EVIDENCE_FILE?.trim();
  const path = configuredPath || DEFAULT_CAREER_AGENT_DESTINATION_EVIDENCE_FILE;
  if (!existsSync(resolve(path))) {
    if (configuredPath) throw new Error("The configured Career Agent destination evidence file could not be found.");
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch {
    throw new Error("The configured Career Agent destination evidence file could not be read or parsed.");
  }
  try {
    return parseDestinationCandidates(parsed);
  } catch {
    throw new Error("The configured Career Agent destination evidence file does not match the bounded destination schema.");
  }
}

export interface RuntimeSources {
  scout: JobScout;
  campaignInput: CreateCampaignInput;
  destinationResolver: BoundedApplicationDestinationResolver;
  officialDestinationCandidates: ReturnType<typeof parseDestinationCandidates>;
}

/** The campaign searches exactly the sources built from discovery.json (switched-off feeds removed, The Muse and Ashby boards added). */
function discoveryCampaignInput(input: CreateCampaignInput, sources: Readonly<Record<string, JobSource>>): CreateCampaignInput {
  const ids = (input.searchSources.length > 0 ? input.searchSources : (input.sourceConfigs ?? []).map(jobSourceConfigId))
    .filter((id) => id in sources || id.startsWith("references:"));
  for (const id of Object.keys(sources)) if (!ids.includes(id)) ids.push(id);
  return { ...input, searchSources: ids, ...(input.sourceConfigs ? { sourceConfigs: input.sourceConfigs.filter((config) => jobSourceConfigId(config) in sources || config.type === "brave_search") } : {}) };
}

/** The scout and campaign shape built from search-intent.json and discovery.json. */
export function createRuntimeSources(env: BackgroundCareerAgentEnvironment): RuntimeSources {
  const remotiveEndpoint = valueOrDefault(env.VITE_REMOTIVE_API_BASE_URL, DEFAULT_REMOTIVE_API_BASE_URL);
  const himalayasEndpoint = valueOrDefault(env.ATELIER_HIMALAYAS_API_BASE_URL, DEFAULT_HIMALAYAS_API_BASE_URL);
  const leverEndpoint = valueOrDefault(env.VITE_LEVER_API_BASE_URL, DEFAULT_LEVER_POSTINGS_BASE_URL);
  const greenhouseEndpoint = valueOrDefault(env.VITE_GREENHOUSE_API_BASE_URL, DEFAULT_GREENHOUSE_API_BASE_URL);
  const configured = loadBackgroundDiscoveryConfig(env);
  // Boards the job search learned from feed companies (learned-boards.json) join the configured ones.
  const learned = loadLearnedBoards((env as Record<string, string | undefined>).ATELIER_CAREER_AGENT_LEARNED_BOARDS_FILE?.trim() || DEFAULT_LEARNED_BOARDS_FILE);
  const merge = (a: readonly string[], b: readonly string[]) => [...new Map([...a, ...b].map((board) => [board.toLowerCase(), board])).values()];
  const discovery = {
    ...configured,
    employerBoards: {
      greenhouse: merge(configured.employerBoards.greenhouse, learned.greenhouse),
      lever: merge(configured.employerBoards.lever, learned.lever),
      ashby: merge(configured.employerBoards.ashby, learned.ashby),
    },
  };
  // Boards from discovery.json join any listed in the older env variables.
  const leverSites = parseLeverSites([env.VITE_LEVER_SITES ?? "", ...discovery.employerBoards.lever].join(","));
  const greenhouseBoards = parseGreenhouseBoards([env.VITE_GREENHOUSE_BOARDS ?? "", ...discovery.employerBoards.greenhouse].join(","));
  const broadDiscoveryEnabled = discovery.sources.brave || parseBroadDiscoveryEnabled(env.VITE_BROAD_DISCOVERY_ENABLED ?? "false");
  const searchIntent = loadBackgroundSearchIntent(env);
  const destinationCandidates = loadBackgroundDestinationCandidates(env);
  const leverSources = createLeverJobSources(leverSites, leverEndpoint);
  const greenhouseSources = createGreenhouseJobSources(greenhouseBoards, greenhouseEndpoint);
  const resolver = new JobReferenceResolver([...leverSources, ...greenhouseSources], {
    createSource: (classification) => {
      if (classification.kind === "lever" && classification.siteIdentifier) {
        return createLeverJobSource(classification.siteIdentifier, leverEndpoint);
      }
      if (classification.kind === "greenhouse" && classification.siteIdentifier) {
        return createGreenhouseJobSources([classification.siteIdentifier], greenhouseEndpoint)[0];
      }
      return undefined;
    },
  });

  const remotive = createRemotiveJobSource(remotiveEndpoint);
  const himalayas = createHimalayasJobSource(himalayasEndpoint);
  const ashbySources = discovery.employerBoards.ashby.map((board) => new AshbyBoardSource({ board }));
  const sources: Record<string, JobSource> = {
    ...(discovery.sources.remotive ? { [remotive.id]: remotive } : {}),
    ...(discovery.sources.himalayas ? { [HIMALAYAS_SOURCE_ID]: himalayas } : {}),
    ...(discovery.sources.themuse ? { [MUSE_SOURCE_ID]: new MuseJobSource() } : {}),
    ...Object.fromEntries(leverSources.map((source) => [source.id, source])),
    ...Object.fromEntries(greenhouseSources.map((source) => [source.id, source])),
    ...Object.fromEntries(ashbySources.map((source) => [source.id, source])),
  };
  if (broadDiscoveryEnabled) {
    const brave = new BraveSearchDiscoveryProvider({
      ...resolveExecutionHostConfig(env).braveSearch,
    });
    const broadSource = new JobReferenceSource(brave, resolver);
    sources[broadSource.id] = broadSource;
  }

  return {
    // Large boards (Gopuff's Lever board lists ~800 postings) need longer than the 8s default.
    scout: new JobScout(sources, undefined, { timeoutMs: 20_000 }),
    campaignInput: discoveryCampaignInput(createLiveCampaignInput(leverSites, greenhouseBoards, broadDiscoveryEnabled, searchIntent, true), sources),
    destinationResolver: new BoundedApplicationDestinationResolver({
      lookup: new StaticDestinationEvidenceLookup(destinationCandidates),
    }),
    officialDestinationCandidates: destinationCandidates,
  };
}

export class BackgroundCareerAgentRuntimeImpl implements BackgroundCareerAgentRuntime {
  readonly stateStorage?: KeyValueStorage;
  readonly stateFilePath?: string;
  readonly careerRepository: CareerRepository;
  readonly applicationRepository: ApplicationRepository;
  readonly service: CareerAgentService;
  readonly defaultCampaignInput?: CreateCampaignInput;

  private readonly notification?: RuntimeNotificationTransport;
  private readonly profile: CandidateProfile;
  private readonly executor: ApplicationExecutor;
  private readonly executionHost?: CareerAgentExecutionHostPort;
  private readonly autoStartHostExecutions: boolean;
  private readonly hostPollIntervalMs: number;
  private readonly hostPollTimeoutMs: number;
  private readonly submissionAuthority?: DurableSubmissionAuthority;
  private readonly confirmQueueRow?: (job: CareerJob) => Promise<string | undefined>;
  private readonly receiptInbox?: InboxSource;
  private readonly receiptPollIntervalMs: number;
  private readonly seenReceiptEmails = new Set<string>();
  private receiptTimer?: ReturnType<typeof setInterval>;
  private receiptCheckRunning = false;
  private readonly boardPermalinks = new Map<string, string>();
  private started = false;
  private stopped = false;

  constructor(options: BackgroundCareerAgentRuntimeOptions) {
    this.profile = options.profile;
    this.receiptInbox = options.receiptInbox;
    this.receiptPollIntervalMs = positiveInteger(options.receiptPollIntervalMs, 3 * 60_000, "Career Agent receipt poll interval");
    this.confirmQueueRow = options.confirmQueueRow;
    const storage = options.stateStorage ?? new FileKeyValueStorage(options.stateFilePath ?? DEFAULT_CAREER_AGENT_STATE_FILE);
    this.stateStorage = storage;
    this.stateFilePath = storage instanceof FileKeyValueStorage ? storage.filePath : options.stateFilePath;
    this.careerRepository = options.careerRepository ?? new LocalStorageCareerRepository(storage);
    this.applicationRepository = options.applicationRepository ?? new LocalStorageApplicationRepository(storage);
    this.notification = options.notification ?? (options.notificationAdapter ? { adapter: options.notificationAdapter } : undefined);
    if (!this.notification?.adapter) {
      throw new Error("A notification adapter is required for the background Career Agent runtime.");
    }
    this.executor = options.executor ?? new UnavailableApplicationExecutor();
    this.executionHost = options.executionHost;
    this.autoStartHostExecutions = options.autoStartHostExecutions ?? false;
    this.hostPollIntervalMs = positiveInteger(options.hostPollIntervalMs, 500, "Career Agent host poll interval");
    this.hostPollTimeoutMs = positiveInteger(options.hostPollTimeoutMs, 30 * 60 * 1_000, "Career Agent host poll timeout");
    this.submissionAuthority = options.submissionAuthority;
    this.defaultCampaignInput = options.defaultCampaignInput;
    const serviceOptions: CareerAgentServiceOptions = {
      ...(options.now ? { now: options.now } : {}),
      ...(options.createId ? { createId: options.createId } : {}),
    };
    const applicationService =
      options.applicationService ??
      new ApplicationService(this.applicationRepository, options.profile, undefined, serviceOptions satisfies ApplicationServiceOptions);
    this.service = new CareerAgentService(
      options.profile,
      {
        ...(applicationService ? { applicationService } : {}),
        careerRepository: this.careerRepository,
        ...(options.scout ? { scout: options.scout } : {}),
        ...(options.destinationResolver ? { destinationResolver: options.destinationResolver } : {}),
        ...(options.officialDestinationCandidates ? { officialDestinationCandidates: options.officialDestinationCandidates } : {}),
        executor: this.executor,
        ...(options.tracker ? { tracker: options.tracker } : {}),
        notificationAdapter: this.notification.adapter,
        ...(options.resumeArtifactAvailable ? { resumeArtifactAvailable: options.resumeArtifactAvailable } : {}),
        ...(options.applicationAnswerDraftGenerator
          ? {
              applicationAnswerDraftGenerator: options.applicationAnswerDraftGenerator,
            }
          : {}),
        ...(options.postingEnricher ? { postingEnricher: options.postingEnricher } : {}),
        ...(options.answerBank ? { answerBank: options.answerBank } : {}),
        ...(options.answerBankMatcher ? { answerBankMatcher: options.answerBankMatcher } : {}),
        ...(this.executionHost
          ? {
              resumeAttention: async (campaignId, jobId, options) => this.resumeHostExecution(campaignId, jobId, options),
            }
          : {}),
        confirmPostSubmitDone: async (campaignId, jobId) => {
          const applied = await this.confirmManualApplication(campaignId, jobId);
          await this.confirmQueueRowForAppliedJob(jobId).catch(() => undefined);
          return applied;
        },
      },
      serviceOptions,
    );
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error("The background Career Agent runtime is stopped.");
    if (this.started) return;
    try {
      await this.notification?.hydrate?.(this.careerRepository.listCampaigns().flatMap((campaign) => campaign.attentionEvents ?? []));
      await this.notification?.start?.();
      await this.service.publishPendingAttentionEvents();
      this.started = true;
      await this.resumePendingAttentionContinuations();
      if (this.receiptInbox) {
        this.receiptTimer = setInterval(() => {
          void this.checkApplicationReceipts().catch((error: unknown) => {
            console.warn(`[career-agent-receipts] check failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`);
          });
        }, this.receiptPollIntervalMs);
        this.receiptTimer.unref?.();
      }
    } catch (error) {
      await this.notification?.stop?.();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.receiptTimer) clearInterval(this.receiptTimer);
    await this.notification?.stop?.();
    const applicationIds = [
      ...new Set(
        this.service
          .listJobs()
          .map((job) => job.applicationId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    for (const applicationId of applicationIds) {
      try {
        await this.executor.close?.(applicationId);
      } catch {
        // The domain record remains durable; executor cleanup is best effort.
      }
    }
  }

  createCampaign(input: CreateCampaignInput): Campaign {
    return this.service.createCampaign(input);
  }

  async runCampaign(campaignId: string): Promise<CampaignRunResult> {
    if (this.stopped) throw new Error("The background Career Agent runtime is stopped.");
    const result = await this.service.runCampaign(campaignId);
    if (this.autoStartHostExecutions && this.executionHost) {
      await this.startPreparedHostExecutions(campaignId);
    }
    const snapshot = this.service.snapshot(campaignId);
    return {
      ...result,
      snapshot,
      attentionRequired:
        snapshot.counts.needsYou +
        (snapshot.campaign.attentionEvents ?? []).filter((event) => event.type === "configuration_required" && event.status === "open")
          .length,
    };
  }

  async processDailyHuntMessage(campaignId: string, message: string): Promise<DailyHuntProcessingResult> {
    if (this.stopped) throw new Error("The background Career Agent runtime is stopped.");
    const result = await this.service.processDailyHuntMessage(campaignId, message);
    if (this.autoStartHostExecutions && this.executionHost) {
      await this.startPreparedHostExecutions(campaignId);
    }
    await this.service.publishPendingAttentionEvents(campaignId);
    return result;
  }

  publishPendingAttentionEvents(campaignId?: string): Promise<number> {
    return this.service.publishPendingAttentionEvents(campaignId);
  }

  reannounceAttentionEvent(campaignId: string, eventId: string): Promise<void> {
    return this.service.reannounceAttentionEvent(campaignId, eventId);
  }

  repairLegacyAttentionEvents(campaignId?: string, options?: LegacyAttentionRepairOptions): Promise<LegacyAttentionRepairResult> {
    return this.service.repairLegacyAttentionEvents(campaignId, options);
  }

  restartAttentionReview(campaignId: string, jobId: string): Promise<void> {
    return this.service.restartAttentionReview(campaignId, jobId);
  }

  resolveDestinations(campaignId: string, jobIds?: readonly string[]) {
    return this.service.resolveDestinations(campaignId, jobIds);
  }

  confirmManualApplication(campaignId: string, jobId: string): Promise<CareerJob> {
    return this.service.confirmManualApplication(campaignId, jobId, this.submissionAuthority);
  }

  /**
   * While any job waits on DONE (or on Submit), look for the employer's
   * "thanks for applying" email. A receipt that names one waiting job marks
   * it Applied exactly as DONE would; an ambiguous one is reported once and
   * changes nothing.
   */
  async checkApplicationReceipts(): Promise<{ confirmed: string[]; ambiguous: string[] }> {
    const result = { confirmed: [] as string[], ambiguous: [] as string[] };
    if (!this.receiptInbox || this.receiptCheckRunning) return result;
    this.receiptCheckRunning = true;
    try {
      (this.stateStorage as { reload?: () => void } | undefined)?.reload?.();
      if (!this.service.listJobs().some(isAwaitingReceipt)) return result;
      const emails = [...await this.receiptInbox.recentEmails(2, { skipIds: this.seenReceiptEmails, maxResults: 25 })]
        .sort((left, right) => left.receivedAt.localeCompare(right.receivedAt));
      for (const email of emails) {
        this.seenReceiptEmails.add(email.id);
        (this.stateStorage as { reload?: () => void } | undefined)?.reload?.();
        const match = matchReceiptToJob(email, this.service.listJobs());
        if (match.kind === "none") continue;
        if (match.kind === "ambiguous") {
          result.ambiguous.push(email.subject);
          await this.notification?.adapter.publishInfoNotice?.(
            `A "thanks for applying" email arrived ("${email.subject.slice(0, 100)}"), but it could be for ${match.jobs.map((job) => `${job.job.company} — ${job.job.title}`).join(" or ")}. Reply DONE on the right one.`,
          ).catch(() => undefined);
          continue;
        }
        const job = match.job;
        const confirm = async () => {
          (this.stateStorage as { reload?: () => void } | undefined)?.reload?.();
          const current = this.service.getJob(job.id);
          if (!isAwaitingReceipt(current)) return undefined;
          const applied = await this.service.confirmManualApplication(current.campaignId, current.id, this.submissionAuthority, { fromReceipt: true });
          this.service.recordReceiptConfirmation(current.campaignId, current.id, email);
          return applied;
        };
        const storage = this.stateStorage as { withExclusiveLockAsync?: <R>(operation: () => Promise<R>) => Promise<R> } | undefined;
        let applied: CareerJob | undefined;
        try {
          applied = storage?.withExclusiveLockAsync ? await storage.withExclusiveLockAsync(confirm) : await confirm();
        } catch (error) {
          // One job that cannot be confirmed this way (for example, one older
          // than the submission fence) must not stop the remaining emails.
          console.warn(`[career-agent-receipts] ${job.job.company}: ${error instanceof Error ? error.message.slice(0, 200) : "confirmation failed"}; reply DONE instead`);
          continue;
        }
        if (!applied) continue;
        const queueNote = await this.confirmQueueRowForAppliedJob(applied.id).catch(() => "the queue row could not be updated; confirm it in the Sheet");
        result.confirmed.push(`${applied.job.company} — ${applied.job.title}`);
        await this.notification?.adapter.publishInfoNotice?.(
          `${applied.job.company} — ${applied.job.title}: their confirmation email arrived ("${email.subject.slice(0, 100)}"), so I marked it Applied. No DONE needed.${queueNote && !/confirmed/i.test(queueNote) ? ` (${queueNote})` : ""}`,
        ).catch(() => undefined);
        console.info(`[career-agent-receipts] ${applied.job.company} marked Applied from a confirmation email`);
      }
      return result;
    } finally {
      this.receiptCheckRunning = false;
    }
  }

  /**
   * Refresh the Slack "Waiting on you" board from job state: post any recent
   * question that never reached Slack, then, only when the board's content
   * changed, post the new board and delete the old one. Run by the
   * long-lived runtime service on an interval.
   */
  async refreshWaitingBoard(now = new Date()): Promise<"posted" | "unchanged" | "unavailable"> {
    const adapter = this.notification?.adapter as Partial<WaitingBoardPort> | undefined;
    if (typeof adapter?.replaceWaitingBoard !== "function") return "unavailable";
    const storage = this.stateStorage as { reload?: () => void; withExclusiveLockAsync?: <R>(operation: () => Promise<R>) => Promise<R> } | undefined;
    const recentSince = new Date(now.getTime() - WAITING_BOARD_RECENT_MS).toISOString();
    const postMissing = async () => { storage?.reload?.(); return this.service.publishUnaskedAttention(recentSince); };
    await (storage?.withExclusiveLockAsync ? storage.withExclusiveLockAsync(postMissing) : postMissing()).catch(() => 0);
    storage?.reload?.();
    const events = this.careerRepository.listCampaigns().flatMap((campaign) => campaign.attentionEvents ?? []);
    const board = waitingBoardItems(this.service.listJobs(), events,
      (blocker, job) => attentionDescriptorSignature(blocker, job.job.compensation) !== undefined, now);
    const signature = waitingBoardSignature(board);
    const saved = this.readWaitingBoardState();
    if (saved?.ts && saved.signature === signature) return "unchanged";
    for (const item of board.items) {
      if (item.link && !this.boardPermalinks.has(item.link)) {
        const url = await adapter.permalink?.(item.link).catch(() => undefined);
        if (url) this.boardPermalinks.set(item.link, url);
      }
    }
    const ts = await adapter.replaceWaitingBoard(renderWaitingBoard(board, now, (messageTs) => this.boardPermalinks.get(messageTs)), saved?.ts);
    this.writeWaitingBoardState({ ts, signature });
    return "posted";
  }

  private get waitingBoardStatePath(): string {
    return resolve(this.stateFilePath ? dirname(this.stateFilePath) : ".local/career-agent", "slack-waiting-board.json");
  }

  private readWaitingBoardState(): { ts?: string; signature?: string } | undefined {
    try { return JSON.parse(readFileSync(this.waitingBoardStatePath, "utf8")) as { ts?: string; signature?: string }; } catch { return undefined; }
  }

  private writeWaitingBoardState(state: { ts: string; signature: string }): void {
    const path = this.waitingBoardStatePath;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(state));
    renameSync(`${path}.tmp`, path);
  }

  correctFalseManualSubmissionConfirmation(campaignId: string, jobId: string, reason?: string): CareerJob {
    return this.service.correctFalseManualSubmissionConfirmation(campaignId, jobId, reason);
  }

  recoverUnsubmittedHumanVerification(campaignId: string, jobId: string, applicationId: string, input: { confirmedNotSubmitted: true; reason: string }): Promise<CareerJob> {
    if (!this.submissionAuthority) throw new Error("The durable submission authority is not configured.");
    return this.service.recoverUnsubmittedHumanVerification(campaignId, jobId, applicationId, this.submissionAuthority, input);
  }

  async restartExistingApplication(campaignId: string, jobId: string, applicationId: string): Promise<CareerJob> {
    if (!this.executionHost) throw new Error("The execution host is not configured for application restart.");
    const campaign = this.service.getCampaign(campaignId);
    const job = this.service.getJob(jobId);
    if (job.campaignId !== campaignId || job.applicationId !== applicationId) {
      throw new Error("The campaign, job, and application IDs do not match.");
    }
    const application = this.service.getApplication(applicationId);
    const proofFree = !job.submissionProof && !job.manualSubmissionConfirmation &&
      !application.submissionProof && !application.manualSubmissionConfirmation;
    const executionEvidence = job.execution?.evidence ?? [];
    const safeFailedPreSubmit = job.status === "failed" && application.status === "failed" && proofFree &&
      executionEvidence.includes("submit:not-clicked") &&
      !executionEvidence.some((evidence) => /submit:(?:clicked|unknown)/i.test(evidence));
    const readyForReviewRestart = application.status === "ready_for_review" && job.status !== "applied" && proofFree;
    if (!readyForReviewRestart && !safeFailedPreSubmit) {
      throw new Error("Restart requires the exact existing proof-free ready-for-review packet; applied or proof-bearing packets are rejected.");
    }
    if (campaign.submissionPolicy.authority !== "never") {
      throw new Error("Restart is fail-closed unless the persisted campaign submission authority is never.");
    }
    if (safeFailedPreSubmit) this.service.recoverFailedApplicationForExecution(campaignId, jobId);
    const request = executionRequestFor(this.service, this.serviceProfile(), campaignId, jobId);
    // Defense in depth: the persisted campaign is already required to be
    // never-submit, and the host request is independently forced to that
    // authority so configuration drift cannot authorize submission here.
    request.campaign = {
      ...request.campaign,
      submissionPolicy: { authority: "never", requireExplicitApproval: false },
    };
    const snapshot = await this.executionHost.start(request);
    await this.reconcileHostExecution(campaignId, jobId, snapshot);
    return this.service.getJob(jobId);
  }

  recoverStalePreSubmitApplication(
    campaignId: string,
    jobId: string,
    applicationId: string,
    executionId: string,
    hostUnavailable: "not_found" | "closed",
  ): Promise<CareerJob> {
    return this.service.recoverStalePreSubmitApplication(campaignId, jobId, applicationId, executionId, hostUnavailable);
  }

  async submitPreparedApplication(campaignId: string, jobId: string): Promise<CareerJob> {
    if (!this.executionHost?.submitManually) throw new Error("The execution host does not expose the explicit manual-submit action.");
    const campaign = this.service.getCampaign(campaignId);
    const job = this.service.getJob(jobId);
    if (job.campaignId !== campaignId || !job.applicationId) throw new Error("The campaign and job IDs do not identify an application packet.");
    const executionId = job.execution?.mode === "real_local" ? job.execution.hostExecutionId : undefined;
    if (!executionId) throw new Error("The application does not have a retained browser execution.");
    const snapshot = await this.executionHost.submitManually(executionId, {
      campaignId,
      careerJobId: jobId,
      applicationId: job.applicationId,
    });
    // The host may have claimed/updated the durable fence in its own process.
    // Reload before persisting the host snapshot so this runtime cannot write
    // a stale state map over that fence update.
    (this.stateStorage as KeyValueStorage & { reload?: () => void }).reload?.();
    await this.service.recordExecutionHostSnapshot(campaignId, jobId, snapshot);
    return this.service.getJob(jobId);
  }

  authorizeDuplicateRiskRetry(campaignId: string, jobId: string, input: { confirmedRisk: true; reason: string }) {
    if (!this.submissionAuthority) throw new Error("The durable submission authority is not configured.");
    const job = this.service.getJob(jobId);
    if (job.campaignId !== campaignId || !job.applicationId) throw new Error("The campaign and job IDs do not identify an application packet.");
    return this.submissionAuthority.authorizeDuplicateRiskRetry(job.applicationId, jobId, input, new Date().toISOString());
  }

  getSubmissionFence(applicationId: string, jobId: string) {
    return this.submissionAuthority?.get(applicationId, jobId);
  }

  resumePreparationOnlyConfigurationBlocker(campaignId: string, jobId: string): CareerJob {
    return this.service.resumePreparationOnlyConfigurationBlocker(campaignId, jobId, this.submissionAuthority);
  }

  async processCuratedJobThroughHost(campaignId: string, input: JobIntakeInput): Promise<CareerJob> {
    if (!this.executionHost) throw new Error("The execution host is not configured for standalone queue processing.");
    const created = await this.service.processCuratedJob(campaignId, input);
    let current = this.service.getJob(created.id);
    if (input.queueSelected && current.applicationId) {
      const application = this.service.getApplication(current.applicationId);
      if (application.status === "needs_input" || current.blockers.some((blocker) => ["salary_expectations", "relocation", "travel", "demographic_disclosure", "legal_attestations"].includes(blocker.field ?? ""))) {
        this.service.deferGenericPreparationBlockersForQueueInspection(campaignId, current.id);
        current = this.service.getJob(created.id);
      }
    }
    if (!current.applicationId) return current;
    const reconciledFence = this.submissionAuthority?.reconcile(current.applicationId, current.id);
    if (reconciledFence?.state === "submitted") {
      const recovered: ExecutionHostSnapshot = {
        id: `reconciled-${current.id}`,
        mode: "real_local",
        applicationId: current.applicationId,
        jobId: current.id,
        campaignId,
        status: "submitted",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        result: {
          state: "submitted",
          proof: {
            mode: "external",
            provider: current.destinationResolution?.ats ?? "verified-ats",
            externalApplicationId: reconciledFence.externalApplicationId,
            submittedAt: current.updatedAt,
            evidence: "durable-fence:reconciled; browser:not-reopened",
          },
        },
      };
      await this.reconcileHostExecution(campaignId, current.id, recovered);
      return this.service.getJob(current.id);
    }
    if (reconciledFence?.state === "needs_input") {
      const recovered: ExecutionHostSnapshot = {
        id: `reconciled-${current.id}`,
        mode: "real_local",
        applicationId: current.applicationId,
        jobId: current.id,
        campaignId,
        status: "needs_input",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        result: {
          state: "requires_human",
          blocker: {
            kind: "external_verification",
            unit: "submission",
            questionProvenance: "POLICY",
            field: "submission-confirmation",
            question: "Verify whether the application was submitted",
            reason: reconciledFence.reason,
            evidence: ["durable-fence:reconciled", "submit:unknown", "submit:not-retried"],
            resumeAfterHuman: false,
          },
        },
      };
      await this.reconcileHostExecution(campaignId, current.id, recovered);
      return this.service.getJob(current.id);
    }
    if (this.service.getApplication(current.applicationId).status !== "ready_for_review") return current;
    // A Slack answer can resume the retained host asynchronously. The queue
    // may poll the same row while that resume is in flight; do not start a
    // second browser session for the same application.
    if (current.execution?.mode === "real_local" && current.execution.hostExecutionId &&
      ["starting", "inspecting", "executing", "resuming", "needs_input", "waiting_for_human"].includes(current.execution.status)) {
      return current;
    }
    const snapshot = await this.executionHost.start(executionRequestFor(this.service, this.serviceProfile(), campaignId, current.id));
    await this.reconcileHostExecution(campaignId, current.id, snapshot);
    return this.service.getJob(current.id);
  }

  processCuratedJob(campaignId: string, input: JobIntakeInput): Promise<CareerJob> {
    return this.service.processCuratedJob(campaignId, input);
  }

  getApplication(applicationId: string) {
    return this.service.getApplication(applicationId);
  }

  async submitFromHumanApproval(campaignId: string, jobId: string, applicationId: string, executionHostBaseUrl: string): Promise<{ submitted: boolean; message: string }> {
    const storage = this.stateStorage as (KeyValueStorage & {
      reload?: () => void;
      withExclusiveLockAsync?: <R>(operation: () => Promise<R>) => Promise<R>;
    }) | undefined;
    if (!storage?.withExclusiveLockAsync) throw new Error("Submitting requires the file-backed runtime state.");
    let label = "this application";
    const job = await authorizeThenSubmit(storage.withExclusiveLockAsync.bind(storage), () => {
      storage.reload?.();
      const current = this.service.getJob(jobId);
      const application = this.service.getApplication(applicationId);
      label = `${current.job.company} — ${current.job.title}`;
      assertSubmitPreparedApplicationPreflight({ campaignId, jobId, applicationId, job: current, application, executionHostBaseUrl });
      // An unknown fence means an earlier click may have landed; only the
      // CLI's explicit duplicate-risk authorization can retry that.
      assertDuplicateRiskRetryAuthorization(this.getSubmissionFence(applicationId, jobId)?.state, undefined, undefined);
    }, () => this.submitPreparedApplication(campaignId, jobId));
    if (job.status === "applied") {
      const queueNote = await this.confirmQueueRowForAppliedJob(jobId).catch(() => "the queue row could not be updated; confirm it in the Sheet");
      return { submitted: true, message: `Submitted: ${label}. The employer confirmation was verified and the tracker is being updated.${queueNote ? ` Queue: ${queueNote}.` : ""}` };
    }
    return {
      submitted: false,
      message: `Not confirmed: ${label} (status ${job.status}). Check the employer site or your email before doing anything else; the agent will not retry automatically.`,
    };
  }

  async confirmQueueRowForAppliedJob(jobId: string): Promise<string | undefined> {
    const job = this.service.getJob(jobId);
    if (job.status !== "applied" || !(job.submissionProof || job.manualSubmissionConfirmation)) return undefined;
    return this.confirmQueueRow?.(job);
  }

  async notifyQueueHandoff(notice: QueueHandoffNotice): Promise<boolean> {
    const adapter = this.notification?.adapter;
    if (!adapter?.publishQueueHandoffNotice) return false;
    await adapter.publishQueueHandoffNotice(notice);
    return true;
  }

  private async startPreparedHostExecutions(campaignId: string): Promise<void> {
    if (!this.executionHost) return;
    const candidates = this.service
      .listJobs(campaignId)
      .filter(
        (job) =>
          job.sourceMode === "live" &&
          job.actionability === "actionable" &&
          (this.executor.supports?.(job) === true ||
            job.sourceId.startsWith("lever:") ||
            job.sourceId.startsWith("greenhouse:") ||
            job.destinationResolution?.ats === "Lever" ||
            job.destinationResolution?.ats === "Greenhouse" ||
            job.destinationResolution?.ats === "Rippling" ||
            job.destinationResolution?.ats === "Ashby" ||
            job.destinationResolution?.ats === "Workday" ||
            (job.sourceId === "curated-live" &&
              (job.sourceRecordId?.startsWith("protagona:") || job.sourceRecordId?.startsWith("gusto:")))) &&
          (job.status === "needs_input" || job.status === "preparing" || job.status === "ready_to_submit") &&
          !(job.execution?.mode === "real_local" && job.execution.hostExecutionId) &&
          Boolean(job.applicationId),
      );
    for (const job of candidates) {
      const application = job.applicationId ? this.service.getApplication(job.applicationId) : undefined;
      if (!application || application.status !== "ready_for_review") continue;
      const request = executionRequestFor(this.service, this.serviceProfile(), campaignId, job.id);
      const snapshot = await this.executionHost.start(request);
      await this.reconcileHostExecution(campaignId, job.id, snapshot);
    }
  }

  /**
   * A response is persisted before the transient browser host is resumed. If
   * the listener or host was restarted in between those operations, the
   * resolved event is the durable record that tells us the answer is already
   * bound and safe to replay. Only jobs with no later execution progress are
   * eligible; a successful resume that reached a subsequent blocker is never
   * replayed.
   */
  private async resumePendingAttentionContinuations(): Promise<void> {
    if (!this.executionHost) return;
    const pending = this.service
      .listCampaigns()
      .flatMap((campaign) =>
        (campaign.attentionEvents ?? [])
          .filter(
            (event) => event.status === "resolved" && event.type === "needs_input" && Boolean(event.jobId) && Boolean(event.resolvedAt),
          )
          .map((event) => ({ campaignId: campaign.id, event })),
      );
    const resumedJobs = new Set<string>();
    for (const { campaignId, event } of pending) {
      if (!event.jobId || resumedJobs.has(event.jobId)) continue;
      let job;
      try {
        job = this.service.getJob(event.jobId);
      } catch {
        continue;
      }
      const execution = job.execution;
      const executionUpdatedAt = execution?.updatedAt ? Date.parse(execution.updatedAt) : Number.NaN;
      const responseAt = event.resolvedAt ? Date.parse(event.resolvedAt) : Number.NaN;
      const awaitingContinuation =
        job.status === "needs_input" &&
        execution?.mode === "real_local" &&
        Boolean(execution.hostExecutionId) &&
        (execution.status === "needs_input" || execution.status === "waiting_for_human") &&
        Number.isFinite(responseAt) &&
        Number.isFinite(executionUpdatedAt) &&
        executionUpdatedAt <= responseAt;
      if (!awaitingContinuation) continue;
      resumedJobs.add(job.id);
      try {
        await this.resumeHostExecution(campaignId, job.id);
      } catch {
        // Keep the resolved answer and needs_input job durable. A later
        // listener start can retry once the local host is available; no
        // routine Slack noise is emitted for this operational gap.
      }
    }
  }

  private serviceProfile(): CandidateProfile {
    return this.profile;
  }

  private async resumeHostExecution(campaignId: string, jobId: string, options: { verificationHandoff?: boolean } = {}): Promise<void> {
    if (!this.executionHost) return;
    const job = this.service.getJob(jobId);
    if (job.execution?.mode !== "real_local") return;
    const executionId = job.execution.hostExecutionId;
    const request = executionRequestFor(this.service, this.serviceProfile(), campaignId, jobId);
    // A refreshed packet has no browser yet; the answer starts its first run.
    if (!executionId) {
      if (options.verificationHandoff) return;
      await this.reconcileHostExecution(campaignId, jobId, await this.executionHost.start(request));
      return;
    }
    let snapshot: ExecutionHostSnapshot;
    try {
      snapshot = await this.executionHost.resume(executionId, request);
    } catch (error) {
      // A host restart loses only the browser handle. Reopening the same
      // validated packet is the existing safe restart path; the executor will
      // inspect the current page before applying the one-time answer.
      const restartable =
        error instanceof ExecutionHostResponseError &&
        (error.statusCode === 404 || (error.statusCode === 409 && /closed|cannot be resumed|not found/i.test(error.message)));
      if (!restartable) throw error;
      if (options.verificationHandoff) {
        throw new Error("The browser verification session expired or closed; manual external verification is required and submission will not be retried.");
      }
      snapshot = await this.executionHost.start(request);
    }
    await this.reconcileHostExecution(campaignId, jobId, snapshot);
  }

  private readonly announcedSubmissionReviews = new Set<string>();

  private async reconcileHostExecution(campaignId: string, jobId: string, initial: ExecutionHostSnapshot): Promise<ExecutionHostSnapshot> {
    const final = await this.pollHostExecution(campaignId, jobId, initial);
    await this.announceSubmissionReview(campaignId, jobId, final).catch(() => {
      console.warn("[career-agent-runtime] submission review notice could not be published");
    });
    return final;
  }

  /** Posts the pre-submit review once per prepared browser execution. */
  private async announceSubmissionReview(campaignId: string, jobId: string, snapshot: ExecutionHostSnapshot): Promise<void> {
    const publish = this.notification?.adapter.publishSubmissionReview;
    if (!publish || snapshot.status !== "ready_to_submit" || snapshot.result?.state !== "ready_to_submit") return;
    if (this.announcedSubmissionReviews.has(snapshot.id)) return;
    const job = this.service.getJob(jobId);
    if (job.status !== "ready_to_submit" || !job.applicationId) return;
    const application = this.service.getApplication(job.applicationId);
    const inspection = snapshot.result.inspection;
    const labels = new Map(inspection.fields.map((field) => [field.id, field.label]));
    this.announcedSubmissionReviews.add(snapshot.id);
    await publish.call(this.notification!.adapter, {
      campaignId,
      jobId,
      applicationId: job.applicationId,
      company: job.job.company,
      role: job.job.title,
      ...(application.resume?.familyId ? { resumeFamily: application.resume.familyId } : {}),
      filled: inspection.reviewSummary ?? inspection.fieldsFilled.map((id) => ({ label: labels.get(id) ?? id, value: "" })),
      leftBlank: inspection.unresolvedFields,
    });
  }

  private async pollHostExecution(campaignId: string, jobId: string, initial: ExecutionHostSnapshot): Promise<ExecutionHostSnapshot> {
    if (!this.executionHost) return initial;
    let snapshot = initial;
    await this.service.recordExecutionHostSnapshot(campaignId, jobId, snapshot);
    const deadline = Date.now() + this.hostPollTimeoutMs;
    while (HOST_ACTIVE_STATUSES.has(snapshot.status) || isCaptchaWaiting(snapshot)) {
      if (Date.now() >= deadline) return snapshot;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, this.hostPollIntervalMs));
      snapshot = await this.executionHost.get(snapshot.id);
      await this.service.recordExecutionHostSnapshot(campaignId, jobId, snapshot);
      if (HOST_TERMINAL_STATUSES.has(snapshot.status) && !isCaptchaWaiting(snapshot)) return snapshot;
    }
    return snapshot;
  }
}

export function createBackgroundCareerAgentRuntime(options: BackgroundCareerAgentRuntimeOptions): BackgroundCareerAgentRuntime {
  return new BackgroundCareerAgentRuntimeImpl(options);
}

export function createConfiguredBackgroundCareerAgentRuntime(env: BackgroundCareerAgentEnvironment): BackgroundCareerAgentRuntime {
  const slackConfig = resolveSlackConfig(env);
  const profile = loadBackgroundCandidateProfile(env);
  const sources = createRuntimeSources(env);
  const resumePaths = resolveResumePathsFromEnv(env);
  const browserEnabled = booleanValue(env.ATELIER_CAREER_AGENT_BROWSER_ENABLED, false, "ATELIER_CAREER_AGENT_BROWSER_ENABLED");
  const handoffViewerEnabled = booleanValue(env.ATELIER_HANDOFF_VIEWER_ENABLED, false, "ATELIER_HANDOFF_VIEWER_ENABLED");
  let executionConfig: ReturnType<typeof resolveExecutionHostConfig> | undefined;
  if (browserEnabled) {
    if (profile.profileKind !== "private") {
      throw new Error("A private candidate profile is required when background browser execution is enabled.");
    }
  }
  // The long-lived Slack listener can be a separate process from the browser
  // executor. It still needs the execution-host configuration to issue a
  // protected handoff URL when the viewer is enabled, even when this process
  // deliberately does not own browser automation.
  if (shouldConfigureExecutionHost(browserEnabled, handoffViewerEnabled)) {
    executionConfig = resolveExecutionHostConfig(env);
  }
  const configuredExecutor = browserEnabled ? createConfiguredBrowserExecutor(executionConfig!) : new UnavailableApplicationExecutor();
  const applicationAnswerDraftGenerator = createConfiguredApplicationAnswerDraftGenerator(env);
  const stateFilePath = resolve(valueOrDefault(env.ATELIER_CAREER_AGENT_STATE_FILE, DEFAULT_CAREER_AGENT_STATE_FILE));
  const sharedStorage = new FileKeyValueStorage(stateFilePath);
  const sharedCareerRepository = new LocalStorageCareerRepository(sharedStorage);
  const sharedApplicationRepository = new LocalStorageApplicationRepository(sharedStorage);
  // The long-lived Slack listener and the browser execution host may be
  // separate processes.  Re-read the atomic state file before every lookup
  // that crosses that boundary; otherwise repository instances retain the
  // snapshot they loaded at process start and can reject a freshly published
  // attention event or answer it against stale job state.
  const reloadSharedState = (): void => sharedStorage.reload();
  const submissionAuthority = new DurableSubmissionAuthority(
    executionConfig?.submissionWorkerId ?? env.ATELIER_EXECUTION_WORKER_ID?.trim() ?? "local-execution-host",
    (() => {
      const submissionStateFile = executionConfig?.submissionStateFile ?? env.ATELIER_EXECUTION_SUBMISSION_STATE_FILE ?? stateFilePath;
      return resolve(submissionStateFile) === resolve(stateFilePath)
        ? { storage: sharedStorage }
        : { stateFile: submissionStateFile };
    })(),
  );
  const tracker = createConfiguredGoogleSheetsJobTracker(env as GoogleSheetsEnvironment);
  const executionHostBaseUrl = valueOrDefault(env.ATELIER_EXECUTION_HOST_BASE_URL ?? env.VITE_EXECUTION_HOST_BASE_URL, "http://127.0.0.1:8787");
  const executionHost = new HttpExecutionHostClient({
    baseUrl: executionHostBaseUrl,
  } satisfies ExecutionHostClientOptions);
  let runtime: BackgroundCareerAgentRuntime | undefined;
  const slack = new SlackNotificationAdapter({
    config: slackConfig,
    eventLookup: (eventId: string): AttentionEvent | undefined => {
      reloadSharedState();
      return runtime?.service.listAttentionEvents().find((event) => event.id === eventId);
    },
    persistedAttentionEventsLookup: () => {
      reloadSharedState();
      return sharedCareerRepository.listCampaigns().flatMap((campaign) => campaign.attentionEvents ?? []);
    },
    responseHandler: async (response: AttentionResponse) => {
      if (!runtime) throw new Error("The Career Agent runtime is not ready.");
      try {
        reloadSharedState();
        const result = await runtime.service.resolveAttentionResponse(response);
        if (result.status === "resolved" && result.event.type === "resume_choice") {
          const chosen = result.careerJob.queueResumeFamily ?? "";
          const note = applyResumeChoice
            ? await applyResumeChoice(result.careerJob, chosen).catch(() => "the Sheet could not be updated, so set Resume Version and Ready in the Sheet")
            : "no queue Sheet is configured";
          await slack.publishInfoNotice(`${result.careerJob.job.company}: using ${result.event.answerUsed ?? chosen}; ${note}.`).catch(() => undefined);
        }
        console.info(
          `[career-agent-slack] ${result.status === "resolved" ? "CareerAgentService resume completed" : "attention event already resolved; no resume needed"}`,
        );
        return { status: result.status };
      } catch (error) {
        console.warn(`[career-agent-slack] CareerAgentService resume failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`);
        throw error;
      }
    },
    submissionApprovalHandler: async (approval) => {
      if (!runtime) throw new Error("The Career Agent runtime is not ready.");
      const result = await runtime.submitFromHumanApproval(approval.campaignId, approval.jobId, approval.applicationId, executionHostBaseUrl);
      console.info(`[career-agent-slack] human-approved submit ${result.submitted ? "confirmed" : "not confirmed"}`);
      return result;
    },
    handoffUrlForApplication: executionConfig?.handoffViewer?.enabled
      ? async (applicationId) => {
          try {
            return (await executionHost.issueHandoffForApplication(applicationId)).url;
          } catch {
            return undefined;
          }
        }
      : undefined,
  });
  const queueSpreadsheetId = env.ATELIER_GOOGLE_SHEET_ID?.trim();
  const queueSpreadsheetName = env.ATELIER_GOOGLE_SHEET_NAME?.trim();
  const confirmQueueRow = queueSpreadsheetId && queueSpreadsheetName
    ? async (job: CareerJob): Promise<string | undefined> => {
        const queue = new GoogleSheetsJobQueue({
          spreadsheetId: queueSpreadsheetId,
          spreadsheetName: queueSpreadsheetName,
          sheetTab: env.ATELIER_GOOGLE_SHEET_QUEUE_TAB?.trim() || "Application Queue",
          timeoutMs: 10_000,
        }, createConfiguredGoogleSheetsTransport(env as GoogleSheetsEnvironment));
        const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        const matches = (await queue.list()).filter((row) =>
          // After an unconfirmed Submit the row waits in Needs Input until DONE.
          (row.status === "Ready to Submit" || row.status === "Submitted" || row.status === "Needs Input") &&
          key(row.company) === key(job.job.company) && key(row.role) === key(job.job.title));
        if (matches.length !== 1) return matches.length === 0 ? undefined : "more than one matching row; confirm it in the Sheet";
        const proof = job.submissionProof;
        const confirmedAt = proof?.submittedAt ?? job.manualSubmissionConfirmation?.confirmedAt ?? new Date().toISOString();
        await queue.update(matches[0]!.jobId, {
          status: "Confirmed",
          ...(proof?.externalApplicationId ? { proofId: proof.externalApplicationId } : {}),
          confirmationEvidence: `Applied ${confirmedAt} via ${proof?.provider ?? "manual confirmation"}${proof?.evidence ? ` (${proof.evidence})` : ""}`.slice(0, 300),
          lastError: "",
        });
        return "marked Confirmed";
      }
    : undefined;
  const applyResumeChoice = queueSpreadsheetId && queueSpreadsheetName
    ? async (job: CareerJob, resumeFamily: string): Promise<string> => {
        const transport = createConfiguredGoogleSheetsTransport(env as GoogleSheetsEnvironment);
        const queue = new GoogleSheetsJobQueue({
          spreadsheetId: queueSpreadsheetId,
          spreadsheetName: queueSpreadsheetName,
          sheetTab: env.ATELIER_GOOGLE_SHEET_QUEUE_TAB?.trim() || "Application Queue",
          timeoutMs: 10_000,
        }, transport);
        return applyResumeChoiceToSheets({
          transport, spreadsheetId: queueSpreadsheetId, queue,
          trackerTab: env.ATELIER_GOOGLE_SHEET_TAB?.trim() || "Job Tracker",
          company: job.job.company, role: job.job.title, links: [job.job.applicationUrl, job.job.sourceUrl],
          resumeFamily,
        });
      }
    : undefined;
  const created = createBackgroundCareerAgentRuntime({
    profile,
    ...(confirmQueueRow ? { confirmQueueRow } : {}),
    stateStorage: sharedStorage,
    careerRepository: sharedCareerRepository,
    applicationRepository: sharedApplicationRepository,
    scout: sources.scout,
    destinationResolver: sources.destinationResolver,
    officialDestinationCandidates: sources.officialDestinationCandidates,
    executor: configuredExecutor,
    tracker,
    postingEnricher: (input) => enrichJobIntake(input),
    resumeArtifactAvailable: (familyId) => {
      const path = resumePaths[familyId];
      return Boolean(path && isUsableResumeArtifact(path));
    },
    ...(applicationAnswerDraftGenerator
      ? {
          applicationAnswerDraftGenerator: applicationAnswerDraftGenerator.generate.bind(applicationAnswerDraftGenerator),
        }
      : {}),
    ...createConfiguredAnswerBank(env),
    ...createConfiguredReceiptInbox(env),
    notification: {
      adapter: slack,
      hydrate: (events) => {
        slack.hydratePublishedAttentionEvents(events);
      },
      start: () => slack.start(),
      stop: () => slack.stop(),
    },
    executionHost,
    autoStartHostExecutions: !browserEnabled,
    hostPollIntervalMs: parsePositiveInteger(
      env.ATELIER_CAREER_AGENT_HOST_POLL_INTERVAL_MS,
      500,
      "ATELIER_CAREER_AGENT_HOST_POLL_INTERVAL_MS",
    ),
    hostPollTimeoutMs: parsePositiveInteger(
      env.ATELIER_CAREER_AGENT_HOST_POLL_TIMEOUT_MS,
      30 * 60 * 1_000,
      "ATELIER_CAREER_AGENT_HOST_POLL_TIMEOUT_MS",
    ),
    defaultCampaignInput: sources.campaignInput,
    submissionAuthority,
  });
  runtime = created;
  return created;
}

/**
 * The Slack listener may not own browser automation, but it must still be
 * able to issue protected handoff links through the execution host.
 */
export function shouldConfigureExecutionHost(browserEnabled: boolean, handoffViewerEnabled: boolean): boolean {
  return browserEnabled || handoffViewerEnabled;
}

function parsePositiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

/**
 * The answer bank is on unless ATELIER_CAREER_AGENT_ANSWER_BANK=disabled.
 * When the local model is configured it also matches low-risk questions
 * worded differently from the saved ones.
 */
function createConfiguredAnswerBank(env: Partial<Record<"ATELIER_CAREER_AGENT_ANSWER_BANK" | "ATELIER_CAREER_AGENT_ANSWER_BANK_FILE" | "ATELIER_CAREER_AGENT_OLLAMA_MODEL" | "ATELIER_CAREER_AGENT_OLLAMA_BASE_URL", string | undefined>>) {
  const setting = env.ATELIER_CAREER_AGENT_ANSWER_BANK?.trim() || "enabled";
  if (setting === "disabled") return {};
  if (setting !== "enabled") throw new Error("ATELIER_CAREER_AGENT_ANSWER_BANK must be enabled or disabled.");
  const model = env.ATELIER_CAREER_AGENT_OLLAMA_MODEL?.trim();
  const baseUrl = env.ATELIER_CAREER_AGENT_OLLAMA_BASE_URL?.trim();
  return {
    answerBank: new FileAnswerBankStore(env.ATELIER_CAREER_AGENT_ANSWER_BANK_FILE?.trim() || undefined),
    ...(model ? { answerBankMatcher: createOllamaAnswerBankMatcher({ model, ...(baseUrl ? { baseUrl } : {}) }) } : {}),
  };
}

/**
 * Confirmation emails are read from Gmail (read-only) when Gmail access is on
 * and Google uses OAuth; ATELIER_CAREER_AGENT_RECEIPT_WATCH=disabled turns it off.
 */
function createConfiguredReceiptInbox(env: BackgroundCareerAgentEnvironment) {
  if ((env as Record<string, string | undefined>).ATELIER_CAREER_AGENT_RECEIPT_WATCH?.trim() === "disabled") return {};
  try {
    const googleEnv = env as never;
    if (!gmailSecurityCodesEnabled(googleEnv) || resolveGoogleAuthMode(googleEnv).mode !== "oauth") return {};
    const tokens = createGoogleOAuthAccessTokenProvider(googleEnv, 10_000);
    return { receiptInbox: gmailInbox(() => tokens.getAccessToken()) };
  } catch {
    return {};
  }
}

function createConfiguredApplicationAnswerDraftGenerator(
  env: Pick<
    BackgroundCareerAgentEnvironment,
    | "ATELIER_CAREER_AGENT_ANSWER_DRAFT_MODE"
    | "ATELIER_CAREER_AGENT_OLLAMA_BASE_URL"
    | "ATELIER_CAREER_AGENT_OLLAMA_MODEL"
    | "ATELIER_CAREER_AGENT_OLLAMA_TIMEOUT_MS"
  >,
): OllamaApplicationAnswerDraftGenerator | undefined {
  const mode =
    env.ATELIER_CAREER_AGENT_ANSWER_DRAFT_MODE?.trim() || (env.ATELIER_CAREER_AGENT_OLLAMA_MODEL?.trim() ? "ollama" : "disabled");
  if (mode === "disabled") return undefined;
  if (mode !== "ollama") throw new Error("ATELIER_CAREER_AGENT_ANSWER_DRAFT_MODE must be disabled or ollama.");
  const model = env.ATELIER_CAREER_AGENT_OLLAMA_MODEL?.trim();
  if (!model) throw new Error("ATELIER_CAREER_AGENT_OLLAMA_MODEL is required when answer-draft mode is ollama.");
  return new OllamaApplicationAnswerDraftGenerator({
    model,
    ...(env.ATELIER_CAREER_AGENT_OLLAMA_BASE_URL?.trim() ? { baseUrl: env.ATELIER_CAREER_AGENT_OLLAMA_BASE_URL.trim() } : {}),
    ...(env.ATELIER_CAREER_AGENT_OLLAMA_TIMEOUT_MS?.trim()
      ? {
          timeoutMs: parsePositiveInteger(env.ATELIER_CAREER_AGENT_OLLAMA_TIMEOUT_MS, 20_000, "ATELIER_CAREER_AGENT_OLLAMA_TIMEOUT_MS"),
        }
      : {}),
  });
}

function createConfiguredBrowserExecutor(config: ReturnType<typeof resolveExecutionHostConfig>): ApplicationExecutor {
  return createPlaywrightLeverBrowserExecutor({
    provider: "auto",
    headless: config.headless,
    timeoutMs: config.browserTimeoutMs,
    ...(Object.keys(config.resumePaths).length > 0 ? { resumePaths: config.resumePaths } : {}),
    allowAutomaticSubmission: config.submissionAuthority === "automatic" && !config.preparationOnly,
  });
}
