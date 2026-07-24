import { describe, expect, it } from "vitest";
import { Coordinator } from "../src/coordinator.js";
import { FinalizerAgent } from "../src/finalizer.js";
import type { AgentToolCall, ToolCallingModel } from "../src/types.js";
import { validateAndCommitCards } from "../src/validation.js";
import { WorkerAgent } from "../src/worker.js";
import {
  FakeRegistry,
  InMemoryRepository,
  ScriptedModel,
  cardContents,
  createBundle,
  journeyId,
  workerScript,
} from "./fakes.js";

function predictedCardIds(repository: InMemoryRepository) {
  return repository.state.chunks.flatMap((chunk) => {
    const result = validateAndCommitCards({
      rawCards: cardContents(chunk.chunkId),
      journeyId,
      chunkId: chunk.chunkId,
      cardBudget: chunk.cardBudget,
      sourcePages: chunk.sourcePages!,
    });
    if (!result.valid) throw new Error("Fixture should be valid");
    return result.cards.map((card) => card.id);
  });
}

describe("Step 6 Coordinator", () => {
  it("runs three Workers concurrently and deduplicates repeated Journey events", async () => {
    const repository = new InMemoryRepository();
    const registry = new FakeRegistry();
    const tracker = { active: 0, maximum: 0 };
    const models = [0, 1, 2].map((chunkId) => {
      const script = workerScript(chunkId);
      let index = 0;
      const model: ToolCallingModel = {
        async nextTool(): Promise<AgentToolCall> {
          tracker.active += 1;
          tracker.maximum = Math.max(tracker.maximum, tracker.active);
          await new Promise((resolve) => setTimeout(resolve, 2));
          tracker.active -= 1;
          const call = script[index++];
          if (!call) throw new Error("No scripted call");
          return call;
        },
      };
      return model;
    });
    const selectedIds = predictedCardIds(repository);
    const finalizerModel = new ScriptedModel([
      { id: "read", name: "read_committed_cards", arguments: {} },
      {
        id: "select",
        name: "select_final_cards",
        arguments: { selectedCardIds: selectedIds, prerequisites: [] },
      },
    ]);
    const workers = models.map(
      (model) => new WorkerAgent(repository, registry, model),
    ) as [WorkerAgent, WorkerAgent, WorkerAgent];
    const coordinator = new Coordinator(
      repository,
      registry,
      workers,
      new FinalizerAgent(repository, registry, finalizerModel, {
        now: () => new Date("2026-07-22T00:00:00.000Z"),
      }),
      { deploymentBlock: 0n },
    );

    const first = await coordinator.runOnce([journeyId, journeyId]);
    expect(first).toHaveLength(1);
    expect(first[0]!.status).toBe("fulfilled");
    expect(tracker.maximum).toBe(3);
    expect(repository.state.journey.status).toBe("READY");
    expect(registry.commitInputs).toHaveLength(3);
    expect(registry.finalizeCount).toBe(1);

    await coordinator.runOnce([journeyId]);
    expect(registry.commitInputs).toHaveLength(3);
    expect(registry.finalizeCount).toBe(1);
  });

  it("preserves successful chunks when one Worker fails", async () => {
    const repository = new InMemoryRepository();
    const registry = new FakeRegistry();
    const workers = [
      new WorkerAgent(repository, registry, new ScriptedModel(workerScript(0))),
      new WorkerAgent(repository, registry, new ScriptedModel([])),
      new WorkerAgent(repository, registry, new ScriptedModel(workerScript(2))),
    ] as const;
    const coordinator = new Coordinator(
      repository,
      registry,
      workers,
      new FinalizerAgent(repository, registry, new ScriptedModel([])),
      { deploymentBlock: 0n },
    );

    const results = await coordinator.runOnce([journeyId]);

    expect(results[0]!.status).toBe("rejected");
    expect(repository.state.journey.status).toBe("FAILED_RETRYABLE");
    expect(repository.state.chunks.map((chunk) => chunk.status)).toEqual([
      "CONFIRMED",
      "RETRYABLE",
      "CONFIRMED",
    ]);
    expect(registry.commitInputs).toHaveLength(2);
    expect(registry.finalizeCount).toBe(0);
  });

  it("runs three Worker lanes concurrently but serializes chunks sharing one wallet", async () => {
    const repository = new InMemoryRepository(createBundle(6));
    const registry = new FakeRegistry();
    const tracker = {
      active: 0,
      maximum: 0,
      laneActive: [0, 0, 0],
      laneMaximum: [0, 0, 0],
    };
    const models = [0, 1, 2].map((laneIndex) => {
      const script = [laneIndex, laneIndex + 3].flatMap((chunkId) => workerScript(chunkId));
      let index = 0;
      const model: ToolCallingModel = {
        async nextTool(): Promise<AgentToolCall> {
          tracker.active += 1;
          tracker.maximum = Math.max(tracker.maximum, tracker.active);
          tracker.laneActive[laneIndex] = tracker.laneActive[laneIndex]! + 1;
          tracker.laneMaximum[laneIndex] = Math.max(
            tracker.laneMaximum[laneIndex]!,
            tracker.laneActive[laneIndex]!,
          );
          await new Promise((resolve) => setTimeout(resolve, 2));
          tracker.active -= 1;
          tracker.laneActive[laneIndex] = tracker.laneActive[laneIndex]! - 1;
          const call = script[index++];
          if (!call) throw new Error("No scripted call");
          return call;
        },
      };
      return model;
    });
    const selectedIds = predictedCardIds(repository);
    const finalizerModel = new ScriptedModel([
      { id: "read", name: "read_committed_cards", arguments: {} },
      {
        id: "select",
        name: "select_final_cards",
        arguments: { selectedCardIds: selectedIds, prerequisites: [] },
      },
    ]);
    const workers = models.map(
      (model) => new WorkerAgent(repository, registry, model),
    ) as [WorkerAgent, WorkerAgent, WorkerAgent];
    const coordinator = new Coordinator(
      repository,
      registry,
      workers,
      new FinalizerAgent(repository, registry, finalizerModel, {
        now: () => new Date("2026-07-22T00:00:00.000Z"),
      }),
      { deploymentBlock: 0n },
    );

    const results = await coordinator.runOnce([journeyId]);

    expect(results[0]!.status).toBe("fulfilled");
    expect(tracker.maximum).toBe(3);
    expect(tracker.laneMaximum).toEqual([1, 1, 1]);
    expect(registry.commitInputs).toHaveLength(6);
    expect(repository.state.journey.status).toBe("READY");
  });
});
