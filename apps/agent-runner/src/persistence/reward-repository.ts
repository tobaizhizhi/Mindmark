import type { SupabaseClient } from "@supabase/supabase-js";
import type { Hex } from "viem";
import type { PreparedWorkerReward, WorkerRewardReceipt } from "../runtime-types.js";
import type { WorkUnitRewardRepositoryV2 } from "../types-v2.js";
import { persistenceError } from "./shared.js";

export class SupabaseRewardRepositoryV2 implements WorkUnitRewardRepositoryV2 {
  constructor(private readonly client: SupabaseClient) {}

  async markWorkUnitRewardStage(projectId: Hex, workUnitId: number, stage: "DISCOVERED" | "LOADED" | "BUILT"): Promise<void> {
    const { error } = await this.client.from("work_unit_rewards")
      .update({ moss_stage: stage, lease_until: new Date(Date.now() + 90_000).toISOString() })
      .eq("project_id", projectId).eq("work_unit_id", workUnitId);
    if (error) throw new Error(persistenceError(error, "advance V2 Moss reward stage"));
  }

  async markWorkUnitRewardPrepared(projectId: Hex, workUnitId: number, prepared: PreparedWorkerReward): Promise<void> {
    const { error } = await this.client.from("work_unit_rewards").update({
      status: "PREPARED", moss_stage: "SIMULATED", moss_plan_hash: prepared.mossPlanHash,
      simulation_status: "PASSED", simulation_warning_codes: prepared.simulationWarningCodes,
      simulation_gas: prepared.simulationGas?.toString() ?? null,
      signed_transaction: prepared.signedTransaction, treasury_nonce: prepared.treasuryNonce.toString(),
      tx_hash: prepared.txHash, lease_until: new Date(Date.now() + 90_000).toISOString(), last_error: null,
    }).eq("project_id", projectId).eq("work_unit_id", workUnitId);
    if (error) throw new Error(persistenceError(error, "persist prepared V2 Moss reward"));
  }

  async markWorkUnitRewardSubmitting(projectId: Hex, workUnitId: number, txHash: Hex): Promise<void> {
    const { error } = await this.client.from("work_unit_rewards").update({
      status: "SUBMITTING", tx_hash: txHash,
      lease_until: new Date(Date.now() + 90_000).toISOString(), last_error: null,
    }).eq("project_id", projectId).eq("work_unit_id", workUnitId);
    if (error) throw new Error(persistenceError(error, "mark V2 Moss reward submitting"));
  }

  async markWorkUnitRewardConfirmed(projectId: Hex, workUnitId: number, receipt: WorkerRewardReceipt): Promise<void> {
    const { data, error } = await this.client.rpc("confirm_escrow_reward_settlement_v1", {
      p_project_id: projectId,
      p_work_unit_id: workUnitId,
      p_tx_hash: receipt.txHash,
      p_confirmed_block: receipt.blockNumber.toString(),
      p_gas_used: receipt.gasUsed.toString(),
      p_confirmation_ms: receipt.confirmationMs,
    });
    if (error || data !== true) throw new Error(persistenceError(error, "confirm V2 Moss Escrow reward"));
  }

  async markWorkUnitRewardRetryable(projectId: Hex, workUnitId: number, message: string): Promise<void> {
    const { error } = await this.client.rpc("release_work_unit_reward_v2", { p_project_id: projectId, p_work_unit_id: workUnitId, p_error: message.slice(0, 500) });
    if (error) throw new Error(persistenceError(error, "release V2 Moss reward"));
  }

  async markWorkUnitRewardBlocked(projectId: Hex, workUnitId: number, message: string, warningCodes: string[] = []): Promise<void> {
    const { error } = await this.client.from("work_unit_rewards").update({
      status: "BLOCKED",
      ...(warningCodes.length > 0 ? { simulation_status: "FAILED" } : {}),
      simulation_warning_codes: warningCodes,
      lease_until: null, last_error: message.slice(0, 500),
    }).eq("project_id", projectId).eq("work_unit_id", workUnitId);
    if (error) throw new Error(persistenceError(error, "block invalid V2 Moss reward"));
  }
}
