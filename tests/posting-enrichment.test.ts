import { describe, expect, it } from "vitest";
import { enrichJobIntake, greenhousePostingRef, leverPostingRef } from "../application-agent/src/domain/postingEnrichment";
import { isCompanyInterestQuestion, postingContextForInterest } from "../application-agent/src/domain/applicationAnswerDraft";

const thin = "https://job-boards.greenhouse.io/mercury/jobs/6101145004\nFound by career-agent discover (greenhouse:mercury).";
const json = (body: unknown, ok = true) => ({ ok, json: async () => body, text: async () => JSON.stringify(body) });

describe("posting enrichment", () => {
  it("fetches a thin Greenhouse queue row's posting from the public board API", async () => {
    const urls: string[] = [];
    const enriched = await enrichJobIntake(
      { sourceUrl: "https://job-boards.greenhouse.io/mercury/jobs/6101145004", applicationUrl: "https://job-boards.greenhouse.io/mercury/jobs/6101145004", rawText: thin },
      { fetchImpl: async (url) => { urls.push(url); return json({ title: "Software Engineer - Product", location: { name: "Remote - US" }, content: "&lt;p&gt;At Mercury, we are crafting an exceptional banking experience for startups. You will build product features end to end.&lt;/p&gt;" }); } },
    );
    expect(urls).toEqual(["https://boards-api.greenhouse.io/v1/boards/mercury/jobs/6101145004"]);
    expect(enriched.rawText).toMatch(/^Software Engineer - Product\nLocation: Remote - US\n\nAt Mercury, we are crafting an exceptional banking experience/);
    expect(enriched.rawText).toContain("Queue context:\n" + thin);
  });

  it("fetches a Lever posting, and leaves the input alone on failure or when it already has the posting", async () => {
    const lever = "https://jobs.lever.co/drivetrain/29f8892c-e0fe-4bb0-a1c1-5c19be4698e9";
    const enriched = await enrichJobIntake({ sourceUrl: lever, applicationUrl: `${lever}/apply`, rawText: "link only" }, {
      fetchImpl: async (url) => {
        expect(url).toBe("https://api.lever.co/v0/postings/drivetrain/29f8892c-e0fe-4bb0-a1c1-5c19be4698e9?mode=json");
        return json({ text: "Platform Engineer", categories: { location: "Remote" }, descriptionPlain: "Drivetrain is on a mission to empower businesses to make better decisions with planning software.", lists: [{ text: "What you'll do", content: "<li>Run the platform</li>" }] });
      },
    });
    expect(enriched.rawText).toContain("Drivetrain is on a mission");
    expect(enriched.rawText).toContain("What you'll do\nRun the platform");

    const failed = await enrichJobIntake({ sourceUrl: lever, rawText: "link only" }, { fetchImpl: async () => json({}, false) });
    expect(failed.rawText).toBe("link only");
    const full = "Responsibilities\n- Build and operate our platform services in Go and Kubernetes.";
    let called = false;
    await enrichJobIntake({ sourceUrl: lever, rawText: full }, { fetchImpl: async () => { called = true; return json({}); } });
    expect(called).toBe(false);
  });

  it("recognizes posting links", () => {
    expect(greenhousePostingRef("https://boards.greenhouse.io/Arize/jobs/123?gh_src=x")).toEqual({ board: "arize", id: "123" });
    expect(greenhousePostingRef("https://job-boards.greenhouse.io/embed/job_app?for=future&token=4745515005")).toEqual({ board: "future", id: "4745515005" });
    expect(leverPostingRef("https://jobs.lever.co/drivetrain/29F8892C-e0fe-4bb0-a1c1-5c19be4698e9/apply")).toEqual({ site: "drivetrain", id: "29f8892c-e0fe-4bb0-a1c1-5c19be4698e9" });
    expect(greenhousePostingRef("https://example.com/jobs/1")).toBeUndefined();
  });
});

describe("why-us questions", () => {
  it("cover the ways forms ask it", () => {
    for (const question of ["What makes you excited about the ElevenLabs mission?", "Why Mercury?*", "What made you decide to apply?", "What interests you about Outmarket?", "Why are you interested in this role?"]) {
      expect(isCompanyInterestQuestion(question), question).toBe(true);
    }
    for (const question of ["Finally, tell us about a hard problem in your past!", "Why do you think you'd be a good fit?", "Mission Underwriting experience?", "Why not?"]) {
      expect(isCompanyInterestQuestion(question), question).toBe(false);
    }
  });

  it("read the company's intro and the role section, not benefits", () => {
    const description = [
      "About Acme", "Acme builds voice AI that makes content accessible in any language.",
      "Benefits", "Free snacks and a gym stipend.",
      "About the role", "You will build the permissions platform every team relies on.",
      "Compensation", "$150k - $200k",
    ].join("\n");
    const context = postingContextForInterest(description);
    expect(context).toContain("voice AI that makes content accessible");
    expect(context).toContain("permissions platform");
    expect(context).not.toContain("snacks");
    expect(context).not.toContain("$150k");
  });
});
