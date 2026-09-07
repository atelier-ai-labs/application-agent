import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Check,
  ExternalLink,
  Minus,
} from "../../../src/components/Icon";
import { formatRelativeTime } from "../../../src/lib/format";
import type {
  CareerBlocker,
  CareerEvent,
  CareerJob,
  Campaign,
  CampaignSnapshot,
  DiscoverySummary,
} from "../domain/campaignTypes";
import { HIMALAYAS_SOURCE_ID } from "../domain/campaignTypes";
import { discoveryCoverageRatios } from "../domain/jobDiscovery";
import { eventLabel } from "../domain/notifications";
import type { ExecutionRunTrace } from "../domain/executionTrace";
import { useCareerAgentWorkspace } from "./useCareerAgentWorkspace";
import type { JobSearchIntent } from "../domain/searchIntent";
import type { JobIntakeInput } from "../domain/types";
import "./application-agent.css";

function LiveSearchForm({ busy, onCreate, onCancel }: {
  busy: boolean;
  onCreate: (intent: JobSearchIntent) => void;
  onCancel: () => void;
}) {
  const [roles, setRoles] = useState("engineer, developer, architect");
  const [locations, setLocations] = useState("");
  const [excluded, setExcluded] = useState("");
  const [remoteOnly, setRemoteOnly] = useState(true);
  const split = (value: string) => value.split(",").map((term) => term.trim()).filter(Boolean);
  return (
    <section className="agent-panel" aria-labelledby="new-search-heading">
      <h2 id="new-search-heading">Configure your search</h2>
      <p>Separate multiple roles, locations, or excluded title terms with commas. Public feeds may have limited location coverage.</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        onCreate({
          primaryLanes: split(roles), adjacentLanes: [], secondaryLanes: [],
          preferredSeniorities: [], excludedSeniorities: [], excludedTitleTerms: split(excluded),
          locations: split(locations), remotePreference: remoteOnly ? "remote_only" : "any",
          employmentTypes: ["full time"], breadth: "targeted",
        });
      }}>
        <div className="agent-form-grid">
          <label>Target roles<input required value={roles} onChange={(event) => setRoles(event.target.value)} /></label>
          <label>Locations<input value={locations} onChange={(event) => setLocations(event.target.value)} placeholder="Any location" /></label>
          <label>Exclude title terms<input value={excluded} onChange={(event) => setExcluded(event.target.value)} placeholder="Optional" /></label>
          <label><input type="checkbox" checked={remoteOnly} onChange={(event) => setRemoteOnly(event.target.checked)} /> Remote only</label>
        </div>
        <div className="agent-form-actions">
          <button className="agent-primary-button" type="submit" disabled={busy || split(roles).length === 0}>Save live campaign</button>
          <button className="agent-secondary-button" type="button" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </section>
  );
}

function readable(value: string): string {
  return value.replace(/_/g, " ");
}

function jobStatusLabel(status: CareerJob["status"]): string {
  return readable(status);
}

function sourceDisplayName(sourceId: string): string {
  if (sourceId === "remotive-live") return "Remotive";
  if (sourceId === HIMALAYAS_SOURCE_ID) return "Himalayas";
  if (sourceId === "demo-local") return "Demo";
  if (sourceId.startsWith("references:brave-search")) return "Brave broad search";
  if (sourceId.startsWith("lever:")) return `Lever · ${sourceId.slice("lever:".length)}`;
  if (sourceId.startsWith("greenhouse:")) return `Greenhouse · ${sourceId.slice("greenhouse:".length)}`;
  if (sourceId === "curated-live") return "User-selected posting";
  return sourceId;
}

function jobProvenanceLabel(job: CareerJob): string {
  if (job.sourceMode === "live") return `LIVE / ${sourceDisplayName(job.sourceId)} / `;
  if (job.sourceMode === "demo" || job.isExample) return `EXAMPLE / ${sourceDisplayName(job.sourceId)} / `;
  return "";
}

function jobActionabilityLabel(job: CareerJob): string {
  return job.actionability === "actionable" && job.job.applicationUrl
    ? "Verified application URL"
    : "Discovery only";
}

function jobActionabilityClass(job: CareerJob): string {
  return job.actionability === "actionable" && job.job.applicationUrl ? "is-actionable" : "is-discovery-only";
}

function trackerStatusLabel(job: CareerJob): string {
  const status = job.trackerSync?.status ?? (job.trackerFailureReason ? "failed" : "not_required");
  if (status === "failed" && /auth|credential|token|oauth|authorization/i.test(job.trackerFailureReason ?? "")) {
    return "authentication required";
  }
  if (status === "failed") return "sync failed";
  return readable(status);
}

function statusClass(status: CareerJob["status"]): string {
  if (status === "applied") return "career-status-success";
  if (status === "needs_input" || status === "held" || status === "ready_to_submit" || status === "failed") return "career-status-attention";
  if (status === "rejected") return "career-status-muted";
  return "career-status-active";
}

export function CareerAgentPage() {
  const { campaignId } = useParams<{ campaignId?: string }>();
  const navigate = useNavigate();
  const workspace = useCareerAgentWorkspace();
  const selectedCampaign = campaignId
    ? workspace.campaigns.find((campaign) => campaign.id === campaignId)
    : workspace.campaigns[0];
  const snapshot = selectedCampaign ? workspace.snapshotFor(selectedCampaign.id) : null;
  const [showSearchForm, setShowSearchForm] = useState(false);

  function createDemo() {
    const campaign = workspace.createDemoCampaign();
    if (campaign) navigate(`/career-agent/${campaign.id}`);
  }

  function createLive() {
    setShowSearchForm(true);
  }

  function saveSearch(intent: JobSearchIntent) {
    const campaign = workspace.createLiveCampaign(intent);
    if (campaign) setShowSearchForm(false);
    if (campaign) navigate(`/career-agent/${campaign.id}`);
  }

  return (
    <div className="shell-container page-space agent-page career-page">
      <Link className="back-link" to="/">
        <ArrowLeft size={16} /> Back to overview
      </Link>

      <section className="agent-hero career-hero">
        <div>
          <p className="eyebrow accent-eyebrow">Atelier HQ / campaign operations</p>
          <h1>Autonomous Career Agent</h1>
          <p className="agent-hero-description">
            A persistent campaign worker around the grounded Application Preparation Core. It keeps
            routine work quiet and surfaces only the decisions, facts, or permissions that need you.
          </p>
        </div>
        <div className="agent-hero-stamp">
          <div className="agent-hero-stamp-heading">
            <span className="agent-stamp-label">V0.1 boundary</span>
            <span className="career-live-badge"><span className="system-indicator" /> LIVE + DEMO</span>
          </div>
          <strong>NO REAL SUBMISSION</strong>
          <span>Current feed available · demo source retained</span>
          <Link className="resource-link" to="/application-agent">
            Open preparation core <ArrowUpRight size={14} />
          </Link>
        </div>
      </section>

      {workspace.error ? <div className="agent-notice agent-notice-error">{workspace.error}</div> : null}
      {workspace.notice ? <div className="agent-notice">{workspace.notice}</div> : null}
      {showSearchForm ? <LiveSearchForm busy={workspace.busy} onCreate={saveSearch} onCancel={() => setShowSearchForm(false)} /> : null}

      <div className="career-workspace-grid">
        <aside className="career-campaign-rail">
          <section className="agent-panel career-panel" aria-labelledby="campaigns-heading">
            <div className="agent-panel-heading">
              <div>
                <p className="eyebrow">Campaigns</p>
                <h2 id="campaigns-heading">Job search</h2>
              </div>
              <span className="agent-count">{workspace.campaigns.length} record{workspace.campaigns.length === 1 ? "" : "s"}</span>
            </div>
            {workspace.campaigns.length > 0 ? (
              <div className="career-campaign-list">
                {workspace.campaigns.map((campaign) => (
                  <CampaignNavItem
                    campaign={campaign}
                    selected={campaign.id === selectedCampaign?.id}
                    key={campaign.id}
                  />
                ))}
              </div>
            ) : (
              <div className="agent-empty-state career-empty-state">
                <Minus size={15} />
                <p>No persistent campaign has been created in this browser.</p>
              </div>
            )}
            <button className="agent-primary-button career-create-button" type="button" onClick={createLive} disabled={workspace.busy}>
              Create live campaign <span>LIVE</span>
            </button>
            <button className="agent-secondary-button career-create-button" type="button" onClick={createDemo} disabled={workspace.busy}>
              Create local demo campaign <span>DEMO</span>
            </button>
          </section>

          <section className="agent-panel career-panel career-profile-summary" aria-labelledby="career-profile-heading">
            <div className="agent-panel-heading">
              <div>
                <p className="eyebrow">Profile anchor</p>
                <h2 id="career-profile-heading">Candidate facts</h2>
              </div>
              <span className={`agent-profile-badge ${workspace.profile.profileKind === "example" ? "is-example" : ""}`}>
                {workspace.profile.profileKind === "example" ? "EXAMPLE" : "PRIVATE"}
              </span>
            </div>
            <p className="agent-profile-name">{workspace.profile.identity.fullName ?? "Unnamed profile"}</p>
            <p className="career-muted-copy">
              The worker can only use facts in the validated profile. Missing personal answers remain
              blockers; they are never inferred.
            </p>
            <Link className="text-link" to="/application-agent">
              Inspect or replace profile <ArrowUpRight size={14} />
            </Link>
          </section>
        </aside>

        <main className="career-main-column">
          {campaignId && !selectedCampaign ? (
            <CampaignNotFound campaignId={campaignId} />
          ) : snapshot ? (
            <CampaignWorkspace
              snapshot={snapshot}
              sourceMode={workspace.sourceModeFor(snapshot.campaign)}
              busy={workspace.busy}
              onActivate={workspace.activate}
              onPause={workspace.pause}
              onRun={workspace.runNow}
              onAddCuratedJob={workspace.addCuratedJob}
              onComplete={workspace.markOfferAccepted}
              onResolve={workspace.resolveBlocker}
              onStartExecution={workspace.startBrowserExecution}
              onResumeExecution={workspace.resumeBrowserExecution}
              onCancelExecution={workspace.cancelBrowserExecution}
              onConfirmApplied={workspace.confirmManualApplication}
              onRetryTrackerSync={workspace.retryTrackerSync}
            />
          ) : (
            <EmptyCampaignState onCreate={createDemo} onCreateLive={createLive} busy={workspace.busy} />
          )}
        </main>
      </div>
    </div>
  );
}

function CampaignNavItem({ campaign, selected }: { campaign: Campaign; selected: boolean }) {
  return (
    <Link className={`career-campaign-item ${selected ? "is-selected" : ""}`} to={`/career-agent/${campaign.id}`}>
      <span className="career-campaign-name">{campaign.name}</span>
      <span className="career-campaign-meta">
        <span className={`career-status ${campaign.status === "active" ? "career-status-success" : "career-status-muted"}`}>
          {readable(campaign.status)}
        </span>
        <ArrowUpRight size={13} />
      </span>
    </Link>
  );
}

function EmptyCampaignState({
  onCreate,
  onCreateLive,
  busy,
}: {
  onCreate: () => void;
  onCreateLive: () => void;
  busy: boolean;
}) {
  return (
    <section className="agent-panel career-empty-panel">
      <p className="eyebrow accent-eyebrow">No campaign selected</p>
      <h2>Start a campaign</h2>
      <p className="career-muted-copy">
        Use the live public feed for current remote postings, or use the clearly synthetic source for
        an offline acceptance run. Neither path submits an application.
      </p>
      <button className="agent-primary-button" type="button" onClick={onCreateLive} disabled={busy}>
        Create live campaign <ArrowUpRight size={15} />
      </button>
      <button className="agent-primary-button" type="button" onClick={onCreate} disabled={busy}>
        Create local demo campaign <ArrowUpRight size={15} />
      </button>
    </section>
  );
}

function CampaignNotFound({ campaignId }: { campaignId: string }) {
  return (
    <section className="agent-panel career-empty-panel">
      <p className="eyebrow">Campaign unavailable</p>
      <h2>That campaign is not in this browser.</h2>
      <p className="career-muted-copy">No campaign record was found for {campaignId}.</p>
      <Link className="text-link" to="/career-agent">Return to Career Agent <ArrowUpRight size={14} /></Link>
    </section>
  );
}

interface CampaignWorkspaceProps {
  snapshot: CampaignSnapshot;
  sourceMode: "live" | "demo";
  busy: boolean;
  onActivate: (campaignId: string) => boolean;
  onPause: (campaignId: string) => boolean;
  onRun: (campaignId: string) => Promise<boolean>;
  onAddCuratedJob: (campaignId: string, input: JobIntakeInput) => Promise<CareerJob | null>;
  onComplete: (campaignId: string) => boolean;
  onResolve: (campaignId: string, jobId: string, blockerId: string, value: string) => Promise<CareerJob | null>;
  onStartExecution: (campaignId: string, jobId: string) => Promise<boolean>;
  onResumeExecution: (campaignId: string, jobId: string) => Promise<boolean>;
  onCancelExecution: (campaignId: string, jobId: string) => Promise<boolean>;
  onConfirmApplied: (campaignId: string, jobId: string) => Promise<boolean>;
  onRetryTrackerSync: (campaignId: string, jobId: string) => Promise<boolean>;
}

function CampaignWorkspace({
  snapshot,
  sourceMode,
  busy,
  onActivate,
  onPause,
  onRun,
  onAddCuratedJob,
  onComplete,
  onResolve,
  onStartExecution,
  onResumeExecution,
  onCancelExecution,
  onConfirmApplied,
  onRetryTrackerSync,
}: CampaignWorkspaceProps) {
  const { campaign, counts } = snapshot;
  return (
    <>
      <section className="career-campaign-header">
        <div>
          <p className="eyebrow">Autonomous career agent / campaign</p>
          <h2>{campaign.name}</h2>
          <p className="career-goal">{campaign.goal}</p>
        </div>
        <div className="career-campaign-state">
          <span className={`career-status-large ${campaign.status === "active" ? "career-status-success" : "career-status-muted"}`}>
            <span className="state-dot" /> {readable(campaign.status)}
          </span>
          <span className="career-simulation-label">{sourceMode === "live" ? "LIVE SOURCE" : "SYNTHETIC / LOCAL"}</span>
        </div>
      </section>

      <section className="career-control-bar" aria-label="Campaign controls">
        {campaign.status === "draft" || campaign.status === "paused" ? (
          <button className="agent-primary-button" type="button" onClick={() => onActivate(campaign.id)} disabled={busy}>
            Start campaign <ArrowUpRight size={14} />
          </button>
        ) : null}
        {campaign.status === "active" ? (
          <button className="agent-secondary-button" type="button" onClick={() => onPause(campaign.id)} disabled={busy}>
            Pause campaign
          </button>
        ) : null}
        {campaign.status === "active" ? (
          <button className="agent-secondary-button" type="button" onClick={() => void onRun(campaign.id)} disabled={busy}>
            {busy ? "Running…" : "Run now"} <Activity size={14} />
          </button>
        ) : null}
        {(campaign.status === "active" || campaign.status === "paused") ? (
          <button className="agent-text-button career-complete-button" type="button" onClick={() => onComplete(campaign.id)} disabled={busy}>
            Mark offer accepted
          </button>
        ) : null}
      </section>

      <CuratedJobPanel
        campaignId={campaign.id}
        active={campaign.status === "active"}
        busy={busy}
        onAdd={onAddCuratedJob}
      />

      <DiscoveryStrip discovery={campaign.lastDiscovery} sourceMode={sourceMode} />
      <RunTraceNote trace={campaign.lastRunTrace} />

      <section className="career-stats-grid" aria-label="Today campaign counts">
        <CareerStat label="Jobs discovered" value={counts.discovered} />
        <CareerStat label="Worth pursuing" value={counts.worthPursuing} />
        <CareerStat label="Applications prepared" value={counts.prepared} />
        <CareerStat label="Applied" value={counts.applied} />
        <CareerStat label="Needs you" value={counts.needsYou} attention={counts.needsYou > 0} />
      </section>

      <AttentionPanel
        snapshot={snapshot}
        busy={busy}
        onResolve={onResolve}
        onStartExecution={onStartExecution}
        onResumeExecution={onResumeExecution}
        onCancelExecution={onCancelExecution}
        onConfirmApplied={onConfirmApplied}
        onRetryTrackerSync={onRetryTrackerSync}
      />

      <div className="career-lower-grid">
        <RecentActivity events={snapshot.recentEvents} />
        <CampaignPolicy campaign={campaign} />
      </div>

      <JobHistory
        jobs={snapshot.jobs}
        busy={busy}
        onStartExecution={onStartExecution}
        onResumeExecution={onResumeExecution}
        onCancelExecution={onCancelExecution}
      />

      <section className="detail-source-note career-boundary-note">
        <div>
          <p className="eyebrow">Execution boundary</p>
          {sourceMode === "live" ? (
            <p>
              This campaign requests current postings from its configured live sources. No employer was
              contacted by this browser surface; it never writes to the tracker or submits an application.
              Actionable Lever, Greenhouse, or Rippling packets
              can be prepared through the separately started local Node browser host, which always stops
              before final submission; an explicit successful-submission confirmation may then sync the
              Applied record through that trusted host.
            </p>
          ) : (
            <p>
              This campaign uses a local synthetic source, a deterministic simulated executor, and an
              in-memory tracker. No employer was contacted, no ATS was opened, and no Google Sheet was
              updated. A real application becomes Applied only after explicit confirmation or external
              proof; tracker writes remain downstream of that state.
            </p>
          )}
        </div>
        <span className="boundary-status"><span className="system-indicator" /> {sourceMode === "live" ? "Discovery live · browser host separate" : "Simulated only"}</span>
      </section>
    </>
  );
}

function CuratedJobPanel({
  campaignId,
  active,
  busy,
  onAdd,
}: {
  campaignId: string;
  active: boolean;
  busy: boolean;
  onAdd: (campaignId: string, input: JobIntakeInput) => Promise<CareerJob | null>;
}) {
  const [rawText, setRawText] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [applicationUrl, setApplicationUrl] = useState("");
  const [companyHint, setCompanyHint] = useState("");
  const [titleHint, setTitleHint] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const created = await onAdd(campaignId, {
      rawText,
      sourceUrl,
      applicationUrl,
      ...(companyHint.trim() ? { companyHint } : {}),
      ...(titleHint.trim() ? { titleHint } : {}),
    });
    if (created) {
      setRawText("");
      setSourceUrl("");
      setApplicationUrl("");
      setCompanyHint("");
      setTitleHint("");
    }
  }

  return (
    <section className="agent-panel career-curated-panel" aria-labelledby="curated-job-heading">
      <div className="agent-panel-heading">
        <div>
          <p className="eyebrow">Selected posting</p>
          <h2 id="curated-job-heading">Add one from the daily hunt</h2>
        </div>
        <span className="agent-panel-index">BOUNDED</span>
      </div>
      <p className="agent-panel-intro">
        Paste one public posting and its application link. The campaign evaluates it with the existing
        fit and pursuit policy; this does not broaden discovery or submit anything.
      </p>
      {!active ? <p className="career-muted-copy">Start this campaign before adding a selected posting.</p> : null}
      <form className="agent-intake-form" onSubmit={(event) => void submit(event)}>
        <div className="agent-form-grid">
          <label>
            <span>Company <small>optional if in posting</small></span>
            <input value={companyHint} onChange={(event) => setCompanyHint(event.target.value)} disabled={!active || busy} />
          </label>
          <label>
            <span>Role <small>optional if in posting</small></span>
            <input value={titleHint} onChange={(event) => setTitleHint(event.target.value)} disabled={!active || busy} />
          </label>
        </div>
        <label>
          <span>Posting text <small>required</small></span>
          <textarea
            value={rawText}
            onChange={(event) => setRawText(event.target.value)}
            placeholder="Paste the public job posting text…"
            minLength={20}
            required
            rows={7}
            disabled={!active || busy}
          />
        </label>
        <div className="agent-form-grid">
          <label>
            <span>Posting/source URL <small>required</small></span>
            <input type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://…" required disabled={!active || busy} />
          </label>
          <label>
            <span>Application URL <small>required</small></span>
            <input type="url" value={applicationUrl} onChange={(event) => setApplicationUrl(event.target.value)} placeholder="https://…" required disabled={!active || busy} />
          </label>
        </div>
        <div className="agent-form-actions">
          <button className="agent-secondary-button" type="submit" disabled={!active || busy}>
            {busy ? "Evaluating…" : "Evaluate selected posting"} <ArrowUpRight size={14} />
          </button>
        </div>
      </form>
    </section>
  );
}

function DiscoveryStrip({
  discovery,
  sourceMode,
}: {
  discovery: DiscoverySummary | undefined;
  sourceMode: "live" | "demo";
}) {
  const statusLabel = discovery?.status === "failed"
    ? "Source unavailable"
    : discovery?.status === "not_configured"
      ? "Broad source not configured"
    : discovery?.status === "partial"
      ? "Partial discovery"
      : discovery?.status === "empty"
        ? "No current matches"
        : discovery
          ? `${discovery.newCount} new after history`
        : "No discovery run yet";
  const sourceLabel = discovery?.sourceIds.length
    ? discovery.sourceIds.map(sourceDisplayName).join(" + ")
    : sourceMode === "live" ? "Remotive" : "Demo";
  const sourceStatusLabel = discovery?.sourceSummaries?.map((source) =>
    `${sourceDisplayName(source.sourceId)}: ${readable(source.status)}` +
    `${source.cached ? ` · cached${source.sourceFetchedAt ? ` · fetched ${formatRelativeTime(source.sourceFetchedAt)}` : ""}` : ""}` +
    `${source.warningCount > 0 ? ` · ${source.warningCount} warning${source.warningCount === 1 ? "" : "s"}` : ""}`,
  ).join(" · ");
  const referenceMetrics = discovery?.referenceMetrics;
  const coverage = referenceMetrics ? discoveryCoverageRatios(referenceMetrics) : {};
  const percentage = (value: number | undefined): string => value === undefined ? "—" : `${Math.round(value * 100)}%`;

  return (
    <section className={`career-discovery-strip ${discovery?.status === "failed" || discovery?.status === "partial" || discovery?.status === "not_configured" ? "is-attention" : ""}`} aria-label="Job discovery status">
      <div>
        <span className="career-discovery-label">Source</span>
        <strong>{sourceMode === "live" ? "LIVE" : "DEMO"} · {sourceLabel}</strong>
      </div>
      <div>
        <span className="career-discovery-label">Last discovery</span>
        <strong>{discovery ? formatRelativeTime(discovery.completedAt) : "Not run"}</strong>
      </div>
      <div>
        <span className="career-discovery-label">Result</span>
        <strong>{statusLabel}</strong>
        {discovery ? (
          <>
            {discovery.status !== "failed" ? (
              <small>{discovery.receivedCount} received · {discovery.normalizedCount} normalized · {discovery.duplicateCount} duplicate</small>
            ) : null}
            {sourceStatusLabel ? <small className="career-source-status">{sourceStatusLabel}</small> : null}
            {referenceMetrics && referenceMetrics.referencesDiscovered > 0 ? (
              <small className="career-source-status">
                References {referenceMetrics.referencesDiscovered} · ATS {referenceMetrics.knownAtsReferences}
                {" "}({referenceMetrics.leverReferences} Lever · {referenceMetrics.greenhouseReferences} Greenhouse)
                {" "}· resolved {referenceMetrics.structuredJobsResolved}
                {" "}· unsupported {referenceMetrics.knownUnsupportedReferences}
                {" "}· fallback {referenceMetrics.unknownOrCustomReferences}
              </small>
            ) : null}
            {referenceMetrics && referenceMetrics.providerResults !== undefined ? (
              <small className="career-source-status">
                Broad sample {referenceMetrics.providerResults} results · {referenceMetrics.acceptedReferences ?? referenceMetrics.referencesDiscovered} accepted
                {" "}· {referenceMetrics.rejectedReferences ?? 0} rejected · {referenceMetrics.duplicateReferences ?? 0} duplicate
                {referenceMetrics.queriesExecuted !== undefined ? ` · ${referenceMetrics.queriesExecuted} quer${referenceMetrics.queriesExecuted === 1 ? "y" : "ies"}` : ""}
              </small>
            ) : null}
            {referenceMetrics && (referenceMetrics.ashbyReferences !== undefined || referenceMetrics.workdayReferences !== undefined || referenceMetrics.customReferences !== undefined || referenceMetrics.unknownReferences !== undefined) ? (
              <small className="career-source-status">
                Classified {referenceMetrics.ashbyReferences ?? 0} Ashby · {referenceMetrics.workdayReferences ?? 0} Workday
                {" "}· {referenceMetrics.customReferences ?? 0} custom · {referenceMetrics.unknownReferences ?? 0} unknown
                {referenceMetrics.uniqueLeverSites !== undefined || referenceMetrics.uniqueGreenhouseBoards !== undefined
                  ? ` · identities ${referenceMetrics.uniqueLeverSites ?? 0} Lever / ${referenceMetrics.uniqueGreenhouseBoards ?? 0} Greenhouse`
                  : ""}
              </small>
            ) : null}
            {referenceMetrics && referenceMetrics.providerResults !== undefined && referenceMetrics.referencesDiscovered > 0 ? (
              <small className="career-source-status">
                Observed sample · ATS {percentage(coverage.knownAtsClassificationRate)} · structured {percentage(coverage.structuredResolutionRate)}
                {" "}· unsupported {percentage(coverage.knownUnsupportedRate)} · fallback {percentage(coverage.fallbackRequiredRate)}
              </small>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

function CareerStat({ label, value, attention = false }: { label: string; value: number; attention?: boolean }) {
  return (
    <div className={`career-stat ${attention ? "is-attention" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function RunTraceNote({ trace }: { trace: ExecutionRunTrace | undefined }) {
  if (!trace) return null;
  const nonSuccessfulNodes = trace.nodes.filter((node) => node.outcome !== "success");
  const duration = trace.durationMs < 1_000
    ? `${trace.durationMs}ms`
    : `${(trace.durationMs / 1_000).toFixed(1)}s`;
  return (
    <div className="career-run-trace-note" aria-label="Last campaign run telemetry">
      <span>Last run</span>
      <strong>{duration}</strong>
      <small>{trace.nodes.length} node{trace.nodes.length === 1 ? "" : "s"}</small>
      <small>{trace.humanAttentionEvents} attention event{trace.humanAttentionEvents === 1 ? "" : "s"}</small>
      {trace.retryCount > 0 ? <small>{trace.retryCount} retr{trace.retryCount === 1 ? "y" : "ies"}</small> : null}
      {nonSuccessfulNodes.length > 0 ? <small>{nonSuccessfulNodes.length} non-success outcome{nonSuccessfulNodes.length === 1 ? "" : "s"}</small> : null}
    </div>
  );
}

function AttentionPanel({
  snapshot,
  busy,
  onResolve,
  onStartExecution,
  onResumeExecution,
  onCancelExecution,
  onConfirmApplied,
  onRetryTrackerSync,
}: {
  snapshot: CampaignSnapshot;
  busy: boolean;
  onResolve: CampaignWorkspaceProps["onResolve"];
  onStartExecution: CampaignWorkspaceProps["onStartExecution"];
  onResumeExecution: CampaignWorkspaceProps["onResumeExecution"];
  onCancelExecution: CampaignWorkspaceProps["onCancelExecution"];
  onConfirmApplied: CampaignWorkspaceProps["onConfirmApplied"];
  onRetryTrackerSync: CampaignWorkspaceProps["onRetryTrackerSync"];
}) {
  const attentionJobs = snapshot.attentionJobs;
  return (
    <section className="agent-panel career-attention-panel" aria-labelledby="needs-attention-heading">
      <div className="agent-panel-heading">
        <div>
          <p className="eyebrow accent-eyebrow">Human attention</p>
          <h2 id="needs-attention-heading">What needs you</h2>
        </div>
        <span className="agent-count">{attentionJobs.length} item{attentionJobs.length === 1 ? "" : "s"}</span>
      </div>
      {attentionJobs.length === 0 ? (
        <div className="agent-empty-state career-clear-state">
          <Check size={15} />
          <p>No open exception. Routine campaign activity remains quiet.</p>
        </div>
      ) : (
        <div className="career-attention-list">
          {attentionJobs.map((job) => (
            <AttentionJob
              job={job}
              busy={busy}
              onResolve={onResolve}
              onStartExecution={onStartExecution}
              onResumeExecution={onResumeExecution}
              onCancelExecution={onCancelExecution}
              onConfirmApplied={onConfirmApplied}
              onRetryTrackerSync={onRetryTrackerSync}
              key={job.id}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function AttentionJob({
  job,
  busy,
  onResolve,
  onStartExecution,
  onResumeExecution,
  onCancelExecution,
  onConfirmApplied,
  onRetryTrackerSync,
}: {
  job: CareerJob;
  busy: boolean;
  onResolve: CampaignWorkspaceProps["onResolve"];
  onStartExecution: CampaignWorkspaceProps["onStartExecution"];
  onResumeExecution: CampaignWorkspaceProps["onResumeExecution"];
  onCancelExecution: CampaignWorkspaceProps["onCancelExecution"];
  onConfirmApplied: CampaignWorkspaceProps["onConfirmApplied"];
  onRetryTrackerSync: CampaignWorkspaceProps["onRetryTrackerSync"];
}) {
  const openBlockers = job.blockers.filter((blocker) => blocker.status === "open");
  const hostStatus = job.execution?.mode === "real_local" ? job.execution.status : undefined;
  return (
    <article className="career-attention-item">
      <div className="career-attention-heading">
        <div>
          <span className="career-job-company">{jobProvenanceLabel(job)}{job.job.company}</span>
          <h3>{job.job.title}</h3>
        </div>
        <span className={`career-status ${statusClass(job.status)}`}>{hostStatus ? readable(hostStatus) : jobStatusLabel(job.status)}</span>
      </div>
      {openBlockers.length > 0 ? (
        <div className="career-blocker-list">
          {openBlockers.map((blocker) => (
            <BlockerForm
              blocker={blocker}
              job={job}
              busy={busy}
              onResolve={onResolve}
              key={blocker.id}
            />
          ))}
        </div>
      ) : (
        <div className="career-blocker-reason">
          <p>{job.status === "ready_to_submit"
            ? "Application form prepared. Final submission remains manual."
            : job.trackerFailureReason ?? job.decisionReason ?? "Review is required before the worker can continue."}</p>
          {job.execution && job.status === "ready_to_submit" ? (
            <small>{job.execution.fieldsFilled.length} of {job.execution.fieldsDetected.length} detected fields prepared · Submit was not activated</small>
          ) : null}
          </div>
      )}
      <BrowserExecutionControls
        job={job}
        busy={busy}
        onStartExecution={onStartExecution}
        onResumeExecution={onResumeExecution}
        onCancelExecution={onCancelExecution}
      />
      <ManualSubmissionControls
        job={job}
        busy={busy}
        onConfirmApplied={onConfirmApplied}
        onRetryTrackerSync={onRetryTrackerSync}
      />
      <div className="career-attention-links">
        {job.applicationId ? (
          <Link className="text-link" to={`/application-agent/${job.applicationId}`}>
            Inspect packet <ArrowUpRight size={13} />
          </Link>
        ) : null}
        {job.job.sourceUrl ? (
          <a className="resource-link" href={job.job.sourceUrl} target="_blank" rel="noreferrer">
            {job.sourceId === HIMALAYAS_SOURCE_ID ? "Open source link" : "Open posting"} <ExternalLink size={13} />
          </a>
        ) : null}
        {job.actionability === "actionable" && job.job.applicationUrl ? (
          <a className="resource-link" href={job.job.applicationUrl} target="_blank" rel="noreferrer">
            Open application <ExternalLink size={13} />
          </a>
        ) : null}
      </div>
    </article>
  );
}

function ManualSubmissionControls({
  job,
  busy,
  onConfirmApplied,
  onRetryTrackerSync,
}: {
  job: CareerJob;
  busy: boolean;
  onConfirmApplied: CampaignWorkspaceProps["onConfirmApplied"];
  onRetryTrackerSync: CampaignWorkspaceProps["onRetryTrackerSync"];
}) {
  const [confirming, setConfirming] = useState(false);

  if (job.status === "ready_to_submit" && job.actionability === "actionable") {
    return (
      <div className="career-manual-confirmation">
        {confirming ? (
          <>
            <span className="career-execution-state">Confirm successful manual submission?</span>
            <button
              className="agent-secondary-button"
              type="button"
              onClick={async () => {
                const confirmed = await onConfirmApplied(job.campaignId, job.id);
                if (confirmed) setConfirming(false);
              }}
              disabled={busy}
            >
              Confirm Applied
            </button>
            <button className="agent-text-button" type="button" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </button>
          </>
        ) : (
          <button className="agent-secondary-button" type="button" onClick={() => setConfirming(true)} disabled={busy}>
            Mark as submitted
          </button>
        )}
      </div>
    );
  }

  if (job.status !== "applied") return null;
  const trackerStatus = job.trackerSync?.status ?? (job.trackerFailureReason ? "failed" : "not_required");
  return (
    <div className="career-manual-confirmation">
      <span className="career-execution-state">APPLIED · Tracker {trackerStatusLabel(job)}</span>
      {trackerStatus === "failed" ? (
        <button
          className="agent-secondary-button"
          type="button"
          onClick={() => void onRetryTrackerSync(job.campaignId, job.id)}
          disabled={busy}
        >
          Retry tracker sync
        </button>
      ) : null}
    </div>
  );
}

function BlockerForm({
  blocker,
  job,
  busy,
  onResolve,
}: {
  blocker: CareerBlocker;
  job: CareerJob;
  busy: boolean;
  onResolve: CampaignWorkspaceProps["onResolve"];
}) {
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState(false);

  async function resolve(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!value.trim()) return;
    const result = await onResolve(job.campaignId, job.id, blocker.id, value.trim());
    if (result) {
      setSubmitted(true);
      setValue("");
    }
  }

  return (
    <div className="career-blocker-item">
      <div className="career-blocker-copy">
        <strong>{blocker.question}</strong>
        <span>{blocker.reason}</span>
        {blocker.evidence.length > 0 ? <small>Evidence: {blocker.evidence.join(" · ")}</small> : null}
      </div>
      <form className="career-blocker-form" onSubmit={resolve}>
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={blocker.kind === "external_login" ? "Session acknowledged" : "Enter a verified answer"}
          aria-label={`Resolve ${blocker.question}`}
          disabled={busy || submitted}
        />
        <button className="agent-secondary-button" type="submit" disabled={busy || submitted || !value.trim()}>
          {submitted ? "Saved" : "Resolve"}
        </button>
      </form>
    </div>
  );
}

function RecentActivity({ events }: { events: readonly CareerEvent[] }) {
  return (
    <section className="agent-panel career-activity-panel" aria-labelledby="career-activity-heading">
      <div className="agent-panel-heading">
        <div>
          <p className="eyebrow">Recent activity</p>
          <h2 id="career-activity-heading">Quiet audit trail</h2>
        </div>
      </div>
      {events.length === 0 ? (
        <div className="agent-empty-state"><Minus size={15} /><p>No campaign events yet.</p></div>
      ) : (
        <div className="career-event-list">
          {events.slice(0, 8).map((event) => (
            <div className="career-event-row" key={event.id}>
              <span className={`career-event-mark ${event.attention ? "is-attention" : ""}`}>
                {event.attention ? "!" : "✓"}
              </span>
              <div className="career-event-copy">
                <strong>{eventLabel(event.type)}</strong>
                <span>{event.metadata?.company && event.metadata.role ? `${event.metadata.company} · ${event.metadata.role}` : event.metadata?.reason ?? "Campaign event"}</span>
              </div>
              <time dateTime={event.occurredAt}>{formatRelativeTime(event.occurredAt)}</time>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function CampaignPolicy({ campaign }: { campaign: Campaign }) {
  const usesHimalayas = campaign.searchSources.includes(HIMALAYAS_SOURCE_ID);
  return (
    <section className="agent-panel career-policy-panel" aria-labelledby="career-policy-heading">
      <div className="agent-panel-heading">
        <div>
          <p className="eyebrow">Policy</p>
          <h2 id="career-policy-heading">Authority</h2>
        </div>
      </div>
      <dl className="career-policy-list">
        <div><dt>Target roles</dt><dd>{campaign.searchCriteria.roleLanes.join(", ") || "Any role"}</dd></div>
        <div><dt>Locations</dt><dd>{campaign.searchCriteria.locations.join(", ") || "Any location"}</dd></div>
        <div><dt>Remote only</dt><dd>{campaign.searchCriteria.remoteOnly ? "Yes" : "No"}</dd></div>
        <div><dt>Excluded titles</dt><dd>{campaign.searchCriteria.excludedTitleTerms?.join(", ") || "None"}</dd></div>
        <div><dt>Fit pursuit</dt><dd>Strong / good pursue · stretch hold · weak reject</dd></div>
        <div><dt>Submission</dt><dd>{readable(campaign.submissionPolicy.authority)}</dd></div>
        <div><dt>Daily cap</dt><dd>{campaign.dailyApplicationLimit} applications</dd></div>
        <div><dt>Sources</dt><dd>{campaign.searchSources.map(sourceDisplayName).join(", ") || "None configured"}</dd></div>
      </dl>
      {usesHimalayas ? (
        <p className="career-policy-footnote">
          Himalayas is the source of these remote listings. <a href="https://himalayas.app" target="_blank" rel="noreferrer">Visit Himalayas</a>.
        </p>
      ) : null}
      <p className="career-policy-footnote">A model cannot grant authority. Explicit policy, grounding, and external proof are required.</p>
    </section>
  );
}

export function BrowserExecutionControls({
  job,
  busy,
  compact = false,
  onStartExecution,
  onResumeExecution,
  onCancelExecution,
}: {
  job: CareerJob;
  busy: boolean;
  compact?: boolean;
  onStartExecution: CampaignWorkspaceProps["onStartExecution"];
  onResumeExecution: CampaignWorkspaceProps["onResumeExecution"];
  onCancelExecution: CampaignWorkspaceProps["onCancelExecution"];
}) {
  const isVerifiedGreenhouseDestination = job.destinationResolution?.status === "resolved" &&
    job.destinationResolution.ats === "Greenhouse" &&
    job.destinationResolution.actionable === true &&
    job.destinationResolution.destinationUrl === job.job.applicationUrl;
  const isVerifiedRipplingDestination = job.destinationResolution?.status === "resolved" &&
    job.destinationResolution.ats === "Rippling" &&
    job.destinationResolution.actionable === true &&
    job.destinationResolution.destinationUrl === job.job.applicationUrl;
  const isSupportedBrowserDestination = job.sourceId.startsWith("lever:") || job.sourceId.startsWith("greenhouse:") ||
    isVerifiedGreenhouseDestination || isVerifiedRipplingDestination;
  if (!job.applicationId || job.actionability !== "actionable" || !job.job.applicationUrl || !isSupportedBrowserDestination) return null;

  const execution = job.execution;
  const isRealLocal = execution?.mode === "real_local" && Boolean(execution.hostExecutionId);
  const status = isRealLocal ? execution?.status : undefined;
  const isRunning = status === "starting" || status === "inspecting" || status === "executing" || status === "resuming";
  const needsResume = status === "needs_input" || status === "waiting_for_human";
  const terminalFailure = status === "failed" || status === "cancelled" || status === "closed";

  return (
    <div className={`career-execution-controls ${compact ? "is-compact" : ""}`}>
      {!isRealLocal || terminalFailure ? (
        <button
          className="agent-secondary-button"
          type="button"
          onClick={() => void onStartExecution(job.campaignId, job.id)}
          disabled={busy}
        >
          Prepare in browser
        </button>
      ) : null}
      {isRunning ? (
        <>
          <span className="career-execution-state">REAL LOCAL · {readable(status ?? "executing")}</span>
          <button
            className="agent-text-button"
            type="button"
            onClick={() => void onCancelExecution(job.campaignId, job.id)}
            disabled={busy}
          >
            Cancel browser
          </button>
        </>
      ) : null}
      {needsResume ? (
        <>
          <span className="career-execution-state">REAL LOCAL · NEEDS YOU</span>
          <button
            className="agent-secondary-button"
            type="button"
            onClick={() => void onResumeExecution(job.campaignId, job.id)}
            disabled={busy}
          >
            Resume browser
          </button>
          <button
            className="agent-text-button"
            type="button"
            onClick={() => void onCancelExecution(job.campaignId, job.id)}
            disabled={busy}
          >
            Cancel browser
          </button>
        </>
      ) : null}
      {status === "ready_to_submit" ? (
        <>
          <span className="career-execution-state">REAL LOCAL · READY TO SUBMIT · MANUAL</span>
          <button
            className="agent-text-button"
            type="button"
            onClick={() => void onCancelExecution(job.campaignId, job.id)}
            disabled={busy}
          >
            Close browser
          </button>
        </>
      ) : null}
    </div>
  );
}

function JobHistory({
  jobs,
  busy,
  onStartExecution,
  onResumeExecution,
  onCancelExecution,
}: {
  jobs: readonly CareerJob[];
  busy: boolean;
  onStartExecution: CampaignWorkspaceProps["onStartExecution"];
  onResumeExecution: CampaignWorkspaceProps["onResumeExecution"];
  onCancelExecution: CampaignWorkspaceProps["onCancelExecution"];
}) {
  return (
    <section className="agent-panel career-history-panel" aria-labelledby="career-history-heading">
      <div className="agent-panel-heading">
        <div>
          <p className="eyebrow">Campaign history</p>
          <h2 id="career-history-heading">Processed postings</h2>
        </div>
        <span className="agent-count">{jobs.length} record{jobs.length === 1 ? "" : "s"}</span>
      </div>
      {jobs.length === 0 ? (
        <div className="agent-empty-state"><Minus size={15} /><p>The next run will place normalized postings here.</p></div>
      ) : (
        <div className="career-job-table">
          {jobs.map((job) => (
            <div className="career-job-row" key={job.id}>
              <div className="career-job-main">
                <span className="career-job-company">{jobProvenanceLabel(job)}{job.job.company}</span>
                <strong>{job.job.title}</strong>
                <div className="career-job-submeta">
                  <span>{sourceDisplayName(job.sourceId)}</span>
                  <span className={`career-actionability ${jobActionabilityClass(job)}`}>{jobActionabilityLabel(job)}</span>
                  {job.job.sourceUrl ? (
                    <a href={job.job.sourceUrl} target="_blank" rel="noreferrer">{job.sourceId === HIMALAYAS_SOURCE_ID ? "Open source link" : "Open posting"} <ExternalLink size={11} /></a>
                  ) : null}
                  {job.actionability === "actionable" && job.job.applicationUrl ? (
                    <a href={job.job.applicationUrl} target="_blank" rel="noreferrer">Open application <ExternalLink size={11} /></a>
                  ) : null}
                </div>
              </div>
              <BrowserExecutionControls
                job={job}
                busy={busy}
                compact
                onStartExecution={onStartExecution}
                onResumeExecution={onResumeExecution}
                onCancelExecution={onCancelExecution}
              />
              <span className={`career-status ${statusClass(job.status)}`}>{jobStatusLabel(job.status)}</span>
              <span className="career-job-fit">{job.fit?.classification ?? "—"}</span>
              {job.status === "applied" ? (
                <span className="career-job-fit">Tracker: {trackerStatusLabel(job)}</span>
              ) : null}
              <time dateTime={job.updatedAt}>{formatRelativeTime(job.updatedAt)}</time>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
