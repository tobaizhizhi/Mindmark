import { describe, expect, it } from "vitest";
import { createLatestRequestGate } from "@/lib/client/latest-request";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("createLatestRequestGate", () => {
  it("does not let an older failure overwrite a newer success", async () => {
    const gate = createLatestRequestGate();
    const older = deferred<void>();
    const newer = deferred<void>();
    const visibleStates: string[] = [];

    async function run(promise: Promise<void>, successState: string) {
      const request = gate.begin();
      try {
        await promise;
        request.commit(() => visibleStates.push(successState));
      } catch {
        request.commit(() => visibleStates.push("Editable Learning Project source was not found"));
      }
    }

    const olderRun = run(older.promise, "older success");
    const newerRun = run(newer.promise, "outline ready");
    newer.resolve();
    await newerRun;
    older.reject(new Error("stale source lookup"));
    await olderRun;

    expect(visibleStates).toEqual(["outline ready"]);
  });

  it("invalidates an in-flight request when the source is reset", () => {
    const gate = createLatestRequestGate();
    const request = gate.begin();
    const visibleStates: string[] = [];

    gate.invalidate();

    expect(request.commit(() => visibleStates.push("stale result"))).toBe(false);
    expect(visibleStates).toEqual([]);
  });
});
