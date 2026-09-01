# Application Agent: Preparation Core and Autonomous Career Agent

This folder contains two related layers inside the Atelier HQ repository:

1. **Application Preparation Core / Job Hunter Dashboard** — the original V0 workflow that accepts a candidate profile and pasted posting, then prepares one grounded packet for human review.
2. **Autonomous Career Agent / Campaign Worker** — the persistent campaign layer that discovers jobs through injected sources, filters and deduplicates them, invokes the existing preparation core, pauses only at explicit blockers, and records proof-backed outcomes.

The second layer reuses the first. It does not replace the packet UI or duplicate fit, profile, resume, answer, provenance, or application-blocker logic.

It intentionally lives inside the Atelier HQ repository as a dedicated project folder. The shared HQ shell owns navigation, department presentation, and the visual system; this folder owns the application domain, policies, lifecycle, persistence boundary, and first-party UI. There is no nested Git repository and no separate package to install.

## Preparation Core V0 scope

The supported path is:

```text
pasted posting → normalized job → fit assessment → resume-family routing
→ grounded answer preparation → human-required fields → ready_for_review
```

V0 supports pasted job text plus optional source and application URLs. URLs are recorded as provenance only; V0 does not scrape or fetch them. A deterministic local implementation stands behind the replaceable model boundary, so the workflow is useful without an API key or network model call.

V0 does not submit applications. It does not click a final-submit control, call an ATS, run browser automation, send profile data to a model provider, or send notifications. A packet may reach `ready_for_review`, after which the user opens the employer’s application page and submits manually.

## Autonomous Career Agent scope

Career Agent introduces persistent campaigns and a caller-driven `runCampaign()` boundary. It is designed so a future scheduler can invoke the worker without coupling scheduling to the domain. The current HQ surface keeps execution and tracking local, but supports verified live discovery sources:

| Boundary | Current implementation | Reality |
| --- | --- | --- |
| Job source | `RemotiveJobSource("remotive-live")`, optional `JobReferenceSource(HttpJobDiscoveryProvider("brave-search-live"))`, configured `LeverJobSource("lever:<SITE>")`, configured `GreenhouseJobSource("greenhouse:<BOARD>")`, or `StaticJobSource("demo-local", ...)` | Remotive is broad structured listing discovery; Brave is bounded URL/reference discovery through the local Node host; Lever and Greenhouse are targeted employer/ATS board feeds; the static source is synthetic and offline |
| Preparation | Existing `ApplicationService` | Real local deterministic preparation core |
| Executor | `SourceAwareApplicationExecutor` in the HQ browser surface; the loopback Node host injects the Node-only `LeverBrowserExecutor` backed by Playwright | Demo postings may receive visibly simulated proof; live Lever postings can be inspected/prepared by the real browser adapter, which stops before final Submit |
| Tracker | `InMemoryJobTracker` for demo evidence; `HttpGoogleSheetsJobTracker` → the Node-only `GoogleSheetsJobTracker` for live confirmed applications | The canonical `Nate Job Search Tracker` is updated only after explicit Applied confirmation and configured server credentials |
| Notifications | Attention flags on career events | No ChatGPT or external delivery |

The worker’s adapters are intentionally small interfaces: `JobSource`, `ApplicationExecutor`, and `JobTracker`. A source returns `JobSourceListing` values that are normalized through the existing `JobPosting` contract. It may return non-fatal warnings so partial provider results are visible. An executor may return a structured human blocker, `ready_to_submit`, a failure, or validated `SubmissionProof`. Only that proof allows `ApplicationService.recordApplied()` and the `application.applied` event. The real Lever browser executor never returns proof in this phase. A model response alone cannot establish external state.

### Browser execution host

`automation/executionHost/` is the smallest trusted transport around the
existing Lever executor. It is not a second preparation engine and it is not a
generic remote browser. `server.ts` uses Node's built-in HTTP server,
`sessionRegistry.ts` owns opaque in-memory browser executions, and
`trustedRequest.ts` revalidates the campaign, packet, private profile, live
Lever provenance, provider ID, and exact HTTPS `/apply` path before Playwright
is called. `src/service/executionHostClient.ts` is the only Vite-side caller.

The client starts an execution, polls its typed snapshot, resumes a blocked
session, or cancels it. The host keeps the Playwright page and browser handle
server-side. It never exposes arbitrary navigation/selector/JavaScript
controls. A CAPTCHA/login/MFA boundary becomes `waiting_for_human`; the user
acts directly in the open browser and then resumes the same application ID.
The current default capacity is one session, with a process-memory timeout and
shutdown cleanup. A host restart loses live browser state; the UI marks the
persisted execution interrupted rather than pretending it remains active.

The real host is intentionally preparation-only. It can inspect and fill
supported grounded fields and can reach `ready_to_submit`, but it cannot click
Submit, trigger a keyboard submit, call an ATS submission API, emit
`application.submitted`/`application.applied`, or write an Applied tracker
record. `SimulatedApplicationExecutor` remains available for deterministic
tests and explicit demo runs. The UI never silently converts a missing real
host into simulated success. After the user submits manually and explicitly
confirms success, the Career Agent may mark the application Applied and invoke
the downstream tracker adapter; the tracker is never evidence of submission.

### Google Sheets tracker

The tracker seam has two intentionally distinct implementations:

```text
demo proof → InMemoryJobTracker
live manual/external Applied evidence → HttpGoogleSheetsJobTracker
                                      → loopback host
                                      → GoogleSheetsJobTracker
                                      → Nate Job Search Tracker / Job Tracker
```

The Node adapter uses the Google Sheets v4 REST API. Personal local use should
use the server-only OAuth mode: configure a Google Desktop OAuth client JSON,
set `ATELIER_GOOGLE_AUTH_MODE=oauth`, and run
`npm run career-agent:google-auth`. The loopback authorization requests only
`https://www.googleapis.com/auth/spreadsheets`, stores a refreshable token at
the ignored `ATELIER_GOOGLE_TOKEN_FILE` path, and keeps all client/token
material in the Node process boundary. Retained explicit alternatives are a
service-account JSON path (`service_account`) and a short-lived raw access
token (`access_token`). When multiple lanes are configured,
`ATELIER_GOOGLE_AUTH_MODE` is required; the host never guesses.

No credential, token, sheet ID, or profile data is sent through the Vite
client. Without both a configured sheet ID and usable server-side auth, the
host returns an honest failed sync and the application remains Applied.

The verified spreadsheet is named `Nate Job Search Tracker`; the verified tab
is `Job Tracker`. The adapter reads the header row and maps by header name. It
writes only agent-owned fields: Company, Role, Job Link, Location / Remote,
known salary bounds, Fit, Priority, Status, Date Found, Date Applied, Resume
Version, and Next Step. It preserves Follow-Up Date, Contact / Referral, and
Notes. Existing rows match by canonical application/job URL first, then
provider record ID when a matching header exists, then normalized company and
role (with location when available). Retry updates the same row rather than
appending a duplicate. The adapter never creates a new sheet, changes headers,
creates an XLSX/CSV copy, or infers Applied from a tracker response.

Career records persist `trackerSync.status` as `pending`, `synced`, or
`failed` (or `not_required` for older/non-tracker records). A failed sync
surfaces as attention while the application remains truthfully Applied; the
**Retry tracker sync** action retries only that downstream unit. The Career
Agent emits `application.applied` before calling the tracker, then emits
`tracker.updated` or `tracker.failed`. There is no automatic ATS submission.

The personal OAuth flow uses a temporary loopback callback on `127.0.0.1`,
PKCE, `access_type=offline`, and an explicit consent prompt so later tracker
requests can refresh without interactive authorization each time. If Google
returns no refresh token, revoke Atelier HQ's existing access in the Google
account and run the auth command again. Revoked/expired authorization, missing
client configuration, permission errors, and inaccessible sheets remain
tracker failures rather than changing Applied truth. OAuth client JSON and
token files belong outside source control; `.local/`, client-secret patterns,
and token patterns are ignored by this repository. To revoke/re-authorize,
remove the local token file and revoke the app in the Google account before
running `npm run career-agent:google-auth` again.

To add a real source, implement `JobSource.discover(criteria, context)`, preserve the source/application URLs, return only fields present in the source response, optionally implement `classifyActionability()` for provider-specific endpoint proof, and register it in the dependency-injected `JobScout`; the worker and shared UI do not change. To add a real executor, implement `ApplicationExecutor.execute(request)`, keep provider navigation behind a session adapter, return `ready_to_submit` for this phase, and return a human handoff for login/MFA/CAPTCHA or other blockers. To add a real tracker, implement `JobTracker.recordApplied(update)` and acknowledge the canonical record. Keep provider-specific response shapes inside those adapters.

### Live discovery source

`RemotiveJobSource` calls `GET https://remotive.com/api/remote-jobs` with a public browser-safe GET request. The current feed returned structured postings with stable IDs and listing URLs during implementation verification on 2026-08-30; the response also permitted the local Vite origin through CORS. No API key is required. `VITE_REMOTIVE_API_BASE_URL` can point to an explicitly trusted compatible endpoint or development proxy, and defaults to the canonical Remotive URL when blank.

Remotive documents one `search` term and a `limit` parameter. The live response currently observed did not honor those query parameters, so the adapter sends a single search term only when one lane is configured, then always applies deterministic local OR matching for multiple `searchQueries`, sorts by the provider publication timestamp, and caps the result before normalization. Campaign role lanes, location, remote, employment, salary, exclusions, and final safety checks remain local policy decisions; the adapter does not claim the provider applied them. Remotive’s public feed is remote-only, has delayed listings, should not be polled frequently, and includes terms restricting downstream third-party submission. This phase uses it for current discovery and preparation only.

Each accepted listing retains `sourceId: "remotive-live"`, the provider job ID, the Remotive source URL, `sourcePublishedAt` when valid, a capture/discovery timestamp, and `sourceMode: "live"`. Remotive does not provide a verified employer application URL in this response, so `applicationUrl` remains absent rather than being set to the Remotive listing page. Provider HTML is converted to plain text before it reaches the shared posting contract.

### Targeted Lever source

`LeverJobSource` calls the public JSON postings feed `GET https://api.lever.co/v0/postings/{SITE}?mode=json&limit=N` for one configured employer/site identifier. It does not discover or crawl employer sites. Configure sites with `VITE_LEVER_SITES=site-a,site-b`; the UI creates a combined campaign containing Remotive plus those Lever sources. `VITE_LEVER_API_BASE_URL` is an optional approved endpoint override. The official [Lever postings API documentation](https://github.com/lever/postings-api) describes the site namespace and published JSON fields. The public `h1` board used for acceptance testing allowed the local browser origin; other boards may impose different CORS behavior.

Lever provider objects stay inside `leverJobSource.ts`. The adapter validates the posting ID, the expected `jobs.lever.co` or `jobs.eu.lever.co` hosted path, and the plaintext/HTML description fields before building the shared `JobPosting`. The configured SITE identifier is retained as the canonical company label because the public feed is namespaced by SITE and does not return a separate display-company field. `categories.allLocations` is preferred over the primary location, `workplaceType` is mapped conservatively, known commitments become employment types, and only finite non-negative salary bounds become compensation. No optional value is invented.

Lever never receives the campaign’s candidate profile. Search lanes are matched locally against title, SITE, categories, workplace type, and normalized description; Lever’s endpoint is not treated as a global full-text search. Each source request is capped, does not paginate without a future requirement, and a site-level HTTP/JSON/timeout failure becomes an isolated source failure. A malformed posting is skipped with a partial-discovery warning.

An accepted Lever listing is `actionable` only when it is live, has a provider posting ID, its `hostedUrl` exactly matches the configured SITE and posting ID, and its `applyUrl` exactly matches that Lever-hosted posting’s `/apply` path. An invalid or absent apply URL is retained as a live `discoverable_only` posting when the rest of the listing is usable. Actionability means a verified endpoint is available to the future executor; it does not authorize submission.

### Targeted Greenhouse source

`GreenhouseJobSource` calls the public Job Board API
`GET https://boards-api.greenhouse.io/v1/boards/{BOARD}/jobs?content=true`
for each explicitly configured board token. Greenhouse’s public GET Job Board
API does not require authentication; `content=true` supplies the structured
description, departments, and offices used by the adapter. The official
[Greenhouse Job Board API documentation](https://docs.greenhouse.io/job-board.html)
defines the published-job response, including provider IDs, titles, locations,
timestamps, and canonical absolute URLs. The adapter also reads the public
board metadata endpoint when no company label is configured, but never uses the
board token as a fabricated company name.

Configure multiple boards before starting Vite:

```bash
VITE_GREENHOUSE_BOARDS=anthropic,stripe,ramp
```

`VITE_GREENHOUSE_API_BASE_URL` is an optional endpoint override for an approved
compatible proxy; the default is the public Greenhouse API base. The board
list is a watchlist, not a global Greenhouse search or company-discovery
crawler. Greenhouse does not receive candidate profile data.

All lane/query, location, remote, employment, salary, seniority, and company
policy checks remain local. The adapter applies the configured search queries
locally to title, company, location, department/office metadata, and the
sanitized plaintext description. It reads at most the configured retrieval cap
from a board collection and then returns at most the normal source result cap.
One board’s HTTP, rate-limit, timeout, malformed JSON, or malformed-entry
failure is isolated from other boards and sources.

Greenhouse descriptions are converted deterministically to plaintext before
normalization; provider HTML is never rendered or passed to React as markup.
Required provider fields are `id`, `title`, `absolute_url`, a usable company
label, and a non-trivial plaintext description. Optional compensation,
employment type, and other fields remain absent when the provider does not
provide verified values.

The adapter marks a listing `actionable` only when it is live, has its provider
ID, and its URL is HTTPS on `boards.greenhouse.io` or
`job-boards.greenhouse.io` with the exact configured `{BOARD}/jobs/{numeric-id}`
path. Greenhouse-hosted URLs are the public job/application form according to
[Greenhouse’s hosted job URL guidance](https://support.greenhouse.io/hc/en-us/articles/360020561392-Job-post-URL-for-Greenhouse-hosted-job-posts).
An employer-hosted `absolute_url` is preserved as `sourceUrl` but remains
`discoverable_only`. Actionable means a trusted endpoint is available for
future executor work; a Greenhouse browser executor and ATS submission are not
implemented.

The live acceptance board used during this phase was `anthropic`, which was
queried manually/read-only and is not a production default. It returned current
published postings, including technical/AI roles, with numeric provider IDs and
`job-boards.greenhouse.io/anthropic/jobs/{id}` URLs. Configure only boards you
intend to watch; there is no claim of global Greenhouse coverage.

### Source-level metrics and fallback

Reference-driven runs retain low-noise metrics in `DiscoverySummary`: raw
provider results, accepted/rejected/duplicate references, query-level status,
known ATS references, Lever/Greenhouse/Ashby/Workday/custom/unknown counts,
structured resolutions, known unsupported/fallback/invalid/failed references,
unique discovered Lever sites and Greenhouse boards (with exact observed
site/board identities retained when available), and source failures. The UI
derives simple percentages only for the observed classified-reference sample
and labels them `Observed sample`; they are provider/query/time dependent and
are not labor-market estimates. These metrics make the cost of a future
structured adapter or fallback extractor measurable. The current fallback is
only a resolution status (`fallback_required`) and audit warning; it does not
scrape a custom site or launch browser automation. A structured source can
still be queried directly without a discovery reference, so existing Remotive,
Lever, Greenhouse, and demo behavior remains available.

The campaign can persist declarative `sourceConfigs` such as `{ type: "lever", site: "example-company" }` while retaining the existing `searchSources` registry IDs. Cross-source identity uses exact provider IDs and canonical URLs first. A complete company/title/location alias can bridge two different live source IDs, allowing a richer actionable Lever record to replace a discovery-only duplicate while `sourceObservations` retains both source IDs, URLs, provider IDs, and actionability states. Demo records do not cross-dedupe against live records by this content alias.

The scout records `success`, `empty`, `partial`, `failed`, or `not_configured` discovery state. Invalid entries are skipped with warnings; HTTP errors, rate limits, invalid JSON, timeouts, and malformed top-level payloads become source failures. A healthy source can still be processed when another configured source fails. Discovery state, counts, warnings, and failures are persisted on the campaign and represented in quiet audit events. There is no silent live-to-demo fallback.

### Discovery references and ATS routing

Discovery and extraction are separate contracts. A `JobDiscoveryProvider` may
return only a validated `DiscoveredJobReference`—a URL, optional title/company
hints, provider identity, discovery time, and evidence. `JobReferenceSource`
then applies the deterministic `classifyJobUrl()` classifier and routes only
recognized configured boards to structured adapters. It never sends a partial
reference directly to fit, preparation, or the UI.

The classifier recognizes the hostname/path evidence for Lever, Greenhouse,
Ashby, and Workday. Lever and Greenhouse can resolve through configured
structured sources. Ashby and Workday are currently `known_unsupported`;
valid employer career URLs that do not provide trusted ATS evidence are
`fallback_required`; malformed URLs are invalid. Unknown/custom references do
not start Playwright and are not scraped.

`BraveSearchDiscoveryProvider` is the single bounded live broad-discovery
provider. It runs only behind `POST /career-agent/discovery` on the trusted
loopback Node host, uses the documented Brave Search Web API JSON response, and
returns URL-first references with title, provider, timestamp, and query
provenance. The browser receives no Brave key. The source is opt-in through
`VITE_BROAD_DISCOVERY_ENABLED=true` plus server-only
`ATELIER_BRAVE_SEARCH_API_KEY`; without the key it reports `not_configured` and
does not fall back to Demo. `StaticJobDiscoveryProvider` remains the
deterministic offline implementation. Direct structured discovery remains
available through Remotive, configured Lever SITE identifiers, and configured
Greenhouse board tokens.

Brave query generation uses a small deterministic set from `searchQueries` or
role lanes, samples lane buckets round-robin, and adds remote/location context
when configured. Default caps are three queries, ten results per query, and
thirty retained references per cycle; all are server-configurable with bounded
environment variables. Successful, empty, and partial responses are reused in
the host process for five minutes by default (`ATELIER_BRAVE_SEARCH_CACHE_TTL_MS`);
failed and not-configured responses are never cached. Cache hits retain the
original reference discovery/fetch timestamp and are marked as cached in the
persisted source summary, so they are not presented as newly fetched. The
provider uses only documented result URLs/titles,
rejects obvious non-job/social/redirect noise, normalizes tracking URL noise,
and retains query-level counts. It never fetches result pages or launches
Playwright. The [Brave Web Search API reference](https://api-dashboard.search.brave.com/api-reference/web/search/get), [getting-started guide](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started), and [pricing](https://api-dashboard.search.brave.com/documentation/pricing) are the current provider references.

Broad references enter the existing classifier/resolver unchanged: Lever and
Greenhouse route to their structured adapters, Ashby and Workday remain
`known_unsupported`, and custom/unknown references remain `fallback_required`.
The resulting persisted `referenceMetrics` include raw/accepted/rejected/
duplicate totals, query evidence, classification and resolution counts, source
failures, and unique Lever/Greenhouse identities. Coverage ratios use the
classified, de-duplicated reference sample so malformed or duplicate input
does not distort the denominator. The UI labels derived rates as `Observed
sample`; they describe only the provider/query/time sample, not
the labor market. If a source fails or is not configured, successful Remotive
and targeted-source results remain usable and the partial/failure state is
preserved.

### Campaign lifecycle

Campaigns persist as `draft`, `active`, `paused`, `completed`, or `failed`. `start`, `pause`, `markOfferAccepted`, and bounded systemic-failure handling use explicit transitions. Each normalized posting gets a durable fingerprint and history record. A posting already seen or already applied is not processed again, including across campaign records in the same local workspace.

The run boundary performs deterministic work in this order:

```text
configured sources → normalized postings → fingerprint history
→ hard filters → qualitative fit policy → ApplicationService preparation
→ grounding/submission policy gate → injected executor → proof
→ tracker adapter → career events
```

Strong and good fit are pursued by default, stretch is held, and weak is rejected; each decision stores a reason. Daily/weekly application caps, role/location/employment/salary exclusions, allowed ATS values, unusual-term review, and explicit submission authority are deterministic policy checks.

### Blockers and resume behavior

Career blockers include salary, sponsorship, relocation, travel, legal attestation, demographic disclosure, unknown fact, subjective answer, external login, CAPTCHA, external verification, unknown form field, unsupported widget, missing resume/file, submission approval, and other. Each blocker retains the exact question, job/application context, reason, evidence, resume-after-input hint, and resolution value.

Resolving a blocker updates the existing V0 packet when it is an application-preparation field. The worker then resumes from the blocked unit. It does not call resume tailoring, answer drafting, or other completed preparation units again. External login blockers never ask for passwords; they represent a future handoff to a user-authenticated session.

### Authority and privacy

`never` submission authority cannot be overridden by a model or a normal blocker answer. An explicitly marked `preparation_only` executor, such as the Lever browser executor, may still open and prepare a form under that policy, but the service rejects any submission proof from it and the executor stops at `ready_to_submit`. `approval_required` requires an explicit resolved approval blocker. `automatic` remains constrained by verified profile facts, approved resume families, grounded answers, no unsupported required qualifications, and external proof. `simulated` is for local tests/demo only.

Candidate data remains browser-local in the HQ surface. No real profile is committed; `profile.example.json` contains obvious placeholders. The Node browser host receives only the explicitly supplied packet/profile and keeps browser state in an ephemeral process context; it does not persist cookies, passwords, MFA codes, or raw page HTML. Future integrations must be explicitly configured and must not request passwords in application state.

## Project structure

```text
application-agent/
├── profile.example.json
├── automation/
│   ├── README.md
│   ├── executionHost/
│   │   ├── config.ts
│   │   ├── run.ts
│   │   ├── server.ts
│   │   ├── sessionRegistry.ts
│   │   └── trustedRequest.ts
│   ├── createLeverBrowserExecutor.ts
│   ├── googleAuth.ts                  # local OAuth CLI entrypoint
│   ├── googleOAuth.ts                 # Node-only OAuth/refresh/storage boundary
│   ├── googleSheetsJobTracker.ts      # Node-only Google Sheets v4 adapter
│   └── playwrightLeverBrowserSession.ts
├── README.md
└── src/
    ├── domain/
    │   ├── answers.ts                 # policies, drafts, blockers
    │   ├── campaignLifecycle.ts        # campaign state transitions
    │   ├── campaignTypes.ts            # campaign/job/blocker/event contracts
    │   ├── demoSources.ts              # explicitly synthetic local source
    │   ├── events.ts                  # domain event construction
    │   ├── executor.ts                 # executor seam and local simulation
    │   ├── executionHostTypes.ts       # browser-safe host transport contract
    │   ├── executionHostValidation.ts  # host request/response guards
    │   ├── fit.ts                     # deterministic grounded fit
    │   ├── job.ts                     # pasted intake and validation
    │   ├── greenhouseJobSource.ts      # targeted Greenhouse board feed adapter
    │   ├── jobDiscovery.ts             # source-neutral URL/reference seam
    │   ├── jobReferenceResolver.ts     # ATS classification and structured routing
    │   ├── jobUrlClassifier.ts         # deterministic ATS URL classifier
    │   ├── leverJobSource.ts           # targeted Lever employer feed adapter
    │   ├── lifecycle.ts               # explicit state transitions
    │   ├── model.ts                   # replaceable model boundary
    │   ├── notifications.ts            # quiet vs attention event policy
    │   ├── policies.ts                 # hard filters and submission gate
    │   ├── profile.ts                 # example/private profile loading
    │   ├── remotiveJobSource.ts        # verified live public source adapter
    │   ├── resume.ts                  # verified resume tailoring plan
    │   ├── scout.ts                    # job-source seam and dedupe
    │   ├── tracker.ts                  # tracker contract, sync state, demo tracker
    │   ├── types.ts                   # normalized domain contracts
    │   └── validation.ts               # runtime boundary validation
    ├── persistence/
    │   ├── applicationRepository.ts   # replaceable memory/local storage
    │   ├── careerRepository.ts         # campaign/job/event persistence
    │   └── storage.ts                 # small key/value boundary
    ├── service/
    │   ├── applicationService.ts      # preparation-core orchestration
    │   ├── careerAgentService.ts      # persistent campaign worker
    │   ├── executionHostClient.ts     # typed Vite → loopback browser client
    │   └── trackerClient.ts           # typed Vite → loopback tracker client
    └── ui/
        ├── CareerAgentPage.tsx         # campaign operations surface
        ├── ApplicationAgentPage.tsx   # HQ surface
        ├── application-agent.css
        ├── useApplicationWorkspace.ts
        └── useCareerAgentWorkspace.ts
```

The parent `src/` directory integrates the capability through the HQ registry, adapter, routing, and shared shell. The application domain does not import React or the parent department data contract.

## Candidate profile and privacy

`profile.example.json` is a safe schema template with obvious placeholder values. The bundled example profile is also explicitly marked `profileKind: "example"` and is labelled in the UI. Do not replace it in the repository with real personal information.

To use a private profile:

1. Copy `profile.example.json` to a local file such as `profile.local.json`.
2. Replace placeholders with verified facts only.
3. Load the JSON through **Load private profile JSON** in the Application Agent page.

The UI validates the profile before storing it in browser local storage. `profile.local.json` is ignored by Git. Existing applications are not rewritten when a profile is changed; new packets use the active profile.

The profile is the factual source for identity, contact information, employment, education, skills, projects, certifications, work preferences, work authorization, resume families, and approved reusable answers. The system does not fill gaps by inference.

## Answer policies

Each application field carries an explicit policy:

| Policy | V0 behavior |
| --- | --- |
| `auto` | Use a verified profile fact or approved reusable answer when present. Missing values remain unresolved. |
| `draft_review` | Produce a grounded draft with provenance. The user reviews it before use. |
| `ask` | Always remain a human-required field unless the user supplies an explicit answer. |
| `never_auto` | Never resolve automatically. The field stays visibly blocked until the user handles it. |

The default policy map keeps identity and verified skills automatic, company motivation and cover letters as drafts, compensation/relocation/travel/sponsorship as questions, and demographic/legal fields outside automatic handling. A private profile may configure the map and approved reusable answers.

## Domain workflow and state transitions

`ApplicationService.prepareFromIntake()` creates, evaluates, and prepares one application record. Preparation creates a tailored resume representation, normalized answers, and explicit blockers. `resolveHumanField()` accepts a non-empty user-provided value and moves the packet to `ready_for_review` only when every blocker is resolved.

Allowed transitions are:

```text
discovered ──→ evaluated ──→ preparing ──→ needs_input ──→ ready_for_review
      │             │             │              │                  │
      └─────────────┴─────────────┴──────────────┴──→ failed         └──→ applied (manual confirmation)
failed ──→ discovered
```

The packet UI’s V0 boundary still exposes no submission path. `submitApplication(applicationId, approval)` requires an explicit `SubmissionApproval` value, then still raises `SubmissionDisabledError`. The Career Agent may call the separate `recordApplied()` method after an injected executor returns validated external or explicitly simulated proof, or may use its explicit manual-confirmation path after the user submits. These paths record the result and do not themselves contact an employer. The Playwright Lever executor stops earlier at `ready_to_submit` and cannot produce proof.

For a live browser-prepared packet, the user opens the employer page, performs
the final Submit action, and then explicitly selects **Mark as submitted** in
Career Agent. That confirmation records a `manualSubmissionConfirmation` and
transitions the application/career job to `applied`; reaching
`ready_to_submit` alone never does. `application.applied` is emitted before
the downstream tracker call. A real tracker failure leaves the application
Applied and records `trackerSync.status: "failed"` for retry.

## Grounding and provenance

Fit assessment is qualitative (`strong`, `good`, `stretch`, `weak`) and deterministic. It compares normalized job skills against verified profile skills, records strong/partial matches and meaningful gaps, and explains resume-family selection. It does not calculate a fake percentage.

Resume tailoring only reorders verified skills, configured employment/projects, and existing bullets or summaries. Each output section carries provenance such as `profile.skills`, `employment:<id>`, or `resume-family:<id>`. Draft answers include job and fit provenance. Unsupported qualifications remain gaps rather than becoming claims.

The normalized `JobPosting` boundary validates URLs, timestamps, required fields, and extracted structured fields. `isJobPosting`, `isCandidateProfile`, and related guards protect persisted or external-shaped data before rendering. Raw posting text is rendered as React text, never as HTML.

## Model and ingestion boundaries

`ModelClient` defines `analyzeJob`, `assessFit`, `draftResume`, and `draftAnswer`. `DeterministicModelClient` is the offline V0 implementation. A future provider can implement the interface while leaving the service and UI unchanged; provider configuration and secrets must remain outside source control.

`JobPostingIngestor` is the small intake seam for future URL or ATS-specific ingestion. `pastedJobPostingIngestor` is the only V0 implementation. Future Greenhouse, Lever, Ashby, Workday, or browser-assisted sources should return the same normalized `JobPosting` and should not leak provider response shapes into the domain.

## Persistence and events

`ApplicationRepository` is the persistence boundary. V0 uses browser `localStorage` in the UI and an in-memory repository in tests or non-browser environments. Records are validated when loaded, and malformed stored entries are ignored rather than rendered.

The service records:

```text
application.created
application.evaluated
application.prepared
application.needs_input
application.ready_for_review
application.failed
```

`application.applied` is emitted only from validated executor proof or the
explicit manual confirmation path. Tracker lifecycle events include
`tracker.update_started`, `tracker.retry_started`, `tracker.updated`, and
`tracker.failed`; a tracker write is never used as submission evidence. The
event stream is local and has no notification provider; it is a clean seam for
a future HQ attention inbox or ChatGPT condition watch.

Career state uses a separate `CareerRepository` so the persistent campaign worker does not force campaign concerns into individual V0 packet records. Browser storage keys are versioned independently for campaigns, career jobs, and career events. Reconstructing the service with the same repository is the restart boundary; a server/database repository can replace it later.

Career events include campaign lifecycle, discovery lifecycle, job rejection/hold, application preparation and execution states, tracker success/failure, and `campaign.review_needed`. Discovery adds `job.discovery_started`, `job.discovery_completed`, `job.discovery_partial`, and `job.discovery_failed` audit events. Routine events are not notification-worthy; attention flags are deterministic and currently only rendered in the HQ campaign surface.

## Execution graph audit and run telemetry

The Career Agent uses ordinary domain orchestration, not a generic graph engine.
The current path and edge audit are recorded in
[`EXECUTION_GRAPH.md`](EXECUTION_GRAPH.md). The meaningful independent work is
source retrieval and URL/reference resolution. Both now use the small ordered
`mapWithConcurrencyLimit()` helper with a conservative default of four. Source
and reference failures remain isolated, and fan-in always follows declared
input order so completion timing cannot change dedupe winners, source metrics,
or campaign ordering.

The campaign’s ordered per-job loop remains serial. Application caps,
repository writes, event ordering, browser/session state, and human gates are
real shared dependencies; parallelizing it would require a reservation and
deterministic reducer that the current product does not need. Preparation also
keeps tailored-resume generation before answer drafting because the existing
answer contract consumes the tailored resume. Blocker resolution, browser
resume, and tracker retry reuse successful upstream work.

Each campaign run persists a lightweight `ExecutionRunTrace` as
`campaign.lastRunTrace`. It records safe node IDs/kinds, durations, outcomes,
attempts, counts, cache hits, and high-level source/status metadata. It contains
no profile data, answers, resume contents, browser HTML, credentials, or
tokens. `humanAttentionEvents` counts new attention-worthy career events for
that run; passive reads are not counted. The trace is measurement state, not a
topology or scheduling system. A controlled deferred-work test demonstrates
bounded overlap and deterministic fan-in without relying on flaky network
timings.

## Run and test

Run commands from the Atelier HQ repository root:

```bash
npm install
npm run dev
npm run test
npm run typecheck
npm run build
npx playwright install chromium
# Separate terminal for the loopback Node host (browser preparation, tracker,
# and optional broad discovery):
npm run career-agent:executor
```

Open `/application-agent` or `/departments/application-agent` for the preparation core. Open `/career-agent` or `/application-agent/campaigns` for campaigns. The latter route has deep-linkable campaign IDs. Create a **live campaign** to use Remotive plus any configured Lever sites and Greenhouse boards, or a **local demo campaign** for offline reproducibility. Set `VITE_LEVER_SITES` and/or `VITE_GREENHOUSE_BOARDS` to comma-separated public board identifiers before starting Vite; no credential is required for the public GET feeds. To include the bounded broad source in newly created live campaigns, set `VITE_BROAD_DISCOVERY_ENABLED=true`, set the server-only `ATELIER_BRAVE_SEARCH_API_KEY`, and run `npm run career-agent:executor` alongside Vite. The NHL and Quant variables remain separate read-only department configuration.

The local campaign acceptance flow is: create the demo campaign → start → run now → inspect synthetic postings and blockers → resolve a blocker if desired → observe simulated proof and the local tracker record. The live flow is: configure optional Lever sites and/or Greenhouse boards → optionally enable bounded Brave discovery → create the live campaign → start → run now → inspect current Remotive/Lever/Greenhouse postings plus URL references, source provenance, actionability, and locally evaluated packets. Greenhouse and Lever are watchlists, not global ATS searches, and Brave is a bounded URL discovery sample rather than comprehensive market coverage. Reference-based discovery can classify a URL and route it to a structured board adapter; Ashby/Workday are recognized but unsupported, and custom/unknown pages stop at `fallback_required` without browser scraping. With a private verified profile loaded and `npm run career-agent:executor` running, select **Prepare in browser** only on an actionable Lever packet; the host opens the verified `/apply` page, pauses for human boundaries, and stops at `ready_to_submit`. After the user submits manually, select **Mark as submitted** and confirm; only then does the service attempt the configured Google Sheets tracker sync. If the tracker host or credentials are unavailable, the application remains Applied and the UI exposes **Retry tracker sync**.

## Known limitations and roadmap

The preparation core has no URL ingestion or real resume PDF/DOCX generation. Career Agent additionally has no scheduler, ChatGPT delivery, authentication, or multi-user storage. The Google Sheets adapter is implemented behind the local Node host; the local OAuth client/token are not configured in this checkout, although the connected Sheets workflow completed one controlled temporary live upsert/readback/repeat/cleanup against the canonical tab. The Lever browser adapter supports only the common visible simple controls it can classify safely; it does not fill arbitrary custom widgets, bypass CAPTCHA/MFA, persist sessions to disk, or click Submit. The Node host is local-only, ephemeral, and not an authenticated remote service; a host restart loses its live browser session and the UI marks it interrupted. Remotive is a single public remote feed rather than broad job-market coverage; its public data is delayed and its terms do not authorize blindly forwarding listings to third-party submission systems. Brave broad discovery is a bounded, credentialed URL-search experiment with no claim of comprehensive coverage; it does not fetch result pages, scrape HTML, or resolve Ashby/Workday/custom/unknown references. Lever and Greenhouse are targeted only at explicitly configured employer SITE/board identifiers and are not global ATS searches. Greenhouse structured postings are not connected to a browser executor yet, even when their official hosted URL is classified as actionable for future executor work. Local storage is a single-browser workspace and is not a durable server-side record. The static source, simulated executor, and in-memory tracker are test/demo infrastructure, not production integrations.

The next sensible integration is a safe local/private resume-artifact workflow and expanded verified field fixtures. Any future submission path must require deliberate user approval, external proof, and the current policy/provenance model. Do not add a scheduler or multi-agent runtime until a source and executor are production-authorized.
