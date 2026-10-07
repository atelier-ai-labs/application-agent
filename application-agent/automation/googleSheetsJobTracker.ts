import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createGoogleOAuthAccessTokenProvider,
  GOOGLE_OAUTH_TOKEN_URL as GOOGLE_TOKEN_URL,
  GOOGLE_SHEETS_SCOPE,
  resolveGoogleAuthMode,
  type GoogleAuthEnvironment,
} from "./googleOAuth";
import type {
  JobTracker,
  JobTrackerResult,
  JobTrackerSyncContext,
  JobTrackerUpdate,
} from "../src/domain/tracker";
import { isJobTrackerSyncContext, isJobTrackerUpdate } from "../src/domain/tracker";
import { canonicalJobUrl } from "../src/domain/scout";

export type GoogleSheetCellValue = string | number | boolean | null;

export interface GoogleSheetMetadata {
  spreadsheetId: string;
  title: string;
  sheets: readonly {
    title: string;
    sheetId: number;
    gridProperties?: { columnCount?: number; rowCount?: number };
  }[];
}

export interface GoogleSheetValueRange {
  range: string;
  values: readonly (readonly GoogleSheetCellValue[])[];
}

export interface GoogleSheetUpdateAcknowledgement {
  updatedCells?: number;
  totalUpdatedCells?: number;
  updatedRange?: string;
}

/** Injectable transport boundary used by the real adapter and offline tests. */
export interface GoogleSheetsApiTransport {
  getSpreadsheetMetadata(spreadsheetId: string): Promise<GoogleSheetMetadata>;
  getValues(spreadsheetId: string, range: string): Promise<readonly (readonly unknown[])[]>;
  updateValues(
    spreadsheetId: string,
    data: readonly GoogleSheetValueRange[],
  ): Promise<GoogleSheetUpdateAcknowledgement>;
  batchUpdate?(spreadsheetId: string, requests: readonly Record<string, unknown>[]): Promise<void>;
}

export interface GoogleSheetsJobTrackerConfig {
  spreadsheetId: string;
  spreadsheetName: string;
  sheetTab: string;
  timeoutMs: number;
}

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}

interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
}

const GOOGLE_SHEETS_API_ROOT = "https://sheets.googleapis.com/v4";
const MAX_TRACKER_ROWS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function safeError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/(?:access|refresh)_token["'=:\s]+[^,}\s]+/gi, "token [redacted]")
    .replace(/client_secret["'=:\s]+[^,}\s]+/gi, "client_secret [redacted]")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted-key]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500) || fallback;
}

function base64Url(value: string | Uint8Array): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value);
}

function quoteSheetName(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function headerKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeIdentity(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function cellText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatSheetDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("The tracker received an invalid application timestamp.");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${month}/${day}/${date.getUTCFullYear()}`;
}

function fitLabel(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "strong" || normalized === "excellent") return "Excellent";
  if (normalized === "good") return "Good";
  if (normalized === "stretch") return "Stretch";
  if (normalized === "weak" || normalized === "low") return "Low";
  return undefined;
}

function priorityLabel(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "high") return "High";
  if (normalized === "standard" || normalized === "medium") return "Medium";
  if (normalized === "review" || normalized === "low") return "Low";
  return undefined;
}

function parseMetadata(value: unknown): GoogleSheetMetadata {
  if (!isRecord(value) || !nonEmptyString(value.spreadsheetId) || !isRecord(value.properties) || !nonEmptyString(value.properties.title)) {
    throw new Error("Google Sheets returned malformed spreadsheet metadata.");
  }
  if (!Array.isArray(value.sheets)) throw new Error("Google Sheets returned no sheet metadata.");
  const sheets = value.sheets.map((sheet) => {
    if (!isRecord(sheet) || !isRecord(sheet.properties) || !nonEmptyString(sheet.properties.title) || !nonNegativeInteger(sheet.properties.sheetId)) {
      throw new Error("Google Sheets returned malformed sheet metadata.");
    }
    const grid = isRecord(sheet.properties.gridProperties) ? sheet.properties.gridProperties : undefined;
    const columnCount = grid?.columnCount;
    const rowCount = grid?.rowCount;
    if (columnCount !== undefined && !nonNegativeInteger(columnCount)) throw new Error("Google Sheets returned malformed sheet column metadata.");
    if (rowCount !== undefined && !nonNegativeInteger(rowCount)) throw new Error("Google Sheets returned malformed sheet row metadata.");
    return { title: sheet.properties.title, sheetId: sheet.properties.sheetId, ...(grid ? { gridProperties: { ...(columnCount !== undefined ? { columnCount } : {}), ...(rowCount !== undefined ? { rowCount } : {}) } } : {}) };
  });
  return {
    spreadsheetId: value.spreadsheetId,
    title: value.properties.title,
    sheets,
  };
}

function parseValues(value: unknown): readonly (readonly unknown[])[] {
  if (!isRecord(value)) throw new Error("Google Sheets returned malformed cell values.");
  if (value.values === undefined) return [];
  if (!Array.isArray(value.values) || !value.values.every((row) => Array.isArray(row))) {
    throw new Error("Google Sheets returned malformed cell values.");
  }
  if (!value.values.every((row) => (row as unknown[]).every((cell) =>
    cell === null || typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean"))) {
    throw new Error("Google Sheets returned malformed cell values.");
  }
  return value.values as readonly (readonly unknown[])[];
}

function parseUpdateAcknowledgement(value: unknown): GoogleSheetUpdateAcknowledgement {
  if (!isRecord(value)) throw new Error("Google Sheets returned a malformed update acknowledgement.");
  if (value.updatedCells !== undefined && !nonNegativeInteger(value.updatedCells)) {
    throw new Error("Google Sheets returned a malformed updated-cell count.");
  }
  if (value.totalUpdatedCells !== undefined && !nonNegativeInteger(value.totalUpdatedCells)) {
    throw new Error("Google Sheets returned a malformed total updated-cell count.");
  }
  if (value.updatedRange !== undefined && !nonEmptyString(value.updatedRange)) {
    throw new Error("Google Sheets returned a malformed updated range.");
  }
  if (value.updatedCells === undefined && value.totalUpdatedCells === undefined && value.updatedRange === undefined) {
    throw new Error("Google Sheets returned no update acknowledgement.");
  }
  return {
    ...(value.updatedCells !== undefined ? { updatedCells: value.updatedCells as number } : {}),
    ...(value.totalUpdatedCells !== undefined ? { totalUpdatedCells: value.totalUpdatedCells as number } : {}),
    ...(value.updatedRange !== undefined ? { updatedRange: value.updatedRange as string } : {}),
  };
}

class StaticAccessTokenProvider implements AccessTokenProvider {
  constructor(private readonly token: string) {}

  async getAccessToken(): Promise<string> {
    return this.token;
  }
}

class ServiceAccountAccessTokenProvider implements AccessTokenProvider {
  private cached: { token: string; expiresAt: number } | undefined;

  constructor(private readonly credentialsPath: string, private readonly timeoutMs: number) {}

  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now + 60_000) return this.cached.token;

    let credentials: ServiceAccountCredentials;
    try {
      const raw = await readFile(this.credentialsPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || !nonEmptyString(parsed.client_email) || !nonEmptyString(parsed.private_key)) {
        throw new Error("Google credential file is missing client_email or private_key.");
      }
      credentials = { client_email: parsed.client_email, private_key: parsed.private_key };
    } catch (error) {
      throw new Error(`Google credential file could not be read: ${safeError(error, "invalid credential file")}`);
    }

    const issuedAt = Math.floor(now / 1_000);
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64Url(JSON.stringify({
      iss: credentials.client_email,
      scope: GOOGLE_SHEETS_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3_600,
    }));
    const unsigned = `${header}.${payload}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(credentials.private_key);
    const assertion = `${unsigned}.${base64Url(signature)}`;
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: controller.signal,
      });
      let responseBody: unknown;
      try {
        responseBody = await response.json();
      } catch {
        throw new Error(`Google OAuth returned HTTP ${response.status} with malformed JSON.`);
      }
      if (!response.ok) throw new Error(`Google OAuth returned HTTP ${response.status}.`);
      if (!isRecord(responseBody) || !nonEmptyString(responseBody.access_token)) {
        throw new Error("Google OAuth returned no access token.");
      }
      const expiresIn = typeof responseBody.expires_in === "number" && Number.isFinite(responseBody.expires_in)
        ? responseBody.expires_in
        : 3_600;
      this.cached = { token: responseBody.access_token, expiresAt: now + expiresIn * 1_000 };
      return responseBody.access_token;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error("Google OAuth token request timed out.");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface GoogleSheetsHttpTransportOptions {
  timeoutMs?: number;
  accessTokenProvider: AccessTokenProvider;
}

/** Minimal Google Sheets v4 REST transport. It is imported only by Node code. */
export class GoogleSheetsHttpTransport implements GoogleSheetsApiTransport {
  private readonly timeoutMs: number;

  constructor(private readonly options: GoogleSheetsHttpTransportOptions) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("Google Sheets timeout must be a positive integer.");
  }

  async getSpreadsheetMetadata(spreadsheetId: string): Promise<GoogleSheetMetadata> {
    const query = "?includeGridData=false&fields=spreadsheetId,properties.title,sheets.properties";
    const body = await this.request(
      `${GOOGLE_SHEETS_API_ROOT}/spreadsheets/${encodePathPart(spreadsheetId)}${query}`,
      { method: "GET" },
    );
    return parseMetadata(body);
  }

  async getValues(spreadsheetId: string, range: string): Promise<readonly (readonly unknown[])[]> {
    const query = "?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE";
    const body = await this.request(
      `${GOOGLE_SHEETS_API_ROOT}/spreadsheets/${encodePathPart(spreadsheetId)}/values/${encodePathPart(range)}${query}`,
      { method: "GET" },
    );
    return parseValues(body);
  }

  async updateValues(
    spreadsheetId: string,
    data: readonly GoogleSheetValueRange[],
  ): Promise<GoogleSheetUpdateAcknowledgement> {
    const body = await this.request(
      `${GOOGLE_SHEETS_API_ROOT}/spreadsheets/${encodePathPart(spreadsheetId)}/values:batchUpdate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          valueInputOption: "USER_ENTERED",
          data,
        }),
      },
    );
    return parseUpdateAcknowledgement(body);
  }

  async batchUpdate(spreadsheetId: string, requests: readonly Record<string, unknown>[]): Promise<void> {
    await this.request(`${GOOGLE_SHEETS_API_ROOT}/spreadsheets/${encodePathPart(spreadsheetId)}:batchUpdate`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requests }),
    });
  }

  private async request(url: string, init: RequestInit): Promise<unknown> {
    const token = await this.options.accessTokenProvider.getAccessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetch(url, {
          ...init,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(init.headers ?? {}),
          },
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw new Error("Google Sheets request timed out.");
        throw new Error("Google Sheets could not be reached.");
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error(`Google Sheets returned HTTP ${response.status} with malformed JSON.`);
      }
      if (!response.ok) {
        const providerMessage = isRecord(body) && isRecord(body.error) && nonEmptyString(body.error.message)
          ? `: ${body.error.message}`
          : "";
        throw new Error(`Google Sheets returned HTTP ${response.status}${providerMessage}.`);
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }
}

interface TrackerColumns {
  company?: number;
  role?: number;
  jobLink?: number;
  locationRemote?: number;
  salaryMin?: number;
  salaryMax?: number;
  fit?: number;
  priority?: number;
  status?: number;
  dateFound?: number;
  dateApplied?: number;
  followUpDate?: number;
  contactReferral?: number;
  resumeVersion?: number;
  nextStep?: number;
  notes?: number;
  providerId?: number;
}

const HEADER_ALIASES: Readonly<Record<keyof TrackerColumns, readonly string[]>> = {
  company: ["company"],
  role: ["role", "title", "job title"],
  jobLink: ["job link", "job url", "application url", "posting url"],
  locationRemote: ["location / remote", "location", "remote", "workplace"],
  salaryMin: ["salary min", "minimum salary", "salary minimum"],
  salaryMax: ["salary max", "maximum salary", "salary maximum"],
  fit: ["fit", "fit classification"],
  priority: ["priority"],
  status: ["status"],
  dateFound: ["date found", "discovered", "discovered at"],
  dateApplied: ["date applied", "applied date"],
  followUpDate: ["follow-up date", "follow up date"],
  contactReferral: ["contact / referral", "contact", "referral"],
  resumeVersion: ["resume version", "resume"],
  nextStep: ["next step"],
  notes: ["notes", "note"],
  providerId: ["provider job id", "source record id", "job id", "provider id"],
};

function mapColumns(headers: readonly unknown[]): TrackerColumns {
  const normalized = headers.map((header) => headerKey(cellText(header)));
  const columns: TrackerColumns = {};
  for (const [column, aliases] of Object.entries(HEADER_ALIASES) as [keyof TrackerColumns, readonly string[]][]) {
    const index = normalized.findIndex((candidate) => aliases.some((alias) => candidate === headerKey(alias)));
    if (index >= 0) columns[column] = index;
  }
  const required: (keyof TrackerColumns)[] = ["company", "role", "jobLink", "fit", "priority", "status", "dateFound", "dateApplied", "resumeVersion", "nextStep"];
  const missing = required.filter((column) => columns[column] === undefined);
  if (missing.length > 0) throw new Error(`Tracker header mismatch; missing: ${missing.join(", ")}.`);
  return columns;
}

function canonicalUrls(update: JobTrackerUpdate): readonly string[] {
  return [update.applicationUrl, update.sourceUrl, update.jobLink]
    .map((value) => canonicalJobUrl(value))
    .filter((value): value is string => value !== undefined);
}

function providerIdentity(update: JobTrackerUpdate): string | undefined {
  if (!update.sourceRecordId?.trim()) return undefined;
  return update.sourceId?.trim()
    ? `${update.sourceId.trim()}:${update.sourceRecordId.trim()}`
    : update.sourceRecordId.trim();
}

function findExistingRow(
  rows: readonly (readonly unknown[])[],
  columns: TrackerColumns,
  update: JobTrackerUpdate,
): number | undefined {
  const incomingUrls = new Set(canonicalUrls(update));
  const incomingProviderId = update.sourceRecordId?.trim();
  const incomingCompany = normalizeIdentity(update.company);
  const incomingRole = normalizeIdentity(update.role);
  const incomingLocation = normalizeIdentity(update.locationRemote);

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    const existingLink = cellText(columns.jobLink === undefined ? undefined : row[columns.jobLink]);
    const existingUrl = canonicalJobUrl(existingLink);
    if (existingUrl && incomingUrls.has(existingUrl)) return index + 1;

    if (columns.providerId !== undefined && incomingProviderId) {
      const existingProviderId = cellText(row[columns.providerId]);
      const incomingIdentity = providerIdentity(update);
      if (existingProviderId && (existingProviderId === incomingProviderId || existingProviderId === incomingIdentity)) {
        return index + 1;
      }
    }

    const company = cellText(row[columns.company ?? -1]);
    const role = cellText(row[columns.role ?? -1]);
    if (!company || !role || normalizeIdentity(company) !== incomingCompany || normalizeIdentity(role) !== incomingRole) continue;
    const existingLocation = cellText(columns.locationRemote === undefined ? undefined : row[columns.locationRemote]);
    if (incomingLocation && existingLocation && normalizeIdentity(existingLocation) !== incomingLocation) continue;
    return index + 1;
  }
  return undefined;
}

function rowIsBlank(row: readonly unknown[] | undefined): boolean {
  return !row || row.every((value) => cellText(value) === "");
}

function firstAvailableRow(rows: readonly (readonly unknown[])[]): number {
  for (let index = 1; index < Math.min(rows.length, MAX_TRACKER_ROWS); index += 1) {
    if (rowIsBlank(rows[index])) return index + 1;
  }
  return rows.length + 1;
}

function cellRange(tab: string, column: number, row: number): string {
  let value = column + 1;
  let letters = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return `${quoteSheetName(tab)}!${letters}${row}`;
}

function addWrite(
  writes: GoogleSheetValueRange[],
  tab: string,
  row: number,
  column: number | undefined,
  value: GoogleSheetCellValue | undefined,
): void {
  if (column === undefined || value === undefined) return;
  writes.push({ range: cellRange(tab, column, row), values: [[value]] });
}

function buildWrites(
  tab: string,
  row: number,
  columns: TrackerColumns,
  update: JobTrackerUpdate,
): readonly GoogleSheetValueRange[] {
  const writes: GoogleSheetValueRange[] = [];
  addWrite(writes, tab, row, columns.company, update.company);
  addWrite(writes, tab, row, columns.role, update.role);
  addWrite(writes, tab, row, columns.jobLink, update.jobLink);
  addWrite(writes, tab, row, columns.locationRemote, update.locationRemote);
  addWrite(writes, tab, row, columns.salaryMin, asFiniteNumber(update.salaryMin));
  addWrite(writes, tab, row, columns.salaryMax, asFiniteNumber(update.salaryMax));
  addWrite(writes, tab, row, columns.fit, fitLabel(update.fit));
  addWrite(writes, tab, row, columns.priority, priorityLabel(update.priority));
  addWrite(writes, tab, row, columns.status, "Applied");
  addWrite(writes, tab, row, columns.dateFound, formatSheetDate(update.dateFound));
  addWrite(writes, tab, row, columns.dateApplied, formatSheetDate(update.dateApplied));
  addWrite(writes, tab, row, columns.providerId, providerIdentity(update));
  addWrite(writes, tab, row, columns.resumeVersion, update.resumeVersion);
  addWrite(writes, tab, row, columns.nextStep, update.nextStep);
  // Follow-up date, contact/referral, and Notes are user-owned. They are
  // intentionally omitted even when the provider-neutral update has a note.
  return writes;
}

function rowCell(row: readonly unknown[] | undefined, column: number | undefined): string {
  return cellText(column === undefined ? undefined : row?.[column]);
}

function verifyTrackerRow(
  row: readonly unknown[] | undefined,
  previousRow: readonly unknown[] | undefined,
  columns: TrackerColumns,
  update: JobTrackerUpdate,
): string | undefined {
  if (!row) return "Google Sheets write was acknowledged but the target row could not be read back.";
  const expectedDateFound = formatSheetDate(update.dateFound);
  const expectedDateApplied = formatSheetDate(update.dateApplied);
  const requiredMatches: [keyof TrackerColumns, string][] = [
    ["company", update.company],
    ["role", update.role],
    ["status", "Applied"],
    ["dateFound", expectedDateFound],
    ["dateApplied", expectedDateApplied],
    ["resumeVersion", update.resumeVersion],
    ["nextStep", update.nextStep],
  ];
  if (update.jobLink !== undefined) requiredMatches.splice(2, 0, ["jobLink", update.jobLink]);
  for (const [column, expected] of requiredMatches) {
    if (rowCell(row, columns[column]) !== expected) {
      return `Google Sheets write verification failed for '${column}'.`;
    }
  }
  const providerId = providerIdentity(update);
  if (columns.providerId !== undefined && providerId !== undefined && rowCell(row, columns.providerId) !== providerId) {
    return "Google Sheets write verification failed for the provider identity.";
  }
  const preservedColumns: (keyof TrackerColumns)[] = ["followUpDate", "contactReferral", "notes"];
  for (const column of preservedColumns) {
    if (rowCell(row, columns[column]) !== rowCell(previousRow, columns[column])) {
      return `Google Sheets write verification detected an unexpected change to user-owned '${column}'.`;
    }
  }
  return undefined;
}

function trackerFailure(reason: string): JobTrackerResult {
  return { ok: false, simulated: false, error: reason };
}

/**
 * Real server-side adapter for the canonical Nate Job Search Tracker sheet.
 * It only records an already-applied application; it has no submission path.
 */
export class GoogleSheetsJobTracker implements JobTracker {
  public readonly id = "google-sheets-nate-job-search-tracker";

  constructor(
    private readonly config: GoogleSheetsJobTrackerConfig,
    private readonly transport: GoogleSheetsApiTransport,
  ) {
    if (!config.spreadsheetId.trim()) throw new Error("A Google spreadsheet ID is required.");
    if (!config.spreadsheetName.trim()) throw new Error("A Google spreadsheet name is required.");
    if (!config.sheetTab.trim()) throw new Error("A Google spreadsheet tab is required.");
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0) throw new Error("Google Sheets timeout must be a positive integer.");
  }

  async recordApplied(update: JobTrackerUpdate, context?: JobTrackerSyncContext): Promise<JobTrackerResult> {
    if (!isJobTrackerUpdate(update) || !context || !isJobTrackerSyncContext(context)) {
      return trackerFailure("Tracker sync requires a validated applied application context.");
    }
    if (context.sourceMode !== "live" || update.proofMode === "simulated") {
      return trackerFailure("The real Google Sheets tracker accepts live, non-simulated application evidence only.");
    }
    if (update.company !== context.job.company || update.role !== context.job.title) {
      return trackerFailure("Tracker update does not match the applied job posting.");
    }
    if (context.sourceRecordId && update.sourceRecordId !== context.sourceRecordId) {
      return trackerFailure("Tracker update does not match the applied provider record.");
    }
    const contextUrls = new Set([
      canonicalJobUrl(context.job.applicationUrl),
      canonicalJobUrl(context.job.sourceUrl),
    ].filter((value): value is string => value !== undefined));
    if (contextUrls.size > 0 && !canonicalUrls(update).some((value) => contextUrls.has(value))) {
      return trackerFailure("Tracker update URL provenance does not match the applied job posting.");
    }

    try {
      const metadata = await this.transport.getSpreadsheetMetadata(this.config.spreadsheetId);
      if (metadata.spreadsheetId !== this.config.spreadsheetId) {
        return trackerFailure("Google Sheets returned metadata for a different spreadsheet.");
      }
      if (metadata.title !== this.config.spreadsheetName) {
        return trackerFailure(`Configured spreadsheet title did not match '${this.config.spreadsheetName}'.`);
      }
      if (!metadata.sheets.some((sheet) => sheet.title === this.config.sheetTab)) {
        return trackerFailure(`Configured tracker tab '${this.config.sheetTab}' was not found.`);
      }

      const range = `${quoteSheetName(this.config.sheetTab)}!A1:Z${MAX_TRACKER_ROWS}`;
      const rows = await this.transport.getValues(this.config.spreadsheetId, range);
      if (rows.length === 0) return trackerFailure("The tracker tab returned no header row.");
      const columns = mapColumns(rows[0] ?? []);
      const existingRow = findExistingRow(rows, columns, update);
      const row = existingRow ?? firstAvailableRow(rows);
      if (row > MAX_TRACKER_ROWS) return trackerFailure("The tracker retrieval cap was reached; no row was written.");
      const writes = buildWrites(this.config.sheetTab, row, columns, update);
      if (writes.length === 0) return trackerFailure("No agent-owned tracker fields were available to write.");
      await this.transport.updateValues(this.config.spreadsheetId, writes);
      const verifiedRows = await this.transport.getValues(this.config.spreadsheetId, range);
      const verificationError = verifyTrackerRow(verifiedRows[row - 1], rows[row - 1], columns, update);
      if (verificationError) return trackerFailure(verificationError);
      return {
        ok: true,
        simulated: false,
        trackerRecordId: `${this.config.sheetTab}!row:${row}`,
      };
    } catch (error) {
      return trackerFailure(safeError(error, "Google Sheets tracker update failed."));
    }
  }
}

export interface GoogleSheetsEnvironment extends GoogleAuthEnvironment {
  ATELIER_GOOGLE_SHEET_ID?: string;
  ATELIER_GOOGLE_SHEET_NAME?: string;
  ATELIER_GOOGLE_SHEET_TAB?: string;
  ATELIER_GOOGLE_SHEETS_TIMEOUT_MS?: string;
}

/** Server-side transport factory shared by the legacy tracker and standalone queue. */
export function createConfiguredGoogleSheetsTransport(env: GoogleSheetsEnvironment): GoogleSheetsHttpTransport {
  const timeoutMs = timeoutFromEnv(env.ATELIER_GOOGLE_SHEETS_TIMEOUT_MS);
  const authSelection = resolveGoogleAuthMode(env);
  if (authSelection.error) throw new Error(authSelection.error);
  if (!authSelection.mode) throw new Error("Google Sheets credentials are not configured; set ATELIER_GOOGLE_AUTH_MODE=oauth and run npm run career-agent:google-auth, or configure an explicit legacy credential mode.");
  const token = env.ATELIER_GOOGLE_ACCESS_TOKEN?.trim();
  const credentialPath = env.ATELIER_GOOGLE_APPLICATION_CREDENTIALS?.trim();
  const provider = authSelection.mode === "oauth"
    ? createGoogleOAuthAccessTokenProvider(env, timeoutMs)
    : authSelection.mode === "access_token" && token
      ? new StaticAccessTokenProvider(token)
      : authSelection.mode === "service_account" && credentialPath
        ? new ServiceAccountAccessTokenProvider(credentialPath, timeoutMs)
        : undefined;
  if (!provider) throw new Error(`Google Sheets auth mode '${authSelection.mode}' is missing its required credential configuration.`);
  return new GoogleSheetsHttpTransport({ accessTokenProvider: provider, timeoutMs });
}

function timeoutFromEnv(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 10_000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("ATELIER_GOOGLE_SHEETS_TIMEOUT_MS must be a positive integer.");
  return parsed;
}

/** Build the configured real tracker without exposing credentials to the client. */
export function createConfiguredGoogleSheetsJobTracker(
  env: GoogleSheetsEnvironment,
): JobTracker {
  const unavailable = (reason: string): JobTracker => ({
    id: "google-sheets-unavailable",
    async recordApplied(): Promise<JobTrackerResult> {
      return trackerFailure(reason);
    },
  });
  const spreadsheetId = env.ATELIER_GOOGLE_SHEET_ID?.trim();
  if (!spreadsheetId) {
    return unavailable("ATELIER_GOOGLE_SHEET_ID is not configured; the canonical tracker was not updated.");
  }

  const timeoutMs = timeoutFromEnv(env.ATELIER_GOOGLE_SHEETS_TIMEOUT_MS);
  const authSelection = resolveGoogleAuthMode(env);
  if (authSelection.error) return unavailable(authSelection.error);
  const token = env.ATELIER_GOOGLE_ACCESS_TOKEN?.trim();
  const credentialPath = env.ATELIER_GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!authSelection.mode) {
    return unavailable("Google Sheets credentials are not configured; set ATELIER_GOOGLE_AUTH_MODE=oauth and run npm run career-agent:google-auth, or configure an explicit legacy credential mode.");
  }

  let provider: AccessTokenProvider;
  if (authSelection.mode === "oauth") {
    provider = createGoogleOAuthAccessTokenProvider(env, timeoutMs);
  } else if (authSelection.mode === "access_token" && token) {
    provider = new StaticAccessTokenProvider(token);
  } else if (authSelection.mode === "service_account" && credentialPath) {
    provider = new ServiceAccountAccessTokenProvider(resolve(credentialPath), timeoutMs);
  } else {
    return unavailable(`ATELIER_GOOGLE_AUTH_MODE=${authSelection.mode} is missing its matching credential configuration.`);
  }
  const transport = new GoogleSheetsHttpTransport({ accessTokenProvider: provider, timeoutMs });
  return new GoogleSheetsJobTracker({
    spreadsheetId,
    spreadsheetName: env.ATELIER_GOOGLE_SHEET_NAME?.trim() || "Nate Job Search Tracker",
    sheetTab: env.ATELIER_GOOGLE_SHEET_TAB?.trim() || "Job Tracker",
    timeoutMs,
  }, transport);
}
