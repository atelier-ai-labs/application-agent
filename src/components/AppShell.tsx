import { Link, NavLink } from "react-router-dom";
import { Layers } from "./Icon";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="shell-container site-header-inner">
          <Link className="brand" to="/" aria-label="Atelier HQ home">
            <span className="brand-mark">A</span>
            <span className="brand-copy">
              <span className="brand-name">Atelier</span>
              <span className="brand-product">HQ</span>
            </span>
          </Link>

          <nav className="primary-nav" aria-label="Primary navigation">
            <NavLink className={({ isActive }) => (isActive ? "active" : "")} to="/">
              Overview
            </NavLink>
            <NavLink className={({ isActive }) => (isActive ? "active" : "")} to="/career-agent">
              Career Agent
            </NavLink>
            <span className="nav-divider" aria-hidden="true" />
            <span className="nav-context">
              <Layers size={14} />
              Departments
            </span>
          </nav>

          <div className="header-state">
            <span className="system-indicator" />
            <span>Local state only</span>
          </div>
        </div>
      </header>

      <main>{children}</main>

      <footer className="site-footer">
        <div className="shell-container site-footer-inner">
          <span>Atelier AI Labs</span>
          <span>Portfolio operations · v0.1</span>
        </div>
      </footer>
    </div>
  );
}
