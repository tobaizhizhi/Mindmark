import { describe, expect, it } from "vitest";
import { ApiError, jsonError } from "@/lib/server/http";
import { getWorkflowOperations, type OperationsStore } from "@/lib/server/operations";

const projectId = `0x${"71".repeat(32)}`;
const generatedAt = "2026-07-28T00:00:00.000Z";

class MemoryOperationsStore implements OperationsStore {
  async loadSnapshot() {
    return {
      generatedAt,
      metrics: {
        queuedJobs: 2,
        runningJobs: 1,
        retryableJobs: 0,
        failedJobs: 1,
        staleJobs: 0,
        succeededJobs: 8,
        pendingRewards: 1,
        blockedRewards: 0,
        retryableRewards: 0,
        failedProjects: 1,
      },
      alerts: [{
        severity: "critical",
        code: "FAILED_JOBS",
        count: 1,
        message: "工作流已达到重试上限，需要人工处理。",
      }],
      jobs: [{
        jobId: "123e4567-e89b-42d3-a456-426614174000",
        projectId,
        projectTitle: "重入安全",
        kind: "GENERATE_WORK_UNIT",
        status: "RUNNING",
        chapterId: 0,
        workUnitId: 0,
        attempt: 1,
        availableAt: generatedAt,
        leaseUntil: generatedAt,
        lastError: null,
        createdAt: generatedAt,
        startedAt: generatedAt,
        completedAt: null,
      }],
      events: [{
        eventId: 1,
        jobId: "123e4567-e89b-42d3-a456-426614174000",
        projectId,
        chapterId: 0,
        workUnitId: 0,
        eventType: "WORKFLOW_JOB_QUEUED",
        payload: { kind: "GENERATE_WORK_UNIT" },
        createdAt: generatedAt,
      }],
    };
  }
}

describe("Workflow operations", () => {
  it("returns a compact operational snapshot without source content", async () => {
    const snapshot = await getWorkflowOperations(new MemoryOperationsStore());

    expect(snapshot.metrics).toMatchObject({ queuedJobs: 2, failedProjects: 1 });
    expect(snapshot.alerts[0]).toMatchObject({ code: "FAILED_JOBS", count: 1 });
    expect(snapshot.jobs[0]).toMatchObject({ kind: "GENERATE_WORK_UNIT", workUnitId: 0 });
    expect(JSON.stringify(snapshot)).not.toContain("sourceText");
  });
});

describe("HTTP errors", () => {
  it("adds a stable request ID to client-visible errors", async () => {
    const requestId = "123e4567-e89b-42d3-a456-426614174000";
    const response = jsonError(new ApiError(403, "operator_access_required", "Access denied"), requestId);

    expect(response.status).toBe(403);
    expect(response.headers.get("x-request-id")).toBe(requestId);
    await expect(response.json()).resolves.toEqual({
      error: { code: "operator_access_required", message: "Access denied", requestId },
    });
  });
});
