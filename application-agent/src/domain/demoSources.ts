import type { CreateCampaignInput } from "./campaignTypes";
import { StaticJobSource, type JobSourceListing } from "./scout";

/**
 * Local, synthetic postings used by the acceptance surface. The `.invalid`
 * URLs and `isExample` flags are deliberate: this source never represents
 * live job discovery.
 */
export const demoJobListings: readonly JobSourceListing[] = [
  {
    sourceRecordId: "demo-cloud-001",
    input: {
      isExample: true,
      companyHint: "Example Cloud Systems",
      titleHint: "Cloud Platform Engineer",
      sourceUrl: "https://jobs.example.invalid/cloud-platform-engineer",
      applicationUrl: "https://jobs.example.invalid/cloud-platform-engineer/apply",
      rawText: `Example Cloud Systems
Cloud Platform Engineer
Location: Remote - United States
Employment type: Full-time

About the role
Build dependable platform services and developer workflows for internal product teams.

Required qualifications
- AWS
- Kubernetes
- Python

Preferred qualifications
- Terraform
`,
    },
  },
  {
    sourceRecordId: "demo-frontend-001",
    input: {
      isExample: true,
      companyHint: "Example Product Studio",
      titleHint: "Frontend Software Engineer",
      sourceUrl: "https://jobs.example.invalid/frontend-software-engineer",
      applicationUrl: "https://jobs.example.invalid/frontend-software-engineer/apply",
      rawText: `Example Product Studio
Frontend Software Engineer
Location: Remote - United States
Employment type: Full-time

Build accessible product interfaces and dependable client-side systems.

Required qualifications
- React
- TypeScript

Preferred qualifications
- API design
`,
    },
  },
  {
    sourceRecordId: "demo-weak-001",
    input: {
      isExample: true,
      companyHint: "Example Systems Group",
      titleHint: "C++ Backend Engineer",
      sourceUrl: "https://jobs.example.invalid/cpp-backend-engineer",
      applicationUrl: "https://jobs.example.invalid/cpp-backend-engineer/apply",
      rawText: `Example Systems Group
C++ Backend Engineer
Location: Remote - United States
Employment type: Full-time

Build high-throughput systems for an example data platform.

Required qualifications
- C++
- Rust
`,
    },
  },
  {
    sourceRecordId: "demo-cloud-duplicate",
    input: {
      isExample: true,
      companyHint: "Example Cloud Systems",
      titleHint: "Cloud Platform Engineer",
      sourceUrl: "https://jobs.example.invalid/cloud-platform-engineer#duplicate",
      applicationUrl: "https://jobs.example.invalid/cloud-platform-engineer/apply",
      rawText: `Example Cloud Systems
Cloud Platform Engineer
Location: Remote - United States
Employment type: Full-time

Build dependable platform services and developer workflows for internal product teams.

Required qualifications
- AWS
- Kubernetes
- Python
- Observability
`,
    },
  },
];

export const demoJobSource = new StaticJobSource("demo-local", demoJobListings);

export const demoCampaignInput: CreateCampaignInput = {
  name: "Example remote engineering search",
  goal: "Prepare and simulate review of suitable remote engineering roles.",
  searchSources: [demoJobSource.id],
  sourceConfigs: [{ type: "demo", id: demoJobSource.id }],
  searchCriteria: {
    roleLanes: ["engineer"],
    remoteOnly: true,
    employmentTypes: ["full time"],
  },
  applicationPolicy: {
    autoPrepare: true,
    allowGroundedDrafts: true,
    approvedResumeFamilies: [],
  },
  submissionPolicy: {
    authority: "simulated",
    requireExplicitApproval: false,
  },
  dailyApplicationLimit: 3,
  stopConditions: {
    stopOnAcceptedOffer: true,
    systemicFailureLimit: 3,
  },
};
