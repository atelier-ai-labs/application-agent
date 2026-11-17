import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { LocalStorageCareerRepository } from "../src/persistence/careerRepository";
import { questionProvenanceForBlocker } from "../src/domain/attention";
import {
  STANDING_TOPICS, answerBankKey, findAnswerBankEntries, answerRiskTier, isBankableQuestion, questionFromBlocker, withRecordedAnswer, withStandingAnswer,
  type AnswerBankEntry, type AnswerRiskTier, type StandingTopicId,
} from "../src/domain/answerBank";
import { openStateStorage } from "./runtime/stateStorage";
import { openAnswerBankStore } from "./answerBank/sqliteAnswerBankStore";

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

function oneEntry(entries: readonly AnswerBankEntry[], reference: string): AnswerBankEntry {
  const found = findAnswerBankEntries(entries, reference);
  if (found.length === 1) return found[0]!;
  if (found.length === 0) throw new Error(`No saved answer matches "${reference}". Run career-agent:answers to list them.`);
  throw new Error(`"${reference}" matches ${found.length} saved answers; be more specific:\n${found.slice(0, 8).map((entry) => `  ${entry.key}`).join("\n")}`);
}

const USAGE = `career-agent:answers                      list saved answers
  -- --set "<question>" <value>          change a saved answer (e.g. --set "10 times 10" 100)
  -- --disable "<question>"                stop reusing an answer   (--enable turns it back on)
  -- --remove "<question>"                 delete a saved answer
  -- --set-standing topic=value ...        set standing answers (knows_employee=No)
  -- --backfill [--dry-run]                seed the bank from past applications
  -- --export <file.json>                  write the bank to a JSON file to read or keep`;

export function runAnswerBankCli(argv = process.argv.slice(2), env = process.env): void {
  if (argv.includes("--help")) { console.log(USAGE); return; }
  const store = openAnswerBankStore(env);
  const where = `${store.path} (answer_bank table)`;
  const now = new Date().toISOString();
  const argAfter = (flag: string) => argv[argv.indexOf(flag) + 1];

  // --set-standing criminal_conviction=No background_check=Yes previously_applied=@records
  const setIndex = argv.indexOf("--set-standing");
  if (setIndex >= 0) {
    const pairs = argv.slice(setIndex + 1).filter((arg) => !arg.startsWith("--")).map((pair) => {
      const [topic, ...rest] = pair.split("=");
      const value = rest.join("=").trim();
      if (!topic || !value) throw new Error(`Expected topic=value, got "${pair}".`);
      if (!STANDING_TOPICS.some((candidate) => candidate.id === topic)) throw new Error(`Unknown standing topic "${topic}".`);
      return { topic: topic as StandingTopicId, value };
    });
    store.update((entries) => pairs.reduce((current, { topic, value }) => withStandingAnswer(current, topic, value, now), entries));
    console.log(`Saved ${pairs.length} standing answer${pairs.length === 1 ? "" : "s"}.`);
  }
  if (argv.includes("--set")) {
    const reference = argAfter("--set");
    const value = argv[argv.indexOf("--set") + 2];
    if (!reference || value === undefined || value.startsWith("--")) throw new Error('Usage: --set "<question>" <value>');
    let changed = "";
    store.update((entries) => {
      const target = oneEntry(entries, reference);
      changed = target.question;
      return entries.map((entry) => entry.key === target.key ? { ...entry, value, source: "manual" as const, recordedAt: now } : entry);
    });
    console.log(`Saved: ${changed} → ${value}`);
  }
  for (const flag of ["--disable", "--enable", "--remove"] as const) {
    if (!argv.includes(flag)) continue;
    const reference = argAfter(flag);
    if (!reference || reference.startsWith("--")) throw new Error(`Usage: ${flag} "<question>"`);
    let changed = "";
    store.update((entries) => {
      const target = oneEntry(entries, reference);
      changed = target.question;
      if (flag === "--remove") return entries.filter((entry) => entry.key !== target.key);
      return entries.map((entry) => {
        if (entry.key !== target.key) return entry;
        const { disabled: _disabled, ...rest } = entry;
        return flag === "--disable" ? { ...rest, disabled: true } : rest;
      });
    });
    console.log(`${flag === "--remove" ? "Removed" : flag === "--disable" ? "Turned off" : "Turned on"}: ${changed}`);
  }
  if (argv.includes("--backfill")) {
    const repository = new LocalStorageCareerRepository(openStateStorage());
    if (argv.includes("--dry-run")) {
      const { entries, added } = backfillFromHistory(store.entries(), repository.listJobs());
      console.log(`Dry run: would add ${added} answer${added === 1 ? "" : "s"}.`);
      printBank(entries, where);
      return;
    }
    let added = 0;
    store.update((entries) => {
      const result = backfillFromHistory(entries, repository.listJobs());
      added = result.added;
      return result.entries;
    });
    console.log(`Added ${added} answer${added === 1 ? "" : "s"} from past applications.`);
  }
  if (argv.includes("--export")) {
    const file = argAfter("--export");
    if (!file || file.startsWith("--")) throw new Error("Usage: --export <file.json>");
    writeFileSync(file, `${JSON.stringify({ version: 1, entries: store.entries() }, null, 2)}\n`);
    console.log(`Wrote ${store.entries().length} answers to ${file}.`);
    return;
  }
  printBank(store.entries(), where);
  store.close();
}

try {
  runAnswerBankCli();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
