import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AppRoutes } from "../src/App";
import { clearDepartmentCache, type AdapterRegistry } from "../src/hooks/useDepartmentData";
import type { DepartmentAdapter } from "../src/departments/adapters/types";
import { DepartmentPage } from "../src/pages/DepartmentPage";

function renderAt(path: string) {
  return render(
    <MemoryRouter
      initialEntries={[path]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <AppRoutes />
    </MemoryRouter>,
  );
}

describe("Atelier HQ routes and resilient states", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("test API unavailable")));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders configured departments on the overview", async () => {
    clearDepartmentCache();
    renderAt("/");

    expect(screen.getByRole("heading", { name: "NHL Intelligence" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Quant Intelligence" })).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getAllByText("Unavailable").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("renders a deep-linked department detail page", async () => {
    clearDepartmentCache();
    renderAt("/departments/quant-intelligence");

    expect(screen.getByRole("heading", { name: "Quant Intelligence" })).toBeInTheDocument();
    expect(screen.getByText("Project profile")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("API base URL not configured")).toBeInTheDocument());
  });

  it("renders a validated live metric from an adapter", async () => {
    clearDepartmentCache();
    const liveAdapter: DepartmentAdapter = {
      id: "quant-intelligence",
      getSnapshot: async () => ({
        metric: {
          label: "Latest experiment Sharpe",
          value: 1.42,
          state: "live",
          observedAt: "2026-08-29T13:58:00.000Z",
          source: "quant.example.test",
        },
        activities: [],
        fetchedAt: "2026-08-29T14:00:00.000Z",
      }),
    };

    render(
      <MemoryRouter
        initialEntries={["/departments/quant-intelligence"]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route
            path="/departments/:departmentId"
            element={<DepartmentPage registry={{ "quant-intelligence": liveAdapter }} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("1.42")).toBeInTheDocument();
      expect(screen.getAllByText("Live").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("keeps synthetic output visibly labelled", async () => {
    clearDepartmentCache();
    const syntheticAdapter: DepartmentAdapter = {
      id: "quant-intelligence",
      getSnapshot: async () => ({
        metric: {
          label: "Latest experiment Sharpe",
          value: 1.8,
          state: "synthetic",
          source: "test API",
          note: "The project API identified this result as synthetic.",
        },
        activities: [],
        fetchedAt: "2026-08-29T14:00:00.000Z",
      }),
    };
    const registry: AdapterRegistry = { "quant-intelligence": syntheticAdapter };

    render(
      <MemoryRouter
        initialEntries={["/departments/quant-intelligence"]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route
            path="/departments/:departmentId"
            element={<DepartmentPage registry={registry} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText("SYNTHETIC DATA")).toBeInTheDocument());
  });

  it("renders a graceful unavailable state when a request fails", async () => {
    clearDepartmentCache();
    const failingAdapter: DepartmentAdapter = {
      id: "nhl-intelligence",
      getSnapshot: async () => {
        throw new Error("API unreachable");
      },
    };
    const registry: AdapterRegistry = { "nhl-intelligence": failingAdapter };

    render(
      <MemoryRouter
        initialEntries={["/departments/nhl-intelligence"]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <Routes>
          <Route
            path="/departments/:departmentId"
            element={<DepartmentPage registry={registry} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("API unreachable")).toBeInTheDocument();
      expect(screen.getAllByText("Unavailable").length).toBeGreaterThanOrEqual(1);
    });
  });
});
