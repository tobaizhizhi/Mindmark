import { describe, expect, it } from "vitest";
import { buildInitialPlan, FinalizerAgent } from "../src/finalizer.js";
import { validateAndCommitCards } from "../src/validation.js";
import {
  FakeRegistry,
  InMemoryRepository,
  ScriptedModel,
  cardContents,
  hex,
  journeyId,
} from "./fakes.js";

function commitFixture(repository: InMemoryRepository, registry: FakeRegistry) {
  for (const chunk of repository.state.chunks) {
    const result = validateAndCommitCards({
      rawCards: cardContents(chunk.chunkId),
      journeyId,
      chunkId: chunk.chunkId,
      cardBudget: chunk.cardBudget,
      sourcePages: chunk.sourcePages!,
    });
    if (!result.valid) throw new Error("Fixture should be valid");
    chunk.cards = result.cards;
    chunk.cardsRoot = result.cardsRoot;
    chunk.cardCount = result.cards.length;
    chunk.status = "CONFIRMED";
    registry.commitments.set(chunk.chunkId, {
      sourceChunkHash: chunk.sourceChunkHash,
      cardsRoot: result.cardsRoot,
      agent: registry.workerAddress(chunk.chunkId % 3),
      committedBlock: BigInt(100 + chunk.chunkId),
      cardCount: result.cards.length,
    });
  }
  repository.state.journey.status = "FINALIZING";
  return repository.state.chunks.flatMap((chunk) => chunk.cards);
}

describe("Step 8 Finalizer", () => {
  it("selects only committed IDs, repairs once, and persists immutable provenance", async () => {
    const repository = new InMemoryRepository();
    const registry = new FakeRegistry();
    const cards = commitFixture(repository, registry);
    const model = new ScriptedModel([
      { id: "read", name: "read_committed_cards", arguments: {} },
      {
        id: "invalid",
        name: "select_final_cards",
        arguments: {
          selectedCardIds: [hex("e"), ...cards.slice(0, 3).map((card) => card.id)],
          prerequisites: [],
        },
      },
      {
        id: "repair",
        name: "select_final_cards",
        arguments: {
          selectedCardIds: cards.map((card) => card.id),
          prerequisites: [
            { beforeCardId: cards[0]!.id, afterCardId: cards[cards.length - 1]!.id },
          ],
        },
      },
    ]);
    const finalizer = new FinalizerAgent(repository, registry, model, {
      now: () => new Date("2026-07-22T00:00:00.000Z"),
    });

    const record = await finalizer.prepare(journeyId);

    expect(record.deck).toEqual(cards);
    expect(Object.keys(record.provenance)).toHaveLength(cards.length);
    expect(record.provenance[cards[0]!.id]!.chunkProof).toEqual(cards[0]!.cardProof);
    expect(record.plan.days).toHaveLength(7);
    expect(record.plan.days.every((day) => day.newCardIds.length <= 8)).toBe(true);
    expect(
      record.plan.days.every(
        (day) => day.newCardIds.length + day.reviewCardIds.length <= 15,
      ),
    ).toBe(true);
    expect(model.calls).toBe(3);

    const second = await finalizer.prepare(journeyId);
    expect(second).toEqual(record);
    expect(model.calls).toBe(3);
  });

  it("rejects a mutated database card before invoking the model", async () => {
    const repository = new InMemoryRepository();
    const registry = new FakeRegistry();
    commitFixture(repository, registry);
    repository.state.chunks[1]!.cards[0]!.answer = "mutated after commitment";
    const model = new ScriptedModel([]);

    await expect(new FinalizerAgent(repository, registry, model).prepare(journeyId)).rejects.toThrow(
      /does not match its Monad commitment/u,
    );
    expect(model.calls).toBe(0);
  });

  it("orders prerequisites and keeps the rolling seven-day limits", () => {
    const repository = new InMemoryRepository();
    const registry = new FakeRegistry();
    const cards = commitFixture(repository, registry);
    const prerequisite = cards[cards.length - 1]!;
    const dependent = cards[0]!;
    const plan = buildInitialPlan({
      cards,
      prerequisites: [
        { beforeCardId: prerequisite.id, afterCardId: dependent.id },
      ],
      generatedAt: "2026-07-22T00:00:00.000Z",
    });
    const dayOf = (id: string) =>
      plan.days.find((day) => day.newCardIds.includes(id as `0x${string}`))!.dayOffset;

    expect(dayOf(prerequisite.id)).toBeLessThanOrEqual(dayOf(dependent.id));
    expect(plan.days.every((day) => day.newCardIds.length <= 8)).toBe(true);
    expect(plan.days.every((day) => day.newCardIds.length + day.reviewCardIds.length <= 15)).toBe(
      true,
    );
  });
});
