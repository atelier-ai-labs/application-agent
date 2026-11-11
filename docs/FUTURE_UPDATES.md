# Future updates

These are ideas we've parked for later. None of them are scheduled; Nate picks what's next.

## For other users (open-source prep)

- **Story bank.** Users save a handful of short personal stories ("something I'm proud of", "a hard problem I solved", "something not on my résumé"). The essay drafter retrieves the best fit for questions a résumé can't answer.
  - Origin: Temporal's "Tell us something we won't learn from your resume" (2026-11-09).
  - Nate won't use it himself, but other users will need it.
- **Onboarding questionnaire for new users.** Common application answers are collected up front, built from the questions real forms ask most. `career-agent:questionnaire` is the start.
- **Setup that works on a stranger's machine.** One guided setup for Slack, Google Sheets, Gmail and Ollama.
  - Personal data stays out of the repo.
  - Each user creates their own Google OAuth app.
- **Texting interface.** iMessage, SMS or WhatsApp as an alternative to Slack, since most job seekers don't use Slack. The same questions, drafts and Approve/Skip/Done replies would arrive as texts. Inspired by the Pally/Monid iMessage agent (2026-11-10).
- **Reaching out to the hiring contact.** After applying, draft a short note to the recruiter or hiring manager for the user to send, and later help schedule a call.
  - Harder than demos make it look: finding the right person and their email, avoiding spam, and the user's reputation.
  - Draft-only, and the user sends it, like the Submit tap.
- **Docs, license and limits.** Document what it does, what it never does, the supported ATSs and a fixed daily cap.

## Agent behavior

- **Move the agent's state from `state.json` to SQLite (next infrastructure job).** The Slack listener, the browser host and one-off commands share one 17 MB JSON file, and every save rewrites the whole file from that program's own copy. Two saves close together wipe each other out. On 2026-11-10 this lost Upstart Delivery's submission fence, put back Affirm's old status, and helped make Latitude's question post every minute. Reads and writes were patched to re-read the file when it changes (f8cee38, 4c1caa7), but two programs changing the same list at the same moment can still collide.
  - SQLite is a free, serverless database in one local file. It saves one job or question at a time, and several programs can use it at once safely.
  - Google Sheets stays as the tracker and queue; nothing the user sees changes.
  - Do it in a quiet session, not during live applications. Keep a one-time import from `state.json` and a backup.

- **Bigger free model for essays (Groq).** Draft essays with Llama 3.3 70B on Groq's free tier instead of local qwen2.5:7b. The 7B model writes stiffly, copies the posting's slogans and sometimes borrows the posting's claims as the candidate's experience (Mercury and Temporal, 2026-11-09). Groq is already used free in PuckPulse.
  - Tradeoff: the profile, résumé evidence and the question leave the machine.
  - Make it opt-in, keep Ollama as the default, and fall back to Ollama when Groq is down or rate-limited.
  - Not urgent: Nate writes or edits the important essays himself, and other users can do the same.

- **Headless browser.** Set `ATELIER_EXECUTION_HEADLESS=true` and restart the host; review still happens through the handoff link. Planned for about 2026-11-14, after a week more of tuning.
- **Answer-length check.** Hold drafts to a form's word or character limit, e.g. "150 words max".
- **Redo command.** A Slack command to restart an application from scratch.
- **Standing no-range salary answer.** An answer for postings that list no pay range, so the agent doesn't have to ask.
- **Title-drift check.** Flag when the posting's title differs from the tracker row's, e.g. "AI Engineer" vs "Lead AI Engineer" at Reflow.
- **Per-company limits.** Space out applications to many roles at one company. Left as is on 2026-11-06.
- **Higher daily throughput.** Raise the limit from 3 to 5, or add a midday run.
- **Screenshot (vision) fallback.** For Workday or custom sites the form reader can't parse. Declined for now (2026-11-07).

## Applied-AI depth (interview material)

- **Essay eval.** A dataset of real questions and postings. Score drafts with simple checks plus an LLM judge on a rubric: grounded, specific, nothing made up.
- **Structured output for unknown questions.** The local model maps a question to a known answer topic as strict JSON with a confidence score. The stored answer is what gets filled, never the model's own text. Measured on the form replay set.
- **Log every model call.** Prompt version, inputs, output, latency and tokens.
- **Prompt versions plus a regression gate.** A prompt change that lowers the eval score fails the tests.
