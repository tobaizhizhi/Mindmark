import { describe, expect, it } from "vitest";
import {
  chapterTitleQualityIssues,
  normalizeChapterTitle,
} from "../src/chapter-title.js";

describe("Chapter title policy", () => {
  it("normalizes numbering, Markdown, punctuation and Chinese parentheses", () => {
    expect(normalizeChapterTitle("**第 1 章 · 进程 ( 线程 ) 调度方式。**")).toBe(
      "进程（线程）调度方式",
    );
    expect(normalizeChapterTitle("1. 页框回收算法( PFRA )")).toBe("页框回收算法（PFRA）");
  });

  it("rejects worked-example fragments as learner-facing titles", () => {
    expect(chapterTitleQualityIssues("50 − 5 − 30 ）。 此 时应抢占处理机给 A 运行。"))
      .toEqual(expect.arrayContaining([
        expect.stringMatching(/arithmetic expression/u),
        expect.stringMatching(/concise topic/u),
      ]));
  });
});
