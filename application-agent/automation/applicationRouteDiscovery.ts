import type {
  BrowserApplicationRouteDiscovery,
  LeverBrowserSessionFactory,
} from "../src/domain/executor";
import { safeBrowserDiagnosticMessage } from "../src/domain/executor";

export interface ApplicationRouteDiscoveryInput {
  jobId: string;
  company: string;
  role: string;
  sourceUrl: string;
}

export interface ApplicationRouteDiscoverer {
  discover(input: ApplicationRouteDiscoveryInput): Promise<BrowserApplicationRouteDiscovery>;
}

/**
 * Opens one public listing in an ephemeral browser, performs the bounded
 * Apply-link discovery step, and closes that browser before the trusted ATS
 * preparation flow begins. No candidate data is sent during discovery.
 */
export class PlaywrightApplicationRouteDiscoverer implements ApplicationRouteDiscoverer {
  constructor(private readonly sessionFactory: LeverBrowserSessionFactory) {}

  async discover(input: ApplicationRouteDiscoveryInput): Promise<BrowserApplicationRouteDiscovery> {
    let session;
    try {
      session = await this.sessionFactory.open(`route-discovery:${input.jobId}`);
      await session.navigate(input.sourceUrl);
      const unavailable = await session.detectUnavailablePage?.();
      if (unavailable) {
        return {
          status: "blocked",
          reason: "The public listing is no longer available.",
          evidence: [...unavailable.evidence.slice(0, 6), "apply:not-clicked"],
        };
      }
      if (!session.discoverApplicationRoute) {
        return {
          status: "failed",
          reason: "The configured browser session does not support bounded Apply-link discovery.",
          evidence: ["route-discovery:unsupported"],
        };
      }
      return await session.discoverApplicationRoute(input.company, input.role);
    } catch (error) {
      return {
        status: "failed",
        reason: safeBrowserDiagnosticMessage(error, "The public listing could not be inspected for an application link."),
        evidence: ["route-discovery:failed"],
      };
    } finally {
      await session?.close().catch(() => undefined);
    }
  }
}
