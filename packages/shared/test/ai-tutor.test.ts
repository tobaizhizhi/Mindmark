import { describe, expect, it } from "vitest";
import {
  AskChapterTutorRequestSchema,
  AskChapterTutorResponseSchema,
  AiTutorStreamEventSchema,
} from "../src/ai-tutor.js";

describe("Chapter AI Tutor contracts", () => {
  it("bounds conversation history and optional PDF selection context", () => {
    const request = AskChapterTutorRequestSchema.parse({
      question: "为什么时间片过小会增加调度开销？",
      currentPage: 12,
      selectedText: "时间片过小会导致频繁上下文切换。",
      history: [{ role: "user", content: "先解释时间片轮转。" }],
    });
    expect(request).toMatchObject({ currentPage: 12, history: [{ role: "user" }] });
  });

  it("requires grounded citations to carry a block and page", () => {
    expect(AskChapterTutorResponseSchema.parse({
      answer: "时间片越小，单位时间内发生的上下文切换越多。",
      citations: [{ blockId: "source-block-8", pageNumber: 12, quote: "频繁上下文切换会增加系统开销" }],
      suggestedQuestions: ["时间片应该如何选择？"],
    }).citations[0]).toMatchObject({ blockId: "source-block-8", pageNumber: 12 });
  });

  it("keeps streaming deltas separate from the validated final response", () => {
    expect(AiTutorStreamEventSchema.parse({ type: "answer_delta", delta: "先给结论" })).toEqual({
      type: "answer_delta",
      delta: "先给结论",
    });
    expect(AiTutorStreamEventSchema.safeParse({
      type: "result",
      response: { answer: null, citations: [], suggestedQuestions: [] },
    }).success).toBe(false);
  });
});
