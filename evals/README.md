# Evals harness (scaffold)

Offline evaluation harness for portfolio packaging. Exercises pure domain pipeline steps (URL classify, fit, answer policies, submit fail-closed) against PII-redacted golden fixtures. No Playwright, no live ATS, no network LLM calls by default.

## Quick start

```bash
npm install
npm run test:evals
```

This runs `vite-node evals/run.ts`, loads every `evals/golden/fixtures/*.json`, prints a baseline report (pass/fail + score), and **exits 0** unless you opt into hard failure:

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
  README.md                 ← you are here
  run.ts                    ← CLI entry
  runner.ts                 ← load fixtures → grade → SuiteReport
  types.ts
  graders/
    deterministic.ts        ← classify / fit / field-fill / submit-never-auto
    modelRubric.ts          ← groundedness + fit-vs-resume (mocked in CI)
  golden/
    README.md               ← how to grow to ≥20 fixtures
    schema.ts
    fixtures/
      01-classify-lever-url.json
      02-fit-strong-cloud.json
      03-submit-never-auto.json
```

## How to add a golden task

See [`golden/README.md`](./golden/README.md). Summary:

1. Add `evals/golden/fixtures/NN-slug.json` matching `golden/schema.ts`.
2. Use fake PII only (Alex Example / example.com).
3. Choose `kind` + `graders` (`deterministic` and/or `model_rubric`).
4. Re-run `npm run test:evals`.

## CI reporting (soft gate)

Workflow: [`.github/workflows/evals.yml`](../.github/workflows/evals.yml)

- Runs on pull_request + push to `main`.
- Uses `continue-on-error: true` so the job is **non-blocking** for required merge checks.
- Prints the same baseline report as local runs.
- Does **not** set `EVALS_FAIL_ON_ERROR` yet.

### Flip to blocking later

When Nate opts in:

1. In `.github/workflows/evals.yml`, remove `continue-on-error: true` (or set it to `false`).
2. Add `EVALS_FAIL_ON_ERROR: "1"` to the eval step `env`.
3. In GitHub **Settings → Branches → rulesets / protection**, mark the `evals` check as required.

Until then, treat the workflow as a baseline signal only.

## Safety invariants

- Submit policy remains fail-closed: fixture `03-submit-never-auto` asserts `authority: "never"` never allows auto-submit via `verifyPreparedApplication`.
- Deterministic graders import real domain modules under `application-agent/src/domain/*`.
- Out of scope for this job: new ATS executors, ScopeLock, live submit, Playwright, observability dashboards.

## Relation to `npm test`

`npm test` (vitest) is unchanged. Evals live under `evals/` and are **not** named `*.test.ts`, so the default vitest run does not pick them up. Use `npm run test:evals` explicitly.
