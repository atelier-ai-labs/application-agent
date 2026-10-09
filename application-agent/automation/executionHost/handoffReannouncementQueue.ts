export interface HandoffReannouncementQueue {
  enqueue(origin: string, reannounce: (origin: string) => Promise<void>): void;
  invalidate(): void;
  flush(): Promise<void>;
}

/** Serializes recovery posts and drops queued links superseded by a newer tunnel origin. */
export function createHandoffReannouncementQueue(): HandoffReannouncementQueue {
  let generation = 0;
  let queue = Promise.resolve();

  return {
    enqueue(origin, reannounce) {
      const currentGeneration = ++generation;
      queue = queue.then(async () => {
        if (currentGeneration !== generation) return;
        await reannounce(origin);
      }).catch(() => undefined);
    },
    invalidate() {
      generation += 1;
    },
    flush() {
      return queue;
    },
  };
}
