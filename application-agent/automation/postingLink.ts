/**
 * One posting can be linked several ways: Ashby serves the same job at
 * `/span.app/<id>` and `/Span.app/<id>/application`. Compare links without
 * case, scheme, `www.`, query, fragment, trailing slash or a trailing
 * apply/application step, so a second spelling is not a new job.
 */
export function postingLinkKey(link: unknown): string {
  return String(link ?? "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "")
    .replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/\/(?:application|apply)$/, "");
}
