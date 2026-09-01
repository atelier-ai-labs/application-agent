import { DepartmentCard } from "../components/DepartmentCard";
import { Activity } from "../components/Icon";
import { departments } from "../departments/config";

export function LandingPage() {
  return (
    <div className="shell-container page-space">
      <section className="landing-hero">
        <div className="hero-copy">
          <p className="eyebrow accent-eyebrow">Atelier AI Labs / operations surface</p>
          <h1>
            A clearer view of
            <br />
            <em>what we&apos;re building.</em>
          </h1>
          <p className="hero-description">
            Atelier HQ is the front door to a small portfolio of research systems —
            their shape, their state, and the work behind them.
          </p>
        </div>

        <div className="hero-aside">
          <span className="hero-aside-label">Surface status</span>
          <span className="hero-aside-value">
            <span className="system-indicator" />
            Public / local state
          </span>
          <p>Department signals are read-only; Career Agent controls remain local until external integrations are configured.</p>
        </div>
      </section>

      <section className="section-intro" aria-labelledby="departments-heading">
        <div>
          <p className="eyebrow">01 / Portfolio</p>
          <h2 id="departments-heading">Departments</h2>
        </div>
        <p className="section-note">
          Three systems, different instruments. One quiet place to start.
        </p>
      </section>

      <section className="department-grid" aria-label="Atelier departments">
        {departments.map((department, index) => (
          <DepartmentCard key={department.id} config={department} index={index} />
        ))}
      </section>

      <section className="operating-note">
        <div className="operating-note-icon">
          <Activity size={17} />
        </div>
        <div>
          <p className="eyebrow">A note on the surface</p>
          <p>
            This is a read-only department index with a local Career Agent surface. Each project
            signal is sourced from its department API, validated at the interface edge, and marked
            when it is unavailable or stale.
          </p>
        </div>
        <span className="surface-note-label">No external side effects</span>
      </section>
    </div>
  );
}
