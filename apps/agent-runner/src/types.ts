import type {
  CardProvenance,
  CommittedKnowledgeCard,
  KnowledgeCardContent,
  ReviewPlan,
  SourcePage,
} from "@mindmark/shared";
import type { Hex } from "viem";

export type AgentRole =
  | "coordinator"
  | "worker-0"
  | "worker-1"
  | "worker-2"
  | "finalizer";

export type JourneyStatus =
  | "PREPARING"
  | "AWAITING_CREATE_TX"
  | "CREATED"
  | "GENERATING"
  | "FINALIZING"
  | "FAILED_RETRYABLE"
  | "READY"
  | "CANCELLED";

export type ChunkStatus =
  | "QUEUED"
  | "GENERATING"
  | "VALIDATING"
  | "SAVED"
  | "SUBMITTING"
  | "CONFIRMED"
  | "MERGED"
  | "RETRYABLE";

export type RunnerJourney = {
  journeyId: Hex;
  learnerAddress: `0x${string}`;
  goal: string | null;
  sourceHash: Hex;
  goalHash: Hex;
  chunkManifestRoot: Hex;
  chunkCount: number;
  status: JourneyStatus;
  deck: CommittedKnowledgeCard[] | null;
  provenance: Record<Hex, CardProvenance> | null;
  deckRoot: Hex | null;
  plan: ReviewPlan | null;
  planHash: Hex | null;
  finalizeTxHash: Hex | null;
};

export type RunnerChunk = {
  journeyId: Hex;
  chunkId: number;
  pageStart: number;
  pageEnd: number;
  title: string;
  sourceText: string | null;
  sourcePages: SourcePage[] | null;
  sourceChunkHash: Hex;
  manifestProof: Hex[];
  cardBudget: number;
  workerAddress: `0x${string}` | null;
  attempt: number;
  status: ChunkStatus;
  cards: CommittedKnowledgeCard[];
  cardsRoot: Hex | null;
  cardCount: number | null;
  commitTxHash: Hex | null;
};

export type JourneyBundle = {
  journey: RunnerJourney;
  chunks: RunnerChunk[];
};

export type SavedChunkResult = {
  cards: CommittedKnowledgeCard[];
  cardsRoot: Hex;
  generationMs: number;
};

export type FinalizationRecord = {
  deck: CommittedKnowledgeCard[];
  provenance: Record<Hex, CardProvenance>;
  deckRoot: Hex;
  plan: ReviewPlan;
  planHash: Hex;
};

export interface RunnerRepository {
  listRecoverableJourneyIds(): Promise<Hex[]>;
  recoverStaleChunks(): Promise<number>;
  claimJourney(journeyId: Hex): Promise<boolean>;
  renewJourneyLease(journeyId: Hex): Promise<boolean>;
  getJourneyBundle(journeyId: Hex): Promise<JourneyBundle>;
  claimChunk(
    journeyId: Hex,
    chunkId: number,
    workerAddress: `0x${string}`,
  ): Promise<boolean>;
  markChunkValidating(journeyId: Hex, chunkId: number): Promise<void>;
  saveChunkResult(
    journeyId: Hex,
    chunkId: number,
    result: SavedChunkResult,
  ): Promise<void>;
  markChunkSubmitting(journeyId: Hex, chunkId: number, txHash: Hex): Promise<void>;
  markChunkConfirmed(
    journeyId: Hex,
    chunkId: number,
    confirmation: {
      txHash: Hex | null;
      blockNumber: bigint;
      gasUsed: bigint | null;
      confirmationMs: number;
    },
  ): Promise<void>;
  markChunkRetryable(journeyId: Hex, chunkId: number, message: string): Promise<void>;
  claimFinalization(journeyId: Hex): Promise<boolean>;
  saveFinalization(journeyId: Hex, record: FinalizationRecord): Promise<void>;
  markJourneyReady(journeyId: Hex, txHash: Hex | null, blockNumber: bigint): Promise<void>;
  markJourneyRetryable(journeyId: Hex, message: string): Promise<void>;
  recordAgentEvent(event: {
    journeyId: Hex;
    chunkId?: number;
    role: AgentRole;
    type: string;
    payload?: Record<string, unknown>;
    txHash?: Hex;
  }): Promise<void>;
}

export type ChainChunkCommitment = {
  sourceChunkHash: Hex;
  cardsRoot: Hex;
  agent: `0x${string}`;
  committedBlock: bigint;
  cardCount: number;
};

export type ChainReceipt = {
  txHash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
  confirmationMs: number;
};

export type ChainJourneyState = {
  status: "CREATED" | "READY" | "CANCELLED";
  deckRoot: Hex | null;
  planHash: Hex | null;
  totalCardCount: number;
};

export interface RegistryGateway {
  workerAddress(workerIndex: number): `0x${string}`;
  coordinatorAddress(): `0x${string}`;
  assertConfiguredWallets(): Promise<void>;
  readJourney(journeyId: Hex): Promise<ChainJourneyState | null>;
  readTransactionStatus(
    txHash: Hex,
  ): Promise<"PENDING" | "SUCCESS" | "REVERTED" | "NOT_FOUND">;
  readChunk(journeyId: Hex, chunkId: number): Promise<ChainChunkCommitment | null>;
  commitChunk(
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
  ): Promise<ChainReceipt>;
  finalizeDeck(input: {
    journeyId: Hex;
    deckRoot: Hex;
    planHash: Hex;
    totalCardCount: number;
  }): Promise<ChainReceipt>;
  getJourneyCreatedIds(fromBlock: bigint): Promise<Hex[]>;
  watchJourneyCreated(onJourney: (journeyId: Hex) => void): () => void;
}

export type AgentToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type AgentToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

export type AgentTranscriptEntry = {
  call: AgentToolCall;
  result: unknown;
};

export interface ToolCallingModel {
  nextTool(input: {
    system: string;
    task: string;
    tools: AgentToolDefinition[];
    transcript: AgentTranscriptEntry[];
    signal: AbortSignal;
  }): Promise<AgentToolCall>;
}

export type WorkerDraft = KnowledgeCardContent[];
