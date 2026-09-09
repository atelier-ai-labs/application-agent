# Evals harness (scaffold)

Offline evaluation harness for portfolio packaging. Exercises pure domain pipeline steps (URL classify, fit, answer policies, submit fail-closed, Rippling DOM helpers, blocker handoff) against PII-redacted golden fixtures. No Playwright, no live ATS, no network LLM calls by default.

## Quick start

```bash
npm install
npm run test:evals
```

This runs `vite-node evals/run.ts`, loads every `evals/golden/fixtures/*.json`, prints a baseline report (pass/fail + score), writes `evals/baseline.json`, and **exits 0** unless you opt into hard failure:

```bash
EVALS_FAIL_ON_ERROR=1 npm run test:evals
```

Model / rubric grader stays mocked unless you set:

```bash
EVALS_MODEL_GRADER=live npm run test:evals   # reserved; live client not wired yet
```

## Layout

```
evals/
  README.md                 <- you are here
  run.ts                    <- CLI entry (also writes baseline.json)
  runner.ts                 <- load fixtures -> grade -> SuiteReport + baseline artifact
  types.ts
  baseline.json             <- committed snapshot; CI re-writes/uploads on each run
  graders/
    deterministic.ts        <- classify / fit / field-fill / submit / field_classify /
                               rippling_dom / blocker_policy / pass_k
    modelRubric.ts          <- groundedness + fit-vs-resume (mocked in CI)
  golden/
    README.md               <- how to grow fixtures (#21+)
    schema.ts
    fixtures/               <- ≥20 golden tasks
```

## How to add a golden task (#21+)

See [`golden/README.md`](./golden/README.md). Summary:

1. Add `evals/golden/fixtures/NN-slug.json` matching `golden/schema.ts`.
2. Use fake PII only (Alex Example / example.com).
3. Choose `kind` + `graders` (`deterministic` and/or `model_rubric`).
4. Prefer extending an existing kind; add a small new kind only when needed (`field_classify`, `rippling_dom`, `blocker_policy`, `pass_k`).
5. Re-run `npm run test:evals` and commit the refreshed `evals/baseline.json`.

## Baseline recording

Every `npm run test:evals` run:

1. Prints the suite report + a one-line `evals baseline: fixtures=… passed=… failed=… passRate=…` summary.
2. Writes `evals/baseline.json` with pass/fail counts, pass rate, average score, and per-task rows.

CI (`.github/workflows/evals.yml`) echoes that summary line and uploads `evals/baseline.json` as the `evals-baseline` artifact. After the first green CI run on a branch, treat the uploaded artifact as the source of truth if it diverges from a stale committed file — then refresh the committed snapshot locally.

## CI reporting (soft gate)

Workflow: [`.github/workflows/evals.yml`](../.github/workflows/evals.yml)

- Runs on pull_request + push to `main`.
- Uses `continue-on-error: true` so the job is **non-blocking** for required merge checks.
- Prints the baseline report, echoes the summary line, uploads `evals/baseline.json`.
- Does **not** set `EVALS_FAIL_ON_ERROR` yet.

### Flip to blocking later

When Nate opts in:

1. In `.github/workflows/evals.yml`, remove `continue-on-error: true` (or set it to `false`).
2. Add `EVALS_FAIL_ON_ERROR: "1"` to the eval step `env`.
3. In GitHub **Settings -> Branches -> rulesets / protection**, mark the `evals` check as required.

Until then, treat the workflow as a baseline signal only.

## Safety invariants

- Submit policy remains fail-closed: fixture `03-submit-never-auto` asserts `authority: "never"` never allows auto-submit via `verifyPreparedApplication`.
- CAPTCHA / login walls must produce attention handoff (`14-*`), never silent skip.
- Deterministic graders import real domain modules under `application-agent/src/domain/*` and pure helpers from `application-agent/automation/ripplingDomHelpers.ts`.
- Out of scope for this job: new ATS executors, ScopeLock, live submit, Playwright in CI, observability dashboards.

## Relation to `npm test`

`npm test` (vitest) is unchanged. Evals live under `evals/` and are **not** named `*.test.ts`, so the default vitest run does not pick them up. Use `npm run test:evals` explicitly.
