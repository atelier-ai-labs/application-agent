import type { JobIntakeInput } from "./types";

export const exampleJobIntake: JobIntakeInput = {
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
- Experience with observability and operational documentation

Preferred qualifications
- Terraform
- GitHub Actions
`,
};
