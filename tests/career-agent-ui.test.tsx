import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "../src/App";
import {
  clearCareerRepositoryStorage,
  resetDefaultCareerRepository,
  getDefaultCareerRepository,
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

beforeEach(() => {
  clearCareerRepositoryStorage(window.localStorage);
  window.localStorage.removeItem("atelier.application-agent.applications.v0");
  window.localStorage.removeItem("atelier.application-agent.events.v0");
  window.localStorage.removeItem("atelier.application-agent.profile.v0");
  resetDefaultCareerRepository();
});

afterEach(() => {
  clearCareerRepositoryStorage(window.localStorage);
  window.localStorage.removeItem("atelier.application-agent.applications.v0");
  window.localStorage.removeItem("atelier.application-agent.events.v0");
  window.localStorage.removeItem("atelier.application-agent.profile.v0");
  resetDefaultCareerRepository();
});

describe("Autonomous Career Agent HQ surface", () => {
  it("provides a campaign route and runs the clearly labelled local workflow", async () => {
    renderAt("/career-agent");

    expect(screen.getByRole("heading", { name: "Autonomous Career Agent" })).toBeInTheDocument();
    expect(screen.getByText(/No persistent campaign has been created/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /Create local demo campaign/i })[0]);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Example remote engineering search" })).toBeInTheDocument();
    });
    expect(screen.getAllByText("SYNTHETIC / LOCAL").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: /Start campaign/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Start campaign/i }));
    fireEvent.click(screen.getByRole("button", { name: /Run now/i }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "What needs you" })).toBeInTheDocument();
    });
    expect(screen.getByText(/No employer was contacted/)).toBeInTheDocument();
    expect(screen.getAllByText(/EXAMPLE \/ /).length).toBeGreaterThan(0);
  });

  it("keeps the campaign route available through the Application Agent namespace", () => {
    renderAt("/application-agent/campaigns");
    expect(screen.getByRole("heading", { name: "Autonomous Career Agent" })).toBeInTheDocument();
  });

  it("exposes a distinct live campaign without presenting it as demo data", async () => {
    renderAt("/career-agent");
    fireEvent.click(screen.getAllByRole("button", { name: /Create live campaign/i })[0]);
    fireEvent.change(screen.getByLabelText("Target roles"), { target: { value: "platform engineer, frontend developer" } });
    fireEvent.change(screen.getByLabelText("Locations"), { target: { value: "United States" } });
    fireEvent.change(screen.getByLabelText("Exclude title terms"), { target: { value: "principal, director" } });
    fireEvent.click(screen.getByRole("button", { name: "Save live campaign" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Live platform engineer search" })).toBeInTheDocument();
    });
    expect(screen.getByText("LIVE SOURCE")).toBeInTheDocument();
    expect(screen.getByText("LIVE · Remotive")).toBeInTheDocument();
    expect(screen.getByText("No discovery run yet")).toBeInTheDocument();
    expect(screen.getByText(/No employer was contacted/)).toBeInTheDocument();
    const campaign = getDefaultCareerRepository().listCampaigns()[0];
    expect(campaign.searchCriteria.roleLanes).toEqual(["platform engineer", "frontend developer"]);
    expect(campaign.searchCriteria.locations).toEqual(["United States"]);
    expect(campaign.searchCriteria.excludedTitleTerms).toEqual(["principal", "director"]);
    expect(campaign.submissionPolicy.authority).toBe("never");
  });
});
