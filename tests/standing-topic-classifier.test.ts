import { describe, expect, it } from "vitest";
import { acceptedModelTopic, standingTopicFor } from "../application-agent/src/domain/answerBank";
import { createOllamaStandingTopicChecker, createOllamaStandingTopicClassifier } from "../application-agent/automation/answerBank/ollamaStandingTopicClassifier";
import { outcomeFor, scoreStandingTopicCase, summarize } from "../application-agent/automation/answerBank/standingTopicEval";

/** A fake Ollama: the first call answers the topic, the second the check. */
function fakeOllama(...responses: object[]) {
  const bodies: { system: string; prompt: string }[] = [];
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const next = responses[bodies.length - 1] ?? { answer: "no", asks: "" };
    return new Response(JSON.stringify({ response: JSON.stringify(next) }), { status: 200 });
  }) as typeof fetch;
  return { fetcher, bodies };
}

const yesNo = { fieldType: "radio", options: ["Yes", "No"] };

describe("standing topic from the local model (2026-11-23)", () => {
  it("counts a topic only when the second check agrees", async () => {
    const agreed = fakeOllama({ topic: "related_to_employee", confidence: 1 }, { asks: "family at the company", answer: "yes" });
    const classify = createOllamaStandingTopicClassifier({ model: "m", fetcher: agreed.fetcher });
    expect(await classify({ question: "Do any of your family members work for Acme?", ...yesNo })).toEqual({ topic: "related_to_employee", confidence: 1 });
    expect(agreed.bodies).toHaveLength(2);

    const refused = fakeOllama({ topic: "terminated", confidence: 1 }, { asks: "laid off", answer: "no" });
    const classify2 = createOllamaStandingTopicClassifier({ model: "m", fetcher: refused.fetcher });
    expect(await classify2({ question: "Have you ever been laid off?", ...yesNo })).toEqual({ topic: "none", confidence: 1 });
  });

  it("never asks the check when the model says none, and ignores a made-up topic", async () => {
    const none = fakeOllama({ topic: "none", confidence: 0.9 });
    expect(await createOllamaStandingTopicClassifier({ model: "m", fetcher: none.fetcher })({ question: "Why us?" })).toEqual({ topic: "none", confidence: 0.9 });
    expect(none.bodies).toHaveLength(1);
    const invented = fakeOllama({ topic: "favorite_color", confidence: 1 });
    expect(await createOllamaStandingTopicClassifier({ model: "m", fetcher: invented.fetcher })({ question: "x?" })).toBeUndefined();
  });

  it("gives up quietly when the model is down", async () => {
    const down = (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch;
    expect(await createOllamaStandingTopicClassifier({ model: "m", fetcher: down })({ question: "x?" })).toBeUndefined();
    expect(await createOllamaStandingTopicChecker({ model: "m", fetcher: down })("terminated", { question: "x?" })).toBe("error");
  });

  it("uses a model pick only on a Yes/No question or a text box", () => {
    const pick = { topic: "security_clearance" as const, confidence: 1 };
    expect(acceptedModelTopic({ question: "Are you cleared at the Secret level?", ...yesNo }, pick)).toBe("security_clearance");
    expect(acceptedModelTopic({ question: "Your clearance?", fieldType: "select", options: ["None", "Secret", "Top Secret"] }, pick)).toBeUndefined();
    expect(acceptedModelTopic({ question: "Are you able to obtain a clearance?", ...yesNo }, pick)).toBeUndefined();
    expect(acceptedModelTopic({ question: "Are you cleared?", ...yesNo }, { ...pick, confidence: 0.5 })).toBeUndefined();
  });

  it("no longer reads a request for accommodations as being able to do the job", () => {
    expect(standingTopicFor("Do you require any reasonable accommodations to perform the essential functions of this job?")).toBeUndefined();
    expect(standingTopicFor("Are you able to perform the essential functions of the position with or without reasonable accommodations?")).toBe("essential_functions");
    expect(standingTopicFor("Have you ever held a security clearance in the past?")).toBeUndefined();
    expect(standingTopicFor("Are you currently working toward any certifications?")).toBeUndefined();
  });

  it("scores right, asked and wrong, with the check able to overrule a rule", async () => {
    expect(outcomeFor("none", undefined)).toBe("correct");
    expect(outcomeFor("terminated", undefined)).toBe("missed");
    expect(outcomeFor("none", "terminated")).toBe("wrong");
    const result = await scoreStandingTopicCase(
      { id: "c", source: "made-up", question: "Do you currently hold an active security clearance?", expected: "security_clearance", ...yesNo },
      undefined, async () => "no");
    expect(result.outcomes).toEqual({ rules: "correct", combined: "correct", checked: "missed" });
    expect(summarize([result], "checked")).toEqual({ correct: 0, missed: 1, wrong: 0, total: 1 });
  });
});
