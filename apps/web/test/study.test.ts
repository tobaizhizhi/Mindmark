import {
  buildCardTree,
  deriveCardId,
  hashKnowledgeCard,
  type CommittedKnowledgeCard,
} from "@mindmark/shared";
import { describe, expect, it } from "vitest";
import {
  buildAdaptivePlan,
  buildStudyQueue,
  scheduleReview,
  type FsrsStateMap,
} from "@/lib/server/study";

const journeyId = `0x${"11".repeat(32)}` as `0x${string}`;

function cards(count = 6): CommittedKnowledgeCard[] {
  const partial = Array.from({ length: count }, (_, index) => {
    const content = {
      type: "qa" as const,
      question: `Question ${index}`,
      answer: `Answer ${index}`,
      keyPoint: `Point ${index}`,
      source: {
        page: 1,
        quote: `This is a sufficiently long exact quotation for card number ${index}.`,
      },
      tags: ["security"],
      importance: index === 0 ? 5 : 3,
      initialDifficulty: 3,
    };
    const cardHash = hashKnowledgeCard(content);
    return {
      ...content,
      cardHash,
      id: deriveCardId(journeyId, 0, cardHash),
      chunkId: 0,
    };
  });
  const tree = buildCardTree(partial.map((card) => card.id));
  return partial.map((card) => ({
    ...card,
    cardProof: tree.cards.find((item) => item.cardId === card.id)!.proof,
  }));
}

function state(due: string): FsrsStateMap[string] {
  return {
    due,
    stability: 1,
    difficulty: 5,
    elapsed_days: 0,
    scheduled_days: 1,
    learning_steps: 0,
    reps: 1,
    lapses: 0,
    state: 2,
    last_review: "2026-07-20T00:00:00.000Z",
  };
}

describe("Step 10 study scheduling", () => {
  it("maps all four ratings through fixed FSRS parameters", () => {
    const reviewedAt = "2026-07-22T00:00:00.000Z";
    const results = ["again", "hard", "good", "easy"].map((rating) =>
      scheduleReview({
        currentState: null,
        rating: rating as "again" | "hard" | "good" | "easy",
        reviewedAt,
      }),
    );
    expect(results.every((result) => result.reps === 1)).toBe(true);
    expect(new Set(results.map((result) => result.due)).size).toBe(4);
    expect(Date.parse(results[3]!.due)).toBeGreaterThan(Date.parse(results[2]!.due));
  });

  it("puts due cards first and introduces at most eight planned cards", () => {
    const deck = cards();
    const fsrsStates = {
      [deck[0]!.id]: state("2026-07-21T00:00:00.000Z"),
      [deck[1]!.id]: state("2026-07-30T00:00:00.000Z"),
    };
    const queue = buildStudyQueue({
      deck,
      fsrsStates,
      plan: {
        version: 1,
        generatedAt: "2026-07-22T00:00:00.000Z",
        days: Array.from({ length: 7 }, (_, dayOffset) => ({
          dayOffset,
          newCardIds: dayOffset === 0 ? deck.slice(2).map((card) => card.id) : [],
          reviewCardIds: [],
        })),
      },
      now: new Date("2026-07-22T12:00:00.000Z"),
    });
    expect(queue.queue[0]).toMatchObject({ reason: "due", card: { id: deck[0]!.id } });
    expect(queue.newCount).toBe(4);
    expect(queue.queue).toHaveLength(5);
    expect(queue.queue.length).toBeLessThanOrEqual(15);
  });

  it("builds a seven-day Plan v2 within daily limits", () => {
    const deck = cards(20);
    const fsrsStates = Object.fromEntries(
      deck.slice(0, 8).map((card, index) => [
        card.id,
        state(`2026-07-${String(22 + (index % 4)).padStart(2, "0")}T00:00:00.000Z`),
      ]),
    );
    const plan = buildAdaptivePlan({
      deck,
      fsrsStates,
      version: 2,
      now: new Date("2026-07-22T00:00:00.000Z"),
    });
    expect(plan.days).toHaveLength(7);
    expect(plan.days.every((day) => day.newCardIds.length <= 8)).toBe(true);
    expect(plan.days.every((day) => day.newCardIds.length + day.reviewCardIds.length <= 15)).toBe(
      true,
    );
  });
});
