import type { Hex } from "viem";
import type { FinalizerAgent } from "./finalizer.js";
import type { RegistryGateway, RunnerRepository } from "./types.js";
import type { WorkerAgent } from "./worker.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Coordinator failure";
}

export class Coordinator {
  private readonly pendingJourneyIds = new Set<Hex>();
  private pollTimer: NodeJS.Timeout | null = null;
  private unwatch: (() => void) | null = null;
  private tickInProgress = false;

  constructor(
    private readonly repository: RunnerRepository,
    private readonly registry: RegistryGateway,
    private readonly workers: readonly [WorkerAgent, WorkerAgent, WorkerAgent],
    private readonly finalizer: FinalizerAgent,
    private readonly configuration: {
      deploymentBlock: bigint;
      pollIntervalMs?: number;
    },
  ) {}

  async start(): Promise<void> {
    await this.registry.assertConfiguredWallets();
    this.unwatch = this.registry.watchJourneyCreated((journeyId) => {
      this.pendingJourneyIds.add(journeyId);
      this.scheduleTick();
    });
    // Supabase already contains confirmed CREATED journeys. Process those first so a
    // provider-limited historical log replay cannot hold the visible work queue idle.
    await this.tick();
    const replayed = await this.registry.getJourneyCreatedIds(
      this.configuration.deploymentBlock,
    );
    for (const journeyId of replayed) this.pendingJourneyIds.add(journeyId);
    await this.tick();
    this.pollTimer = setInterval(
      () => this.scheduleTick(),
      this.configuration.pollIntervalMs ?? 20_000,
    );
    this.pollTimer.unref();
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.unwatch?.();
    this.unwatch = null;
  }

  async runOnce(additionalJourneyIds: readonly Hex[] = []): Promise<PromiseSettledResult<void>[]> {
    await this.repository.recoverStaleChunks();
    const recoverable = await this.repository.listRecoverableJourneyIds();
    const pending = [...this.pendingJourneyIds];
    this.pendingJourneyIds.clear();
    const journeyIds = [...new Set([...additionalJourneyIds, ...pending, ...recoverable])];
    return Promise.allSettled(journeyIds.map((journeyId) => this.processJourney(journeyId)));
  }

  private async tick(): Promise<void> {
    if (this.tickInProgress) return;
    this.tickInProgress = true;
    try {
      await this.runOnce();
    } finally {
      this.tickInProgress = false;
    }
  }

  private scheduleTick(): void {
    void this.tick().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "Coordinator polling failed");
    });
  }

  private async processJourney(journeyId: Hex): Promise<void> {
    let bundle = await this.repository.getJourneyBundle(journeyId);
    if (
      bundle.journey.status === "PREPARING" ||
      bundle.journey.status === "AWAITING_CREATE_TX" ||
      bundle.journey.status === "READY" ||
      bundle.journey.status === "CANCELLED"
    ) {
      return;
    }

    if (bundle.journey.status === "FINALIZING") {
      if (!(await this.repository.claimFinalization(journeyId))) return;
      await this.finalizeJourney(journeyId);
      return;
    }

    if (!(await this.repository.claimJourney(journeyId))) return;
    bundle = await this.repository.getJourneyBundle(journeyId);
    const workerRuns = bundle.chunks.map(async (chunk) => {
      if (chunk.status === "CONFIRMED" || chunk.status === "MERGED") return;
      const workerIndex = chunk.chunkId % 3;
      if (chunk.status === "QUEUED" || chunk.status === "RETRYABLE") {
        const claimed = await this.repository.claimChunk(
          journeyId,
          chunk.chunkId,
          this.registry.workerAddress(workerIndex),
        );
        if (!claimed) throw new Error(`Chunk ${chunk.chunkId} could not be claimed`);
      } else if (chunk.status !== "SAVED" && chunk.status !== "SUBMITTING") {
        throw new Error(`Chunk ${chunk.chunkId} has non-recoverable status ${chunk.status}`);
      }
      const worker = this.workers[workerIndex];
      if (!worker) throw new Error(`Worker ${workerIndex} is not configured`);
      await worker.run(journeyId, chunk.chunkId);
    });

    const workerResults = await Promise.allSettled(workerRuns);
    const failedWorkers = workerResults.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failedWorkers.length > 0) {
      await this.repository.markJourneyRetryable(
        journeyId,
        `${failedWorkers.length} Worker chunk(s) require retry`,
      );
      throw new Error(errorMessage(failedWorkers[0]!.reason));
    }

    bundle = await this.repository.getJourneyBundle(journeyId);
    if (!bundle.chunks.every((chunk) => chunk.status === "CONFIRMED")) {
      await this.repository.markJourneyRetryable(
        journeyId,
        "Not all chunks reached CONFIRMED after Worker completion",
      );
      throw new Error("Not all chunks reached CONFIRMED");
    }
    if (!(await this.repository.claimFinalization(journeyId))) return;
    await this.finalizeJourney(journeyId);
  }

  private async finalizeJourney(journeyId: Hex): Promise<void> {
    try {
      const record = await this.finalizer.prepare(journeyId);
      const onChain = await this.registry.readJourney(journeyId);
      if (!onChain) throw new Error("Journey does not exist in the Registry");
      if (onChain.status === "CANCELLED") {
        throw new Error("Journey was cancelled before finalization");
      }
      if (onChain.status === "READY") {
        if (
          onChain.deckRoot !== record.deckRoot ||
          onChain.planHash !== record.planHash ||
          onChain.totalCardCount !== record.deck.length
        ) {
          throw new Error("Existing Monad finalization does not match persisted Deck and Plan");
        }
        await this.repository.markJourneyReady(journeyId, null, 0n);
        return;
      }
      const receipt = await this.registry.finalizeDeck({
        journeyId,
        deckRoot: record.deckRoot,
        planHash: record.planHash,
        totalCardCount: record.deck.length,
      });
      await this.repository.markJourneyReady(journeyId, receipt.txHash, receipt.blockNumber);
    } catch (error) {
      await this.repository.markJourneyRetryable(journeyId, errorMessage(error));
      throw error;
    }
  }
}
