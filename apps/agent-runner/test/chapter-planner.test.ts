import { describe, expect, it } from "vitest";
import { intakeSource } from "@mindmark/shared";
import { AiChapterPlanner, DeterministicChapterPlanner } from "../src/chapter-planner.js";
import { ScriptedModel } from "./fakes.js";

const projectId = `0x${"51".repeat(32)}` as `0x${string}`;

describe("Chapter Planner adapters", () => {
  it("falls back deterministically when no model is available", async () => {
    const source = intakeSource([{ pageNumber: 1, text: "第1章 原理\n\n调用会转移控制权。\n\n第2章 防御\n\n先更新状态。" }]);
    const proposal = await new DeterministicChapterPlanner().plan({ projectId, blocks: source.blocks });
    expect(proposal.chapters).toHaveLength(2);
    expect(proposal.chapters[0]?.startBlock).toBe(0);
    expect(proposal.chapters.at(-1)?.endBlock).toBe(source.blocks.length - 1);
    expect(proposal.excludedRanges).toEqual([]);
  });

  it("keeps the AI Adapter limited to learner-facing proposals", async () => {
    const source = intakeSource([{ pageNumber: 1, text: "第一章\n\n原理说明。\n\n第二章\n\n防御说明。" }]);
    const planner = new AiChapterPlanner(
      new ScriptedModel([
        { id: "read", name: "read_source_outline", arguments: {} },
        {
          id: "propose",
          name: "propose_chapters",
          arguments: {
            chapters: [
              { title: "原理", summary: "理解原理", startBlock: 0, endBlock: 1, importance: 4 },
              { title: "防御", summary: "理解防御", startBlock: 2, endBlock: 3, importance: 4 },
            ],
            excludedRanges: [],
          },
        },
      ]),
    );
    const proposal = await planner.plan({ projectId, blocks: source.blocks });
    expect(proposal.chapters[0]).toEqual({ title: "原理", summary: "理解原理", startBlock: 0, endBlock: 1, importance: 4 });
    expect(JSON.stringify(proposal)).not.toContain("hash");
  });

  it("rejects an over-segmented AI outline and accepts a budgeted retry", async () => {
    const text = Array.from(
      { length: 12 },
      (_, index) => `第${index + 1}章 主题${index + 1}\n\n主题${index + 1}包含一个需要理解的核心概念。`,
    ).join("\n\n");
    const source = intakeSource([{ pageNumber: 1, text }]);
    const overSegmented = Array.from({ length: 12 }, (_, index) => ({
      title: `主题${index + 1}`,
      summary: `理解主题${index + 1}`,
      startBlock: index * 2,
      endBlock: index * 2 + 1,
      importance: 3,
    }));
    const model = new ScriptedModel([
      { id: "read", name: "read_source_outline", arguments: {} },
      {
        id: "too-many",
        name: "propose_chapters",
        arguments: { chapters: overSegmented, excludedRanges: [] },
      },
      {
        id: "retry",
        name: "propose_chapters",
        arguments: {
          chapters: [
            { title: "基础主题", summary: "理解前半部分主题", startBlock: 0, endBlock: 11, importance: 3 },
            { title: "进阶主题", summary: "理解后半部分主题", startBlock: 12, endBlock: 23, importance: 3 },
          ],
          excludedRanges: [],
        },
      },
    ]);

    const proposal = await new AiChapterPlanner(model).plan({ projectId, blocks: source.blocks });

    expect(model.calls).toBe(3);
    expect(proposal.chapters).toHaveLength(2);
  });

  it("rejects English Chapter text for Chinese learning material", async () => {
    const source = intakeSource([{
      pageNumber: 1,
      text: "# 调度原理\n\n调度器需要平衡公平性和实时截止时间。\n\n# 进程通信\n\n信号用于进程间异步通知。",
    }]);
    const model = new ScriptedModel([
      { id: "read", name: "read_source_outline", arguments: {} },
      {
        id: "english",
        name: "propose_chapters",
        arguments: {
          chapters: [{
            title: "CPU Scheduling and Process Communication",
            summary: "Learn scheduling fairness and asynchronous process signals.",
            startBlock: 0,
            endBlock: source.blocks.length - 1,
            importance: 4,
          }],
          excludedRanges: [],
        },
      },
      {
        id: "chinese",
        name: "propose_chapters",
        arguments: {
          chapters: [{
            title: "处理器调度与进程通信",
            summary: "理解调度公平性和进程异步通知机制。",
            startBlock: 0,
            endBlock: source.blocks.length - 1,
            importance: 4,
          }],
          excludedRanges: [],
        },
      },
    ]);

    const proposal = await new AiChapterPlanner(model).plan({
      projectId,
      blocks: source.blocks,
      goal: "理解操作系统的调度和通信机制",
    });

    expect(model.calls).toBe(3);
    expect(proposal.chapters[0]?.title).toBe("处理器调度与进程通信");
  });
});
