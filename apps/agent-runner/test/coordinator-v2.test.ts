import { describe, expect, it } from "vitest";
import { ProjectCoordinatorV2 } from "../src/coordinator-v2.js";

describe("ProjectCoordinatorV2", () => {
  it("retries transient Registry wallet checks before starting", async () => {
    let checks = 0;
    const coordinator = new ProjectCoordinatorV2(
      {
        assertConfiguredWallets: async () => {
          checks += 1;
          if (checks < 3) throw new Error("Monad RPC request timed out");
        },
      },
      {
        recoverStaleJobs: async () => 0,
        runNextDetailed: async () => null,
        runNextGenerationForWorker: async () => null,
      } as never,
      { pollIntervalMs: 1_000, startupRetryDelayMs: 0 },
    );

    await coordinator.start();

    expect(checks).toBe(3);
    coordinator.stop();
  });

  it("keeps polling after an empty initial queue scan", async () => {
    const coordinator = new ProjectCoordinatorV2(
      { assertConfiguredWallets: async () => undefined },
      {
        recoverStaleJobs: async () => 0,
        runNextDetailed: async () => null,
        runNextGenerationForWorker: async () => null,
      } as never,
      { pollIntervalMs: 1_000 },
    );

    await coordinator.start();
    const pollTimer = (coordinator as unknown as { pollTimer: NodeJS.Timeout | null }).pollTimer;

    expect(pollTimer?.hasRef()).toBe(true);
    coordinator.stop();
  });

  it("dispatches one generation job per worker concurrently", async () => {
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const coordinator = new ProjectCoordinatorV2(
      { assertConfiguredWallets: async () => undefined },
      {
        recoverStaleJobs: async () => 0,
        runNextDetailed: async () => null,
        runNextGenerationForWorker: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await gate;
          active -= 1;
          return "GENERATE_WORK_UNIT";
        },
      },
      { maxWorkflowJobsPerRun: 3 },
    );

    const run = coordinator.runOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(peak).toBe(3);
    release();
    await expect(run).resolves.toMatchObject({ processedWorkflowJobs: 3, errors: [] });
  });
});
