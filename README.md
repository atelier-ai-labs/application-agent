# Atelier HQ

Atelier HQ is a small React operations surface for Atelier AI Labs. Its original department signals are read-only, while the Career Agent keeps campaign state browser-local and can discover postings from configured live public feeds, an optional bounded server-side web-search reference source, or a deterministic demo source; each boundary remains explicit about provenance and external side effects.

The first registry entries are:

- **Application Agent** — a local, grounded workspace that prepares job applications for human review.
- **NHL Intelligence** — a grounded conversational layer over structured NHL statistics.
- **Quant Intelligence** — a quantitative research and backtesting platform with persisted experiment context.

No project data is bundled in the application. If an API is missing, unreachable, slow, empty, or malformed, that department remains visible and its signal is rendered as unavailable (or stale when an older validated response can be retained).

## Run locally

Requirements: Node.js 20+ and npm.

```bash
npm install
cp .env.example .env.local
npm run dev
```

The NHL adapter uses the verified public NHL Dashboard API by default. Quant Intelligence is local-only by default; set `VITE_QUANT_API_BASE_URL` when its API is running locally. Application Agent uses browser-local persistence. Real Lever browser preparation, Google Sheets tracking, and optional broad URL discovery are separate loopback Node-host capabilities; the browser UI never receives their credentials.

Useful commands:

```bash
npm run test
npm run build
npm run preview
# After configuring a Google OAuth desktop-client JSON:
npm run career-agent:google-auth
```

## Environment variables

The `VITE_*` values are browser-readable service roots; do not place API keys, bearer tokens, or other secrets in them. `ATELIER_*` values are read only by the local Node execution host and are not bundled by Vite.

| Variable | Purpose |
| --- | --- |
| `VITE_NHL_API_BASE_URL` | Optional override for the verified NHL Dashboard API service root. The default is `https://nhl-dashboard-api.bravecoast-a5240643.westus2.azurecontainerapps.io`. HQ requests only `GET /standings/latest`. |
| `VITE_QUANT_API_BASE_URL` | Optional Quant Intelligence API service root. HQ requests `GET /api/experiments`, then `GET /api/experiments/{experiment_id}`. Leave blank when the local Quant API is not running. |
| `VITE_REMOTIVE_API_BASE_URL` | Optional override for the public Remotive job feed. Defaults to `https://remotive.com/api/remote-jobs`; no credential is required. |
| `VITE_LEVER_SITES` | Optional comma-separated Lever public SITE identifiers for targeted employer feeds. Blank keeps Lever disabled. |
| `VITE_LEVER_API_BASE_URL` | Optional override for Lever's public postings base URL. Defaults to `https://api.lever.co/v0/postings`; no credential is required. |
| `VITE_GREENHOUSE_BOARDS` | Optional comma-separated Greenhouse board tokens for targeted employer feeds. Blank keeps Greenhouse disabled. |
| `VITE_GREENHOUSE_API_BASE_URL` | Optional override for Greenhouse's public Job Board API base URL. Defaults to `https://boards-api.greenhouse.io/v1/boards`; no credential is required for GET requests. |
| `VITE_BROAD_DISCOVERY_ENABLED` | Set `true` to include the bounded Brave broad-reference source in newly created live campaigns. It remains disabled by default. |
| `VITE_EXECUTION_HOST_BASE_URL` | Optional loopback execution-host URL. Defaults to `http://127.0.0.1:8787`; the UI never falls back to simulation when this host is unavailable. |

The optional broad source is server-only beyond its opt-in flag:

| Variable | Purpose |
| --- | --- |
| `ATELIER_BRAVE_SEARCH_API_KEY` | Server-only Brave Search Web API subscription token. Required for live broad discovery; never put it in a `VITE_` variable. |
| `ATELIER_BRAVE_SEARCH_API_BASE_URL` | HTTPS endpoint override; defaults to `https://api.search.brave.com/res/v1/web/search`. |
| `ATELIER_BRAVE_SEARCH_MAX_QUERIES` | Maximum generated queries per cycle; default `3`, bounded to `1..10`. |
| `ATELIER_BRAVE_SEARCH_MAX_RESULTS_PER_QUERY` | Maximum provider results requested per query; default `10`, bounded to `1..20`. |
| `ATELIER_BRAVE_SEARCH_MAX_TOTAL_REFERENCES` | Maximum accepted URL references per cycle; default `30`, bounded to `1..200`. |
| `ATELIER_BRAVE_SEARCH_CACHE_TTL_MS` | In-memory reuse window for successful/empty/partial responses; default `300000` (five minutes). Set `0` to disable. |
| `ATELIER_BRAVE_SEARCH_TIMEOUT_MS` | Per-query timeout; default `8000`. |
| `ATELIER_BRAVE_SEARCH_COUNTRY` / `ATELIER_BRAVE_SEARCH_LANGUAGE` | Optional Brave search locale controls; defaults are `US` and `en`. |

The Node execution host also reads these server-only Google Sheets variables:

| Variable | Purpose |
| --- | --- |
| `ATELIER_GOOGLE_SHEET_ID` | Existing canonical spreadsheet ID; no sheet is created by HQ. |
| `ATELIER_GOOGLE_SHEET_NAME` | Exact spreadsheet title guard; defaults to `Nate Job Search Tracker`. |
| `ATELIER_GOOGLE_SHEET_TAB` | Exact tracker tab; defaults to `Job Tracker`. |
| `ATELIER_GOOGLE_AUTH_MODE` | Explicit credential lane: preferred `oauth`, or retained `service_account` / `access_token`. Required when multiple lanes are configured. |
| `ATELIER_GOOGLE_OAUTH_CLIENT_FILE` | Server-only Google Desktop OAuth client JSON. Defaults to `.local/google-oauth-client.json`; never commit it. |
| `ATELIER_GOOGLE_TOKEN_FILE` | Server-only OAuth token path. Defaults to `.local/google-sheets-token.json`; never expose it to Vite. |
| `ATELIER_GOOGLE_APPLICATION_CREDENTIALS` | Retained alternative: path to a service-account JSON file that has access to the sheet. Keep it outside source control. |
| `ATELIER_GOOGLE_ACCESS_TOKEN` | Retained debugging alternative: short-lived server-only OAuth access token. Never expose it through Vite. |
| `ATELIER_GOOGLE_SHEETS_TIMEOUT_MS` | Google API/OAuth timeout; defaults to `10000`. |

Personal OAuth is the preferred local mode. Put a Google OAuth Desktop client
JSON at the configured server-only path, set the spreadsheet ID and
`ATELIER_GOOGLE_AUTH_MODE=oauth`, then run `npm run career-agent:google-auth`.
The command opens a Google authorization page, receives a loopback callback,
and stores a refreshable token under a private ignored path. The exact scope is
`https://www.googleapis.com/auth/spreadsheets`; no Google Drive scope is
requested. The current checkout has no local OAuth client or token configured,
so the connected Sheets workflow was used for the controlled live
read/write/readback verification; the local Node OAuth path is not claimed as
authorized until its own client/token are configured. See
[`application-agent/automation/README.md`](application-agent/automation/README.md)
for authentication, ownership, identity, and retry behavior.

The real browser host reads `ATELIER_EXECUTION_HOST`, `ATELIER_EXECUTION_PORT`, `ATELIER_EXECUTION_ALLOWED_ORIGINS`, `ATELIER_EXECUTION_ALLOW_NON_LOOPBACK`, `ATELIER_EXECUTION_HEADLESS`, `ATELIER_EXECUTION_MAX_CONCURRENT`, `ATELIER_EXECUTION_SESSION_TIMEOUT_MS`, and optional `ATELIER_RESUME_ROOT` plus resume-family paths. See [`application-agent/automation/README.md`](application-agent/automation/README.md). It binds to loopback by default, requires an explicit opt-in for non-loopback binding, permits only exact configured Vite origins, and keeps browser handles/session state in process memory.

Configured URLs must be `http` or `https` URLs and must allow browser CORS. The frontend only requests known paths on the configured service roots; it does not accept arbitrary URLs from users.

## Verified project links

- NHL Intelligence repository: <https://github.com/atelier-ai-labs/nhl-intelligence>
- NHL public interface: <https://ashy-sky-01e4eba1e.7.azurestaticapps.net>
- NHL Intelligence service health: <https://nhl-intelligence-kaxll7b4fq-uk.a.run.app/health>
- Quant Intelligence repository: <https://github.com/atelier-ai-labs/quant-intelligence>

No Quant deployment URL is currently represented in its canonical repository, so HQ intentionally does not show one.

## Architecture

The data path is intentionally small:

```text
department registry → project-specific adapter → normalized snapshot → shared UI
```

### Registry

`src/departments/config.ts` is the central registry. Each `DepartmentConfig` contains static metadata such as the name, description, project status, tech stack, verified links, adapter ID, API base URL, and future capability names. Only passive capabilities are currently surfaced.

### Adapters

`src/departments/adapters/nhlIntelligence.ts` calls the NHL Dashboard API’s `GET /standings/latest`. The canonical endpoint returns a list of `StandingsLatestRow` objects ordered by `league_sequence` by default. The adapter uses the first row as the supplied league leader and reads only `team_name`, `points`, `snapshot_date`, and `created_at`.

`src/departments/adapters/quantIntelligence.ts` calls the Quant API’s `GET /api/experiments`. The canonical response is a newest-first array of experiment summaries ordered by `created_at`. The adapter requests the first summary’s detail endpoint and reads only `metrics.sharpe_ratio`; it does not calculate financial metrics. The detail’s `metadata.created_at` or list summary’s `created_at` is retained as freshness data.

Both adapters validate the fields they consume and return the shared `DepartmentSnapshot` contract. A new department should normally require one registry entry and one adapter; shared cards and detail pages should not need project-specific changes.

The normalized metric contract is:

```ts
type DepartmentMetric = {
  label: string;
  value: string | number | null;
  state: "live" | "stale" | "unavailable" | "synthetic";
  observedAt?: string;
  source?: string;
  note?: string;
};
```

The adapters never infer synthetic status from a development environment or from a missing timestamp. `SYNTHETIC DATA` is shown only when a project response explicitly identifies the result as synthetic.

### Fetching and freshness

`src/hooks/useDepartmentData.ts` provides a small in-memory cache shared by overview cards and detail pages. A successful response is reused for 60 seconds. After that, the last response is shown as `Stale` while a background refresh runs. If refresh fails, the last validated response remains visible with a `Stale` state; a department with no usable response shows `Unavailable`. Failed retries have a short cooldown, and every request has an eight-second timeout.

`observedAt` is preferred for freshness display. If a source does not supply one, the UI says it was fetched without claiming an observation time.

### CORS boundary

The canonical NHL Dashboard API and Quant API configurations allow the local Vite origin `http://localhost:5173`. Quant also allows `http://127.0.0.1:5173`. Their current configurations do not include HQ’s default Vite preview origin `http://localhost:4173` or an arbitrary production HQ origin. HQ does not broaden either project’s CORS policy; use an allowed development origin or make a separately authorized backend/deployment change later.

## Adding a department

1. Add one `DepartmentConfig` entry in `src/departments/config.ts`.
2. Add a small adapter implementing `DepartmentAdapter` and returning `DepartmentSnapshot`.
3. Register that adapter in `src/departments/adapters/index.ts`.
4. Add adapter and route/state tests for the response shapes that are actually approved.

Avoid putting project response parsing in shared components. Avoid adding write or agent capabilities until there is a real backend contract for them.

## Application Agent

Application Agent is a first-class HQ route implemented in the dedicated [`application-agent/`](application-agent/README.md) project folder. Its domain logic is isolated from the shared department UI and can be tested without a browser or network service.

The V0 flow is pasted job content → normalized posting → deterministic fit assessment → verified resume-family routing → grounded answer preparation → explicit human-required fields → `ready_for_review`. It never submits an application. Candidate profiles and application records are stored in browser local storage; the repository contains only the clearly labelled [`profile.example.json`](application-agent/profile.example.json) template and no real private profile.

Open it at `/application-agent` or through the Application Agent department card. The `/departments/application-agent` alias is retained for consistent HQ department navigation.

## Autonomous Career Agent

The Career Agent is the persistent campaign layer around that preparation core. It is deliberately a separate surface from the reusable Job Hunter Dashboard / Application Preparation Core:

```text
Career campaign → scout → normalize/dedupe → filters → fit policy
    → existing preparation core → verification/policy gate
    → blocker or executor → proof → tracker/event record
```

Open `/career-agent` (or `/application-agent/campaigns`). Campaigns, discovered-job history, structured blockers, and career events persist in browser local storage. `ownerId` is reserved in the campaign contract for a future per-user boundary; authentication and multi-tenancy are intentionally not implemented.

The campaign page exposes a broad live source, optional targeted live sources, and an explicit demo source. `remotive-live` requests remote postings from Remotive’s public structured feed. `lever:<SITE>` requests published postings from each configured Lever employer board. `greenhouse:<BOARD>` requests published postings from each configured Greenhouse board. `references:brave-search-live` is an opt-in, server-side Brave Search reference source; it finds current URLs but does not extract or scrape job pages. `demo-local` remains a static, synthetic source for offline tests and reproducible demos. Remotive and the configured public ATS feeds require no credential for their GET endpoints. Brave requires `ATELIER_BRAVE_SEARCH_API_KEY` on the trusted local Node host. Provider-specific terms, coverage, freshness, and browser-origin limitations still apply. Live postings never silently fall back to demo data.

Remotive is used for broad discovery and usually has no verified employer application URL. Lever is targeted by employer/site and retains the provider’s verified `hostedUrl` and `applyUrl`; only those exact Lever-hosted paths, paired with a live provider ID, are labelled `ACTIONABLE`. Greenhouse is targeted by board token and retains the public board posting URL; an official HTTPS Greenhouse-hosted URL with the matching board and numeric provider ID is labelled actionable for structured discovery. The same destination pipeline recognizes verified Rippling and Workday application routes. Actionable means that a verified endpoint is available to a compatible preparation executor, not that HQ can submit an application today. The provider API contracts are documented by [Remotive](https://github.com/remotive-io/remote-jobs-api), [Lever](https://github.com/lever/postings-api), and the official [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html).

### Source discovery and ATS routing

Discovery references are intentionally separate from full job extraction:

```text
reference URL → deterministic ATS classifier → configured structured adapter
                                      ├─ Lever
                                      ├─ Greenhouse
                                      └─ known unsupported / fallback_required
```

`JobDiscoveryProvider` and `DiscoveredJobReference` are the bounded seam for URL-first broad discovery. `BraveSearchDiscoveryProvider` uses the documented Brave Web Search JSON endpoint (`GET /res/v1/web/search`) from the loopback Node host, authenticating with the server-only `X-Subscription-Token` header. It returns only validated URL/title references plus query provenance; it does not fetch result pages, scrape search HTML, launch Playwright, or pass search snippets into the posting contract. `StaticJobDiscoveryProvider` remains the deterministic offline provider. `JobReferenceSource` routes recognized Lever and Greenhouse URLs to the matching structured adapter, classifies Ashby and Workday as known-but-unsupported, and reports custom/unknown career pages as `fallback_required` without launching Playwright.

Broad queries are generated deterministically from campaign `searchQueries` (or role lanes), with a small round-robin sample across primary cloud/platform, secondary frontend, and adjacent AI/agent lanes. Remote and first configured location terms are added as query context; authoritative role/location/employment/salary decisions remain local policy. The provider requests at most three queries, ten results per query, and thirty retained references by default. These limits are deliberately below the API’s documented per-request result maximum and keep one cycle bounded. The provider currently advertises usage-based pricing and a monthly credit; consult [Brave’s current pricing](https://api-dashboard.search.brave.com/documentation/pricing) before increasing caps. Brave’s [Web Search API reference](https://api-dashboard.search.brave.com/api-reference/web/search/get) and [getting-started documentation](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started) are the source of truth for endpoint, authentication, query, and pagination behavior.

The broad provider applies only a small explainable pre-classification filter for obvious social, cache/translation, news/advice, malformed, and generic non-job results. Accepted references flow through the existing deterministic ATS classifier and resolver: Lever and Greenhouse are structured when their board/site can be resolved; Ashby and Workday are `known_unsupported`; custom/unknown references are `fallback_required`. Provider results are never presented as full postings until a structured adapter validates them. If the key is absent, the source returns `not_configured`; it does not make a network request or substitute demo data. A failed or partial broad source is isolated from Remotive and configured ATS feeds.

Greenhouse uses `GET /v1/boards/{board}/jobs?content=true` with a bounded retrieval cap. The adapter maps provider IDs, titles, company/board metadata, location, office/department context, plaintext description, publication/update timestamps, and the provider's canonical URL. It applies search-lane matching locally; it does not claim that Greenhouse performed those filters. The official Greenhouse documentation describes the public GET Job Board API and its `content=true` job detail fields; Greenhouse-hosted posting URLs are also the public application form according to [Greenhouse's hosted job URL guidance](https://support.greenhouse.io/hc/en-us/articles/360020561392-Job-post-URL-for-Greenhouse-hosted-job-posts). Non-hosted employer URLs remain discovery-only.

The campaign records low-noise reference metrics for each reference-driven cycle: raw provider results, accepted/rejected/duplicate references, query-level status, known ATS references, Lever/Greenhouse/Ashby/Workday/custom/unknown counts, structured resolutions, known unsupported/fallback/invalid/failed references, unique discovered Lever sites and Greenhouse boards (with exact observed site/board identities retained when available), duplicates, and source failures. The UI derives simple percentages only for the observed classified-reference sample and labels them `Observed sample`; they are provider/query/time dependent and do not estimate the whole labor market. These metrics are intended to show whether another structured adapter or a future targeted extractor earns its complexity; they are not a crawler or a general analytics subsystem.

The HQ browser surface remains source-aware: demo postings may receive visibly simulated proof for acceptance testing, while actionable live ATS postings expose **Prepare in browser**. That control calls the separate loopback Node host, which injects the existing Playwright-backed browser executor; it can inspect/fill a verified Lever, Greenhouse, Rippling, or Workday form, preserve a CAPTCHA/login handoff session, surface blockers, and stop at `ready_to_submit` without ever activating Submit. Workday commonly requires a user account/sign-in boundary before its application steps become available. After the user manually submits and explicitly selects **Mark as submitted**, HQ records the Applied state first and asks the server-side `GoogleSheetsJobTracker` to upsert the canonical tracker row. A failed sync remains visible and retryable; it never rolls back Applied or becomes proof of submission. No ATS submission, scheduler, or ChatGPT notification delivery is claimed.

### Local browser execution host

Start the Vite UI and the host in separate terminals:

```bash
npm run dev
npm run career-agent:executor
```

The default host is `http://127.0.0.1:8787`. It exposes only domain-specific start, status, resume, cancel, and health routes. The UI sends a validated campaign/job/application/profile packet; the server validates it again and navigates only to a verified application route for a supported ATS. Browser/session objects, cookies, credentials, MFA, CAPTCHA state, and filesystem paths never enter the UI snapshot or local-storage career record.

The default example profile is intentionally rejected for real live execution. Load a private, verified profile in the Application Agent UI before preparing a real posting. Resume artifacts, when required by the form, must be configured in the Node process under `ATELIER_RESUME_ROOT`; frontend requests cannot submit arbitrary paths.

When the browser encounters CAPTCHA, login, MFA, or another human boundary, the host returns `waiting_for_human` and keeps the session open until the user acts in the browser and selects **Resume browser**. A host restart makes that live session unrecoverable; the UI marks it interrupted and offers a fresh preparation. Cancelling, timeout, failure, and shutdown close the retained browser session where possible.

The host is preparation-only. It does not click Submit, call an ATS submission API, or emit `application.submitted`/`application.applied`. Final submission remains a manual user action. Only after explicit confirmation does HQ emit `application.applied` and invoke the separate tracker route; a tracker write is downstream recordkeeping, never proof of submission.

The worker is injected at four boundaries: `JobSource`, `ApplicationExecutor`, `JobTracker`, and the existing `ApplicationService`. The worker owns deterministic history checks, caps, state transitions, policy gates, proof requirements, events, and persistence. The V0 core remains the owner of profile facts, fit assessment, resume routing/tailoring, answers, provenance, and application-preparation blockers. A new real integration should provide one adapter at the relevant boundary without changing shared HQ components.

The current Career Agent execution graph is audited in
[`application-agent/EXECUTION_GRAPH.md`](application-agent/EXECUTION_GRAPH.md).
Independent source and reference I/O uses bounded, input-ordered concurrency;
the per-job application path remains intentionally ordered where caps,
persistence, browser sessions, and human authority create real dependencies.
Campaign runs persist a small operational trace with node duration/outcome and
human-attention counts. This is instrumentation and deterministic fan-out/fan-
in, not a generic graph runtime; no LangGraph, orchestration library, or
multi-agent layer is installed.

Submission authority is explicit. `never` always stops; `approval_required` needs a resolved approval blocker; `automatic` is still subject to grounding and deterministic checks; `simulated` is visibly local-only. A career record can become `applied` only after validated external proof or an explicit user confirmation of successful manual submission. A model assertion is never proof. Human blockers resume the existing application packet rather than regenerating its completed resume, answers, or other units.

The event stream is quiet for routine work and marks `application.needs_input`, authentication/verification stops, tracker failures, and campaign review conditions for future notification consumers. After manual confirmation, `application.applied` is emitted before the downstream tracker adapter call; tracker failure leaves the application applied but creates an auditable attention event and retryable sync state.

## Scope

This application has no user-account authentication, ATS submission, scheduler, iframe embedding, ChatGPT notification delivery, Codex integration, or MCP tooling. It consumes existing read-only project APIs for the original departments, Remotive for broad structured listings, optional Brave for bounded URL discovery, and explicitly configured Lever/Greenhouse employer feeds for targeted structured discovery. Preparation remains local; demo execution/tracking remain simulated, while live Lever, Greenhouse, Rippling, and Workday browser preparation, optional post-confirmation Google Sheets tracking, and optional Brave discovery run through the loopback Node host. Workday account/sign-in boundaries remain human-controlled. The browser UI remains honest about the manual submission boundary; local Node credentials are intentionally not committed or bundled. Brave broad discovery is a coverage experiment, not comprehensive job-market search, and custom/unknown pages still have no extractor.
