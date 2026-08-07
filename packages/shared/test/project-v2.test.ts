import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  chapterLeafV2,
  deriveCardIdV2,
  hashChapterSourceV2,
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
  analyzeChapterStructure,
  materializeChapterOutline,
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
      "基础概念",
      "防御模式",
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
      "原理",
      "防御",
    ]);
    expect(outline.chapters[0]?.endBlock).toBe(5);
    expect(outline.chapters[1]?.startBlock).toBe(6);
  });

  it("excludes an implicit contents page and groups numbered topic sequences", () => {
    const detail = "这是需要理解的知识内容，包含概念、机制、约束与应用条件。".repeat(80);
    const topics = [
      "1. 公平原则的调度算法",
      "2. 实时调度算法",
      "1. 多处理机操作系统",
      "2. 多处理机操作系统的进程调度",
      "1. 伙伴算法",
      "2. 页框回收算法",
      "1. 信号",
      "2. 进程间通信",
    ];
    const source = intakeSource([
      { pageNumber: 1, text: topics.join("\n\n") },
      ...topics.map((topic, index) => ({
        pageNumber: index + 2,
        text: `${topic}\n\n${detail}`,
      })),
    ]);

    const outline = planChaptersDeterministically(projectId, source.blocks);
    const analysis = analyzeChapterStructure(source.blocks, outline.excludedRanges);

    expect(outline.excludedRanges).toEqual([
      expect.objectContaining({
        startBlock: 0,
        endBlock: topics.length - 1,
        category: "TABLE_OF_CONTENTS",
      }),
    ]);
    expect(analysis.naturalGroups.map((group) => group.headingTitles)).toEqual([
      ["公平原则的调度算法", "实时调度算法"],
      ["多处理机操作系统", "多处理机操作系统的进程调度"],
      ["伙伴算法", "页框回收算法"],
      ["信号", "进程间通信"],
    ]);
    expect(outline.chapters.map((chapter) => chapter.title)).toEqual([
      "公平原则与实时调度算法",
      "多处理机操作系统与进程调度",
      "伙伴与页框回收算法",
      "信号与进程间通信",
    ]);

    const excluded = new Set(
      outline.excludedRanges.flatMap((range) =>
        Array.from({ length: range.endBlock - range.startBlock + 1 }, (_, offset) => range.startBlock + offset),
      ),
    );
    const covered = new Map<number, number>();
    for (const chapter of outline.chapters) {
      for (let blockIndex = chapter.startBlock; blockIndex <= chapter.endBlock; blockIndex += 1) {
        covered.set(blockIndex, (covered.get(blockIndex) ?? 0) + 1);
      }
    }
    expect(source.blocks.every((block) =>
      excluded.has(block.blockIndex) || covered.get(block.blockIndex) === 1,
    )).toBe(true);
  });

  it("infers parenthesized numbered headings as subsections", () => {
    const source = intakeSource([{
      pageNumber: 1,
      text: [
        "1. 调度算法",
        "",
        "调度算法决定处理器分配顺序。",
        "",
        "1）评价指标",
        "",
        "评价指标包括公平性、响应时间和吞吐量。",
        "",
        "2. 实时调度",
        "",
        "实时调度需要满足任务截止时间。",
      ].join("\n"),
    }]);

    const analysis = analyzeChapterStructure(source.blocks, []);

    expect(analysis.headings.map((heading) => ({
      title: heading.title,
      inferredLevel: heading.inferredLevel,
    }))).toEqual([
      { title: "调度算法", inferredLevel: 1 },
      { title: "评价指标", inferredLevel: 2 },
      { title: "实时调度", inferredLevel: 1 },
    ]);
    expect(analysis.naturalGroups).toHaveLength(1);
    expect(analysis.naturalGroups[0]?.headingTitles).toEqual(["调度算法", "实时调度"]);
  });

  it("keeps numbered worked-example branches inside their learning topic", () => {
    const source = intakeSource([{
      pageNumber: 1,
      text: [
        "1. 实时调度算法",
        "",
        "实时调度需要满足任务截止时间。",
        "",
        "1. 假定任务 A 具有较高的优先级",
        "",
        "任务 B 会错过截止时间。",
        "",
        "2. 假定任务 B 具有较高的优先级",
        "",
        "任务 A 会错过截止时间。",
        "",
        "3. 采用 EDF 算法",
        "",
        "按照截止时间排序可以满足约束。",
        "",
        "1. 多处理机操作系统",
        "",
        "多处理机操作系统协调多个处理器。",
      ].join("\n"),
    }]);

    const analysis = analyzeChapterStructure(source.blocks, []);

    expect(analysis.headings.filter((heading) => /假定|采用/u.test(heading.title)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ title: "假定任务 A 具有较高的优先级", inferredLevel: 2 }),
        expect.objectContaining({ title: "采用 EDF 算法", inferredLevel: 2 }),
      ]));
    expect(analysis.naturalGroups.map((group) => group.headingTitles)).toEqual([
      ["实时调度算法"],
      ["多处理机操作系统"],
    ]);
  });

  it("does not turn a wrapped arithmetic example into a Chapter title", () => {
    const source = intakeSource([{
      pageNumber: 1,
      text: [
        "3 ）最低松弛度优先算法",
        "",
        "松弛度用于衡量实时任务距离截止时间还剩多少缓冲。",
        "",
        "50 − 5 − 30 ）。 此 时应抢占处理机给 A 运行。",
        "",
        "1. 多处理机操作系统",
        "",
        "多处理机操作系统负责协调多个处理器。",
      ].join("\n"),
    }]);

    const arithmeticExample = source.blocks.find((block) => block.text.startsWith("50 − 5"));
    expect(arithmeticExample?.kind).toBe("paragraph");
    const bareNumberedHeading = intakeSource([{
      pageNumber: 1,
      text: "1 多处理机操作系统\n\n多处理机操作系统负责协调多个处理器。",
    }]);
    expect(bareNumberedHeading.blocks[0]?.kind).toBe("heading");

    const outline = planChaptersDeterministically(projectId, source.blocks);
    expect(outline.chapters.map((chapter) => chapter.title)).toEqual([
      "最低松弛度优先算法",
      "多处理机操作系统",
    ]);
  });

  it("rejects sentence-like arithmetic titles proposed by AI", () => {
    const source = intakeSource([{
      pageNumber: 1,
      text: "# 最低松弛度优先算法\n\n松弛度越低，实时任务的调度优先级越高。",
    }]);

    expect(() => materializeChapterOutline(projectId, source.blocks, [{
      title: "50 − 5 − 30 ）。 此 时应抢占处理机给 A 运行。",
      summary: "说明最低松弛度优先算法。",
      startBlock: 0,
      endBlock: source.blocks.length - 1,
      importance: 4,
    }])).toThrow(/Chapter title/u);
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
      "调度原理",
      "内存管理",
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
      "代理合约",
      "重入防御",
    ]);
    expect(learningText).not.toContain("考纲变化");
    expect(learningText).not.toContain("考试日期");
  });

  it("keeps exam change notices using 改动 out of learning Chapters", () => {
    const source = intakeSource([
      {
        pageNumber: 1,
        text: "# 2026 年考纲改动\n\n新增知识点：外部调用。",
      },
      {
        pageNumber: 2,
        text: "# 外部调用\n\n外部调用会转移执行控制权，调用者需要考虑重入风险。",
      },
    ]);

    const outline = planChaptersDeterministically(projectId, source.blocks);
    expect(outline.excludedRanges).toEqual([
      expect.objectContaining({ startBlock: 0, endBlock: 1, category: "EXAM_UPDATE" }),
    ]);
    expect(outline.chapters.map((chapter) => chapter.title)).toEqual(["外部调用"]);
  });

  it("rejects an AI Chapter that wraps learning content in an exam-update boundary", () => {
    const source = intakeSource([
      { pageNumber: 1, text: "# 2026 年考纲改动\n\n新增知识点：外部调用。" },
      { pageNumber: 2, text: "# 外部调用\n\n外部调用会转移执行控制权。" },
    ]);
    const exclusions = planChaptersDeterministically(projectId, source.blocks).excludedRanges;

    expect(() => validateChapterOutline([{
      chapterId: 0,
      position: 0,
      title: "2026 年考纲改动",
      summary: "本章介绍考纲改动和外部调用。",
      startBlock: 0,
      endBlock: source.blocks.length - 1,
      pageStart: 1,
      pageEnd: 2,
      sourceHash: hashChapterSourceV2(source.blocks),
      importance: 3,
    }], source.blocks, exclusions)).toThrow(/learning Source Block boundaries/u);
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
