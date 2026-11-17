import { describe, expect, it } from "vitest";
import { requiredExcludedLanguages } from "../application-agent/src/domain/requiredLanguages";
import { applyHardFilters } from "../application-agent/src/domain/policies";
import { screenDiscoveredJob } from "../application-agent/src/domain/discoveryFilter";
import { normalizeJobSearchIntent, searchCriteriaFromJobSearchIntent } from "../application-agent/src/domain/searchIntent";
import { standingTopicFor, STANDING_TOPICS } from "../application-agent/src/domain/answerBank";
import { isYesNoQuestion, quickRepliesForEvent } from "../application-agent/automation/slack/slackNotificationAdapter";
import type { AttentionEvent } from "../application-agent/src/domain/attention";

const figma = [
  "The team owns a large Ruby application that powers Figma’s REST APIs, asynchronous jobs, and workflow orchestration.",
  "We’re looking for an experienced backend engineer with meaningful production Ruby experience who enjoys building for other engineers.",
  "You don’t need to be a Ruby language specialist, but you should be comfortable reading it.",
].join("\n");

describe("excluded languages (Figma / Ruby, 2026-11-17)", () => {
  it("finds a required language and ignores mentions, nice-to-haves and alternatives", () => {
    expect(requiredExcludedLanguages("Software Engineer - Application Platform", figma, ["Ruby"])).toEqual(["Ruby"]);
    expect(requiredExcludedLanguages("Backend Engineer", "The team owns a large Ruby application.", ["Ruby"])).toEqual([]);
    expect(requiredExcludedLanguages("Engineer", "Experience with Ruby on Rails is a plus.", ["Ruby"])).toEqual([]);
    expect(requiredExcludedLanguages("Engineer", "2+ years of programming experience with full stack technologies such Java, Kotlin, Python or TypeScript.", ["Java"])).toEqual([]);
    expect(requiredExcludedLanguages("Engineer", "Strong experience with Rails and PostgreSQL.", ["Ruby"])).toEqual(["Ruby"]);
    expect(requiredExcludedLanguages("Senior Ruby Engineer", "", ["Ruby"])).toEqual(["Ruby"]);
    expect(requiredExcludedLanguages("Engineer", "Proficiency in Rubymine shortcuts.", ["Ruby"])).toEqual([]);
    expect(requiredExcludedLanguages("Engineer", figma, [])).toEqual([]);
  });

  it("is read from the search settings and applied at discovery and before applying", () => {
    const intent = normalizeJobSearchIntent({
      primaryLanes: ["Software Engineer"], adjacentLanes: [], secondaryLanes: [], preferredSeniorities: [], excludedSeniorities: [],
      excludedTitleTerms: [], locations: ["United States"], remotePreference: "remote_preferred", breadth: "balanced",
      excludedLanguages: ["Ruby"],
    });
    const posting = (description: string) => ({ title: "Software Engineer", company: "Figma", description, location: "Remote - US", remoteStatus: "remote", employmentType: "full time", requiredSkills: [], preferredSkills: [] }) as never;
    expect(screenDiscoveredJob(posting(figma), intent)).toEqual({ keep: false, reason: "language" });
    const criteria = searchCriteriaFromJobSearchIntent(intent);
    expect(applyHardFilters(posting(figma), criteria)).toMatchObject({ decision: "reject", reason: "Posting requires Ruby, which the search excludes." });
    expect(applyHardFilters(posting("Build TypeScript services."), criteria).decision).not.toBe("reject");
  });
});

describe("yes/no typed questions (Smartsheet, 2026-11-17)", () => {
  const event = (prompt: string, extra: Partial<AttentionEvent> = {}): AttentionEvent => ({
    id: "a", type: "needs_input", source: "career-agent", campaignId: "c", applicationId: "x", createdAt: "2026-11-17T00:00:00.000Z",
    status: "open", title: "t", context: { company: "Smartsheet", role: "Software Engineer I" }, questionProvenance: "ATS_FORM",
    question: { prompt, kind: "free_text", options: [], required: true }, blockerType: "subjective_answer", ...extra,
  });

  it("offers Yes and No buttons on a plain yes/no question only", () => {
    expect(isYesNoQuestion("Do you know anyone who works at Smartsheet?*")).toBe(true);
    expect(isYesNoQuestion("Are you willing to relocate?")).toBe(true);
    expect(isYesNoQuestion("Do you prefer frontend or backend work?")).toBe(false);
    expect(isYesNoQuestion("Why do you want to join Smartsheet?")).toBe(false);
    expect(quickRepliesForEvent(event("Do you know anyone who works at Smartsheet?*"))).toEqual(["YES", "NO"]);
    expect(quickRepliesForEvent(event("Why do you want to join Smartsheet?"))).toEqual([]);
  });

  it("remembers 'do you know anyone here' as a standing answer for every company", () => {
    expect(standingTopicFor("Do you know anyone who works at Smartsheet?*", "Smartsheet")).toBe("knows_employee");
    expect(standingTopicFor("Do you know anyone currently working at Twilio?", "Twilio")).toBe("knows_employee");
    expect(standingTopicFor("Do you know someone at Twilio who referred you?", "Twilio")).toBeUndefined();
    const topic = STANDING_TOPICS.find((candidate) => candidate.id === "knows_employee")!;
    expect(topic.asText?.("No", "Twilio")).toBe("No, I don't know anyone at Twilio.");
  });
});
