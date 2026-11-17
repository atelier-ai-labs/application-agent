# Learning Log: Application Agent

What I've learned building the application agent (atelier-hq): what happened, why it matters, and
how I'd describe it in an interview. Newest first. PuckPulse's log lives in nhl-dashboard/docs/LEARNING.md.

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
