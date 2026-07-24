import type { CommittedKnowledgeCard } from "@mindmark/shared";
import { describe, expect, it } from "vitest";
import { buildStudyChapters, type StudyChapterSource } from "@/lib/client/chapters";

function id(value: number): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function card(value: number, chunkId: number): CommittedKnowledgeCard {
  return { id: id(value), chunkId } as CommittedKnowledgeCard;
}

function source(
  chunks: StudyChapterSource["chunks"],
  cards: CommittedKnowledgeCard[],
): StudyChapterSource {
  return {
    chunks,
    deck: cards,
    studiedCardIds: [cards[0]!.id],
    studyQueue: {
      dueCount: 1,
      newCount: 1,
      queue: [
        { reason: "due", card: cards[0]! },
        { reason: "planned", card: cards.at(-1)! },
      ],
    },
  };
}

describe("study chapter grouping", () => {
  it("keeps an eight-page source as one learning chapter", () => {
    const cards = [card(1, 0), card(2, 1), card(3, 2)];
    const chapters = buildStudyChapters(
      source(
        [
          { chunkId: 0, pageStart: 1, pageEnd: 3, title: "第一章 基础" },
          { chunkId: 1, pageStart: 4, pageEnd: 6, title: "第二章 进阶" },
          { chunkId: 2, pageStart: 7, pageEnd: 8, title: "第三章 应用" },
        ],
        cards,
      ),
    );

    expect(chapters).toHaveLength(1);
    expect(chapters[0]).toMatchObject({
      title: "全部学习内容",
      chunkIds: [0, 1, 2],
      studiedCount: 1,
    });
    expect(chapters[0]!.queue).toHaveLength(2);
  });

  it("merges chapter subsegments and keeps real chapters separate", () => {
    const cards = [card(1, 0), card(2, 1), card(3, 2)];
    const chapters = buildStudyChapters(
      source(
        [
          { chunkId: 0, pageStart: 1, pageEnd: 6, title: "第一章 基础 · 分段 1/2" },
          { chunkId: 1, pageStart: 7, pageEnd: 12, title: "第一章 基础 · 分段 2/2" },
          { chunkId: 2, pageStart: 13, pageEnd: 20, title: "第二章 应用" },
        ],
        cards,
      ),
    );

    expect(chapters.map((chapter) => chapter.title)).toEqual(["第一章 基础", "第二章 应用"]);
    expect(chapters[0]).toMatchObject({ chunkIds: [0, 1], pageStart: 1, pageEnd: 12 });
    expect(chapters[0]!.cards).toHaveLength(2);
    expect(chapters[1]!.queue).toHaveLength(1);
  });

  it("does not invent chapters for long material without headings", () => {
    const cards = [card(1, 0), card(2, 1)];
    const chapters = buildStudyChapters(
      source(
        [
          { chunkId: 0, pageStart: 1, pageEnd: 10, title: "外部调用会转移控制权。" },
          { chunkId: 1, pageStart: 11, pageEnd: 20, title: "状态更新应先于交互。" },
        ],
        cards,
      ),
    );

    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.title).toBe("全部学习内容");
  });
});
