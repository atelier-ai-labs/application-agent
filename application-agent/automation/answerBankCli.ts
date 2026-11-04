import { randomUUID } from "node:crypto";
import { LocalStorageCareerRepository } from "../src/persistence/careerRepository";
import { questionProvenanceForBlocker } from "../src/domain/attention";
import {
  STANDING_TOPICS, answerBankKey, answerRiskTier, isBankableQuestion, questionFromBlocker, withRecordedAnswer, withStandingAnswer,
  type AnswerBankEntry, type AnswerRiskTier, type StandingTopicId,
} from "../src/domain/answerBank";
import { FileKeyValueStorage } from "./runtime/fileKeyValueStorage";
import { FileAnswerBankStore } from "./answerBank/fileAnswerBankStore";

/**
 * `career-agent:answers` lists the answer bank. `--backfill` seeds it from
 * every answer already given on past forms (newest answer per question wins;
 * answers the agent itself produced are not copied back in).
 */
export function backfillFromHistory(entries: readonly AnswerBankEntry[], jobs: ReturnType<LocalStorageCareerRepository["listJobs"]>): { entries: AnswerBankEntry[]; added: number } {
  const answers = jobs.flatMap((job) => job.blockers
    .filter((blocker) => blocker.status === "resolved" && blocker.unit === "submission" && questionProvenanceForBlocker(blocker) === "ATS_FORM")
    .filter((blocker) => !blocker.evidence.some((item) => item.startsWith("answer-provider:")))
    .map((blocker) => ({ job, blocker })))
    .sort((a, b) => (a.blocker.resolvedAt ?? "").localeCompare(b.blocker.resolvedAt ?? ""));
  let current = [...entries];
  const seen = new Set(current.map((entry) => entry.key));
  let added = 0;
  for (const { job, blocker } of answers) {
    const question = questionFromBlocker({ ...blocker, context: { ...blocker.context, company: blocker.context.company ?? job.job.company } });
    if (!isBankableQuestion(question, blocker.value)) continue;
    const key = answerBankKey(question.question, question.company);
    const existing = current.find((entry) => entry.key === key);
    // Answers given in Slack after the bank existed are newer than history.
    if (existing && existing.source !== "history") continue;
    if (!seen.has(key)) { added += 1; seen.add(key); }
    current = withRecordedAnswer(current, {
      id: existing?.id ?? `answer-${randomUUID()}`,
      key, question: question.question, value: blocker.value, tier: answerRiskTier(question),
      ...(question.fieldType ? { fieldType: question.fieldType } : {}),
      ...(question.options ? { options: question.options } : {}),
      ...(question.company ? { company: question.company } : {}),
      jobId: job.id, source: "history", recordedAt: blocker.resolvedAt ?? job.updatedAt,
    });
  }
  return { entries: current, added };
}

function printBank(all: readonly AnswerBankEntry[], path: string): void {
  let entries = all;
  const order: AnswerRiskTier[] = ["low", "medium"];
  entries = entries.filter((entry) => !entry.topic);
  console.log(`${entries.length} saved answer${entries.length === 1 ? "" : "s"} in ${path}`);
  console.log("\nStanding answers (set by you; never learned from Slack):");
  for (const topic of STANDING_TOPICS) {
    const entry = all.find((candidate) => candidate.topic === topic.id);
    console.log(`  ${topic.id.padEnd(24)} ${entry ? (entry.disabled ? "[off] " : "") + String(entry.value) : "(not set: asks you)"}  — ${topic.label}`);
  }
  for (const tier of order) {
    const rows = entries.filter((entry) => entry.tier === tier);
    if (rows.length === 0) continue;
    console.log(`\n${tier === "low" ? "Low risk (reused even when worded differently)" : "Medium risk (reused only for the same question)"}:`);
    for (const entry of rows) {
      const used = entry.usedCount ? `, used ${entry.usedCount}x` : "";
      console.log(`  ${entry.disabled ? "[off] " : ""}${entry.question.slice(0, 90)}\n      → ${String(entry.value).slice(0, 80)}  (${entry.source}${entry.company ? `, ${entry.company}` : ""}${used})`);
    }
  }
}

export function runAnswerBankCli(argv = process.argv.slice(2), env = process.env): void {
  const store = new FileAnswerBankStore(env.ATELIER_CAREER_AGENT_ANSWER_BANK_FILE?.trim() || undefined);
  // --set-standing criminal_conviction=No background_check=Yes previously_applied=@records
  const setIndex = argv.indexOf("--set-standing");
  if (setIndex >= 0) {
    let entries = [...store.entries()];
    for (const pair of argv.slice(setIndex + 1).filter((arg) => !arg.startsWith("--"))) {
      const [topic, ...rest] = pair.split("=");
      const value = rest.join("=").trim();
      if (!topic || !value) throw new Error(`Expected topic=value, got "${pair}".`);
      entries = withStandingAnswer(entries, topic as StandingTopicId, value, new Date().toISOString());
    }
    store.save(entries);
  }
  if (argv.includes("--backfill")) {
    const repository = new LocalStorageCareerRepository(new FileKeyValueStorage());
    const { entries, added } = backfillFromHistory(store.entries(), repository.listJobs());
    if (argv.includes("--dry-run")) {
      console.log(`Dry run: would add ${added} answer${added === 1 ? "" : "s"}.`);
      printBank(entries, store.path);
      return;
    }
    store.save(entries);
    console.log(`Added ${added} answer${added === 1 ? "" : "s"} from past applications.`);
  }
  printBank(store.entries(), store.path);
}

runAnswerBankCli();
