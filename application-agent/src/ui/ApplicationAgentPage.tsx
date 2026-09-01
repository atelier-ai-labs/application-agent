import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ArrowUpRight, Check, ExternalLink, Minus } from "../../../src/components/Icon";
import { formatRelativeTime } from "../../../src/lib/format";
import { getDepartment } from "../../../src/departments/config";
import { DepartmentStatusPill } from "../../../src/components/StatusPill";
import { exampleJobIntake } from "../domain/examples";
import { useApplicationWorkspace } from "./useApplicationWorkspace";
import type {
  AnswerPolicy,
  Application,
  ApplicationAnswer,
  ApplicationEvent,
  CandidateProfile,
  FitAssessment,
  HumanRequiredField,
  TailoredResume,
  TailoredResumeSection,
} from "../domain/types";
import "./application-agent.css";

const applicationAgentDepartment = getDepartment("application-agent");

function statusLabel(status: Application["status"]): string {
  return status.replace(/_/g, " ");
}

function policyLabel(policy: AnswerPolicy): string {
  return policy.replace(/_/g, " ");
}

function answerStatusLabel(status: ApplicationAnswer["status"]): string {
  return status.replace(/_/g, " ");
}

function valueText(value: ApplicationAnswer["value"]): string {
  if (value === undefined) return "No value supplied";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

export function ApplicationAgentPage() {
  const { applicationId } = useParams<{ applicationId?: string }>();
  const navigate = useNavigate();
  const workspace = useApplicationWorkspace();
  const [rawText, setRawText] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [applicationUrl, setApplicationUrl] = useState("");
  const [companyHint, setCompanyHint] = useState("");
  const [titleHint, setTitleHint] = useState("");
  const [exampleMode, setExampleMode] = useState(false);

  const selectedApplication = applicationId
    ? workspace.applications.find((application) => application.id === applicationId)
    : undefined;

  async function handlePrepare(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const application = await workspace.prepare({
      rawText,
      sourceUrl: sourceUrl || undefined,
      applicationUrl: applicationUrl || undefined,
      companyHint: companyHint || undefined,
      titleHint: titleHint || undefined,
      isExample: exampleMode,
    });
    if (application) navigate(`/application-agent/${application.id}`);
  }

  function loadExample() {
    setExampleMode(true);
    setRawText(exampleJobIntake.rawText);
    setSourceUrl(exampleJobIntake.sourceUrl ?? "");
    setApplicationUrl(exampleJobIntake.applicationUrl ?? "");
    setCompanyHint(exampleJobIntake.companyHint ?? "");
    setTitleHint(exampleJobIntake.titleHint ?? "");
  }

  return (
    <div className="shell-container page-space agent-page">
      <Link className="back-link" to="/">
        <ArrowLeft size={16} /> Back to overview
      </Link>

      <section className="agent-hero">
        <div>
          <p className="eyebrow accent-eyebrow">Atelier HQ / application operations</p>
          <h1>Application Agent</h1>
          <p className="agent-hero-description">
            Turn a real posting into a grounded, reviewable application packet. The last step stays
            with you.
          </p>
        </div>
        <div className="agent-hero-stamp">
          <div className="agent-hero-stamp-heading">
            <span className="agent-stamp-label">V0 boundary</span>
            {applicationAgentDepartment ? <DepartmentStatusPill status={applicationAgentDepartment.status} /> : null}
          </div>
          <strong>STOP BEFORE SUBMIT</strong>
          <span>Local preparation · human review</span>
          {applicationAgentDepartment?.repositoryUrl ? (
            <ExternalResourceLink href={applicationAgentDepartment.repositoryUrl}>View repository</ExternalResourceLink>
          ) : null}
          <Link className="resource-link" to="/career-agent">
            Open Career Agent <ArrowUpRight size={14} />
          </Link>
        </div>
      </section>

      {workspace.error ? <div className="agent-notice agent-notice-error">{workspace.error}</div> : null}
      {workspace.notice ? <div className="agent-notice">{workspace.notice}</div> : null}

      <div className="agent-workspace-grid">
        <main className="agent-main-column">
          {selectedApplication ? (
            <ApplicationDetail
              application={selectedApplication}
              events={workspace.eventsFor(selectedApplication.id)}
              busy={workspace.busy}
              onResolve={workspace.resolveField}
            />
          ) : applicationId ? (
            <NotFoundApplication applicationId={applicationId} />
          ) : (
            <>
              <IntakePanel
                rawText={rawText}
                sourceUrl={sourceUrl}
                applicationUrl={applicationUrl}
                companyHint={companyHint}
                titleHint={titleHint}
                busy={workspace.busy}
                onRawTextChange={(value) => { setExampleMode(false); setRawText(value); }}
                onSourceUrlChange={(value) => { setExampleMode(false); setSourceUrl(value); }}
                onApplicationUrlChange={(value) => { setExampleMode(false); setApplicationUrl(value); }}
                onCompanyHintChange={(value) => { setExampleMode(false); setCompanyHint(value); }}
                onTitleHintChange={(value) => { setExampleMode(false); setTitleHint(value); }}
                onSubmit={handlePrepare}
                onLoadExample={loadExample}
              />
              <ApplicationHistory applications={workspace.applications} />
            </>
          )}
        </main>

        <aside className="agent-sidebar">
          <ProfilePanel
            profile={workspace.profile}
            busy={workspace.busy}
            onImport={workspace.importProfile}
            onUseExample={workspace.useExampleProfile}
          />
          <WorkflowPanel selectedApplication={selectedApplication} />
          <div className="agent-boundary-note">
            <p className="eyebrow">Human boundary</p>
            <p>
              Application Agent can prepare and organize. It never sends an application, clicks a
              final-submit control, or transmits profile data to a model provider in V0.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

interface IntakePanelProps {
  rawText: string;
  sourceUrl: string;
  applicationUrl: string;
  companyHint: string;
  titleHint: string;
  busy: boolean;
  onRawTextChange: (value: string) => void;
  onSourceUrlChange: (value: string) => void;
  onApplicationUrlChange: (value: string) => void;
  onCompanyHintChange: (value: string) => void;
  onTitleHintChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onLoadExample: () => void;
}

function IntakePanel({
  rawText,
  sourceUrl,
  applicationUrl,
  companyHint,
  titleHint,
  busy,
  onRawTextChange,
  onSourceUrlChange,
  onApplicationUrlChange,
  onCompanyHintChange,
  onTitleHintChange,
  onSubmit,
  onLoadExample,
}: IntakePanelProps) {
  return (
    <section className="agent-panel agent-intake-panel" aria-labelledby="intake-heading">
      <div className="agent-panel-heading">
        <div>
          <p className="eyebrow">01 / Job intake</p>
          <h2 id="intake-heading">Start with the posting</h2>
        </div>
        <span className="agent-panel-index">PASTE</span>
      </div>
      <p className="agent-panel-intro">
        Paste the source text below. Optional hints help when a board omits a clean company or role
        heading. URLs are recorded for provenance only; V0 does not scrape them.
      </p>

      <form className="agent-intake-form" onSubmit={onSubmit}>
        <div className="agent-form-grid">
          <label>
            <span>Company hint <small>optional</small></span>
            <input value={companyHint} onChange={(event) => onCompanyHintChange(event.target.value)} />
          </label>
          <label>
            <span>Role hint <small>optional</small></span>
            <input value={titleHint} onChange={(event) => onTitleHintChange(event.target.value)} />
          </label>
        </div>
        <label>
          <span>Job posting text <small>required</small></span>
          <textarea
            value={rawText}
            onChange={(event) => onRawTextChange(event.target.value)}
            placeholder="Paste the full job posting here…"
            minLength={20}
            required
            rows={13}
          />
        </label>
        <div className="agent-form-grid">
          <label>
            <span>Source URL <small>optional</small></span>
            <input type="url" value={sourceUrl} onChange={(event) => onSourceUrlChange(event.target.value)} placeholder="https://…" />
          </label>
          <label>
            <span>Application URL <small>optional</small></span>
            <input type="url" value={applicationUrl} onChange={(event) => onApplicationUrlChange(event.target.value)} placeholder="https://…" />
          </label>
        </div>
        <div className="agent-form-actions">
          <button className="agent-primary-button" type="submit" disabled={busy}>
            {busy ? "Preparing…" : "Normalize and prepare"} <ArrowUpRight size={15} />
          </button>
          <button className="agent-secondary-button" type="button" onClick={onLoadExample} disabled={busy}>
            Load example workflow <span>DEMO</span>
          </button>
        </div>
      </form>
    </section>
  );
}

function ApplicationHistory({ applications }: { applications: readonly Application[] }) {
  return (
    <section className="agent-panel agent-history-panel" aria-labelledby="history-heading">
      <div className="agent-panel-heading">
        <div>
          <p className="eyebrow">02 / Applications</p>
          <h2 id="history-heading">Application history</h2>
        </div>
        <span className="agent-count">{applications.length} record{applications.length === 1 ? "" : "s"}</span>
      </div>
      {applications.length === 0 ? (
        <div className="agent-empty-state">
          <Minus size={15} />
          <p>No application packets yet. A prepared packet will remain in this browser.</p>
        </div>
      ) : (
        <div className="agent-history-list">
          {applications.map((application) => (
            <Link className="agent-history-item" to={`/application-agent/${application.id}`} key={application.id}>
              <div>
                <span className="agent-history-company">
                  {application.isExample ? "EXAMPLE / " : ""}{application.job.company}
                </span>
                <strong>{application.job.title}</strong>
              </div>
              <div className="agent-history-meta">
                <AgentStatus status={application.status} />
                <span>{formatRelativeTime(application.updatedAt)}</span>
                <ArrowUpRight size={15} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function ProfilePanel({
  profile,
  busy,
  onImport,
  onUseExample,
}: {
  profile: CandidateProfile;
  busy: boolean;
  onImport: (file: File) => Promise<boolean>;
  onUseExample: () => void;
}) {
  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (file) await onImport(file);
    event.currentTarget.value = "";
  }

  return (
    <section className="agent-panel agent-profile-panel" aria-labelledby="profile-heading">
      <div className="agent-panel-heading">
        <div>
          <p className="eyebrow">Profile source</p>
          <h2 id="profile-heading">Candidate facts</h2>
        </div>
        <span className={`agent-profile-badge ${profile.profileKind === "example" ? "is-example" : ""}`}>
          {profile.profileKind === "example" ? "EXAMPLE" : "PRIVATE"}
        </span>
      </div>
      <p className="agent-profile-name">{profile.identity.fullName ?? "Unnamed profile"}</p>
      <p className="agent-panel-intro">
        Only verified profile facts can flow into a packet. Drafted language is marked for review;
        missing personal answers stay open.
      </p>
      <label className="agent-file-control">
        <span>Load private profile JSON</span>
        <input type="file" accept="application/json,.json" onChange={handleFile} disabled={busy} />
      </label>
      {profile.profileKind === "example" ? (
        <p className="agent-example-warning">EXAMPLE PROFILE — replace before using a real application.</p>
      ) : (
        <button className="agent-text-button" type="button" onClick={onUseExample} disabled={busy}>
          Switch to example profile
        </button>
      )}
      <span className="agent-storage-note">Stored locally in this browser. No upload is performed.</span>
    </section>
  );
}

function WorkflowPanel({ selectedApplication }: { selectedApplication: Application | undefined }) {
  const activeStatus = selectedApplication?.status;
  const steps = [
    ["01", "Intake", !activeStatus || activeStatus !== "discovered"],
    ["02", "Fit", activeStatus === "evaluated" || activeStatus === "preparing" || activeStatus === "needs_input" || activeStatus === "ready_for_review"],
    ["03", "Prepare", activeStatus === "preparing" || activeStatus === "needs_input" || activeStatus === "ready_for_review"],
    ["04", "Review", activeStatus === "ready_for_review"],
  ] as const;

  return (
    <section className="agent-panel agent-workflow-panel" aria-labelledby="workflow-heading">
      <div className="agent-panel-heading">
        <div>
          <p className="eyebrow">Workflow</p>
          <h2 id="workflow-heading">Preparation path</h2>
        </div>
      </div>
      <ol className="agent-step-list">
        {steps.map(([number, label, complete]) => (
          <li className={complete ? "is-complete" : ""} key={number}>
            <span>{complete ? <Check size={13} /> : number}</span>
            <strong>{label}</strong>
          </li>
        ))}
      </ol>
      <p className="agent-workflow-footnote">
        {selectedApplication ? `Current state: ${statusLabel(selectedApplication.status)}` : "No packet selected"}
      </p>
    </section>
  );
}

function ApplicationDetail({
  application,
  events,
  busy,
  onResolve,
}: {
  application: Application;
  events: readonly ApplicationEvent[];
  busy: boolean;
  onResolve: (applicationId: string, blockerId: string, value: string) => Promise<Application | null>;
}) {
  const [draftValues, setDraftValues] = useState<Readonly<Record<string, string>>>({});
  const resolvedCount = application.answers.filter((answer) => answer.status === "resolved").length;
  const draftedCount = application.answers.filter((answer) => answer.status === "drafted").length;
  const openBlockers = application.blockers.filter((blocker) => blocker.status === "open");

  async function resolve(blocker: HumanRequiredField) {
    const value = draftValues[blocker.id] ?? "";
    const updated = await onResolve(application.id, blocker.id, value);
    if (updated) {
      setDraftValues((current) => ({ ...current, [blocker.id]: "" }));
    }
  }

  return (
    <>
      <div className="agent-detail-back-row">
        <Link className="back-link" to="/application-agent">
          <ArrowLeft size={16} /> All applications
        </Link>
        {application.isExample ? <span className="agent-example-label">EXAMPLE WORKFLOW</span> : null}
      </div>

      <section className="agent-readiness-panel">
        <div className="agent-readiness-topline">
          <div>
            <p className="eyebrow">Application packet</p>
            <h2>{application.job.company}</h2>
            <p className="agent-role-title">{application.job.title}</p>
          </div>
          <AgentStatus status={application.status} prominent />
        </div>
        <div className="agent-readiness-grid">
          <div>
            <span>Fit</span>
            <strong>{application.fit ? titleCase(application.fit.classification) : "Not evaluated"}</strong>
          </div>
          <div>
            <span>Resume family</span>
            <strong>{application.resume?.familyLabel ?? "Not selected"}</strong>
          </div>
          <div>
            <span>Preparation</span>
            <strong>{resolvedCount} of {application.answers.length} resolved</strong>
          </div>
          <div>
            <span>Drafts for review</span>
            <strong>{draftedCount}</strong>
          </div>
        </div>
        <div className="agent-readiness-note">
          {application.status === "ready_for_review"
            ? "Ready for your review. Submit manually on the employer’s site when you are satisfied."
            : application.status === "needs_input"
              ? `${openBlockers.length} human-required field${openBlockers.length === 1 ? "" : "s"} still open.`
              : `Captured ${formatRelativeTime(application.createdAt)}.`}
        </div>
      </section>

      {openBlockers.length > 0 ? (
        <section className="agent-panel agent-blocker-panel" aria-labelledby="blockers-heading">
          <div className="agent-panel-heading">
            <div>
              <p className="eyebrow">Human review queue</p>
              <h2 id="blockers-heading">What still needs you</h2>
            </div>
            <span className="agent-blocker-count">{openBlockers.length} open</span>
          </div>
          <p className="agent-panel-intro">
            These fields are never silently guessed. Enter an explicit answer to resolve each one;
            even `NEVER AUTO` fields remain under your control.
          </p>
          <div className="agent-blocker-list">
            {openBlockers.map((blocker) => (
              <div className="agent-blocker-item" key={blocker.id}>
                <div>
                  <div className="agent-answer-meta">
                    <span className="agent-field-label">{blocker.label}</span>
                    <span className="agent-policy">{policyLabel(blocker.policy)}</span>
                  </div>
                  <p>{blocker.reason}</p>
                </div>
                <div className="agent-blocker-action">
                  <input
                    aria-label={blocker.label}
                    value={draftValues[blocker.id] ?? ""}
                    onChange={(event) => setDraftValues((current) => ({ ...current, [blocker.id]: event.target.value }))}
                    placeholder="Your answer"
                  />
                  <button type="button" onClick={() => resolve(blocker)} disabled={busy}>
                    Save answer
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {application.fit ? <FitPanel fit={application.fit} /> : null}
      {application.resume ? <ResumePanel resume={application.resume} /> : null}
      <AnswersPanel answers={application.answers} />
      <PostingPanel application={application} />
      <EventsPanel events={events} />

      <section className="agent-submission-boundary">
        <div>
          <p className="eyebrow">V0 submission boundary</p>
          <h2>No application is sent from here.</h2>
          <p>Review the prepared packet, open the employer’s application page, and submit manually.</p>
        </div>
        <span className="agent-boundary-lock">MANUAL ONLY</span>
      </section>
    </>
  );
}

function FitPanel({ fit }: { fit: FitAssessment }) {
  return (
    <section className="agent-panel" aria-labelledby="fit-heading">
      <div className="agent-panel-heading">
        <div>
          <p className="eyebrow">03 / Fit assessment</p>
          <h2 id="fit-heading">Grounded against the profile</h2>
        </div>
        <AgentFitLabel classification={fit.classification} />
      </div>
      <div className="agent-fit-summary">
        <div>
          <span>Recommendation</span>
          <strong>{fit.applicationRecommendation.replace(/_/g, " ")}</strong>
        </div>
        <div>
          <span>Resume routing</span>
          <strong>{fit.recommendedResumeFamily}</strong>
        </div>
      </div>
      <p className="agent-methodology">{fit.methodology}</p>
      <div className="agent-fit-columns">
        <FitList title="Strong matches" values={fit.strongMatches} className="is-positive" />
        <FitList title="Partial matches" values={fit.partialMatches} className="is-partial" />
        <FitList title="Meaningful gaps" values={fit.meaningfulGaps} className="is-gap" />
      </div>
      <div className="agent-routing-note">
        <strong>Why {fit.recommendedResumeFamily}?</strong> {fit.resumeFamilyReason}
      </div>
    </section>
  );
}

function FitList({ title, values, className }: { title: string; values: readonly string[]; className: string }) {
  return (
    <div className={`agent-fit-list ${className}`}>
      <span>{title}</span>
      {values.length > 0 ? (
        <ul>
          {values.map((value) => <li key={value}>{value}</li>)}
        </ul>
      ) : <p>None recorded</p>}
    </div>
  );
}

function ResumePanel({ resume }: { resume: TailoredResume }) {
  return (
    <section className="agent-panel" aria-labelledby="resume-heading">
      <div className="agent-panel-heading">
        <div>
          <p className="eyebrow">04 / Resume routing</p>
          <h2 id="resume-heading">{resume.familyLabel}</h2>
        </div>
        <span className="agent-panel-index">GROUNDED</span>
      </div>
      <p className="agent-panel-intro">{resume.summary}</p>
      <div className="agent-resume-sections">
        {resume.sections.map((section) => <ResumeSection section={section} key={`${section.kind}-${section.title}`} />)}
      </div>
    </section>
  );
}

function ResumeSection({ section }: { section: TailoredResumeSection }) {
  return (
    <div className="agent-resume-section">
      <div className="agent-resume-section-heading">
        <h3>{section.title}</h3>
        <span>{section.provenance.join(" · ")}</span>
      </div>
      {Array.isArray(section.content) ? (
        <ul>
          {section.content.map((item) => <li key={item}>{item}</li>)}
        </ul>
      ) : <p>{section.content}</p>}
    </div>
  );
}

function AnswersPanel({ answers }: { answers: readonly ApplicationAnswer[] }) {
  return (
    <section className="agent-panel" aria-labelledby="answers-heading">
      <div className="agent-panel-heading">
        <div>
          <p className="eyebrow">05 / Application answers</p>
          <h2 id="answers-heading">Prepared fields</h2>
        </div>
        <span className="agent-count">{answers.length} fields</span>
      </div>
      <div className="agent-answer-list">
        {answers.map((answer) => (
          <div className="agent-answer-row" key={answer.id}>
            <div>
              <span className="agent-field-label">{answer.question ?? answer.field}</span>
              <div className="agent-answer-meta">
                <span className={`agent-answer-status status-${answer.status}`}>{answerStatusLabel(answer.status)}</span>
                <span className="agent-policy">{policyLabel(answer.policy)}</span>
              </div>
            </div>
            <p>{valueText(answer.value)}</p>
            {answer.provenance && answer.provenance.length > 0 ? (
              <span className="agent-answer-provenance">{answer.provenance.join(" · ")}</span>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function PostingPanel({ application }: { application: Application }) {
  return (
    <section className="agent-panel agent-posting-panel" aria-labelledby="posting-heading">
      <div className="agent-panel-heading">
        <div>
          <p className="eyebrow">06 / Posting snapshot</p>
          <h2 id="posting-heading">Captured source</h2>
        </div>
        <span className="agent-count">{formatRelativeTime(application.job.capturedAt)}</span>
      </div>
      <div className="agent-posting-facts">
        <div><span>Company</span><strong>{application.job.company}</strong></div>
        <div><span>Role</span><strong>{application.job.title}</strong></div>
        {application.job.location ? <div><span>Location</span><strong>{application.job.location}</strong></div> : null}
        {application.job.ats ? <div><span>ATS hint</span><strong>{application.job.ats}</strong></div> : null}
      </div>
      <div className="agent-posting-links">
        {application.job.sourceUrl ? <ExternalResourceLink href={application.job.sourceUrl}>Open source URL</ExternalResourceLink> : null}
        {application.job.applicationUrl ? <ExternalResourceLink href={application.job.applicationUrl}>Open application URL</ExternalResourceLink> : null}
      </div>
      <details className="agent-posting-details">
        <summary>Show normalized posting text</summary>
        <pre>{application.job.description}</pre>
      </details>
    </section>
  );
}

function EventsPanel({ events }: { events: readonly ApplicationEvent[] }) {
  return (
    <section className="agent-panel agent-events-panel" aria-labelledby="events-heading">
      <div className="agent-panel-heading">
        <div>
          <p className="eyebrow">07 / Domain events</p>
          <h2 id="events-heading">Packet history</h2>
        </div>
        <span className="agent-count">{events.length} events</span>
      </div>
      <div className="agent-event-list">
        {events.map((event) => (
          <div className="agent-event-row" key={event.id}>
            <span className="agent-event-dot" />
            <strong>{event.type.replace("application.", "").replace(/_/g, " ")}</strong>
            <span>{formatRelativeTime(event.occurredAt)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ExternalResourceLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <a className="agent-resource-link" href={href} target="_blank" rel="noreferrer">{children}<ExternalLink size={13} /></a>;
}

function AgentStatus({ status, prominent = false }: { status: Application["status"]; prominent?: boolean }) {
  return <span className={`agent-status agent-status-${status} ${prominent ? "is-prominent" : ""}`}>{statusLabel(status)}</span>;
}

function AgentFitLabel({ classification }: { classification: FitAssessment["classification"] }) {
  return <span className={`agent-fit-label agent-fit-${classification}`}>{classification}</span>;
}

function NotFoundApplication({ applicationId }: { applicationId: string }) {
  return (
    <section className="agent-panel agent-not-found">
      <p className="eyebrow">Application not found</p>
      <h2>This packet is not in the local workspace.</h2>
      <p>{applicationId}</p>
      <Link className="agent-primary-button agent-button-link" to="/application-agent">Return to Application Agent <ArrowUpRight size={15} /></Link>
    </section>
  );
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
