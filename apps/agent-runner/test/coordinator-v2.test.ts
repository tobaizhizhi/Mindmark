import { describe, expect, it } from "vitest";
import { ProjectCoordinatorV2 } from "../src/coordinator-v2.js";

describe("ProjectCoordinatorV2", () => {
  it("keeps polling after an empty initial queue scan", async () => {
    const coordinator = new ProjectCoordinatorV2(
      { assertConfiguredWallets: async () => undefined },
      { runNext: async () => false } as never,
      {
        recoverStaleJobs: async () => 0,
        runNext: async () => false,
      } as never,
      { pollIntervalMs: 1_000 },
    );

    await coordinator.start();
    const pollTimer = (coordinator as unknown as { pollTimer: NodeJS.Timeout | null }).pollTimer;

    expect(pollTimer?.hasRef()).toBe(true);
    coordinator.stop();
  });
});
