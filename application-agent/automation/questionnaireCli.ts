import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { applyQuestionnaireAnswer, questionnaireRows, type QuestionnaireRow } from "../src/domain/questionnaire";
import type { CandidateProfile } from "../src/domain/types";
import { FileAnswerBankStore } from "./answerBank/fileAnswerBankStore";

/**
 * `career-agent:questionnaire` shows the common application questions and
 * what the agent will answer for each. It changes nothing unless asked:
 *   --set id=value [id=value ...]   record answers (e.g. security_clearance=No years.python=3)
 *   --ask                           walk through the unanswered ones (Enter skips)
 *   --missing                       list only unanswered questions
 */
type ProfileFile = Pick<CandidateProfile, "workPreferences"> & Record<string, unknown>;

function printRows(rows: readonly QuestionnaireRow[], onlyMissing: boolean): void {
  const answered = rows.filter((row) => row.value !== undefined).length;
  console.log(`Questionnaire: ${answered} of ${rows.length} answered. Unanswered ones are still asked on each form.\n`);
  let section = "";
  for (const row of rows) {
    if (onlyMissing && row.value !== undefined) continue;
    if (row.item.section !== section) { section = row.item.section; console.log(`${section}:`); }
    console.log(`  ${row.item.id.padEnd(26)} ${(row.value ?? "—").slice(0, 40).padEnd(24)} ${row.item.prompt}`);
  }
}

export async function runQuestionnaireCli(argv = process.argv.slice(2), env = process.env): Promise<void> {
  const store = new FileAnswerBankStore(env.ATELIER_CAREER_AGENT_ANSWER_BANK_FILE?.trim() || undefined);
  const profilePath = resolve(env.ATELIER_CAREER_AGENT_PROFILE_FILE?.trim() || ".local/career-agent/profile.json");
  let profile = JSON.parse(readFileSync(profilePath, "utf8")) as ProfileFile;
  let entries = [...store.entries()];
  const before = JSON.stringify(profile.workPreferences);
  const now = new Date().toISOString();

  const setIndex = argv.indexOf("--set");
  if (setIndex >= 0) {
    for (const pair of argv.slice(setIndex + 1).filter((arg) => !arg.startsWith("--"))) {
      const [id, ...rest] = pair.split("=");
      ({ entries, profile } = applyQuestionnaireAnswer(id ?? "", rest.join("="), entries, profile, now));
      console.log(`Saved ${id}.`);
    }
  }

  if (argv.includes("--ask")) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      for (const row of questionnaireRows(entries, profile).filter((candidate) => candidate.value === undefined)) {
        const reply = (await prompt.question(`${row.item.prompt}${row.item.hint ? ` (${row.item.hint})` : ""}: `)).trim();
        if (!reply) continue;
        try {
          ({ entries, profile } = applyQuestionnaireAnswer(row.item.id, reply, entries, profile, now));
        } catch (error) {
          console.log(`  Not saved: ${(error as Error).message}`);
        }
      }
    } finally {
      prompt.close();
    }
  }

  if (setIndex >= 0 || argv.includes("--ask")) {
    store.save(entries);
    if (JSON.stringify(profile.workPreferences) !== before) {
      const temporary = `${profilePath}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(profile, null, 2) + "\n");
      renameSync(temporary, profilePath);
    }
    console.log("");
  }
  printRows(questionnaireRows(entries, profile), argv.includes("--missing"));
}

await runQuestionnaireCli();
