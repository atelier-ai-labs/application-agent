import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DepartmentAdapter } from "../src/departments/adapters";
import {
  CACHE_FRESH_MS,
  clearDepartmentCache,
  useDepartmentData,
  type AdapterRegistry,
} from "../src/hooks/useDepartmentData";
import type { DepartmentConfig } from "../src/types/department";

const config: DepartmentConfig = {
  id: "cache-test",
  name: "Cache Test",
  shortName: "TEST",
  description: "Test department",
  status: "LIVE",
  metricLabel: "Test signal",
  repositoryUrl: null,
  deploymentUrl: null,
  techStack: [],
  adapterId: "cache-test",
  dataSourceLabel: "Test API",
  capabilities: [],
};

function ResourceProbe({ registry }: { registry: AdapterRegistry }) {
  const resource = useDepartmentData(config, { registry });
  return (
    <div>
      <span data-testid="metric-state">{resource.data?.metric.state ?? "loading"}</span>
      <span data-testid="metric-value">{resource.data?.metric.value ?? "none"}</span>
      <span data-testid="error-message">{resource.errorMessage ?? "none"}</span>
    </div>
  );
}

afterEach(() => {
  clearDepartmentCache();
  vi.restoreAllMocks();
});

describe("useDepartmentData cache behavior", () => {
  it("retains a validated signal as stale after a refresh failure", async () => {
    let currentTime = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => currentTime);

    const adapter: DepartmentAdapter = {
      id: "cache-test",
      getSnapshot: vi
        .fn()
        .mockResolvedValueOnce({
          metric: {
            label: "Test signal",
            value: "verified",
            state: "live",
            source: "test API",
          },
          activities: [],
          fetchedAt: "2026-08-29T14:00:00.000Z",
        })
        .mockRejectedValueOnce(new Error("API unreachable")),
    };
    const registry: AdapterRegistry = { "cache-test": adapter };

    const firstRender = render(<ResourceProbe registry={registry} />);
    await waitFor(() => expect(screen.getByTestId("metric-state")).toHaveTextContent("live"));
    firstRender.unmount();

    currentTime += CACHE_FRESH_MS + 1;
    render(<ResourceProbe registry={registry} />);

    await waitFor(() => {
      expect(screen.getByTestId("metric-state")).toHaveTextContent("stale");
      expect(screen.getByTestId("metric-value")).toHaveTextContent("verified");
      expect(screen.getByTestId("error-message")).toHaveTextContent("API unreachable");
    });
  });
});
