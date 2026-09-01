import type { DepartmentSnapshot } from "../../types/department";
import type { DepartmentAdapter } from "./types";
import {
  apiUrl,
  isArray,
  isRecord,
  sourceFromEndpoint,
  syntheticFrom,
  timestampFrom,
  unavailableSnapshot,
} from "./utils";

const METRIC_LABEL = "Latest league leader";
const STANDINGS_PATH = "standings/latest";

interface StandingsRow {
  team_name: string;
  points: number | null;
  snapshot_date: string;
  created_at: string;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isStandingsRow(value: unknown): value is StandingsRow {
  if (!isRecord(value)) {
    return false;
  }

  return (
    nonEmptyString(value.team_name) &&
    nullableNumber(value.points) &&
    nonEmptyString(value.snapshot_date) &&
    timestampFrom(value.snapshot_date) !== undefined &&
    nonEmptyString(value.created_at) &&
    timestampFrom(value.created_at) !== undefined
  );
}

function standingsRows(payload: unknown): payload is readonly StandingsRow[] {
  return isArray(payload) && payload.every(isStandingsRow);
}

export const nhlIntelligenceAdapter: DepartmentAdapter = {
  id: "nhl-intelligence",
  async getSnapshot({ apiBaseUrl, now, requestJson }): Promise<DepartmentSnapshot> {
    if (!apiBaseUrl) {
      return unavailableSnapshot(
        METRIC_LABEL,
        "API base URL not configured",
        "NHL Dashboard API",
        now,
      );
    }

    const endpoint = apiUrl(apiBaseUrl, STANDINGS_PATH);
    const source = sourceFromEndpoint(endpoint);
    const payload = await requestJson(endpoint);

    if (!standingsRows(payload)) {
      return unavailableSnapshot(
        METRIC_LABEL,
        "Response did not match the NHL latest standings schema",
        source,
        now,
      );
    }

    if (payload.length === 0) {
      return unavailableSnapshot(METRIC_LABEL, "No current standings data", source, now);
    }

    // /standings/latest defaults to league_sequence ASC, so its first row is
    // the canonical current league leader. No standings calculation happens here.
    const leader = payload[0];
    if (leader.points === null) {
      return unavailableSnapshot(
        METRIC_LABEL,
        "Latest standings leader did not include points",
        source,
        now,
      );
    }

    const observedAt = timestampFrom(leader.snapshot_date, leader.created_at);
    const isSynthetic = syntheticFrom(leader);
    const state = isSynthetic ? "synthetic" : "live";
    const leaderValue = `${leader.team_name} · ${leader.points} pts`;

    return {
      metric: {
        label: METRIC_LABEL,
        value: leaderValue,
        state,
        observedAt,
        source,
        note: isSynthetic
          ? "The project API identified this response as synthetic."
          : "Canonical /standings/latest response; the API supplies league ordering.",
      },
      activities: [
        {
          label: "League leader",
          value: leaderValue,
          observedAt,
          state,
          source,
        },
      ],
      fetchedAt: now(),
    };
  },
};

export function isNhlResponse(payload: unknown): boolean {
  return standingsRows(payload);
}
