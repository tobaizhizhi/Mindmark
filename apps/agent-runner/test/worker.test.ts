import { describe, expect, it } from "vitest";
import { WorkerAgent } from "../src/worker.js";
import { validateAndCommitCards } from "../src/validation.js";
import {
  FakeRegistry,
  InMemoryRepository,
  ScriptedModel,
  cardContents,
  hex,
  journeyId,
  workerScript,
} from "./fakes.js";

describe("Step 7 Worker Agent", () => {
  it("derives commitment calldata from persisted cards and rejects model-supplied roots", async () => {
    const repository = new InMemoryRepository();
    const registry = new FakeRegistry();
    await repository.claimChunk(journeyId, 0, registry.workerAddress(0));
    const calls = workerScript(0);
    calls.splice(3, 0, {
      id: "malicious",
      name: "submit_chunk_commitment",
      arguments: { cardsRoot: hex("e"), cardCount: 30 },
    });
    const model = new ScriptedModel(calls);

    await new WorkerAgent(repository, registry, model).run(journeyId, 0);

    expect(repository.state.chunks[0]!.status).toBe("CONFIRMED");
    expect(registry.commitInputs).toHaveLength(1);
    expect(registry.commitInputs[0]!.cardsRoot).toBe(repository.state.chunks[0]!.cardsRoot);
    expect(registry.commitInputs[0]!.cardsRoot).not.toBe(hex("e"));
  });

  it("allows exactly one citation repair", async () => {
    const repository = new InMemoryRepository();
    const registry = new FakeRegistry();
    await repository.claimChunk(journeyId, 0, registry.workerAddress(0));
    const model = new ScriptedModel([
      { id: "read", name: "read_assigned_chunk", arguments: {} },
      {
        id: "bad-save",
        name: "save_chunk_draft",
        arguments: { cards: cardContents(0, 2, "This quotation is not present in the assigned source page.") },
      },
      { id: "bad-validate", name: "validate_chunk_cards", arguments: {} },
      { id: "repair", name: "save_chunk_draft", arguments: { cards: cardContents(0) } },
      { id: "good-validate", name: "validate_chunk_cards", arguments: {} },
      { id: "get", name: "get_chunk_commitment", arguments: {} },
      { id: "submit", name: "submit_chunk_commitment", arguments: {} },
    ]);

    await new WorkerAgent(repository, registry, model).run(journeyId, 0);
    expect(model.calls).toBe(7);
    expect(repository.state.chunks[0]!.status).toBe("CONFIRMED");
  });

  it("fails on a second invalid validation", async () => {
    const repository = new InMemoryRepository();
    const registry = new FakeRegistry();
    await repository.claimChunk(journeyId, 0, registry.workerAddress(0));
    const bad = cardContents(0, 2, "This quotation is not present in the assigned source page.");
    const model = new ScriptedModel([
      { id: "read", name: "read_assigned_chunk", arguments: {} },
      { id: "save-1", name: "save_chunk_draft", arguments: { cards: bad } },
      { id: "validate-1", name: "validate_chunk_cards", arguments: {} },
      { id: "save-2", name: "save_chunk_draft", arguments: { cards: bad } },
      { id: "validate-2", name: "validate_chunk_cards", arguments: {} },
    ]);

    await expect(new WorkerAgent(repository, registry, model).run(journeyId, 0)).rejects.toThrow(
      /single card validation repair/u,
    );
    expect(repository.state.chunks[0]!.status).toBe("RETRYABLE");
    expect(registry.commitInputs).toHaveLength(0);
  });

  it("resumes a saved result without calling the model", async () => {
    const repository = new InMemoryRepository();
    const registry = new FakeRegistry();
    const chunk = repository.state.chunks[0]!;
    const result = validateAndCommitCards({
      rawCards: cardContents(0),
      journeyId,
      chunkId: 0,
      cardBudget: chunk.cardBudget,
      sourcePages: chunk.sourcePages!,
    });
    if (!result.valid) throw new Error("Fixture should be valid");
    chunk.cards = result.cards;
    chunk.cardsRoot = result.cardsRoot;
    chunk.cardCount = result.cards.length;
    chunk.status = "SAVED";
    const model = new ScriptedModel([]);

    await new WorkerAgent(repository, registry, model).run(journeyId, 0);

    expect(model.calls).toBe(0);
    expect(chunk.status).toBe("CONFIRMED");
    expect(registry.commitInputs).toHaveLength(1);
  });

  it("does not rebroadcast while a saved transaction is still pending", async () => {
    const repository = new InMemoryRepository();
    const registry = new FakeRegistry();
    const chunk = repository.state.chunks[0]!;
    const result = validateAndCommitCards({
      rawCards: cardContents(0),
      journeyId,
      chunkId: 0,
      cardBudget: chunk.cardBudget,
      sourcePages: chunk.sourcePages!,
    });
    if (!result.valid) throw new Error("Fixture should be valid");
    chunk.cards = result.cards;
    chunk.cardsRoot = result.cardsRoot;
    chunk.cardCount = result.cards.length;
    chunk.status = "SUBMITTING";
    chunk.commitTxHash = hex("d");
    registry.transactionStates.set(chunk.commitTxHash, "PENDING");

    await expect(
      new WorkerAgent(repository, registry, new ScriptedModel([])).run(journeyId, 0),
    ).rejects.toThrow(/still pending/u);
    expect(registry.commitInputs).toHaveLength(0);
    expect(repository.state.chunks[0]!.status).toBe("SAVED");
    expect(repository.state.chunks[0]!.commitTxHash).toBe(hex("d"));
  });

  it("recovers a matching chain commitment and rejects mutated persisted cards", async () => {
    const repository = new InMemoryRepository();
    const registry = new FakeRegistry();
    const chunk = repository.state.chunks[0]!;
    const result = validateAndCommitCards({
      rawCards: cardContents(0),
      journeyId,
      chunkId: 0,
      cardBudget: chunk.cardBudget,
      sourcePages: chunk.sourcePages!,
    });
    if (!result.valid) throw new Error("Fixture should be valid");
    chunk.cards = result.cards;
    chunk.cardsRoot = result.cardsRoot;
    chunk.cardCount = result.cards.length;
    chunk.status = "SAVED";
    registry.commitments.set(0, {
      sourceChunkHash: chunk.sourceChunkHash,
      cardsRoot: result.cardsRoot,
      agent: registry.workerAddress(0),
      committedBlock: 42n,
      cardCount: result.cards.length,
    });
    const noModel = new ScriptedModel([]);
    await new WorkerAgent(repository, registry, noModel).run(journeyId, 0);
    expect(repository.state.chunks[0]!.status).toBe("CONFIRMED");
    expect(registry.commitInputs).toHaveLength(0);

    repository.state.chunks[0]!.status = "SAVED";
    repository.state.chunks[0]!.cards[0]!.answer = "tampered";
    await expect(
      new WorkerAgent(repository, registry, new ScriptedModel([])).run(journeyId, 0),
    ).rejects.toThrow(/does not match persisted validated data/u);
  });
});
