import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authorizeGoogleSheets,
  GoogleOAuthAccessTokenProvider,
  googleOAuthClientFile,
  googleOAuthTokenFile,
  loadGoogleOAuthClientConfig,
  resolveGoogleAuthMode,
  GOOGLE_SHEETS_SCOPE,
} from "../application-agent/automation/googleOAuth";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "atelier-hq-google-oauth-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

describe("Google Sheets OAuth configuration", () => {
  it("requires an explicit mode when multiple credential lanes exist", () => {
    expect(resolveGoogleAuthMode({
      ATELIER_GOOGLE_OAUTH_CLIENT_FILE: "/private/client.json",
      ATELIER_GOOGLE_APPLICATION_CREDENTIALS: "/private/service-account.json",
    })).toEqual({
      error: "Multiple Google credential modes are configured; set ATELIER_GOOGLE_AUTH_MODE explicitly.",
    });
    expect(resolveGoogleAuthMode({
      ATELIER_GOOGLE_AUTH_MODE: "oauth",
      ATELIER_GOOGLE_OAUTH_CLIENT_FILE: "/private/client.json",
    })).toEqual({ mode: "oauth" });
    expect(resolveGoogleAuthMode({ ATELIER_GOOGLE_AUTH_MODE: "service_account" })).toEqual({
      error: "ATELIER_GOOGLE_AUTH_MODE=service_account has no matching Google credential configuration.",
    });
  });

  it("keeps OAuth paths server-side and uses the Sheets-only scope", () => {
    expect(googleOAuthClientFile({})).toContain(".local/google-oauth-client.json");
    expect(googleOAuthTokenFile({})).toContain(".local/google-sheets-token.json");
    expect(googleOAuthClientFile({ ATELIER_GOOGLE_OAUTH_CLIENT_FILE: "./private/client.json" })).toContain("/private/client.json");
    expect(GOOGLE_SHEETS_SCOPE).toBe("https://www.googleapis.com/auth/spreadsheets");
  });

  it("loads the installed OAuth client shape without exposing client secrets through the result", async () => {
    const directory = await temporaryDirectory();
    const clientFile = join(directory, "client.json");
    await writeFile(clientFile, JSON.stringify({ installed: {
      client_id: "client-id",
      client_secret: "client-secret-for-test",
      auth_uri: "https://accounts.google.com/o/oauth2/v2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
    }}));

    await expect(loadGoogleOAuthClientConfig(clientFile)).resolves.toEqual({
      clientId: "client-id",
      clientSecret: "client-secret-for-test",
      authorizationUri: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUri: "https://oauth2.googleapis.com/token",
    });
  });
});

describe("Google Sheets OAuth token provider", () => {
  it("uses a valid stored access token without a network refresh", async () => {
    const directory = await temporaryDirectory();
    const tokenFile = join(directory, "tokens.json");
    await writeFile(tokenFile, JSON.stringify({ access_token: "cached-token", refresh_token: "refresh-token", expires_at: 2_000_000 }));
    let calls = 0;
    const provider = new GoogleOAuthAccessTokenProvider({
      tokenFile,
      timeoutMs: 1_000,
      now: () => 1_000_000,
      fetcher: async () => {
        calls += 1;
        return new Response(JSON.stringify({ access_token: "unexpected" }), { status: 200 });
      },
    });

    await expect(provider.getAccessToken()).resolves.toBe("cached-token");
    expect(calls).toBe(0);
  });

  it("refreshes an expired token, preserves the refresh token, and stores restrictive credentials", async () => {
    const directory = await temporaryDirectory();
    const tokenFile = join(directory, "private", "tokens.json");
    await mkdir(join(directory, "private"), { recursive: true });
    await writeFile(tokenFile, JSON.stringify({ access_token: "expired-token", refresh_token: "refresh-token", expires_at: 900_000 }));
    const requestBodies: string[] = [];
    const provider = new GoogleOAuthAccessTokenProvider({
      tokenFile,
      client: {
        clientId: "client-id",
        clientSecret: "client-secret",
        authorizationUri: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUri: "https://oauth2.googleapis.com/token",
      },
      timeoutMs: 1_000,
      now: () => 1_000_000,
      fetcher: async (_input, init) => {
        requestBodies.push(String(init.body));
        return new Response(JSON.stringify({ access_token: "refreshed-token", expires_in: 3_600 }), { status: 200 });
      },
    });

    await expect(provider.getAccessToken()).resolves.toBe("refreshed-token");
    expect(requestBodies[0]).toContain("grant_type=refresh_token");
    expect(requestBodies[0]).toContain("client_id=client-id");
    expect(requestBodies[0]).toContain("refresh_token=refresh-token");
    const stored = JSON.parse(await readFile(tokenFile, "utf8")) as Record<string, unknown>;
    expect(stored).toMatchObject({ access_token: "refreshed-token", refresh_token: "refresh-token", expires_at: 4_600_000 });
    expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "private"))).mode & 0o777).toBe(0o700);
  });

  it("reports missing credentials and revoked authorization without token details", async () => {
    const directory = await temporaryDirectory();
    const missing = new GoogleOAuthAccessTokenProvider({ tokenFile: join(directory, "missing.json"), timeoutMs: 1_000 });
    await expect(missing.getAccessToken()).rejects.toThrow("run npm run career-agent:google-auth");

    const tokenFile = join(directory, "tokens.json");
    await writeFile(tokenFile, JSON.stringify({ refresh_token: "refresh-token" }));
    const revoked = new GoogleOAuthAccessTokenProvider({
      tokenFile,
      client: {
        clientId: "client-id",
        authorizationUri: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUri: "https://oauth2.googleapis.com/token",
      },
      timeoutMs: 1_000,
      fetcher: async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "token was revoked" }), { status: 400 }),
    });
    await expect(revoked.getAccessToken()).rejects.toThrow("authorization expired or was revoked");
    await expect(revoked.getAccessToken()).rejects.not.toThrow("refresh-token");
  });

  it("can retry after a local token becomes available without changing the auth lane", async () => {
    const directory = await temporaryDirectory();
    const tokenFile = join(directory, "tokens.json");
    const provider = new GoogleOAuthAccessTokenProvider({
      tokenFile,
      timeoutMs: 1_000,
      now: () => 1_000_000,
    });
    await expect(provider.getAccessToken()).rejects.toThrow("authentication is required");
    await writeFile(tokenFile, JSON.stringify({ access_token: "available-token", refresh_token: "refresh-token", expires_at: 2_000_000 }));
    await expect(provider.getAccessToken()).resolves.toBe("available-token");
  });
});

describe("Google Sheets loopback authorization", () => {
  it("receives the loopback callback, exchanges PKCE code, and stores a reusable token", async () => {
    const directory = await temporaryDirectory();
    const clientFile = join(directory, "client.json");
    const tokenFile = join(directory, "tokens.json");
    await writeFile(clientFile, JSON.stringify({ installed: {
      client_id: "client-id",
      client_secret: "client-secret",
      auth_uri: "https://accounts.google.com/o/oauth2/v2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
    }}));
    const requests: Array<{ input: string; body: string }> = [];

    const result = await authorizeGoogleSheets({
      clientFile,
      tokenFile,
      timeoutMs: 5_000,
      now: () => 1_000_000,
      randomBytes: (size) => new Uint8Array(size).fill(7),
      fetcher: async (input, init) => {
        requests.push({ input, body: String(init.body) });
        return new Response(JSON.stringify({ access_token: "new-access-token", refresh_token: "new-refresh-token", expires_in: 3_600, scope: GOOGLE_SHEETS_SCOPE }), { status: 200 });
      },
      openBrowser: (authorizationUrl) => {
        const parsed = new URL(authorizationUrl);
        const redirectUri = parsed.searchParams.get("redirect_uri");
        const state = parsed.searchParams.get("state");
        if (!redirectUri || !state) throw new Error("test authorization URL was incomplete");
        setTimeout(() => {
          void fetch(`${redirectUri}?code=test-code&state=${encodeURIComponent(state)}`);
        }, 0);
      },
    });

    expect(result.tokenFile).toBe(tokenFile);
    expect(result.callbackUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toContain("code=test-code");
    expect(requests[0]?.body).toContain("code_verifier=");
    expect(requests[0]?.body).toContain("grant_type=authorization_code");
    expect(JSON.parse(await readFile(tokenFile, "utf8"))).toMatchObject({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_at: 4_600_000,
    });
  });
});
