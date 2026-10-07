# Evals harness (scaffold)

Offline evaluation harness for portfolio packaging. Exercises pure domain pipeline steps (URL classify, fit, answer policies, submit fail-closed, Rippling DOM helpers, blocker handoff) against PII-redacted golden fixtures. No Playwright, no live ATS, no network LLM calls by default.

## Quick start

```bash
npm install
npm run test:evals
```

This runs `vite-node evals/run.ts`, loads every `evals/golden/fixtures/*.json` (**positives only**), prints a baseline report (pass/fail + score), writes `evals/baseline.json`, and **exits 0** unless you opt into hard failure:

```bash
EVALS_FAIL_ON_ERROR=1 npm run test:evals
```

Model / rubric grader stays mocked unless you set:

```bash
EVALS_MODEL_GRADER=live npm run test:evals   # reserved; live client not wired yet
```

## Fail-audit / known-bad negatives

`passRate=1` on a new suite is not trustworthy until graders are shown to FAIL on known-bad inputs.

| Suite | Script | Fixture dir | Success criteria |
| --- | --- | --- | --- |
| Positives | `npm run test:evals` | `evals/golden/fixtures/` | Soft report; writes `evals/baseline.json` |
| Negatives | `npm run test:evals:negatives` | `evals/golden/negative/` | **Every** fixture must FAIL; exit **1** if any unexpectedly PASSES; writes `evals/negative-baseline.json` |

Negatives are tagged `expectFail: true` and kept out of the positive loader so the soft baseline job stays green on the ~30 good fixtures.

```bash
npm run test:evals:negatives
```

Shipped known-bad fixtures:

1. `N01-submit-never-wrongly-allowed.json` — deterministic `submit_never_auto`: wrong `expected.allowed=true` under `authority: "never"`.
2. `N02-groundedness-invents-employer.json` — model_rubric `groundedness_mock`: draft invents employer / years not in profile.

See [`FAIL_AUDIT.md`](./FAIL_AUDIT.md) for the quoteable before/after proof snippet.

### Mock hardening note

`modelRubric` previously returned always-pass stubs for kinds with no rubric (`*_rubric_skipped`) and for `pass_k_variance_note`. Those paths now return `null` (skip) so they cannot inflate pass rates or hide fail-audit regressions. Groundedness mock fails hard on any `mustNotInventSkills` hit.

## Layout

```
evals/
  README.md                 <- you are here
  FAIL_AUDIT.md             <- fail-audit proof snippet
  run.ts                    <- CLI entry (positives + baseline.json)
  runNegatives.ts           <- fail-audit CLI (negatives must FAIL)
  runner.ts                 <- load fixtures -> grade -> SuiteReport + baseline artifact
  types.ts
  baseline.json             <- positive snapshot; CI re-writes/uploads on each run
  negative-baseline.json    <- fail-audit snapshot (failedCount must equal fixtureCount)
  graders/
    deterministic.ts        <- classify / fit / field-fill / submit / field_classify /
                               rippling_dom / blocker_policy / pass_k
    modelRubric.ts          <- groundedness + fit-vs-resume (mocked in CI; no always-pass stubs)
  golden/
    README.md               <- how to grow fixtures (#21+)
    schema.ts               <- expectFail?: boolean for negatives
    fixtures/               <- ≥20 golden positives
    negative/               <- known-bad fail-audit fixtures
```

## How to add a golden task (#21+)

See [`golden/README.md`](./golden/README.md). Summary:

1. Add `evals/golden/fixtures/NN-slug.json` matching `golden/schema.ts`.
2. Use fake PII only (Alex Example / example.com).
3. Choose `kind` + `graders` (`deterministic` and/or `model_rubric`).
4. Prefer extending an existing kind; add a small new kind only when needed (`field_classify`, `rippling_dom`, `blocker_policy`, `pass_k`).
5. Re-run `npm run test:evals` and commit the refreshed `evals/baseline.json`.

### How to add a known-bad (fail-audit) fixture

1. Add `evals/golden/negative/Nxx-slug.json` with `expectFail: true`.
2. Mutate a good fixture so domain logic / mock rubric **must** fail (wrong expected field, invented employer, etc.).
3. Run `npm run test:evals:negatives` — exit 0 only if all negatives FAIL.
4. Commit refreshed `evals/negative-baseline.json` + update `FAIL_AUDIT.md` if the snippet changes.

## Baseline recording

Every `npm run test:evals` run:

1. Prints the suite report + a one-line `evals baseline: fixtures=… passed=… failed=… passRate=…` summary.
2. Writes `evals/baseline.json` with pass/fail counts, pass rate, average score, and per-task rows.

CI (`.github/workflows/evals.yml`) echoes that summary line and uploads `evals/baseline.json` as the `evals-baseline` artifact. After the first green CI run on a branch, treat the uploaded artifact as the source of truth if it diverges from a stale committed file — then refresh the committed snapshot locally.

## CI reporting (soft gate)

Workflow: [`.github/workflows/evals.yml`](../.github/workflows/evals.yml)

- Runs on pull_request + push to `main`.
- Uses `continue-on-error: true` so the job is **non-blocking** for required merge checks.
- Positives: soft-report baseline, upload artifact.
- Negatives: intentional fail-audit step — **requires** known-bad fixtures to FAIL (step exits 1 if a negative PASSES). Job-level `continue-on-error` still keeps the merge path soft.
- Does **not** set `EVALS_FAIL_ON_ERROR` on positives yet.

### Flip to blocking later

When Nate opts in:

1. In `.github/workflows/evals.yml`, remove `continue-on-error: true` (or set it to `false`).
2. Add `EVALS_FAIL_ON_ERROR: "1"` to the positive eval step `env`.
3. Keep the negatives step (it already hard-fails on unexpected passes).
4. In GitHub **Settings -> Branches -> rulesets / protection**, mark the `evals` check as required.

Until then, treat the workflow as a baseline + fail-audit signal only.

## Safety invariants

- Submit policy remains fail-closed: fixture `03-submit-never-auto` asserts `authority: "never"` never allows auto-submit via `verifyPreparedApplication`.
- CAPTCHA / login walls must produce attention handoff (`14-*`), never silent skip.
- Deterministic graders import real domain modules under `application-agent/src/domain/*` and pure helpers from `application-agent/automation/ripplingDomHelpers.ts`.
- Out of scope for this job: new ATS executors, ScopeLock, live submit, Playwright in CI, observability dashboards.

## Relation to `npm test`

`npm test` (vitest) is unchanged. Evals live under `evals/` and are **not** named `*.test.ts`, so the default vitest run does not pick them up. Use `npm run test:evals` / `npm run test:evals:negatives` explicitly.
