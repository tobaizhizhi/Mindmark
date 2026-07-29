import { describe, expect, it } from "vitest";
import { intakeSource } from "@mindmark/shared";
import { AiChapterPlanner, DeterministicChapterPlanner } from "../src/chapter-planner.js";
import { ScriptedModel } from "./fakes.js";

const projectId = `0x${"51".repeat(32)}` as `0x${string}`;

describe("Chapter Planner adapters", () => {
  it("falls back deterministically when no model is available", async () => {
    const source = intakeSource([{ pageNumber: 1, text: "第1章 原理\n\n调用会转移控制权。\n\n第2章 防御\n\n先更新状态。" }]);
    const chapters = await new DeterministicChapterPlanner().plan({ projectId, blocks: source.blocks });
    expect(chapters).toHaveLength(2);
    expect(chapters[0]?.startBlock).toBe(0);
    expect(chapters.at(-1)?.endBlock).toBe(source.blocks.length - 1);
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
          },
        },
      ]),
    );
    const proposals = await planner.plan({ projectId, blocks: source.blocks });
    expect(proposals[0]).toEqual({ title: "原理", summary: "理解原理", startBlock: 0, endBlock: 1, importance: 4 });
    expect(JSON.stringify(proposals)).not.toContain("hash");
  });
});
