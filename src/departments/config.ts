import type {
  DepartmentCapability,
  DepartmentConfig,
} from "../types/department";

const NHL_DASHBOARD_API_BASE_URL =
  "https://nhl-dashboard-api.bravecoast-a5240643.westus2.azurecontainerapps.io";
const NHL_DASHBOARD_URL = "https://ashy-sky-01e4eba1e.7.azurestaticapps.net";
const NHL_REPOSITORY_URL = "https://github.com/atelier-ai-labs/nhl-intelligence";
const QUANT_REPOSITORY_URL = "https://github.com/atelier-ai-labs/quant-intelligence";
const ATELIER_HQ_REPOSITORY_URL = "https://github.com/atelier-ai-labs/atelier-hq";

function optionalUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function optionalBaseUrl(value: string | undefined): string | undefined {
  const url = optionalUrl(value);
  return url ?? undefined;
}

const readOnlyLinks: readonly DepartmentCapability[] = ["viewRepo", "openDeployment"];
const applicationAgentLinks: readonly DepartmentCapability[] = ["viewRepo", "openWorkspace"];

export const departments: readonly DepartmentConfig[] = [
  {
    id: "application-agent",
    name: "Application Agent",
    shortName: "APP",
    description:
      "A grounded application-preparation core with a persistent campaign worker for provenance-aware job search and review.",
    status: "IN DEVELOPMENT",
    metricLabel: "Ready for review",
    repositoryUrl: ATELIER_HQ_REPOSITORY_URL,
    deploymentUrl: null,
    techStack: ["React", "Local persistence", "Policy-driven workflow"],
    adapterId: "application-agent",
    dataSourceLabel: "Local Application Agent workspace",
    capabilities: applicationAgentLinks,
  },
  {
    id: "nhl-intelligence",
    name: "NHL Intelligence",
    shortName: "NHL",
    description:
      "A grounded conversational layer over structured NHL statistics, designed to make the game state easier to interrogate.",
    status: "LIVE",
    metricLabel: "Latest league leader",
    repositoryUrl: NHL_REPOSITORY_URL,
    deploymentUrl: NHL_DASHBOARD_URL,
    techStack: ["React", "NHL data API", "Google Cloud Run"],
    adapterId: "nhl-intelligence",
    dataSourceLabel: "NHL Dashboard API",
    apiBaseUrl: optionalBaseUrl(import.meta.env.VITE_NHL_API_BASE_URL) ?? NHL_DASHBOARD_API_BASE_URL,
    capabilities: readOnlyLinks,
  },
  {
    id: "quant-intelligence",
    name: "Quant Intelligence",
    shortName: "QUANT",
    description:
      "A quantitative research and backtesting platform that keeps strategy experiments tied to their provenance and reproducibility context.",
    status: "IN DEVELOPMENT",
    metricLabel: "Latest experiment Sharpe",
    repositoryUrl: QUANT_REPOSITORY_URL,
    deploymentUrl: null,
    techStack: ["Python", "Backtesting engine", "React result viewer"],
    adapterId: "quant-intelligence",
    dataSourceLabel: "Quant Intelligence API",
    apiBaseUrl: optionalBaseUrl(import.meta.env.VITE_QUANT_API_BASE_URL),
    capabilities: readOnlyLinks,
  },
];

export function getDepartment(id: string | undefined): DepartmentConfig | undefined {
  return departments.find((department) => department.id === id);
}
