import { Link } from "react-router-dom";
import type { DepartmentConfig } from "../types/department";
import { useDepartmentData } from "../hooks/useDepartmentData";
import { ArrowUpRight, Database } from "./Icon";
import { DataProvenance } from "./DataProvenance";
import { DepartmentStatusPill } from "./StatusPill";
import { MetricValue } from "./MetricValue";

export function DepartmentCard({ config, index }: { config: DepartmentConfig; index: number }) {
  const resource = useDepartmentData(config);
  const metric = resource.data?.metric;

  return (
    <article className="department-card">
      <div className="card-header">
        <span className="card-index">0{index + 1}</span>
        <DepartmentStatusPill status={config.status} />
      </div>

      <div className="card-title-row">
        <div>
          <p className="eyebrow">Department</p>
          <h2>{config.name}</h2>
        </div>
        <span className="department-mark" aria-hidden="true">
          {config.shortName.slice(0, 2)}
        </span>
      </div>

      <p className="card-description">{config.description}</p>

      <div className="card-signal">
        <div className="signal-heading">
          <span className="signal-kicker">
            <Database size={14} />
            Current signal
          </span>
          {resource.status === "loading" && !metric ? <span className="loading-label">Loading</span> : null}
        </div>
        <div className="card-metric-row">
          <div>
            <p className="metric-label">{metric?.label ?? "Project signal"}</p>
            <MetricValue value={metric?.value ?? null} loading={resource.status === "loading" && !metric} />
          </div>
          <span className="metric-arrow" aria-hidden="true">
            <ArrowUpRight size={21} />
          </span>
        </div>
        {metric ? (
          <DataProvenance
            metric={metric}
            fetchedAt={resource.data?.fetchedAt}
            isRefreshing={resource.isRefreshing}
            className="card-provenance"
          />
        ) : null}
        {resource.errorMessage ? (
          <p className="data-note">{resource.errorMessage}</p>
        ) : null}
      </div>

      <div className="card-footer">
        <div className="tech-preview">
          {config.techStack.slice(0, 2).map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
        <Link className="text-link" to={`/departments/${config.id}`}>
          Open department <ArrowUpRight size={15} />
        </Link>
      </div>
    </article>
  );
}
