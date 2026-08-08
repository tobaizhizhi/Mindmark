import { describe, expect, it } from "vitest";
import type { LearnerProjectProgress } from "@mindmark/shared/learning-project";
import {
  shouldPollProjectProgress,
  shouldRefreshWorkspaceResources,
} from "@/features/learning-workspace/project-progress-policy";

const progress = (stage: LearnerProjectProgress["stage"], retrying = false) => ({
  projectId: `0x${"12".repeat(32)}`,
  stage,
  progressPercent: 20,
  currentChapter: null,
  completedChapters: 0,
  totalChapters: 1,
  phaseCounts: {
    generation: { completed: 0, total: 1 },
    qualityCheck: { completed: 0, total: 1 },
    automaticRepair: { completed: 0, total: 0, active: 0 },
    assembly: { completed: 0, total: 1 },
    completion: { completed: 0, total: 1 },
  },
  retrying,
  updatedAt: "2026-08-03T00:00:00.000Z",
  operationId: null,
  code: null,
}) satisfies LearnerProjectProgress;

describe("Learner Project progress polling", () => {
  it("polls only automatic work and active retries", () => {
    expect(shouldPollProjectProgress(progress("DESIGNING_CARDS"))).toBe(true);
    expect(shouldPollProjectProgress(progress("CHECKING_QUALITY"))).toBe(true);
    expect(shouldPollProjectProgress(progress("REPAIRING_CARDS"))).toBe(true);
    expect(shouldPollProjectProgress(progress("ASSEMBLING_CHAPTERS"))).toBe(true);
    expect(shouldPollProjectProgress(progress("ACTION_REQUIRED"))).toBe(false);
    expect(shouldPollProjectProgress(progress("OUTLINE_READY"))).toBe(false);
    expect(shouldPollProjectProgress(progress("AWAITING_MONAD"))).toBe(false);
    expect(shouldPollProjectProgress(progress("ACTION_REQUIRED", true))).toBe(true);
  });

  it("refreshes heavy workspace data only at meaningful lifecycle transitions", () => {
    const current = progress("GENERATING_CARDS");
    expect(shouldRefreshWorkspaceResources(current, { ...current, progressPercent: 61 })).toBe(false);
    expect(shouldRefreshWorkspaceResources(current, { ...current, completedChapters: 1 })).toBe(true);
    expect(shouldRefreshWorkspaceResources(current, { ...current, stage: "READY" })).toBe(true);
  });
});
