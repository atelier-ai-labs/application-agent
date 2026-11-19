# Roadmap

_Last updated: November 17, 2026_

This is the order I plan to build things in, and why. The long-term goal hasn't changed: an agent that finds jobs, fills out the applications, keeps the tracker up to date, and only needs me for the parts that really are mine to answer. After that, a version other people can use.

Each stage has a goal and a way to tell it's done. Ideas without a stage live in [FUTURE_UPDATES.md](FUTURE_UPDATES.md). Things this agent will never do are at the bottom.

## Where it is today

- 39 applications sent since September, and 3 today.
- It runs every evening on its own: finding jobs, cleaning up the tracker, reading email, and starting applications.
- I approve every submission. The Submit button works even after the browser window has closed.
- On the 46 real forms it has saved, the agent fills **68%** of the fields itself, saved answers cover another **5%**, and about **2.5 questions per form** still come to me.
- The local essay drafter scores **0.48** on its eval. Most of the misses are story questions it has no material for.

The last few days showed the weak spot. When I was busy for three days, nothing got applied: every application waited on me, and the waiting work expired. Stage 1 is about that.

---

## Stage 1: Runs smoothly every day (next 1–2 weeks)

**Goal:** a busy week still produces applications, and my part takes about 5 minutes a day.

- **One daily question round-up.** Every open question across every application goes into one Slack message, so I clear them in one sitting instead of a trickle all evening.
- **Fewer questions per form.**
  - Go through the questions that still reach me, using the form replay, and turn the common ones into profile facts or standing answers.
  - A standing answer for postings with no pay range.
  - Hold drafts to a form's word limit.
- **Alerts when something breaks.** _Done 2026-11-18._ Slack gets one "needs your attention" message for: an expired login, a dead job source, a run that got stuck twice, the listener crash-looping, or the local model not answering. A **stuck-run watchdog** also retries a fill that stops making progress for 5 minutes.
  - Still to do: the Slack listener should retry a busy database instead of crashing on startup.
- **Tidier inbox reading.** Newsletters and webinars ("Evaluating agents with Langfuse") never count as interview requests.
- **Confirm before saving an answer**, plus a "remember this for every company?" button. A typo or a joke ("100 lol") never becomes a permanent answer.

**Done when:** for two weeks straight, every daily run starts its applications, questions average **under 1.5 per form** on the replay set, and nothing waits more than a day without me hearing about it.

## Stage 2: Better writing (weeks 2–4)

**Goal:** essay drafts I'd send with light edits, measured by the eval and not by feel.

- **Story bank.** A handful of short, true stories in the profile (this agent, the lost-update bug and the move to SQLite, PuckPulse's AI chat), so "tell us about a hard problem" questions have something to draw on.
- **Re-run the essay eval against the 0.48 baseline** after every change. Add an LLM-judge check on a simple rubric: grounded, specific, nothing made up.
- **A regression gate.** A prompt change that lowers the eval score fails the tests, the same way the form replay catches form-filling regressions.
- **Try a bigger free model** (Llama 3.3 70B on Groq's free tier) as an opt-in, with the local model as the default and the fallback. The eval decides whether it's worth sending data off the machine.

**Done when:** the eval scores **0.75 or higher**, and no draft that reaches me invents a skill or an employer.

## Stage 3: Earns more trust (weeks 4–8)

**Goal:** the agent can run without me watching the browser.

- **Headless browser.** No visible windows. I review through the Submit card and the handoff link, and Submit-after-the-window-closed already makes this workable.
- **More applications per day.** Go from 3 to 5, or add a midday run, once questions per form are low enough that more applications don't just mean more interruptions.
- **Track what matters over time:**
  - questions per application
  - share of applications that reach Submit with no questions
  - fixes I make on the Submit card
  - interviews per application
- **Workday, maybe.** Big employers use it, but every company has its own Workday account with a password and sign-in. It's only worth doing if the numbers say Workday jobs are a large share of the good matches.

**Done when:** a month of headless runs with **zero wrong answers** caught on the Submit card.

## Stage 4: Other people can use it (2–3 months out)

**Goal:** someone who isn't me can install it and get their first application out in one evening.

The idea that makes this work is **share the questions, never the answers.** What the agent learns about forms helps everyone: which questions are standing facts, how to read a strange dropdown, that Greenhouse has two domains. Each person's answers stay theirs.

- **Setup a stranger can follow.** One guided setup for the profile, résumés, Slack, Google and the local model. Personal data never enters the repo.
- **Résumé import → profile.** The most common form fields come straight from a résumé.
- **A short starter questionnaire** (10–15 questions): work authorization, demographics, location, salary approach, and the never-changes facts. Together with the résumé, that covers about half of what forms ask. The agent learns the rest as it goes.
- **Separate data per user.** The answer bank already has an `owner_id` column. Profiles, jobs and applications need the same.
- **Docs, license and clear limits.** What it does, what it never does, which job sites it supports, and a daily cap.
- **A way to answer besides Slack.** Most job seekers don't use Slack, so the same questions and buttons would come by text message.

**Done when:** one other person uses it for two weeks with only the docs to go on.

---

## Decisions I still need to make

- **Open source, paid product, or both?** This changes Stage 4 a lot. A hosted version needs Google's yearly security review for Gmail access and someone paying for model calls, and cloud servers hit far more CAPTCHAs. A local, open-source version avoids all three.
- **A no-questions lane?** Should an application with zero questions and no AI-written text be allowed to submit on its own, while everything else still waits for me? Not before Stage 3 is done.
- **Recruiter outreach?** Drafting a short note to the hiring contact after applying, sent by me. It's useful, but finding the right person, avoiding spam, and protecting my reputation make it harder than it looks.

## What this agent will never do

- Submit an application I haven't approved (unless I deliberately make the no-questions-lane call above).
- Guess an answer it doesn't know, or claim experience I don't have.
- Answer salary, legal, or employer-specific questions from memory without me seeing them.
- Mass-apply. One role per company, best fit only, a few a day.
- Send my email, résumé or answers to a paid AI service.
- Store anyone's personal data in this repo.
