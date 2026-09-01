import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "../src/App";
import {
  DEFAULT_ANSWER_POLICIES,
  ApplicationService,
  LocalStorageApplicationRepository,
  clearRepositoryStorage,
  exampleCandidateProfile,
  exampleJobIntake,
  resetDefaultApplicationRepository,
  saveCandidateProfile,
  type CandidateProfile,
} from "../application-agent/src";

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

function readyProfile(): CandidateProfile {
  const profile = JSON.parse(JSON.stringify(exampleCandidateProfile)) as CandidateProfile;
  profile.profileKind = "private";
  profile.answerPolicies = Object.fromEntries(
    Object.keys(DEFAULT_ANSWER_POLICIES).map((field) => [field, "auto"]),
  ) as CandidateProfile["answerPolicies"];
  profile.approvedReusableAnswers = Object.fromEntries(
    Object.keys(DEFAULT_ANSWER_POLICIES).map((field) => [field, `Approved answer for ${field}`]),
  );
  return profile;
}

beforeEach(() => {
  clearRepositoryStorage(window.localStorage);
  window.localStorage.removeItem("atelier.application-agent.profile.v0");
  resetDefaultApplicationRepository();
});

afterEach(() => {
  clearRepositoryStorage(window.localStorage);
  window.localStorage.removeItem("atelier.application-agent.profile.v0");
  resetDefaultApplicationRepository();
});

describe("Application Agent HQ surface", () => {
  it("routes the first-class department entry to the pasted-posting workspace", () => {
    renderAt("/departments/application-agent");

    expect(screen.getByRole("heading", { name: "Application Agent" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Start with the posting" })).toBeInTheDocument();
    expect(screen.getByText(/V0 does not scrape them/)).toBeInTheDocument();
  });

  it("runs the example workflow and visibly stops at human-required review", async () => {
    renderAt("/application-agent");

    fireEvent.click(screen.getByRole("button", { name: /Load example workflow/i }));
    expect((screen.getByLabelText(/Job posting text/i) as HTMLTextAreaElement).value)
      .toContain("Example Cloud Systems");
    fireEvent.click(screen.getByRole("button", { name: /Normalize and prepare/i }));

    await waitFor(() => {
      expect(screen.getByText("What still needs you")).toBeInTheDocument();
    });
    expect(screen.getByText("EXAMPLE WORKFLOW")).toBeInTheDocument();
    expect(screen.getAllByText("Expected compensation").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("MANUAL ONLY")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /submit application/i })).not.toBeInTheDocument();
  });

  it("renders a persisted ready-for-review deep link with the submission boundary", async () => {
    const profile = readyProfile();
    saveCandidateProfile(profile, window.localStorage);
    const repository = new LocalStorageApplicationRepository(window.localStorage);
    const service = new ApplicationService(repository, profile, undefined, {
      now: () => "2026-08-30T12:00:00.000Z",
      createId: (() => {
        let sequence = 0;
        return (prefix: string) => `${prefix}-ui-test-${++sequence}`;
      })(),
    });
    const application = await service.prepareFromIntake({ ...exampleJobIntake, isExample: false });

    renderAt(`/application-agent/${application.id}`);

    await waitFor(() => {
      expect(screen.getByText("No application is sent from here.")).toBeInTheDocument();
    });
    expect(screen.getAllByText("ready for review").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("0 open")).not.toBeInTheDocument();
    expect(screen.getAllByText(/submit manually/i).length).toBeGreaterThanOrEqual(1);
  });
});
