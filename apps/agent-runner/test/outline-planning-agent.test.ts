import { describe, expect, it, vi } from "vitest";
import { intakeSource } from "@mindmark/shared";
import { OutlinePlanningAgent } from "../src/outline-planning-agent.js";
import type {
  OutlinePlanningSourceV2,
  SavedProjectOutlineDraftV2,
  WorkflowJobRepositoryV2,
  WorkflowJobV2,
} from "../src/types-v2.js";
import { ScriptedModel } from "./fakes.js";

const projectId = `0x${"61".repeat(32)}` as const;
const ownerAddress = `0x${"ab".repeat(20)}` as const;
const jobId = "123e4567-e89b-42d3-a456-426614174000";

class InMemoryWorkflowRepository implements WorkflowJobRepositoryV2 {
  readonly source;
  job: WorkflowJobV2 = {
    jobId,
    projectId,
    kind: "PLAN_OUTLINE",
    chapterId: null,
    workUnitId: null,
    status: "QUEUED",
    attempt: 0,
    input: {},
    lastError: null,
  };
  saved: SavedProjectOutlineDraftV2 | null = null;
  completed: Record<string, unknown> | null = null;
  retried: string | null = null;
  failSave = false;

  constructor(pages = [{
    pageNumber: 1,
    text: "# 调用原理\n\n外部调用会把执行控制权交给未知代码，必须在交互之前完成状态更新。",
  }]) {
    this.source = intakeSource(pages);
  }

  async recoverStaleWorkflowJobs() { return 0; }

  async claimNextWorkflowJob(): Promise<WorkflowJobV2 | null> {
    if (this.job.status !== "QUEUED") return null;
    this.job = { ...this.job, status: "RUNNING", attempt: 1 };
    return structuredClone(this.job);
  }

  async completeWorkflowJob(_jobId: string, output: Record<string, unknown>) {
    this.job = { ...this.job, status: "SUCCEEDED" };
    this.completed = structuredClone(output);
  }

  async retryWorkflowJob(_jobId: string, message: string) {
    this.job = { ...this.job, status: "RETRYABLE", lastError: message };
    this.retried = message;
  }

  async loadOutlinePlanningSource(): Promise<OutlinePlanningSourceV2> {
    return {
      projectId,
      ownerAddress,
      goal: "理解调用顺序",
      sourceHash: this.source.sourceHash,
      headVersion: null,
      sourceBlocks: this.source.blocks,
    };
  }

  async saveProjectOutlineDraft(input: SavedProjectOutlineDraftV2) {
    if (this.failSave) throw new Error("database unavailable");
    this.saved = structuredClone(input);
    return 1;
  }
}

describe("OutlinePlanningAgent", () => {
  it("turns a PLAN_OUTLINE job into a versioned Draft without exposing source text to the queue", async () => {
    const repository = new InMemoryWorkflowRepository();
    const agent = new OutlinePlanningAgent(repository, new ScriptedModel([
      { id: "read", name: "read_source_outline", arguments: {} },
      {
        id: "propose",
        name: "propose_chapters",
        arguments: {
          chapters: [{ title: "调用原理", summary: "理解控制权变化", startBlock: 0, endBlock: 1, importance: 5 }],
          excludedRanges: [],
        },
      },
    ]));

    await expect(agent.runNext()).resolves.toBe(true);

    expect(repository.job.status).toBe("SUCCEEDED");
    expect(repository.saved).toMatchObject({
      projectId,
      ownerAddress,
      expectedHeadVersion: null,
      plannerVersion: "semantic-relevance-v6",
    });
    expect(repository.saved?.chapters[0]).toMatchObject({
      item_id: "chapter-0",
      min_card_count: 3,
    });
    expect(repository.saved?.exclusions).toEqual([]);
    expect(repository.completed).toMatchObject({ outlineVersion: 1, chapterCount: 1 });
    expect(JSON.stringify(repository.job.input)).not.toContain("外部调用");
  });

  it("uses a deterministic outline when the model fails validation", async () => {
    const repository = new InMemoryWorkflowRepository();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const agent = new OutlinePlanningAgent(repository, new ScriptedModel([
      { id: "invalid", name: "unknown_tool", arguments: {} },
    ]));

    await agent.runNext();
    warn.mockRestore();

    expect(repository.job.status).toBe("SUCCEEDED");
    expect(repository.saved?.plannerVersion).toBe("relevance-deterministic-v6");
  });

  it("keeps deterministic exam exclusions when the model omits them", async () => {
    const repository = new InMemoryWorkflowRepository([
      { pageNumber: 1, text: "# 2026 年考纲变化\n\n新增考点：外部调用。" },
      { pageNumber: 2, text: "# 调用原理\n\n外部调用会转移执行控制权。" },
    ]);
    const agent = new OutlinePlanningAgent(repository, new ScriptedModel([
      { id: "read", name: "read_source_outline", arguments: {} },
      {
        id: "propose",
        name: "propose_chapters",
        arguments: {
          chapters: [{ title: "调用原理", summary: "理解控制权变化", startBlock: 2, endBlock: 3, importance: 5 }],
          excludedRanges: [],
        },
      },
    ]));

    await agent.runNext();

    expect(repository.saved?.plannerVersion).toBe("semantic-relevance-v6");
    expect(repository.saved?.exclusions).toEqual([
      expect.objectContaining({ start_block: 0, end_block: 1, category: "EXAM_UPDATE" }),
    ]);
  });

  it("releases a job for retry when persisting its Draft fails", async () => {
    const repository = new InMemoryWorkflowRepository();
    repository.failSave = true;
    const agent = new OutlinePlanningAgent(repository, new ScriptedModel([
      { id: "read", name: "read_source_outline", arguments: {} },
      {
        id: "propose",
        name: "propose_chapters",
        arguments: {
          chapters: [{ title: "调用原理", summary: "理解控制权变化", startBlock: 0, endBlock: 1, importance: 5 }],
          excludedRanges: [],
        },
      },
    ]));

    await agent.runNext();

    expect(repository.job.status).toBe("RETRYABLE");
    expect(repository.retried).toContain("database unavailable");
  });
});
