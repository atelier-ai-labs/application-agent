# Kapitus CAPTCHA recheck — 2026-09-05

The prior false positive was `visible_challenge_iframe`: the detector classified
an invisible-mode reCAPTCHA enterprise anchor inside the visible attribution badge
as an interactive challenge. The real recheck now records:

- `captcha-state:infrastructure_present`
- Six markers, three visible markers, zero challenge iframes.
- `captcha-evidence:passive_infrastructure`

Known passive badge infrastructure no longer blocks preparation. Visible challenge
frames/controls still block; ambiguous frames, unexpected badge controls, and DOM
observation failure remain uncertain and block. The trusted host can additionally
restrict field classifications for bounded preparation; the recheck allowed only
contact and resume-upload classifications.

Validation: 327 tests passed across 33 files, TypeScript/production build passed,
and nine real-Chromium local CAPTCHA fixtures passed. The initial sandboxed full
suite failed on loopback server permissions; the final suite passed outside that
sandbox. Independent review found an overly broad passive-badge exception, which
was corrected and covered by the unexpected-control fixture before live execution.

The same durable Kapitus application was reopened through the trusted HTTP host
and reconciled through the background service. Five contact controls were filled
(`first_name`, `last_name`, `preferred_name`, `email`, `phone`), and the configured
resume was uploaded. No candidate values are recorded here.

Execution then failed: the adapter tried another file field labelled “Attach”,
but its saved positional locator now pointed to the school combobox. Two existing
issues are implicated: all file controls are classified as resume uploads, and
field locators use mutable DOM indices. The existing preferred-name mapping also
needs review before another live run; the filled name is not evidence of a
separately verified preferred-name fact.

No genuine ATS_FORM question was published. The earlier CAPTCHA attention event
remains open in the original Slack thread; its old published timestamp must not
be counted as successful delivery of a new question. Execution was stopped and
the temporary browser host closed. A private state backup was made before the run.
The existing service failure path marked the same application packet failed;
continuation must recover that packet rather than create a replacement.

Submit was not clicked, no application.applied event was emitted, no tracker was
configured or written, and submission authority remained NEVER. No CAPTCHA was
solved or bypassed. No campaign or application was created.

Next: narrowly repair stable field targeting and distinguish resume from other
uploads, reconcile the stale CAPTCHA attention state through the service, then
resume this same application to the first unresolved ATS_FORM question. Do not
repeat the live run against the current positional locators.
