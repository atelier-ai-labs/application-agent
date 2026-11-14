# Application agent handoff (updated 2026-11-10 late night)

Read this first in a new session. PuckPulse has its own handoff in `nhl-dashboard/HANDOFF.md`;
this one is only the application agent (`application-agent/`). Parked ideas live in
[docs/FUTURE_UPDATES.md](docs/FUTURE_UPDATES.md).

## Where things stand

- **Applied 2026-11-09/10 (9):** Mercury, Temporal (11-09); Upstart ×3 (Upstart Bank, Unsecured
  Installments, Delivery), Ramp Frontend, Latitude AI, Affirm CIAM, ElevenLabs (11-10).
- **Skipped 11-10:** Gusto (asks 10+ years), Ramp Security/Stablecoin, and six stalled September
  jobs (Rootstock, Home Depot, Tebra, Reddit Ads, McKesson, Abnormal Security). Nothing submitted.
- **Waiting on Nate:** nothing at end of night. Next daily run is 17:30.
- Host restarted after the last fix; every 11-10 fix is live in the host and the Slack listener.

## What changed 2026-11-10 (all pushed to `feature/application-agent`)

**State is in SQLite now (4fa9a2a, d18a0f0, migrated 21:37).** `.local/career-agent/state.db`
replaced `state.json` (kept as `state.json.pre-sqlite-1794364633988.backup`). Built-in `node:sqlite`,
WAL mode; each write touches one key, and repositories change job/campaign/application/event lists
inside one short `BEGIN IMMEDIATE` transaction (`updateStoredArray`), so processes can't erase each
other's saves. `openStateStorage()` (runtime/stateStorage.ts) is the only way to open state: a
`.json` path with a `.db` beside it uses the database, and a missing db next to an old state.json
refuses to start. Keys and values are stored as bytes because fence keys contain a NUL (the import
check caught SQLite text cutting them short). Tests now use a temporary state db (tests/setup.ts):
the host's default fence store used to be the **real** state.json during tests. To inspect state by
hand, use `sqlite3` or a vite-node script through the runtime, not `python json.load(state.json)`.
Lists are still stored one JSON array per key (atomic, not one row per job); splitting into tables
is optional later.

**Submitting from Slack.** The "Application ready to submit" card's **Submit application** button
already existed (two Upstart roles went in that way). The waiting board now says to tap it
(5a73925) and links to the card (ed0c4bf). Submission authority stays `never`; Nate's tap is the
approval and the agent clicks once, behind the durable submission fence.

**Shared state file races (the big lesson of the night).** The Slack listener, the browser host
and one-off CLIs share `.local/career-agent/state.json` (17 MB), and each saved its whole
in-memory copy:
- f8cee38: a write re-reads the file if another process changed it, then sets one key. Fixed
  Upstart Delivery's "durable submission fence is missing".
- 4c1caa7: reads also re-read a changed file (stat check), and keep the last good copy if the
  file is missing or unreadable. Fixed Affirm's job going back to `ready_to_submit` after it failed.
- Writes deliberately do not wait on the file lock: `restart-existing` holds it for minutes while
  a browser runs and the listener would freeze.
- Closed by the SQLite move the same night (see the top of this list): same-list changes now run
  in one transaction.
- Interview write-up: `nhl-dashboard/docs/LEARNING.md`, "2026-11-10 — A lost update between two
  processes".

**Questions the agent now answers itself** (`leverBrowserExecutor.ts`, staging trick):
- 9b7a060: authorization "in the country where you are applying"; "Have you ever, or are you
  currently working at X" with "Gusto, Inc." suffixes; veteran option without "protected";
  first-generation professional → the form's decline option.
- dd8a606: worded former-employee No ("I have not previously been employed at Affirm"); exact "No"
  still wins; punctuation-stripped company match (form replay caught a D.A. Davidson regression).
- c5e1337 (`playwrightLeverBrowserSession.ts`): bare state dropdowns ("Which U.S. State or Canadian
  Province…") match the profile's state.

**Not a login wall** (6bed341): Affirm's CIAM posting text says "login" and "MFA", so the page check
stopped with nothing filled. With the application form visible and no password box, those words
are ignored; a password box or "verification code" still stops it. Test runs in real headless
Chromium (`tests/login-boundary-browser.test.ts`).

**Question re-posted every minute** (73462b4): Latitude's multiple-choice human check got a model
draft (a wrong one); drafts are only valid on free-text questions, so the saved record failed
validation and was silently dropped on every read, and the agent re-posted it each minute. Drafts
now attach only to free-text questions, human checks get none, and a record whose only problem is
its draft keeps its question. 58 duplicate Slack posts were deleted.

**Filters** (f62a3d4): search intent `maxYearsExperience` (Nate: 5). Discovery and the pre-apply
hard filter skip postings whose stated minimum is above it (`domain/experienceYears.ts`: low end of
a range, only sentences that mention experience, ignores nice-to-haves). `stablecoin(s)` added to
excluded title terms. **The excluded title list caps at 12 values**: adding two crashed the
listener for about a minute until `contract-to-hire` was dropped ("contract" already covers it).

**Slack:**
- 4fe707d: every new question shows "View the job posting" under the title; board job names link
  to the posting; the Submit card links it. Only https links render (`isPostingUrl`).
- 42b24f6: hourly tidy in the listener deletes the bot's own messages more than a day old unless
  they are the current board, a question for a job still waiting, or the Submit card of a job still
  ready. `ATELIER_SLACK_TIDY=disabled` turns it off. Max 40 deletes per run.
- One-time cleanup of ~600 old bot messages ran 11-10 night. The bot can't delete Nate's messages;
  deleted parents with his replies leave "This message was deleted".
- e7e444e: essay filler filter catches every form of "align"/"resonate".

## 2026-11-11

- Upstart declined Software Engineer II, Delivery: it allows **3 applications per person per 60 days**
  and that was the 4th (DevOps Cloud Platform was earlier). Sheet row 82 set to Rejected with a note.
- ecfd173: `companyApplicationLimit` in search intent (`{ max: 3, windowDays: 60, overrides: { Upstart: 3 } }`).
  Before applying, a company's count is applications in the window plus ones still in progress; at
  the limit the job is rejected with the reason. Roles are still taken in queue order, not best fit.
- The inbox classifier now reads "will not be able to move forward with your…" as a rejection.

## 2026-11-12

- Skipped Pinecone (hybrid, NYC 3 days/week), Outmarket Platform Engineer (already applied to
  Outmarket AI), Sparksoft DevOps. `excludedCompanies` now lives in search intent (Sparksoft, D.A.
  Davidson) and matches any spelling; "X AI" and "X" count as one company.
- 92a1573: Ashby queue rows are enriched from the public job-board data (carries workplaceType);
  the posting-content check no longer counts the title line ("…, Experience") as posting prose.
- Samsara fixes (11b9439, 31eb3b6, 38707e8): two option matchers treated "Cis-man" as matching
  "Man" (a dialing-list rule for "+1 US - United States"); option reads waited 15 s on closed menus
  (a 23-minute run, now under a minute); keyboard fallback now Enters only on the exact option; a
  dropdown the form won't take becomes a question; curly-apostrophe disability option; "I confirm
  that I reside in the US". Verified live on Samsara: gender, disability and residence now fill.

## 2026-11-14: model-call log and essay eval

- 0e811e3: every local-model call (essay drafts, answer-bank matches) appends a line to
  `.local/career-agent/model-calls.jsonl`: purpose, model, promptVersion (hash of prompt + template),
  attempt, question, outcome (drafted or why dropped), output, problems, latency, tokens.
- 0ff67e0: `npm run career-agent:eval-essays [-- --save-baseline] [--only <id>]` over
  `application-agent/evals/essay-cases.json` (13 real questions). Checks: drafted, length, no_filler,
  not_copied, grounded, names_company. Reports + baseline in `.local/career-agent/evals/`.
- Baseline 0.48 (qwen2.5:7b, prompt a25c005a99): drafted 54%, no_filler 57%, others ~100%. 4 of the 6
  missing drafts were the model declining for insufficient evidence on story questions → next: give
  the drafter real stories (story bank / profile projects: this agent, PuckPulse AI), re-run, compare.

## Known gaps / next

- Done 11-10 late (bac524c): "select all that apply" groups are one question with the box labels as
  choices; the answer checks only that box, and an answer that names no box asks again. Profile now
  has `identity.preferredName: "Nate"` and `approvedReusableAnswers.pronouns: "He/him"`.
- Headless browser around 11-14 (FUTURE_UPDATES); the Slack Submit button is what makes it work.

## How to operate (learned the hard way)

- Before restarting the host: `curl -s http://127.0.0.1:8787/health` and check `activeSessions`.
  A host restart closes every browser window; restarting only `atelier-career-agent.service` keeps
  them.
- A fix to form filling (`leverBrowserExecutor.ts`, `playwrightLeverBrowserSession.ts`) only takes
  effect after a **host** restart; Slack/board/state changes need a **listener** restart.
- After editing `.local/career-agent/search-intent.json`, validate it before restarting anything
  (`normalizeJobSearchIntent`), or the listener crash-loops.
- Reopen an application: `ATELIER_CAREER_AGENT_JOB_ID=… ATELIER_CAREER_AGENT_APPLICATION_ID=… npm run -s career-agent:restart-existing`
  (needs `ready_for_review`, or a failed run whose evidence says `submit:not-clicked`).
- Form replay before committing executor changes: `npm run -s career-agent:replay -- --quiet`
  (`--form <name> --show-values` for one form). Start-date "filled → filled" lines are expected.
- The other session's uncommitted edits in `googleSheetsJobQueue.ts`, `leverBrowserExecutor.ts` and
  their tests are not ours; commit only our lines (staging trick: edit `git show HEAD:file` copy,
  `git update-index --cacheinfo`, verify with `git checkout-index` into a scratch dir).
- Push after each chunk: `git push application-agent HEAD:feature/application-agent`.
