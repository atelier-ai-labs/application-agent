# Application agent handoff (updated 2026-11-17)

Read this first in a new session. PuckPulse has its own handoff in `nhl-dashboard/HANDOFF.md`;
this one is only the application agent (`application-agent/`). Its learning log is [docs/LEARNING.md](docs/LEARNING.md). Parked ideas live in
[docs/FUTURE_UPDATES.md](docs/FUTURE_UPDATES.md).

## Where things stand (end of 2026-11-17)

- **Applied: 39 total.** On 11-17: Reddit (Front End, Media Player), Smartsheet (SE I) and Twilio
  (SE L3), all through the Slack Submit button. Nothing was applied 11-14 to 11-16.
- **Waiting on Nate:** nothing. The host and listener both run every 11-17 fix (host restarted at
  16:10, listener at about 16:20). The next daily run is 17:34 on 11-17, the first with all of
  today's changes.
- **Rules now:**
  - One application per company: best fit, 365-day window.
  - Ruby postings are skipped.
  - Submission authority stays `never`: every application goes through Nate's Submit tap.

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
- Interview write-up: `docs/LEARNING.md`, "2026-11-10 — A lost update between two
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

## 2026-11-17: the day, organized

All of it is pushed to `feature/application-agent`. PR #10 merged the branch into `main` early in
the day (6cba053). Everything after that is on the branch only.

### Housekeeping
- **README rewritten** in plain language, in Nate's voice (508800c). The old one is now
  `docs/REFERENCE.md`.
- **`PRIVACY.md` added** (6aed8e9) for the Google sign-in screen.

### Why nothing got applied for three days, and the fixes
- **Google login expired.** The OAuth app was in "Testing" (7-day refresh tokens), and the 11-16
  daily run failed in every phase. The app is **In production** now.
  - The branding page needed a homepage (the GitHub repo) and a privacy policy (`PRIVACY.md`).
    No logo, because a logo forces brand verification.
  - google-auth was re-run, and the Sheets and Gmail dry runs are clean.
- **Finished forms expired.** The host closes windows after 4 h, and the Submit button then had
  nothing to click. Now a late Submit works (2b388a4):
  - `submitFromHumanApproval` checks `executionHost.get(id)`. If the window is gone, it reopens
    the packet (`startExistingApplication`, forced never-submit) and refills it.
  - It compares the refill's `reviewSummary` with the copy saved when the card was posted
    (`APPROVED_FORMS_KEY`, `compareApprovedForm` in `runtime/approvedFormCheck.ts`).
  - On a match it submits once. A moved date is allowed.
  - Any difference posts a fresh card, and a new question goes to Slack.
  - Write-up: LEARNING "An approval has to be tied to what was approved".

### Search rules
- **One application per company** (Nate's call): `companyApplicationLimit {max 1, windowDays 365}`,
  no overrides.
- **The limit, `excludedCompanies` and `maxYearsExperience` had never reached the pre-apply check**
  (eda5ea7). The live campaign kept the criteria it was created with. Queue rows only went through
  discovery, which does read search-intent.
  - `CareerAgentService.liveSearchPolicy` fixes this. The runtime's
    `liveSearchPolicyFromIntentFile` reads search-intent for every job and keeps the last good
    copy if the file is bad.
- **Companies match by job board too** (`companyBoardKey`), so "Span" and "Span App" are one
  company.
- **Excluded languages** (f78ffa5): `excludedLanguages: ["Ruby"]`, in `domain/requiredLanguages.ts`.
  - A posting is skipped when its title names the language, or a sentence requires it.
  - A nice-to-have, one choice among several, or a plain mention doesn't count.
  - Aliases: rails→ruby, golang→go (a bare "Go" is never matched), .net→c#.
- **Skipped under the new rules**, nothing submitted, Sheet rows set to Skipped:
  - Phantom Backend, Span App DevOps, Outmarket Full Stack AI: already applied to each company.
  - Smartsheet SE II: kept SE I as the better fit.
  - Figma: Ruby.

### Answers and the answer bank
- **The answer bank is in SQLite** (0f097d7): the `answer_bank` table in state.db, keyed by
  `(owner_id, key)`, with owner `local`.
  - `AnswerBankStore.update(change)` replaced `save(list)`. It is one transaction that writes only
    the rows that changed and never deletes a row it can't read.
  - Edit with `career-agent:answers -- --set/--disable/--enable/--remove/--export` (`--help`
    lists them).
  - The import matched exactly: 52 entries. Backups are
    `answer-bank.json.pre-sqlite-20261117-145327.backup` and
    `state.db.pre-answer-bank-20261117-145327.backup`.
- **Standing answer `knows_employee=No`** ("Do you know anyone who works at X?").
- **Fixed entry:** the Arize human check had been saved as "100 lol"; it's "100" now.
- **Waiting questions are rechecked when saved answers change** (7fa00d9,
  `answerWaitingQuestionsFromBank`). It runs every minute but only does work when the bank's hash
  changed. Smartsheet's question was answered that way.
- **Loop breaker** (c7420ff). If the form asks again after a saved answer was used, the question is
  marked `answer-bank:rejected-by-form` and goes to Nate.
  - Twilio's veteran question had looped 39 times (15:57–16:08) while the host ran old code.
- **Ollama `keep_alive` 2h** (843deed). The model unloaded after 5 idle minutes, and the 37 s
  reload was longer than the 15 s matcher timeout. Every bank check after a quiet spell timed out,
  and the listener took 95 s to start.

### Form filling
- **Greenhouse's two domains** (d38450b): `boards.greenhouse.io` redirects to
  `job-boards.greenhouse.io`, and the form-destination check had called that a foreign site
  (Figma).
- **Safety stops explain themselves in Slack**, with "nothing to answer here".
- **Newly answered from the profile:**
  - "From where do you intend to work?" (location)
  - "authorized to work in the country for which you applied" (4833a9e)
- **Veteran lists** (d18217a): "I identify as a veteran but not a protected veteran" no longer
  counts as "no". When several options match, the word-for-word one wins. `optionValue` is
  exported.
- **Checkboxes are never essays** (623409c), on four layers:
  1. classification
  2. the drafter skips them
  3. a stored draft is dropped from a choice question when read
  4. the Slack render

### Slack
- **Yes/No buttons** for plain yes/no typed questions (`isYesNoQuestion`) and for a lone checkbox.
- **Lost questions** (1262578): two listener code paths each saved the whole campaign, and one
  question was erased while its Slack buttons stayed live (Twilio's dead Yes).
  - `saveCampaign` now merges `attentionEvents` and `runHistory` by id inside the transaction
    (`mergeCampaignWrite`).
  - `recordAttentionResolution` closes the copy that was answered and cancels its twins. It used
    to pick the first copy, see the ids differ, and record nothing.

### Incidents (mine)
- I restarted the host with 2 windows open. Nothing was lost.
- The listener exited once on "database is locked" (14:22) during restart-existing, and systemd
  restarted it.
- `timeout 120` killed two one-off scripts mid-poll and left Twilio's record at "executing".

### Seen in passing, not fixed
- The Muse job source returns 404.
- The inbox check read a Langfuse webinar email as an interview. No row matched.

## 2026-11-18

- **The inbox check reads Trash and Spam too** (fad0589, `includeSpamTrash=true`, still
  read-only). Samsara's and Arize's rejections had been sitting in Trash unseen.
- **New rejection wordings:**
  - Arize: "don't see a strong mutual fit"
  - Mercury: "move forward with other candidates whose skills…"

  Mercury's email had already been handled as "received" by the 17:34 run. Its id was removed
  from `inbox-processed.json` (backup `inbox-processed.json.before-mercury-reread-*.backup`) and it
  was re-read.
- **Tracker now Rejected:**
  - Arize Applied AI
  - Samsara SWE Data Platform
  - Upstart SWE Unsecured Installments
  - Mercury SWE Product
- **CircleCI fixes (2ab23c6):**
  - Plural "races/ethnicities" now matches race_ethnicity. The "Hispanic/Latinx" option had
    pulled it into the Hispanic yes/no answer.
  - `isPostedLocationEligibilityQuestion`: a Yes/No "are you located in and willing to work in the
    location where the job is posted?" answers Yes, and the prepared address no longer overrides
    it.
  - Replay: CircleCI goes from 2 questions to 0, with no regressions. The host was restarted (only
    CircleCI's window was open) and CircleCI reopened.
- **More CircleCI fixes:**
  - 2072d53: the location Yes is selected as a plain choice. Location matching had searched
    for a place called "Yes".
  - 97763df: "salary within the posted band?" answers Yes, not the midpoint figure, and the
    question is no longer classified `salary`. "I do not identify as a protected veteran" is
    now read as "no".
  - A fill once sat stuck for 10 minutes. It was cancelled and reopened, and Nate submitted
    CircleCI (applied).
- **Stuck-run watchdog (6bae53e).** The executor sends `reportProgress` once per field.
  `ExecutionSessionRegistry.checkForStalledRuns` runs every 30 s, and a run with no heartbeat for
  `ATELIER_EXECUTION_STALL_TIMEOUT_MS` (default 5 min) has its browser closed and reruns in the
  same session. A second stall fails the run with "got stuck while … Nothing was submitted".
  `runToken` makes an abandoned run's late return a no-op.
- **Alerts (83b1e9f, `runtime/agentAlerts.ts`).** One Slack message, "The application agent
  needs your attention", for:
  - daily-run phase failures (stderr is now captured; an expired Google login is named, with
    the fix)
  - dead job sources (weekly)
  - failed browser runs (not the normal 4-hour close)
  - a listener crash loop (3+ starts in 15 min; checked on start)
  - the local model failing every call for an hour (checked hourly)

  Each alert key repeats at most once a day (`alerts-sent.v0` in state).
  `ATELIER_AGENT_ALERTS=disabled` turns off the listener checks. The Muse 404 should produce the
  first real alert on the next daily run.
- **Standing-topic model ON (11-23, 0b1b067).** Off switch: `ATELIER_CAREER_AGENT_STANDING_TOPIC_MODEL=disabled`.
  Additive only; rule matches are checked by the model only for `ruleNeedsCheck` topics
  (security_clearance, certifications). Eval: main 78/8/0, held-out 25/5/0 (held-out partly tuned
  now: write fresh cases before the next prompt change). Replay off→on 167→166, nothing lost.
  New standing answers set by Nate: military No, clearance No, notice 2 weeks, certifications None,
  work_location "Remote from Pittsburgh, PA". Profile `identity.location` → Pittsburgh (street and
  ZIP unchanged; backup in .local/career-agent/profile.json.before-pittsburgh-*.backup).
  WSL memory raised to 10GB by Nate (.wslconfig): it had 7.3GB with swap full and Ollama under
  memory pressure (model was on the GPU all along).
- **Standing-topic eval + model matcher (11-23, 15f3c50), NOT switched on.**
  `npm run career-agent:eval-topics [-- --holdout|--rules-only]`. Cases in
  `application-agent/evals/standing-topic-{cases,holdout}.json`; when a held-out case drives a
  prompt change, move it to cases and write a fresh one. Classifier =
  `automation/answerBank/ollamaStandingTopicClassifier.ts` (topic enum + second "check" call);
  `acceptedModelTopic` guards it (Yes/No or text box only, confidence, topic `exclude`). Results:
  main 65/19/0 → 70/14/0, held-out 16/12/2 → 22/8/0 (right/asked/wrong) with the check also run on
  rule picks. Next: wire into `findAnswerBankMatch` (classifier when rules miss, checker on rule
  picks), behind an env switch, then compare on the form replay.
- **Age wording (11-23, ece0cb6):** "Are you over the age of 18?" now answers Yes like "18 or older".
  Host NOT restarted yet (Hex's window was open on a post-Submit CAPTCHA), so the running host still
  has the old rule; Supabase's age question was left for Nate to tap.
- **Hex checkbox group (11-23, f9a89b6):** Ashby names group boxes `q[]`, `q[]--2`; `checkboxGroupKey`
  only knew Greenhouse's `q[]_0`, so each box went to Slack as a bare Yes/No. Fixed, plus the
  work-location rule now matches "from where do you intend to work?" and reads
  `preferredWorkLocation` (falls back to Remote when only `workPreferences.remote` is set). A lone
  group box names its label in Slack and in the answer-bank key. Host and listener restarted;
  Hex reopened, only "How did you hear about Hex?" is left.
- **OpenAI Applied AI Engineer, Enterprise – EDU skipped (11-19):** the form required an active
  Full Scope Polygraph clearance and 5 days on-site in Maryland. Nate's call.
- **MCA Connect skipped** (16 questions; Nate's call, no automatic cap). Its second role was
  skipped by the one-per-company rule.
- **Software-engineer résumé:** drafted in
  `.local/career-agent/resumes/software-engineer-2026-11-DRAFT.md` and waiting on Nate's review.
  Six real rejections since 11-01, three of them for plain "Software Engineer" roles, and 22 of
  39 applications were plain "Software Engineer" roles.
  - Résumé families are fixed in code (`validation.ts`, `fit.ts`, `policies.ts`), so a fourth
    family needs a code change. The proposed rule: plain SWE / Full Stack / Backend titles get the
    new résumé.

## Known gaps / next

- **Step 3 of Nate's plan:** one daily Slack message with every open question, so they can be
  cleared in minutes.
- **The listener's startup** should retry a busy database instead of exiting.
- **Answer bank:** confirm before saving an answer ("Save '100' for next time?"), and add a
  "remember this for every company?" button.
- **Multi-user design** (LEARNING 11-17): résumé → profile, a short starter questionnaire, then
  learn as you go. Share the questions, never the answers. `owner_id` already exists.
- **The Muse 404, and the inbox misreading newsletters as interviews.**
- **Headless browser.** Later: Nate wants more trust in the agent first.

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
- **Deleting questions on purpose** (or clearing a Slack delivery to re-post) needs
  `careerRepository.replaceCampaign`. `saveCampaign` merges, so it would keep them.
- Tests that use `SqliteKeyValueStorage` need `// @vitest-environment node`. Under jsdom its reads
  return null.
- Run one-off scripts that touch the host in the background, or with a long timeout. A killed
  script leaves the job record behind the host.
- A Submit card can be tapped after its window closed: the agent reopens, refills, checks and
  submits.
- The browser host doesn't use the answer bank. A bank change needs only a listener restart.
