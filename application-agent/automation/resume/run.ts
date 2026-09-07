import { loadEnv } from "vite";
import { readFileSync, renameSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseCandidateProfile } from "../../src/domain/profile";
import {
  DEFAULT_RESUME_ARTIFACT_MANIFEST,
  DEFAULT_RESUME_DIRECTORY,
  defaultResumeArtifactPath,
  resolveResumeArtifactPath,
  writeResumeArtifactManifest,
} from "./resumeArtifact";
import { ingestResumeIntoProfile, ResumeIngestionError } from "./resumeIngestion";

const localEnv = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
for (const [key, value] of Object.entries(localEnv)) {
  if (process.env[key] === undefined) process.env[key] = value;
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.slice(2).find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function familyId(value: string | undefined): "cloud-platform" | "frontend-software" | "ai-platform-agentic" {
  if (value === "cloud-platform" || value === "frontend-software" || value === "ai-platform-agentic") return value;
  throw new Error("--family must be cloud-platform, frontend-software, or ai-platform-agentic.");
}

function writePrivateProfile(filePath: string, profile: unknown): void {
  const target = resolve(filePath);
  const temporary = `${target}.tmp-${process.pid}`;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, target);
  } catch {
    throw new Error("The private Career Agent profile could not be saved safely.");
  }
}

function loadPrivateProfile(filePath: string) {
  try {
    const profile = parseCandidateProfile(JSON.parse(readFileSync(resolve(filePath), "utf8")));
    if (profile.profileKind !== "private") throw new Error("example profile");
    return profile;
  } catch {
    throw new Error("The configured private Career Agent profile could not be read or does not match the profile schema.");
  }
}

try {
  const family = familyId(argument("family") ?? "cloud-platform");
  const root = resolve(argument("root") ?? process.env.ATELIER_RESUME_ROOT?.trim() ?? DEFAULT_RESUME_DIRECTORY);
  const manifest = resolve(argument("manifest") ?? process.env.ATELIER_RESUME_MANIFEST_FILE?.trim() ?? DEFAULT_RESUME_ARTIFACT_MANIFEST);
  const profilePath = resolve(argument("profile") ?? process.env.ATELIER_CAREER_AGENT_PROFILE_FILE?.trim() ?? ".local/career-agent/profile.json");
  const requestedArtifact = argument("file");
  const artifactPath = resolveResumeArtifactPath(requestedArtifact ? resolve(requestedArtifact) : defaultResumeArtifactPath(family, root), root);
  const result = ingestResumeIntoProfile(loadPrivateProfile(profilePath), { familyId: family, artifactPath });
  writePrivateProfile(profilePath, result.profile);
  writeResumeArtifactManifest(manifest, family, artifactPath, root);
  console.log(`[career-agent:import-resume] imported ${result.artifact.extension} (${result.artifact.byteLength} bytes)`);
  console.log(`[career-agent:import-resume] grounded counts: skills=${result.counts.skills}, employment=${result.counts.employment}, education=${result.counts.education}, projects=${result.counts.projects}, certifications=${result.counts.certifications}`);
  for (const warning of result.warnings) console.warn(`[career-agent:import-resume] warning: ${warning}`);
} catch (error) {
  const message = error instanceof ResumeIngestionError || error instanceof Error
    ? error.message
    : "Resume import failed safely.";
  console.error(`[career-agent:import-resume] ${message}`);
  process.exitCode = 1;
}
