import { describe, expect, it, vi } from "vitest";
import { nhlIntelligenceAdapter } from "../src/departments/adapters/nhlIntelligence";
import { quantIntelligenceAdapter } from "../src/departments/adapters/quantIntelligence";

const now = () => "2026-08-29T14:00:00.000Z";

function quantSummary(
  experimentId: string,
  createdAt: string,
): Record<string, unknown> {
  return {
    experiment_id: experimentId,
    symbol: "SPY",
    strategy: "moving_average",
    parameters: { fast_window: 20 },
    requested_start: "2026-01-01",
    requested_end: "2026-08-28",
    actual_start: "2026-01-02",
    actual_end: "2026-08-28",
    initial_capital: 100000,
    total_return: 0.18,
    benchmark: "SPY",
    created_at: createdAt,
    package_version: "0.1.0",
  };
}

function quantDetail(
  experimentId: string,
  sharpeRatio: number | null,
): Record<string, unknown> {
  return {
    specification: {
      name: "moving_average",
      symbol: "SPY",
      signal_parameters: { fast_window: 20 },
      start: "2026-01-01",
      end: "2026-08-28",
      initial_capital: 100000,
      benchmark: "SPY",
    },
    actual_start: "2026-01-02",
    actual_end: "2026-08-28",
    states: [],
    trades: [],
    metrics: {
      total_return: 0.18,
      sharpe_ratio: sharpeRatio,
    },
    benchmark_metrics: {},
    benchmark_equity: [],
    metadata: {
      experiment_id: experimentId,
      created_at: "2026-08-29T12:00:00.000Z",
      package_version: "0.1.0",
    },
  };
}

function nhlRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    snapshot_date: "2026-08-29",
    team_abbrev: "COL",
    season_id: 20252026,
    games_played: 82,
    wins: 50,
    losses: 20,
    ot_losses: 12,
    points: 112,
    point_pctg: 0.68,
    goal_for: 250,
    goal_against: 200,
    goal_differential: 50,
    created_at: "2026-08-29T10:00:00.000Z",
    team_name: "Colorado Avalanche",
    common_name: "Avalanche",
    division: "Central",
    conference: "Western",
    ...overrides,
  };
}

describe("Quant Intelligence adapter", () => {
  it("retrieves the canonical latest experiment and normalizes its detail Sharpe", async () => {
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce([
        quantSummary("newer", "2026-08-29T12:00:00.000Z"),
        quantSummary("older", "2026-08-27T10:00:00.000Z"),
      ])
      .mockResolvedValueOnce(quantDetail("newer", 1.42));

    const snapshot = await quantIntelligenceAdapter.getSnapshot({
      apiBaseUrl: "https://quant.example.test/",
      now,
      requestJson,
    });

    expect(requestJson).toHaveBeenNthCalledWith(
      1,
      "https://quant.example.test/api/experiments",
    );
    expect(requestJson).toHaveBeenNthCalledWith(
      2,
      "https://quant.example.test/api/experiments/newer",
    );
    expect(snapshot.metric).toMatchObject({
      label: "Latest experiment Sharpe",
      value: 1.42,
      state: "live",
      observedAt: "2026-08-29T12:00:00.000Z",
      source: "quant.example.test",
    });
    expect(snapshot.activities[0]).toMatchObject({
      label: "Latest experiment",
      value: "moving_average · newer",
    });
  });

  it("uses the API's newest-first ordering rather than selecting by a local sort", async () => {
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce([
        quantSummary("canonical-first", "2026-08-29T12:00:00.000Z"),
        quantSummary("canonical-second", "2026-08-30T12:00:00.000Z"),
      ])
      .mockResolvedValueOnce(quantDetail("canonical-first", 0.91));

    await quantIntelligenceAdapter.getSnapshot({
      apiBaseUrl: "https://quant.example.test",
      now,
      requestJson,
    });

    expect(requestJson).toHaveBeenNthCalledWith(
      2,
      "https://quant.example.test/api/experiments/canonical-first",
    );
  });

  it("returns an honest unavailable state when there are no experiments", async () => {
    const snapshot = await quantIntelligenceAdapter.getSnapshot({
      apiBaseUrl: "https://quant.example.test",
      now,
      requestJson: vi.fn().mockResolvedValue([]),
    });

    expect(snapshot.metric).toMatchObject({
      label: "Latest experiment Sharpe",
      value: null,
      state: "unavailable",
      note: "No experiment found",
    });
  });

  it("degrades safely for a malformed experiment list", async () => {
    const snapshot = await quantIntelligenceAdapter.getSnapshot({
      apiBaseUrl: "https://quant.example.test",
      now,
      requestJson: vi.fn().mockResolvedValue({ experiments: [] }),
    });

    expect(snapshot.metric.state).toBe("unavailable");
    expect(snapshot.metric.value).toBeNull();
    expect(snapshot.metric.note).toContain("summary schema");
  });

  it("degrades safely when the canonical detail has no numeric Sharpe", async () => {
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce([quantSummary("no-sharpe", "2026-08-29T12:00:00.000Z")])
      .mockResolvedValueOnce(quantDetail("no-sharpe", null));

    const snapshot = await quantIntelligenceAdapter.getSnapshot({
      apiBaseUrl: "https://quant.example.test",
      now,
      requestJson,
    });

    expect(snapshot.metric.state).toBe("unavailable");
    expect(snapshot.metric.note).toContain("numeric Sharpe ratio");
  });

  it("preserves an explicit synthetic marker", async () => {
    const detail = quantDetail("synthetic-run", 2.1);
    detail.synthetic = true;
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce([quantSummary("synthetic-run", "2026-08-29T12:00:00.000Z")])
      .mockResolvedValueOnce(detail);

    const snapshot = await quantIntelligenceAdapter.getSnapshot({
      apiBaseUrl: "https://quant.example.test",
      now,
      requestJson,
    });

    expect(snapshot.metric.state).toBe("synthetic");
    expect(snapshot.metric.note).toContain("identified");
  });

  it("propagates API failures to the shared resilience layer", async () => {
    const requestJson = vi.fn().mockRejectedValue(new Error("Project API unreachable"));

    await expect(
      quantIntelligenceAdapter.getSnapshot({
        apiBaseUrl: "https://quant.example.test",
        now,
        requestJson,
      }),
    ).rejects.toThrow("Project API unreachable");
  });
});

describe("NHL Intelligence adapter", () => {
  it("normalizes the canonical latest standings leader", async () => {
    const requestJson = vi
      .fn()
      .mockResolvedValue([nhlRow(), nhlRow({ id: 2, team_name: "Dallas Stars" })]);

    const snapshot = await nhlIntelligenceAdapter.getSnapshot({
      apiBaseUrl: "https://nhl.example.test/",
      now,
      requestJson,
    });

    expect(requestJson).toHaveBeenCalledWith(
      "https://nhl.example.test/standings/latest",
    );
    expect(snapshot.metric).toMatchObject({
      label: "Latest league leader",
      value: "Colorado Avalanche · 112 pts",
      state: "live",
      observedAt: "2026-08-29",
      source: "nhl.example.test",
    });
  });

  it("returns an honest unavailable state for an empty standings snapshot", async () => {
    const snapshot = await nhlIntelligenceAdapter.getSnapshot({
      apiBaseUrl: "https://nhl.example.test",
      now,
      requestJson: vi.fn().mockResolvedValue([]),
    });

    expect(snapshot.metric).toMatchObject({
      value: null,
      state: "unavailable",
      note: "No current standings data",
    });
  });

  it("degrades safely for a malformed standings response", async () => {
    const snapshot = await nhlIntelligenceAdapter.getSnapshot({
      apiBaseUrl: "https://nhl.example.test",
      now,
      requestJson: vi.fn().mockResolvedValue({ standings: [] }),
    });

    expect(snapshot.metric.state).toBe("unavailable");
    expect(snapshot.metric.value).toBeNull();
    expect(snapshot.metric.note).toContain("latest standings schema");
  });

  it("returns unavailable when the ordered leader has no points", async () => {
    const snapshot = await nhlIntelligenceAdapter.getSnapshot({
      apiBaseUrl: "https://nhl.example.test",
      now,
      requestJson: vi.fn().mockResolvedValue([nhlRow({ points: null })]),
    });

    expect(snapshot.metric.state).toBe("unavailable");
    expect(snapshot.metric.note).toContain("did not include points");
  });

  it("propagates API failures to the shared resilience layer", async () => {
    const requestJson = vi.fn().mockRejectedValue(new Error("Project API unreachable"));

    await expect(
      nhlIntelligenceAdapter.getSnapshot({
        apiBaseUrl: "https://nhl.example.test",
        now,
        requestJson,
      }),
    ).rejects.toThrow("Project API unreachable");
  });

  it("does not request an API when its base URL is not configured", async () => {
    const requestJson = vi.fn();
    const snapshot = await nhlIntelligenceAdapter.getSnapshot({ now, requestJson });

    expect(requestJson).not.toHaveBeenCalled();
    expect(snapshot.metric.state).toBe("unavailable");
    expect(snapshot.metric.note).toBe("API base URL not configured");
  });
});
