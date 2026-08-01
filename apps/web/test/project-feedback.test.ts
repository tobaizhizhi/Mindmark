import { describe, expect, it } from "vitest";
import {
  SubmitKnowledgeCardFeedbackRequestSchema,
  type SubmitKnowledgeCardFeedbackRequest,
} from "@mindmark/shared";
import type { Hex } from "viem";
import { ApiError } from "../lib/server/http.js";
import {
  listKnowledgeCardFeedbackForOwner,
  submitKnowledgeCardFeedbackForOwner,
  type KnowledgeCardFeedbackStore,
} from "../lib/server/project-feedback.js";

const projectId = `0x${"a1".repeat(32)}` as Hex;
const cardId = `0x${"b2".repeat(32)}` as Hex;
const owner = `0x${"c3".repeat(20)}` as `0x${string}`;

class InMemoryFeedbackStore implements KnowledgeCardFeedbackStore {
  ownsProjectResult = true;
  ownsCardResult = true;
  rows: Array<{
    feedback_id: string;
    project_id: Hex;
    chapter_id: number;
    card_id: Hex;
    rating: string;
    reason: string | null;
    corrected_content: unknown;
    created_at: string;
  }> = [];

  async ownsProject() { return this.ownsProjectResult; }
  async ownsCard() { return this.ownsCardResult; }
  async create(input: Parameters<KnowledgeCardFeedbackStore["create"]>[0]) {
    const row = {
      feedback_id: "00000000-0000-4000-8000-000000000001",
      project_id: input.projectId,
      chapter_id: input.chapterId,
      card_id: input.cardId,
      rating: input.rating,
      reason: input.reason,
      corrected_content: input.correctedContent,
      created_at: "2026-07-30T00:00:00.000Z",
    };
    this.rows.push(row);
    return row;
  }
  async list() { return this.rows; }
}

function feedback(overrides: Partial<SubmitKnowledgeCardFeedbackRequest> = {}) {
  return SubmitKnowledgeCardFeedbackRequestSchema.parse({
    chapterId: 0,
    cardId,
    rating: "INCORRECT",
    reason: "答案遗漏了资料中的前置条件。",
    correctedContent: { answer: "应先说明前置条件，再给出结论。" },
    ...overrides,
  });
}

describe("Knowledge Card feedback", () => {
  it("requires a reason for incorrect and unclear feedback", () => {
    expect(() => SubmitKnowledgeCardFeedbackRequestSchema.parse({
      chapterId: 0,
      cardId,
      rating: "INCORRECT",
    })).toThrow(/requires a reason/u);
  });

  it("persists correction feedback only after the card ownership check", async () => {
    const store = new InMemoryFeedbackStore();

    await expect(submitKnowledgeCardFeedbackForOwner(projectId, owner, feedback(), store)).resolves.toMatchObject({
      projectId,
      cardId,
      rating: "INCORRECT",
      correctedContent: { answer: "应先说明前置条件，再给出结论。" },
    });
    expect(store.rows).toHaveLength(1);

    store.ownsCardResult = false;
    await expect(submitKnowledgeCardFeedbackForOwner(projectId, owner, feedback(), store))
      .rejects.toMatchObject({ status: 404, code: "card_not_found" } satisfies Partial<ApiError>);
    expect(store.rows).toHaveLength(1);
  });

  it("does not reveal feedback when the Project is not owned by the active wallet", async () => {
    const store = new InMemoryFeedbackStore();
    await submitKnowledgeCardFeedbackForOwner(projectId, owner, feedback(), store);
    expect(await listKnowledgeCardFeedbackForOwner(projectId, owner, {}, store)).toMatchObject({
      feedback: [{ projectId, cardId }],
    });

    store.ownsProjectResult = false;
    await expect(listKnowledgeCardFeedbackForOwner(projectId, owner, {}, store))
      .rejects.toMatchObject({ status: 404, code: "project_not_found" } satisfies Partial<ApiError>);
  });
});
