import { describe, expect, it } from "vitest";
import {
  classifyJobUrl,
  isVerifiedAshbyApplicationUrl,
  isVerifiedAshbyHostedUrl,
  isVerifiedRipplingHostedUrl,
  isVerifiedRipplingApplicationUrl,
  isVerifiedWorkdayApplicationUrl,
  isVerifiedWorkdayHostedUrl,
  workdayPostingId,
  isVerifiedMatlenApplicationUrl,
  isVerifiedProtagonaApplicationUrl,
  isVerifiedYouHiredApplicationUrl,
  isVerifiedGustoHostedUrl,
  isVerifiedGustoApplicationUrl,
  gustoPostingId,
  matlenPostingId,
  protagonaPostingId,
  ripplingApplicationUrl,
  youHiredPostingId,
} from "../application-agent/src";

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

  it("recognizes Rippling public postings and derives their adjacent application route", () => {
    expect(classifyJobUrl("https://ats.rippling.com/fullthrottle1/jobs/posting-123?source=daily-hunt")).toMatchObject({
      kind: "rippling",
      siteIdentifier: "fullthrottle1",
      postingIdentifier: "posting-123",
      canonicalUrl: "https://ats.rippling.com/fullthrottle1/jobs/posting-123",
    });
    expect(ripplingApplicationUrl("https://ats.rippling.com/fullthrottle1/jobs/posting-123")).toBe(
      "https://ats.rippling.com/fullthrottle1/jobs/posting-123/apply",
    );
    expect(isVerifiedRipplingApplicationUrl("https://ats.rippling.com/fullthrottle1/jobs/posting-123/apply")).toBe(true);
    expect(classifyJobUrl("https://ats.rippling.com/fullthrottle1/jobs/posting-123/apply").postingIdentifier).toBe("posting-123");
    expect(classifyJobUrl("https://ats.rippling.com/en-US/fullthrottle1/jobs/posting-123/apply")).toMatchObject({
      kind: "rippling",
      siteIdentifier: "fullthrottle1",
      postingIdentifier: "posting-123",
    });
    expect(classifyJobUrl("https://ats.rippling.com/us/jobs/posting-123/apply")).toMatchObject({
      kind: "rippling",
      siteIdentifier: "us",
      postingIdentifier: "posting-123",
    });
    expect(ripplingApplicationUrl("https://ats.rippling.com/de-DE/fullthrottle1/jobs/posting-123")).toBe(
      "https://ats.rippling.com/de-DE/fullthrottle1/jobs/posting-123/apply",
    );
    expect(isVerifiedRipplingHostedUrl(
      "https://ats.rippling.com/en-US/fullthrottle1/jobs/posting-123",
      "fullthrottle1",
      "posting-123",
    )).toBe(true);
    expect(isVerifiedRipplingApplicationUrl(
      "https://ats.rippling.com/en-US/fullthrottle1/jobs/posting-123/apply",
      "fullthrottle1",
      "posting-123",
    )).toBe(true);
    expect(isVerifiedRipplingHostedUrl(
      "https://ats.rippling.com/en-US/fullthrottle1/jobs/other-posting",
      "fullthrottle1",
      "posting-123",
    )).toBe(false);
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

  it("recognizes only the bounded YouHired job route for custom execution", () => {
    const url = "https://youhired.me/job/1932919574/platform-engineer-remote?utm_source=chatgpt.com";
    expect(classifyJobUrl(url).kind).toBe("custom");
    expect(isVerifiedYouHiredApplicationUrl(url)).toBe(true);
    expect(youHiredPostingId(url)).toBe("1932919574");
    expect(isVerifiedYouHiredApplicationUrl("https://youhired.me/")).toBe(false);
    expect(isVerifiedYouHiredApplicationUrl("https://evil.example/job/1932919574/platform-engineer-remote")).toBe(false);
    expect(isVerifiedYouHiredApplicationUrl("https://youhired.me/job/not-a-number/platform-engineer-remote")).toBe(false);
  });

  it("recognizes only the bounded Matlen Silver posting/application route for custom execution", () => {
    const url = "https://matlensilver.com/job/azure-engineer-60869931/?utm_source=daily-hunt";
    expect(classifyJobUrl(url).kind).toBe("custom");
    expect(isVerifiedMatlenApplicationUrl(url)).toBe(true);
    expect(matlenPostingId(url)).toBe("60869931");
    expect(isVerifiedMatlenApplicationUrl("https://matlensilver.com/jobs/")).toBe(false);
    expect(isVerifiedMatlenApplicationUrl("https://matlensilver.com/job/azure-engineer-no-id")).toBe(false);
    expect(isVerifiedMatlenApplicationUrl("https://evil.example/job/azure-engineer-60869931")).toBe(false);
  });

  it("recognizes only the exact current Protagona ApplyToJob route for custom execution", () => {
    const url = "https://protagona.applytojob.com/apply/YDO63zlPbH/AWS-Cloud-Engineer?utm_source=daily-hunt";
    expect(classifyJobUrl(url).kind).toBe("custom");
    expect(isVerifiedProtagonaApplicationUrl(url)).toBe(true);
    expect(protagonaPostingId(url)).toBe("YDO63zlPbH");
    expect(isVerifiedProtagonaApplicationUrl("https://protagona.applytojob.com/")).toBe(false);
    expect(isVerifiedProtagonaApplicationUrl("https://protagona.applytojob.com/apply/YDO63zlPbH/Other-Role")).toBe(false);
    expect(isVerifiedProtagonaApplicationUrl("https://evil.example/apply/YDO63zlPbH/AWS-Cloud-Engineer")).toBe(false);
  });

  it("recognizes only the exact Sidekick Gusto posting and applicant form", () => {
    const posting = "https://jobs.gusto.com/postings/sidekick-solutions-llc-cloud-engineer-ac0d6b2b-36c5-4bad-a8d2-91b69546d4ad";
    const application = `${posting}/applicants/new?utm_source=daily-hunt`;

    expect(classifyJobUrl(posting).kind).toBe("custom");
    expect(isVerifiedGustoHostedUrl(posting)).toBe(true);
    expect(isVerifiedGustoApplicationUrl(application)).toBe(true);
    expect(gustoPostingId(posting)).toBe("sidekick-solutions-llc-cloud-engineer:ac0d6b2b-36c5-4bad-a8d2-91b69546d4ad");
    expect(gustoPostingId(application)).toBe("sidekick-solutions-llc-cloud-engineer:ac0d6b2b-36c5-4bad-a8d2-91b69546d4ad");
    expect(isVerifiedGustoHostedUrl(application)).toBe(false);
    expect(isVerifiedGustoApplicationUrl(posting)).toBe(false);
    expect(isVerifiedGustoApplicationUrl("https://jobs.gusto.com/postings/other-company-role-ac0d6b2b-36c5-4bad-a8d2-91b69546d4ad/applicants/new")).toBe(false);
    expect(isVerifiedGustoApplicationUrl("https://jobs.gusto.com/postings/sidekick-solutions-llc-cloud-engineer-ac0d6b2b-36c5-4bad-a8d2-91b69546d4ad/applicants/new/other")).toBe(false);
  });

  it("distinguishes a verified Ashby posting page from its application route", () => {
    const posting = "https://jobs.ashbyhq.com/Mastra/3b06208b-34fe-4dda-b409-ee3fd9305cc3";
    const application = `${posting}/application`;
    expect(isVerifiedAshbyHostedUrl(posting, "Mastra", "3b06208b-34fe-4dda-b409-ee3fd9305cc3")).toBe(true);
    expect(isVerifiedAshbyApplicationUrl(application, "Mastra", "3b06208b-34fe-4dda-b409-ee3fd9305cc3")).toBe(true);
    expect(isVerifiedAshbyHostedUrl(application, "Mastra", "3b06208b-34fe-4dda-b409-ee3fd9305cc3")).toBe(false);
    expect(isVerifiedAshbyApplicationUrl(posting, "Mastra", "3b06208b-34fe-4dda-b409-ee3fd9305cc3")).toBe(false);
    expect(isVerifiedAshbyApplicationUrl(`${posting}/application/other`, "Mastra", "3b06208b-34fe-4dda-b409-ee3fd9305cc3")).toBe(false);
  });

  it("matches Ashby organization identity case-insensitively but keeps posting UUID exact", () => {
    const postingId = "3b06208b-34fe-4dda-b409-ee3fd9305cc3";
    const posting = `https://jobs.ashbyhq.com/Mastra/${postingId}`;
    const application = `https://jobs.ashbyhq.com/mastra/${postingId}/application`;
    expect(isVerifiedAshbyHostedUrl(posting, "mastra", postingId)).toBe(true);
    expect(isVerifiedAshbyApplicationUrl(application, "MASTRA", postingId)).toBe(true);
    expect(isVerifiedAshbyApplicationUrl(application, "MASTRA", "3b06208b-34fe-4dda-b409-ee3fd9305cc4")).toBe(false);
    expect(isVerifiedAshbyHostedUrl(`https://jobs.ashbyhq.com/MASTRA/${postingId.slice(0, -1)}4`, "mastra", postingId)).toBe(false);
  });

  it("accepts only a Workday job application route, including interactive steps", () => {
    const applyUrl = "https://homedepot.wd5.myworkdayjobs.com/en-US/CareerDepot/job/TEXAS---VIRTUAL---TX01/Software-Engineer-II--REMOTE-_Req191434/apply";
    const manualUrl = `${applyUrl}/applyManually`;
    expect(isVerifiedWorkdayApplicationUrl(applyUrl, "homedepot.wd5")).toBe(true);
    expect(isVerifiedWorkdayApplicationUrl(manualUrl, "homedepot.wd5")).toBe(true);
    expect(isVerifiedWorkdayApplicationUrl(
      "https://homedepot.wd5.myworkdayjobs.com/en-US/CareerDepot/job/TEXAS---VIRTUAL---TX01/Software-Engineer-II--REMOTE-_Req191434",
      "homedepot.wd5",
    )).toBe(false);
    expect(isVerifiedWorkdayApplicationUrl(applyUrl, "other-tenant")).toBe(false);
    expect(isVerifiedWorkdayHostedUrl(applyUrl, "homedepot.wd5")).toBe(false);
    expect(isVerifiedWorkdayHostedUrl(
      "https://homedepot.wd5.myworkdayjobs.com/en-US/CareerDepot/job/TEXAS---VIRTUAL---TX01/Software-Engineer-II--REMOTE-_Req191434",
      "homedepot.wd5",
    )).toBe(true);
    expect(workdayPostingId(applyUrl)).toBe(workdayPostingId(
      "https://homedepot.wd5.myworkdayjobs.com/en-US/CareerDepot/job/TEXAS---VIRTUAL---TX01/Software-Engineer-II--REMOTE-_Req191434",
    ));
    expect(workdayPostingId("https://homedepot.wd5.myworkdayjobs.com/en-US/CareerDepot")).toBeUndefined();
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
