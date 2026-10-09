# ATS browser execution boundary

This directory contains the Node-only browser host for the existing
`ApplicationExecutor` seam. It is intentionally outside the Vite client
source tree so Playwright, browser sessions, and local resume paths cannot be
bundled into the public HQ application.

## What is implemented

- `PlaywrightLeverBrowserSessionFactory` launches an ephemeral Chromium context.
- `PlaywrightLeverBrowserSession` navigates to an already-verified Lever,
  Greenhouse, Rippling, Workday, or narrowly verified direct application
  destination such as YouHired or Matlen Silver
  route, inspects visible simple
  form controls, and exposes deterministic fill/select/check/upload operations.
- `createPlaywrightLeverBrowserExecutor()` wires that session to the existing
  browser-neutral executor; the class name is retained for compatibility.

The domain executor validates live provider provenance again immediately before
navigation. It maps only verified profile facts, explicitly resolved answers,
approved grounded drafts, and an injected local resume artifact. It can pause
for login/MFA/CAPTCHA, unknown fields, policy-sensitive questions, or missing
artifacts. It keeps the session in process memory so the host can call
`execute()` again after a blocker is resolved; a restart loses the session and
replays only deterministic known values.

The final Submit control is inspection-only by default. The executor never
submits unless both the persisted campaign explicitly authorizes `automatic`
submission and the server-only execution host is configured with
`ATELIER_EXECUTION_SUBMISSION_AUTHORITY=automatic`. In that explicit mode it
clicks only the verified final control and returns proof only after deterministic
confirmation. A durable local application/job fence prevents duplicate workers
or restarted processes from clicking twice; an ambiguous post-click outcome is
terminal and requires human verification.

## Local execution host

The root application does not run Playwright from the browser. The dedicated
loopback Node host in `executionHost/` injects the existing executor and exposes
only these domain-specific routes:

```text
GET  /health
POST /career-agent/executions
GET  /career-agent/executions/:id
POST /career-agent/executions/:id/resume
POST /career-agent/executions/:id/cancel
POST /career-agent/tracker-sync
```

Start it separately from the Vite process:

```bash
npm run career-agent:executor
```

The default URL is `http://127.0.0.1:8787`. The default is headed Chromium so
the user can complete CAPTCHA/login/MFA directly in the real browser window.
Use `ATELIER_EXECUTION_HEADLESS=true` for an inspection-only or CI run. The
host binds to loopback and accepts only exact configured Vite origins; it does
not expose arbitrary navigation, selectors, JavaScript, or typing endpoints.

The client sends the current validated campaign, career job, application
packet, and profile. The host revalidates all of them, requires a private/local
profile, requires live actionable provider provenance, and navigates only to the
verified application route. A frontend cannot provide a filesystem path. If a
resume upload is needed, configure an existing local artifact with
`ATELIER_RESUME_ROOT` and one of the family-specific path variables in
`.env.local` for the Node process, or use the ignored local manifest described
below. The configured path must remain inside the root and is checked again
when upload is attempted.

The same host exposes the narrow `POST /career-agent/tracker-sync` route for
the configured Google Sheets tracker. It accepts only an already-applied,
live, non-simulated application context and never accepts browser commands or
candidate credentials. The browser client calls this route only after the user
explicitly confirms a successful manual submission.

Install the package and browser once from the repository root:

```bash
npm install
npx playwright install chromium
```

The managed verification environment required an isolated copy of
`libasound.so.2` because system dependency installation requires administrator
authentication. With that library path supplied, a read-only inspection
successfully opened a current public Lever application and detected its live
form. The page presented a CAPTCHA, so the executor stopped with a `captcha`
blocker without filling or submitting anything. That live run remains an
acceptance check, not a fallback to simulated browser success; deterministic
fake-session tests remain the CI path.

## Session lifecycle and human handoff

The host registry keeps the prepared request and browser executor session in
process memory under an opaque execution ID. It supports one active browser by
default (configurable to a small positive limit), generous inactivity timeout,
same-session resume, cancellation, and graceful shutdown cleanup.

When CAPTCHA, login, MFA, or external verification is detected, the result is
`waiting_for_human` with a structured blocker. The browser remains open where
possible. For an active CAPTCHA, the host watches the same page's safe CAPTCHA
state and resumes automatically as soon as manual completion is observed; the
user should complete the challenge while that browser remains open. The
existing **Resume browser** action remains a fallback for a paused session and
for other human boundaries. In either case, the host invokes the existing
executor for the same application ID, so it can reuse its page/session and does
not regenerate the preparation packet. If the host process restarts, its
in-memory browser handle is gone. The persisted HQ record is marked interrupted
on the next UI load and the user can start a fresh preparation.

## Session and privacy limits

Contexts are ephemeral and are not saved to disk. The executor does not request
or persist passwords, cookies, MFA codes, CAPTCHA tokens, or arbitrary page
HTML. A host may keep a live session for human handoff, but it closes the
executor on cancel, timeout, failure, and shutdown. The serializable career
execution record contains field identifiers, labels, blocker reasons, safe
evidence, an opaque execution ID, and the selected resume family—not browser
credentials, cookies, filesystem handles, or field values. Host logs contain
execution/application/job IDs, statuses, timing, and high-level reasons; they
do not log the request body.

Final application submission remains a manual user action. The host does not
click Submit, trigger a keyboard submit shortcut, call an ATS submission API,
or emit `application.submitted`/`application.applied`. It also cannot write an
Applied tracker record before the user confirms the submission in HQ. After
that confirmation, HQ records `application.applied` first and the separate
server-side tracker route may update the canonical sheet; a tracker failure
leaves the application applied and exposes retry state. A future executor may
add a separate explicit approval/submission lane, but it must not weaken the
current trust, policy, provenance, and external-proof checks.

## Background search intent

The background runtime optionally loads the provider-neutral user search policy
from `.local/career-agent/search-intent.json`. It is bounded, portable JSON
with role lanes, seniority preferences/exclusions, location/remote preference,
employment type, compensation floor, and search breadth. The runtime
materializes compatible legacy criteria for existing providers; it does not
send candidate profile data to discovery providers. If the file is absent,
legacy campaign criteria remain available for compatibility.

The runtime always registers the credential-free `HimalayasJobSource` in
addition to Remotive. It calls the server-side filtered JSON endpoint only;
the browser workspace does not import or invoke it. One cycle uses at most
three deterministic lane queries and one page of at most 20 jobs per query.
Himalayas records remain discovery-only, including when their provider-supplied
application link points directly at an ATS.

## Configuration

| Variable                                                         | Default                                                      | Purpose                                                                                                                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_EXECUTION_HOST_BASE_URL`                                   | `http://127.0.0.1:8787`                                      | Browser client URL for the loopback host.                                                                                                                           |
| `ATELIER_CAREER_AGENT_STATE_FILE`                                | `.local/career-agent/state.json`                             | Shared server-side campaign/application state; ignored by Git.                                                                                                      |
| `ATELIER_CAREER_AGENT_PROFILE_FILE`                              | unset                                                        | Required server-only private candidate profile JSON for the background runtime.                                                                                     |
| `ATELIER_CAREER_AGENT_SEARCH_INTENT_FILE`                        | `.local/career-agent/search-intent.json` when present        | Optional server-only provider-neutral job-search intent.                                                                                                            |
| `ATELIER_HIMALAYAS_API_BASE_URL`                                 | `https://himalayas.app/jobs/api/search`                      | Server-only Himalayas filtered JSON endpoint override; no credential is required.                                                                                   |
| `ATELIER_CAREER_AGENT_DESTINATION_EVIDENCE_FILE`                 | `.local/career-agent/destination-evidence.json` when present | Optional server-only bounded list of reviewed public employer/ATS application evidence; it never contains candidate data and is never read by the browser client.   |
| `ATELIER_CAREER_AGENT_BROWSER_ENABLED`                           | `false`                                                      | Explicitly run the existing preparation-only Playwright executor inside the runtime; otherwise the loopback host owns browser execution.                            |
| `ATELIER_CAREER_AGENT_ROUTE_DISCOVERY_ENABLED`                   | `true`                                                       | Queue-only bounded fallback for unsupported listing URLs: verify the public role, click one exact Apply control, and continue only when the resulting URL passes the supported ATS checks. |
| `ATELIER_CAREER_AGENT_CAMPAIGN_ID`                               | unset                                                        | Existing durable campaign to run when startup execution is explicitly enabled.                                                                                      |
| `ATELIER_CAREER_AGENT_DAILY_HUNT_FILE`                           | unset                                                        | Optional one-shot UTF-8 snapshot of a Daily job hunt message. Explicit Apply links are bounded and sent through the existing curated path; no web scraping is performed. The currently supported live destinations are verified Lever, Rippling, Ashby, the exact YouHired job route, the exact Matlen Silver job route, and the exact current Protagona ApplyToJob route. |
| `ATELIER_CAREER_AGENT_EXIT_AFTER_DAILY_HUNT`                     | `false`                                                      | Close the runtime after the one-shot Daily job hunt intake; use this when replacing an already-running runtime for a single batch.                                  |
| `ATELIER_CAREER_AGENT_RUN_ON_START`                              | `false`                                                      | Explicitly run one campaign cycle at startup.                                                                                                                       |
| `ATELIER_CAREER_AGENT_CREATE_CAMPAIGN`                           | `false`                                                      | Explicitly create the configured default live campaign when no campaign ID is supplied.                                                                             |
| `ATELIER_EXECUTION_HOST_BASE_URL`                                | `http://127.0.0.1:8787`                                      | Server-side URL for the existing execution host used by background resume.                                                                                          |
| `ATELIER_CAREER_AGENT_HOST_POLL_INTERVAL_MS`                     | `500`                                                        | Poll interval while reconciling one existing host execution.                                                                                                        |
| `ATELIER_CAREER_AGENT_HOST_POLL_TIMEOUT_MS`                      | `1800000`                                                    | Bound for one host execution reconciliation.                                                                                                                        |
| `ATELIER_CAREER_AGENT_ANSWER_DRAFT_MODE`                         | `disabled`                                                   | Set to `ollama` to generate grounded answers for exact ATS free-text questions; campaigns with `allowGroundedDrafts` enabled may use them automatically, while other campaigns keep human review. |
| `ATELIER_CAREER_AGENT_OLLAMA_BASE_URL`                           | `http://127.0.0.1:11434`                                     | Server-only local Ollama endpoint.                                                                                                                                  |
| `ATELIER_CAREER_AGENT_OLLAMA_MODEL`                              | unset                                                        | Local Ollama model name; required when draft mode is `ollama`.                                                                                                      |
| `ATELIER_CAREER_AGENT_OLLAMA_TIMEOUT_MS`                         | `20000`                                                      | Bounded local model request timeout.                                                                                                                                |
| `ATELIER_EXECUTION_HOST`                                         | `127.0.0.1`                                                  | Host bind address; non-loopback is rejected by default.                                                                                                             |
| `ATELIER_EXECUTION_PORT`                                         | `8787`                                                       | Host port.                                                                                                                                                          |
| `ATELIER_EXECUTION_ALLOWED_ORIGINS`                              | local Vite/preview origins                                   | Comma-separated exact origins; wildcard is not accepted.                                                                                                            |
| `ATELIER_EXECUTION_ALLOW_NON_LOOPBACK`                           | `false`                                                      | Explicitly opt into a non-loopback bind; this remains unauthenticated local infrastructure and is not recommended.                                                  |
| `ATELIER_EXECUTION_HEADLESS`                                     | `false`                                                      | Whether Chromium is headless.                                                                                                                                       |
| `ATELIER_EXECUTION_BROWSER_TIMEOUT_MS`                           | `15000`                                                      | Browser navigation/control timeout.                                                                                                                                 |
| `ATELIER_EXECUTION_MAX_CONCURRENT`                               | `1`                                                          | Small local session capacity.                                                                                                                                       |
| `ATELIER_EXECUTION_SESSION_TIMEOUT_MS`                           | `1800000`                                                    | In-memory session inactivity timeout.                                                                                                                               |
| `ATELIER_EXECUTION_SUBMISSION_AUTHORITY`                         | `never`                                                      | Server-only final-submission capability. `automatic` requires a persisted campaign with automatic authority and verified confirmation; any other value is rejected. |
| `ATELIER_EXECUTION_PREPARATION_ONLY`                             | `false`                                                      | Preparation-only safety override. Automatic campaigns may fill the visible form and stop at `Ready to Submit`; no submit callbacks, fences, or clicks are available. |
| `ATELIER_HANDOFF_VIEWER_ENABLED`                                | `false`                                                      | Starts the separate loopback-only human handoff viewer. It shows the paused browser and accepts taps only inside one recognized CAPTCHA provider frame; it has no form, navigation, keyboard, or Submit controls. |
| `ATELIER_HANDOFF_VIEWER_PORT`                                   | `8790`                                                       | Loopback viewer port.                                                                                                                                              |
| `ATELIER_HANDOFF_VIEWER_ORIGIN`                                 | `http://127.0.0.1:8790`                                     | Exact viewer origin. Keep the loopback origin for local-only use; public origins must use HTTPS.                                                                    |
| `ATELIER_HANDOFF_QUICK_TUNNEL_ENABLED`                         | `false`                                                      | Starts an optional Cloudflare Quick Tunnel to the isolated viewer only. Requires `cloudflared`; no Cloudflare account or domain is required.                         |

To open a verification handoff from Slack on another device, enable both
`ATELIER_HANDOFF_VIEWER_ENABLED=true` and
`ATELIER_HANDOFF_QUICK_TUNNEL_ENABLED=true`, then restart the execution host.
The host starts a temporary HTTPS tunnel to the viewer only; its browser
execution API remains bound to loopback. Slack receives a short-lived link
only while an execution is waiting for human verification. The token stays in
the link fragment so link previews cannot redeem it; opening the page exchanges
it for an HttpOnly session cookie. Links are single-use, expire quickly, and
should not be forwarded. The viewer streams the current page and permits human
clicks only inside a recognized CAPTCHA iframe. It cannot interact with the
rest of the form or submit the application. The temporary Cloudflare URL
changes when the execution host restarts.
| `ATELIER_SLACK_BOT_TOKEN`                                        | unset                                                        | Server-only Slack bot token for `chat.postMessage`/`chat.update`.                                                                                                   |
| `ATELIER_SLACK_APP_TOKEN`                                        | unset                                                        | Server-only Slack app-level token for Socket Mode `apps.connections.open`.                                                                                          |
| `ATELIER_SLACK_CHANNEL_ID`                                       | unset                                                        | Exact channel receiving actionable Career Agent questions.                                                                                                          |
| `ATELIER_SLACK_ALLOWED_USER_ID`                                  | unset                                                        | Exact Slack user allowed to answer attention events.                                                                                                                |
| `ATELIER_SLACK_ALLOWED_TEAM_ID`                                  | unset                                                        | Optional exact Slack workspace/team restriction.                                                                                                                    |
| `ATELIER_SLACK_API_BASE_URL`                                     | `https://slack.com/api`                                      | HTTPS Slack API base; normally left at the default.                                                                                                                 |
| `VITE_BROAD_DISCOVERY_ENABLED`                                   | `false`                                                      | Browser-readable opt-in for adding the bounded broad-reference source to newly created live campaigns.                                                              |
| `ATELIER_BRAVE_SEARCH_API_KEY`                                   | unset                                                        | Server-only Brave Search Web API subscription token; required for live broad discovery.                                                                             |
| `ATELIER_BRAVE_SEARCH_API_BASE_URL`                              | `https://api.search.brave.com/res/v1/web/search`             | HTTPS endpoint override for the documented Brave Web Search API.                                                                                                    |
| `ATELIER_BRAVE_SEARCH_MAX_QUERIES`                               | `3`                                                          | Maximum deterministic queries per cycle, bounded to `1..10`.                                                                                                        |
| `ATELIER_BRAVE_SEARCH_MAX_RESULTS_PER_QUERY`                     | `10`                                                         | Maximum results requested per query, bounded to `1..20`.                                                                                                            |
| `ATELIER_BRAVE_SEARCH_MAX_TOTAL_REFERENCES`                      | `30`                                                         | Maximum retained URL references per cycle, bounded to `1..200`.                                                                                                     |
| `ATELIER_BRAVE_SEARCH_CACHE_TTL_MS`                              | `300000`                                                     | In-memory reuse window for successful/empty/partial responses; `0` disables it.                                                                                     |
| `ATELIER_BRAVE_SEARCH_TIMEOUT_MS`                                | `8000`                                                       | Per-query broad-discovery timeout.                                                                                                                                  |
| `ATELIER_BRAVE_SEARCH_COUNTRY` / `ATELIER_BRAVE_SEARCH_LANGUAGE` | `US` / `en`                                                  | Optional search locale controls.                                                                                                                                    |
| `ATELIER_RESUME_ROOT`                                            | unset                                                        | Allowed local root for existing resume artifacts.                                                                                                                   |
| `ATELIER_RESUME_MANIFEST_FILE`                                   | `.local/career-agent/resume-artifacts.json`                  | Ignored family-to-artifact mapping written by the local resume importer.                                                                                            |
| `ATELIER_RESUME_*_PATH`                                          | unset                                                        | Existing family artifact paths under that root.                                                                                                                     |
| `ATELIER_GOOGLE_SHEET_ID`                                        | unset                                                        | Canonical Google spreadsheet ID; required for real tracker writes.                                                                                                  |
| `ATELIER_GOOGLE_SHEET_NAME`                                      | `Nate Job Search Tracker`                                    | Exact spreadsheet title guard.                                                                                                                                      |
| `ATELIER_GOOGLE_SHEET_TAB`                                       | `Job Tracker`                                                | Exact tab containing the existing tracker headers.                                                                                                                  |
| `ATELIER_GOOGLE_SHEET_QUEUE_TAB`                                | `Application Queue`                                          | Dedicated application queue tab consumed by `career-agent:queue --poll`; it is never inferred from the tracker tab.                                                   |
| `ATELIER_GOOGLE_AUTH_MODE`                                       | unset                                                        | `oauth` (preferred), `service_account`, or `access_token`; required when multiple lanes are present.                                                                |
| `ATELIER_GOOGLE_OAUTH_CLIENT_FILE`                               | `.local/google-oauth-client.json`                            | Server-only Google Desktop OAuth client JSON.                                                                                                                       |
| `ATELIER_GOOGLE_TOKEN_FILE`                                      | `.local/google-sheets-token.json`                            | Server-only refreshable OAuth token file.                                                                                                                           |
| `ATELIER_GOOGLE_APPLICATION_CREDENTIALS`                         | unset                                                        | Retained server-only service-account JSON path, shared with the sheet.                                                                                              |
| `ATELIER_GOOGLE_ACCESS_TOKEN`                                    | unset                                                        | Retained server-only short-lived OAuth access-token alternative.                                                                                                    |
| `ATELIER_GOOGLE_SHEETS_TIMEOUT_MS`                               | `10000`                                                      | Google Sheets/OAuth request timeout.                                                                                                                                |

Do not put private resume paths, candidate values, browser cookies, or
credentials in Vite variables or source control. This host is a local trusted
boundary, not an authenticated remote service.

## Grounded local resume import

Keep the real resume artifact under the ignored local directory
`.local/career-agent/resumes/`. The importer currently supports the first
`cloud-platform` family and reads PDF or DOCX text deterministically. It adds only facts explicitly
present in the artifact to the private profile; it never fills work
authorization, sponsorship, compensation, relocation, travel, demographic, or
legal fields.

Use the local workflow:

```bash
mkdir -p .local/career-agent/resumes
# Place the real cloud-platform.pdf or cloud-platform.docx here.
npm run career-agent:import-resume -- --family cloud-platform
# If the artifact is DOCX rather than the default PDF name:
# npm run career-agent:import-resume -- --family cloud-platform --file .local/career-agent/resumes/cloud-platform.docx
npm run career-agent:executor
npm run career-agent:runtime
```

For an always-on local listener, run the runtime under a user service rather
than inside a one-shot queue command. The repository includes
`runtime/atelier-career-agent.service`; copy it to
`~/.config/systemd/user/atelier-career-agent.service`, adjust
`WorkingDirectory` and `EnvironmentFile` if the checkout is elsewhere, then
run `systemctl --user daemon-reload` and
`systemctl --user enable --now atelier-career-agent`. The service restarts the
listener after process or Slack Socket Mode failure. Keep the queue's
`career-service` processor bounded; it must not be the owner of the long-lived
Slack connection.

The import command atomically refreshes the private profile and writes the
ignored `.local/career-agent/resume-artifacts.json` family mapping. The
existing Lever executor resolves that mapping server-side and uses its existing
safe file-input upload boundary; it stops before the final Submit control.
Review the non-sensitive counts printed by the importer before starting a
campaign. A missing or unsupported artifact is a configuration blocker, not a
reason to invent a profile fact.

## Slack attention transport

The Slack adapter is Node-only and uses Slack Socket Mode, so the local
listener does not require a publicly reachable webhook. Create a Slack app,
enable Socket Mode and Interactivity, grant the bot `chat:write`, create an
app-level token with `connections:write`, invite the bot to the configured
channel, and set the four required `ATELIER_SLACK_*` variables from the table
above. Optionally set `ATELIER_SLACK_ALLOWED_TEAM_ID` as a workspace guard.

For live operation, use the background runtime:

```bash
npm run career-agent:runtime
```

The runtime owns the single Slack Socket Mode connection and injects the
CareerAgentService response handler and existing host-resume callback. Do not
run `npm run career-agent:slack` alongside it: that standalone command is
transport-only, has no service response handler, and can trigger Slack's
`too_many_websockets` disconnect when both are running. The transport accepts
only one configured user, workspace (when configured), channel, open event,
and valid event option; it never guesses answers, changes profile facts, or
submits an application. Missing configuration fails before any Slack request
is made.

## Background Career Agent runtime

The background runtime is the canonical owner for background campaign,
application, job, event, and attention state. It reuses the existing
`LocalStorageCareerRepository` and `LocalStorageApplicationRepository` over a
server-only file-backed `KeyValueStorage`; the default path is
`.local/career-agent/state.json`. Writes replace the file atomically, and
malformed domain records are isolated by the existing repository validators.
The file is ignored by Git and contains no Slack credentials, browser session
objects, cookies, or tokens.

The current web Career Agent page remains an engineering/debug console and
continues to use browser-local storage. It is intentionally not synchronized
with this background state in this task. Create or operate background campaigns
through the runtime instead of assuming the browser console's local campaigns
are visible to it.

The runtime requires a private profile file and all four required Slack
variables. The safer default leaves Playwright in the existing loopback
`career-agent:executor` process; the runtime starts that host for prepared live
Lever jobs and reconciles its typed snapshots. Set
`ATELIER_CAREER_AGENT_BROWSER_ENABLED=true` only when the existing
preparation-only Playwright executor should run in the background process
itself. A host/browser restart never serializes a browser handle: the next
resume reopens the verified application route and re-inspects it before using
the one-time answer.

Run the local background flow in two terminals:

```bash
# Terminal 1: existing trusted loopback browser host
npm run career-agent:executor

# Terminal 2: shared state + Slack attention runtime
npm run career-agent:runtime
```

The runtime starts the Slack Socket Mode listener, publishes only durable open
attention events that still need delivery, and then waits. To create and run
one default live campaign on startup, set
`ATELIER_CAREER_AGENT_CREATE_CAMPAIGN=true` and
`ATELIER_CAREER_AGENT_RUN_ON_START=true`. To run an existing campaign, set
`ATELIER_CAREER_AGENT_CAMPAIGN_ID` and
`ATELIER_CAREER_AGENT_RUN_ON_START=true`. There is no scheduler in this task;
`runCampaign()` remains the explicit caller-driven cycle boundary.

To process one copied Daily job hunt report through the same existing campaign,
stop any existing Career Agent runtime first (it owns the single Slack Socket
Mode connection), then start one bounded intake run with the existing campaign
ID and a local UTF-8 snapshot file:

```bash
ATELIER_CAREER_AGENT_CAMPAIGN_ID=campaign-id \
ATELIER_CAREER_AGENT_DAILY_HUNT_FILE=/path/to/daily-hunt.txt \
ATELIER_CAREER_AGENT_EXIT_AFTER_DAILY_HUNT=true \
npm run career-agent:daily-hunt
```

The snapshot parser considers only explicit Markdown Apply links, caps the
batch at eight candidates, and sends each candidate through the existing
verified Lever/Rippling/Ashby/YouHired/Matlen Silver/Protagona curated path. Company homepages, missing apply
links, unsupported/custom destinations, and incomplete public context are
skipped with a safe reason; they are never converted into guessed application
URLs. This is a handoff boundary for the Daily job hunt conversation, not a
ChatGPT connector or a scheduler.

Shutdown stops Slack and closes only browser sessions owned by an embedded
runtime executor. The separate execution host owns its own session lifecycle;
stop it separately when it should close its browsers. Restarting the runtime
reloads the file state, republishes only open attention events that were not
acknowledged, and accepts a response through the same Career Agent service.
To intentionally reset local runtime state, stop the processes and remove the
specific ignored `.local/career-agent/state.json` file after confirming it is
the state file configured for this checkout.

### Personal Google OAuth setup

1. In Google Cloud, create a Desktop OAuth client for the Google account that
   owns or can edit the existing tracker. Download its JSON to a private path
   such as `.local/google-oauth-client.json`; the file is ignored by this repo.
2. Set `ATELIER_GOOGLE_SHEET_ID` to the verified existing spreadsheet ID,
   `ATELIER_GOOGLE_AUTH_MODE=oauth`, and optionally
   `ATELIER_GOOGLE_OAUTH_CLIENT_FILE` / `ATELIER_GOOGLE_TOKEN_FILE` in the
   server process environment or `.env.local`.
3. Run:

   ```bash
   npm run career-agent:google-auth
   ```

   Google authorization opens in the browser. Atelier HQ starts a temporary
   loopback callback on `127.0.0.1`, validates state, uses PKCE, exchanges the
   code, and stores only the refreshable token in the private token file. The
   requested scope is exactly `https://www.googleapis.com/auth/spreadsheets`;
   no general Drive scope is requested.

4. Start the host with `npm run career-agent:executor`. The host loads and
   refreshes the token server-side when the user confirms an application as
   Applied. The browser UI receives only a success/failure result, never an
   OAuth credential.

The auth command does not send credentials through the Career Agent UI. If a
stored grant is revoked or refresh fails, the tracker remains failed/pending
and the UI exposes retry. Remove the local token file and revoke Atelier HQ in
the Google account before re-running authorization when re-consent is needed.

## Google Sheets tracker

`googleAuth.ts` is the local CLI entrypoint and `googleOAuth.ts` is the
Node-only OAuth/refresh/storage boundary. `GoogleSheetsJobTracker` is a
Node-only adapter for the existing `Job Tracker`
tab in `Nate Job Search Tracker`. It maps columns by their existing header
names, verifies the spreadsheet title and tab before writing, and performs a
small `values:batchUpdate` only after an application has been explicitly
confirmed Applied. It never creates a spreadsheet, tab, header, XLSX, CSV, or
submission request.

The adapter owns the application fields it can authoritatively derive:
Company, Role, Job Link, Location / Remote, known Salary Min/Max, Fit, Priority,
Status, Date Found, Date Applied, Resume Version, and Next Step. Follow-Up Date,
Contact / Referral, and Notes remain user-owned and are never overwritten. Row
identity checks canonical application/job URLs first, then provider job ID, then
normalized company + role + location. A retry matches the same row before any
write, so a failed sync does not cause a duplicate Applied row.

The default UI/demo path uses the in-memory tracker. A live posting uses the
configured server adapter; missing credentials, unavailable Sheets access,
header mismatch, timeout, permission failure, and malformed acknowledgements
produce a failed sync rather than simulated success. The current repository has
no local OAuth client/token configured, so real writes are not claimed until
those variables are provided and a safe live row update is verified. The
connected Sheets workflow has separately verified one temporary live
upsert/readback/repeat/cleanup against the canonical tab; that does not stand
in for configuring the local Node OAuth client. A tracker write is never
submission proof, and the executor's final Submit boundary remains closed.
### Page-first direct applications

Unknown ATS pages use the shared rendered-form executor only for explicitly
curated applications whose destination has been validated by the server-side
official-employer evidence file. The evidence must match the company, role,
current application page, official domain, and exact HTTPS URL. The executor
verifies the rendered page identity and same-origin form action, then prepares
the form without activating Submit. Standalone queue links begin with the same
recognized ATS allowlist. When a queue row instead contains a public listing or
aggregator URL, the queue can perform one bounded read-only discovery pass: it
verifies the visible company and role, clicks one exact Apply control, and
continues only when the resulting URL passes the same supported-route checks.
Ambiguous controls, identity mismatches, human-verification boundaries, and
unsupported destinations remain `Needs Input`; discovery never fills fields or
clicks Submit.
