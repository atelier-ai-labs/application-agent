import { describe, expect, it } from "vitest";
import { overallScore, scoreEssay } from "../application-agent/automation/answerDraft/essayEval";

const elevenlabs = {
  id: "elevenlabs-mission", company: "Elevenlabs", title: "Full-Stack Engineer",
  question: "What makes you excited about the ElevenLabs mission?",
  posting: "ElevenLabs builds AI voice models. ElevenAgents lets teams deploy tool-using AI agents for support and sales.",
};
const evidence = JSON.stringify({ projects: ["PuckPulse: FastAPI on Azure Container Apps, AI chat with a Gemini to Groq fallback"], skills: ["Python", "TypeScript", "React"] });

describe("essay eval scoring", () => {
  it("flags the real ElevenLabs draft from 2026-11-10: filler and a claim not in the evidence", () => {
    const draft = "I'm excited about ElevenLabs' mission because I've built backend APIs and containerized services with FastAPI and Azure Container Apps, similar to the tool-using AI agents they emphasize. PuckPulse, my solo project, integrates these technologies with Kubernetes to create a robust analytics platform, aligning closely with ElevenLabs' focus on cloud infrastructure and automation.";
    const score = scoreEssay(elevenlabs, draft, evidence);
    const failed = Object.fromEntries(score.checks.filter((check) => !check.passed).map((check) => [check.name, check.detail]));
    expect(failed.no_filler).toContain("robust");
    expect(failed.grounded).toBe("not in your evidence: kubernetes");
    expect(score.checks.find((check) => check.name === "names_company")?.passed).toBe(true);
    expect(score.score).toBeLessThan(1);
  });

  it("passes a grounded, specific draft, and scores a missing draft zero", () => {
    const good = "What pulls me to ElevenLabs is the idea that a voice can carry anything, in any language. In PuckPulse, my NHL research app, I built an AI chat that answers questions from the app's data and switches to a second model provider when the first is down. That taught me the model is the easy part; the platform under it is the hard part: speed, fallbacks, and knowing when it got something wrong. Doing that work for voice, where a slow answer is heard right away, is what excites me.";
    expect(scoreEssay(elevenlabs, good, evidence).score).toBe(1);
    expect(scoreEssay(elevenlabs, undefined, evidence)).toMatchObject({ score: 0, checks: [{ name: "drafted", passed: false }] });
    expect(overallScore([{ id: "a", score: 1, checks: [] }, { id: "b", score: 0.5, checks: [] }])).toBe(0.75);
  });

  it("holds a stated word limit, and doesn't count the company's own name as a technology", () => {
    const temporal = { id: "temporal", company: "Temporal", title: "Engineer", question: "We know resumes only tell part of the story. Choose one to share with us (150 words max)", maxWords: 150, posting: "Temporal builds durable execution." };
    const long = Array.from({ length: 160 }, () => "word").join(" ");
    expect(scoreEssay(temporal, long, evidence).checks.find((check) => check.name === "length")).toMatchObject({ passed: false, detail: "160 words (40–150)" });
    const mentionsCompany = "I want to work on Temporal because durable workflows are the problem I keep running into in my own projects. In PuckPulse I rebuilt the nightly ingest so a failed step resumes instead of starting over, and I would like to work where that reliability is the product itself, for teams who depend on it daily.";
    expect(scoreEssay(temporal, mentionsCompany, evidence).checks.find((check) => check.name === "grounded")?.passed).toBe(true);
  });
});
