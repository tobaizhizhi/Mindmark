import { describe, expect, it } from "vitest";
import {
  createPersistedReviewSessionIds,
  createSerialTaskQueue,
  persistedReviewSessionIdForCard,
} from "@/lib/client/serial-task-queue";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("createSerialTaskQueue", () => {
  it("starts the next review write only after the previous write settles", async () => {
    const queue = createSerialTaskQueue();
    const first = deferred<void>();
    const order: string[] = [];

    const firstRun = queue.enqueue(async () => {
      order.push("first-start");
      await first.promise;
      order.push("first-end");
    });
    const secondRun = queue.enqueue(async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    first.resolve();
    await Promise.all([firstRun, secondRun, queue.onIdle()]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("reports a failed background review write when the session waits for idle", async () => {
    const queue = createSerialTaskQueue();
    const failure = new Error("review write failed");

    await expect(queue.enqueue(async () => { throw failure; })).rejects.toBe(failure);
    await expect(queue.onIdle()).rejects.toBe(failure);
  });
});

describe("persisted review Session segments", () => {
  it("keeps one visible review round while splitting database Sessions every 15 cards", () => {
    let sequence = 0;
    const sessionIds = createPersistedReviewSessionIds(31, () => `session-${++sequence}`);

    expect(sessionIds).toEqual(["session-1", "session-2", "session-3"]);
    expect(persistedReviewSessionIdForCard(sessionIds, 0)).toBe("session-1");
    expect(persistedReviewSessionIdForCard(sessionIds, 14)).toBe("session-1");
    expect(persistedReviewSessionIdForCard(sessionIds, 15)).toBe("session-2");
    expect(persistedReviewSessionIdForCard(sessionIds, 30)).toBe("session-3");
  });
});
