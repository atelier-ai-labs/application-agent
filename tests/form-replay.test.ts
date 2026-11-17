import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exampleCandidateProfile, type CandidateProfile } from "../application-agent/src";
import type { LeverBrowserField, LeverBrowserSession } from "../application-agent/src/domain/executor";
import { answerBankKey, type AnswerBankEntry } from "../application-agent/src/domain/answerBank";
import { FormSnapshotStore, recordingSessionFactory, type FormSnapshot } from "../application-agent/automation/formSnapshots/formSnapshot";
import { compareReplays, replayForm, replayTotals } from "../application-agent/automation/formSnapshots/formReplay";

const options = (labels: string[]) => labels.map((label) => ({ label, value: label }));

const phantom: FormSnapshot = {
  version: 1, applicationId: "application-phantom", url: "https://jobs.ashbyhq.com/phantom/f4fcc35e-bdc0-498b-a5f0-ac553d146531/application",
  capturedAt: "2026-11-03T22:36:00.000Z", company: "Phantom", role: "AI Engineer",
  fields: [
    { id: "_systemfield_name", label: "Name", type: "text", required: true, classification: "unknown" },
    { id: "_systemfield_email", label: "Email", type: "email", required: true, classification: "unknown" },
    { id: "region", label: "We currently support remote work from North America, South America, and Europe. Which of these three locations will you be working from?", type: "radio", required: true, classification: "unknown", options: options(["North America", "South America", "Europe", "Other"]) },
    { id: "work-location", label: "Anticipated Work Location (City, Country)", type: "text", required: true, classification: "unknown" },
    { id: "pets", label: "What is the name of your first pet?", type: "text", required: true, classification: "unknown" },
    { id: "favorite", label: "Which ice cream flavor do you prefer?", type: "select", required: true, classification: "unknown", options: options(["Vanilla", "Chocolate"]) },
  ],
};

const profile: CandidateProfile = { ...exampleCandidateProfile, identity: { ...exampleCandidateProfile.identity, location: "McDonald, Pennsylvania, USA" } };

describe("form replay", () => {
  it("replays a saved form through the real executor without a browser", async () => {
    const bank: AnswerBankEntry[] = [{ id: "e", key: answerBankKey("Which ice cream flavor do you prefer?"), question: "Which ice cream flavor do you prefer?", value: "Chocolate", tier: "low", source: "manual", recordedAt: "2026-11-01T00:00:00.000Z" }];
    const replay = await replayForm(phantom, { profile, answerBank: bank, now: "2026-11-04T00:00:00.000Z" });
    const outcome = Object.fromEntries(replay.fields.map((field) => [field.id, field.outcome]));
    expect(outcome).toMatchObject({ _systemfield_name: "filled", _systemfield_email: "filled", region: "filled", "work-location": "filled", pets: "asked" });
    // A medium-risk question (unclassified) is reused only with an exact key, which this is.
    expect(outcome.favorite).toBe("bank");
    expect(replayTotals([replay])).toMatchObject({ forms: 1, fields: 6, asked: 1, bank: 1, errors: 0 });
    expect(JSON.stringify(replay)).not.toContain("McDonald");
  });

  it("reports regressions, improvements, and changed answers against a baseline", () => {
    const form = (outcomes: Record<string, "filled" | "asked" | "bank" | "blank">, hash = "a") => ({
      key: "k", company: "Phantom", role: "AI Engineer", url: "u", state: "requires_human" as const,
      fields: Object.entries(outcomes).map(([id, outcome]) => ({ id, label: id, required: true, outcome, ...(outcome === "filled" ? { valueHash: hash } : {}) })),
    });
    const changes = compareReplays([form({ a: "filled", b: "asked", c: "filled" })], [form({ a: "asked", b: "filled", c: "filled" }, "b")]);
    expect(changes.map((change) => [change.field, change.kind])).toEqual([["a", "worse"], ["b", "better"], ["c", "changed"]]);
  });

  it("saves the first form read in each live session and passes everything through", async () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-form-snapshots-"));
    try {
      let reads = 0;
      const field = { id: "q1", label: "Question", type: "text", required: true, classification: "unknown", value: "secret", fill: async () => undefined } as unknown as LeverBrowserField;
      const inner = { open: async () => ({
        navigate: async () => undefined,
        currentUrl: () => "https://jobs.lever.co/acme/1/apply",
        inspectFields: async () => { reads += 1; return [field]; },
        verifyPageIdentity: async () => true,
      } as unknown as LeverBrowserSession) };
      const store = new FormSnapshotStore(directory);
      const session = await recordingSessionFactory(inner, store, () => "2026-11-04T00:00:00.000Z").open("application-1");
      await session.navigate("https://jobs.lever.co/acme/1/apply");
      await session.verifyPageIdentity?.("Acme", "Platform Engineer");
      expect(await session.inspectFields()).toEqual([field]);
      await session.inspectFields();
      expect(reads).toBe(2);
      const saved = store.list();
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ applicationId: "application-1", company: "Acme", role: "Platform Engineer", url: "https://jobs.lever.co/acme/1/apply" });
      expect(JSON.stringify(saved[0])).not.toContain("secret");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
