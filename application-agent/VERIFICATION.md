# Application Agent engineering verification — 2026-09-04

## Result

The local preparation workflow and synthetic campaign workflow work in a real
Chromium browser. This is **not evidence of a completed live job application**.
Live tracking is blocked by missing local Google Sheets configuration and OAuth
credentials. External-account testing and employer submission were not performed.

## Actual execution flow

- The React/Vite HQ routes `/application-agent` to the preparation workspace and
  `/career-agent` to the campaign workspace.
- `ApplicationService` normalizes pasted text, assesses fit, orders verified
  resume facts, prepares answers, and persists explicit human-input blockers.
  The default model boundary is deterministic local code, not a remote model.
- `CareerAgentService` discovers through source adapters, deduplicates, filters,
  prepares packets, applies campaign policy, records attention and execution
  outcomes, and attempts tracking after submission evidence or manual confirmation.
- The UI stores profiles, applications, and campaigns in browser localStorage.
  Its loopback execution-host client starts/polls/resumes Playwright preparation.
  Lever and verified Greenhouse routes are supported; final Submit remains manual.
- The separate Node background worker uses file-backed repositories, imported
  private profile/resume artifacts, and Slack attention responses. Its file state
  is separate from browser localStorage. It does not automatically appear in HQ.
- Google Sheets, Slack, source feeds, and the browser adapter have implementations.
  The demo source, simulated submission proof, and in-memory tracker are fixtures.

## Changes made in this takeover

1. Added a live-campaign form using the existing search-intent boundary. Roles,
   locations, excluded title terms, and remote preference now persist and appear
   in campaign details. Custom campaign names reflect the selected role.
2. Exposed browser preparation for direct Greenhouse sources in both the UI and
   the background worker's existing host-dispatch path. Existing host validation
   and manual submission boundaries remain authoritative.
3. Changed file-store loading to reject malformed, unsupported, and unreadable
   state. Only a missing file starts empty. Failed updates/removals retain saved
   memory, and temporary writes use exclusive private files with cleanup.
4. Added regression tests and a reproducible production-browser acceptance runner.

Pre-existing uncommitted work was retained. The much larger repository diff is
not all work performed during this takeover.

## Verification

- Baseline: 31 test files, 316 tests passed; TypeScript passed.
- Final unit/integration suite: **33 files, 326 tests passed**.
- `npm run build`: TypeScript project checks and production build passed.
  Vite warns that the main JavaScript chunk is 531.87 kB (149.05 kB gzip).
- `git diff --check`: passed. No separate lint command is configured.
- Independent Terra review of the focused storage diff: SUCCESS, no material
  correctness, restart, or persistence findings. It accepted the recorded test
  evidence without repeating the full suite.
- Separate read-only public-feed checks returned HTTP 200: Remotive returned
  17 jobs and `Access-Control-Allow-Origin: *`; Himalayas returned 20 jobs for
  the bounded request. Himalayas had no CORS header and remains a server-side
  source. These checks sent no candidate data or credentials.
- Real Chromium acceptance checks:
  - Prepared a packet, explicitly resolved six blockers, reloaded its deep link,
    and verified persisted `ready_for_review` state with no open blockers.
  - Created a custom live search and verified its criteria after reload without
    running external discovery.
  - Ran demo campaign discovery/preparation; verified rendered jobs and zero
    uncaught browser errors.
  - Used the actual Playwright form adapter to inspect, fill, and read back real
    controls; detected Submit without clicking it.

Run the suite with `npm test`. Run the production-browser checks with
`npm run test:acceptance`. Acceptance uses a fresh browser context and blocks
external requests. It does not start the configured Slack/background runtime.

## Environment and remaining limitations

- A private profile file and Slack configuration exist locally; their values were
  not printed or used to send messages.
- `ATELIER_GOOGLE_SHEET_ID`, Google authentication mode, access token/service-account
  configuration, and local OAuth client/token files were absent. The full live
  submission-to-tracker path cannot be validated here without configuration and
  authorization for the external action.
- Brave credentials were absent. Public structured feeds do not require that key,
  but bounded Brave discovery does.
- Chromium is installed but the normal Linux loader cannot find `libasound.so.2`.
  These checks passed using the existing local library at
  `/tmp/atelier-hq-alsa/extracted/usr/lib/x86_64-linux-gnu` via `LD_LIBRARY_PATH`.
  Browser execution also required running outside the restricted agent sandbox.
  For a durable Linux installation, install Playwright's OS dependencies, e.g.
  `npx playwright install --with-deps chromium`, before using the executor.
- Browser sessions are process-local and disappear on host restart. The UI and
  background store remain separate workspaces; there is no shared dashboard API.
- File replacement is atomic per write, not a multi-record transaction or a
  multi-process database. Run only one background worker per state file.
- The preparation core produces a structured tailored resume, while browser upload
  uses a configured existing artifact. It does not render a newly tailored PDF.
- Acceptance uses synthetic forms, not every employer's changing ATS controls.
  Unsupported forms, authentication, CAPTCHA, and final submission require a human.

## Best next action

Configure the canonical Google Sheet and local OAuth access, then authorize one
bounded live preparation/manual-confirmation/tracker verification. That is needed
before claiming the live workflow works end-to-end.
