import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import {
  completeChapterSessionForOwner,
  getChapterStudyForOwner,
  getProjectStudyForOwner,
  submitChapterReviewForOwner,
  type ProjectQueueStore,
  type ProjectStudyStore,
} from "@/lib/server/project-study";
import { scheduleReview, type SerializedFsrsCard } from "@/lib/server/fsrs";

const projectId = `0x${"91".repeat(32)}` as Hex;
const owner = `0x${"ab".repeat(20)}` as `0x${string}`;
const cardIds = [
  `0x${"a1".repeat(32)}`,
  `0x${"a2".repeat(32)}`,
  `0x${"a3".repeat(32)}`,
] as const;

const content = (index: number) => ({
  type: "qa" as const,
  question: `问题 ${index}`,
  answer: `答案 ${index}`,
  keyPoint: `要点 ${index}`,
  source: { page: 1, quote: `这是第 ${index} 张卡片对应的足够长逐字引用内容，用来验证来源。` },
  tags: ["chapter-one"],
  importance: 5 - index,
  initialDifficulty: 3,
});

class MemoryProjectStudyStore implements ProjectStudyStore {
  state: SerializedFsrsCard = scheduleReview({
    currentState: null,
    rating: "good",
    reviewedAt: "2026-07-20T00:00:00.000Z",
  });
  submitted: Parameters<ProjectStudyStore["submitReview"]>[0] | null = null;
  loadOwnedChapterCalls = 0;
  loadCardStateCalls = 0;

  async loadOwnedChapter(id: Hex, chapterId: number, address: `0x${string}`) {
    this.loadOwnedChapterCalls += 1;
    if (id !== projectId || chapterId !== 0 || address !== owner) return null;
    return {
      chapter: { project_id: projectId, chapter_id: 0, status: "READY" as const },
      cards: cardIds.map((cardId, position) => ({ card_id: cardId, position, content: content(position) })),
      states: [{
        card_id: cardIds[0], fsrs_state: this.state,
        due_at: this.state.due, reps: this.state.reps, lapses: this.state.lapses,
      }],
    };
  }

  async loadCardState(id: Hex, chapterId: number, cardId: Hex, address: `0x${string}`) {
    this.loadCardStateCalls += 1;
    if (id !== projectId || chapterId !== 0 || address !== owner || cardId !== cardIds[0]) return null;
    return {
      card_id: cardIds[0], fsrs_state: this.state,
      due_at: this.state.due, reps: this.state.reps, lapses: this.state.lapses,
    };
  }

  async submitReview(input: Parameters<ProjectStudyStore["submitReview"]>[0]) {
    this.submitted = input;
    this.state = input.nextState;
    return { accepted: true, duplicate: false, nextReviewAt: input.nextState.due };
  }

  async completeSession(_owner: `0x${string}`, sessionId: string) {
    return {
      sessionId,
      reviewedCount: 1,
      forgottenCount: 0,
      averageResponseMs: 900,
      completedAt: "2026-07-26T00:01:00.000Z",
    };
  }
}

describe("Chapter-scoped V2 study", () => {
  it("builds the queue from only the selected Chapter", async () => {
    const detail = await getChapterStudyForOwner(
      projectId,
      0,
      owner,
      new MemoryProjectStudyStore(),
      new Date("2026-07-26T00:00:00.000Z"),
    );
    expect(detail.cards).toHaveLength(3);
    expect(detail.queue).toEqual(cardIds);
    expect(detail.dueCount).toBe(1);
    expect(detail.newCount).toBe(2);
    expect(detail.cards.every((card) => card.tags.includes("chapter-one"))).toBe(true);
  });

  it("keeps every due and new card in the Chapter queue", async () => {
    const dueCardIds = Array.from({ length: 18 }, (_, index) =>
      `0x${(index + 1).toString(16).padStart(64, "0")}` as Hex);
    const newCardId = `0x${"ff".repeat(32)}` as Hex;
    const dueState = scheduleReview({
      currentState: null,
      rating: "again",
      reviewedAt: "2026-07-20T00:00:00.000Z",
    });
    const store: ProjectStudyStore = {
      async loadOwnedChapter() {
        return {
          chapter: { project_id: projectId, chapter_id: 0, status: "READY" as const },
          cards: [...dueCardIds, newCardId].map((cardId, position) => ({
            card_id: cardId,
            position,
            content: {
              ...content(0),
              question: `问题 ${position}`,
              answer: `答案 ${position}`,
              importance: 3,
            },
          })),
          states: dueCardIds.map((cardId) => ({
            card_id: cardId,
            fsrs_state: dueState,
            due_at: dueState.due,
            reps: dueState.reps,
            lapses: dueState.lapses,
          })),
        };
      },
      async loadCardState() {
        throw new Error("not used");
      },
      async submitReview() {
        throw new Error("not used");
      },
      async completeSession() {
        throw new Error("not used");
      },
    };

    const detail = await getChapterStudyForOwner(
      projectId,
      0,
      owner,
      store,
      new Date("2026-07-26T00:00:00.000Z"),
    );

    expect(detail.queue).toEqual([...dueCardIds, newCardId]);
    expect(detail.dueCount).toBe(18);
    expect(detail.newCount).toBe(1);
  });

  it("advances exactly one card state and completes the same Chapter session", async () => {
    const store = new MemoryProjectStudyStore();
    const sessionId = "323e4567-e89b-42d3-a456-426614174000";
    const response = await submitChapterReviewForOwner(
      projectId,
      0,
      owner,
      {
        sessionId,
        cardId: cardIds[1],
        rating: "good",
        responseMs: 900,
        reviewedAt: "2026-07-26T00:00:30.000Z",
      },
      store,
    );
    expect(response.accepted).toBe(true);
    expect(store.loadOwnedChapterCalls).toBe(0);
    expect(store.loadCardStateCalls).toBe(1);
    expect(store.submitted?.chapterId).toBe(0);
    expect(store.submitted?.expectedState).toBeNull();
    expect(store.submitted?.nextState.reps).toBe(1);

    await expect(completeChapterSessionForOwner(owner, sessionId, store)).resolves.toMatchObject({
      sessionId,
      reviewedCount: 1,
      averageResponseMs: 900,
    });
  });

  it("does not reveal another owner's Chapter", async () => {
    await expect(getChapterStudyForOwner(
      projectId,
      0,
      `0x${"cd".repeat(20)}`,
      new MemoryProjectStudyStore(),
    )).rejects.toMatchObject({ status: 404, code: "chapter_not_found" });
  });
});

describe("Project-scoped V2 study", () => {
  it("merges due cards and round-robins new cards across READY Chapters", async () => {
    const ids = Array.from({ length: 6 }, (_, index) =>
      `0x${(index + 11).toString(16).padStart(64, "0")}` as Hex);
    const dueState = scheduleReview({
      currentState: null,
      rating: "again",
      reviewedAt: "2026-07-20T00:00:00.000Z",
    });
    const store: ProjectQueueStore = {
      async loadOwnedProject(id, address) {
        if (id !== projectId || address !== owner) return null;
        return {
          project: { project_id: projectId, status: "GENERATING" as const },
          chapters: [
            { project_id: projectId, chapter_id: 0, position: 0, title: "基础", status: "READY" as const },
            { project_id: projectId, chapter_id: 1, position: 1, title: "实践", status: "READY" as const },
          ],
          cards: [
            { card_id: ids[0]!, chapter_id: 1, position: 2, content: { ...content(0), importance: 5 } },
            { card_id: ids[1]!, chapter_id: 0, position: 0, content: { ...content(0), importance: 5 } },
            { card_id: ids[2]!, chapter_id: 0, position: 1, content: { ...content(0), importance: 3 } },
            { card_id: ids[3]!, chapter_id: 1, position: 3, content: { ...content(0), importance: 4 } },
            { card_id: ids[4]!, chapter_id: 1, position: 4, content: { ...content(0), importance: 2 } },
            { card_id: ids[5]!, chapter_id: 2, position: 5, content: { ...content(0), importance: 5 } },
          ],
          states: [{
            card_id: ids[0]!,
            fsrs_state: dueState,
            due_at: dueState.due,
            reps: dueState.reps,
            lapses: dueState.lapses,
          }],
        };
      },
    };

    const result = await getProjectStudyForOwner(
      projectId,
      owner,
      store,
      new Date("2026-07-26T00:00:00.000Z"),
    );

    expect(result.status).toBe("GENERATING");
    expect(result.readyChapterCount).toBe(2);
    expect(result.dueCount).toBe(1);
    expect(result.newCount).toBe(4);
    expect(result.queue.map((card) => card.id)).toEqual([
      ids[0], ids[1], ids[3], ids[2], ids[4],
    ]);
    expect(result.queue.map((card) => card.chapterTitle)).toEqual([
      "实践", "基础", "实践", "基础", "实践",
    ]);
    expect(result.queue).not.toContainEqual(expect.objectContaining({ id: ids[5] }));
  });

  it("round-robins every new card without a daily cap", async () => {
    const ids = Array.from({ length: 24 }, (_, index) =>
      `0x${(index + 41).toString(16).padStart(64, "0")}` as Hex);
    const store: ProjectQueueStore = {
      async loadOwnedProject() {
        return {
          project: { project_id: projectId, status: "READY" as const },
          chapters: [
            { project_id: projectId, chapter_id: 0, position: 0, title: "基础", status: "READY" as const },
            { project_id: projectId, chapter_id: 1, position: 1, title: "实践", status: "READY" as const },
          ],
          cards: ids.map((cardId, position) => ({
            card_id: cardId,
            chapter_id: position < 12 ? 0 : 1,
            position,
            content: { ...content(0), question: `问题 ${position}`, answer: `答案 ${position}` },
          })),
          states: [],
        };
      },
    };

    const result = await getProjectStudyForOwner(projectId, owner, store);

    expect(result.queue).toHaveLength(24);
    expect(result.newCount).toBe(24);
    expect(result.queue.map((card) => card.chapterId).slice(0, 6)).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it("does not reveal another owner's Project queue", async () => {
    const store: ProjectQueueStore = { async loadOwnedProject() { return null; } };
    await expect(getProjectStudyForOwner(projectId, owner, store)).rejects.toMatchObject({
      status: 404,
      code: "project_not_found",
    });
  });
});
