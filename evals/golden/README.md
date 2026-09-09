# Golden fixtures

PII-redacted scenario fixtures for the offline evals harness.

## Layout

- `schema.ts` — TypeScript shapes for each `kind`
- `fixtures/*.json` — one golden task per file (v1 target ≥20)

## Adding a golden task (#21+)

1. Copy an existing fixture and give it a new `id` (`NN-short-slug.json`). Numbers may include letter suffixes (`09b-…`) — files sort lexicographically.
2. Set `kind` to one of:
   - `classify_url` — ATS URL shapes + Rippling org:posting identity
   - `assess_fit` — fit bands
   - `field_fill` — answer policies (`auto` / `ask` / `never_auto`)
   - `submit_policy` — fail-closed submit authority
   - `groundedness` — draft invent vs profile facts (model rubric mock)
   - `field_classify` — Lever/Rippling/Greenhouse field classification map
   - `rippling_dom` — opaque prompt candidates + Search remount distance math
   - `blocker_policy` — CAPTCHA/login → attention handoff (not silent skip)
   - `pass_k` — run a nested deterministic fixture k times; assert identical scores
3. Fill `input` / `expected` to match `schema.ts`.
4. List graders: `deterministic` and/or `model_rubric`.
5. Use **fake PII only** (e.g. Alex Example, `alex.example@example.com`). Never commit secrets, live campaign config, or private profiles.
6. Run `npm run test:evals`, confirm PASS, and commit the refreshed `evals/baseline.json`.

## Catalog themes (v1)

| Theme | Example kinds | Notes |
| --- | --- | --- |
| ATS URL shapes | `classify_url` | Lever / Greenhouse / Rippling locale vs org slug / identity match / malformed |
| Fit bands | `assess_fit` | strong / weak mismatch / empty JD |
| Answer policies | `field_fill` | auto / ask needs_input / never_auto |
| Field classification | `field_classify` | phone-country dialing, location, LinkedIn, legal, salary, prepare map |
| Rippling DOM | `rippling_dom` | opaque prompt extraction, remount uniqueness |
| Blocker handoff | `blocker_policy` | CAPTCHA / login wall → needs_input |
| Submit fail-closed | `submit_policy` | authority `never` always blocks |
| Groundedness | `groundedness` | no invent employers/years; work-auth + salary band grounding |
| Stability | `pass_k` | same fixture ×3 identical deterministic scores |

Keep fixtures self-contained and deterministic so CI stays offline.
