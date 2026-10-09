import { createHash, randomBytes } from "node:crypto";

/** View plus server-discovered provider-frame actions; generic browser input is never exposed. */
export type HandoffAction = "view";

export interface HandoffGrant {
  executionId: string;
  /** Opaque value returned only to the caller that issued the grant. */
  token: string;
  expiresAt: number;
}

export interface HandoffSession {
  executionId: string;
  /** Opaque session token. Never persist or log this value. */
  token: string;
  expiresAt: number;
  capabilities: readonly HandoffAction[];
}

interface StoredBootstrap {
  executionId: string;
  expiresAt: number;
}

interface StoredSession {
  executionId: string;
  expiresAt: number;
  capabilities: readonly HandoffAction[];
}

export interface HandoffBoundaryOptions {
  now?: () => number;
  bootstrapTtlMs?: number;
  sessionTtlMs?: number;
}

export class HandoffBoundaryError extends Error {
  constructor(message: string, public readonly code: "invalid" | "expired" | "revoked" | "forbidden") {
    super(message);
    this.name = "HandoffBoundaryError";
  }
}

function defaultNow(): number {
  return Date.now();
}

function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

function digest(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

function requirePositiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result <= 0) throw new Error(`${name} must be a positive integer.`);
  return result;
}

/**
 * In-memory security boundary for the remote browser viewer.
 *
 * The bootstrap token is one-time: redeeming it creates a separate session
 * token and immediately consumes the bootstrap token. Session tokens are
 * scoped to one execution and carry only view capability. This
 * class intentionally has no browser, registry, or HTTP dependencies.
 */
export class HandoffBoundary {
  private readonly now: () => number;
  private readonly bootstrapTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly bootstraps = new Map<string, StoredBootstrap>();
  private readonly sessions = new Map<string, StoredSession>();

  constructor(options: HandoffBoundaryOptions = {}) {
    this.now = options.now ?? defaultNow;
    this.bootstrapTtlMs = requirePositiveInteger(options.bootstrapTtlMs, 2 * 60_000, "bootstrapTtlMs");
    this.sessionTtlMs = requirePositiveInteger(options.sessionTtlMs, 10 * 60_000, "sessionTtlMs");
  }

  issue(executionId: string): HandoffGrant {
    if (!executionId.trim()) throw new HandoffBoundaryError("An execution ID is required.", "invalid");
    this.prune();
    this.revoke(executionId);
    const token = newSecret();
    const expiresAt = this.now() + this.bootstrapTtlMs;
    this.bootstraps.set(digest(token).toString("base64url"), { executionId, expiresAt });
    return { executionId, token, expiresAt };
  }

  redeem(token: string): HandoffSession {
    this.prune();
    const bootstrap = this.findSecret(this.bootstraps, token);
    if (!bootstrap) throw new HandoffBoundaryError("The handoff link is invalid, expired, or already used.", "invalid");
    this.deleteSecret(this.bootstraps, token);
    if (bootstrap.expiresAt <= this.now()) throw new HandoffBoundaryError("The handoff link has expired.", "expired");
    const sessionToken = newSecret();
    const session: StoredSession = {
      executionId: bootstrap.executionId,
      expiresAt: this.now() + this.sessionTtlMs,
      capabilities: ["view"],
    };
    this.sessions.set(digest(sessionToken).toString("base64url"), session);
    return { executionId: session.executionId, token: sessionToken, expiresAt: session.expiresAt, capabilities: session.capabilities };
  }

  authenticate(token: string, executionId: string, action: HandoffAction = "view"): HandoffSession {
    this.prune();
    const session = this.findSecret(this.sessions, token);
    if (!session) throw new HandoffBoundaryError("The handoff session is invalid or expired.", "invalid");
    if (session.expiresAt <= this.now()) {
      this.deleteSecret(this.sessions, token);
      throw new HandoffBoundaryError("The handoff session has expired.", "expired");
    }
    if (session.executionId !== executionId) throw new HandoffBoundaryError("The handoff session is scoped to another execution.", "forbidden");
    if (!session.capabilities.includes(action)) throw new HandoffBoundaryError("That handoff action is not permitted.", "forbidden");
    return { executionId: session.executionId, token, expiresAt: session.expiresAt, capabilities: session.capabilities };
  }

  revoke(executionId: string): void {
    for (const [token, session] of this.sessions) if (session.executionId === executionId) this.sessions.delete(token);
    for (const [token, grant] of this.bootstraps) if (grant.executionId === executionId) this.bootstraps.delete(token);
  }

  revokeAll(): void {
    this.bootstraps.clear();
    this.sessions.clear();
  }

  private prune(): void {
    const now = this.now();
    for (const [token, value] of this.bootstraps) if (value.expiresAt <= now) this.bootstraps.delete(token);
    for (const [token, value] of this.sessions) if (value.expiresAt <= now) this.sessions.delete(token);
  }

  private findSecret<T>(store: Map<string, T>, presented: string): T | undefined {
    if (!presented || presented.length > 256) return undefined;
    const presentedDigest = digest(presented).toString("base64url");
    return store.get(presentedDigest);
  }

  private deleteSecret<T>(store: Map<string, T>, presented: string): void {
    store.delete(digest(presented).toString("base64url"));
  }
}

/** Exact-origin check for a future browser viewer. Missing Origin is rejected. */
export function assertHandoffOrigin(origin: string | undefined, allowedOrigins: readonly string[]): void {
  if (!origin || !allowedOrigins.includes(origin)) throw new HandoffBoundaryError("The handoff origin is not allowed.", "forbidden");
}
