import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";

/** The narrowest Sheets scope needed to read the tracker and update its rows. */
export const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const DEFAULT_GOOGLE_OAUTH_CLIENT_FILE = ".local/google-oauth-client.json";
export const DEFAULT_GOOGLE_OAUTH_TOKEN_FILE = ".local/google-sheets-token.json";

export type GoogleAuthMode = "oauth" | "service_account" | "access_token";

export interface GoogleAuthEnvironment {
  ATELIER_GOOGLE_AUTH_MODE?: string;
  ATELIER_GOOGLE_OAUTH_CLIENT_FILE?: string;
  ATELIER_GOOGLE_TOKEN_FILE?: string;
  ATELIER_GOOGLE_APPLICATION_CREDENTIALS?: string;
  ATELIER_GOOGLE_ACCESS_TOKEN?: string;
}

export interface GoogleOAuthClientConfig {
  clientId: string;
  clientSecret?: string;
  authorizationUri: string;
  tokenUri: string;
}

interface StoredGoogleOAuthToken {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_at?: number;
}

interface GoogleOAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
}

export interface GoogleOAuthTokenFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type GoogleOAuthTokenFetcher = (
  input: string,
  init: RequestInit,
) => Promise<GoogleOAuthTokenFetchResponse>;

export interface GoogleOAuthAccessTokenProviderOptions {
  tokenFile: string;
  clientFile?: string;
  client?: GoogleOAuthClientConfig;
  timeoutMs: number;
  fetcher?: GoogleOAuthTokenFetcher;
  now?: () => number;
}

export interface GoogleOAuthAuthorizationOptions {
  clientFile: string;
  tokenFile: string;
  timeoutMs?: number;
  callbackPath?: string;
  openBrowser?: (url: string) => Promise<void> | void;
  fetcher?: GoogleOAuthTokenFetcher;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
}

export interface GoogleOAuthAuthorizationResult {
  tokenFile: string;
  callbackUri: string;
}

export interface GoogleAuthSelection {
  mode?: GoogleAuthMode;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function safeError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/(?:access|refresh)_token["'=:\s]+[^,}\s]+/gi, "token [redacted]")
    .replace(/client_secret["'=:\s]+[^,}\s]+/gi, "client_secret [redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500) || fallback;
}

function positiveTimeout(value: number | undefined): number {
  const timeoutMs = value ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Google OAuth timeout must be a positive integer.");
  return timeoutMs;
}

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function expiresAtFromResponse(now: number, expiresIn: unknown): number {
  const seconds = typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
    ? expiresIn
    : 3_600;
  return now + seconds * 1_000;
}

function tokenFileForPath(value: string): string {
  return resolve(value.trim());
}

function clientFileForPath(value: string): string {
  return resolve(value.trim());
}

function configuredValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function configuredModes(env: GoogleAuthEnvironment): readonly GoogleAuthMode[] {
  const modes: GoogleAuthMode[] = [];
  if (configuredValue(env.ATELIER_GOOGLE_OAUTH_CLIENT_FILE) || configuredValue(env.ATELIER_GOOGLE_TOKEN_FILE)) modes.push("oauth");
  if (configuredValue(env.ATELIER_GOOGLE_APPLICATION_CREDENTIALS)) modes.push("service_account");
  if (configuredValue(env.ATELIER_GOOGLE_ACCESS_TOKEN)) modes.push("access_token");
  return modes;
}

function isGoogleAuthMode(value: string | undefined): value is GoogleAuthMode {
  return value === "oauth" || value === "service_account" || value === "access_token";
}

/**
 * Select one explicit credential lane. A single configured legacy lane remains
 * backwards compatible; multiple lanes require ATELIER_GOOGLE_AUTH_MODE so the
 * server never guesses which credential should be used.
 */
export function resolveGoogleAuthMode(env: GoogleAuthEnvironment): GoogleAuthSelection {
  const requested = configuredValue(env.ATELIER_GOOGLE_AUTH_MODE);
  const modes = configuredModes(env);
  if (requested && !isGoogleAuthMode(requested)) {
    return { error: "ATELIER_GOOGLE_AUTH_MODE must be oauth, service_account, or access_token." };
  }
  if (requested && isGoogleAuthMode(requested)) {
    if (!modes.includes(requested)) {
      return { error: `ATELIER_GOOGLE_AUTH_MODE=${requested} has no matching Google credential configuration.` };
    }
    return { mode: requested };
  }
  if (modes.length > 1) {
    return { error: "Multiple Google credential modes are configured; set ATELIER_GOOGLE_AUTH_MODE explicitly." };
  }
  return { mode: modes[0] };
}

export function googleOAuthClientFile(env: GoogleAuthEnvironment): string {
  return clientFileForPath(configuredValue(env.ATELIER_GOOGLE_OAUTH_CLIENT_FILE) ?? DEFAULT_GOOGLE_OAUTH_CLIENT_FILE);
}

export function googleOAuthTokenFile(env: GoogleAuthEnvironment): string {
  return tokenFileForPath(configuredValue(env.ATELIER_GOOGLE_TOKEN_FILE) ?? DEFAULT_GOOGLE_OAUTH_TOKEN_FILE);
}

function readJsonClient(value: unknown): GoogleOAuthClientConfig {
  if (!isRecord(value)) throw new Error("Google OAuth client configuration must be a JSON object.");
  const candidate = isRecord(value.installed) ? value.installed : isRecord(value.web) ? value.web : value;
  if (!nonEmptyString(candidate.client_id) || !nonEmptyString(candidate.auth_uri) || !nonEmptyString(candidate.token_uri)) {
    throw new Error("Google OAuth client configuration is missing client_id, auth_uri, or token_uri.");
  }
  try {
    const authorizationUri = new URL(candidate.auth_uri).toString();
    const tokenUri = new URL(candidate.token_uri).toString();
    if (new URL(authorizationUri).origin !== "https://accounts.google.com" || new URL(tokenUri).origin !== "https://oauth2.googleapis.com") {
      throw new Error("Google OAuth endpoints must use the trusted Google authorization and token hosts.");
    }
    return {
      clientId: candidate.client_id,
      ...(nonEmptyString(candidate.client_secret) ? { clientSecret: candidate.client_secret } : {}),
      authorizationUri,
      tokenUri,
    };
  } catch (error) {
    throw new Error(`Google OAuth client configuration has invalid endpoint URLs: ${safeError(error, "invalid URL")}`);
  }
}

export async function loadGoogleOAuthClientConfig(path: string): Promise<GoogleOAuthClientConfig> {
  try {
    const raw = await readFile(clientFileForPath(path), "utf8");
    return readJsonClient(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new Error(`Google OAuth client configuration could not be read: ${safeError(error, "invalid client configuration")}`);
  }
}

function readToken(value: unknown): StoredGoogleOAuthToken {
  if (!isRecord(value)) throw new Error("Google OAuth token file must contain a JSON object.");
  if (value.access_token !== undefined && !nonEmptyString(value.access_token)) throw new Error("Google OAuth token file has an invalid access token.");
  if (value.refresh_token !== undefined && !nonEmptyString(value.refresh_token)) throw new Error("Google OAuth token file has an invalid refresh token.");
  if (value.token_type !== undefined && !nonEmptyString(value.token_type)) throw new Error("Google OAuth token file has an invalid token type.");
  if (value.scope !== undefined && !nonEmptyString(value.scope)) throw new Error("Google OAuth token file has an invalid scope.");
  if (value.expires_at !== undefined && (typeof value.expires_at !== "number" || !Number.isFinite(value.expires_at))) {
    throw new Error("Google OAuth token file has an invalid expiration.");
  }
  return {
    ...(value.access_token ? { access_token: value.access_token } : {}),
    ...(value.refresh_token ? { refresh_token: value.refresh_token } : {}),
    ...(value.token_type ? { token_type: String(value.token_type) } : {}),
    ...(value.scope ? { scope: String(value.scope) } : {}),
    ...(value.expires_at !== undefined ? { expires_at: value.expires_at } : {}),
  };
}

export async function loadGoogleOAuthToken(path: string): Promise<StoredGoogleOAuthToken> {
  try {
    const raw = await readFile(tokenFileForPath(path), "utf8");
    return readToken(JSON.parse(raw) as unknown);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      throw new Error("Google Sheets authentication is required; run npm run career-agent:google-auth.");
    }
    throw new Error(`Google OAuth token could not be read: ${safeError(error, "invalid token file")}`);
  }
}

async function storeGoogleOAuthToken(path: string, token: StoredGoogleOAuthToken): Promise<void> {
  const target = tokenFileForPath(path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await chmod(dirname(target), 0o700).catch(() => undefined);
  await writeFile(target, `${JSON.stringify(token, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(target, 0o600).catch(() => undefined);
}

function tokenResponse(value: unknown): GoogleOAuthTokenResponse {
  if (!isRecord(value) || !nonEmptyString(value.access_token)) throw new Error("Google OAuth returned no access token.");
  if (value.refresh_token !== undefined && !nonEmptyString(value.refresh_token)) throw new Error("Google OAuth returned an invalid refresh token.");
  if (value.token_type !== undefined && !nonEmptyString(value.token_type)) throw new Error("Google OAuth returned an invalid token type.");
  if (value.scope !== undefined && !nonEmptyString(value.scope)) throw new Error("Google OAuth returned an invalid scope.");
  if (value.expires_in !== undefined && (typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in) || value.expires_in <= 0)) {
    throw new Error("Google OAuth returned an invalid expiration.");
  }
  return {
    access_token: value.access_token,
    ...(nonEmptyString(value.refresh_token) ? { refresh_token: value.refresh_token } : {}),
    ...(nonEmptyString(value.token_type) ? { token_type: value.token_type } : {}),
    ...(nonEmptyString(value.scope) ? { scope: value.scope } : {}),
    ...(value.expires_in !== undefined ? { expires_in: value.expires_in as number } : {}),
  };
}

function defaultTokenFetcher(input: string, init: RequestInit): Promise<GoogleOAuthTokenFetchResponse> {
  return fetch(input, init);
}

function tokenErrorMessage(status: number, body: unknown): string {
  const code = isRecord(body) && nonEmptyString(body.error) ? body.error : undefined;
  if (code === "invalid_grant" || status === 401) {
    return "Google Sheets authorization expired or was revoked; run npm run career-agent:google-auth again.";
  }
  const description = isRecord(body) && nonEmptyString(body.error_description)
    ? `: ${safeError(body.error_description, "provider error")}`
    : "";
  return `Google OAuth token request failed with HTTP ${status}${description}.`;
}

async function exchangeToken(
  client: GoogleOAuthClientConfig,
  body: URLSearchParams,
  timeoutMs: number,
  fetcher: GoogleOAuthTokenFetcher,
): Promise<GoogleOAuthTokenResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: GoogleOAuthTokenFetchResponse;
    try {
      response = await fetcher(client.tokenUri, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error("Google OAuth token request timed out.");
      throw new Error("Google OAuth token endpoint could not be reached.");
    }
    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      throw new Error(`Google OAuth returned HTTP ${response.status} with malformed JSON.`);
    }
    if (!response.ok) throw new Error(tokenErrorMessage(response.status, responseBody));
    return tokenResponse(responseBody);
  } finally {
    clearTimeout(timer);
  }
}

export class GoogleOAuthAccessTokenProvider {
  private readonly timeoutMs: number;
  private readonly fetcher: GoogleOAuthTokenFetcher;
  private readonly now: () => number;
  private cached: { token: string; expiresAt: number } | undefined;

  constructor(private readonly options: GoogleOAuthAccessTokenProviderOptions) {
    this.timeoutMs = positiveTimeout(options.timeoutMs);
    this.fetcher = options.fetcher ?? defaultTokenFetcher;
    this.now = options.now ?? Date.now;
  }

  async getAccessToken(): Promise<string> {
    const now = this.now();
    if (this.cached && this.cached.expiresAt > now + 60_000) return this.cached.token;
    const stored = await loadGoogleOAuthToken(this.options.tokenFile);
    if (stored.access_token && typeof stored.expires_at === "number" && stored.expires_at > now + 60_000) {
      this.cached = { token: stored.access_token, expiresAt: stored.expires_at };
      return stored.access_token;
    }
    if (!stored.refresh_token) {
      throw new Error("Google Sheets authentication is required; run npm run career-agent:google-auth.");
    }
    const client = this.options.client ?? await loadGoogleOAuthClientConfig(
      this.options.clientFile ?? DEFAULT_GOOGLE_OAUTH_CLIENT_FILE,
    );
    const body = new URLSearchParams({
      client_id: client.clientId,
      refresh_token: stored.refresh_token,
      grant_type: "refresh_token",
    });
    if (client.clientSecret) body.set("client_secret", client.clientSecret);
    const refreshed = await exchangeToken(client, body, this.timeoutMs, this.fetcher);
    const expiresAt = expiresAtFromResponse(now, refreshed.expires_in);
    const next: StoredGoogleOAuthToken = {
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token ?? stored.refresh_token,
      ...(refreshed.token_type ?? stored.token_type ? { token_type: refreshed.token_type ?? stored.token_type } : {}),
      ...(refreshed.scope ?? stored.scope ? { scope: refreshed.scope ?? stored.scope } : {}),
      expires_at: expiresAt,
    };
    await storeGoogleOAuthToken(this.options.tokenFile, next);
    this.cached = { token: refreshed.access_token, expiresAt };
    return refreshed.access_token;
  }
}

function defaultOpenBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", shell: false });
  child.unref();
}

function callbackHtml(message: string, ok: boolean): string {
  const escaped = message.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
  return `<!doctype html><html><body><h1>${ok ? "Atelier HQ authorization complete" : "Atelier HQ authorization failed"}</h1><p>${escaped}</p><p>You may close this window.</p></body></html>`;
}

function responseWithHtml(response: import("node:http").ServerResponse, statusCode: number, html: string): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(html);
}

function authorizationCodeBody(
  client: GoogleOAuthClientConfig,
  code: string,
  verifier: string,
  redirectUri: string,
): URLSearchParams {
  const body = new URLSearchParams({
    client_id: client.clientId,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  if (client.clientSecret) body.set("client_secret", client.clientSecret);
  return body;
}

function randomText(random: (size: number) => Uint8Array, size: number): string {
  return base64Url(random(size));
}

/**
 * Run a loopback OAuth authorization-code + PKCE flow. This function is Node
 * only and returns metadata, never token contents.
 */
export async function authorizeGoogleSheets(options: GoogleOAuthAuthorizationOptions): Promise<GoogleOAuthAuthorizationResult> {
  const timeoutMs = positiveTimeout(options.timeoutMs ?? 10 * 60_000);
  const client = await loadGoogleOAuthClientConfig(options.clientFile);
  const random = options.randomBytes ?? randomBytes;
  const callbackPath = options.callbackPath ?? "/oauth2callback";
  if (!callbackPath.startsWith("/") || callbackPath.includes("?")) throw new Error("Google OAuth callback path is invalid.");

  const state = randomText(random, 32);
  const verifier = randomText(random, 48);
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const server = createServer();
  try {
    const callback = await new Promise<{ serverPort: number; result: GoogleOAuthAuthorizationResult }>((resolvePromise, rejectPromise) => {
      let settled = false;
      const finish = (callbackResult: { serverPort: number; result: GoogleOAuthAuthorizationResult } | undefined, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) rejectPromise(error);
        else if (callbackResult) resolvePromise(callbackResult);
      };
      const timer = setTimeout(() => finish(undefined, new Error("Google OAuth authorization timed out.")), timeoutMs);
      server.on("error", (error) => finish(undefined, new Error(`Google OAuth callback server failed: ${safeError(error, "server error")}`)));
      server.on("request", async (request, response) => {
        try {
          const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
          if (requestUrl.pathname !== callbackPath) {
            responseWithHtml(response, 404, callbackHtml("Callback route not found.", false));
            return;
          }
          const returnedState = requestUrl.searchParams.get("state");
          if (returnedState !== state) {
            responseWithHtml(response, 400, callbackHtml("Authorization state did not match.", false));
            finish(undefined, new Error("Google OAuth authorization state did not match."));
            return;
          }
          const providerError = requestUrl.searchParams.get("error");
          if (providerError) {
            responseWithHtml(response, 400, callbackHtml("Google authorization was not completed.", false));
            finish(undefined, new Error("Google authorization was not completed by the user."));
            return;
          }
          const code = requestUrl.searchParams.get("code");
          if (!code) {
            responseWithHtml(response, 400, callbackHtml("Google did not return an authorization code.", false));
            finish(undefined, new Error("Google OAuth returned no authorization code."));
            return;
          }
          const redirectUri = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}${callbackPath}`;
          const responseBody = await exchangeToken(
            client,
            authorizationCodeBody(client, code, verifier, redirectUri),
            timeoutMs,
            options.fetcher ?? defaultTokenFetcher,
          );
          let previous: StoredGoogleOAuthToken | undefined;
          try {
            previous = await loadGoogleOAuthToken(options.tokenFile);
          } catch {
            previous = undefined;
          }
          const refreshToken = responseBody.refresh_token ?? previous?.refresh_token;
          if (!refreshToken) {
            responseWithHtml(response, 500, callbackHtml("Google did not return a reusable refresh token. Revoke Atelier HQ access and run authorization again.", false));
            finish(undefined, new Error("Google OAuth did not return a refresh token; revoke access and authorize again."));
            return;
          }
          const now = options.now?.() ?? Date.now();
          await storeGoogleOAuthToken(options.tokenFile, {
            access_token: responseBody.access_token,
            refresh_token: refreshToken,
            ...(responseBody.token_type ? { token_type: responseBody.token_type } : {}),
            ...(responseBody.scope ? { scope: responseBody.scope } : {}),
            expires_at: expiresAtFromResponse(now, responseBody.expires_in),
          });
          responseWithHtml(response, 200, callbackHtml("Google Sheets credentials are stored locally for the Node tracker host.", true));
          finish({ serverPort: (server.address() as import("node:net").AddressInfo).port, result: {
            tokenFile: tokenFileForPath(options.tokenFile),
            callbackUri: redirectUri,
          } });
        } catch (error) {
          responseWithHtml(response, 500, callbackHtml("Authorization could not be completed. Return to the terminal for details.", false));
          finish(undefined, new Error(safeError(error, "Google OAuth authorization failed.")));
        }
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          finish(undefined, new Error("Google OAuth callback server did not expose a loopback port."));
          return;
        }
        const redirectUri = `http://127.0.0.1:${address.port}${callbackPath}`;
        const authorizationUrl = new URL(client.authorizationUri);
        authorizationUrl.searchParams.set("client_id", client.clientId);
        authorizationUrl.searchParams.set("redirect_uri", redirectUri);
        authorizationUrl.searchParams.set("response_type", "code");
        authorizationUrl.searchParams.set("scope", GOOGLE_SHEETS_SCOPE);
        authorizationUrl.searchParams.set("access_type", "offline");
        authorizationUrl.searchParams.set("prompt", "consent");
        authorizationUrl.searchParams.set("state", state);
        authorizationUrl.searchParams.set("code_challenge", challenge);
        authorizationUrl.searchParams.set("code_challenge_method", "S256");
        console.log(`[career-agent-google-auth] authorize at ${authorizationUrl.toString()}`);
        try {
          void Promise.resolve((options.openBrowser ?? defaultOpenBrowser)(authorizationUrl.toString())).catch(() => {
            console.log("[career-agent-google-auth] browser could not be opened automatically; use the URL above.");
          });
        } catch {
          console.log("[career-agent-google-auth] browser could not be opened automatically; use the URL above.");
        }
      });
    });
    return callback.result;
  } finally {
    await new Promise<void>((resolveClose) => {
      if (!server.listening) {
        resolveClose();
        return;
      }
      server.close(() => resolveClose());
    });
  }
}

export function createGoogleOAuthAccessTokenProvider(
  env: GoogleAuthEnvironment,
  timeoutMs: number,
): GoogleOAuthAccessTokenProvider {
  return new GoogleOAuthAccessTokenProvider({
    tokenFile: googleOAuthTokenFile(env),
    clientFile: googleOAuthClientFile(env),
    timeoutMs,
  });
}
