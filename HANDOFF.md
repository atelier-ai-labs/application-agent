# Application agent handoff (updated 2026-11-17)

Read this first in a new session. PuckPulse has its own handoff in `nhl-dashboard/HANDOFF.md`;
this one is only the application agent (`application-agent/`). Its learning log is [docs/LEARNING.md](docs/LEARNING.md). Parked ideas live in
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

## 2026-11-17: Google login fixed, Submit works after the window closed

- **Nothing applied 11-14 to 11-17.** Nate was busy, and finished windows close after 4 h
  (`ATELIER_EXECUTION_SESSION_TIMEOUT_MS`). The 11-16 daily run failed in every phase because
  the Google token expired (Testing app, 7-day refresh token).
- **Google OAuth app is In production now.** Branding needed a homepage (the GitHub repo) and
  a privacy policy (`PRIVACY.md`, 6aed8e9). There's no logo, because a logo forces brand
  verification. google-auth was re-run, and the Sheets and Gmail dry runs are clean.
- **Late Submit (2b388a4).** `submitFromHumanApproval` checks `executionHost.get(id)`. If the
  window is gone (timed out, or a 404 after a host restart), it reopens the packet with
  `startExistingApplication` (the restart path, forced to never-submit), polls it, and compares the
  refill's `reviewSummary` with the card's copy (`APPROVED_FORMS_KEY`, written in
  `announceSubmissionReview`) using `compareApprovedForm` (`runtime/approvedFormCheck.ts`).
  - On a match, it submits once. A moved date is allowed.
  - On a difference, it posts a new card.
  - A new question goes to Slack.
  - If the host is busy, it re-posts the old card.

  Slack rewrites the tapped card with progress. Cards posted before this change have no saved
  copy, so their first tap reopens the form and posts a fresh card, and the second tap submits.
  Interview write-up: docs/LEARNING.md "2026-11-17 — An approval has to be tied to what was
  approved".
- **One application per company (Nate, 11-17).** search-intent is now
  `companyApplicationLimit {max 1, windowDays 365}`, and the Upstart override is gone.
  - **The limit was never actually applied before (eda5ea7).** The live campaign kept the
    criteria it was created with, so the limit, `excludedCompanies` and `maxYearsExperience`
    only filtered discovery, never the pre-apply check. Queue rows skipped discovery entirely.
  - `CareerAgentService` now takes `liveSearchPolicy`. The runtime wires
    `liveSearchPolicyFromIntentFile`, which reads search-intent for every job and keeps the last
    good copy if the file is bad.
  - Companies also match by job board (`companyBoardKey`), so "Span" and "Span App" are the
    same company.
  - **Skipped (nothing submitted), and their Sheet rows set to Skipped:**
    - Phantom Backend (Trading) and Span App DevOps. Both companies already had an application,
      and their Submit cards were deleted.
    - Outmarket Full Stack AI. Already applied to Outmarket, 11-07.
    - Smartsheet SE II. SE I was kept as the better fit: 1+ years asked vs 2+, and 4 strong
      skill matches vs 2.
- **Figma (d38450b, 4833a9e).** Figma had stopped with "Greenhouse form action / reply with one
  grounded answer". The link `boards.greenhouse.io` redirects to `job-boards.greenhouse.io`, and
  the form-destination check called that an unrelated site. `sameProviderOrigin` now treats every
  https `*.greenhouse.io` host as Greenhouse.
  - The three browser safety stops (wrong site, page identity, no form) carry a plain
    explanation (`safetyStop`, kept under 240 characters because that is the prompt cap). Slack
    shows the explanation plus "nothing to answer here", with no reply instruction.
  - Two wordings are now answered: "From where do you intend to work?" (location) and
    "authorized to work in the country for which you applied".
  - Form replay: Figma goes from 4 questions to 2 (years in this type of role, why Figma), and
    no other saved form regressed.
  - Figma was reopened with the fix: 17 of 23 fields are filled.
- **Applied 11-17:** Reddit (Front End, Media Player), via the Slack Submit button.
- **Incidents 11-17:**
  - I restarted the host while 2 windows were open (Figma, and Twilio at needs_input). Nothing was
    lost, because Twilio's next answer reopens it, but check `activeSessions` and wait.
  - The listener exited once with "database is locked" (14:22:05) while restart-existing was
    running, and systemd restarted it 5 s later. Startup should retry a busy database instead of
    exiting. **TODO.**
- **Figma skipped** (Ruby is its main language). Then f78ffa5:
  - **`excludedLanguages` in search-intent** (now `["Ruby"]`), handled in
    `domain/requiredLanguages.ts`. Discovery and the pre-apply check skip a posting when the title
    names the language, or when a sentence requires it. These don't count:
    - a nice-to-have
    - one choice among several ("or", "such as")
    - a plain mention

    Aliases: ruby→rails, go→golang (a bare "Go" is never matched), c#→.net.
  - **Yes/No buttons** for typed-answer questions that are plain yes/no questions
    (`isYesNoQuestion`). A tap sends "Yes" or "No", the same as typing it.
  - **Standing topic `knows_employee`** ("Do you know anyone who works at X?"). It is **not set
    yet**: waiting for Nate's answer, then run
    `npm run career-agent:answers -- --set-standing knows_employee=No`.
- **The answer bank is in SQLite (0f097d7, migrated 14:54).** It is the `answer_bank` table in
  state.db, one row per answer, keyed by `(owner_id, key)` with owner `local`.
  - `AnswerBankStore.update(change)` replaced `save(list)`. Each change is one `BEGIN IMMEDIATE`
    transaction that writes only changed rows and never deletes a row it can't parse.
  - `openAnswerBankStore()` is the only way to open the bank.
  - The 52 entries were imported and match the backup exactly. The JSON was renamed
    `answer-bank.json.moved-to-state-db-1794945214950`, with backups
    `answer-bank.json.pre-sqlite-20261117-145327.backup` and
    `state.db.pre-answer-bank-20261117-145327.backup`.
  - Edit the bank with `career-agent:answers -- --set/--disable/--enable/--remove/--export`
    (`--help` lists them). The browser host doesn't use the bank, so only the listener was
    restarted.
  - Fixed today: the Arize human-check answer had been saved as "100 lol" and is now "100".
    `knows_employee=No` is set.
- **7fa00d9:**
  - **A lone checkbox** (Twilio's "By clicking Acknowledge…") now gets Yes/No buttons
    (`questionOptions` in attention.ts). Before, it was posted as a typed question with no button.
    Twilio's old message was deleted and re-posted (one-off).
  - **`answerWaitingQuestionsFromBank`.** The listener rechecks open questions whenever the saved
    answers change (a sha256 of key, value and disabled for each entry, checked every minute) and
    once at start. It then resumes the form or posts the next question. On start it answered
    Smartsheet's "know anyone" question with "No, I don't know anyone at Smartsheet." from the
    standing answer.
- **Applied 11-17:** Smartsheet SE I (15:29, Slack Submit).
- **Lost question, fixed in 1262578.** Twilio's Yes did nothing: every tap logged
  `unknown_or_closed_event`.
  - Two code paths in the listener (answer → post next question, and the minute loop's stale
    replacement) each read the campaign, added a question and saved it whole. One question was
    erased, and its Slack message kept buttons that pointed at nothing.
  - `saveCampaign` now merges `attentionEvents` and `runHistory` by id inside the transaction
    (`mergeCampaignWrite`). Closed questions never reopen from an older copy, and a recorded
    Slack delivery is kept.
  - **Deliberate deletions or clearing a delivery must use `replaceCampaign`.** The re-post
    one-offs used `saveCampaign` and would no longer work.
  - `recordAttentionResolution` used to pick the first open copy of a question, see that the ids
    differed, and silently record nothing. It now closes the answered copy and cancels its twins.
  - Twilio's dead messages were deleted, and the guidelines question was re-posted top-level.
  - Test gotcha: vitest's default environment is jsdom, where `SqliteKeyValueStorage` reads
    return null (`instanceof Uint8Array` fails across realms). Database tests need
    `// @vitest-environment node`.
- **Waiting at end of session:** Twilio needs the candidate-guidelines acknowledgement (fresh
  message, Yes/No). The browser reopens on answer.
- **Seen in passing:**
  - The Muse source returns 404.
  - The inbox check read a Langfuse webinar email as an interview. No row matched, so nothing
    changed.

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
