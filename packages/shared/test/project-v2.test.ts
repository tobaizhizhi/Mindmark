import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  chapterLeafV2,
  deriveCardIdV2,
  hashTitleV2,
  outlineLeafV2,
  workUnitLeafV2,
} from "../src/hash-v2.js";
import { buildOutlineCommitmentV2, verifyMerkleProof } from "../src/merkle-v2.js";
import {
  ChapterStudyResponseSchema,
  MAX_SOURCE_BLOCK_CHARACTERS,
  ProjectStudyResponseSchema,
} from "../src/project-v2.js";
import { intakeSource } from "../src/source-intake.js";
import {
  planChaptersDeterministically,
  validateChapterOutline,
} from "../src/chapter-planning.js";
import { filterExcludedSourceBlocks } from "../src/source-relevance.js";
import { planWorkUnits } from "../src/work-planning.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const projectId = `0x${"42".repeat(32)}` as Hex;

describe("Uncapped live review queues", () => {
  const cardIds = Array.from({ length: 24 }, (_, index) =>
    `0x${(index + 1).toString(16).padStart(64, "0")}` as Hex);

  it("accepts every Chapter card and Project card in a live queue", () => {
    expect(ChapterStudyResponseSchema.parse({
      projectId,
      chapterId: 0,
      status: "READY",
      cards: [],
      queue: cardIds,
      dueCount: 0,
      newCount: cardIds.length,
    }).queue).toHaveLength(24);

    expect(ProjectStudyResponseSchema.parse({
      projectId,
      status: "READY",
      readyChapterCount: 1,
      queue: cardIds.map((id, position) => ({
        id,
        position,
        chapterId: 0,
        chapterPosition: 0,
        chapterTitle: "基础",
        ...{
          type: "qa" as const,
          question: `问题 ${position}`,
          answer: `答案 ${position}`,
          keyPoint: `关键点 ${position}`,
          source: { page: 1, quote: `这是第 ${position} 张知识卡对应的足够长来源引用内容。` },
          tags: ["基础"],
          importance: 3,
          initialDifficulty: 3,
        },
        state: "NEW" as const,
        dueAt: null,
        reps: 0,
        lapses: 0,
      })),
      dueCount: 0,
      newCount: cardIds.length,
    }).queue).toHaveLength(24);
  });

});

describe("V2 Source Intake and Chapter Planning", () => {
  it("creates stable, ordered Source Blocks without losing code or page provenance", () => {
    const pages = [
      {
        pageNumber: 1,
        text: "# 第一章 调用顺序\n\n外部调用会转移控制权。状态应先更新。\n\n```solidity\ncall();\n```",
      },
      {
        pageNumber: 2,
        text: `第2章 防御\n\n${"检查、更新、交互。".repeat(700)}`,
      },
    ];
    const first = intakeSource(pages);
    const second = intakeSource(structuredClone(pages));

    expect(first).toEqual(second);
    expect(first.blocks.map((block) => block.blockIndex)).toEqual(
      first.blocks.map((_, index) => index),
    );
    expect(first.blocks.some((block) => block.kind === "heading")).toBe(true);
    expect(first.blocks.some((block) => block.kind === "code")).toBe(true);
    expect(first.blocks.every((block) => block.text.length <= MAX_SOURCE_BLOCK_CHARACTERS)).toBe(
      true,
    );
    expect(new Set(first.blocks.map((block) => block.blockHash)).size).toBe(first.blocks.length);
  });

  it("builds a complete Chapter outline and keeps execution terms out of titles", () => {
    const source = intakeSource([
      {
        pageNumber: 1,
        text: "第1章 基础概念\n\n重入发生在外部调用把控制权交给未知代码时。",
      },
      {
        pageNumber: 2,
        text: "第2章 防御模式\n\nChecks-Effects-Interactions 先更新状态，再执行外部交互。",
      },
    ]);
    const outline = planChaptersDeterministically(projectId, source.blocks);

    expect(outline.chapters).toHaveLength(2);
    expect(outline.chapters.map((chapter) => chapter.title)).toEqual([
      "第1章 基础概念",
      "第2章 防御模式",
    ]);
    expect(outline.chapters[0]?.startBlock).toBe(0);
    expect(outline.chapters.at(-1)?.endBlock).toBe(source.blocks.length - 1);
    expect(outline.chapters.every((chapter) => !chapter.title.includes("分段"))).toBe(true);

    const commitment = buildOutlineCommitmentV2(projectId, outline.chapters);
    expect(commitment.root).toBe(outline.outlineHash);
    for (const chapter of commitment.chapters) {
      expect(verifyMerkleProof(commitment.root, chapter.leaf, chapter.proof)).toBe(true);
    }
  });

  it("keeps subsection headings inside their top-level Chapters", () => {
    const source = intakeSource([
      {
        pageNumber: 1,
        text: "# 第一章 原理\n\n总论内容。\n\n## 1.1 调用\n\n调用内容。\n\n## 1.2 状态\n\n状态内容。",
      },
      {
        pageNumber: 2,
        text: "# 第二章 防御\n\n防御总论。\n\n## 2.1 检查\n\n检查内容。",
      },
    ]);

    const outline = planChaptersDeterministically(projectId, source.blocks);

    expect(outline.chapters.map((chapter) => chapter.title)).toEqual([
      "第一章 原理",
      "第二章 防御",
    ]);
    expect(outline.chapters[0]?.endBlock).toBe(5);
    expect(outline.chapters[1]?.startBlock).toBe(6);
  });

  it("merges many shallow headings when the learning material is short", () => {
    const text = Array.from(
      { length: 12 },
      (_, index) => `第${index + 1}章 主题${index + 1}\n\n主题${index + 1}包含一个需要理解的核心概念。`,
    ).join("\n\n");
    const source = intakeSource([{ pageNumber: 1, text }]);

    const outline = planChaptersDeterministically(projectId, source.blocks);

    expect(outline.chapters.length).toBeLessThanOrEqual(2);
    expect(outline.chapters[0]?.startBlock).toBe(0);
    expect(outline.chapters.at(-1)?.endBlock).toBe(source.blocks.length - 1);
  });

  it("rejects gaps and source commitments that do not match Chapter ranges", () => {
    const source = intakeSource([
      { pageNumber: 1, text: "第一段。\n\n第二段。\n\n第三段。" },
    ]);
    const outline = planChaptersDeterministically(projectId, source.blocks);
    expect(() =>
      validateChapterOutline(
        [{ ...outline.chapters[0]!, sourceHash: `0x${"00".repeat(32)}` }],
        source.blocks,
      ),
    ).toThrow(/sourceHash/u);
  });

  it("accounts for repeated watermarks and promotional text without turning them into Chapters", () => {
    const watermark = "一大颗牛奶糖 一大颗牛奶糖 一大颗牛奶糖";
    const source = intakeSource([
      {
        pageNumber: 1,
        text: `${watermark}\n\n# 第一章 调度原理\n\n调度器根据任务优先级和截止时间选择任务。`,
      },
      {
        pageNumber: 2,
        text: `${watermark}\n\n调度算法需要兼顾公平性、吞吐量与响应时间。`,
      },
      {
        pageNumber: 3,
        text: `${watermark}\n\n# 第二章 内存管理\n\n伙伴算法通过拆分与合并内存块控制碎片。\n\n26 版预计 10 月底上线。\n\n相邻空闲伙伴块满足条件时可以合并。`,
      },
    ]);

    const outline = planChaptersDeterministically(projectId, source.blocks);
    const learningBlocks = filterExcludedSourceBlocks(source.blocks, outline.excludedRanges);

    expect(outline.excludedRanges.map((range) => range.category)).toContain("REPEATED_HEADER_FOOTER");
    expect(outline.excludedRanges.map((range) => range.category)).toContain("VERSION_NOTICE");
    expect(outline.chapters.map((chapter) => chapter.title)).toEqual([
      "第一章 调度原理",
      "第二章 内存管理",
    ]);
    expect(learningBlocks.map((block) => block.text).join("\n")).not.toContain("一大颗牛奶糖");
    expect(learningBlocks.map((block) => block.text).join("\n")).not.toContain("10 月底上线");
    expect(learningBlocks.map((block) => block.text).join("\n")).toContain("相邻空闲伙伴块");
    expect(() => validateChapterOutline(outline.chapters, source.blocks, outline.excludedRanges)).not.toThrow();
  });

  it("keeps exam updates and schedule notices out of learning Chapters", () => {
    const source = intakeSource([
      {
        pageNumber: 1,
        text: "# 2026 年考纲变化\n\n新增考点：代理合约。\n\n删除考点：旧版编译器语法。",
      },
      {
        pageNumber: 2,
        text: "# 第一章 代理合约\n\n代理合约通过 delegatecall 在调用者的存储上下文中执行逻辑。",
      },
      {
        pageNumber: 3,
        text: "# 考试安排\n\n报名时间为 9 月 1 日，考试日期为 11 月 20 日。",
      },
      {
        pageNumber: 4,
        text: "# 第二章 重入防御\n\nChecks-Effects-Interactions 要求先更新状态，再执行外部调用。",
      },
    ]);

    const outline = planChaptersDeterministically(projectId, source.blocks);
    const learningText = filterExcludedSourceBlocks(source.blocks, outline.excludedRanges)
      .map((block) => block.text)
      .join("\n");

    expect(outline.excludedRanges.map((range) => range.category)).toContain("EXAM_UPDATE");
    expect(outline.excludedRanges.map((range) => range.category)).toContain("SCHEDULE_NOTICE");
    expect(outline.chapters.map((chapter) => chapter.title)).toEqual([
      "第一章 代理合约",
      "第二章 重入防御",
    ]);
    expect(learningText).not.toContain("考纲变化");
    expect(learningText).not.toContain("考试日期");
  });

  it("separates a metadata notice line from the learning paragraph that follows it", () => {
    const source = intakeSource([{
      pageNumber: 1,
      text: "最新考纲变化：新增重入攻击。\n重入攻击发生在外部调用重新进入原合约时。",
    }]);

    expect(source.blocks.map((block) => block.text)).toEqual([
      "最新考纲变化：新增重入攻击。",
      "重入攻击发生在外部调用重新进入原合约时。",
    ]);
  });

  it("rejects a source that contains only non-learning notices", () => {
    const source = intakeSource([{
      pageNumber: 1,
      text: "# 2026 年考纲变化\n\n新增考点：代理合约。\n\n报名时间为 9 月 1 日。",
    }]);

    expect(() => planChaptersDeterministically(projectId, source.blocks)).toThrow(
      /did not contain learning content/u,
    );
  });
});

describe("V2 Work Planning", () => {
  it("splits large Chapters into bounded Work Units that never cross Chapter ranges", () => {
    const pages = Array.from({ length: 8 }, (_, index) => ({
      pageNumber: index + 1,
      text: `${index === 0 ? "第1章 原理\n\n" : index === 4 ? "第2章 实践\n\n" : ""}${
        "可验证的知识说明。".repeat(280)
      }`,
    }));
    const source = intakeSource(pages);
    const outline = planChaptersDeterministically(projectId, source.blocks);
    const plan = planWorkUnits(projectId, outline.chapters, source.blocks);

    expect(plan.workUnits.length).toBeGreaterThan(outline.chapters.length);
    expect(plan.workUnits.map((unit) => unit.workUnitId)).toEqual(
      plan.workUnits.map((_, index) => index),
    );
    for (const workUnit of plan.workUnits) {
      const chapter = outline.chapters[workUnit.chapterId]!;
      expect(workUnit.startBlock).toBeGreaterThanOrEqual(chapter.startBlock);
      expect(workUnit.endBlock).toBeLessThanOrEqual(chapter.endBlock);
      expect(workUnit.sourceBlocks.every((block) => block.blockIndex >= chapter.startBlock)).toBe(
        true,
      );
      expect(
        verifyMerkleProof(
          plan.workUnitManifestRoot,
          workUnitLeafV2(
            projectId,
            workUnit.chapterId,
            workUnit.workUnitId,
            workUnit.sourceUnitHash,
          ),
          workUnit.manifestProof,
        ),
      ).toBe(true);
    }
  });
});

describe("V2 golden hash vectors", () => {
  it("matches domain-separated TypeScript vectors intended for Foundry reuse", async () => {
    const vector = JSON.parse(
      await readFile(path.join(root, "fixtures/hash-vectors-v2.json"), "utf8"),
    ) as {
      projectId: Hex;
      chapterId: number;
      workUnitId: number;
      title: string;
      titleHash: Hex;
      sourceHash: Hex;
      sourceUnitHash: Hex;
      cardHash: Hex;
      cardsRoot: Hex;
      cardCount: number;
      outlineLeaf: Hex;
      workUnitLeaf: Hex;
      cardId: Hex;
      chapterLeaf: Hex;
    };

    expect(hashTitleV2(vector.title)).toBe(vector.titleHash);
    expect(
      outlineLeafV2(vector.projectId, vector.chapterId, vector.titleHash, vector.sourceHash),
    ).toBe(vector.outlineLeaf);
    expect(
      workUnitLeafV2(
        vector.projectId,
        vector.chapterId,
        vector.workUnitId,
        vector.sourceUnitHash,
      ),
    ).toBe(vector.workUnitLeaf);
    expect(
      deriveCardIdV2(vector.projectId, vector.chapterId, vector.workUnitId, vector.cardHash),
    ).toBe(vector.cardId);
    expect(
      chapterLeafV2(vector.projectId, vector.chapterId, vector.cardsRoot, vector.cardCount),
    ).toBe(vector.chapterLeaf);
  });
});
