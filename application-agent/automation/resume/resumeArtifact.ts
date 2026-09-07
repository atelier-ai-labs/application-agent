import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { inflateRawSync, inflateSync } from "node:zlib";
import type { ResumeFamilyId } from "../../src/domain/types";

export const DEFAULT_RESUME_DIRECTORY = ".local/career-agent/resumes";
export const DEFAULT_RESUME_ARTIFACT_MANIFEST = ".local/career-agent/resume-artifacts.json";
export const MAX_RESUME_ARTIFACT_BYTES = 10 * 1024 * 1024;
export const MAX_EXTRACTED_RESUME_TEXT_LENGTH = 120_000;

export type ResumeArtifactExtension = ".pdf" | ".docx";
export type ResumeArtifactFailureCode =
  | "missing"
  | "unsupported_type"
  | "unreadable"
  | "empty"
  | "too_large"
  | "invalid_format";

export interface ResumeArtifactMetadata {
  extension: ResumeArtifactExtension;
  mimeType: string;
  byteLength: number;
  fingerprint: string;
}

export type ResumeArtifactInspection =
  | { ok: true; path: string; metadata: ResumeArtifactMetadata }
  | { ok: false; code: ResumeArtifactFailureCode; extension?: string };

export class ResumeArtifactError extends Error {
  constructor(
    public readonly code: ResumeArtifactFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "ResumeArtifactError";
  }
}

const RESUME_FAMILY_IDS: ReadonlySet<string> = new Set([
  "cloud-platform",
  "frontend-software",
  "ai-platform-agentic",
]);

function isResumeFamilyId(value: string): value is ResumeFamilyId {
  return RESUME_FAMILY_IDS.has(value);
}

function supportedExtension(value: string): ResumeArtifactExtension | undefined {
  const extension = extname(value).toLowerCase();
  return extension === ".pdf" || extension === ".docx"
    ? extension
    : undefined;
}

function mimeType(extension: ResumeArtifactExtension): string {
  return extension === ".pdf"
    ? "application/pdf"
    : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
}

function fingerprint(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

function withinRoot(root: string, candidate: string): boolean {
  const candidateRelative = relative(root, candidate);
  return candidateRelative === "" || (!candidateRelative.startsWith(`..${sep}`) && candidateRelative !== ".." && !candidateRelative.startsWith(sep));
}

function safeManifestText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512 &&
    !/[\u0000-\u001F\u007F]/.test(value);
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function cleanExtractedText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && index < lines.length - 1))
    .join("\n")
    .trim()
    .slice(0, MAX_EXTRACTED_RESUME_TEXT_LENGTH);
}

function zipEntry(bytes: Buffer, targetName: string): Buffer | undefined {
  const centralSignature = 0x02014B50;
  const localSignature = 0x04034B50;
  const endSignature = 0x06054B50;
  const minimumEndSize = 22;
  const searchStart = Math.max(0, bytes.length - 65_557);
  let endOffset = -1;
  for (let index = bytes.length - minimumEndSize; index >= searchStart; index -= 1) {
    if (bytes.readUInt32LE(index) === endSignature) {
      endOffset = index;
      break;
    }
  }
  if (endOffset < 0) return undefined;

  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  if (centralOffset + centralSize > bytes.length) return undefined;

  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== centralSignature) return undefined;
    const compression = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + commentLength > bytes.length) return undefined;
    const name = bytes.subarray(nameStart, nameEnd).toString("utf8");

    if (name === targetName) {
      if (uncompressedSize > MAX_EXTRACTED_RESUME_TEXT_LENGTH || localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== localSignature) {
        return undefined;
      }
      const localNameLength = bytes.readUInt16LE(localOffset + 26);
      const localExtraLength = bytes.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > bytes.length) return undefined;
      const compressed = bytes.subarray(dataStart, dataEnd);
      try {
        if (compression === 0) return Buffer.from(compressed);
        if (compression === 8) return inflateRawSync(compressed);
      } catch {
        return undefined;
      }
      return undefined;
    }
    offset = nameEnd + extraLength + commentLength;
  }
  return undefined;
}

function docxText(bytes: Buffer): string {
  const xml = zipEntry(bytes, "word/document.xml");
  if (!xml) throw new ResumeArtifactError("invalid_format", "The DOCX resume did not contain readable document text.");
  const decoded = xml.toString("utf8")
    .replace(/<w:tab\b[^>]*\/?\s*>/gi, "\t")
    .replace(/<w:br\b[^>]*\/?\s*>/gi, "\n")
    .replace(/<\/w:(?:p|tr|tc)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return cleanExtractedText(decodeXmlEntities(decoded));
}

function decodePdfLiteral(value: string): string {
  return value
    .replace(/\\([nrtbf()\\])/g, (_match, escaped: string) => ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" }[escaped] ?? escaped))
    .replace(/\\([0-7]{1,3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function pdfStrings(value: string): string[] {
  const result: string[] = [];
  const literalPattern = /\(((?:\\.|[^\\()])*)\)\s*Tj/g;
  for (const match of value.matchAll(literalPattern)) {
    if (match[1]) result.push(decodePdfLiteral(match[1]));
  }
  const arrayPattern = /\[((?:.|\n)*?)\]\s*TJ/g;
  for (const match of value.matchAll(arrayPattern)) {
    const contents = match[1] ?? "";
    for (const literal of contents.matchAll(/\(((?:\\.|[^\\()])*)\)/g)) {
      if (literal[1]) result.push(decodePdfLiteral(literal[1]));
    }
  }
  return result;
}

function pdfText(bytes: Buffer): string {
  if (!bytes.subarray(0, 5).toString("latin1").startsWith("%PDF-")) {
    throw new ResumeArtifactError("invalid_format", "The PDF resume header was not recognized.");
  }
  const source = bytes.toString("latin1");
  const chunks = [source];
  let streamOffset = source.indexOf("stream");
  while (streamOffset >= 0 && chunks.length < 64) {
    let dataStart = streamOffset + "stream".length;
    if (source[dataStart] === "\r") dataStart += source[dataStart + 1] === "\n" ? 2 : 1;
    else if (source[dataStart] === "\n") dataStart += 1;
    const dataEnd = source.indexOf("endstream", dataStart);
    if (dataEnd < 0) break;
    const dictionary = source.slice(Math.max(0, source.lastIndexOf("<<", streamOffset)), streamOffset);
    if (/\/FlateDecode\b/.test(dictionary)) {
      const compressed = bytes.subarray(dataStart, dataEnd);
      try {
        chunks.push(inflateSync(compressed).toString("latin1"));
      } catch {
        try {
          chunks.push(inflateRawSync(compressed).toString("latin1"));
        } catch {
          // A non-text or malformed stream is ignored; other streams may still contain text.
        }
      }
    } else {
      chunks.push(source.slice(dataStart, dataEnd));
    }
    streamOffset = source.indexOf("stream", dataEnd + "endstream".length);
  }
  const text = chunks.flatMap(pdfStrings).join("\n");
  const cleaned = cleanExtractedText(text);
  if (!cleaned) throw new ResumeArtifactError("invalid_format", "The PDF resume contained no extractable text.");
  return cleaned;
}

export function inspectResumeArtifact(filePath: string): ResumeArtifactInspection {
  const extension = supportedExtension(filePath);
  if (!extension) return { ok: false, code: "unsupported_type", extension: extname(filePath).toLowerCase() || "none" };
  const resolvedPath = resolve(filePath);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(resolvedPath);
  } catch {
    return { ok: false, code: "missing", extension };
  }
  if (!stats.isFile()) return { ok: false, code: "missing", extension };
  if (stats.size <= 0) return { ok: false, code: "empty", extension };
  if (stats.size > MAX_RESUME_ARTIFACT_BYTES) return { ok: false, code: "too_large", extension };
  try {
    accessSync(resolvedPath, constants.R_OK);
  } catch {
    return { ok: false, code: "unreadable", extension };
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(resolvedPath);
  } catch {
    return { ok: false, code: "unreadable", extension };
  }
  return {
    ok: true,
    path: resolvedPath,
    metadata: {
      extension,
      mimeType: mimeType(extension),
      byteLength: bytes.length,
      fingerprint: fingerprint(bytes),
    },
  };
}

export function isUsableResumeArtifact(filePath: string): boolean {
  return inspectResumeArtifact(filePath).ok;
}

export function readResumeArtifact(filePath: string): { path: string; metadata: ResumeArtifactMetadata; text: string } {
  const inspection = inspectResumeArtifact(filePath);
  if (!inspection.ok) {
    const messages: Record<ResumeArtifactFailureCode, string> = {
      missing: "The configured resume artifact is missing.",
      unsupported_type: "The resume artifact type is unsupported; use PDF or DOCX.",
      unreadable: "The resume artifact is not readable by the local Career Agent.",
      empty: "The resume artifact is empty.",
      too_large: "The resume artifact exceeds the local size limit.",
      invalid_format: "The resume artifact format could not be read safely.",
    };
    throw new ResumeArtifactError(inspection.code, messages[inspection.code]);
  }
  const bytes = readFileSync(inspection.path);
  let text: string;
  try {
    if (inspection.metadata.extension === ".docx") text = docxText(bytes);
    else if (inspection.metadata.extension === ".pdf") text = pdfText(bytes);
    else text = pdfText(bytes);
  } catch (error) {
    if (error instanceof ResumeArtifactError) throw error;
    throw new ResumeArtifactError("invalid_format", "The resume artifact could not be parsed safely.");
  }
  if (!text) throw new ResumeArtifactError("invalid_format", "The resume artifact contained no readable text.");
  return { path: inspection.path, metadata: inspection.metadata, text };
}

function manifestObject(value: unknown): Partial<Record<ResumeFamilyId, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ResumeArtifactError("invalid_format", "The resume artifact manifest is not a JSON object.");
  }
  const result: Partial<Record<ResumeFamilyId, string>> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (!isResumeFamilyId(key) || !safeManifestText(candidate)) {
      throw new ResumeArtifactError("invalid_format", "The resume artifact manifest contains an invalid family mapping.");
    }
    result[key] = candidate.trim();
  }
  return result;
}

export function loadResumeArtifactManifest(filePath = DEFAULT_RESUME_ARTIFACT_MANIFEST): Partial<Record<ResumeFamilyId, string>> {
  try {
    return manifestObject(JSON.parse(readFileSync(resolve(filePath), "utf8")));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") return {};
    if (error instanceof ResumeArtifactError) throw error;
    throw new ResumeArtifactError("invalid_format", "The resume artifact manifest could not be read safely.");
  }
}

export function resolveResumeArtifactManifest(
  filePath = DEFAULT_RESUME_ARTIFACT_MANIFEST,
  rootPath?: string,
): Partial<Record<ResumeFamilyId, string>> {
  const manifestPath = resolve(filePath);
  const root = resolve(rootPath ?? join(dirname(manifestPath), "resumes"));
  const manifest = loadResumeArtifactManifest(manifestPath);
  const resolved: Partial<Record<ResumeFamilyId, string>> = {};
  for (const [family, candidate] of Object.entries(manifest)) {
    if (!candidate || !isResumeFamilyId(family)) continue;
    const artifactPath = resolve(dirname(manifestPath), candidate);
    if (!withinRoot(root, artifactPath)) {
      throw new ResumeArtifactError("invalid_format", "A resume artifact must remain inside the configured resume directory.");
    }
    resolved[family] = artifactPath;
  }
  return resolved;
}

export function resolveResumeArtifactPath(filePath: string, rootPath = DEFAULT_RESUME_DIRECTORY): string {
  const root = resolve(rootPath);
  const artifactPath = resolve(filePath);
  if (!withinRoot(root, artifactPath)) {
    throw new ResumeArtifactError("invalid_format", "The resume artifact must remain inside the local resume directory.");
  }
  return artifactPath;
}

let temporaryManifestSequence = 0;

export function writeResumeArtifactManifest(
  filePath: string,
  familyId: ResumeFamilyId,
  artifactPath: string,
  rootPath = join(dirname(resolve(filePath)), "resumes"),
): void {
  const manifestPath = resolve(filePath);
  const root = resolve(rootPath);
  const resolvedArtifact = resolve(artifactPath);
  if (!withinRoot(root, resolvedArtifact)) {
    throw new ResumeArtifactError("invalid_format", "The resume artifact must remain inside the local resume directory.");
  }
  const inspection = inspectResumeArtifact(resolvedArtifact);
  if (!inspection.ok) {
    throw new ResumeArtifactError(inspection.code, "The resume artifact must exist, be readable, and use PDF or DOCX before it is mapped.");
  }
  const current = loadResumeArtifactManifest(manifestPath);
  current[familyId] = relative(dirname(manifestPath), resolvedArtifact).split(sep).join("/");
  const directory = dirname(manifestPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${manifestPath}.tmp-${process.pid}-${++temporaryManifestSequence}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(current, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, manifestPath);
  } catch (error) {
    throw new ResumeArtifactError("unreadable", "The resume artifact manifest could not be saved safely.");
  }
}

export function defaultResumeArtifactPath(familyId: ResumeFamilyId, rootPath = DEFAULT_RESUME_DIRECTORY): string {
  return join(resolve(rootPath), `${familyId}.pdf`);
}
