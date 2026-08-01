export type SerialTaskQueue = {
  enqueue: <T>(task: () => Promise<T>) => Promise<T>;
  onIdle: () => Promise<void>;
};

export const MAX_CARDS_PER_PERSISTED_REVIEW_SESSION = 15;

export function createPersistedReviewSessionIds(
  cardCount: number,
  createId: () => string,
): string[] {
  if (!Number.isInteger(cardCount) || cardCount < 0) {
    throw new RangeError("Review card count must be a non-negative integer");
  }
  return Array.from(
    { length: Math.ceil(cardCount / MAX_CARDS_PER_PERSISTED_REVIEW_SESSION) },
    createId,
  );
}

export function persistedReviewSessionIdForCard(
  sessionIds: readonly string[],
  cardIndex: number,
): string {
  const sessionId = sessionIds[Math.floor(cardIndex / MAX_CARDS_PER_PERSISTED_REVIEW_SESSION)];
  if (!sessionId) throw new RangeError("Review card index has no persisted Session segment");
  return sessionId;
}

export function createSerialTaskQueue(): SerialTaskQueue {
  let tail: Promise<void> = Promise.resolve();
  let firstError: unknown;

  return {
    enqueue<T>(task: () => Promise<T>) {
      const run = tail.then(task);
      tail = run.then(
        () => undefined,
        (error: unknown) => {
          firstError ??= error;
        },
      );
      return run;
    },
    async onIdle() {
      await tail;
      if (firstError !== undefined) throw firstError;
    },
  };
}
