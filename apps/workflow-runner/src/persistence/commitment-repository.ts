import { CardBlueprintSlotTypeSchema, WORK_UNIT_PRICING_POLICY_VERSION } from "@mindmark/shared";
import { AddressSchema, Bytes32Schema } from "@mindmark/shared/schemas";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Hex } from "viem";
import type {
  ChapterCommitmentRepositoryV2,
  ProjectAgentEventV2,
  ProjectCommitmentRepositoryV2,
  RegistryReconciliationRepositoryV2,
} from "../types-v2.js";
import {
  loadChapterBundle,
  loadProjectBundle,
  persistenceError,
  recordProjectAgentEvent,
} from "./shared.js";

export class SupabaseCommitmentRepositoryV2 implements
  RegistryReconciliationRepositoryV2,
  ChapterCommitmentRepositoryV2,
  ProjectCommitmentRepositoryV2 {
  constructor(private readonly client: SupabaseClient) {}

  async getPendingRegistryProject(projectId: Hex) {
    const [projectResult, slotsResult] = await Promise.all([
      this.client.from("learning_projects").select(
        "project_id,owner_address,source_hash,goal_hash,outline_hash,work_unit_manifest_root,chapters(count),work_units(work_unit_id,source_text,card_target)",
      ).in("status", ["AWAITING_REGISTRY", "GENERATING"])
        .eq("escrow_state", "UNFUNDED")
        .eq("project_id", projectId)
        .maybeSingle(),
      this.client.from("card_blueprint_slots")
        .select("assigned_work_unit_id,card_type,difficulty")
        .eq("project_id", projectId)
        .not("assigned_work_unit_id", "is", null),
    ]);
    const error = projectResult.error ?? slotsResult.error;
    if (error) throw new Error(persistenceError(error, "load V2 Registry reconciliation intent"));
    if (!projectResult.data) return null;
    const row = projectResult.data as unknown as {
      project_id: unknown;
      owner_address: unknown;
      source_hash: unknown;
      goal_hash: unknown;
      outline_hash: unknown;
      work_unit_manifest_root: unknown;
      chapters: Array<{ count: number }>;
      work_units: Array<{ work_unit_id: number; source_text: string | null; card_target: number }>;
    };
    const slotRows = (slotsResult.data ?? []) as unknown as Array<{
      assigned_work_unit_id: number;
      card_type: string;
      difficulty: number;
    }>;
    const units = [...row.work_units].sort((left, right) => left.work_unit_id - right.work_unit_id);
    const pricingInputs = units.map((unit) => {
      const slots = slotRows.filter((slot) => slot.assigned_work_unit_id === unit.work_unit_id).map((slot) => ({
        type: CardBlueprintSlotTypeSchema.parse(slot.card_type),
        difficulty: slot.difficulty,
      }));
      if (!unit.source_text || slots.length !== unit.card_target) {
        throw new Error(`Work Unit ${unit.work_unit_id} has incomplete frozen pricing evidence`);
      }
      return { workUnitId: unit.work_unit_id, sourceCharacterCount: unit.source_text.length, slots };
    });
    return {
      projectId: Bytes32Schema.parse(row.project_id),
      ownerAddress: AddressSchema.parse(row.owner_address),
      sourceHash: Bytes32Schema.parse(row.source_hash),
      goalHash: Bytes32Schema.parse(row.goal_hash),
      outlineHash: Bytes32Schema.parse(row.outline_hash),
      workUnitManifestRoot: Bytes32Schema.parse(row.work_unit_manifest_root),
      chapterCount: Number(row.chapters?.[0]?.count ?? 0),
      workUnitCount: units.length,
      pricingInputs,
    };
  }

  async markProjectRegistryReconciled(
    projectId: Hex,
    funding: Parameters<RegistryReconciliationRepositoryV2["markProjectRegistryReconciled"]>[1],
  ): Promise<void> {
    if (funding.pricingMode === "LEGACY_FIXED") {
      if (funding.rewardPerWorkUnitWei === null) {
        throw new Error("Legacy Project Escrow funding is missing its fixed Work Unit reward");
      }
      for (const quote of funding.quotes) {
        const { data: units, error: unitError } = await this.client.from("work_units").update({
          workload_score: quote.workloadScore,
          reward_tier: quote.rewardTier,
          reward_amount_wei: funding.rewardPerWorkUnitWei.toString(),
        }).eq("project_id", projectId).eq("work_unit_id", quote.workUnitId).select("work_unit_id");
        if (unitError || units?.length !== 1) {
          throw new Error(persistenceError(unitError, `persist legacy Work Unit ${quote.workUnitId} pricing`));
        }
      }
      const { data, error } = await this.client.rpc("mark_project_escrow_funded_v1", {
        p_project_id: projectId,
        p_escrow_address: funding.escrowAddress,
        p_sponsor_address: funding.sponsorAddress,
        p_reward_per_work_unit_wei: funding.rewardPerWorkUnitWei.toString(),
        p_total_budget_wei: funding.totalBudgetWei.toString(),
        p_remaining_budget_wei: funding.remainingBudgetWei.toString(),
        p_work_unit_count: funding.workUnitCount,
        p_settled_work_unit_count: funding.settledWorkUnitCount,
        p_funding_tx_hash: funding.fundingTxHash,
        p_funded_block: funding.fundedBlock.toString(),
      });
      if (error || data !== true) throw new Error(persistenceError(error, "reconcile legacy funded V2 Registry Project"));
      return;
    }
    if (funding.pricingRoot === null) {
      throw new Error("Dynamic Project Escrow funding is missing its pricing root");
    }
    const { data, error } = await this.client.rpc("mark_project_escrow_funded_v2", {
      p_project_id: projectId,
      p_escrow_address: funding.escrowAddress,
      p_sponsor_address: funding.sponsorAddress,
      p_pricing_policy_version: WORK_UNIT_PRICING_POLICY_VERSION,
      p_pricing_root: funding.pricingRoot,
      p_quotes: funding.quotes.map((quote) => ({
        work_unit_id: quote.workUnitId,
        workload_score: quote.workloadScore,
        reward_tier: quote.rewardTier,
        reward_amount_wei: quote.rewardAmountWei.toString(),
      })),
      p_total_budget_wei: funding.totalBudgetWei.toString(),
      p_remaining_budget_wei: funding.remainingBudgetWei.toString(),
      p_work_unit_count: funding.workUnitCount,
      p_settled_work_unit_count: funding.settledWorkUnitCount,
      p_funding_tx_hash: funding.fundingTxHash,
      p_funded_block: funding.fundedBlock.toString(),
    });
    if (error || data !== true) throw new Error(persistenceError(error, "reconcile funded V2 Registry Project"));
  }

  getChapterBundle(projectId: Hex, chapterId: number) {
    return loadChapterBundle(this.client, projectId, chapterId);
  }

  async saveChapterAssembly(projectId: Hex, chapterId: number, assembly: Parameters<ChapterCommitmentRepositoryV2["saveChapterAssembly"]>[2]): Promise<void> {
    const cards = assembly.cards.map((card) => ({
      card_id: card.id,
      project_id: card.projectId,
      chapter_id: card.chapterId,
      work_unit_id: card.workUnitId,
      position: card.position,
      content: {
        type: card.type,
        question: card.question,
        answer: card.answer,
        keyPoint: card.keyPoint,
        source: card.source,
        tags: card.tags,
        importance: card.importance,
        initialDifficulty: card.initialDifficulty,
      },
      card_hash: card.cardHash,
      worker_proof: card.workerProof,
      chapter_proof: card.chapterProof,
    }));
    const { error } = await this.client.rpc("save_chapter_assembly_v2", {
      p_project_id: projectId, p_chapter_id: chapterId, p_cards_root: assembly.cardsRoot, p_cards: cards,
    });
    if (error) throw new Error(persistenceError(error, "save V2 Chapter assembly"));
  }

  async markChapterReady(projectId: Hex, chapterId: number, txHash: Hex | null): Promise<void> {
    const { error } = await this.client.rpc("mark_chapter_ready_v2", { p_project_id: projectId, p_chapter_id: chapterId, p_tx_hash: txHash });
    if (error) throw new Error(persistenceError(error, "mark V2 Chapter ready"));
  }

  async markChapterRetryable(projectId: Hex, chapterId: number, message: string): Promise<void> {
    const { error } = await this.client.rpc("mark_chapter_retryable_v2", { p_project_id: projectId, p_chapter_id: chapterId, p_error: message.slice(0, 500) });
    if (error) throw new Error(persistenceError(error, "release V2 Chapter assembly"));
  }

  getProjectBundle(projectId: Hex) {
    return loadProjectBundle(this.client, projectId);
  }

  async saveProjectFinalization(input: Parameters<ProjectCommitmentRepositoryV2["saveProjectFinalization"]>[0]): Promise<void> {
    const { error } = await this.client.rpc("save_project_finalization_v2", {
      p_project_id: input.projectId, p_project_deck_root: input.projectDeckRoot,
      p_initial_plan: input.initialPlan, p_initial_plan_hash: input.initialPlanHash,
      p_total_card_count: input.totalCardCount,
    });
    if (error) throw new Error(persistenceError(error, "save V2 Project finalization"));
  }

  async markProjectReady(input: Parameters<ProjectCommitmentRepositoryV2["markProjectReady"]>[0]): Promise<void> {
    const { error } = await this.client.rpc("mark_project_ready_v2", {
      p_project_id: input.projectId, p_project_deck_root: input.projectDeckRoot,
      p_initial_plan: input.initialPlan, p_initial_plan_hash: input.initialPlanHash,
      p_total_card_count: input.totalCardCount, p_tx_hash: input.txHash,
    });
    if (error) throw new Error(persistenceError(error, "mark V2 Project ready"));
  }

  async markProjectRetryable(projectId: Hex, message: string): Promise<void> {
    const { error } = await this.client.rpc("mark_project_retryable_v2", { p_project_id: projectId, p_error: message.slice(0, 500) });
    if (error) throw new Error(persistenceError(error, "release V2 Project finalization"));
  }

  recordProjectAgentEvent(event: ProjectAgentEventV2) {
    return recordProjectAgentEvent(this.client, event);
  }
}
