# Career Agent execution graph audit

This document describes the execution path that exists in the codebase. It is
an audit and operating note, not a proposal for a generic graph runtime.

## Current path

```text
campaign run
   ├─ resume persisted needs-input jobs (serial; human/session state)
   ├─ discovery-started event
   ├─ bounded source fan-out
   │    ├─ source request + timeout
   │    │    └─ reference source: provider → classify → bounded ATS resolution
   │    └─ source result / cache / warnings
   ├─ deterministic normalize + dedupe reduction
   ├─ persist discovery summary + audit event
   └─ ordered new-job loop (shared caps and persistence)
        ├─ history check / observation merge
        ├─ deterministic hard filters
        ├─ grounded fit assessment
        ├─ deterministic pursuit policy
        ├─ application-cap check
        ├─ existing preparation core
        │    ├─ create/evaluate packet
        │    ├─ tailored resume → application answers
        │    └─ preparation blockers or ready-for-review
        ├─ executor / browser preparation
        │    └─ human login/CAPTCHA/input gate when required
        ├─ READY_TO_SUBMIT (final Submit lane closed)
        ├─ explicit manual submission confirmation
        └─ APPLIED → tracker sync (downstream, retryable, never proof)
```

`JobScout` now starts independent configured sources through
`mapWithConcurrencyLimit()` with a default limit of four. The result array is
still reduced in campaign `searchSources` order. `JobReferenceResolver` uses
the same kind of bound for independent URL resolutions, also defaulting to
four, while its per-batch response cache prevents repeated retrieval of the
same configured board/site.

## Node inventory

| Node | Responsibility | Input → output | Class | Current execution / reuse |
| --- | --- | --- | --- | --- |
| `campaign.run` | Own one caller-triggered campaign cycle | campaign ID → run result | orchestration / persistence | One run at a time at this boundary; trace is persisted on the campaign |
| `campaign.resume-blocked` | Revisit persisted blockers without rebuilding packets | career jobs → updated jobs | human gate | Serial because browser sessions, user state, and persistence are shared |
| `scout.source.<id>` | Request one source, enforce timeout, retain warnings/cache state | criteria → source batch | external I/O | Independent sources; bounded to four concurrent requests; failure is isolated |
| `references:<provider>` | Convert URL references into structured listings | references → validated listings/metrics | external I/O + deterministic validation | Provider-specific response shapes stop inside the source/resolver boundary |
| `reference.resolveMany` | Resolve independent Lever/Greenhouse references | references → ordered resolutions | external I/O | Bounded to four; shared response cache; result order follows input |
| `scout.reduce` | Normalize listings, classify actionability, merge duplicates | source listings → ordered jobs | deterministic | Runs after source fan-in; duplicate winner is not completion-order dependent |
| `scout.history-dedupe` | Compare the cycle against persisted career history | scouted jobs + history → new count | deterministic + persistence read | Reuses canonical identity/history; does not recreate applied jobs |
| `job.process.<n>` | Process one candidate through filters, fit, policy, preparation, and executor | one new job → career state | judgment + deterministic policy | Intentionally ordered because caps, IDs, events, and persistence are shared |
| `application.prepare` | Existing Application Agent packet preparation | normalized job + profile + fit → grounded packet | judgment/model boundary + persistence | Resume is produced before answers because answers consume the tailored resume; blocker resume reuses the packet |
| `application.execute` | Prepare/inspect an application through injected executor | prepared packet → blocker/ready/proof | external I/O / human gate | Lever browser session is isolated behind the executor and host; Submit remains closed |
| `application.manual-confirmation` | Record the user’s explicit successful submission confirmation | ready-to-submit job → applied job | human gate + persistence | Required; READY_TO_SUBMIT never implies APPLIED |
| `tracker.sync` | Record an already-applied application downstream | applied record → synced/failed tracker state | consequential external side effect | Runs after `application.applied`; failure preserves APPLIED and is retried alone |

The trace records the source nodes, reduction, history check, blocked-job
resume, and per-job processing boundary. It deliberately does not turn every
function or event into a graph node.

## Edge audit

| Edge | Current behavior | Finding | Change / evidence |
| --- | --- | --- | --- |
| source A → source B | Requests were already started with `Promise.all` | Resource-constrained, not a data dependency; unlimited fan-out was unsafe for external providers | Bounded concurrency, default four; controlled start/release test proves overlap and cap |
| source results → normalize/dedupe | Reduction waits for all source results | Required fan-in: the deterministic winner needs all observations | Preserved; source results are reduced in declared source order |
| reference A → reference B | `resolveMany` used unbounded `Promise.all` | Resource-constrained; references are independent unless they share a cached board response | Bounded concurrency, default four; shared response cache and input-order results preserved |
| discovery → history check | New admission depends on persisted history | Required state dependency | Preserved and traced |
| history check → job loop | New jobs are processed after the cycle-level check | Required for deterministic already-seen/applied handling | Preserved |
| job A → job B | Candidate jobs are processed serially | Resource-constrained by application caps, shared repository writes, event ordering, and possible browser/external state; parallelism could overshoot caps | Deliberately not parallelized; no reservation/reducer evidence justifies the added complexity |
| hard filter → fit | Fit follows a passing hard filter | Required: rejected/held jobs must not incur fit work | Preserved |
| fit → pursuit → preparation | Sequential | Required: pursuit consumes fit and preparation consumes the admitted job/policy state | Preserved |
| tailored resume → answers | Resume is generated first | Required in the current contract: answer drafting receives the tailored resume | Preserved |
| answer blocker → resume | A blocker can stop preparation | Accidental invalidation would be harmful, but the existing packet state already isolates it | Preserved successful resume/answers; blocker resolution does not regenerate them |
| preparation → browser execution | Browser work starts only after a grounded packet | Required data and authority dependency | Preserved |
| browser blocker → preparation | Browser blocker does not rebuild the packet | Local human/session gate | Preserved same-session resume where available |
| READY_TO_SUBMIT → manual confirmation | UI/user must confirm after external submission | Human-gated consequential edge | Preserved; no executor or tracker path crosses it |
| APPLIED → tracker | Tracker starts after validated/manual Applied evidence | Required downstream side effect; tracker is not submission evidence | Preserved; tracker failure is isolated and retryable |

## Reuse and failure isolation findings

The existing system already has the most important local-correction seams:

- malformed individual source listings become listing warnings while healthy
  listings continue;
- a failing source becomes a source-level failure while other sources remain
  usable;
- a failing Lever/Greenhouse reference does not invalidate unrelated
  references;
- a blocker in application preparation preserves the successful packet units;
- a browser blocker resumes the same host session when possible;
- tracker failure does not roll back APPLIED and does not repeat preparation;
- repeated discovery uses canonical/provider/content identity and suppresses
  already-applied jobs.

No new persistent partial-result system was justified by the audit. The only
new retry/reuse-related behavior in this phase is bounded reuse of the existing
per-batch source response cache during concurrent reference resolution.

## Trace and attention measurements

`domain/executionTrace.ts` provides a typed observation model:

- `ExecutionNodeTrace` records node ID/kind, timestamps, duration, outcome,
  derived exclusive duration, parent ID, attempt, typed reason codes, safe
  counters, cache hit, human-attention category, optional future model fields,
  and a safe metadata map;
- `ExecutionRunTrace.summary` is deterministic and reports total agent
  runtime, human wait separately, retry/failure/external/cache/attention
  counts, per-stage summaries, and the five slowest stages;
- persisted campaign state retains the latest trace plus a bounded last-five
  `runHistory`; malformed historical entries are isolated during rehydration;
  runtime validation rejects malformed traces.

`humanAttentionEvents` counts newly appended career events whose existing
attention policy marks them as attention-worthy. Each event receives a bounded
category such as `candidate_fact_missing`, `captcha`, `manual_submission`,
`tracker_failure`, or `operational_failure`. It counts blockers, review
conditions, ready-to-submit/manual gates, meaningful application failures, and
tracker failures according to the current event policy; it does not count
passive UI reads. Trace metadata contains IDs, counts, provider/source names,
and statuses only. It never contains profile content, answers, tokens, cookies,
resume contents, or page HTML.

## Instrumentation semantics

Instrumentation is attached to existing service, Scout, application-preparation,
browser-host, Lever, and tracker boundaries. It does not introduce a graph
runtime or alter ordering, caps, retries, browser actions, or submission
authority. The stable stage vocabulary currently emitted is:

```text
scout.total
scout.source-fanout
scout.source.<sourceId>
scout.reference-resolution
scout.reduce
scout.history-dedupe
job.total
job.persist-discovered
job.hard-filter
job.fit
job.pursuit-policy
job.application-create
job.application-evaluate
preparation.total
preparation.resume
preparation.answers
preparation.blocker-evaluation
preparation.validation
execution.policy-check
execution.host-start
execution.lever-execute
tracker.sync
tracker.retry
```

Node `durationMs` is inclusive elapsed time. A node with children receives a
derived `exclusiveDurationMs` after the union of its direct-child intervals is
removed. Stage `inclusiveDurationMs` is a sum and may overlap; stage
`wallClockDurationMs` is an interval union and is the safe value for
end-to-end reporting. Parent plus child durations must never be added as if
they were independent wall-clock work. Fixed-clock tests fall back to the
largest observed child duration when timestamp precision cannot show overlap.

External counters are attached only where the boundary owns an observable
request. Brave query count is taken from its existing query metrics; cached
responses and demo/in-memory sources do not claim external requests. Browser
network requests are not currently observable through the narrow browser
session contract. Host telemetry separately records preflight inspection,
Lever executor inspection, total browser-preparation work for each active
attempt, DOM/form inspection count, cancellation, and late completion.

Attempts represent repeated work on the same unit only: explicit browser or
application resume and tracker retry. A new campaign run starts at attempt one.
Human wait is derived from resolved blocker timestamps when both endpoints are
available and is kept out of the agent runtime duration. The optional model
fields remain absent for the current deterministic local implementations.

## Controlled benchmark evidence

`tests/execution-graph.test.ts` uses deferred local work rather than wall-clock
assertions. Four independent units with a limit of two start as two units,
begin the next unit as soon as one completes, and return `[0, 1, 2, 3]` even
when completion order is `[1, 0, 2, 3]`; observed maximum concurrency is two.
The source and reference tests apply the same controlled gates. This
demonstrates a two-wave critical path instead of four serial waves without
claiming a noisy real-network millisecond benchmark.

## Why there is no graph runtime

There is currently no generic graph/DAG runtime in Atelier HQ. The system has a
small number of clear, domain-specific boundaries and benefits from ordinary
bounded mapping, deterministic reduction, state transitions, and injected
adapters. Build a reusable graph runtime only after multiple Atelier projects
independently require the same node semantics, typed edges, retries, bounded
concurrency, correction loops, verification, and tracing—and the duplicated
implementation cost is measurable.

The next optimization should be selected from trace evidence, not from the
presence of this document. The current largest deliberate bottleneck is the
ordered per-job pipeline, which should remain unchanged until a safe cap
reservation/reducer design and real latency data justify revisiting it.
