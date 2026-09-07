export type ProfileKind = "example" | "private";

export type AnswerPolicy = "auto" | "draft_review" | "ask" | "never_auto";

export type ResumeFamilyId =
  | "cloud-platform"
  | "frontend-software"
  | "ai-platform-agentic";

export type FitClassification = "strong" | "good" | "stretch" | "weak";

export type ApplicationRecommendation =
  | "proceed"
  | "proceed_with_review"
  | "hold";

export type ApplicationAnswerStatus =
  | "resolved"
  | "drafted"
  | "needs_input"
  | "blocked";

export type ApplicationStatus =
  | "discovered"
  | "evaluated"
  | "preparing"
  | "needs_input"
  | "ready_for_review"
  | "applied"
  | "failed";

export type HumanRequiredFieldStatus = "open" | "resolved";

export type ApplicationEventType =
  | "application.created"
  | "application.evaluated"
  | "application.prepared"
  | "application.needs_input"
  | "application.ready_for_review"
  | "application.applied"
  | "application.failed";

export type AnswerValue = string | boolean | number;

export type SubmissionProofMode = "external" | "simulated";

export interface SubmissionProof {
  mode: SubmissionProofMode;
  provider: string;
  externalApplicationId: string;
  submittedAt: string;
  evidence: string;
}

/**
 * A user confirmation is intentionally separate from executor proof. It records
 * that the user said the manual submission succeeded without inventing an ATS
 * receipt or external application identifier.
 */
export interface ManualSubmissionConfirmation {
  mode: "manual";
  confirmedAt: string;
  evidence: "user_confirmed_successful_manual_submission";
}

export interface CandidateIdentity {
  fullName: string | null;
  /** Optional explicit, verified preferred name; never derived from fullName. */
  preferredName?: string | null;
  /** Optional explicit profile fact; never inferred from fullName or another URL. */
  linkedinUrl?: string | null;
  /** Optional explicit profile fact; never inferred from fullName or another URL. */
  websiteUrl?: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
}

export interface EmploymentRecord {
  id: string;
  employer: string;
  title: string;
  startDate: string;
  endDate: string | null;
  location: string | null;
  bullets: readonly string[];
  verifiedSkills: readonly string[];
  provenance: string;
}

export interface EducationRecord {
  id: string;
  institution: string;
  degree: string;
  field: string | null;
  completionDate: string | null;
  provenance: string;
}

export interface CandidateProject {
  id: string;
  name: string;
  description: string;
  bullets: readonly string[];
  verifiedSkills: readonly string[];
  provenance: string;
}

export interface CertificationRecord {
  id: string;
  name: string;
  issuer: string;
  issuedDate: string | null;
  expiresDate: string | null;
  provenance: string;
}

export interface WorkPreferences {
  remote: string | null;
  relocation: string | null;
  travel: string | null;
  /** Optional explicit authority for desired/preferred work-location questions. */
  preferredWorkLocation?: string | null;
  /** Optional explicit authority for application availability/start-date questions. */
  availabilityStartDate?: string | null;
}

export interface WorkAuthorization {
  status: string | null;
  countries: readonly string[];
  sponsorshipRequired: boolean | null;
}

export interface ResumeFamily {
  id: ResumeFamilyId;
  label: string;
  summary: string;
  focusKeywords: readonly string[];
  experienceIds: readonly string[];
  projectIds: readonly string[];
}

export interface CandidateProfile {
  schemaVersion: "0.1";
  id: string;
  profileKind: ProfileKind;
  identity: CandidateIdentity;
  location: string | null;
  employmentHistory: readonly EmploymentRecord[];
  education: readonly EducationRecord[];
  skills: readonly string[];
  projects: readonly CandidateProject[];
  certifications: readonly CertificationRecord[];
  workPreferences: WorkPreferences;
  workAuthorization: WorkAuthorization;
  resumeFamilies: readonly ResumeFamily[];
  answerPolicies: Readonly<Record<string, AnswerPolicy>>;
  approvedReusableAnswers: Readonly<Record<string, string>>;
}

export interface JobIntakeInput {
  rawText: string;
  sourceUrl?: string;
  applicationUrl?: string;
  companyHint?: string;
  titleHint?: string;
  isExample?: boolean;
}

export interface JobCompensation {
  minimum?: number;
  maximum?: number;
  currency?: string;
  period?: string;
}

export interface JobPosting {
  sourceUrl?: string;
  applicationUrl?: string;
  company: string;
  title: string;
  location?: string;
  remoteStatus?: string;
  employmentType?: string;
  compensation?: JobCompensation;
  description: string;
  requiredSkills: readonly string[];
  preferredSkills: readonly string[];
  seniority?: string;
  ats?: string;
  capturedAt: string;
}

export interface FitAssessment {
  classification: FitClassification;
  strongMatches: readonly string[];
  partialMatches: readonly string[];
  meaningfulGaps: readonly string[];
  unsupportedRequiredQualifications: readonly string[];
  recommendedResumeFamily: ResumeFamilyId;
  resumeFamilyReason: string;
  applicationRecommendation: ApplicationRecommendation;
  methodology: string;
}

export type TailoredResumeSectionKind =
  | "summary"
  | "skills"
  | "experience"
  | "projects";

export interface TailoredResumeSection {
  kind: TailoredResumeSectionKind;
  title: string;
  content: string | readonly string[];
  provenance: readonly string[];
}

export interface TailoredResume {
  familyId: ResumeFamilyId;
  familyLabel: string;
  summary: string;
  sections: readonly TailoredResumeSection[];
  generatedAt: string;
}

export interface ApplicationAnswer {
  id: string;
  field: string;
  question?: string;
  policy: AnswerPolicy;
  value?: AnswerValue;
  status: ApplicationAnswerStatus;
  provenance?: readonly string[];
}

export interface HumanRequiredField {
  id: string;
  field: string;
  label: string;
  reason: string;
  policy: AnswerPolicy;
  answerId: string;
  status: HumanRequiredFieldStatus;
  value?: AnswerValue;
}

export interface Application {
  id: string;
  isExample: boolean;
  job: JobPosting;
  fit: FitAssessment | null;
  resume: TailoredResume | null;
  answers: readonly ApplicationAnswer[];
  blockers: readonly HumanRequiredField[];
  status: ApplicationStatus;
  createdAt: string;
  updatedAt: string;
  failureReason?: string;
  submissionProof?: SubmissionProof;
  manualSubmissionConfirmation?: ManualSubmissionConfirmation;
}

export interface ApplicationEvent {
  id: string;
  applicationId: string;
  type: ApplicationEventType;
  occurredAt: string;
  metadata?: Readonly<Record<string, string>>;
}

/** Future submission integrations must receive an explicit user approval. */
export interface SubmissionApproval {
  approved: true;
  approvedAt: string;
}
