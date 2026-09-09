# Fail-audit proof (grader can fail)

`passRate=1` on a brand-new suite is suspicious until known-bad fixtures prove graders can FAIL.

## Layout

| Path | Role |
| --- | --- |
| `evals/golden/fixtures/` | Positives — `npm run test:evals` |
| `evals/golden/negative/` | Known-bad (`expectFail: true`) — `npm run test:evals:negatives` |
| `evals/baseline.json` | Positive baseline (soft) |
| `evals/negative-baseline.json` | Fail-audit artifact (all must FAIL) |

## Known-bad fixtures

1. **`evals/golden/negative/N01-submit-never-wrongly-allowed.json`**
   - Grader: `deterministic` / `submit_never_auto`
   - Mutation: same `authority: "never"` input as good `03-submit-never-auto`, but `expected.allowed: true`
   - Domain: `verifyPreparedApplication` fail-closes → `gate.allowed === false`
   - Expectation mismatch → **FAIL** (`allowed=false` vs want `true`)

2. **`evals/golden/negative/N02-groundedness-invents-employer.json`**
   - Grader: `model_rubric` / `groundedness_mock`
   - Mutation of `18`/`19`: draft invents `FakeCorp`, `Acme Stealth Startup`, and `15 years`
   - Mock detects `mustNotInventSkills` hits → **FAIL** (`invented-skill:…`)

## Expected outcome (domain-derived; CI rewrites artifact)

```
=== positives (npm run test:evals) ===
evals baseline: fixtures=30 passed=30 failed=0 passRate=1 averageScore=1

=== negatives (npm run test:evals:negatives) ===
FAIL  N01-submit-never-wrongly-allowed  score=0.5  (submit_policy)
  - [deterministic/submit_never_auto] FAIL score=0.5
    FAIL:allowed=false; PASS:blocked:authority:never
FAIL  N02-groundedness-invents-employer  score=0.167  (groundedness)
  - [model_rubric/groundedness_mock] FAIL score=0.167
    invented-skill:FakeCorp; factHits=2/3
fail-audit OK: 2/2 known-bad fixtures correctly FAILED (0 unexpected passes).
```

## Mock hardening

Before: `modelRubric` returned **always-pass** for (a) kinds with no rubric (`*_rubric_skipped`) and (b) `pass_k_variance_note`.
After: those paths return `null` (skip) so they cannot inflate pass rates or mask fail-audit regressions. Groundedness mock already penalizes invented skills/employers/years and remains the fail path for `N02`.
