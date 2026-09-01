import type { Application, ApplicationEvent } from "../domain/types";
import { isApplication, isApplicationEvent, isRecord } from "../domain/validation";
import { browserStorage, type KeyValueStorage } from "./storage";

export const APPLICATIONS_STORAGE_KEY = "atelier.application-agent.applications.v0";
export const EVENTS_STORAGE_KEY = "atelier.application-agent.events.v0";

export interface ApplicationRepository {
  listApplications(): readonly Application[];
  getApplication(id: string): Application | null;
  saveApplication(application: Application): void;
  listEvents(applicationId: string): readonly ApplicationEvent[];
  appendEvent(event: ApplicationEvent): void;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function loadArray(storage: KeyValueStorage, key: string): unknown[] {
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export class InMemoryApplicationRepository implements ApplicationRepository {
  private applications: Application[] = [];
  private events: ApplicationEvent[] = [];

  listApplications(): readonly Application[] {
    return this.applications.map(clone);
  }

  getApplication(id: string): Application | null {
    const application = this.applications.find((candidate) => candidate.id === id);
    return application ? clone(application) : null;
  }

  saveApplication(application: Application): void {
    const index = this.applications.findIndex((candidate) => candidate.id === application.id);
    if (index === -1) {
      this.applications.push(clone(application));
    } else {
      this.applications[index] = clone(application);
    }
  }

  listEvents(applicationId: string): readonly ApplicationEvent[] {
    return this.events
      .filter((event) => event.applicationId === applicationId)
      .map(clone);
  }

  appendEvent(event: ApplicationEvent): void {
    this.events.push(clone(event));
  }
}

export class LocalStorageApplicationRepository implements ApplicationRepository {
  constructor(private readonly storage: KeyValueStorage) {}

  listApplications(): readonly Application[] {
    return loadArray(this.storage, APPLICATIONS_STORAGE_KEY).filter(isApplication);
  }

  getApplication(id: string): Application | null {
    return this.listApplications().find((application) => application.id === id) ?? null;
  }

  saveApplication(application: Application): void {
    const applications = [...this.listApplications()];
    const index = applications.findIndex((candidate) => candidate.id === application.id);
    if (index === -1) {
      applications.push(clone(application));
    } else {
      applications[index] = clone(application);
    }
    this.storage.setItem(APPLICATIONS_STORAGE_KEY, JSON.stringify(applications));
  }

  listEvents(applicationId: string): readonly ApplicationEvent[] {
    return loadArray(this.storage, EVENTS_STORAGE_KEY).filter(isApplicationEvent).filter(
      (event) => event.applicationId === applicationId,
    );
  }

  appendEvent(event: ApplicationEvent): void {
    const events = [...loadArray(this.storage, EVENTS_STORAGE_KEY).filter(isApplicationEvent), clone(event)];
    this.storage.setItem(EVENTS_STORAGE_KEY, JSON.stringify(events));
  }
}

let defaultRepository: ApplicationRepository | null = null;

export function getDefaultApplicationRepository(): ApplicationRepository {
  if (!defaultRepository) {
    const storage = browserStorage();
    defaultRepository = storage
      ? new LocalStorageApplicationRepository(storage)
      : new InMemoryApplicationRepository();
  }
  return defaultRepository;
}

export function resetDefaultApplicationRepository(): void {
  defaultRepository = null;
}

export function clearRepositoryStorage(storage: KeyValueStorage): void {
  storage.removeItem(APPLICATIONS_STORAGE_KEY);
  storage.removeItem(EVENTS_STORAGE_KEY);
}

export function isPersistedApplicationEnvelope(value: unknown): value is { applications: unknown[]; events: unknown[] } {
  return (
    isRecord(value) &&
    Array.isArray(value.applications) &&
    Array.isArray(value.events)
  );
}
