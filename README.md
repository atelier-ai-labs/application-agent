# Application Agent

Applying to jobs is mostly the same 40 form fields over and over. You type your name, upload a resume, say you're authorized to work in the US, say you're not a veteran, explain how you heard about the job, and then write one or two essays at the bottom. I wanted an agent that does the boring 90% for me and asks me about the rest.

This repo is that agent. It finds jobs, fills out the applications in a real browser, and messages me on Slack when it needs something. It never hits Submit on its own. I approve every application myself, either with a button in Slack or by clicking Submit in the browser window.

It's been running every evening on my PC since September 2026, and it has sent 36 real applications so far.

## What a normal day looks like

At 5:30pm a timer kicks off the daily run:

1. **Find jobs.** It searches free job feeds and the public job boards of companies I've listed (Greenhouse, Lever, and Ashby). It throws out anything that isn't a fit: contract or part-time roles, titles I've excluded, jobs that ask for more than 5 years of experience, companies on my "no thanks" list, and companies I've already applied to 3 times in the last 60 days.
2. **Clean up the tracker.** It checks which postings have closed and marks them Expired in my Google Sheet.
3. **Read my email.** It looks for rejections, interview requests and "thanks for applying" emails, and updates the sheet. It only reads; it never sends or deletes anything.
4. **Start applications.** It opens the best-fit jobs in a browser (up to 3 at once) and fills in everything it can.
5. **Ask me the rest.** Anything it doesn't know goes to Slack. Multiple-choice questions show up as buttons, and essay questions come with a draft I can edit or approve. When a form is done, it posts a card with a **Submit** button.

My part is usually a few taps on my phone.

## How it decides what to fill in

The rule is simple: **never guess**. Every answer comes from one of these places, or the agent asks me:

- **My profile.** Name, contact info, work history, education, links, and work authorization.
- **Standing answers.** Facts that never change, like "No, I've never been convicted of a felony" or "Yes, I'm fine with a background check." I set these once by hand. The agent never learns them on its own.
- **The answer bank.** Every answer I give in Slack gets saved and reused the next time a similar question shows up. How much it reuses depends on the risk:
  - **Low risk** ("How did you hear about us?"): reused even when the wording is different.
  - **Medium risk** ("Years of Python experience"): reused only for the exact same question.
  - **High risk** (salary, legal attestations, anything specific to one employer): never saved and never reused.
- **A local model for essays.** Essay drafts come from a small open model running on my own machine through Ollama (qwen2.5:7b), so there are no API bills. The draft is only allowed to use facts from my profile. Code checks it before I ever see it and throws it out if it invents a skill, copies the job posting, runs too long, or reads like filler ("I'm passionate about leveraging…"). In that case, I get the question with no draft.

## Things I've learned building it

Most of the work hasn't been the AI part. It's been the messy parts around it:

- **Every job site is different.** Greenhouse, Lever, Ashby, Rippling, and Workday all build their forms differently, and every company adds its own strange questions. A lot of this codebase is just learning to read those forms correctly. One example: the answer "Man" was matching the option "Cis-man".
- **Two programs, one file, lost data.** The Slack listener and the browser each kept their own copy of the shared state file and saved the whole thing back. One would quietly erase what the other had just written. Moving the state into SQLite, with small transactions, fixed it for good. I wrote up the whole bug in [docs/LEARNING.md](docs/LEARNING.md).
- **You can't improve what you don't measure.** Every model call is now logged with its prompt version, its outcome, how long it took, and how many tokens it used. There's also a small eval: 13 real essay questions, scored by checks that don't need a human. The first baseline was 0.48 out of 1. The main reason was that the model kept refusing to write story questions because it didn't have my stories to work with. That's the next thing to fix.
- **Tests from real forms.** Every form the agent opens gets saved (just the questions, never my answers). After I change a rule, I replay all of them to make sure the change didn't break a form that used to work.

## Where it stands

**Working well:**
- Finding and filtering jobs.
- Filling forms on Greenhouse, Lever, Ashby, and Rippling.
- The Slack questions and the Submit button.
- Keeping the tracker up to date from email.

**Still rough:**
- **Browser windows time out.** A finished application waits in a browser window, and after 4 hours that window closes on its own. Then I have to reopen it.
- **Workday.** It usually wants an account and a login before it shows you the form.
- **Essays.** The drafts still need my stories in the profile before they're good.
- **Headless mode.** I still watch the browser windows. I'm not ready to let it run without them yet.

## Running it yourself

You'll need Node 20+, and Ollama if you want essay drafts. The agent expects these:
- a private profile file (see [`profile.example.json`](application-agent/profile.example.json))
- your resumes
- a Slack app
- Google OAuth for the Sheet and Gmail

None of that is in the repo.

```bash
npm install
cp .env.example .env.local   # then fill it in
npm test
```

The pieces run as three background services:

```bash
npm run career-agent:executor   # the browser host, on 127.0.0.1:8787
npm run career-agent:runtime    # the Slack listener and shared state
npm run career-agent:daily      # one full daily run (find, clean up, read email, apply)
```

On Linux there are systemd unit files in [`application-agent/automation/runtime/`](application-agent/automation/runtime/) that run the host and listener all the time and the daily run at 5:30pm.

Some other useful commands:

| Command | What it does |
| --- | --- |
| `npm run career-agent:discover` | Shows which jobs it would add and why it skipped the rest (add `-- --apply` to actually add them) |
| `npm run career-agent:inbox` | Dry run of the email check |
| `npm run career-agent:replay -- --quiet` | Replays every saved form against the current code |
| `npm run career-agent:eval-essays` | Runs the essay eval and compares it with the last baseline |
| `npm run career-agent:answers` | Lists the answer bank; `-- --help` shows how to change, turn off or remove an answer |
| `npm run career-agent:history` | Builds an HTML report of every application so far |

## Where to read more

- [docs/REFERENCE.md](docs/REFERENCE.md): every config file and environment variable, in detail.
- [application-agent/README.md](application-agent/README.md) and [application-agent/automation/README.md](application-agent/automation/README.md): how the agent and its services fit together.
- [docs/CASE_STUDY.md](docs/CASE_STUDY.md): the short portfolio version.
- [docs/LEARNING.md](docs/LEARNING.md): notes on the bugs that taught me something.
- [docs/ROADMAP.md](docs/ROADMAP.md): what's next, in order, and how I'll know each stage is done.
- [docs/FUTURE_UPDATES.md](docs/FUTURE_UPDATES.md): ideas I've parked for later.

The repo also has a small React dashboard (`npm run dev`) that started as a hub for my other projects. That's where the "Atelier HQ" name in some files comes from.
