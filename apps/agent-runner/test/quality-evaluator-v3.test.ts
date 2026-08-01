import { describe, expect, it } from "vitest";
import type { CardBlueprintSlot, SourceBlock, WorkerKnowledgeCardV2 } from "@mindmark/shared";
import type { AgentToolCall, ToolCallingModel } from "../src/runtime-types.js";
import {
  DeterministicCardQualityEvaluatorV3,
  ModelCardQualityEvaluatorV3,
  type CardQualityEvaluationContextV3,
} from "../src/quality-evaluator-v3.js";
import { hex } from "./fakes.js";

function fixture(): CardQualityEvaluationContextV3 {
  const evidenceBlocks: SourceBlock[] = [{
    blockIndex: 3,
    pageNumber: 2,
    kind: "paragraph",
    text: "外部调用会把执行控制权交给未知代码，因此必须在交互前完成关键状态更新。",
    blockHash: hex("3"),
    headingLevel: null,
  }];
  const slot: CardBlueprintSlot = {
    slotId: hex("4"),
    conceptId: hex("5"),
    type: "application",
    objective: "根据执行顺序判断重入防御是否正确",
    difficulty: 4,
    sourceBlockIndexes: [3],
    required: true,
  };
  const card: WorkerKnowledgeCardV2 = {
    id: hex("6"),
    cardHash: hex("7"),
    projectId: hex("8"),
    chapterId: 0,
    workUnitId: 0,
    type: "qa",
    question: "为什么关键状态必须在外部交互前更新？",
    answer: "因为外部调用会把控制权交给未知代码，调用前更新状态可避免旧状态被再次利用。",
    keyPoint: "先更新状态，再执行外部交互",
    source: { page: 2, quote: evidenceBlocks[0]!.text },
    tags: ["重入防御"],
    importance: 5,
    initialDifficulty: 4,
    workerProof: [],
  };
  return { conceptName: "检查-更新-交互", slot, card, evidenceBlocks };
}

class CapturingQualityModel implements ToolCallingModel {
  lastInput: Parameters<ToolCallingModel["nextTool"]>[0] | null = null;

  constructor(private readonly cardId: `0x${string}`) {}

  async nextTool(input: Parameters<ToolCallingModel["nextTool"]>[0]): Promise<AgentToolCall> {
    this.lastInput = input;
    return {
      id: "quality",
      name: "submit_card_quality_evaluation",
      arguments: {
        cardId: this.cardId,
        citationSufficient: true,
        factuality: 5,
        learningValue: 4,
        clarity: 4,
        completeness: 4,
        citationRelevance: 5,
        difficultyFit: 4,
        verdict: "ACCEPT",
        reasons: [],
      },
    };
  }
}

describe("V3 Card Quality Evaluator", () => {
  it("sends only one Slot, card and its evidence through a strict tool call", async () => {
    const input = fixture();
    const model = new CapturingQualityModel(input.card.id);
    const evaluator = new ModelCardQualityEvaluatorV3(model, { modelId: "quality-model" });

    await expect(evaluator.evaluate(input)).resolves.toMatchObject({
      cardId: input.card.id,
      citationSufficient: true,
      verdict: "ACCEPT",
    });

    const task = JSON.parse(model.lastInput!.task) as Record<string, unknown>;
    expect(task).toMatchObject({ conceptName: input.conceptName });
    expect(model.lastInput!.task).not.toContain("workerAddress");
    expect(model.lastInput!.task).not.toContain(input.card.projectId);
    expect(model.lastInput!.tools[0]?.parameters).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining(["citationSufficient", "factuality", "difficultyFit", "verdict"]),
    });
  });

  it("rejects an evaluation that refers to another candidate card", async () => {
    const input = fixture();
    const evaluator = new ModelCardQualityEvaluatorV3(
      new CapturingQualityModel(hex("9")),
      { modelId: "quality-model" },
    );

    await expect(evaluator.evaluate(input)).rejects.toThrow(/wrong cardId/u);
  });

  it("retries transient model gateway failures inside one card evaluation", async () => {
    const input = fixture();
    const successfulModel = new CapturingQualityModel(input.card.id);
    let calls = 0;
    const model: ToolCallingModel = {
      async nextTool(modelInput) {
        calls += 1;
        if (calls === 1) throw new Error("fetch failed");
        if (calls === 2) throw new Error("AI model request failed with status 503");
        return successfulModel.nextTool(modelInput);
      },
    };
    const evaluator = new ModelCardQualityEvaluatorV3(model, {
      modelId: "quality-model",
      retryDelaysMs: [0, 0],
    });

    await expect(evaluator.evaluate(input)).resolves.toMatchObject({
      cardId: input.card.id,
      verdict: "ACCEPT",
    });
    expect(calls).toBe(3);
  });

  it("requests deterministic repair when the quote is outside Slot evidence", async () => {
    const input = fixture();
    const evaluator = new DeterministicCardQualityEvaluatorV3();

    await expect(evaluator.evaluate({
      ...input,
      evidenceBlocks: [{ ...input.evidenceBlocks[0]!, text: "另一段完全不包含该引用的证据文本，长度足够但内容不相关。" }],
    })).resolves.toMatchObject({
      citationSufficient: false,
      citationRelevance: 1,
      verdict: "REPAIR",
    });
  });
});
