import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ArrowUpRight, Check, Database, ExternalLink, Minus } from "../components/Icon";
import { DataProvenance } from "../components/DataProvenance";
import { DepartmentStatusPill } from "../components/StatusPill";
import { MetricValue } from "../components/MetricValue";
import { useDepartmentData } from "../hooks/useDepartmentData";
import type { AdapterRegistry } from "../hooks/useDepartmentData";
import { getDepartment } from "../departments/config";
import { formatRelativeTime, stateClass, stateLabel } from "../lib/format";

function ExternalResourceLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="resource-link" href={href} target="_blank" rel="noreferrer">
      {children}
      <ExternalLink size={14} />
    </a>
  );
}

export function DepartmentPage({ registry }: { registry?: AdapterRegistry } = {}) {
  const { departmentId } = useParams();
  const config = getDepartment(departmentId);

  if (!config) {
    return <DepartmentNotFound />;
  }

  const resource = useDepartmentData(config, { registry });
  const metric = resource.data?.metric;
  const activities = resource.data?.activities ?? [];

  return (
    <div className="shell-container page-space detail-page">
      <Link className="back-link" to="/">
        <ArrowLeft size={16} /> Back to overview
      </Link>

      <section className="detail-hero">
        <div className="detail-hero-copy">
          <div className="detail-kicker">
            <span className="detail-code">{config.shortName}</span>
            <DepartmentStatusPill status={config.status} />
          </div>
          <h1>{config.name}</h1>
          <p>{config.description}</p>
        </div>
        <div className="detail-actions">
          {config.deploymentUrl ? (
            <ExternalResourceLink href={config.deploymentUrl}>
              Open live interface <ArrowUpRight size={15} />
            </ExternalResourceLink>
          ) : null}
          {config.repositoryUrl ? (
            <ExternalResourceLink href={config.repositoryUrl}>View repository</ExternalResourceLink>
          ) : null}
          {config.id === "application-agent" ? (
            <Link className="resource-link" to="/career-agent">
              Open Career Agent <ArrowUpRight size={15} />
            </Link>
          ) : null}
          {!config.deploymentUrl && !config.repositoryUrl ? (
            <span className="no-link-note">Public project links not configured</span>
          ) : null}
        </div>
      </section>

      <div className="detail-grid">
        <section className="detail-signal-panel panel" aria-labelledby="current-signal-heading">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Current signal</p>
              <h2 id="current-signal-heading">{metric?.label ?? "Project signal"}</h2>
            </div>
            <Database size={19} />
          </div>

          <div className="detail-metric-value">
            <MetricValue value={metric?.value ?? null} loading={resource.status === "loading" && !metric} />
          </div>

          {metric ? (
            <DataProvenance
              metric={metric}
              fetchedAt={resource.data?.fetchedAt}
              isRefreshing={resource.isRefreshing}
              className="detail-provenance"
            />
          ) : null}

          <div className={`signal-explanation ${metric ? stateClass(metric.state) : ""}`}>
            {metric?.state === "synthetic" ? <strong>SYNTHETIC DATA</strong> : null}
            <p>
              {resource.errorMessage
                ? defaultSignalNote(metric?.state, resource.errorMessage)
                : metric?.note ?? defaultSignalNote(metric?.state, null)}
            </p>
          </div>
        </section>

        <aside className="detail-facts panel" aria-labelledby="project-facts-heading">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Project profile</p>
              <h2 id="project-facts-heading">At a glance</h2>
            </div>
          </div>
          <dl className="facts-list">
            <div>
              <dt>Project status</dt>
              <dd>
                <DepartmentStatusPill status={config.status} />
              </dd>
            </div>
            <div>
              <dt>Data source</dt>
              <dd>{config.dataSourceLabel}</dd>
            </div>
            <div>
              <dt>Adapter</dt>
              <dd className="mono-text">{config.adapterId}</dd>
            </div>
          </dl>
        </aside>
      </div>

      <section className="detail-lower-grid">
        <div className="detail-section">
          <div className="section-heading-row">
            <div>
              <p className="eyebrow">02 / Context</p>
              <h2>Technology</h2>
            </div>
            <span className="section-count">{config.techStack.length} elements</span>
          </div>
          <div className="stack-list">
            {config.techStack.map((item) => (
              <div className="stack-item" key={item}>
                <Check size={14} />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="detail-section activity-section">
          <div className="section-heading-row">
            <div>
              <p className="eyebrow">03 / Recent activity</p>
              <h2>What moved last</h2>
            </div>
          </div>
          {activities.length > 0 ? (
            <div className="activity-list">
              {activities.map((activity) => (
                <div className="activity-item" key={`${activity.label}-${activity.value}`}>
                  <div>
                    <span className="activity-label">{activity.label}</span>
                    <strong>{activity.value}</strong>
                  </div>
                  <span className="activity-time">
                    {activity.observedAt ? formatRelativeTime(activity.observedAt) : "Timestamp not supplied"}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-activity">
              <Minus size={15} />
              <p>No recent activity is exposed by this project API.</p>
            </div>
          )}
        </div>
      </section>

      <section className="detail-source-note">
        <div>
          <p className="eyebrow">Data boundary</p>
          <p>
            Atelier HQ reads known read-only paths on this department’s configured project API. It
            does not write to, control, or embed the underlying project.
          </p>
        </div>
        <span className="boundary-status">
          <span className="system-indicator" />
          {metric ? stateLabel(metric.state) : "Loading"}
        </span>
      </section>
    </div>
  );
}

function defaultSignalNote(
  state: string | undefined,
  errorMessage: string | null,
): string {
  if (state === "live") {
    return "Validated response from the configured project API.";
  }

  if (state === "stale") {
    return errorMessage
      ? `Refresh unavailable: ${errorMessage}. The last validated response is being shown.`
      : "The last validated response is being shown while a fresher request is unavailable.";
  }

  if (state === "unavailable") {
    return errorMessage ?? "No current data is available.";
  }

  if (state === "synthetic") {
    return "The project API explicitly identified this result as synthetic.";
  }

  return "Waiting for the configured project API.";
}

function DepartmentNotFound() {
  return (
    <div className="shell-container page-space not-found-page">
      <p className="eyebrow">404 / Department not found</p>
      <h1>This department is not registered.</h1>
      <Link className="text-link" to="/">
        Return to overview <ArrowUpRight size={15} />
      </Link>
    </div>
  );
}
