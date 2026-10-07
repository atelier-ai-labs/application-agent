# Golden fixtures

## Positives (`fixtures/`)

One JSON file per scenario. Loaded by `npm run test:evals`.

How to add (#21+):

1. Copy a nearby fixture of the same `kind`.
2. Use fake PII only (Alex Example / example.com).
3. Set `graders` to `deterministic` and/or `model_rubric`.
4. Re-run `npm run test:evals` and commit `evals/baseline.json`.

## Negatives (`negative/`)

Fail-audit known-bad cases with `expectFail: true`. Loaded **only** by `npm run test:evals:negatives`, which exits 1 if any unexpectedly PASSES.

See [`../FAIL_AUDIT.md`](../FAIL_AUDIT.md).
