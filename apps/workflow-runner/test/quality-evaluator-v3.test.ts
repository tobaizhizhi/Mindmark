import { afterEach, describe, expect, it, vi } from "vitest";
import type { CardBlueprintSlot, SourceBlock, WorkerKnowledgeCardV2 } from "@mindmark/shared";
import {
  DeterministicCardQualityEvaluatorV3,
  RemoteCardQualityEvaluatorV3,
  type CardQualityEvaluationContextV3,
} from "../src/quality-evaluator-v3.js";
import { hex } from "./fakes.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

function qualityResponse(cardId: `0x${string}`) {
  return {
    evaluation: {
      cardId,
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
    model: "agent-runner:evaluation",
    prompt_version: "card-rubric-langgraph-v1",
  };
}

describe("V3 Card Quality Evaluator", () => {
  it("sends only one Slot, card and its evidence to Agent Runner", async () => {
    const input = fixture();
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(qualityResponse(input.card.id)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const evaluator = new RemoteCardQualityEvaluatorV3({
      baseUrl: "https://agents.example",
      internalToken: "test-internal-token",
    });

    await expect(evaluator.evaluate(input)).resolves.toMatchObject({
      cardId: input.card.id,
      citationSufficient: true,
      verdict: "ACCEPT",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://agents.example/v1/card-quality-evaluations");
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(request).toMatchObject({
      conceptName: input.conceptName,
      card: { cardId: input.card.id },
    });
    expect(JSON.stringify(request)).not.toContain("workerAddress");
    expect(JSON.stringify(request)).not.toContain(input.card.projectId);
  });

  it("rejects an evaluation that refers to another candidate card", async () => {
    const input = fixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(qualityResponse(hex("9"))), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    const evaluator = new RemoteCardQualityEvaluatorV3({
      baseUrl: "https://agents.example",
      internalToken: "test-internal-token",
    });

    await expect(evaluator.evaluate(input)).rejects.toThrow(/wrong cardId/u);
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
