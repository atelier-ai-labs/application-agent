# Application Agent — Portfolio Case Study

**Role signal:** Applied AI / LLM / Forward-Deployed Engineer  
**Repo:** [atelier-ai-labs/application-agent](https://github.com/atelier-ai-labs/application-agent)  
**Status:** Human-in-the-loop only — prepare and review; **never auto-submit** applications.

> Sanitized public write-up. Private profile data, credentials, live campaign config, and employer-identifying dry-run details are omitted.

---

## Problem

Job applications across ATS providers (Greenhouse, Lever, Rippling, and others) are repetitive, brittle, and easy to get wrong: field classification, opaque custom questions, locale vs org-slug edge cases, and policy constraints (work auth, salary, legal attestations).

**Goal:** an agent that *prepares* high-quality applications end-to-end — ingest → fit → answers → form fill — then stops at a human gate before submit.

---

## What we built

A multi-step **tool-using agent** with deterministic policy gates:

| Stage | Responsibility |
|--------|----------------|
| Scout / ingest | Pull postings from supported sources |
| Fit | Score role vs resume; reject clear mismatches |
| Prepare | Classify fields, draft grounded answers, fill forms via browser prep |
| Attention | Route ambiguous / sensitive fields to human (`needs_input`) |
| Ready for review | Package for human approve/reject — **submit stays closed** |

**Hard constraints**

- Submit is **fail-closed** (no unsupervised click).
- Answers must be **grounded** in profile facts (no invented employers, years, or auth status).
- Sensitive fields (compensation, legal) prefer `needs_input` over guessing.

---

## Architecture (interview sketch)

```text
Posting sources → Fit scorer → Prepare (classifiers + LLM drafts + browser tools)
                                      ↓
                              needs_input / blocker
                                      ↓
                              ready_for_review ──► human ──► (manual) submit
                                      ↑
                         evals + traces + cost/latency
```

**Why this shape:** production agents fail on messy integrations and silent overconfidence. HITL + evals + traces are the product, not an afterthought.

---

## Evaluation (quality gates)

We treat agent quality like software quality: **versioned goldens + graders in CI**.

| Layer | What it covers |
|--------|----------------|
| Golden set | 30+ redacted fixtures across classifier, policy, fit, and groundedness |
| Deterministic graders | Field classification, fail-closed submit, schema / prepare contracts |
| Rubric graders | Fit plausibility, answer groundedness vs profile |
| Negatives | Known-bad fixtures (e.g. N01/N02) that **must fail** — proves graders aren’t always-pass stubs |
| Soft CI | Suite reports baseline without blocking main until opted in |

**Fail-audit:** intentional negatives fail; positives stay green. That check is what makes a `passRate=1` baseline trustworthy.

### Eval-driven fix (concrete story)

**Failure mode:** email address fields misclassified as **location**.  
**Signal:** suite task(s) failing under deterministic grading.  
**Fix:** classifier correction ([PR #5](https://github.com/atelier-ai-labs/application-agent/pull/5)).  
**Before → after:** **27 FAIL → PASS**; suite **30/31 → 31/31**.

This is the loop we want on a resume: *measure → fix → prove with regression goldens*.

---

## Observability & cost

Instrumented prep runs emit correlated **trace IDs** across scout → fit → prepare → attention → ready, plus portfolio-usable aggregates ([PR #4](https://github.com/atelier-ai-labs/application-agent/pull/4)).

**Sample dry-run artifact (illustrative — confirm pricing assumptions before citing externally):**

| Metric | Sample value |
|--------|----------------|
| Latency (p50) | ~3010 ms |
| Cost | ~$0.000722 / application-prep |
| Human-attention rate | 40% |
| Prepare-success rate | 80% |

**Assumptions to disclose in interviews:** token pricing table used for `$/prep`; sample size of the dry-run; environment (local/CI vs production ATS).

---

## Decisions we wouldn’t reverse

1. **HITL submit over “full auto.”** Safer, more hireable, and honest about ToS / irreversible actions.
2. **Evals before more ATS adapters.** Adapter sprawl without graders looks busy; eval-gated fixes convert to interview signal.
3. **Known-bad fixtures in the suite.** Always-green suites are a smell; negatives prove the harness.
4. **Sanitize the public story.** Depth stays in private ops; the case study shows system design, not someone else’s PII.

---

## What this demonstrates (JD mapping)

- Multi-step **agents + tool use** (browser prep, ATS variance)
- **Eval frameworks** and eval-driven development
- **Productionization:** policy gates, fail-closed submit, attention routing
- **Observability:** traces, latency, token/$ , success rates
- **Safety / groundedness:** no invented profile facts; human gates for sensitive fields

Relevant hiring themes (2026): Anthropic-style agent evals / FDE expectations; applied LLM eng screens that ask for measurable quality, not chat wrappers.

---

## What’s intentionally out of scope (for this write-up)

- Live unsupervised submit
- Private Slack campaign ops / resume contents
- Unrelated product experiments (e.g. ScopeLock) — separate PM signal

---

## How to explore the code

1. Read `evals/README.md` — how to add a golden and read CI output  
2. Review PRs: [#3](https://github.com/atelier-ai-labs/application-agent/pull/3) harness, [#4](https://github.com/atelier-ai-labs/application-agent/pull/4) metrics, [#5](https://github.com/atelier-ai-labs/application-agent/pull/5) eval-driven fix  
3. Optional: short redacted Loom of prepare → blocker → **manual** submit (never claim auto-submit)

---

## One-liner for resume / LinkedIn

> Built an eval-gated, HITL job-application agent (multi-ATS prep): golden-set graders in CI, trace/cost metrics, and an eval-driven classifier fix (email≠location) that moved the suite 30/31 → 31/31.
