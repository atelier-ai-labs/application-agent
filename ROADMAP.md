# Application Agent roadmap

**Last reviewed:** 2026-11-20. This file follows the Atelier AI Labs roadmap standard (v1.0). It's the order I
plan to build things in, and why. Ideas without a stage live in [docs/FUTURE_UPDATES.md](docs/FUTURE_UPDATES.md).

## Vision

An agent that finds jobs, fills out the applications, keeps the tracker up to date, and only needs me for the
parts that really are mine to answer. After that, a version other people can use. The idea that makes the
second part work is **share the questions, never the answers**: what the agent learns about forms helps
everyone, and each person's answers stay theirs.

**What this agent will never do:**
- Submit an application I haven't approved (unless I deliberately make the no-questions-lane call below).
- Guess an answer it doesn't know, or claim experience I don't have.
- Answer salary, legal or employer-specific questions from memory without me seeing them.
- Mass-apply. One role per company, best fit only, a few a day.
- Send my email, résumé or answers to a paid AI service.
- Store anyone's personal data in this repo.

Setup and architecture are in [README.md](README.md) and [HANDOFF.md](HANDOFF.md).

## Current state

- 39 applications sent since September (as of 2026-11-17), 3 a day at most, and every one through my Submit tap.
- It runs every evening on its own: finding jobs, cleaning up the tracker, reading email (including Trash and
  Spam since 2026-11-18) and starting applications. Submit still works after the browser window has closed.
- On the 46 saved real forms, the agent fills 68% of fields itself, saved answers cover another 5%, and about
  2.5 questions per form still come to me.
- The answer bank lives in SQLite and reuses answers across companies; the local essay drafter scores 0.48 on
  its eval.
- Since 2026-11-18, Slack gets one "needs your attention" message when something breaks, and a stuck-run
  watchdog retries a fill that stops making progress.
- Weak spot: when I was busy for three days, nothing got applied. Every application waited on me and the
  waiting work expired.
- Next major objective: Stage 1, so a busy week still produces applications.

## Roadmap

### Stage 1 — Runs smoothly every day (next 1–2 weeks)

Goal: a busy week still produces applications, and my part takes about 5 minutes a day. The stage is done when,
for two weeks straight, every daily run starts its applications, questions average under 1.5 per form on the
replay set, and nothing waits more than a day without me hearing about it.

#### AA-001 — One daily question round-up

- **Status:** planned
- **Priority:** P1
- **Goal:** Every open question across every application goes into one Slack message, so I clear them in one
  sitting instead of a trickle all evening.

**Why it matters:** Questions trickling in all evening is why a busy few days stopped every application.

**Done when:**
- One Slack message lists every open question across all applications.
- Answering from that message unblocks the applications that were waiting.
- The test suite passes.

#### AA-002 — Confirm before saving an answer

- **Status:** planned
- **Priority:** P1
- **Goal:** The agent asks before saving an answer ("Save '100' for next time?") and offers a "remember this for
  every company?" button.

**Why it matters:** A typo or a joke ("100 lol") should never become a permanent answer.

**Done when:**
- No answer is saved to the answer bank without my confirmation.
- A "remember this for every company?" choice saves it across companies.
- The test suite passes.

#### AA-004 — Fewer questions per form

- **Status:** planned
- **Priority:** P1
- **Goal:** Cut the questions that reach me per form, using the form replay to find the common ones.

**Requirements:**
- Turn the common questions that still reach me into profile facts or standing answers.
- A standing answer for postings with no pay range.
- Hold drafts to a form's word or character limit (e.g. "150 words max").

**Done when:**
- Questions average under 1.5 per form on the replay set.
- The form replay shows no regressions.

**Out of scope:** Answering salary, legal or employer-specific questions without me seeing them.

#### AA-005 — Alerts when something breaks

- **Status:** done
- **Priority:** P1
- **Goal:** One Slack "needs your attention" message for an expired login, a dead job source, a run that got
  stuck twice, the listener crash-looping, or the local model not answering.

**Done when:**
- Each of those cases sends one alert, repeated at most once a day.
- A fill that stops making progress for 5 minutes is retried once.

**References:** 83b1e9f (alerts), 6bae53e (stuck-run watchdog), HANDOFF.md (2026-11-18)

#### AA-006 — Listener retries a busy database on startup

- **Status:** planned
- **Priority:** P2
- **Goal:** The Slack listener retries a busy database instead of crashing on startup.

**Done when:**
- A listener started while the database is busy waits and retries, and starts normally once it's free.
- The test suite passes.

#### AA-007 — Tidier inbox reading

- **Status:** planned
- **Priority:** P2
- **Goal:** Newsletters and webinars ("Evaluating agents with Langfuse") never count as interview requests.

**Done when:**
- A test with real newsletter and webinar emails classifies none of them as interview requests.
- Real interview requests are still recognized.

### Stage 2 — Better writing (weeks 2–4)

Goal: essay drafts I'd send with light edits, measured by the eval and not by feel. The stage is done when the
eval scores 0.75 or higher and no draft that reaches me invents a skill or an employer.

#### AA-008 — Story bank

- **Status:** planned
- **Priority:** P2
- **Goal:** A handful of short, true stories in the profile (this agent, the lost-update bug and the move to
  SQLite, PuckPulse's AI chat), so "tell us about a hard problem" questions have something to draw on.

**Done when:**
- The essay drafter uses a story from the bank for story questions in the eval set.
- The essay eval score doesn't drop.

#### AA-009 — Essay eval with an LLM judge

- **Status:** planned
- **Priority:** P2
- **Goal:** Re-run the essay eval against the 0.48 baseline after every change, and add an LLM-judge check on a
  simple rubric: grounded, specific, nothing made up.

**Done when:**
- The eval reports the rubric score alongside the six automatic checks.
- Running it after a change shows the result against the baseline.

**Out of scope:** Paid models for the judge.

#### AA-010 — A regression gate for prompts

- **Status:** planned
- **Priority:** P2
- **Goal:** A prompt change that lowers the eval score fails the tests, the same way the form replay catches
  form-filling regressions.

**Done when:**
- A deliberately worse prompt makes the test suite fail.

**Depends on:** AA-009

#### AA-011 — Try a bigger free model for essays

- **Status:** planned
- **Priority:** P3
- **Goal:** Llama 3.3 70B on Groq's free tier as an opt-in, with the local model as the default and the
  fallback.

**Why it matters:** The 7B local model writes stiffly and sometimes borrows the posting's claims as my
experience.

**Requirements:**
- Opt-in only; Ollama stays the default.
- Falls back to Ollama when Groq is down or rate-limited.

**Done when:**
- The eval compares both models, and the result decides whether it's worth sending data off the machine.

**Out of scope:** Paid tiers.

### Stage 3 — Earns more trust (weeks 4–8)

Goal: the agent can run without me watching the browser. The stage is done after a month of headless runs with
zero wrong answers caught on the Submit card.

#### AA-003 — Headless browser

- **Status:** planned
- **Priority:** P3
- **Goal:** No visible browser windows. I review through the Submit card and the handoff link.

**Why it matters:** Submit-after-the-window-closed already makes this workable. I want more trust in the agent
first.

**Requirements:**
- `ATELIER_EXECUTION_HEADLESS=true` and a host restart.

**Done when:**
- A month of headless runs with zero wrong answers caught on the Submit card.

#### AA-012 — More applications per day

- **Status:** planned
- **Priority:** P3
- **Goal:** Go from 3 to 5 a day, or add a midday run.

**Done when:**
- The daily limit is raised and the runs still stay within one role per company.

**Depends on:** AA-004 (questions per form low enough that more applications don't just mean more
interruptions)

#### AA-013 — Track what matters over time

- **Status:** planned
- **Priority:** P3
- **Goal:** Track questions per application, the share of applications that reach Submit with no questions,
  fixes I make on the Submit card, and interviews per application.

#### AA-014 — Workday support

- **Status:** idea
- **Priority:** P4
- **Goal:** Apply to Workday postings.

**Why it matters:** Big employers use it, but every company has its own Workday account with a password and
sign-in. Only worth doing if the numbers say Workday jobs are a large share of the good matches.

**Depends on:** AA-013

### Stage 4 — Other people can use it (2–3 months out)

Goal: someone who isn't me can install it and get their first application out in one evening. The stage is
done when one other person uses it for two weeks with only the docs to go on.

#### AA-015 — Setup a stranger can follow

- **Status:** planned
- **Priority:** P4
- **Goal:** One guided setup for the profile, résumés, Slack, Google and the local model.

**Requirements:**
- Personal data never enters the repo.
- Each user creates their own Google OAuth app.

**Depends on:** The open source vs. paid product decision below.

#### AA-016 — Résumé import into the profile

- **Status:** planned
- **Priority:** P4
- **Goal:** The most common form fields come straight from a résumé.

#### AA-017 — A short starter questionnaire

- **Status:** planned
- **Priority:** P4
- **Goal:** 10–15 questions (work authorization, demographics, location, salary approach and the never-changes
  facts) that, with the résumé, cover about half of what forms ask.

**References:** `career-agent:questionnaire`

#### AA-018 — Separate data per user

- **Status:** planned
- **Priority:** P4
- **Goal:** Profiles, jobs and applications are kept per user, as the answer bank already is (`owner_id`).

#### AA-019 — Docs, license and clear limits

- **Status:** planned
- **Priority:** P4
- **Goal:** Document what it does, what it never does, which job sites it supports, and a daily cap.

**Depends on:** The open source vs. paid product decision below.

#### AA-020 — A way to answer besides Slack

- **Status:** planned
- **Priority:** P4
- **Goal:** The same questions and buttons arrive by text message, since most job seekers don't use Slack.

## Future ideas

- Redo command: a Slack command to restart an application from scratch.
- Title-drift check: flag when the posting's title differs from the tracker row's.
- Structured output for unknown questions: map a question to a known answer topic as strict JSON with a
  confidence score; fill the stored answer, never the model's own text.
- One SQLite row per job instead of one JSON list per key, if the lists get slow.
- Screenshot (vision) fallback for forms the reader can't parse (declined 2026-11-07).
- Recruiter outreach: draft a short note to the hiring contact after applying, sent by me.

## Decisions I still need to make

- **Open source, paid product, or both?** This changes Stage 4 a lot. A hosted version needs Google's yearly
  security review for Gmail access and someone paying for model calls, and cloud servers hit far more CAPTCHAs.
  A local, open-source version avoids all three.
- **A no-questions lane?** Should an application with zero questions and no AI-written text be allowed to
  submit on its own, while everything else still waits for me? Not before Stage 3 is done.
- **Recruiter outreach?** Useful, but finding the right person, avoiding spam and protecting my reputation make
  it harder than it looks.
