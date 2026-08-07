import { describe, expect, it } from "vitest";
import { projectProgressFromState } from "@/lib/server/project-lifecycle/progress";

const projectId = `0x${"34".repeat(32)}` as const;
const updatedAt = "2026-08-03T00:00:00.000Z";

describe("Learner Project Progress", () => {
  it("distinguishes an active retry from a workflow that needs action", () => {
    const retrying = projectProgressFromState({
      project: { projectId, status: "FAILED_RETRYABLE", updatedAt },
      chapters: [{ chapterId: 0, title: "变量", status: "FAILED_RETRYABLE" }],
      latestJob: {
        jobId: "00000000-0000-4000-8000-000000000001",
        kind: "GENERATE_WORK_UNIT",
        chapterId: 0,
        status: "RETRYABLE",
        attempt: 2,
        lastError: "provider timeout",
      },
    });
    const actionRequired = projectProgressFromState({
      project: { projectId, status: "FAILED_RETRYABLE", updatedAt },
      chapters: [{ chapterId: 0, title: "变量", status: "FAILED_RETRYABLE" }],
      latestJob: {
        jobId: "00000000-0000-4000-8000-000000000002",
        kind: "GENERATE_WORK_UNIT",
        chapterId: 0,
        status: "FAILED",
        attempt: 3,
        lastError: "retry budget exhausted",
      },
    });
    expect(retrying).toMatchObject({ stage: "GENERATING_CARDS", retrying: true, currentChapter: { title: "变量" } });
    expect(actionRequired).toMatchObject({ stage: "ACTION_REQUIRED", retrying: false, code: "workflow_action_required" });
  });

  it("stops showing card generation when a generation job exhausted retries before the Project status changed", () => {
    const progress = projectProgressFromState({
      project: { projectId, status: "GENERATING", updatedAt },
      chapters: [{ chapterId: 0, title: "实时调度", status: "GENERATING" }],
      latestJob: {
        jobId: "00000000-0000-4000-8000-000000000006",
        kind: "GENERATE_WORK_UNIT",
        chapterId: 0,
        status: "FAILED",
        attempt: 10,
        lastError: "retry budget exhausted",
      },
    });

    expect(progress).toMatchObject({
      stage: "ACTION_REQUIRED",
      retrying: false,
      code: "workflow_action_required",
    });
  });

  it("advances Chapter design progress from completed design runs", () => {
    const progress = projectProgressFromState({
      project: { projectId, status: "DESIGNING_CARDS", updatedAt },
      chapters: [
        { chapterId: 0, title: "变量", status: "DRAFT" },
        { chapterId: 1, title: "函数", status: "DRAFT" },
      ],
      designRuns: [
        { chapterId: 0, status: "COMPLETED" },
        { chapterId: 1, status: "RUNNING" },
      ],
      latestJob: {
        jobId: "00000000-0000-4000-8000-000000000003",
        kind: "DESIGN_CHAPTER",
        chapterId: 1,
        status: "RUNNING",
        attempt: 1,
        lastError: null,
      },
    });
    expect(progress).toMatchObject({
      stage: "DESIGNING_CARDS",
      progressPercent: 30,
      retrying: false,
      currentChapter: { chapterId: 1, title: "函数" },
    });
  });

  it("keeps Reward processing out of learner-facing progress", () => {
    const progress = projectProgressFromState({
      project: { projectId, status: "GENERATING", updatedAt },
      chapters: [{ chapterId: 0, title: "变量", status: "GENERATING" }],
      latestJob: {
        jobId: "00000000-0000-4000-8000-000000000004",
        kind: "SETTLE_WORK_UNIT_REWARD",
        chapterId: 0,
        status: "RETRYABLE",
        attempt: 3,
        lastError: "treasury unavailable",
      },
    });
    expect(progress).toMatchObject({
      stage: "GENERATING_CARDS",
      retrying: false,
      operationId: null,
    });
  });

  it("keeps an Outline retry in the source analysis stage", () => {
    const progress = projectProgressFromState({
      project: { projectId, status: "FAILED_RETRYABLE", updatedAt },
      chapters: [],
      latestJob: {
        jobId: "00000000-0000-4000-8000-000000000005",
        kind: "PLAN_OUTLINE",
        chapterId: null,
        status: "RETRYABLE",
        attempt: 2,
        lastError: "model timeout",
      },
    });
    expect(progress).toMatchObject({ stage: "ANALYZING_SOURCE", retrying: true });
  });

  it("keeps progress monotonic through generation, quality and readiness", () => {
    const stages = [
      ["GENERATING", "GENERATING"],
      ["GENERATING", "QUALITY_CHECK"],
      ["GENERATING", "ASSEMBLING"],
      ["READY", "READY"],
    ] as const;
    const percentages = stages.map(([projectStatus, chapterStatus]) => projectProgressFromState({
      project: { projectId, status: projectStatus, updatedAt },
      chapters: [{ chapterId: 0, title: "函数", status: chapterStatus }],
      latestJob: null,
    }).progressPercent);
    expect(percentages).toEqual([55, 79, 91, 100]);
  });
});
