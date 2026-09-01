import { useCallback, useMemo, useState } from "react";
import { clearDepartmentCache } from "../../../src/hooks/useDepartmentData";
import {
  clearCandidateProfile,
  exampleCandidateProfile,
  loadCandidateProfile,
  parseCandidateProfile,
  saveCandidateProfile,
} from "../domain/profile";
import { createApplicationService } from "../service/applicationService";
import type {
  Application,
  ApplicationEvent,
  CandidateProfile,
  JobIntakeInput,
} from "../domain/types";
import {
  getDefaultApplicationRepository,
  type ApplicationRepository,
} from "../persistence/applicationRepository";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Application Agent could not complete that action.";
}

export function useApplicationWorkspace() {
  const repository = useMemo<ApplicationRepository>(() => getDefaultApplicationRepository(), []);
  const [profile, setProfile] = useState<CandidateProfile>(() => loadCandidateProfile());
  const service = useMemo(
    () => createApplicationService(profile, repository),
    [profile, repository],
  );
  const [applications, setApplications] = useState<readonly Application[]>(() => service.listApplications());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setApplications(service.listApplications());
    clearDepartmentCache("application-agent");
  }, [service]);

  const prepare = useCallback(async (input: JobIntakeInput): Promise<Application | null> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const application = await service.prepareFromIntake(input);
      refresh();
      setNotice("Application packet prepared. Review the open fields before submitting manually.");
      return application;
    } catch (actionError) {
      setError(errorMessage(actionError));
      refresh();
      return null;
    } finally {
      setBusy(false);
    }
  }, [refresh, service]);

  const resolveField = useCallback(async (
    applicationId: string,
    blockerId: string,
    value: string,
  ): Promise<Application | null> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const application = service.resolveHumanField(applicationId, blockerId, value);
      refresh();
      setNotice(
        application.status === "ready_for_review"
          ? "All required fields are resolved. The packet is ready for your review and manual submission."
          : "Answer saved. The remaining open fields are still shown below.",
      );
      return application;
    } catch (actionError) {
      setError(errorMessage(actionError));
      return null;
    } finally {
      setBusy(false);
    }
  }, [refresh, service]);

  const eventsFor = useCallback((applicationId: string): readonly ApplicationEvent[] => {
    return service.listEvents(applicationId);
  }, [service]);

  const importProfile = useCallback(async (file: File): Promise<boolean> => {
    setError(null);
    setNotice(null);
    try {
      const parsed = parseCandidateProfile(JSON.parse(await file.text()));
      saveCandidateProfile(parsed);
      setProfile(parsed);
      setNotice("Private profile loaded into this browser. Existing applications were not rewritten.");
      return true;
    } catch (profileError) {
      setError(errorMessage(profileError));
      return false;
    }
  }, []);

  const useExampleProfile = useCallback(() => {
    clearCandidateProfile();
    setProfile(exampleCandidateProfile);
    setNotice("The clearly labelled example profile is active. Replace it before using a real application.");
    setError(null);
  }, []);

  return {
    applications,
    profile,
    busy,
    error,
    notice,
    prepare,
    resolveField,
    eventsFor,
    importProfile,
    useExampleProfile,
    refresh,
  };
}
