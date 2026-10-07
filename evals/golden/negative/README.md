# Known-bad (fail-audit) fixtures

These fixtures **must FAIL** grading. Loaded only by `npm run test:evals:negatives`.

- Tag each with `"expectFail": true`.
- Do **not** put them under `fixtures/` — positives stay green for soft baseline.
- See [`../../FAIL_AUDIT.md`](../../FAIL_AUDIT.md) and [`../../README.md`](../../README.md) § Fail-audit.
