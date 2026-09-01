import { describe, expect, it } from "vitest";
import { classifyJobUrl } from "../application-agent/src";

describe("deterministic job URL classifier", () => {
  it("recognizes Lever hosted and apply paths", () => {
    expect(classifyJobUrl("https://jobs.lever.co/acme/abc-123/apply?utm_source=test")).toMatchObject({
      kind: "lever",
      siteIdentifier: "acme",
      postingIdentifier: "abc-123",
      canonicalUrl: "https://jobs.lever.co/acme/abc-123/apply",
    });
  });

  it("recognizes Greenhouse hosted job posts", () => {
    expect(classifyJobUrl("https://boards.greenhouse.io/acme/jobs/123456")).toMatchObject({
      kind: "greenhouse",
      siteIdentifier: "acme",
      postingIdentifier: "123456",
    });
    expect(classifyJobUrl("https://job-boards.greenhouse.io/acme/jobs/123456").kind).toBe("greenhouse");
  });

  it("recognizes Ashby and Workday without treating page text as evidence", () => {
    expect(classifyJobUrl("https://jobs.ashbyhq.com/acme/platform-engineer")).toMatchObject({
      kind: "ashby",
      siteIdentifier: "acme",
      postingIdentifier: "platform-engineer",
    });
    expect(classifyJobUrl("https://acme.wd5.myworkdayjobs.com/en-US/Acme/job/Platform-Engineer").kind).toBe("workday");
    expect(classifyJobUrl("https://example.com/careers/greenhouse-platform-engineer").kind).toBe("custom");
  });

  it("returns custom for valid unknown career pages and unknown for invalid URLs", () => {
    expect(classifyJobUrl("https://careers.example.com/jobs/platform-engineer")).toMatchObject({ kind: "custom" });
    expect(classifyJobUrl("javascript:alert(1)")).toMatchObject({ kind: "unknown" });
    expect(classifyJobUrl("not a URL")).toMatchObject({ kind: "unknown" });
  });

  it("does not classify arbitrary hostname/path text as a known ATS", () => {
    expect(classifyJobUrl("https://example.com/jobs/greenhouse/123").kind).toBe("custom");
    expect(classifyJobUrl("https://example.com/jobs/lever.co/acme/123").kind).toBe("custom");
    expect(classifyJobUrl("https://example.com/workday/platform-engineer").kind).toBe("custom");
  });
});
