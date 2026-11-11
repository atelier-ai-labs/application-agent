export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /**
   * Read the current value, change it and write it back as one atomic step
   * that no other process can interleave with. Optional: storages without it
   * fall back to getItem + setItem.
   */
  updateItem?(key: string, change: (current: string | null) => string): void;
}

function parseStoredArray(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Change one stored JSON list atomically when the storage supports it. Two
 * processes saving different records of the same list (the Slack listener and
 * a restart command, 2026-11-10) can no longer write back each other's stale
 * copy.
 */
export function updateStoredArray(storage: KeyValueStorage, key: string, change: (items: unknown[]) => unknown[]): void {
  const write = (raw: string | null) => JSON.stringify(change(parseStoredArray(raw)));
  if (storage.updateItem) storage.updateItem(key, write);
  else storage.setItem(key, write(storage.getItem(key)));
}

export function browserStorage(): KeyValueStorage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
