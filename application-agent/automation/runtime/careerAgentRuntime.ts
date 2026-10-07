import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ApplicationService,
  type ApplicationServiceOptions,
} from "../../src/service/applicationService";
import {
  CareerAgentService,
  type CareerAgentServiceOptions,
  type LegacyAttentionRepairResult,
} from "../../src/service/careerAgentService";
import type { ApplicationExecutor } from "../../src/domain/executor";
import { UnavailableApplicationExecutor } from "../../src/domain/executor";
import {
  BraveSearchDiscoveryProvider,
} from "../../src/domain/braveSearchDiscoveryProvider";
import {
  BoundedApplicationDestinationResolver,
  parseDestinationCandidates,
  StaticDestinationEvidenceLookup,
  type ApplicationDestinationResolver,
} from "../../src/domain/applicationDestinationResolver";
import type {
  Campaign,
  CampaignRunResult,
  CreateCampaignInput,
} from "../../src/domain/campaignTypes";
import { HIMALAYAS_SOURCE_ID } from "../../src/domain/campaignTypes";
import type {
  ExecutionHostRequest,
  ExecutionHostSnapshot,
  ExecutionHostStatus,
} from "../../src/domain/executionHostTypes";
import {
  createGreenhouseJobSources,
  DEFAULT_GREENHOUSE_API_BASE_URL,
  parseGreenhouseBoards,
} from "../../src/domain/greenhouseJobSource";
import { JobReferenceResolver, JobReferenceSource } from "../../src/domain/jobReferenceResolver";
import {
  createLeverJobSources,
  createLeverJobSource,
  DEFAULT_LEVER_POSTINGS_BASE_URL,
  parseBroadDiscoveryEnabled,
  parseLeverSites,
  createLiveCampaignInput,
} from "../../src/domain/leverJobSource";
import {
  createRemotiveJobSource,
  DEFAULT_REMOTIVE_API_BASE_URL,
} from "../../src/domain/remotiveJobSource";
import {
  createHimalayasJobSource,
  DEFAULT_HIMALAYAS_API_BASE_URL,
} from "../../src/domain/himalayasJobSource";
import { JobScout, type JobSource } from "../../src/domain/scout";
import type { CandidateProfile, ResumeFamilyId } from "../../src/domain/types";
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
import {
  createConfiguredGoogleSheetsJobTracker,
  type GoogleSheetsEnvironment,
} from "../googleSheetsJobTracker";
import {
  resolveExecutionHostConfig,
  resolveResumePathsFromEnv,
  type ExecutionHostEnvironment,
} from "../executionHost/config";
import {
  SlackNotificationAdapter,
} from "../slack/slackNotificationAdapter";
import {
  resolveSlackConfig,
  type SlackEnvironment,
} from "../slack/config";
import { createPlaywrightLeverBrowserExecutor } from "../createLeverBrowserExecutor";
import { isUsableResumeArtifact } from "../resume/resumeArtifact";
import {
  normalizeJobSearchIntent,
  type JobSearchIntent,
} from "../../src/domain/searchIntent";
import {
  DEFAULT_CAREER_AGENT_STATE_FILE,
  FileKeyValueStorage,
} from "./fileKeyValueStorage";
import type {
  AttentionEvent,
  AttentionResponse,
  NotificationAdapter,
  PersistedAttentionEvent,
} from "../../src/domain/attention";

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
  /** Optional bounded public destination evidence; never read by the browser client. */
  ATELIER_CAREER_AGENT_DESTINATION_EVIDENCE_FILE?: string;
  ATELIER_CAREER_AGENT_BROWSER_ENABLED?: string;
  ATELIER_CAREER_AGENT_CAMPAIGN_ID?: string;
  ATELIER_CAREER_AGENT_RUN_ON_START?: string;
  ATELIER_CAREER_AGENT_CREATE_CAMPAIGN?: string;
  ATELIER_CAREER_AGENT_HOST_POLL_INTERVAL_MS?: string;
  ATELIER_CAREER_AGENT_HOST_POLL_TIMEOUT_MS?: string;
}

export interface RuntimeNotificationTransport {
  adapter: NotificationAdapter;
  hydrate?(events: readonly PersistedAttentionEvent[]): void | Promise<void>;
  start?(): Promise<void>;
  stop?(): void | Promise<void>;
}

/** The existing execution-host HTTP seam, kept as a narrow runtime port. */
export interface CareerAgentExecutionHostPort {
  start(request: ExecutionHostRequest): Promise<ExecutionHostSnapshot>;
  get(executionId: string): Promise<ExecutionHostSnapshot>;
  resume(executionId: string, request?: ExecutionHostRequest): Promise<ExecutionHostSnapshot>;
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
  executor?: ApplicationExecutor;
  tracker?: JobTracker;
  notification?: RuntimeNotificationTransport;
  notificationAdapter?: NotificationAdapter;
  executionHost?: CareerAgentExecutionHostPort;
  autoStartHostExecutions?: boolean;
  hostPollIntervalMs?: number;
  hostPollTimeoutMs?: number;
  resumeArtifactAvailable?: (familyId: ResumeFamilyId) => boolean;
  defaultCampaignInput?: CreateCampaignInput;
  now?: () => string;
  createId?: CareerAgentServiceOptions["createId"];
}

export interface BackgroundCareerAgentRuntime {
  readonly stateStorage?: KeyValueStorage;
  readonly stateFilePath?: string;
  readonly careerRepository: CareerRepository;
  readonly applicationRepository: ApplicationRepository;
  readonly service: CareerAgentService;
  readonly defaultCampaignInput?: CreateCampaignInput;
  start(): Promise<void>;
  stop(): Promise<void>;
  createCampaign(input: CreateCampaignInput): Campaign;
  runCampaign(campaignId: string): Promise<CampaignRunResult>;
  publishPendingAttentionEvents(campaignId?: string): Promise<number>;
  repairLegacyAttentionEvents(campaignId?: string): Promise<LegacyAttentionRepairResult>;
  resolveDestinations(
    campaignId: string,
    jobIds?: readonly string[],
  ): Promise<import("../../src/domain/applicationDestinationResolver").DestinationResolutionRunResult>;
}

const HOST_ACTIVE_STATUSES: ReadonlySet<ExecutionHostStatus> = new Set([
  "starting",
  "inspecting",
  "executing",
  "resuming",
]);

const HOST_TERMINAL_STATUSES: ReadonlySet<ExecutionHostStatus> = new Set([
  "needs_input",
  "waiting_for_human",
  "ready_to_submit",
  "submitted",
  "failed",
  "cancelled",
  "closed",
]);

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
  const careerJob = service.getJob(jobId);
  if (!careerJob.applicationId) throw new Error("This career job has no prepared application packet.");
  const application = service.getApplication(careerJob.applicationId);
  const priorAnswers = service.reusableAnswersFor(careerJob.id);
  return {
    mode: "real_local",
    campaign,
    careerJob,
    application,
    profile,
    ...(priorAnswers.length > 0 ? { priorAnswers } : {}),
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

export function loadBackgroundCandidateProfile(env: Pick<BackgroundCareerAgentEnvironment, "ATELIER_CAREER_AGENT_PROFILE_FILE">): CandidateProfile {
  const path = env.ATELIER_CAREER_AGENT_PROFILE_FILE?.trim();
  if (!path) {
    throw new Error("ATELIER_CAREER_AGENT_PROFILE_FILE is required for the background Career Agent runtime.");
  }
  return loadProfileFromFile(path);
}

export const DEFAULT_CAREER_AGENT_SEARCH_INTENT_FILE = ".local/career-agent/search-intent.json";

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

interface RuntimeSources {
  scout: JobScout;
  campaignInput: CreateCampaignInput;
  destinationResolver: BoundedApplicationDestinationResolver;
}

function createRuntimeSources(env: BackgroundCareerAgentEnvironment): RuntimeSources {
  const remotiveEndpoint = valueOrDefault(env.VITE_REMOTIVE_API_BASE_URL, DEFAULT_REMOTIVE_API_BASE_URL);
  const himalayasEndpoint = valueOrDefault(env.ATELIER_HIMALAYAS_API_BASE_URL, DEFAULT_HIMALAYAS_API_BASE_URL);
  const leverEndpoint = valueOrDefault(env.VITE_LEVER_API_BASE_URL, DEFAULT_LEVER_POSTINGS_BASE_URL);
  const greenhouseEndpoint = valueOrDefault(env.VITE_GREENHOUSE_API_BASE_URL, DEFAULT_GREENHOUSE_API_BASE_URL);
  const leverSites = parseLeverSites(env.VITE_LEVER_SITES ?? "");
  const greenhouseBoards = parseGreenhouseBoards(env.VITE_GREENHOUSE_BOARDS ?? "");
  const broadDiscoveryEnabled = parseBroadDiscoveryEnabled(env.VITE_BROAD_DISCOVERY_ENABLED ?? "false");
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
  const sources: Record<string, JobSource> = {
    [remotive.id]: remotive,
    [HIMALAYAS_SOURCE_ID]: himalayas,
    ...Object.fromEntries(leverSources.map((source) => [source.id, source])),
    ...Object.fromEntries(greenhouseSources.map((source) => [source.id, source])),
  };
  if (broadDiscoveryEnabled) {
    const brave = new BraveSearchDiscoveryProvider({
      ...resolveExecutionHostConfig(env).braveSearch,
    });
    const broadSource = new JobReferenceSource(brave, resolver);
    sources[broadSource.id] = broadSource;
  }

  return {
    scout: new JobScout(sources),
    campaignInput: createLiveCampaignInput(leverSites, greenhouseBoards, broadDiscoveryEnabled, searchIntent, true),
    destinationResolver: new BoundedApplicationDestinationResolver({
      lookup: new StaticDestinationEvidenceLookup(destinationCandidates),
    }),
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
  private started = false;
  private stopped = false;

  constructor(options: BackgroundCareerAgentRuntimeOptions) {
    this.profile = options.profile;
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
    this.defaultCampaignInput = options.defaultCampaignInput;
    const serviceOptions: CareerAgentServiceOptions = {
      ...(options.now ? { now: options.now } : {}),
      ...(options.createId ? { createId: options.createId } : {}),
    };
    const applicationService = options.applicationService ?? new ApplicationService(
      this.applicationRepository,
      options.profile,
      undefined,
      serviceOptions satisfies ApplicationServiceOptions,
    );
    this.service = new CareerAgentService(options.profile, {
      ...(applicationService ? { applicationService } : {}),
      careerRepository: this.careerRepository,
      ...(options.scout ? { scout: options.scout } : {}),
      ...(options.destinationResolver ? { destinationResolver: options.destinationResolver } : {}),
      executor: this.executor,
      ...(options.tracker ? { tracker: options.tracker } : {}),
      notificationAdapter: this.notification.adapter,
      ...(options.resumeArtifactAvailable ? { resumeArtifactAvailable: options.resumeArtifactAvailable } : {}),
      ...(this.executionHost ? {
        resumeAttention: async (campaignId, jobId) => this.resumeHostExecution(campaignId, jobId),
      } : {}),
    }, serviceOptions);
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error("The background Career Agent runtime is stopped.");
    if (this.started) return;
    try {
      await this.notification?.hydrate?.(
        this.careerRepository.listCampaigns().flatMap((campaign) => campaign.attentionEvents ?? []),
      );
      await this.notification?.start?.();
      await this.service.publishPendingAttentionEvents();
      this.started = true;
      await this.resumePendingAttentionContinuations();
    } catch (error) {
      await this.notification?.stop?.();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.notification?.stop?.();
    const applicationIds = [...new Set(this.service.listJobs().map((job) => job.applicationId).filter((id): id is string => Boolean(id)))];
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
      attentionRequired: snapshot.counts.needsYou + (snapshot.campaign.attentionEvents ?? []).filter((event) =>
        event.type === "configuration_required" && event.status === "open",
      ).length,
    };
  }

  publishPendingAttentionEvents(campaignId?: string): Promise<number> {
    return this.service.publishPendingAttentionEvents(campaignId);
  }

  repairLegacyAttentionEvents(campaignId?: string): Promise<LegacyAttentionRepairResult> {
    return this.service.repairLegacyAttentionEvents(campaignId);
  }

  resolveDestinations(campaignId: string, jobIds?: readonly string[]) {
    return this.service.resolveDestinations(campaignId, jobIds);
  }

  private async startPreparedHostExecutions(campaignId: string): Promise<void> {
    if (!this.executionHost) return;
    const candidates = this.service.listJobs(campaignId).filter((job) =>
      job.sourceMode === "live" &&
      job.actionability === "actionable" &&
      (job.sourceId.startsWith("lever:") || job.sourceId.startsWith("greenhouse:") ||
        job.destinationResolution?.ats === "Greenhouse" || job.destinationResolution?.ats === "Rippling") &&
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
    const pending = this.service.listCampaigns().flatMap((campaign) =>
      (campaign.attentionEvents ?? [])
        .filter((event) => event.status === "resolved" && event.type === "needs_input" && Boolean(event.jobId) && Boolean(event.resolvedAt))
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
      const awaitingContinuation = job.status === "needs_input" &&
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

  private async resumeHostExecution(campaignId: string, jobId: string): Promise<void> {
    if (!this.executionHost) return;
    const job = this.service.getJob(jobId);
    const executionId = job.execution?.mode === "real_local" ? job.execution.hostExecutionId : undefined;
    if (!executionId) return;
    const request = executionRequestFor(this.service, this.serviceProfile(), campaignId, jobId);
    let snapshot: ExecutionHostSnapshot;
    try {
      snapshot = await this.executionHost.resume(executionId, request);
    } catch (error) {
      // A host restart loses only the browser handle. Reopening the same
      // validated packet is the existing safe restart path; the executor will
      // inspect the current page before applying the one-time answer.
      const restartable = error instanceof ExecutionHostResponseError &&
        (error.statusCode === 404 ||
          (error.statusCode === 409 && /closed|cannot be resumed|not found/i.test(error.message)));
      if (!restartable) throw error;
      snapshot = await this.executionHost.start(request);
    }
    await this.reconcileHostExecution(campaignId, jobId, snapshot);
  }

  private async reconcileHostExecution(
    campaignId: string,
    jobId: string,
    initial: ExecutionHostSnapshot,
  ): Promise<ExecutionHostSnapshot> {
    if (!this.executionHost) return initial;
    let snapshot = initial;
    await this.service.recordExecutionHostSnapshot(campaignId, jobId, snapshot);
    const deadline = Date.now() + this.hostPollTimeoutMs;
    while (HOST_ACTIVE_STATUSES.has(snapshot.status)) {
      if (Date.now() >= deadline) return snapshot;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, this.hostPollIntervalMs));
      snapshot = await this.executionHost.get(snapshot.id);
      await this.service.recordExecutionHostSnapshot(campaignId, jobId, snapshot);
      if (HOST_TERMINAL_STATUSES.has(snapshot.status)) return snapshot;
    }
    return snapshot;
  }
}

export function createBackgroundCareerAgentRuntime(
  options: BackgroundCareerAgentRuntimeOptions,
): BackgroundCareerAgentRuntime {
  return new BackgroundCareerAgentRuntimeImpl(options);
}

export function createConfiguredBackgroundCareerAgentRuntime(
  env: BackgroundCareerAgentEnvironment,
): BackgroundCareerAgentRuntime {
  const slackConfig = resolveSlackConfig(env);
  const profile = loadBackgroundCandidateProfile(env);
  const sources = createRuntimeSources(env);
  const resumePaths = resolveResumePathsFromEnv(env);
  const browserEnabled = booleanValue(
    env.ATELIER_CAREER_AGENT_BROWSER_ENABLED,
    false,
    "ATELIER_CAREER_AGENT_BROWSER_ENABLED",
  );
  let executionConfig: ReturnType<typeof resolveExecutionHostConfig> | undefined;
  if (browserEnabled) {
    if (profile.profileKind !== "private") {
      throw new Error("A private candidate profile is required when background browser execution is enabled.");
    }
    executionConfig = resolveExecutionHostConfig(env);
  }
  const configuredExecutor = browserEnabled
    ? createConfiguredBrowserExecutor(executionConfig!)
    : new UnavailableApplicationExecutor();
  const stateFilePath = resolve(valueOrDefault(env.ATELIER_CAREER_AGENT_STATE_FILE, DEFAULT_CAREER_AGENT_STATE_FILE));
  const sharedStorage = new FileKeyValueStorage(stateFilePath);
  const sharedCareerRepository = new LocalStorageCareerRepository(sharedStorage);
  const sharedApplicationRepository = new LocalStorageApplicationRepository(sharedStorage);
  const tracker = createConfiguredGoogleSheetsJobTracker(env as GoogleSheetsEnvironment);
  const executionHost = new HttpExecutionHostClient({
    baseUrl: valueOrDefault(
      env.ATELIER_EXECUTION_HOST_BASE_URL ?? env.VITE_EXECUTION_HOST_BASE_URL,
      "http://127.0.0.1:8787",
    ),
  } satisfies ExecutionHostClientOptions);
  let runtime: BackgroundCareerAgentRuntime | undefined;
  const slack = new SlackNotificationAdapter({
    config: slackConfig,
    eventLookup: (eventId: string): AttentionEvent | undefined => runtime?.service.listAttentionEvents().find((event) => event.id === eventId),
    persistedAttentionEventsLookup: () => sharedCareerRepository.listCampaigns().flatMap((campaign) => campaign.attentionEvents ?? []),
    responseHandler: async (response: AttentionResponse) => {
      if (!runtime) throw new Error("The Career Agent runtime is not ready.");
      try {
        const result = await runtime.service.resolveAttentionResponse(response);
        console.info(`[career-agent-slack] ${result.status === "resolved" ? "CareerAgentService resume completed" : "attention event already resolved; no resume needed"}`);
        return { status: result.status };
      } catch (error) {
        console.warn("[career-agent-slack] CareerAgentService resume failed");
        throw error;
      }
    },
  });
  const created = createBackgroundCareerAgentRuntime({
    profile,
    stateStorage: sharedStorage,
    careerRepository: sharedCareerRepository,
    applicationRepository: sharedApplicationRepository,
    scout: sources.scout,
    destinationResolver: sources.destinationResolver,
    executor: configuredExecutor,
    tracker,
    resumeArtifactAvailable: (familyId) => {
      const path = resumePaths[familyId];
      return Boolean(path && isUsableResumeArtifact(path));
    },
    notification: {
      adapter: slack,
      hydrate: (events) => { slack.hydratePublishedAttentionEvents(events); },
      start: () => slack.start(),
      stop: () => slack.stop(),
    },
    executionHost,
    autoStartHostExecutions: !browserEnabled,
    hostPollIntervalMs: parsePositiveInteger(env.ATELIER_CAREER_AGENT_HOST_POLL_INTERVAL_MS, 500, "ATELIER_CAREER_AGENT_HOST_POLL_INTERVAL_MS"),
    hostPollTimeoutMs: parsePositiveInteger(env.ATELIER_CAREER_AGENT_HOST_POLL_TIMEOUT_MS, 30 * 60 * 1_000, "ATELIER_CAREER_AGENT_HOST_POLL_TIMEOUT_MS"),
    defaultCampaignInput: sources.campaignInput,
  });
  runtime = created;
  return created;
}

function parsePositiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function createConfiguredBrowserExecutor(config: ReturnType<typeof resolveExecutionHostConfig>): ApplicationExecutor {
  return createPlaywrightLeverBrowserExecutor({
    provider: "auto",
    headless: config.headless,
    timeoutMs: config.browserTimeoutMs,
    ...(Object.keys(config.resumePaths).length > 0 ? { resumePaths: config.resumePaths } : {}),
    allowAutomaticSubmission: config.submissionAuthority === "automatic",
  });
}
