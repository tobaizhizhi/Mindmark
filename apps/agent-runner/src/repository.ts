import {
  AddressSchema,
  Bytes32Schema,
  CardProvenanceSchema,
  CommittedKnowledgeCardSchema,
  ReviewPlanSchema,
  SourcePageSchema,
} from "@mindmark/shared";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Hex, TransactionSerialized } from "viem";
import type {
  AgentRole,
  FinalizationRecord,
  JourneyBundle,
  JourneyStatus,
  RunnerChunk,
  RunnerRepository,
  SavedChunkResult,
  PreparedWorkerReward,
  WorkerReward,
  WorkerRewardRepository,
  WorkerRewardReceipt,
  WorkerRewardStatus,
  MossRewardStage,
} from "./types.js";

const JourneyRowSchema = z.object({
  journey_id: Bytes32Schema,
  learner_address: AddressSchema,
  goal: z.string().nullable(),
  source_hash: Bytes32Schema,
  goal_hash: Bytes32Schema,
  chunk_manifest_root: Bytes32Schema,
  chunk_count: z.number().int(),
  status: z.string(),
  deck: z.unknown().nullable(),
  card_provenance: z.unknown().nullable(),
  deck_root: Bytes32Schema.nullable(),
  plan: z.unknown().nullable(),
  plan_hash: Bytes32Schema.nullable(),
  finalize_tx_hash: Bytes32Schema.nullable(),
});

const ChunkRowSchema = z.object({
  journey_id: Bytes32Schema,
  chunk_id: z.number().int(),
  page_start: z.number().int(),
  page_end: z.number().int(),
  title: z.string(),
  source_text: z.string().nullable(),
  source_pages: z.unknown().nullable(),
  source_chunk_hash: Bytes32Schema,
  manifest_proof: z.unknown(),
  card_budget: z.number().int(),
  worker_address: AddressSchema.nullable(),
  attempt: z.number().int(),
  status: z.string(),
  cards: z.unknown(),
  cards_root: Bytes32Schema.nullable(),
  card_count: z.number().int().nullable(),
  commit_tx_hash: Bytes32Schema.nullable(),
});

const RewardRowSchema = z.object({
  journey_id: Bytes32Schema,
  chunk_id: z.number().int(),
  treasury_address: AddressSchema,
  recipient_address: AddressSchema,
  amount_wei: z.union([z.string(), z.number()]),
  status: z.string(),
  attempt: z.number().int(),
  moss_stage: z.string(),
  moss_plan_hash: Bytes32Schema.nullable(),
  simulation_status: z.string(),
  simulation_warning_codes: z.unknown(),
  simulation_gas: z.union([z.string(), z.number()]).nullable(),
  signed_transaction: z.string().nullable(),
  treasury_nonce: z.union([z.string(), z.number()]).nullable(),
  tx_hash: Bytes32Schema.nullable(),
});

const journeyStatuses = new Set<JourneyStatus>([
  "PREPARING",
  "AWAITING_CREATE_TX",
  "CREATED",
  "GENERATING",
  "FINALIZING",
  "FAILED_RETRYABLE",
  "READY",
  "CANCELLED",
]);

const chunkStatuses = new Set<RunnerChunk["status"]>([
  "QUEUED",
  "GENERATING",
  "VALIDATING",
  "SAVED",
  "SUBMITTING",
  "CONFIRMED",
  "MERGED",
  "RETRYABLE",
]);

const rewardStatuses = new Set<WorkerRewardStatus>([
  "PENDING",
  "PROCESSING",
  "PREPARED",
  "SUBMITTING",
  "CONFIRMED",
  "RETRYABLE",
  "BLOCKED",
]);
const rewardStages = new Set<MossRewardStage>([
  "PENDING",
  "DISCOVERED",
  "LOADED",
  "BUILT",
  "SIMULATED",
]);

const allowedEventPayloadKeys = new Set([
  "attempt",
  "blockNumber",
  "cardCount",
  "confirmationMs",
  "gasUsed",
  "recovered",
  "selectedCount",
  "status",
  "workerIndex",
]);

function parseJourneyStatus(value: string): JourneyStatus {
  if (!journeyStatuses.has(value as JourneyStatus)) {
    throw new Error(`Unknown Journey status: ${value}`);
  }
  return value as JourneyStatus;
}

function parseChunkStatus(value: string): RunnerChunk["status"] {
  if (!chunkStatuses.has(value as RunnerChunk["status"])) {
    throw new Error(`Unknown chunk status: ${value}`);
  }
  return value as RunnerChunk["status"];
}

function parseReward(value: Record<string, unknown>): WorkerReward {
  const row = RewardRowSchema.parse(value);
  if (!rewardStatuses.has(row.status as WorkerRewardStatus)) {
    throw new Error(`Unknown Worker reward status: ${row.status}`);
  }
  if (!rewardStages.has(row.moss_stage as MossRewardStage)) {
    throw new Error(`Unknown Moss reward stage: ${row.moss_stage}`);
  }
  const warningCodes = z.array(z.string().max(80)).parse(row.simulation_warning_codes);
  return {
    journeyId: row.journey_id,
    chunkId: row.chunk_id,
    treasuryAddress: row.treasury_address,
    recipientAddress: row.recipient_address,
    amountWei: BigInt(row.amount_wei),
    status: row.status as WorkerRewardStatus,
    attempt: row.attempt,
    mossStage: row.moss_stage as MossRewardStage,
    mossPlanHash: row.moss_plan_hash,
    simulationStatus: row.simulation_status as WorkerReward["simulationStatus"],
    simulationWarningCodes: warningCodes,
    simulationGas: row.simulation_gas === null ? null : BigInt(row.simulation_gas),
    signedTransaction: row.signed_transaction as TransactionSerialized | null,
    treasuryNonce: row.treasury_nonce === null ? null : BigInt(row.treasury_nonce),
    txHash: row.tx_hash,
  };
}

function assertEventPayload(payload: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(payload)) {
    if (!allowedEventPayloadKeys.has(key)) {
      throw new Error(`Agent event payload key is not allowlisted: ${key}`);
    }
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(`Agent event payload value must be scalar: ${key}`);
    }
  }
}

function errorMessage(error: { message: string } | null, operation: string): string {
  return error ? `${operation}: ${error.message}` : `${operation}: no row was updated`;
}

export class SupabaseRunnerRepository implements RunnerRepository, WorkerRewardRepository {
  static connect(
    url: string,
    serviceRoleKey: string,
    rewardIntent: { treasuryAddress: `0x${string}`; amountWei: bigint },
  ): SupabaseRunnerRepository {
    return new SupabaseRunnerRepository(
      createClient(url, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      }),
      rewardIntent,
    );
  }

  constructor(
    private readonly client: SupabaseClient,
    private readonly rewardIntent: { treasuryAddress: `0x${string}`; amountWei: bigint },
  ) {}

  async listRecoverableJourneyIds(): Promise<Hex[]> {
    const { data, error } = await this.client
      .from("learning_journeys")
      .select("journey_id,status,runner_lease_until")
      .in("status", ["CREATED", "FAILED_RETRYABLE", "GENERATING", "FINALIZING"]);
    if (error) throw new Error(errorMessage(error, "list recoverable Journeys"));
    const now = Date.now();
    return (data ?? [])
      .filter((row) => {
        if (row.status === "CREATED" || row.status === "FAILED_RETRYABLE") return true;
        return !row.runner_lease_until || Date.parse(String(row.runner_lease_until)) < now;
      })
      .map((row) => Bytes32Schema.parse(row.journey_id));
  }

  async recoverStaleChunks(): Promise<number> {
    const { data, error } = await this.client.rpc("recover_stale_chunks");
    if (error) throw new Error(errorMessage(error, "recover stale chunks"));
    return Number(data ?? 0);
  }

  async claimJourney(journeyId: Hex): Promise<boolean> {
    const { data, error } = await this.client.rpc("claim_journey_generation", {
      p_journey_id: journeyId,
    });
    if (error) throw new Error(errorMessage(error, "claim Journey"));
    return data === true;
  }

  async renewJourneyLease(journeyId: Hex): Promise<boolean> {
    const { data, error } = await this.client.rpc("renew_journey_lease", {
      p_journey_id: journeyId,
    });
    if (error) throw new Error(errorMessage(error, "renew Journey lease"));
    return data === true;
  }

  async getJourneyBundle(journeyId: Hex): Promise<JourneyBundle> {
    const [journeyResult, chunksResult] = await Promise.all([
      this.client
        .from("learning_journeys")
        .select("*")
        .eq("journey_id", journeyId)
        .maybeSingle(),
      this.client
        .from("source_chunks")
        .select("*")
        .eq("journey_id", journeyId)
        .order("chunk_id"),
    ]);
    if (journeyResult.error || !journeyResult.data) {
      throw new Error(errorMessage(journeyResult.error, "load Journey"));
    }
    if (chunksResult.error) {
      throw new Error(errorMessage(chunksResult.error, "load chunks"));
    }

    const row = JourneyRowSchema.parse(journeyResult.data);
    const deck = row.deck === null ? null : CommittedKnowledgeCardSchema.array().parse(row.deck);
    const provenance =
      row.card_provenance === null
        ? null
        : z.record(Bytes32Schema, CardProvenanceSchema).parse(row.card_provenance);
    const plan = row.plan === null ? null : ReviewPlanSchema.parse(row.plan);
    const chunks = (chunksResult.data ?? []).map((value): RunnerChunk => {
      const chunk = ChunkRowSchema.parse(value);
      return {
        journeyId: chunk.journey_id,
        chunkId: chunk.chunk_id,
        pageStart: chunk.page_start,
        pageEnd: chunk.page_end,
        title: chunk.title,
        sourceText: chunk.source_text,
        sourcePages:
          chunk.source_pages === null
            ? null
            : SourcePageSchema.array().parse(chunk.source_pages),
        sourceChunkHash: chunk.source_chunk_hash,
        manifestProof: Bytes32Schema.array().parse(chunk.manifest_proof),
        cardBudget: chunk.card_budget,
        workerAddress: chunk.worker_address,
        attempt: chunk.attempt,
        status: parseChunkStatus(chunk.status),
        cards: CommittedKnowledgeCardSchema.array().parse(chunk.cards),
        cardsRoot: chunk.cards_root,
        cardCount: chunk.card_count,
        commitTxHash: chunk.commit_tx_hash,
      };
    });
    return {
      journey: {
        journeyId: row.journey_id,
        learnerAddress: row.learner_address,
        goal: row.goal,
        sourceHash: row.source_hash,
        goalHash: row.goal_hash,
        chunkManifestRoot: row.chunk_manifest_root,
        chunkCount: row.chunk_count,
        status: parseJourneyStatus(row.status),
        deck,
        provenance,
        deckRoot: row.deck_root,
        plan,
        planHash: row.plan_hash,
        finalizeTxHash: row.finalize_tx_hash,
      },
      chunks,
    };
  }

  async claimChunk(
    journeyId: Hex,
    chunkId: number,
    workerAddress: `0x${string}`,
  ): Promise<boolean> {
    const { data, error } = await this.client.rpc("claim_chunk_generation", {
      p_journey_id: journeyId,
      p_chunk_id: chunkId,
      p_worker_address: workerAddress,
    });
    if (error) throw new Error(errorMessage(error, "claim chunk"));
    return data === true;
  }

  async markChunkValidating(journeyId: Hex, chunkId: number): Promise<void> {
    const { data, error } = await this.client
      .from("source_chunks")
      .update({
        status: "VALIDATING",
        chunk_lease_until: new Date(Date.now() + 60_000).toISOString(),
      })
      .eq("journey_id", journeyId)
      .eq("chunk_id", chunkId)
      .eq("status", "GENERATING")
      .select("chunk_id")
      .maybeSingle();
    if (error || !data) throw new Error(errorMessage(error, "mark chunk validating"));
  }

  async saveChunkResult(
    journeyId: Hex,
    chunkId: number,
    result: SavedChunkResult,
  ): Promise<void> {
    const { data, error } = await this.client
      .from("source_chunks")
      .update({
        cards: result.cards,
        cards_root: result.cardsRoot,
        card_count: result.cards.length,
        generation_ms: result.generationMs,
        status: "SAVED",
        chunk_lease_until: null,
        last_error: null,
      })
      .eq("journey_id", journeyId)
      .eq("chunk_id", chunkId)
      .in("status", ["GENERATING", "VALIDATING"])
      .select("chunk_id")
      .maybeSingle();
    if (error || !data) throw new Error(errorMessage(error, "save chunk result"));
  }

  async markChunkSubmitting(journeyId: Hex, chunkId: number, txHash: Hex): Promise<void> {
    const { error } = await this.client
      .from("source_chunks")
      .update({ status: "SUBMITTING", commit_tx_hash: txHash, last_error: null })
      .eq("journey_id", journeyId)
      .eq("chunk_id", chunkId)
      .in("status", ["SAVED", "SUBMITTING"]);
    if (error) throw new Error(errorMessage(error, "mark chunk submitting"));
  }

  async markChunkConfirmed(
    journeyId: Hex,
    chunkId: number,
    confirmation: {
      txHash: Hex | null;
      blockNumber: bigint;
      gasUsed: bigint | null;
      confirmationMs: number;
    },
  ): Promise<void> {
    const { error } = await this.client.rpc("confirm_chunk_and_enqueue_reward", {
      p_journey_id: journeyId,
      p_chunk_id: chunkId,
      p_tx_hash: confirmation.txHash,
      p_block_number: confirmation.blockNumber.toString(),
      p_gas_used: confirmation.gasUsed?.toString() ?? null,
      p_confirmation_ms: confirmation.confirmationMs,
      p_treasury_address: this.rewardIntent.treasuryAddress,
      p_amount_wei: this.rewardIntent.amountWei.toString(),
    });
    if (error) throw new Error(errorMessage(error, "mark chunk confirmed"));
  }

  async markChunkRetryable(journeyId: Hex, chunkId: number, message: string): Promise<void> {
    const { error } = await this.client.rpc("mark_chunk_retryable", {
      p_journey_id: journeyId,
      p_chunk_id: chunkId,
      p_error: message.slice(0, 500),
    });
    if (error) throw new Error(errorMessage(error, "mark chunk retryable"));
  }

  async claimFinalization(journeyId: Hex): Promise<boolean> {
    const { data, error } = await this.client.rpc("claim_journey_finalization", {
      p_journey_id: journeyId,
    });
    if (error) throw new Error(errorMessage(error, "claim finalization"));
    return data === true;
  }

  async saveFinalization(journeyId: Hex, record: FinalizationRecord): Promise<void> {
    const { data, error } = await this.client
      .from("learning_journeys")
      .update({
        deck: record.deck,
        card_provenance: record.provenance,
        deck_root: record.deckRoot,
        plan: record.plan,
        plan_hash: record.planHash,
        plan_version: record.plan.version,
        runner_error: null,
      })
      .eq("journey_id", journeyId)
      .eq("status", "FINALIZING")
      .select("journey_id")
      .maybeSingle();
    if (error || !data) throw new Error(errorMessage(error, "save finalization"));
  }

  async markJourneyReady(
    journeyId: Hex,
    txHash: Hex | null,
    blockNumber: bigint,
  ): Promise<void> {
    const chunks = await this.client
      .from("source_chunks")
      .update({ status: "MERGED" })
      .eq("journey_id", journeyId)
      .eq("status", "CONFIRMED");
    if (chunks.error) throw new Error(errorMessage(chunks.error, "mark chunks merged"));
    const updates: Record<string, unknown> = {
      status: "READY",
      runner_lease_until: null,
      runner_error: null,
    };
    if (txHash) updates.finalize_tx_hash = txHash;
    const { data, error } = await this.client
      .from("learning_journeys")
      .update(updates)
      .eq("journey_id", journeyId)
      .eq("status", "FINALIZING")
      .select("journey_id")
      .maybeSingle();
    if (error || !data) throw new Error(errorMessage(error, "mark Journey ready"));
    await this.recordAgentEvent({
      journeyId,
      role: "coordinator",
      type: "deck_confirmed",
      payload: { blockNumber: blockNumber.toString() },
      ...(txHash ? { txHash } : {}),
    });
  }

  async markJourneyRetryable(journeyId: Hex, message: string): Promise<void> {
    const { error } = await this.client
      .from("learning_journeys")
      .update({
        status: "FAILED_RETRYABLE",
        runner_lease_until: null,
        runner_error: message.slice(0, 500),
      })
      .eq("journey_id", journeyId)
      .in("status", ["GENERATING", "FINALIZING"]);
    if (error) throw new Error(errorMessage(error, "mark Journey retryable"));
  }

  async recordAgentEvent(event: {
    journeyId: Hex;
    chunkId?: number;
    role: AgentRole;
    type: string;
    payload?: Record<string, unknown>;
    txHash?: Hex;
  }): Promise<void> {
    const payload = event.payload ?? {};
    assertEventPayload(payload);
    const { error } = await this.client.from("agent_events").insert({
      journey_id: event.journeyId,
      chunk_id: event.chunkId ?? null,
      agent_role: event.role,
      event_type: event.type,
      payload,
      tx_hash: event.txHash ?? null,
    });
    if (error) throw new Error(errorMessage(error, "record agent event"));
  }

  async claimNextWorkerReward(): Promise<WorkerReward | null> {
    const { data, error } = await this.client.rpc("claim_worker_reward");
    if (error) throw new Error(errorMessage(error, "claim Worker reward"));
    const rows = z.array(z.record(z.string(), z.unknown())).parse(data ?? []);
    return rows[0] ? parseReward(rows[0]) : null;
  }

  async markWorkerRewardStage(
    journeyId: Hex,
    chunkId: number,
    stage: Exclude<MossRewardStage, "PENDING" | "SIMULATED">,
  ): Promise<void> {
    const { error } = await this.client
      .from("worker_rewards")
      .update({
        moss_stage: stage,
        [`${stage.toLowerCase()}_at`]: new Date().toISOString(),
      })
      .eq("journey_id", journeyId)
      .eq("chunk_id", chunkId);
    if (error) throw new Error(errorMessage(error, "record Moss reward stage"));
  }

  async markWorkerRewardPrepared(
    journeyId: Hex,
    chunkId: number,
    prepared: PreparedWorkerReward,
  ): Promise<void> {
    const { error } = await this.client
      .from("worker_rewards")
      .update({
        status: "PREPARED",
        moss_stage: "SIMULATED",
        simulation_status: "PASSED",
        simulated_at: new Date().toISOString(),
        simulation_warning_codes: prepared.simulationWarningCodes,
        simulation_warning_count: prepared.simulationWarningCodes.length,
        simulation_gas: prepared.simulationGas?.toString() ?? null,
        moss_plan_hash: prepared.mossPlanHash,
        signed_transaction: prepared.signedTransaction,
        treasury_nonce: prepared.treasuryNonce.toString(),
        tx_hash: prepared.txHash,
        last_error: null,
      })
      .eq("journey_id", journeyId)
      .eq("chunk_id", chunkId);
    if (error) throw new Error(errorMessage(error, "persist prepared Worker reward"));
  }

  async markWorkerRewardSubmitting(journeyId: Hex, chunkId: number, txHash: Hex): Promise<void> {
    const { error } = await this.client
      .from("worker_rewards")
      .update({ status: "SUBMITTING", tx_hash: txHash, submitted_at: new Date().toISOString() })
      .eq("journey_id", journeyId)
      .eq("chunk_id", chunkId)
      .in("status", ["PREPARED", "SUBMITTING"]);
    if (error) throw new Error(errorMessage(error, "mark Worker reward submitting"));
  }

  async markWorkerRewardConfirmed(
    journeyId: Hex,
    chunkId: number,
    receipt: WorkerRewardReceipt,
  ): Promise<void> {
    const { error } = await this.client
      .from("worker_rewards")
      .update({
        status: "CONFIRMED",
        tx_hash: receipt.txHash,
        confirmed_block: receipt.blockNumber.toString(),
        gas_used: receipt.gasUsed.toString(),
        confirmation_ms: receipt.confirmationMs,
        lease_until: null,
        last_error: null,
      })
      .eq("journey_id", journeyId)
      .eq("chunk_id", chunkId);
    if (error) throw new Error(errorMessage(error, "mark Worker reward confirmed"));
  }

  async markWorkerRewardRetryable(journeyId: Hex, chunkId: number, message: string): Promise<void> {
    const { error } = await this.client.rpc("release_worker_reward", {
      p_journey_id: journeyId,
      p_chunk_id: chunkId,
      p_error: message.slice(0, 500),
    });
    if (error) throw new Error(errorMessage(error, "mark Worker reward retryable"));
  }

  async markWorkerRewardBlocked(
    journeyId: Hex,
    chunkId: number,
    message: string,
    warningCodes: string[] = [],
  ): Promise<void> {
    const { error } = await this.client
      .from("worker_rewards")
      .update({
        status: "BLOCKED",
        moss_stage: "SIMULATED",
        simulation_status: "FAILED",
        simulated_at: new Date().toISOString(),
        simulation_warning_codes: warningCodes,
        simulation_warning_count: warningCodes.length,
        lease_until: null,
        last_error: message.slice(0, 500),
      })
      .eq("journey_id", journeyId)
      .eq("chunk_id", chunkId);
    if (error) throw new Error(errorMessage(error, "block Worker reward"));
  }
}
