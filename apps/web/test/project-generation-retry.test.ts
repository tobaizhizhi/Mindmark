import { describe, expect, it, vi } from "vitest";
import { retryProjectGenerationForOwner } from "@/lib/server/project-lifecycle/retry-generation";

const projectId = `0x${"ab".repeat(32)}` as const;
const owner = `0x${"cd".repeat(20)}` as const;

describe("Learning Project generation retry", () => {
  it("returns the number of atomically requeued Work Unit Jobs", async () => {
    const retry = vi.fn().mockResolvedValue({ jobCount: 4, error: null });
    await expect(retryProjectGenerationForOwner(projectId, owner, { retry }))
      .resolves.toEqual({ queuedJobs: 4 });
    expect(retry).toHaveBeenCalledWith(projectId, owner);
  });

  it("keeps a Project with active work from being queued twice", async () => {
    const retry = vi.fn().mockResolvedValue({
      jobCount: null,
      error: { message: "Learning Project generation already has active work" },
    });
    await expect(retryProjectGenerationForOwner(projectId, owner, { retry }))
      .rejects.toMatchObject({ status: 409, code: "generation_retry_in_progress" });
  });
});
