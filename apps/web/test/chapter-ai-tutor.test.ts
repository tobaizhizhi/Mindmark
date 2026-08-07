import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AskChapterTutorRequest,
  AskChapterTutorResponse,
  ChapterReadingResponse,
} from "@mindmark/shared";
import type { Hex } from "viem";
import {
  askChapterTutorForOwner,
  buildChapterTutorContext,
  extractPartialJsonStringProperty,
  OpenAICompatibleChapterTutorModel,
  streamChapterTutorForOwner,
  type ChapterTutorModel,
} from "@/lib/server/chapter-ai-tutor";

const projectId = `0x${"41".repeat(32)}` as Hex;
const owner = `0x${"ab".repeat(20)}` as `0x${string}`;

const reading: ChapterReadingResponse = {
  projectId,
  chapterId: 0,
  origin: "UPLOAD_SOURCE",
  title: "CPU 调度算法",
  pageStart: 10,
  pageEnd: 12,
  blocks: [
    { blockId: "source-block-1", position: 0, kind: "heading", text: "时间片轮转", pageNumber: 10, language: null },
    { blockId: "source-block-2", position: 1, kind: "paragraph", text: "时间片过小会导致频繁上下文切换，从而增加系统开销。", pageNumber: 11, language: null },
    { blockId: "source-block-3", position: 2, kind: "paragraph", text: "时间片过大时，算法会逐渐退化为先来先服务。", pageNumber: 12, language: null },
  ],
  cardLinks: [],
};

class RecordingTutorModel implements ChapterTutorModel {
  input: Parameters<ChapterTutorModel["answer"]>[0] | null = null;

  async answer(input: Parameters<ChapterTutorModel["answer"]>[0]): Promise<AskChapterTutorResponse> {
    this.input = input;
    return {
      answer: "因为上下文切换本身需要保存和恢复处理机状态。",
      citations: [
        { blockId: "source-block-2", pageNumber: 99, quote: "模型伪造的引用" },
        { blockId: "missing-block", pageNumber: 11, quote: "不存在的块" },
      ],
      suggestedQuestions: ["时间片过大会怎样？"],
    };
  }
}

class StreamingTutorModel implements ChapterTutorModel {
  async answer(): Promise<AskChapterTutorResponse> {
    return {
      answer: "完整回答",
      citations: [],
      suggestedQuestions: [],
    };
  }

  async *streamAnswer(): AsyncGenerator<
    { type: "answer_delta"; delta: string } | { type: "result"; response: AskChapterTutorResponse }
  > {
    yield { type: "answer_delta", delta: "因为上下文" };
    yield { type: "answer_delta", delta: "切换需要开销。" };
    yield {
      type: "result",
      response: {
        answer: "因为上下文切换需要开销。",
        citations: [{ blockId: "source-block-2", pageNumber: 99, quote: "模型伪造的引用" }],
        suggestedQuestions: ["时间片如何选择？"],
      },
    };
  }
}

const request: AskChapterTutorRequest = {
  question: "为什么时间片不能太小？",
  currentPage: 11,
  selectedText: "频繁上下文切换",
  history: [],
};

describe("Chapter AI Tutor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prioritizes the current PDF page and keeps bounded source labels", () => {
    const context = buildChapterTutorContext(reading, request);
    expect(context).toContain("source-block-2");
    expect(context.indexOf("source-block-2")).toBeLessThan(context.indexOf("source-block-1"));
    expect(context.length).toBeLessThanOrEqual(24_000);
  });

  it("extracts a partial answer from fragmented JSON tool arguments", () => {
    expect(extractPartialJsonStringProperty('{"answer":"先给\\n结论', "answer")).toBe("先给\n结论");
    expect(extractPartialJsonStringProperty('{"answer":"先给\\u4e', "answer")).toBe("先给");
    expect(extractPartialJsonStringProperty('{"citations":[],"answer":"回答"}', "answer")).toBe("回答");
  });

  it("loads only the owned Chapter and normalizes model citations to saved source", async () => {
    const model = new RecordingTutorModel();
    const loaded: Array<{ projectId: Hex; chapterId: number; owner: string }> = [];
    const result = await askChapterTutorForOwner(projectId, 0, owner, request, {
      model,
      loadReading: async (id, chapterId, address) => {
        loaded.push({ projectId: id, chapterId, owner: address });
        return reading;
      },
    });

    expect(loaded).toEqual([{ projectId, chapterId: 0, owner }]);
    expect(model.input?.context).toContain("频繁上下文切换");
    expect(result.citations).toEqual([{
      blockId: "source-block-2",
      pageNumber: 11,
      quote: "时间片过小会导致频繁上下文切换，从而增加系统开销。",
    }]);
  });

  it("streams answer deltas and validates citations only on the final event", async () => {
    const events = [];
    for await (const event of streamChapterTutorForOwner(projectId, 0, owner, request, {
      model: new StreamingTutorModel(),
      loadReading: async () => reading,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "answer_delta", delta: "因为上下文" },
      { type: "answer_delta", delta: "切换需要开销。" },
      {
        type: "result",
        response: {
          answer: "因为上下文切换需要开销。",
          citations: [{
            blockId: "source-block-2",
            pageNumber: 11,
            quote: "时间片过小会导致频繁上下文切换，从而增加系统开销。",
          }],
          suggestedQuestions: ["时间片如何选择？"],
        },
      },
    ]);
  });

  it("reports malformed upstream tool responses as a model error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    const model = new OpenAICompatibleChapterTutorModel({ apiKey: "test-key", model: "test-model" });

    await expect(model.answer({
      question: request.question,
      currentPage: request.currentPage ?? null,
      selectedText: request.selectedText ?? null,
      history: [],
      context: "[source-block-2 | page=11 | kind=paragraph]\n正文",
    })).rejects.toMatchObject({ status: 502, code: "ai_tutor_invalid_response" });
  });

  it("reports model connectivity failures without leaking transport details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret upstream detail")));
    const model = new OpenAICompatibleChapterTutorModel({ apiKey: "test-key", model: "test-model" });

    await expect(model.answer({
      question: request.question,
      currentPage: request.currentPage ?? null,
      selectedText: request.selectedText ?? null,
      history: [],
      context: "[source-block-2 | page=11 | kind=paragraph]\n正文",
    })).rejects.toMatchObject({
      status: 502,
      code: "ai_tutor_model_failed",
      message: "AI 导师暂时无法连接模型服务",
    });
  });
});
