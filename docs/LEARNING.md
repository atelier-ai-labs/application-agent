# Learning Log: Application Agent

What I've learned building the application agent (atelier-hq): what happened, why it matters, and
how I'd describe it in an interview. Newest first. PuckPulse's log lives in nhl-dashboard/docs/LEARNING.md.

---

## 2026-11-17 — How would a new user's answers get learned? Share the questions, never the answers

**The question.** Today the agent knows my answers because I've answered hundreds of form questions
over two months. If someone else signed up tomorrow, how would it learn theirs? A questionnaire of
"every question ever" isn't possible.

**The data.** I counted the questions in the 46 real forms the agent has saved (questions only,
never answers):
- 861 fields, but only **248 distinct questions** once the company name is taken out
- **180 of the 248 (73%) appeared on just one form**: company-specific questions and essays
- the 10 most common questions cover 41% of everything asked, the top 25 cover 52%, and the
  top 100 cover 73%

So a questionnaire has diminishing returns. A short one covers about half of every form, and no
length of questionnaire gets close to all of it.

**The design that follows from it, in three layers:**
1. **Résumé → profile.** Name, contact details, current company, school, links and the résumé
   file are 6 of the 15 most common fields.
2. **A short starter questionnaire** (10–15 questions): work authorization, sponsorship,
   demographics, location, salary strategy, and the never-changes facts (convictions, background
   checks, knowing anyone at the company).
3. **Learn as you go.** Everything else is asked the first time it appears and saved to that
   user's own answer bank, with risk tiers deciding what gets reused:
   - low risk: reused even when the wording differs
   - medium risk: reused only for the same question
   - high risk (salary, legal, employer-specific): never reused

   Questions per application fall with every application; the history report already tracks
   that number.

**The idea that makes many users work: share the questions, never the answers.** What the agent
learns about *questions* is general knowledge, and every user can benefit from it. "Do you know
anyone at X?" is a never-changes fact, "From where do you intend to work?" is a location question,
and Greenhouse has two domains. The *answers* stay private to each user. User #2 starts with
everything the forms have taught the agent and none of user #1's data.

**A lesson from the same day.** My answer to Arize's human check ("What is 10 times 10?") had been
saved as "100 lol". Every reply was saved word for word, so the joke would have been typed into the
next form that asked. At scale, the agent should confirm before saving ("Save '100' for next
time?"), and offer "remember this for every company?" for facts like "No, I don't know anyone
there".

**How I'd say it in an interview.** "Most form questions are long-tail: 73% of the distinct
questions in my data appeared on only one form, so no questionnaire covers them. I cover the head
with a résumé import and a short questionnaire, then learn the tail per user, with risk tiers that
decide what can be reused. The cross-user part is knowledge about questions, never answers, which
keeps the data private but still helps every new user."

---

## 2026-11-17 — An approval has to be tied to what was approved

**The problem.** The agent fills a form, posts a "ready to submit" card in Slack and keeps the
browser window open until I tap Submit. The host closes windows after 4 hours. I was busy for a
few days, so two finished applications (and six with questions) lost their windows, and a Submit tap
had nothing left to click.

**The obvious fix, and why it's wrong.** "If the window is gone, reopen it and submit." But my tap
approved a specific filled-in form: the values on the card. A reopened form isn't guaranteed to be the
same. The employer may have added a question, or the agent's rules may have changed since then and
would answer something differently. Submitting it would mean submitting something I never saw.

**What I built.** When the card is posted, the agent saves exactly what it showed: each field label
and value. On a Submit tap it first asks the browser host whether that window still exists. If not,
it reopens the same application, refills it from the saved answers, reads the form back, and
compares the two field by field:
- same → click Submit once, behind the same durable submission fence as before
- a date that moved (the start date is "two weeks from today") → allowed, and mentioned in the reply
- anything new, missing or different → no submit; post a fresh card with the current values instead
- the form now asks a new question → it goes to Slack like any other question
- all browser windows busy → put the old card back and say to tap again later

**Why it matters.** This is how human-in-the-loop systems stay trustworthy as they get more
automated. An approval isn't a general "yes, go ahead". It's a yes to a specific artifact, and the
system has to prove that what it acts on is that artifact. The same idea shows up as "plan, then
apply only that plan" in Terraform, or as optimistic concurrency: check that nothing changed since
you looked, otherwise ask again.

**How I'd say it in an interview.** "My agent needs human approval before submitting. Approvals
can arrive days later, after the browser session is gone. I bind each approval to a snapshot of the
filled form; on a late approval the agent rebuilds the form, diffs it against the snapshot, and only
acts on an exact match, with one explicit exception for dates. Anything else turns back into a new
approval request. It never acts on something the human didn't see."

---

## 2026-11-14 — Measuring the essay drafter: model-call logging and an eval

**The problem.** The application agent drafts essay answers with a small local model (qwen2.5:7b).
When a draft was bad, or silently dropped, there was no record of why, and "the new prompt reads
better" was a feeling, not a measurement.

**Step 1: log every model call.** Each call writes one line: what it was for, the model, a
*prompt version* (a hash of the prompt text, so any prompt edit gets a new version automatically),
the question, the outcome (drafted, or the exact reason it was dropped), the output and its quality
problems, latency, and token counts. Same idea as Langfuse tracing in PuckPulse, kept local and free.

**Step 2: an eval.** A fixed dataset of 13 real essay questions from my applications, each with its
public posting. A command drafts all of them with the real drafter and scores each draft with checks a
computer can verify: it drafted at all, length (or the question's word limit), no filler phrases, not
copied from the posting, *grounded* (it names no technology my profile doesn't), and names the company
on why-us questions. Results are saved, and a baseline lets later runs show what changed per case.

**What it found on the first run.** Overall 0.48. Grounding and copying were perfect; the big failure
was that 6 of 13 questions got no draft. The log showed why: on 4 story questions ("a hard problem",
"AI projects you're proud of") the model correctly said *insufficient evidence*. The missing piece
wasn't the prompt; it was the evidence the model receives. My best stories (this agent, PuckPulse's AI
chat) weren't in it.

**What I'd say in an interview.** "I added per-call logging with automatic prompt versions, then built
a small eval from real questions with deterministic checks for grounding, filler, copying and length.
The first run scored 0.48, and the logs showed most failures were missing evidence, not prompt quality,
so I fixed retrieval before touching the prompt. Every change is now a before-and-after number."

---

## 2026-11-17 — The same bug, one file over: moving the answer bank into SQLite

**What I found.** On 2026-11-10 I fixed a lost update in the agent's state by moving it to SQLite
(the entry below). The answer bank, where the agent keeps my reusable answers, was still a JSON
file with the same pattern: read the whole file, change it, write it all back. Two programs saving
at once could lose an answer. There was a worse failure too: a hand edit that broke the JSON was
read as an empty bank, and the next answer saved would overwrite the file with just that one
answer. That would wipe all 52.

**What I changed.**
- **A table instead of a file:** the bank is now the `answer_bank` table in the same SQLite
  database as the rest of the state, with one row per answer.
- **No "save the whole list" anymore:** a change is a function from the current answers to the
  new ones. The store runs it inside one `BEGIN IMMEDIATE` transaction against what is stored
  *now*, then writes only the rows that changed. A program holding an out-of-date copy can't erase
  anything, because its change is applied to the fresh rows.
- **Fail closed:** a row the code can't read is skipped, never deleted. The one-time import
  refuses a broken JSON file rather than starting with an empty bank.
- **Commands instead of hand edits:** `--set`, `--disable`, `--remove`, `--export`. Each is one
  atomic change, so they're safe while the agent is running.
- **An `owner_id` column:** it costs nothing today, and it's what separates users' answers once
  there are several (see the entry above).

**The migration, done like a production change.** I stopped the one process that writes the
bank, backed up both the file and the database, imported, and checked that the database matched
the backup entry for entry. Then I restarted on the new code and confirmed the form replay still
used the saved answers.

**How I'd say it in an interview.** "I found the lost-update bug I'd already fixed once, in a
second file. Rather than patching it, I moved that data into the same transactional store and
changed the interface, so 'save everything' isn't possible anymore. Every write is a change
function applied atomically to the current rows. I also made it fail closed, so unreadable data
is never treated as empty."

---

## 2026-11-10 — A lost update between two processes

**What happened.** I approved three Upstart applications from Slack at the same moment. Two
went through; the third was refused with "the durable submission fence is missing".

**Why.** Two background programs share one state file: the execution host (which drives the
browser) and the Slack listener. Each kept its own copy of the file in memory, and every save
rewrote the *whole file* from that copy. The host wrote a "fence" (a one-time ticket that makes
sure an application is never submitted twice), then a split second later the listener saved its
older copy, which didn't have the ticket, and erased it. This is the classic *lost update*
race: read, modify, write, with someone else writing in between.

**The fix.** Before each save, the program checks whether the file changed since it last read
it (a cheap check of the file's inode, size and modified time, because the file is 17 MB). If it
did, it re-reads, then applies only its own one-key change on top. I deliberately did *not* make
every save wait on the file lock: some maintenance commands hold the lock for minutes while a
browser runs, and the Slack listener would freeze and time out on button taps. Two new tests
reproduce the bug (they fail on the old code) and pass with the fix.

**Good to notice.** The failure was safe: with the ticket missing, the host refused to click
Submit rather than risk a duplicate. "Fail closed" is the point of the fence.

**What I'd say in an interview.** "Two processes shared a JSON state file and each wrote back
its whole stale snapshot, so one erased the other's write — a lost update. I made writes
re-read when the file changed and apply a single-key change, kept them non-blocking because a
maintenance command could hold the lock for minutes, and added a two-process regression test.
The real long-term answer is a store with atomic per-record writes, like SQLite."

**Follow-up, same night: the move to SQLite.** The state now lives in a SQLite database (built
into Node, no server). Three things fixed the class of bug for good: each save touches only its
own key; changing a list (read it, change one job, write it back) happens inside one short
`BEGIN IMMEDIATE` transaction, so SQLite puts competing writers in line instead of letting one
erase the other; and WAL mode lets readers keep reading while someone writes. A test runs two
real processes that each add 200 records to the same list at once; all 400 survive. Two
surprises: the one-time import's "read every value back and compare" check caught SQLite cutting
keys short at a hidden NUL character (fixed by storing bytes), and switching storage revealed that
some tests had been writing into the real state file (now they use a temporary database).
Interview line: "I verified the migration by reading every value back before retiring the old
file, and that check caught a data-loss bug before it shipped."
