import type { KnowledgeCardContent } from "@mindmark/shared";
import type { Hex, TransactionSerialized } from "viem";

export const DEFAULT_AI_TOOL_TIMEOUT_MS = 120_000;

export type WorkerRewardStatus =
  | "PENDING"
  | "PROCESSING"
  | "PREPARED"
  | "SUBMITTING"
  | "CONFIRMED"
  | "RETRYABLE"
  | "BLOCKED";

export type MossRewardStage =
  | "PENDING"
  | "DISCOVERED"
  | "LOADED"
  | "BUILT"
  | "SIMULATED";

export type PreparedWorkerReward = {
  treasuryAddress: `0x${string}`;
  recipientAddress: `0x${string}`;
  amountWei: bigint;
  mossPlanHash: Hex;
  simulationWarningCodes: string[];
  simulationGas: bigint | null;
  signedTransaction: TransactionSerialized;
  treasuryNonce: bigint;
  txHash: Hex;
};

export type WorkerRewardReceipt = {
  txHash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
  confirmationMs: number;
};

export type ChainReceipt = WorkerRewardReceipt;

export interface WorkerRewardGateway {
  treasuryAddress(): `0x${string}`;
  prepare(
    input: { recipientAddress: `0x${string}`; amountWei: bigint },
    onStage?: (stage: Exclude<MossRewardStage, "PENDING" | "SIMULATED">) => Promise<void>,
  ): Promise<PreparedWorkerReward>;
  settlePrepared(
    input: PreparedWorkerReward,
    onSubmitted?: (txHash: Hex) => Promise<void>,
  ): Promise<WorkerRewardReceipt>;
}

export type AgentToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type AgentToolCall = { id: string; name: string; arguments: unknown };

export type AgentTranscriptEntry = { call: AgentToolCall; result: unknown };

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
