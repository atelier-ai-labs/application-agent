import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BrowserExecutionControls } from "../application-agent/src/ui/CareerAgentPage";
import type { CareerJob } from "../application-agent/src/domain/campaignTypes";

function controls(sourceId: string, actionability = "actionable") {
  // Only the fields read by these presentation controls; host trust is tested
  // separately with complete validated packets in execution-host.test.ts.
  const job = {
    id: "job", campaignId: "campaign", applicationId: "application",
    sourceId, actionability,
    job: { applicationUrl: "https://job-boards.greenhouse.io/example/jobs/123" },
  } as CareerJob;
  const start = vi.fn();
  render(<BrowserExecutionControls job={job} busy={false} onStartExecution={start}
    onResumeExecution={vi.fn()} onCancelExecution={vi.fn()} />);
  return start;
}

describe("Browser preparation controls", () => {
  it("offers direct Greenhouse preparation without requiring destination-resolution metadata", () => {
    const start = controls("greenhouse:example");
    fireEvent.click(screen.getByRole("button", { name: "Prepare in browser" }));
    expect(start).toHaveBeenCalledWith("campaign", "job");
  });

  it("does not offer preparation for discovery-only Greenhouse postings", () => {
    controls("greenhouse:example", "discovery_only");
    expect(screen.queryByRole("button", { name: "Prepare in browser" })).not.toBeInTheDocument();
  });

  it("does not offer preparation just because an unknown source carries a URL", () => {
    controls("unknown");
    expect(screen.queryByRole("button", { name: "Prepare in browser" })).not.toBeInTheDocument();
  });
});
