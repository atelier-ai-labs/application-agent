import { describe, expect, it } from "vitest";
import { parseDailyHuntMessage } from "../application-agent/src";

describe("daily hunt message intake", () => {
  it("extracts bounded explicit Apply links with nearby public metadata", () => {
    const result = parseDailyHuntMessage(`
## Daily Job Hunt

**🥇 [Northstar Cloud](https://northstar.example/?utm_source=chat) — Cloud Engineer — Remote US — $100K–$120K.**
The role uses Azure, Terraform, and CI/CD to operate production infrastructure.

[Apply directly — Northstar Cloud](https://jobs.lever.co/northstar/abc123/apply?utm_source=chat)
`);

    expect(result.skipped).toHaveLength(0);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      companyHint: "Northstar Cloud",
      titleHint: "Cloud Engineer",
      input: {
        companyHint: "Northstar Cloud",
        titleHint: "Cloud Engineer",
        sourceUrl: "https://jobs.lever.co/northstar/abc123",
        applicationUrl: "https://jobs.lever.co/northstar/abc123/apply",
      },
    });
    expect(result.candidates[0]?.input.rawText).toContain("Azure, Terraform, and CI/CD");
  });

  it("uses a job-shaped Apply link as its own source evidence when no separate posting link is present", () => {
    const result = parseDailyHuntMessage(`
**[CloudCo](https://cloudco.example/) — Platform Engineer — Remote US.**
Build internal cloud tooling with Kubernetes and observability.

[Apply — Platform Engineer](https://jobs.example.com/job/platform-engineer-1?utm_source=chat)
`);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.input.sourceUrl).toBe("https://jobs.example.com/job/platform-engineer-1");
    expect(result.candidates[0]?.input.applicationUrl).toBe("https://jobs.example.com/job/platform-engineer-1");
    expect(result.candidates[0]?.sourceLink).toBeUndefined();
  });

  it("derives the related provider posting URL from an explicit ATS Apply route", () => {
    const result = parseDailyHuntMessage(`
**Northstar Cloud — Cloud Engineer — Remote US.**
Build production cloud infrastructure with Terraform and Kubernetes.

[Apply directly](https://jobs.lever.co/northstar/abc123/apply)
`);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.input.sourceUrl).toBe("https://jobs.lever.co/northstar/abc123");
    expect(result.candidates[0]?.input.applicationUrl).toBe("https://jobs.lever.co/northstar/abc123/apply");
  });

  it("does not turn a company homepage into an application URL and keeps incomplete entries visible", () => {
    const result = parseDailyHuntMessage(`
**[Sidekick Solutions](https://sidekick.example/) — Cloud Engineer — Remote US.**
The team builds cloud infrastructure and automation.

Read the company overview at [Sidekick Solutions](https://sidekick.example/).
`);

    expect(result.candidates).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it("deduplicates links and applies a deterministic candidate bound", () => {
    const message = Array.from({ length: 3 }, (_, index) => `
**[Company ${index}](https://company-${index}.example/) — Engineer ${index} — Remote.**
Build software systems.
[Apply — Engineer ${index}](https://jobs.example.com/job/${index})
`).join("\n");
    const duplicate = `${message}\n[Apply — duplicate](https://jobs.example.com/job/1)`;
    const result = parseDailyHuntMessage(duplicate, { maxCandidates: 2 });

    expect(result.candidates).toHaveLength(2);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "Daily hunt candidate cap reached." }),
    ]));
  });

  it("rejects an invalid candidate cap instead of widening the intake", () => {
    expect(() => parseDailyHuntMessage("text", { maxCandidates: 0 })).toThrow("candidate cap");
  });
});
