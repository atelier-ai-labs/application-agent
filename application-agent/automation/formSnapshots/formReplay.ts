import { createHash } from "node:crypto";
import type { Application } from "../../src/domain/types";
import type { Campaign, CareerBlockerDraft, CareerJob } from "../../src/domain/campaignTypes";
import type { CandidateProfile } from "../../src/domain/types";
import type {
  ApplicationExecutorResult, ApplicationFieldDescriptor, ApplicationFieldOption, ApplicationFieldQuestionDescriptor,
  BrowserSubmissionResult, LeverBrowserField, LeverBrowserSession,
} from "../../src/domain/executor";
import { LeverBrowserExecutor } from "../../src/domain/leverBrowserExecutor";
import { normalizeJobPosting } from "../../src/domain/job";
import { classifyJobUrl } from "../../src/domain/jobUrlClassifier";
import { findAnswerBankMatch, questionFromBlocker, type AnswerBankEntry, type AnswerBankSemanticMatcher } from "../../src/domain/answerBank";
import type { FormSnapshot } from "./formSnapshot";

/**
 * Replays a saved form through the real executor with a pretend browser:
 * fields accept whatever the executor fills, nothing is submitted, and the
 * result says which fields the agent fills, which the answer bank covers,
 * and which would still be asked in Slack.
 */
export type FieldOutcome = "filled" | "bank" | "asked" | "blank";

export interface FieldReplay {
  id: string;
  label: string;
  required: boolean;
  outcome: FieldOutcome;
  /** Short hash of the filled value, to notice a changed answer without storing it. */
  valueHash?: string;
  /** The question as the form words it (the label is often a placeholder). */
  prompt?: string;
  /** The filled value itself, only when explicitly requested for local debugging. */
  value?: string;
}

export interface FormReplay {
  key: string;
  company: string;
  role: string;
  url: string;
  state: ApplicationExecutorResult["state"] | "error";
  reason?: string;
  fields: FieldReplay[];
}

class ReplayField implements LeverBrowserField {
  readonly id: string;
  readonly label: string;
  readonly type: ApplicationFieldDescriptor["type"];
  readonly required: boolean;
  readonly classification: ApplicationFieldDescriptor["classification"];
  readonly options?: readonly ApplicationFieldOption[];
  readonly section?: string;
  readonly sourceSelector?: string;
  readonly questionDescriptor?: ApplicationFieldQuestionDescriptor;
  readonly fullPrompt?: string;
  value: string | boolean | null = null;

  constructor(descriptor: ApplicationFieldDescriptor) {
    this.id = descriptor.id;
    this.label = descriptor.label;
    this.type = descriptor.type;
    this.required = descriptor.required;
    this.classification = descriptor.classification;
    if (descriptor.options) this.options = descriptor.options;
    if (descriptor.section) this.section = descriptor.section;
    if (descriptor.sourceSelector) this.sourceSelector = descriptor.sourceSelector;
    if (descriptor.questionDescriptor) this.questionDescriptor = descriptor.questionDescriptor;
    if (descriptor.fullPrompt) this.fullPrompt = descriptor.fullPrompt;
  }

  async fill(value: string): Promise<void> { this.value = value; }
  async select(value: string): Promise<void> { this.value = value; }
  async setChecked(value: boolean): Promise<void> { this.value = value; }
  async uploadFile(path: string): Promise<void> { this.value = `file:${path}`; }
  async readValue(): Promise<string | boolean | null> { return this.value; }
}

class ReplaySession implements LeverBrowserSession {
  readonly fields: ReplayField[];
  private url: string;
  constructor(snapshot: FormSnapshot) {
    this.fields = snapshot.fields.map((field) => new ReplayField(field));
    this.url = snapshot.url;
  }
  async navigate(url: string): Promise<void> { this.url = url; }
  currentUrl(): string { return this.url; }
  async detectUnavailablePage() { return null; }
  async inspectFields(): Promise<readonly LeverBrowserField[]> { return this.fields; }
  async formActionOrigin(): Promise<string | null> { try { return new URL(this.url).origin; } catch { return null; } }
  async verifyPageIdentity(): Promise<boolean> { return true; }
  async verifyUploadedFile(): Promise<boolean> { return true; }
  async detectHumanBoundary() { return null; }
  async hasSubmitControl(): Promise<boolean> { return true; }
  async submit(): Promise<BrowserSubmissionResult> { throw new Error("Replay never submits."); }
  async close(): Promise<void> { /* nothing to close */ }
}

const ATS_NAME: Record<string, string> = { lever: "Lever", greenhouse: "Greenhouse", ashby: "Ashby", rippling: "Rippling", workday: "Workday", custom: "Custom" };

function requestFor(snapshot: FormSnapshot, profile: CandidateProfile, now: string) {
  const company = snapshot.company ?? "Unknown company";
  const role = snapshot.role ?? "Unknown role";
  const kind = classifyJobUrl(snapshot.url).kind;
  // Ashby and Lever pair a posting page with its /application or /apply page.
  const sourceUrl = snapshot.url.replace(/\/(?:application|apply)\/?(?=$|[?#])/, "");
  const job = normalizeJobPosting({ companyHint: company, titleHint: role, sourceUrl, applicationUrl: snapshot.url, rawText: `${company}\n${role}\nRemote - United States` }, now);
  const familyId = profile.resumeFamilies[0]?.id;
  const application = {
    id: `replay-${snapshot.applicationId}`, isExample: false, job, fit: null,
    resume: { familyId } as Application["resume"], answers: [], blockers: [], status: "ready_for_review", createdAt: now, updatedAt: now,
  } as unknown as Application;
  const careerJob = {
    id: `replay-job-${snapshot.applicationId}`, campaignId: "replay", isExample: false, sourceMode: "live", actionability: "actionable",
    fingerprint: `replay:${snapshot.url}`, sourceId: "replay", sourceRecordId: snapshot.applicationId,
    destinationResolution: {
      status: "resolved", attemptedAt: now, destinationUrl: snapshot.url, ats: ATS_NAME[kind] ?? "Custom", actionable: true,
      provenance: kind === "custom" || kind === "unknown" ? "official_employer_evidence" : "recognized_ats_evidence", evidence: ["replayed form snapshot"],
    },
    job, discoveredAt: now, fit: null, applicationId: application.id, status: "preparing", blockers: [], createdAt: now, updatedAt: now,
  } as unknown as CareerJob;
  return {
    campaign: { id: "replay", applicationPolicy: { allowGroundedDrafts: true }, submissionPolicy: { authority: "never", requireExplicitApproval: false } } as Campaign,
    careerJob, application, profile, now,
    familyId,
  };
}

const hash = (value: unknown) => createHash("sha256").update(String(value)).digest("hex").slice(0, 12);

export function snapshotKey(snapshot: FormSnapshot): string {
  try { const url = new URL(snapshot.url); return `${url.hostname}${url.pathname}`; } catch { return snapshot.url; }
}

export async function replayForm(
  snapshot: FormSnapshot,
  options: { profile: CandidateProfile; answerBank?: readonly AnswerBankEntry[]; matcher?: AnswerBankSemanticMatcher; now?: string; showValues?: boolean },
): Promise<FormReplay> {
  const now = options.now ?? new Date().toISOString();
  const session = new ReplaySession(snapshot);
  const { familyId, ...request } = requestFor(snapshot, options.profile, now);
  const executor = new LeverBrowserExecutor({
    sessionFactory: { open: async () => session },
    provider: "auto",
    ...(familyId ? { resumePaths: { [familyId]: "/replay/resume.pdf" } as never } : {}),
    resumeFileExists: () => true,
    now: () => now,
  });
  const base = { key: snapshotKey(snapshot), company: snapshot.company ?? "?", role: snapshot.role ?? "?", url: snapshot.url };
  let result: ApplicationExecutorResult;
  try {
    result = await executor.execute(request);
  } catch (error) {
    return { ...base, state: "error", reason: error instanceof Error ? error.message.slice(0, 200) : "replay failed", fields: [] };
  }
  const loose = result as { blocker?: unknown; blockers?: readonly unknown[] };
  const blockers = [loose.blocker, ...(loose.blockers ?? [])]
    .filter((blocker): blocker is CareerBlockerDraft => Boolean(blocker && typeof blocker === "object" && "field" in blocker));
  const fields: FieldReplay[] = [];
  for (const field of session.fields) {
    const blocker = blockers.find((candidate) => candidate.field === field.id);
    let outcome: FieldOutcome = field.value !== null && field.value !== "" ? "filled" : blocker ? "asked" : "blank";
    if (outcome === "asked" && blocker && options.answerBank) {
      const match = await findAnswerBankMatch(options.answerBank, questionFromBlocker({
        ...blocker, context: { company: base.company, role: base.role } as never, status: "open",
      } as never), options.matcher);
      if (match) outcome = "bank";
    }
    const prompt = (field.questionDescriptor?.promptText ?? field.fullPrompt ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
    fields.push({
      id: field.id, label: field.label.replace(/\s+/g, " ").trim().slice(0, 120), required: field.required, outcome,
      ...(prompt && prompt !== field.label.trim() ? { prompt } : {}),
      ...(outcome === "filled" ? { valueHash: hash(field.value) } : {}),
      ...(outcome === "filled" && options.showValues ? { value: String(field.value).slice(0, 120) } : {}),
    });
  }
  return { ...base, state: result.state, ...("reason" in result && typeof result.reason === "string" ? { reason: result.reason.slice(0, 200) } : {}), fields };
}

export interface ReplayChange { form: string; field: string; from: FieldOutcome | "new"; to: FieldOutcome | "gone"; kind: "better" | "worse" | "changed" }

const RANK: Record<FieldOutcome, number> = { filled: 3, bank: 2, blank: 1, asked: 0 };

/** Field-by-field differences from a saved baseline; "worse" means a regression. */
export function compareReplays(baseline: readonly FormReplay[], current: readonly FormReplay[]): ReplayChange[] {
  const changes: ReplayChange[] = [];
  const before = new Map(baseline.map((form) => [form.key, form]));
  for (const form of current) {
    const previous = before.get(form.key);
    if (!previous) continue;
    const old = new Map(previous.fields.map((field) => [field.id, field]));
    for (const field of form.fields) {
      const was = old.get(field.id);
      if (!was) continue;
      if (was.outcome !== field.outcome) {
        changes.push({ form: `${form.company} — ${form.role}`, field: field.prompt ?? field.label, from: was.outcome, to: field.outcome, kind: RANK[field.outcome] > RANK[was.outcome] ? "better" : "worse" });
      } else if (field.outcome === "filled" && was.valueHash !== field.valueHash) {
        changes.push({ form: `${form.company} — ${form.role}`, field: field.prompt ?? field.label, from: "filled", to: "filled", kind: "changed" });
      }
    }
  }
  return changes;
}

export function replayTotals(forms: readonly FormReplay[]) {
  const all = forms.flatMap((form) => form.fields);
  const count = (outcome: FieldOutcome) => all.filter((field) => field.outcome === outcome).length;
  return { forms: forms.length, fields: all.length, filled: count("filled"), bank: count("bank"), asked: count("asked"), blank: count("blank"), errors: forms.filter((form) => form.state === "error").length };
}
