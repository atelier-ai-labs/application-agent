# Golden fixtures

PII-redacted scenario fixtures for the offline evals harness.

## Layout

- `schema.ts` — TypeScript shapes for each `kind`
- `fixtures/*.json` — one golden task per file (2–3 starters; expand to ≥20)

## Adding a golden task

1. Copy an existing fixture and give it a new `id` (`NN-short-slug.json`).
2. Set `kind` to one of: `classify_url`, `assess_fit`, `field_fill`, `submit_policy`, `groundedness`.
3. Fill `input` / `expected` to match `schema.ts`.
4. List graders: `deterministic` and/or `model_rubric`.
5. Use **fake PII only** (e.g. Alex Example, `alex.example@example.com`). Never commit secrets, live campaign config, or private profiles.
6. Run `npm run test:evals` and confirm pass/fail + score in the report.

## Target catalog (≥20)

Suggested expansion themes (not implemented yet):

| Theme | Example kinds | Notes |
| --- | --- | --- |
| ATS URL shapes | `classify_url` | Lever / Greenhouse / Rippling / Ashby / Workday / custom / invalid |
| Fit bands | `assess_fit` | strong / good / stretch / weak; compound skills; gaps |
| Answer policies | `field_fill` | auto / draft_review / ask / never_auto |
| Submit fail-closed | `submit_policy` | authority `never` always blocks; approval_required |
| Groundedness | `groundedness` | draft invents skills vs stays on profile facts |

Keep fixtures self-contained and deterministic so CI stays offline.
