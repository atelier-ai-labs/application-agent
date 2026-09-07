import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clearDepartmentCache } from "../../../src/hooks/useDepartmentData";
import {
  demoCampaignInput,
  demoJobSource,
} from "../domain/demoSources";
import {
  SourceAwareApplicationExecutor,
} from "../domain/executor";
import {
  JobScout,
} from "../domain/scout";
import {
  createRemotiveJobSource,
  REMOTIVE_SOURCE_ID,
} from "../domain/remotiveJobSource";
import {
  createLeverJobSources,
  createLeverJobSource,
  createLiveCampaignInput,
  parseBroadDiscoveryEnabled,
  parseLeverSites,
} from "../domain/leverJobSource";
import {
  createGreenhouseJobSource,
  createGreenhouseJobSources,
  parseGreenhouseBoards,
} from "../domain/greenhouseJobSource";
import { BRAVE_SEARCH_DISCOVERY_ID } from "../domain/jobDiscovery";
import { JobReferenceResolver, JobReferenceSource } from "../domain/jobReferenceResolver";
import {
  InMemoryJobTracker,
  SourceAwareJobTracker,
} from "../domain/tracker";
import { loadCandidateProfile } from "../domain/profile";
import type {
  AnswerValue,
  CandidateProfile,
  JobIntakeInput,
} from "../domain/types";
import type {
  Campaign,
  CampaignSnapshot,
  CareerJob,
  JobSourceMode,
} from "../domain/campaignTypes";
import type {
  ExecutionHostRequest,
  ExecutionHostSnapshot,
} from "../domain/executionHostTypes";
import {
  getDefaultApplicationRepository,
} from "../persistence/applicationRepository";
import {
  getDefaultCareerRepository,
} from "../persistence/careerRepository";
import { createApplicationService } from "../service/applicationService";
import { CareerAgentService } from "../service/careerAgentService";
import {
  ExecutionHostResponseError,
  ExecutionHostUnavailableError,
  HttpExecutionHostClient,
} from "../service/executionHostClient";
import { HttpGoogleSheetsJobTracker } from "../service/trackerClient";
import { HttpJobDiscoveryProvider } from "../service/jobDiscoveryClient";
import type { JobSearchIntent } from "../domain/searchIntent";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Career Agent could not complete that action.";
}

function hostAwareErrorMessage(error: unknown): string {
  if (error instanceof ExecutionHostUnavailableError) {
    return "Real executor unavailable. Start the local Node host with `npm run career-agent:executor`; no simulated execution was used.";
  }
  return errorMessage(error);
}

function executionRequestFor(
  service: CareerAgentService,
  profile: CandidateProfile,
  campaignId: string,
  jobId: string,
): ExecutionHostRequest {
  const campaign = service.getCampaign(campaignId);
  const careerJob = service.getJob(jobId);
  if (!careerJob.applicationId) throw new Error("This job has no prepared application packet.");
  const application = service.getApplication(careerJob.applicationId);
  return {
    mode: "real_local",
    campaign,
    careerJob,
    application,
    profile,
  };
}

export function useCareerAgentWorkspace() {
  const [profile, setProfile] = useState<CandidateProfile>(() => loadCandidateProfile());
  const careerRepository = useMemo(() => getDefaultCareerRepository(), []);
  const applicationRepository = useMemo(() => getDefaultApplicationRepository(), []);
  const executor = useMemo(() => new SourceAwareApplicationExecutor(), []);
  const executionHostClient = useMemo(() => new HttpExecutionHostClient(), []);
  const tracker = useMemo(
    () => new SourceAwareJobTracker(new InMemoryJobTracker(), new HttpGoogleSheetsJobTracker()),
    [],
  );
  const liveSource = useMemo(() => createRemotiveJobSource(), []);
  const leverSites = useMemo(() => parseLeverSites(), []);
  const leverSources = useMemo(() => createLeverJobSources(leverSites), [leverSites]);
  const greenhouseBoards = useMemo(() => parseGreenhouseBoards(), []);
  const greenhouseSources = useMemo(() => createGreenhouseJobSources(greenhouseBoards), [greenhouseBoards]);
  const broadDiscoveryEnabled = useMemo(() => parseBroadDiscoveryEnabled(), []);
  const referenceResolver = useMemo(() => new JobReferenceResolver(
    [...leverSources, ...greenhouseSources],
    {
      createSource: (classification) => {
        if (classification.kind === "lever" && classification.siteIdentifier) {
          return createLeverJobSource(classification.siteIdentifier);
        }
        if (classification.kind === "greenhouse" && classification.siteIdentifier) {
          return createGreenhouseJobSource(classification.siteIdentifier);
        }
        return undefined;
      },
    },
  ), [greenhouseSources, leverSources]);
  const broadDiscoveryProvider = useMemo(
    () => new HttpJobDiscoveryProvider({ id: BRAVE_SEARCH_DISCOVERY_ID }),
    [],
  );
  const broadReferenceSource = useMemo(
    () => new JobReferenceSource(broadDiscoveryProvider, referenceResolver),
    [broadDiscoveryProvider, referenceResolver],
  );
  const liveCampaignInput = useMemo(
    () => createLiveCampaignInput(leverSites, greenhouseBoards, broadDiscoveryEnabled),
    [broadDiscoveryEnabled, greenhouseBoards, leverSites],
  );
  const scout = useMemo(() => new JobScout({
    [demoJobSource.id]: demoJobSource,
    [liveSource.id]: liveSource,
    ...Object.fromEntries(leverSources.map((source) => [source.id, source])),
    ...Object.fromEntries(greenhouseSources.map((source) => [source.id, source])),
    [broadReferenceSource.id]: broadReferenceSource,
  }), [broadReferenceSource, greenhouseSources, leverSources, liveSource]);
  const service = useMemo(
    () => new CareerAgentService(
      profile,
      {
        applicationService: createApplicationService(profile, applicationRepository),
        careerRepository,
        scout,
        executor,
        tracker,
      },
    ),
    [applicationRepository, careerRepository, executor, profile, scout, tracker],
  );
  const [campaigns, setCampaigns] = useState<readonly Campaign[]>(() => service.listCampaigns());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pollingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    setCampaigns(service.listCampaigns());
  }, [service]);

  const refresh = useCallback(() => {
    setCampaigns(service.listCampaigns());
    clearDepartmentCache("application-agent");
  }, [service]);

  useEffect(() => {
    return () => {
      for (const timer of pollingTimers.current.values()) clearTimeout(timer);
      pollingTimers.current.clear();
    };
  }, []);

  const snapshotFor = useCallback((campaignId: string): CampaignSnapshot | null => {
    try {
      return service.snapshot(campaignId);
    } catch {
      return null;
    }
  }, [service]);

  const createDemoCampaign = useCallback((): Campaign | null => {
    setError(null);
    setNotice(null);
    try {
      const campaign = service.createCampaign(demoCampaignInput);
      refresh();
      setNotice("Synthetic campaign created locally. No live jobs or external applications are connected.");
      return campaign;
    } catch (actionError) {
      setError(errorMessage(actionError));
      return null;
    }
  }, [refresh, service]);

  const createLiveCampaign = useCallback((searchIntent?: JobSearchIntent): Campaign | null => {
    setError(null);
    setNotice(null);
    try {
      const campaign = service.createCampaign(searchIntent
        ? createLiveCampaignInput(leverSites, greenhouseBoards, broadDiscoveryEnabled, searchIntent)
        : liveCampaignInput);
      refresh();
      const targetedParts = [
        leverSites.length > 0 ? `${leverSites.length} configured Lever site${leverSites.length === 1 ? "" : "s"}` : "",
        greenhouseBoards.length > 0 ? `${greenhouseBoards.length} configured Greenhouse board${greenhouseBoards.length === 1 ? "" : "s"}` : "",
        broadDiscoveryEnabled ? "bounded Brave broad discovery" : "",
      ].filter(Boolean);
      const targeted = targetedParts.length > 0 ? ` plus ${targetedParts.join(" and ")}` : "";
      setNotice(`Live campaign created. Run Now will request current Remotive listings${targeted}; no application will be submitted.`);
      return campaign;
    } catch (actionError) {
      setError(errorMessage(actionError));
      return null;
    }
  }, [broadDiscoveryEnabled, greenhouseBoards, leverSites, liveCampaignInput, refresh, service]);

  const activate = useCallback((campaignId: string): boolean => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      service.activateCampaign(campaignId);
      refresh();
      const campaign = service.getCampaign(campaignId);
      setNotice(campaign.searchSources.includes(REMOTIVE_SOURCE_ID) || campaign.searchSources.some((sourceId) => sourceId.startsWith("lever:")) || campaign.searchSources.some((sourceId) => sourceId.startsWith("greenhouse:")) || campaign.searchSources.includes(`references:${BRAVE_SEARCH_DISCOVERY_ID}`)
        ? "Campaign active. Run Now will request the configured live sources; no application will be submitted."
        : "Campaign active. Run Now uses the configured local source in this build.");
      return true;
    } catch (actionError) {
      setError(errorMessage(actionError));
      return false;
    } finally {
      setBusy(false);
    }
  }, [refresh, service]);

  const pause = useCallback((campaignId: string): boolean => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      service.pauseCampaign(campaignId);
      refresh();
      setNotice("Campaign paused. Existing packets remain available for inspection.");
      return true;
    } catch (actionError) {
      setError(errorMessage(actionError));
      return false;
    } finally {
      setBusy(false);
    }
  }, [refresh, service]);

  const runNow = useCallback(async (campaignId: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await service.runCampaign(campaignId);
      refresh();
      const discovery = result.snapshot.campaign.lastDiscovery;
      const discoveryLabel = discovery?.status === "failed"
        ? "source unavailable"
        : discovery?.status === "not_configured"
          ? "broad source not configured"
        : discovery?.status === "partial"
          ? "partial discovery"
          : `${discovery?.newCount ?? result.discovered} new job${(discovery?.newCount ?? result.discovered) === 1 ? "" : "s"}`;
      setNotice(
        `Run complete: ${discoveryLabel}, ` +
        `${result.applied} locally recorded application${result.applied === 1 ? "" : "s"}, ` +
        `${result.attentionRequired} needing attention.`,
      );
      return true;
    } catch (actionError) {
      setError(errorMessage(actionError));
      refresh();
      return false;
    } finally {
      setBusy(false);
    }
  }, [refresh, service]);

  const addCuratedJob = useCallback(async (campaignId: string, input: JobIntakeInput): Promise<CareerJob | null> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const job = await service.processCuratedJob(campaignId, input);
      refresh();
      setNotice(`${job.job.company} — ${job.job.title} evaluated as ${job.fit?.classification ?? "unclassified"}. No application was submitted.`);
      return job;
    } catch (actionError) {
      setError(errorMessage(actionError));
      refresh();
      return null;
    } finally {
      setBusy(false);
    }
  }, [refresh, service]);

  const scheduleExecutionPoll = useCallback((executionId: string) => {
    if (pollingTimers.current.has(executionId)) return;
    const poll = async () => {
      pollingTimers.current.delete(executionId);
      try {
        const snapshot = await executionHostClient.get(executionId);
        const job = service.getJob(snapshot.jobId);
        await service.recordExecutionHostSnapshot(snapshot.campaignId, job.id, snapshot);
        refresh();
        if (["starting", "inspecting", "executing", "resuming"].includes(snapshot.status)) {
          const timer = setTimeout(() => void poll(), 1_500);
          pollingTimers.current.set(executionId, timer);
        }
      } catch (pollError) {
        setError(hostAwareErrorMessage(pollError));
      }
    };
    const timer = setTimeout(() => void poll(), 1_500);
    pollingTimers.current.set(executionId, timer);
  }, [executionHostClient, refresh, service]);

  useEffect(() => {
    let cancelled = false;
    const recover = async () => {
      const activeStatuses = new Set(["starting", "inspecting", "executing", "resuming", "needs_input", "waiting_for_human", "ready_to_submit"]);
      for (const job of service.listJobs()) {
        const executionId = job.execution?.mode === "real_local" ? job.execution.hostExecutionId : undefined;
        if (!executionId || !activeStatuses.has(job.execution?.status ?? "")) continue;
        try {
          const snapshot = await executionHostClient.get(executionId);
          if (cancelled) return;
          await service.recordExecutionHostSnapshot(snapshot.campaignId, job.id, snapshot);
          refresh();
          if (["starting", "inspecting", "executing", "resuming"].includes(snapshot.status)) scheduleExecutionPoll(snapshot.id);
        } catch (recoveryError) {
          if (cancelled) return;
          if (recoveryError instanceof ExecutionHostResponseError && recoveryError.statusCode === 404) {
            service.recordExecutionHostInterrupted(job.campaignId, job.id, executionId);
            refresh();
            setNotice("A prior browser session was not recoverable after the local host stopped. Restart preparation to open a new session.");
          } else {
            setError(hostAwareErrorMessage(recoveryError));
          }
        }
      }
    };
    void recover();
    return () => {
      cancelled = true;
    };
  }, [executionHostClient, refresh, scheduleExecutionPoll, service]);

  const resolveBlocker = useCallback(async (
    campaignId: string,
    jobId: string,
    blockerId: string,
    value: AnswerValue,
  ): Promise<CareerJob | null> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const job = await service.resolveCareerBlocker(campaignId, jobId, blockerId, value);
      if (job.execution?.mode === "real_local" && job.execution.hostExecutionId) {
        const request = executionRequestFor(service, profile, campaignId, jobId);
        const snapshot = await executionHostClient.resume(job.execution.hostExecutionId, request);
        await service.recordExecutionHostSnapshot(campaignId, jobId, snapshot);
        refresh();
        scheduleExecutionPoll(snapshot.id);
        setNotice("Input saved. The same browser session resumed without regenerating completed preparation work.");
        return service.getJob(jobId);
      }
      refresh();
      setNotice("Input saved. The blocked unit resumed without regenerating completed preparation work.");
      return job;
    } catch (actionError) {
      setError(hostAwareErrorMessage(actionError));
      return null;
    } finally {
      setBusy(false);
    }
  }, [executionHostClient, profile, refresh, scheduleExecutionPoll, service]);

  const startBrowserExecution = useCallback(async (campaignId: string, jobId: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const request = executionRequestFor(service, profile, campaignId, jobId);
      const snapshot = await executionHostClient.start(request);
      await service.recordExecutionHostSnapshot(campaignId, jobId, snapshot);
      refresh();
      scheduleExecutionPoll(snapshot.id);
      setNotice("Real browser execution started. The host will stop at CAPTCHA, human input, or the manual Submit boundary.");
      return true;
    } catch (actionError) {
      setError(hostAwareErrorMessage(actionError));
      return false;
    } finally {
      setBusy(false);
    }
  }, [executionHostClient, profile, refresh, scheduleExecutionPoll, service]);

  const resumeBrowserExecution = useCallback(async (campaignId: string, jobId: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const job = service.getJob(jobId);
      const executionId = job.execution?.hostExecutionId;
      if (!executionId) throw new Error("No local browser execution is waiting for this job.");
      const request = executionRequestFor(service, profile, campaignId, jobId);
      const snapshot = await executionHostClient.resume(executionId, request);
      await service.recordExecutionHostSnapshot(campaignId, jobId, snapshot);
      refresh();
      scheduleExecutionPoll(snapshot.id);
      setNotice("Resume requested. The existing browser session is continuing; final submission remains manual.");
      return true;
    } catch (actionError) {
      setError(hostAwareErrorMessage(actionError));
      return false;
    } finally {
      setBusy(false);
    }
  }, [executionHostClient, profile, refresh, scheduleExecutionPoll, service]);

  const cancelBrowserExecution = useCallback(async (campaignId: string, jobId: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const job = service.getJob(jobId);
      const executionId = job.execution?.hostExecutionId;
      if (!executionId) throw new Error("No local browser execution is active for this job.");
      const snapshot = await executionHostClient.cancel(executionId);
      await service.recordExecutionHostSnapshot(campaignId, jobId, snapshot);
      service.recordExecutionHostCancelled(campaignId, jobId, executionId);
      refresh();
      setNotice("Browser session closed. No application was submitted.");
      return true;
    } catch (actionError) {
      setError(hostAwareErrorMessage(actionError));
      return false;
    } finally {
      setBusy(false);
    }
  }, [executionHostClient, refresh, service]);

  const confirmManualApplication = useCallback(async (campaignId: string, jobId: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const job = await service.confirmManualApplication(campaignId, jobId);
      refresh();
      setNotice(job.trackerSync?.status === "synced"
        ? "Application marked Applied. The canonical tracker was updated."
        : "Application marked Applied. Tracker sync needs attention; no submission was inferred by the tracker.");
      return true;
    } catch (actionError) {
      setError(errorMessage(actionError));
      return false;
    } finally {
      setBusy(false);
    }
  }, [refresh, service]);

  const retryTrackerSync = useCallback(async (campaignId: string, jobId: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const job = await service.retryTrackerSync(campaignId, jobId);
      refresh();
      setNotice(job.trackerSync?.status === "synced"
        ? "Tracker sync succeeded."
        : "Tracker sync still needs attention; the application remains Applied.");
      return true;
    } catch (actionError) {
      setError(errorMessage(actionError));
      return false;
    } finally {
      setBusy(false);
    }
  }, [refresh, service]);

  const markOfferAccepted = useCallback((campaignId: string): boolean => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      service.markOfferAccepted(campaignId);
      refresh();
      setNotice("Campaign completed because an offer was accepted.");
      return true;
    } catch (actionError) {
      setError(errorMessage(actionError));
      return false;
    } finally {
      setBusy(false);
    }
  }, [refresh, service]);

  return {
    profile,
    setProfile,
    campaigns,
    busy,
    error,
    notice,
    snapshotFor,
    createDemoCampaign,
    createLiveCampaign,
    sourceModeFor: useCallback((campaign: Campaign): JobSourceMode => {
      if (campaign.lastDiscovery?.sourceModes.includes("live")) return "live";
      if (campaign.lastDiscovery?.sourceModes.includes("demo")) return "demo";
      if (service.listJobs(campaign.id).some((job) => job.sourceMode === "live")) return "live";
      return campaign.searchSources.includes(REMOTIVE_SOURCE_ID) ||
        campaign.searchSources.some((sourceId) => sourceId.startsWith("lever:")) ||
        campaign.searchSources.some((sourceId) => sourceId.startsWith("greenhouse:")) ||
        campaign.searchSources.some((sourceId) => sourceId === `references:${BRAVE_SEARCH_DISCOVERY_ID}`) ||
        campaign.sourceConfigs?.some((source) => source.type === "remotive" || source.type === "lever")
        || campaign.sourceConfigs?.some((source) => source.type === "greenhouse" || source.type === "brave_search")
        ? "live"
        : "demo";
    }, [service]),
    activate,
    pause,
    runNow,
    addCuratedJob,
    resolveBlocker,
    startBrowserExecution,
    resumeBrowserExecution,
    cancelBrowserExecution,
    confirmManualApplication,
    retryTrackerSync,
    markOfferAccepted,
    refresh,
  };
}
