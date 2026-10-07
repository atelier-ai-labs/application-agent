import { describe, expect, it } from "vitest";
import { enrichAshbyJobIntake } from "../application-agent/src/domain/ashbyJobSource";

describe("Ashby sparse queue enrichment", () => {
  it("uses the public posting description before fit selection", async () => {
    const input = {
      companyHint: "GC AI",
      titleHint: "Member of Technical Staff, Platform Engineering",
      sourceUrl: "https://jobs.ashbyhq.com/gc-ai/posting-id",
      applicationUrl: "https://jobs.ashbyhq.com/gc-ai/posting-id/application",
      rawText: "Member of Technical Staff, Platform Engineering at GC AI\nhttps://jobs.ashbyhq.com/gc-ai/posting-id",
    };
    const enriched = await enrichAshbyJobIntake(input, {
      fetchImpl: async () => ({
        ok: true,
        text: async () => '<script>window.__INITIAL_STATE__={"posting":{"descriptionHtml":"<p>Build the platform with Terraform and observability.</p><p>Required qualifications include GCP and CI/CD.</p>"}};</script>',
      }),
    });

    expect(enriched.rawText).toContain("Build the platform with Terraform and observability.");
    expect(enriched.rawText).toContain("Required qualifications include GCP and CI/CD.");
    expect(enriched.rawText).toContain("Queue context:");
  });

  it("does not replace a queue row that already contains posting prose", async () => {
    const input = {
      sourceUrl: "https://jobs.ashbyhq.com/example/posting-id",
      rawText: "Example Co\nPlatform Engineer\n\nBuild reliable infrastructure.\n\nRequired qualifications\n- Terraform\n- Kubernetes",
    };
    let fetchCalled = false;
    const enriched = await enrichAshbyJobIntake(input, {
      fetchImpl: async () => {
        fetchCalled = true;
        return { ok: true, text: async () => "<p>Replacement</p>" };
      },
    });

    expect(fetchCalled).toBe(false);
    expect(enriched).toEqual(input);
  });
});
