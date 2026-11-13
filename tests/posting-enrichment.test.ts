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

    // Mercury's pay range uses &mdash;, which hid the top of the range.
    const pay = await enrichJobIntake({ sourceUrl: "https://job-boards.greenhouse.io/mercury/jobs/6101145004", rawText: thin }, {
      fetchImpl: async () => json({ title: "Engineer", content: "&lt;p&gt;Build product features for startups end to end, with care.&lt;/p&gt;&lt;p&gt;US employees: $122,400 &amp;mdash; $158,400 USD&lt;/p&gt;" }),
    });
    expect(pay.rawText).toContain("$122,400 — $158,400 USD");
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

  it("reads an Ashby queue row's workplace type from the job board, not the row's own note", async () => {
    // Pinecone (2026-11-12): the row said "New York City (Remote)", its title has
    // the word "Experience", so the posting was never fetched; the job is Hybrid.
    const row = "Full-Stack Software Engineer, Experience at Pinecone\nhttps://jobs.ashbyhq.com/pinecone/08760530-e6c3-4167-9272-923d85a2388d/application\nLocation: New York City (Remote)\nResume Version: frontend-software\nPriority: Low\nFit: Stretch\nFound by career-agent discover (ashby:pinecone).";
    const urls: string[] = [];
    const enriched = await enrichJobIntake({ sourceUrl: "https://jobs.ashbyhq.com/pinecone/08760530-e6c3-4167-9272-923d85a2388d", rawText: row }, {
      fetchImpl: async (url) => {
        urls.push(url);
        return json({ jobs: [{ id: "08760530-e6c3-4167-9272-923d85a2388d", title: "Full-Stack Software Engineer, Experience", location: "New York City", secondaryLocations: [], workplaceType: "Hybrid", isRemote: true,
          descriptionPlain: "Pinecone is the leading vector database. You will build the product experience customers use every day." }] });
      },
    });
    expect(urls).toEqual(["https://api.ashbyhq.com/posting-api/job-board/pinecone"]);
    expect(enriched.rawText).toMatch(/^Full-Stack Software Engineer, Experience\nLocation: New York City \(Hybrid\)/);
    expect(enriched.rawText).toContain("Queue context:");
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

  it("skip an opening story that comes before the company talks about itself", () => {
    const mercury = "Since the dawn of aviation, pilots have faced air resistance. The trim tab simplifies flight.\nAt Mercury, we are committed to an exceptional banking experience for startups.\nAbout the role\nBuild product features.";
    const context = postingContextForInterest(mercury, 2_400, "Mercury");
    expect(context.startsWith("At Mercury, we are committed")).toBe(true);
    expect(context).not.toContain("trim tab");
    // A posting that opens by naming itself keeps its opening.
    expect(postingContextForInterest("ElevenLabs builds AI voice models.\nElevenAgents runs voice agents.", 2_400, "ElevenLabs")).toContain("ElevenAgents runs voice agents");
  });
});
