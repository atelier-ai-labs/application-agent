import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import {
  DEFAULT_RESUME_ARTIFACT_MANIFEST,
  inspectResumeArtifact,
  readResumeArtifact,
  resolveResumeArtifactManifest,
  writeResumeArtifactManifest,
} from "../application-agent/automation/resume/resumeArtifact";
import {
  ingestResumeIntoProfile,
  ResumeIngestionError,
} from "../application-agent/automation/resume/resumeIngestion";
import { resolveResumePathsFromEnv } from "../application-agent/automation/executionHost/config";
import { validateCareerAgentReadiness } from "../application-agent/src/service/careerAgentService";
import { attentionEventForConfiguration, isAttentionEvent } from "../application-agent/src/domain/attention";
import { exampleCandidateProfile } from "../application-agent/src/domain/profile";
import { isCandidateProfile } from "../application-agent/src/domain/validation";
import type { CandidateProfile } from "../application-agent/src/domain/types";

function privateProfile(): CandidateProfile {
  const profile = JSON.parse(JSON.stringify(exampleCandidateProfile)) as CandidateProfile;
  profile.profileKind = "private";
  profile.identity = { fullName: null, email: null, phone: null, location: null };
  profile.location = null;
  profile.employmentHistory = [];
  profile.education = [];
  profile.skills = [];
  profile.projects = [];
  profile.certifications = [];
  profile.resumeFamilies = [];
  profile.workPreferences = { remote: null, relocation: null, travel: null };
  profile.workAuthorization = { status: null, countries: [], sponsorshipRequired: null };
  return profile;
}

const resumeText = [
  "Jordan Example",
  "SKILLS",
  "AWS, Kubernetes, Terraform, Python",
  "EXPERIENCE",
  "Platform Engineer | Example Cloud | 2020-01 - Present | Location: Remote",
  "- Built AWS deployment workflows with Terraform and Kubernetes.",
  "EDUCATION",
  "B.S. Computer Science | Example University | 2019",
  "PROJECTS",
  "Cloud Deployment System",
  "- Automated Kubernetes releases for internal platform services.",
  "CERTIFICATIONS",
  "AWS Certified Solutions Architect | Amazon Web Services | 2024",
  "WORK AUTHORIZATION",
  "This section must not change the existing authorization profile.",
].join("\n");

const ordinaryResumeText = [
  "CORE COMPETENCIES",
  "AWS, Docker",
  "PROFESSIONAL EXPERIENCE",
  "Acme Systems — Platform Engineer — 2022 - Present — Remote",
  "• Built AWS deployment automation.",
  "Example Labs",
  "Software Developer",
  "2020 - 2022",
  "• Delivered Docker-based services.",
  "EDUCATION",
  "Example University — B.S. Computer Science — 2019",
].join("\n");

function crc32(bytes: Buffer): number {
  let value = 0xFFFFFFFF;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xEDB88320 : 0);
  }
  return (value ^ 0xFFFFFFFF) >>> 0;
}

function docxWithBody(body: string): Buffer {
  const name = Buffer.from("word/document.xml");
  const data = Buffer.from("<w:document><w:body>" + body + "</w:body></w:document>");
  const compressed = deflateRawSync(data);
  const crc = crc32(data);
  const local = Buffer.alloc(30 + name.length + compressed.length);
  local.writeUInt32LE(0x04034B50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  compressed.copy(local, 30 + name.length);

  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014B50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  name.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(0, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

function minimalDocx(text: string): Buffer {
  return docxWithBody(text.split("\n").map((line) => "<w:p><w:r><w:t>" + line + "</w:t></w:r></w:p>").join(""));
}

function multiRunDocx(paragraphs: readonly (readonly [string, string])[]): Buffer {
  return docxWithBody(paragraphs.map(([label, value]) => "<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>" + label + "</w:t></w:r><w:r><w:t>" + value + "</w:t></w:r></w:p>").join(""));
}

function minimalPdf(text: string): string {
  const escaped = (line: string) => line.replace(/([\\()])/g, "\\$1");
  return `%PDF-1.4\nBT\n${text.split("\n").map((line) => `(${escaped(line)}) Tj`).join("\n")}\nET\n%%EOF`;
}

describe("grounded local resume ingestion", () => {
  it("populates only explicit normalized resume facts and a grounded cloud family", () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-resume-ingestion-"));
    try {
      const artifact = join(directory, "resume.pdf");
      writeFileSync(artifact, minimalPdf(resumeText), "latin1");
      const before = privateProfile();
      const result = ingestResumeIntoProfile(before, { familyId: "cloud-platform", artifactPath: artifact });

      expect(isCandidateProfile(result.profile)).toBe(true);
      expect(result.counts).toEqual({ skills: 5, employment: 1, education: 1, projects: 1, certifications: 1 });
      expect(result.profile.skills).toEqual(["AWS", "Kubernetes", "Terraform", "Python", "platform"]);
      expect(result.profile.skills).not.toContain("TargetJobOnlySkill");
      expect(result.profile.employmentHistory).toHaveLength(1);
      expect(result.profile.employmentHistory[0]).toMatchObject({ employer: "Example Cloud", title: "Platform Engineer", startDate: "2020-01", endDate: null, location: "Remote" });
      expect(result.profile.education[0]).toMatchObject({ institution: "Example University", degree: "B.S.", field: "Computer Science", completionDate: "2019" });
      expect(result.profile.projects[0]).toMatchObject({ name: "Cloud Deployment System" });
      expect(result.profile.certifications[0]).toMatchObject({ name: "AWS Certified Solutions Architect", issuer: "Amazon Web Services", issuedDate: "2024" });
      expect(result.profile.resumeFamilies).toContainEqual(expect.objectContaining({
        id: "cloud-platform",
        focusKeywords: expect.arrayContaining(["AWS", "Kubernetes", "Terraform", "cloud", "platform"]),
        experienceIds: [result.profile.employmentHistory[0]?.id],
        projectIds: [result.profile.projects[0]?.id],
      }));
      expect(JSON.stringify(result.artifact)).not.toContain("Platform Engineer");
      expect(result.profile.workAuthorization).toEqual(before.workAuthorization);
      expect(result.profile.workPreferences).toEqual(before.workPreferences);
      expect(result.profile.identity).toEqual(before.identity);
      expect(result.profile.answerPolicies).toEqual(before.answerPolicies);
      expect(result.profile.approvedReusableAnswers).toEqual(before.approvedReusableAnswers);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("extracts only explicitly labeled profile URLs and preserves explicit profile precedence", () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-resume-profile-links-"));
    try {
      const artifact = join(directory, "resume.docx");
      writeFileSync(artifact, minimalDocx([
        "Jordan Example",
        "LinkedIn URL: https://www.linkedin.com/in/jordan-example",
        "Portfolio | www.jordan-example.dev.",
        "https://unlabeled.example/not-a-profile-fact",
        "SKILLS",
        "AWS",
      ].join("\n")));

      const extracted = ingestResumeIntoProfile(privateProfile(), { familyId: "cloud-platform", artifactPath: artifact }).profile;
      expect(extracted.identity.linkedinUrl).toBe("https://www.linkedin.com/in/jordan-example");
      expect(extracted.identity.websiteUrl).toBe("https://www.jordan-example.dev");

      const explicit = privateProfile();
      explicit.identity = {
        ...explicit.identity,
        linkedinUrl: "https://www.linkedin.com/in/explicit-profile",
        websiteUrl: "https://explicit.example",
      };
      const preserved = ingestResumeIntoProfile(explicit, { familyId: "cloud-platform", artifactPath: artifact }).profile;
      expect(preserved.identity.linkedinUrl).toBe("https://www.linkedin.com/in/explicit-profile");
      expect(preserved.identity.websiteUrl).toBe("https://explicit.example");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("extracts explicitly labeled work preference and availability facts", () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-resume-preferences-"));
    try {
      const artifact = join(directory, "resume.docx");
      writeFileSync(artifact, minimalDocx([
        "Preferred work location: Remote - United States",
        "Earliest start date: 2026-10-01",
        "SKILLS",
        "AWS",
      ].join("\n")));

      const result = ingestResumeIntoProfile(privateProfile(), { familyId: "cloud-platform", artifactPath: artifact }).profile;
      expect(result.workPreferences.preferredWorkLocation).toBe("Remote - United States");
      expect(result.workPreferences.availabilityStartDate).toBe("2026-10-01");

      const explicitProfile = privateProfile();
      explicitProfile.workPreferences = {
        ...explicitProfile.workPreferences,
        preferredWorkLocation: "New York, NY",
        availabilityStartDate: "Immediately",
      };
      const preserved = ingestResumeIntoProfile(explicitProfile, { familyId: "cloud-platform", artifactPath: artifact }).profile;
      expect(preserved.workPreferences.preferredWorkLocation).toBe("New York, NY");
      expect(preserved.workPreferences.availabilityStartDate).toBe("Immediately");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not treat ordinary location or employment dates as preference facts", () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-resume-preferences-negative-"));
    try {
      const artifact = join(directory, "resume.docx");
      writeFileSync(artifact, minimalDocx([
        "Location: New York, NY",
        "EXPERIENCE",
        "Platform Engineer | Example Cloud | 2020-01 - Present",
        "SKILLS",
        "AWS",
      ].join("\n")));

      const result = ingestResumeIntoProfile(privateProfile(), { familyId: "cloud-platform", artifactPath: artifact }).profile;
      expect(result.workPreferences.preferredWorkLocation).toBeUndefined();
      expect(result.workPreferences.availabilityStartDate).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reads the supported PDF and DOCX artifact formats without persisting document text as metadata", () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-resume-artifacts-"));
    try {
      const pdf = join(directory, "resume.pdf");
      const docx = join(directory, "resume.docx");
      writeFileSync(pdf, "%PDF-1.4\nBT\n(AWS) Tj\n(Kubernetes) Tj\nET\n%%EOF", "latin1");
      writeFileSync(docx, minimalDocx("SKILLS\nAWS, Kubernetes"));
      expect(readResumeArtifact(pdf).text).toContain("AWS");
      expect(readResumeArtifact(docx).text).toContain("Kubernetes");
      expect(inspectResumeArtifact(pdf)).toMatchObject({ ok: true, metadata: { extension: ".pdf", mimeType: "application/pdf" } });
      expect(inspectResumeArtifact(docx)).toMatchObject({ ok: true, metadata: { extension: ".docx" } });
      expect(JSON.stringify(inspectResumeArtifact(pdf))).not.toContain("AWS");
      expect(JSON.stringify(inspectResumeArtifact(docx))).not.toContain("Kubernetes");
      expect(ingestResumeIntoProfile(privateProfile(), { familyId: "cloud-platform", artifactPath: docx }).counts.skills).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("parses ordinary paragraph resume structure, adjacent dates, and Word bullet characters", () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-resume-structure-"));
    try {
      const artifact = join(directory, "resume.docx");
      writeFileSync(artifact, minimalDocx(ordinaryResumeText));
      const result = ingestResumeIntoProfile(privateProfile(), { familyId: "cloud-platform", artifactPath: artifact });

      expect(result.counts).toEqual({ skills: 2, employment: 2, education: 1, projects: 0, certifications: 0 });
      expect(result.profile.employmentHistory).toMatchObject([
        { employer: "Acme Systems", title: "Platform Engineer", startDate: "2022", endDate: null, location: "Remote", bullets: ["Built AWS deployment automation."] },
        { employer: "Example Labs", title: "Software Developer", startDate: "2020", endDate: "2022", bullets: ["Delivered Docker-based services."] },
      ]);
      expect(result.profile.education[0]).toMatchObject({ institution: "Example University", degree: "B.S.", field: "Computer Science", completionDate: "2019" });
      expect(result.profile.employmentHistory[0]?.bullets).not.toContain("Delivered Docker-based services.");
      expect(result.profile.education).toHaveLength(1);
      expect(result.profile.skills).toEqual(["AWS", "Docker"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("extracts explicit technology lists from bold multi-run category lines", () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-resume-inline-skills-"));
    try {
      const artifact = join(directory, "resume.docx");
      writeFileSync(artifact, multiRunDocx([
        ["TECHNICAL PROFILE", ""],
        ["Cloud Platforms:", "ExampleCompute, ExampleQueue, ExampleQueue"],
        ["Tools and Technologies:", "ExampleCLI, ExampleQueue"],
        ["Languages and Frameworks:", "ExampleLang, ExampleWeb"],
        ["Security:", "ExampleAuth, ExamplePolicy"],
      ]));
      const extracted = readResumeArtifact(artifact).text;
      expect(extracted).toContain("Cloud Platforms: ExampleCompute");
      const result = ingestResumeIntoProfile(privateProfile(), { familyId: "cloud-platform", artifactPath: artifact });

      expect(result.profile.skills).toEqual([
        "ExampleCompute",
        "ExampleQueue",
        "ExampleCLI",
        "ExampleLang",
        "ExampleWeb",
        "ExampleAuth",
        "ExamplePolicy",
      ]);
      expect(result.counts).toMatchObject({ skills: 7, employment: 0, education: 0, projects: 0, certifications: 0 });
      expect(result.profile.resumeFamilies[0]).toMatchObject({ focusKeywords: [], experienceIds: [], projectIds: [] });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not invent a degree from an institution, program, and date-only education line", () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-resume-education-program-"));
    try {
      const artifact = join(directory, "resume.docx");
      writeFileSync(artifact, minimalDocx([
        "EXPERIENCE",
        "Example Organization — Platform Engineer — 2022 - Present",
        "EDUCATION",
        "Example Technical School — Web Development — 2020 - 2021",
      ].join("\n")));
      const result = ingestResumeIntoProfile(privateProfile(), { familyId: "cloud-platform", artifactPath: artifact });

      expect(result.profile.education).toEqual([]);
      expect(result.counts.education).toBe(0);
      expect(isCandidateProfile(result.profile)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts an employment-only resume when the record is structurally unambiguous", () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-resume-optional-sections-"));
    try {
      const artifact = join(directory, "resume.docx");
      writeFileSync(artifact, minimalDocx("EXPERIENCE\nAcme Systems — Platform Engineer — 2022 - Present"));
      const result = ingestResumeIntoProfile(privateProfile(), { familyId: "cloud-platform", artifactPath: artifact });
      expect(result.counts).toMatchObject({ skills: 0, employment: 1, education: 0, projects: 0, certifications: 0 });
      expect(result.profile.employmentHistory[0]).toMatchObject({ employer: "Acme Systems", title: "Platform Engineer", startDate: "2022", endDate: null });
      expect(result.profile.resumeFamilies).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("skips an ambiguous employment header without leaking its bullet into another record", () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-resume-ambiguous-"));
    try {
      const artifact = join(directory, "resume.docx");
      writeFileSync(artifact, minimalDocx("EXPERIENCE\nAcme Systems | Innovation | 2022 - Present\n- Ambiguous work detail.\nEDUCATION\nExample University | B.S. Computer Science | 2019"));
      const result = ingestResumeIntoProfile(privateProfile(), { familyId: "cloud-platform", artifactPath: artifact });
      expect(result.profile.employmentHistory).toHaveLength(0);
      expect(result.profile.education).toHaveLength(1);
      expect(result.warnings).toContain("Skipped 1 ambiguous employment block.");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refreshes imported records without changing unrelated profile facts", () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-resume-refresh-"));
    try {
      const artifact = join(directory, "resume.pdf");
      writeFileSync(artifact, minimalPdf(resumeText), "latin1");
      const first = ingestResumeIntoProfile(privateProfile(), { familyId: "cloud-platform", artifactPath: artifact }).profile;
      writeFileSync(artifact, minimalPdf(resumeText.replace("Python", "Go")), "latin1");
      const second = ingestResumeIntoProfile(first, { familyId: "cloud-platform", artifactPath: artifact }).profile;
      expect(second.employmentHistory).toHaveLength(1);
      expect(second.projects).toHaveLength(1);
      expect(second.skills).toEqual(["AWS", "Kubernetes", "Terraform", "Python", "platform", "Go"]);
      expect(second.resumeFamilies).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("honors explicit family assignment while warning when cloud evidence is limited", () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-resume-evidence-"));
    try {
      const artifact = join(directory, "resume.pdf");
      writeFileSync(artifact, minimalPdf("SKILLS\nWriting, Research\nEXPERIENCE\nWriter | Example Press | 2021 - Present"), "latin1");
      const result = ingestResumeIntoProfile(privateProfile(), { familyId: "cloud-platform", artifactPath: artifact });
      const family = result.profile.resumeFamilies[0];
      expect(result.counts).toEqual({ skills: 2, employment: 1, education: 0, projects: 0, certifications: 0 });
      expect(result.warnings).toContain("Limited explicit cloud/platform terminology was detected; the artifact was imported because cloud-platform was explicitly selected.");
      expect(family).toMatchObject({
        id: "cloud-platform",
        summary: "User-designated Cloud / Platform resume family.",
        focusKeywords: [],
        experienceIds: [],
        projectIds: [],
      });
      expect(result.profile.skills).toEqual(["Writing", "Research"]);
      expect(isCandidateProfile(result.profile)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses explicit assignment consistently for other valid families without inventing family evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-resume-family-routing-"));
    try {
      const artifact = join(directory, "resume.pdf");
      writeFileSync(artifact, minimalPdf("SKILLS\nWriting, Research\nEXPERIENCE\nWriter | Example Press | 2021 - Present"), "latin1");
      for (const familyId of ["frontend-software", "ai-platform-agentic"] as const) {
        const result = ingestResumeIntoProfile(privateProfile(), { familyId, artifactPath: artifact });
        expect(result.profile.resumeFamilies).toHaveLength(1);
        expect(result.profile.resumeFamilies[0]).toMatchObject({
          id: familyId,
          focusKeywords: [],
          experienceIds: [],
          projectIds: [],
        });
        expect(result.profile.resumeFamilies[0]?.summary).toMatch(/^User-designated /);
        expect(result.profile.skills).toEqual(["Writing", "Research"]);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an artifact that has no usable grounded facts", () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-resume-empty-"));
    try {
      const artifact = join(directory, "resume.pdf");
      writeFileSync(artifact, minimalPdf("Jordan Example\nProfessional summary without structured facts."), "latin1");
      expect(() => ingestResumeIntoProfile(privateProfile(), { familyId: "cloud-platform", artifactPath: artifact }))
        .toThrow("The resume did not contain usable grounded facts to import.");
      try {
        ingestResumeIntoProfile(privateProfile(), { familyId: "cloud-platform", artifactPath: artifact });
      } catch (error) {
        expect(error).toBeInstanceOf(ResumeIngestionError);
        expect(error).toMatchObject({ code: "no_grounded_facts" });
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves only bounded family mappings inside the private artifact root", () => {
    const directory = mkdtempSync(join(tmpdir(), "atelier-resume-manifest-"));
    try {
      const root = join(directory, "resumes");
      const manifest = join(directory, DEFAULT_RESUME_ARTIFACT_MANIFEST);
      const artifact = join(root, "cloud-platform.docx");
      mkdirSync(root, { recursive: true });
      writeFileSync(artifact, minimalDocx("SKILLS\nAWS"));
      writeResumeArtifactManifest(manifest, "cloud-platform", artifact, root);
      expect(resolveResumeArtifactManifest(manifest, root)).toEqual({ "cloud-platform": artifact });
      expect(resolveResumePathsFromEnv({
        ATELIER_RESUME_ROOT: root,
        ATELIER_RESUME_MANIFEST_FILE: manifest,
      })).toEqual({ "cloud-platform": artifact });
      expect(readFileSync(manifest, "utf8")).not.toContain("AWS");
      writeFileSync(join(directory, "resume.exe"), "not a resume", "utf8");
      expect(inspectResumeArtifact(join(directory, "resume.exe"))).toMatchObject({ ok: false, code: "unsupported_type" });
      expect(inspectResumeArtifact(join(directory, "missing.pdf"))).toMatchObject({ ok: false, code: "missing" });
      expect(() => writeResumeArtifactManifest(manifest, "cloud-platform", join(root, "missing.pdf"), root)).toThrow("must exist");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("surfaces missing artifacts as a pre-campaign configuration requirement", () => {
    expect(validateCareerAgentReadiness({ resumeFamilies: [{
      id: "cloud-platform",
      label: "Cloud / Platform",
      summary: "Grounded family",
      focusKeywords: ["AWS"],
      experienceIds: [],
      projectIds: [],
    }] }, () => false)).toMatchObject({
      ok: false,
      reasonCode: "missing_resume_artifact",
      failureReason: "provider_configuration",
    });
    const event = attentionEventForConfiguration({
      campaignId: "campaign-resume-artifact",
      createdAt: "2026-09-01T12:00:00.000Z",
      createId: (prefix) => `${prefix}-resume-artifact`,
      reasonCode: "missing_resume_artifact",
    }).event;
    expect(isAttentionEvent(event)).toBe(true);
    expect(event.message).toContain("no usable local resume artifact");
    expect(event.remediation).toContain("PDF or DOCX");
    expect(event.question).toBeUndefined();
  });
});
