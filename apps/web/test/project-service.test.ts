import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  confirmProjectOutlineForOwner,
  getProjectSummaryForOwner,
  getProjectOutlinePlanningOperationForOwner,
  intakeProjectForOwner,
  listChaptersForOwner,
  listProjectsForOwner,
  requestProjectOutlinePlanningForOwner,
  type ChapterSummaryStore,
  type ProjectConfirmationStore,
  type ProjectOutlineOperationStore,
  type ProjectSourceStore,
  type ProjectSummaryStore,
} from "@/lib/server/projects";
import { intakeSource, planChaptersDeterministically } from "@mindmark/shared";

const projectId = `0x${"71".repeat(32)}` as Hex;
const owner = `0x${"ab".repeat(20)}` as `0x${string}`;

class RecordingSourceStore implements ProjectSourceStore {
  project: Record<string, unknown> | undefined;
  sourceBlocks: Record<string, unknown>[] = [];

  async registerSource(
    project: Record<string, unknown>,
    sourceBlocks: Record<string, unknown>[],
  ): Promise<Hex> {
    this.project = project;
    this.sourceBlocks = sourceBlocks;
    return project.project_id as Hex;
  }
}

describe("V2 Project intake", () => {
  it("registers private Source Blocks idempotently without creating learner-facing Chapters", async () => {
    const store = new RecordingSourceStore();
    const response = await intakeProjectForOwner(
      {
        clientRequestId: "intake-1",
        title: "重入安全",
        goal: "理解调用顺序",
        sourceFilename: "reentrancy.md",
        sourceMimeType: "text/markdown",
        folderId: "123e4567-e89b-42d3-a456-426614174000",
        pages: [
          {
            pageNumber: 1,
            text: "第1章 调用原理\n\n外部调用会转移控制权。",
          },
          {
            pageNumber: 2,
            text: "第2章 防御方式\n\n先更新状态，再执行交互。",
          },
        ],
      },
      owner,
      store,
      projectId,
    );

    expect(store.project).toMatchObject({
      project_id: projectId,
      owner_address: owner,
      folder_id: "123e4567-e89b-42d3-a456-426614174000",
    });
    expect(store.sourceBlocks.length).toBeGreaterThan(2);
    expect(store.sourceBlocks[0]).toHaveProperty("heading_level", 1);
    expect(response.status).toBe("UPLOADED");
    expect(JSON.stringify(response)).not.toContain("外部调用会转移控制权");
    expect(JSON.stringify(response)).not.toContain("block_hash");
  });
});

const draftSource = intakeSource([
  { pageNumber: 1, text: "第一章 原理\n\n外部调用会把执行控制权交给被调用合约。" },
  { pageNumber: 2, text: "第二章 防御\n\n状态应在外部交互之前完成更新并保持一致。" },
]);
const initialOutline = planChaptersDeterministically(projectId, draftSource.blocks);

function sourceRows() {
  return draftSource.blocks.map((block) => ({
    block_index: block.blockIndex,
    page_number: block.pageNumber,
    kind: block.kind,
    text: block.text,
    block_hash: block.blockHash,
    heading_level: block.headingLevel,
  }));
}

class RecordingOutlineOperationStore implements ProjectOutlineOperationStore {
  enqueued: Array<{ projectId: Hex; owner: `0x${string}` }> = [];
  readonly operationId = "123e4567-e89b-42d3-a456-426614174000";

  async enqueue(id: Hex, address: `0x${string}`) {
    this.enqueued.push({ projectId: id, owner: address });
    return this.operationId;
  }

  async get(id: Hex, address: `0x${string}`, operationId?: string) {
    if (id !== projectId || address !== owner || (operationId && operationId !== this.operationId)) return null;
    return {
      operationId: this.operationId,
      projectId,
      status: "QUEUED" as const,
      attempt: 0,
      lastError: null,
    };
  }
}

describe("V2 Project Outline operations", () => {
  it("only enqueues planning from Web and returns compact operation status", async () => {
    const store = new RecordingOutlineOperationStore();
    await expect(requestProjectOutlinePlanningForOwner(projectId, owner, store)).resolves.toMatchObject({
      projectId,
      status: "QUEUED",
    });
    expect(store.enqueued).toEqual([{ projectId, owner }]);
    await expect(
      getProjectOutlinePlanningOperationForOwner(projectId, owner, store.operationId, store),
    ).resolves.toMatchObject({ operationId: store.operationId, attempt: 0 });
  });
});

class RecordingConfirmationStore implements ProjectConfirmationStore {
  confirmed: Parameters<ProjectConfirmationStore["confirmOutlineDesign"]>[0] | null = null;

  constructor(
    private readonly accessible = true,
    private readonly status = "OUTLINE_READY",
  ) {}

  async loadDraft(id: Hex, address: `0x${string}`) {
    if (!this.accessible || id !== projectId || address !== owner) return null;
    return {
      project: {
        project_id: projectId,
        owner_address: owner,
        title: "重入安全",
        goal: "理解调用顺序",
        source_hash: draftSource.sourceHash,
        goal_hash: `0x${"42".repeat(32)}` as Hex,
        outline_version: 1,
        outline_hash: initialOutline.outlineHash,
        status: this.status,
      },
      chapters: initialOutline.chapters.map((chapter) => ({
        chapter_id: chapter.chapterId,
        position: chapter.position,
        title: chapter.title,
        summary: chapter.summary,
        start_block: chapter.startBlock,
        end_block: chapter.endBlock,
        page_start: chapter.pageStart,
        page_end: chapter.pageEnd,
        source_hash: chapter.sourceHash,
        importance: chapter.importance,
        min_card_count: 3,
        target_card_count: 4,
        max_card_count: 6,
      })),
      sourceBlocks: sourceRows(),
    };
  }

  async saveDraft(input: Parameters<ProjectConfirmationStore["saveDraft"]>[0]) {
    return input.expectedHeadVersion! + 1;
  }

  async confirmOutlineDesign(input: Parameters<ProjectConfirmationStore["confirmOutlineDesign"]>[0]) {
    this.confirmed = structuredClone(input);
  }
}

describe("V3 outline confirmation", () => {
  it("persists the final learner-edited Chapter snapshot before asynchronous design", async () => {
    const store = new RecordingConfirmationStore();
    const draft = await store.loadDraft(projectId, owner);
    const lastBlock = draft!.sourceBlocks.length - 1;
    const result = await confirmProjectOutlineForOwner(
      projectId,
      owner,
      [
        { title: "原理", summary: "理解控制权转移", startBlock: 0, endBlock: 1, importance: 5 },
        { title: "防御", summary: "理解状态更新顺序", startBlock: 2, endBlock: lastBlock, importance: 5 },
      ],
      store,
    );

    expect(result.status).toBe("DESIGNING_CARDS");
    expect(result.chapterCount).toBe(2);
    expect(store.confirmed?.chapters[0]).toMatchObject({ chapter_id: 0, start_block: 0, end_block: 1 });
    expect(JSON.stringify(result)).not.toContain("source_text");
  });

  it("rejects gaps, overlaps and a draft owned by another wallet", async () => {
    const store = new RecordingConfirmationStore();
    const gap = [
      { title: "一", summary: "第一部分", startBlock: 0, endBlock: 0, importance: 3 },
      { title: "二", summary: "第二部分", startBlock: 2, endBlock: 3, importance: 3 },
    ];
    await expect(confirmProjectOutlineForOwner(projectId, owner, gap, store)).rejects.toThrow();

    const overlap = [
      { title: "一", summary: "第一部分", startBlock: 0, endBlock: 2, importance: 3 },
      { title: "二", summary: "第二部分", startBlock: 2, endBlock: 3, importance: 3 },
    ];
    await expect(confirmProjectOutlineForOwner(projectId, owner, overlap, store)).rejects.toThrow();
    await expect(
      confirmProjectOutlineForOwner(projectId, owner, gap, new RecordingConfirmationStore(false)),
    ).rejects.toMatchObject({ status: 404, code: "outline_not_found" });
  });
});

describe("V2 summary queries", () => {
  it("normalizes compact Project summaries without card content or FSRS state", async () => {
    const store: ProjectSummaryStore = {
      async listOwned() {
        return [
          {
            project_id: projectId,
            title: "重入安全",
            goal: "理解调用顺序",
            status: "GENERATING",
            registry_version: 2,
            chapter_count: "2",
            ready_chapter_count: "1",
            card_count: "8",
            due_count: "3",
            updated_at: "2026-07-25T08:00:00.000Z",
          },
        ];
      },
    };

    await expect(listProjectsForOwner(owner, store)).resolves.toEqual({
      projects: [
        {
          projectId,
          title: "重入安全",
          goal: "理解调用顺序",
          status: "GENERATING",
          registryVersion: 2,
          chapterCount: 2,
          readyChapterCount: 1,
          cardCount: 8,
          dueCount: 3,
          updatedAt: "2026-07-25T08:00:00.000Z",
        },
      ],
    });
    await expect(getProjectSummaryForOwner(projectId, owner, store)).resolves.toMatchObject({
      projectId,
      chapterCount: 2,
      cardCount: 8,
    });
  });

  it("loads Chapter Progress only after a Project is selected", async () => {
    const store: ChapterSummaryStore = {
      async listOwned(_owner, selectedProjectId) {
        expect(selectedProjectId).toBe(projectId);
        return [
          {
            project_id: projectId,
            chapter_id: 0,
            position: 0,
            title: "调用原理",
            summary: "理解外部调用的控制权变化。",
            page_start: 1,
            page_end: 2,
            importance: 4,
            status: "READY",
            card_count: "8",
            studied_count: "5",
            due_count: "2",
            new_count: "3",
            mastered_count: "2",
            last_reviewed_at: "2026-07-25T08:00:00.000Z",
            progress_percent: "62.5",
          },
        ];
      },
    };

    const response = await listChaptersForOwner(projectId, owner, store);
    expect(response.chapters[0]).toMatchObject({
      chapterId: 0,
      cardCount: 8,
      studiedCount: 5,
      dueCount: 2,
      progressPercent: 62.5,
    });
    expect(JSON.stringify(response)).not.toContain("question");
    expect(JSON.stringify(response)).not.toContain("fsrs");
  });
});
