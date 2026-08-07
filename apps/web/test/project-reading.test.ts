import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import {
  getChapterReadingForOwner,
  type ProjectReadingStore,
} from "@/lib/server/project-reading";

const projectId = `0x${"61".repeat(32)}` as Hex;
const owner = `0x${"ab".repeat(20)}` as `0x${string}`;
const cardId = `0x${"71".repeat(32)}` as Hex;

class UploadReadingStore implements ProjectReadingStore {
  async loadOwnedChapter(id: Hex, chapterId: number, address: `0x${string}`) {
    if (id !== projectId || chapterId !== 0 || address !== owner) return null;
    return {
      project_id: projectId,
      project_kind: "UPLOAD" as const,
      pack_version_id: null,
      title: "CPU 原理",
      chapter_id: 0,
      chapter_title: "指令执行",
      start_block: 4,
      end_block: 6,
      page_start: 2,
      page_end: 3,
      pack_chapter_id: null,
    };
  }

  async loadUploadBlocks() {
    return [
      { block_index: 4, page_number: 2, kind: "heading" as const, text: "指令周期" },
      { block_index: 5, page_number: 2, kind: "paragraph" as const, text: "CPU 依次完成取指、译码与执行，并在每一步更新内部状态。" },
      { block_index: 6, page_number: 3, kind: "code" as const, text: "fetch -> decode -> execute" },
    ];
  }

  async loadPackBlocks() {
    return [];
  }

  async loadCards() {
    return [{
      card_id: cardId,
      content: {
        type: "qa",
        question: "CPU 的基本指令周期是什么？",
        answer: "取指、译码、执行。",
        keyPoint: "三阶段按顺序推进。",
        source: { page: 2, quote: "CPU 依次完成取指、译码与执行，并在每一步更新内部状态。" },
        tags: ["cpu"],
        importance: 5,
        initialDifficulty: 2,
      },
    }];
  }
}

describe("Chapter reading", () => {
  it("returns only the owned Chapter range and resolves exact card citations", async () => {
    const result = await getChapterReadingForOwner(projectId, 0, owner, new UploadReadingStore());
    expect(result).toMatchObject({
      origin: "UPLOAD_SOURCE",
      pageStart: 2,
      pageEnd: 3,
      blocks: [
        { blockId: "source-block-4", position: 0 },
        { blockId: "source-block-5", position: 1 },
        { blockId: "source-block-6", position: 2 },
      ],
      cardLinks: [{ cardId, blockId: "source-block-5", match: "QUOTE" }],
    });
  });

  it("falls back to the first block on the cited page without claiming an exact match", async () => {
    const store = new UploadReadingStore();
    store.loadCards = async () => [{
      card_id: cardId,
      content: {
        type: "qa",
        question: "引用在哪里？",
        answer: "第二页。",
        keyPoint: "只有页码可以确定。",
        source: { page: 2, quote: "这一段旧引用已经无法与保存的 Source Block 完整匹配。" },
        tags: ["cpu"], importance: 3, initialDifficulty: 2,
      },
    }];
    const result = await getChapterReadingForOwner(projectId, 0, owner, store);
    expect(result.cardLinks).toEqual([{ cardId, blockId: "source-block-4", match: "PAGE_FALLBACK" }]);
  });

  it("recovers legacy redacted Source Blocks from the stored original PDF", async () => {
    const base = new UploadReadingStore();
    const store: ProjectReadingStore = {
      loadOwnedChapter: (id, chapterId, address) => base.loadOwnedChapter(id, chapterId, address),
      loadUploadBlocks: async () => [
        { block_index: 4, page_number: 2, kind: "heading", text: null },
        { block_index: 5, page_number: 2, kind: "paragraph", text: null },
        { block_index: 6, page_number: 3, kind: "code", text: null },
      ],
      loadUploadPages: async (id, pageStart, pageEnd) => {
        expect({ id, pageStart, pageEnd }).toEqual({ id: projectId, pageStart: 2, pageEnd: 3 });
        return [
          { pageNumber: 2, text: "CPU 依次完成取指、译码与执行。" },
          { pageNumber: 3, text: "fetch -> decode -> execute" },
        ];
      },
      loadPackBlocks: () => base.loadPackBlocks(),
      loadCards: () => base.loadCards(),
    };

    const result = await getChapterReadingForOwner(projectId, 0, owner, store);

    expect(result.blocks).toEqual([
      {
        blockId: "source-page-2",
        position: 0,
        kind: "paragraph",
        text: "CPU 依次完成取指、译码与执行。",
        pageNumber: 2,
        language: null,
      },
      {
        blockId: "source-page-3",
        position: 1,
        kind: "paragraph",
        text: "fetch -> decode -> execute",
        pageNumber: 3,
        language: null,
      },
    ]);
  });

  it("uses saved source quotations when a legacy Project has no stored PDF", async () => {
    const base = new UploadReadingStore();
    const store: ProjectReadingStore = {
      loadOwnedChapter: (id, chapterId, address) => base.loadOwnedChapter(id, chapterId, address),
      loadUploadBlocks: async () => [
        { block_index: 4, page_number: 2, kind: "heading", text: null },
        { block_index: 5, page_number: 2, kind: "paragraph", text: null },
      ],
      loadPackBlocks: () => base.loadPackBlocks(),
      loadCards: () => base.loadCards(),
    };

    const result = await getChapterReadingForOwner(projectId, 0, owner, store);

    expect(result.blocks).toEqual([expect.objectContaining({
      blockId: "source-card-0",
      text: "CPU 依次完成取指、译码与执行，并在每一步更新内部状态。",
      pageNumber: 2,
    })]);
    expect(result.cardLinks).toEqual([{ cardId, blockId: "source-card-0", match: "QUOTE" }]);
  });

  it("does not reveal another owner's Chapter", async () => {
    await expect(getChapterReadingForOwner(
      projectId,
      0,
      `0x${"cd".repeat(20)}`,
      new UploadReadingStore(),
    )).rejects.toMatchObject({ status: 404, code: "chapter_not_found" });
  });

  it("returns authored Pack blocks and explicit installed-card anchors", async () => {
    const store: ProjectReadingStore = {
      loadOwnedChapter: async (id, chapterId, address) => {
      if (id !== projectId || chapterId !== 0 || address !== owner) return null;
      return {
        project_id: projectId,
        project_kind: "PACK" as const,
        pack_version_id: "7ce6a2a6-7782-4b63-96dc-2331be64d4c7",
        title: "Solidity 101",
        chapter_id: 0,
        chapter_title: "合约外壳",
        start_block: null,
        end_block: null,
        page_start: null,
        page_end: null,
        pack_chapter_id: 0,
      };
      },
      loadUploadBlocks: async () => [],
      loadPackBlocks: async () => [
        { block_id: "contract-shell-title", position: 0, kind: "heading" as const, text: "合约外壳", language: null },
        { block_id: "contract-shell-concepts", position: 1, kind: "paragraph" as const, text: "pragma 与 contract", language: null },
      ],
      loadCards: async () => [{
        card_id: cardId,
        content: {
          type: "concept",
          question: "合约外壳包含什么？",
          answer: "pragma、contract 与状态变量。",
          keyPoint: "先建立最小可部署结构。",
          source: { kind: "pack_reference", label: "Solidity 官方文档" },
          tags: ["solidity"],
          importance: 5,
          initialDifficulty: 2,
          readingBlockId: "contract-shell-concepts",
        },
      }],
    };
    const result = await getChapterReadingForOwner(projectId, 0, owner, store);
    expect(result).toMatchObject({
      origin: "PACK_LESSON",
      blocks: [{ blockId: "contract-shell-title" }, { blockId: "contract-shell-concepts" }],
      cardLinks: [{ cardId, blockId: "contract-shell-concepts", match: "EXPLICIT" }],
    });
  });
});
