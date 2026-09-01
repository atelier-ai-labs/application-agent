import type { DepartmentSnapshot } from "../../types/department";
import { getDefaultApplicationRepository } from "../../../application-agent/src/persistence/applicationRepository";
import type { DepartmentAdapter } from "./types";

const METRIC_LABEL = "Ready for review";
const SOURCE = "Local application workspace";

export const applicationAgentAdapter: DepartmentAdapter = {
  id: "application-agent",
  async getSnapshot({ now }): Promise<DepartmentSnapshot> {
    const applications = getDefaultApplicationRepository().listApplications();
    const ready = applications.filter((application) => application.status === "ready_for_review");
    const latest = [...applications].sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    )[0];

    return {
      metric: {
        label: METRIC_LABEL,
        value: ready.length,
        state: "live",
        source: SOURCE,
        note: `${applications.length} application${applications.length === 1 ? "" : "s"} persisted in this browser.`,
      },
      activities: latest
        ? [
            {
              label: "Latest application",
              value: `${latest.job.company} · ${latest.job.title}`,
              state: "live",
              observedAt: latest.updatedAt,
              source: SOURCE,
            },
          ]
        : [],
      fetchedAt: now(),
    };
  },
};
