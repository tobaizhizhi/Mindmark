import type {
  AgentToolCall,
  ChainChunkCommitment,
  ChainJourneyState,
  ChainReceipt,
  FinalizationRecord,
  JourneyBundle,
  RegistryGateway,
  RunnerRepository,
  SavedChunkResult,
  ToolCallingModel,
} from "../src/types.js";
import type { Hex } from "viem";

export const hex = (nibble: string): Hex => `0x${nibble.repeat(64)}` as Hex;
export const address = (nibble: string): `0x${string}` =>
  `0x${nibble.repeat(40)}` as `0x${string}`;

export const journeyId = hex("1");
export const workerAddresses = [address("2"), address("3"), address("4")] as const;

export function createBundle(chunkCount = 3): JourneyBundle {
  return {
    journey: {
      journeyId,
      learnerAddress: address("a"),
      goal: "Understand the material",
      sourceHash: hex("5"),
      goalHash: hex("6"),
      chunkManifestRoot: hex("7"),
      chunkCount,
      status: "CREATED",
      deck: null,
      provenance: null,
      deckRoot: null,
      plan: null,
      planHash: null,
      finalizeTxHash: null,
    },
    chunks: Array.from({ length: chunkCount }, (_, chunkId) => {
      const text = `Chunk ${chunkId} explains a concrete security mechanism with enough exact words for citation validation.`;
      return {
        journeyId,
        chunkId,
        pageStart: chunkId + 1,
        pageEnd: chunkId + 1,
        title: `Chunk ${chunkId}`,
        sourceText: text,
        sourcePages: [{ pageNumber: chunkId + 1, text }],
        sourceChunkHash: hex((8 + chunkId).toString(16)),
        manifestProof: [hex("b")],
        cardBudget: 4,
        workerAddress: null,
        attempt: 0,
        status: "QUEUED" as const,
        cards: [],
        cardsRoot: null,
        cardCount: null,
        commitTxHash: null,
      };
    }),
  };
}

export function cardContents(chunkId: number, count = 2, quote?: string) {
  const sourceText = `Chunk ${chunkId} explains a concrete security mechanism with enough exact words for citation validation.`;
  return Array.from({ length: count }, (_, index) => ({
    type: "qa" as const,
    question: `What is mechanism ${chunkId}-${index}?`,
    answer: `Mechanism ${chunkId}-${index} is an atomic security idea.`,
    keyPoint: `Atomic idea ${chunkId}-${index}`,
    source: { page: chunkId + 1, quote: quote ?? sourceText },
    tags: [`chunk-${chunkId}`],
    importance: index === 0 ? 5 : 3,
    initialDifficulty: index === 0 ? 4 : 2,
  }));
}

export class ScriptedModel implements ToolCallingModel {
  calls = 0;

  constructor(
    private readonly script: AgentToolCall[],
    private readonly delayMs = 0,
  ) {}

  async nextTool(): Promise<AgentToolCall> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    const call = this.script[this.calls];
    this.calls += 1;
    if (!call) throw new Error("Scripted model has no remaining tool call");
    return structuredClone(call);
  }
}

export function workerScript(chunkId: number): AgentToolCall[] {
  return [
    { id: "read", name: "read_assigned_chunk", arguments: {} },
    {
      id: "save",
      name: "save_chunk_draft",
      arguments: { cards: cardContents(chunkId) },
    },
    { id: "validate", name: "validate_chunk_cards", arguments: {} },
    { id: "get", name: "get_chunk_commitment", arguments: {} },
    { id: "submit", name: "submit_chunk_commitment", arguments: {} },
  ];
}

export class InMemoryRepository implements RunnerRepository {
  readonly events: Array<{ type: string; chunkId?: number }> = [];

  constructor(public state = createBundle()) {}

  async listRecoverableJourneyIds(): Promise<Hex[]> {
    return ["CREATED", "FAILED_RETRYABLE"].includes(this.state.journey.status)
      ? [this.state.journey.journeyId]
      : [];
  }

  async recoverStaleChunks(): Promise<number> {
    return 0;
  }

  async claimJourney(id: Hex): Promise<boolean> {
    if (
      id !== this.state.journey.journeyId ||
      !["CREATED", "FAILED_RETRYABLE"].includes(this.state.journey.status)
    ) {
      return false;
    }
    this.state.journey.status = "GENERATING";
    return true;
  }

  async renewJourneyLease(): Promise<boolean> {
    return true;
  }

  async getJourneyBundle(): Promise<JourneyBundle> {
    return structuredClone(this.state);
  }

  async claimChunk(
    _journeyId: Hex,
    chunkId: number,
    workerAddress: `0x${string}`,
  ): Promise<boolean> {
    const chunk = this.state.chunks[chunkId];
    if (!chunk || !["QUEUED", "RETRYABLE"].includes(chunk.status) || chunk.attempt >= 2) {
      return false;
    }
    chunk.status = "GENERATING";
    chunk.workerAddress = workerAddress;
    chunk.attempt += 1;
    return true;
  }

  async markChunkValidating(_journeyId: Hex, chunkId: number): Promise<void> {
    this.state.chunks[chunkId]!.status = "VALIDATING";
  }

  async saveChunkResult(
    _journeyId: Hex,
    chunkId: number,
    result: SavedChunkResult,
  ): Promise<void> {
    const chunk = this.state.chunks[chunkId]!;
    chunk.cards = structuredClone(result.cards);
    chunk.cardsRoot = result.cardsRoot;
    chunk.cardCount = result.cards.length;
    chunk.status = "SAVED";
  }

  async markChunkSubmitting(_journeyId: Hex, chunkId: number, txHash: Hex): Promise<void> {
    const chunk = this.state.chunks[chunkId]!;
    chunk.status = "SUBMITTING";
    chunk.commitTxHash = txHash;
  }

  async markChunkConfirmed(
    _journeyId: Hex,
    chunkId: number,
    confirmation: { txHash: Hex | null },
  ): Promise<void> {
    const chunk = this.state.chunks[chunkId]!;
    chunk.status = "CONFIRMED";
    if (confirmation.txHash) chunk.commitTxHash = confirmation.txHash;
  }

  async markChunkRetryable(
    _journeyId: Hex,
    chunkId: number,
  ): Promise<void> {
    const chunk = this.state.chunks[chunkId]!;
    chunk.status = chunk.cardsRoot ? "SAVED" : "RETRYABLE";
  }

  async claimFinalization(): Promise<boolean> {
    if (
      !["GENERATING", "FINALIZING"].includes(this.state.journey.status) ||
      this.state.chunks.some((chunk) => chunk.status !== "CONFIRMED")
    ) {
      return false;
    }
    this.state.journey.status = "FINALIZING";
    return true;
  }

  async saveFinalization(_journeyId: Hex, record: FinalizationRecord): Promise<void> {
    this.state.journey.deck = structuredClone(record.deck);
    this.state.journey.provenance = structuredClone(record.provenance);
    this.state.journey.deckRoot = record.deckRoot;
    this.state.journey.plan = structuredClone(record.plan);
    this.state.journey.planHash = record.planHash;
  }

  async markJourneyReady(_id: Hex, txHash: Hex | null): Promise<void> {
    this.state.journey.status = "READY";
    if (txHash) this.state.journey.finalizeTxHash = txHash;
  }

  async markJourneyRetryable(): Promise<void> {
    this.state.journey.status = "FAILED_RETRYABLE";
  }

  async recordAgentEvent(event: { type: string; chunkId?: number }): Promise<void> {
    this.events.push({ type: event.type, ...(event.chunkId === undefined ? {} : { chunkId: event.chunkId }) });
  }
}

export class FakeRegistry implements RegistryGateway {
  readonly commitments = new Map<number, ChainChunkCommitment>();
  readonly transactionStates = new Map<
    Hex,
    "PENDING" | "SUCCESS" | "REVERTED" | "NOT_FOUND"
  >();
  readonly commitInputs: Array<{ workerIndex: number; cardsRoot: Hex; cardCount: number }> = [];
  finalizeCount = 0;
  journey: ChainJourneyState = {
    status: "CREATED",
    deckRoot: null,
    planHash: null,
    totalCardCount: 0,
  };

  workerAddress(index: number): `0x${string}` {
    const value = workerAddresses[index];
    if (!value) throw new RangeError("Unknown Worker");
    return value;
  }

  coordinatorAddress(): `0x${string}` {
    return address("5");
  }

  async assertConfiguredWallets(): Promise<void> {}

  async readJourney(): Promise<ChainJourneyState | null> {
    return structuredClone(this.journey);
  }

  async readTransactionStatus(
    txHash: Hex,
  ): Promise<"PENDING" | "SUCCESS" | "REVERTED" | "NOT_FOUND"> {
    return this.transactionStates.get(txHash) ?? "NOT_FOUND";
  }

  async readChunk(_journeyId: Hex, chunkId: number): Promise<ChainChunkCommitment | null> {
    return structuredClone(this.commitments.get(chunkId) ?? null);
  }

  async commitChunk(
    workerIndex: number,
    input: {
      journeyId: Hex;
      chunkId: number;
      sourceChunkHash: Hex;
      cardsRoot: Hex;
      cardCount: number;
      manifestProof: Hex[];
    },
    onSubmitted?: (txHash: Hex) => Promise<void>,
  ): Promise<ChainReceipt> {
    const txHash = hex((this.commitInputs.length + 1).toString(16));
    this.commitInputs.push({ workerIndex, cardsRoot: input.cardsRoot, cardCount: input.cardCount });
    await onSubmitted?.(txHash);
    this.transactionStates.set(txHash, "SUCCESS");
    this.commitments.set(input.chunkId, {
      sourceChunkHash: input.sourceChunkHash,
      cardsRoot: input.cardsRoot,
      agent: this.workerAddress(workerIndex),
      committedBlock: BigInt(100 + input.chunkId),
      cardCount: input.cardCount,
    });
    return { txHash, blockNumber: 100n, gasUsed: 80_000n, confirmationMs: 25 };
  }

  async finalizeDeck(input: {
    journeyId: Hex;
    deckRoot: Hex;
    planHash: Hex;
    totalCardCount: number;
  }): Promise<ChainReceipt> {
    this.finalizeCount += 1;
    this.journey = {
      status: "READY",
      deckRoot: input.deckRoot,
      planHash: input.planHash,
      totalCardCount: input.totalCardCount,
    };
    return { txHash: hex("f"), blockNumber: 200n, gasUsed: 90_000n, confirmationMs: 30 };
  }

  async getJourneyCreatedIds(): Promise<Hex[]> {
    return [];
  }

  watchJourneyCreated(): () => void {
    return () => undefined;
  }
}
