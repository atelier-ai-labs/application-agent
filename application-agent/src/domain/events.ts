import type { ApplicationEvent, ApplicationEventType } from "./types";

export interface EventRuntime {
  now: () => string;
  createId: (prefix: string) => string;
}

export function createApplicationEvent(
  applicationId: string,
  type: ApplicationEventType,
  runtime: EventRuntime,
  metadata?: Readonly<Record<string, string>>,
): ApplicationEvent {
  return {
    id: runtime.createId("event"),
    applicationId,
    type,
    occurredAt: runtime.now(),
    ...(metadata ? { metadata } : {}),
  };
}
