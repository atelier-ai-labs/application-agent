import { describe, expect, it } from "vitest";
import { exampleCandidateProfile, type CandidateProfile } from "../application-agent/src";
import { assessFit } from "../application-agent/src/domain/fit";
import { normalizeJobPosting } from "../application-agent/src/domain/job";

const at = "2026-11-09T18:00:00.000Z";
// Nate's three résumés and their keywords.
const profile = {
  ...JSON.parse(JSON.stringify(exampleCandidateProfile)),
} as CandidateProfile;
(profile as { resumeFamilies: unknown }).resumeFamilies = [
  { ...exampleCandidateProfile.resumeFamilies.find((f) => f.id === "cloud-platform")!, focusKeywords: ["AWS", "Azure", "Docker", "Terraform", "CI/CD", "DevOps", "cloud"] },
  { ...exampleCandidateProfile.resumeFamilies.find((f) => f.id === "frontend-software")!, focusKeywords: ["Frontend: React", "JavaScript", "TypeScript", "responsive UI development", "HTML", "CSS", "React"] },
  { ...exampleCandidateProfile.resumeFamilies.find((f) => f.id === "ai-platform-agentic")!, focusKeywords: [] },
];
const family = (title: string, body: string) =>
  assessFit(normalizeJobPosting({ titleHint: title, companyHint: "Acme", sourceUrl: "https://x.test/1", applicationUrl: "https://x.test/1", rawText: `Acme\n${title}\nLocation: Remote - United States\n\n${body}` }, at), profile).recommendedResumeFamily;

describe("résumé choice reads the kind of engineer the posting asks for", () => {
  it("sends a backend or full-stack product role to the backend-leaning résumé, not frontend (Mercury)", () => {
    expect(family("Software Engineer - Product", "Our product engineering group is hiring backend and full-stack engineers.\nThe ideal candidate has 1-4 years of backend or full-stack development experience, with knowledge of Haskell, React, TypeScript, and Redux."))
      .toBe("cloud-platform");
  });

  it("keeps frontend roles on the frontend résumé", () => {
    expect(family("Software Engineer", "You will build our frontend in React and TypeScript, own the design system and polish the UI.")).toBe("frontend-software");
    expect(family("Frontend Engineer", "Backend experience is a plus. React and TypeScript.")).toBe("frontend-software");
  });

  it("keeps AI titles on the AI résumé even when the body says backend", () => {
    expect(family("Backend Engineer, AI (Agent Systems)", "Build backend services for LLM agents. Backend, distributed systems, Python.")).toBe("ai-platform-agentic");
  });
});
