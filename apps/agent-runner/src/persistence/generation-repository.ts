import {
  CardBlueprintSchema,
  ChapterConceptInventorySchema,
} from "@mindmark/shared/chapter";
import {
  CardRubricEvaluationSchema,
  KnowledgeCardContentSchema,
  WorkerKnowledgeCardV2Schema,
  type CardRubricEvaluation,
} from "@mindmark/shared/knowledge-card";
import { Bytes32Schema } from "@mindmark/shared/schemas";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Hex } from "viem";
import type {
  BlueprintQualityDecisionV3,
  ChapterQualityRepositoryV2,
  SavedWorkUnitResultV2,
  WorkUnitGenerationRepositoryV2,
} from "../types-v2.js";
import {
  loadChapterBundle,
  persistenceError,
  recordProjectAgentEvent,
  workUnitFromRow,
} from "./shared.js";

export class SupabaseGenerationRepositoryV2 implements WorkUnitGenerationRepositoryV2, ChapterQualityRepositoryV2 {
  constructor(private readonly client: SupabaseClient) {}

  async getWorkUnit(projectId: Hex, workUnitId: number) {
    const { data, error } = await this.client.from("work_units").select("*")
      .eq("project_id", projectId).eq("work_unit_id", workUnitId).maybeSingle();
    if (error || !data) throw new Error(persistenceError(error, "load V2 Work Unit"));
    return workUnitFromRow(data);
  }

  async getWorkUnitBlueprintContext(projectId: Hex, workUnitId: number) {
    const unit = await this.getWorkUnit(projectId, workUnitId);
    const [runResult, slotsResult] = await Promise.all([
      this.client.from("chapter_design_runs").select("design_run_id,inventory,blueprint")
        .eq("project_id", projectId).eq("chapter_id", unit.chapterId).eq("status", "COMPLETED").single(),
      this.client.from("card_blueprint_slots").select("slot_id,status")
        .eq("project_id", projectId).eq("chapter_id", unit.chapterId).eq("assigned_work_unit_id", workUnitId)
        .in("status", ["ASSIGNED", "REPAIR_REQUESTED"]).order("created_at"),
    ]);
    const error = runResult.error ?? slotsResult.error;
    if (error || !runResult.data) throw new Error(persistenceError(error, "load V3 Work Unit Blueprint"));
    const blueprint = CardBlueprintSchema.parse(runResult.data.blueprint);
    const assignedSlots = z.array(z.object({
      slot_id: Bytes32Schema,
      status: z.enum(["ASSIGNED", "REPAIR_REQUESTED"]),
    })).parse(slotsResult.data ?? []);
    const assignedSlotIds = new Set(assignedSlots.map((slot) => slot.slot_id));
    const slots = blueprint.slots.filter((slot) => assignedSlotIds.has(slot.slotId));
    if (slots.length !== assignedSlotIds.size || slots.length === 0) {
      throw new Error("V3 Work Unit Blueprint Slot assignment is incomplete");
    }
    const designRunId = z.string().uuid().parse(runResult.data.design_run_id);
    const repairSlotIds = assignedSlots.filter((slot) => slot.status === "REPAIR_REQUESTED").map((slot) => slot.slot_id);
    const repairInstructions = repairSlotIds.length === 0 ? [] : await this.loadBlueprintRepairInstructions({
      projectId, chapterId: unit.chapterId, workUnitId, designRunId, slotIds: repairSlotIds,
    });
    return {
      designRunId,
      inventory: ChapterConceptInventorySchema.parse(runResult.data.inventory),
      blueprint,
      slots,
      repairInstructions,
    };
  }

  private async loadBlueprintRepairInstructions(input: {
    projectId: Hex;
    chapterId: number;
    workUnitId: number;
    designRunId: string;
    slotIds: Hex[];
  }) {
    const [candidatesResult, evaluationsResult] = await Promise.all([
      this.client.from("card_slot_candidates").select("slot_id,candidate_revision,card")
        .eq("project_id", input.projectId).eq("chapter_id", input.chapterId).eq("work_unit_id", input.workUnitId)
        .eq("design_run_id", input.designRunId).eq("status", "REJECTED").in("slot_id", input.slotIds)
        .order("candidate_revision", { ascending: false }),
      this.client.from("card_quality_evaluations").select("slot_id,candidate_revision,hard_failures,repair_reason,created_at")
        .eq("project_id", input.projectId).eq("chapter_id", input.chapterId).eq("design_run_id", input.designRunId)
        .in("slot_id", input.slotIds).order("candidate_revision", { ascending: false }).order("created_at", { ascending: false }),
    ]);
    const error = candidatesResult.error ?? evaluationsResult.error;
    if (error) throw new Error(persistenceError(error, "load V3 Blueprint repair instructions"));
    const candidates = z.array(z.object({
      slot_id: Bytes32Schema,
      candidate_revision: z.number().int().min(1).max(10),
      card: z.unknown(),
    })).parse(candidatesResult.data ?? []);
    const evaluations = z.array(z.object({
      slot_id: Bytes32Schema.nullable(),
      candidate_revision: z.number().int().min(0).max(10),
      hard_failures: z.array(z.string()),
      repair_reason: z.string().nullable(),
      created_at: z.string(),
    })).parse(evaluationsResult.data ?? []);
    const latestCandidateBySlot = new Map<string, typeof candidates[number]>();
    for (const candidate of candidates) {
      if (!latestCandidateBySlot.has(candidate.slot_id)) latestCandidateBySlot.set(candidate.slot_id, candidate);
    }
    const exactEvaluationByCandidate = new Map<string, typeof evaluations[number]>();
    for (const evaluation of evaluations) {
      if (!evaluation.slot_id) continue;
      const key = `${evaluation.slot_id}:${evaluation.candidate_revision}`;
      if (!exactEvaluationByCandidate.has(key)) exactEvaluationByCandidate.set(key, evaluation);
    }
    return [...latestCandidateBySlot.values()].map((candidate) => {
      const evaluation = exactEvaluationByCandidate.get(`${candidate.slot_id}:${candidate.candidate_revision}`);
      const failureCodes = evaluation?.hard_failures ?? [];
      const previousCard = WorkerKnowledgeCardV2Schema.parse(candidate.card);
      return {
        slotId: candidate.slot_id,
        candidateRevision: candidate.candidate_revision,
        previousCard: KnowledgeCardContentSchema.parse({
          type: previousCard.type, question: previousCard.question, answer: previousCard.answer,
          keyPoint: previousCard.keyPoint, source: previousCard.source, tags: previousCard.tags,
          importance: previousCard.importance, initialDifficulty: previousCard.initialDifficulty,
        }),
        failureCodes,
        instruction: evaluation?.repair_reason
          ?? (failureCodes.length ? failureCodes.join(", ") : "Replace the rejected card with a fully grounded answer for this Slot."),
      };
    });
  }

  async getChapterBlueprintQualityContext(projectId: Hex, chapterId: number) {
    const [runResult, candidatesResult, evaluationsResult] = await Promise.all([
      this.client.from("chapter_design_runs").select("design_run_id,inventory,blueprint")
        .eq("project_id", projectId).eq("chapter_id", chapterId).eq("status", "COMPLETED").single(),
      this.client.from("card_slot_candidates").select("design_run_id,slot_id,work_unit_id,candidate_revision,status,card")
        .eq("project_id", projectId).eq("chapter_id", chapterId).in("status", ["CANDIDATE_READY", "ACCEPTED"])
        .order("candidate_revision"),
      this.client.from("card_quality_evaluations").select("design_run_id,slot_id,card_id,candidate_revision,verdict,rubric_scores,created_at")
        .eq("project_id", projectId).eq("chapter_id", chapterId).eq("verdict", "APPROVED")
        .order("created_at", { ascending: false }),
    ]);
    const error = runResult.error ?? candidatesResult.error ?? evaluationsResult.error;
    if (error || !runResult.data) throw new Error(persistenceError(error, "load V3 Chapter quality context"));
    const designRunId = z.string().uuid().parse(runResult.data.design_run_id);
    const acceptedEvaluations = z.array(z.object({
      design_run_id: z.string().uuid(), slot_id: Bytes32Schema.nullable(), card_id: Bytes32Schema.nullable(),
      candidate_revision: z.number().int().min(1).max(10), verdict: z.literal("APPROVED"),
      rubric_scores: z.record(z.string(), z.unknown()), created_at: z.string(),
    })).parse(evaluationsResult.data ?? []);
    const acceptedEvaluationByCandidate = new Map<string, CardRubricEvaluation>();
    for (const evaluation of acceptedEvaluations) {
      if (evaluation.design_run_id !== designRunId || !evaluation.slot_id || !evaluation.card_id) continue;
      const key = `${evaluation.slot_id}:${evaluation.card_id}:${evaluation.candidate_revision}`;
      if (acceptedEvaluationByCandidate.has(key)) continue;
      const scores = evaluation.rubric_scores;
      acceptedEvaluationByCandidate.set(key, CardRubricEvaluationSchema.parse({
        cardId: scores.cardId, citationSufficient: scores.citationSufficient,
        factuality: scores.factuality, learningValue: scores.learningValue, clarity: scores.clarity,
        completeness: scores.completeness, citationRelevance: scores.citationRelevance,
        difficultyFit: scores.difficultyFit, verdict: scores.verdict, reasons: scores.reasons,
      }));
    }
    return {
      designRunId,
      inventory: ChapterConceptInventorySchema.parse(runResult.data.inventory),
      blueprint: CardBlueprintSchema.parse(runResult.data.blueprint),
      candidates: (candidatesResult.data ?? []).map((raw) => {
        const row = z.object({
          design_run_id: z.string().uuid(), slot_id: Bytes32Schema, work_unit_id: z.number().int(),
          candidate_revision: z.number().int().min(1).max(10), status: z.enum(["CANDIDATE_READY", "ACCEPTED"]),
          card: z.unknown(),
        }).parse(raw);
        if (row.design_run_id !== designRunId) throw new Error("V3 Slot candidate belongs to a stale Chapter Design Run");
        const card = WorkerKnowledgeCardV2Schema.parse(row.card);
        const acceptedEvaluation = row.status === "ACCEPTED"
          ? acceptedEvaluationByCandidate.get(`${row.slot_id}:${card.id}:${row.candidate_revision}`)
          : undefined;
        if (row.status === "ACCEPTED" && !acceptedEvaluation) throw new Error(`Accepted V3 Slot ${row.slot_id} has no persisted quality evaluation`);
        return {
          designRunId: row.design_run_id, slotId: row.slot_id, workUnitId: row.work_unit_id,
          candidateRevision: row.candidate_revision, status: row.status, card,
          ...(acceptedEvaluation ? { acceptedEvaluation } : {}),
        };
      }),
    };
  }

  async markWorkUnitValidating(projectId: Hex, workUnitId: number): Promise<void> {
    const { data, error } = await this.client.from("work_units")
      .update({ status: "VALIDATING", lease_until: new Date(Date.now() + 60_000).toISOString() })
      .eq("project_id", projectId).eq("work_unit_id", workUnitId).eq("status", "GENERATING")
      .select("work_unit_id").maybeSingle();
    if (error || !data) throw new Error(persistenceError(error, "mark V2 Work Unit validating"));
  }

  async approveChapterBlueprintCandidates(decision: BlueprintQualityDecisionV3 & { workUnits: Parameters<ChapterQualityRepositoryV2["approveChapterCandidates"]>[2] }): Promise<void> {
    const { error } = await this.client.rpc("approve_chapter_candidates_v3", {
      p_project_id: decision.projectId, p_chapter_id: decision.chapterId, p_design_run_id: decision.designRunId,
      p_evaluations: decision.evaluations.map((evaluation) => ({
        slot_id: evaluation.slotId, card_id: evaluation.cardId, candidate_revision: evaluation.candidateRevision,
        verdict: evaluation.verdict, hard_failures: evaluation.hardFailures, rubric_scores: evaluation.rubric,
      })),
      p_work_units: decision.workUnits.map((unit) => ({ work_unit_id: unit.workUnitId, worker_cards: unit.cards, cards_root: unit.cardsRoot, card_count: unit.cards.length })),
      p_coverage_result: decision.coverageResult, p_duplicate_pairs: decision.duplicatePairs,
      p_evaluator_model: decision.evaluatorModel, p_prompt_version: decision.promptVersion,
    });
    if (error) throw new Error(persistenceError(error, "approve V3 Chapter Blueprint candidates"));
  }

  async requestChapterBlueprintRepairs(decision: BlueprintQualityDecisionV3 & { repairs: Array<{ slotId: Hex; reason: string }> }): Promise<void> {
    const { error } = await this.client.rpc("request_chapter_slot_repairs_v3", {
      p_project_id: decision.projectId, p_chapter_id: decision.chapterId, p_design_run_id: decision.designRunId,
      p_evaluations: decision.evaluations.map((evaluation) => ({
        slot_id: evaluation.slotId, card_id: evaluation.cardId, candidate_revision: evaluation.candidateRevision,
        verdict: evaluation.verdict, hard_failures: evaluation.hardFailures, rubric_scores: evaluation.rubric,
      })),
      p_repairs: decision.repairs.map((repair) => ({ slot_id: repair.slotId, reason: repair.reason })),
      p_coverage_result: decision.coverageResult, p_duplicate_pairs: decision.duplicatePairs,
      p_evaluator_model: decision.evaluatorModel, p_prompt_version: decision.promptVersion,
    });
    if (error) throw new Error(persistenceError(error, "request V3 Blueprint Slot repairs"));
  }

  async saveWorkUnitResult(projectId: Hex, workUnitId: number, result: SavedWorkUnitResultV2): Promise<void> {
    if (result.slotCandidates) {
      const cards = new Map(result.cards.map((card) => [card.id, card]));
      const candidates = result.slotCandidates.map((candidate) => {
        const card = cards.get(candidate.cardId);
        if (!card) throw new Error("V3 slot candidate references a missing Worker card");
        return { slot_id: candidate.slotId, card };
      });
      const { error } = await this.client.rpc("save_work_unit_candidates_v3", {
        p_project_id: projectId, p_work_unit_id: workUnitId, p_cards_root: result.cardsRoot,
        p_generation_ms: result.generationMs, p_candidates: candidates,
      });
      if (error) throw new Error(persistenceError(error, "save V3 Work Unit candidates"));
      return;
    }
    const { data, error } = await this.client.from("work_units").update({
      worker_cards: result.cards, cards_root: result.cardsRoot, card_count: result.cards.length,
      generation_ms: result.generationMs, status: "CANDIDATE_READY", lease_until: null, last_error: null,
    }).eq("project_id", projectId).eq("work_unit_id", workUnitId)
      .in("status", ["GENERATING", "VALIDATING"]).select("work_unit_id").maybeSingle();
    if (error || !data) throw new Error(persistenceError(error, "save V2 Work Unit cards"));
  }

  async markWorkUnitSubmitting(projectId: Hex, workUnitId: number, txHash: Hex): Promise<void> {
    const { data, error } = await this.client.from("work_units")
      .update({ status: "SUBMITTING", commit_tx_hash: txHash, last_error: null })
      .eq("project_id", projectId).eq("work_unit_id", workUnitId)
      .in("status", ["APPROVED", "SUBMITTING"]).select("work_unit_id").maybeSingle();
    if (error || !data) throw new Error(persistenceError(error, "mark V2 Work Unit submitting"));
  }

  async markWorkUnitConfirmed(projectId: Hex, workUnitId: number, confirmation: { txHash: Hex | null; blockNumber: bigint; gasUsed: bigint | null; confirmationMs: number }): Promise<void> {
    const { error } = await this.client.rpc("confirm_work_unit_and_enqueue_escrow_reward_v3", {
      p_project_id: projectId, p_work_unit_id: workUnitId, p_tx_hash: confirmation.txHash,
      p_block_number: confirmation.blockNumber.toString(), p_gas_used: confirmation.gasUsed?.toString() ?? null,
      p_confirmation_ms: confirmation.confirmationMs,
    });
    if (error) throw new Error(persistenceError(error, "confirm V2 Work Unit"));
  }

  async markWorkUnitRetryable(projectId: Hex, workUnitId: number, message: string): Promise<void> {
    const { error } = await this.client.rpc("mark_work_unit_retryable_v2", { p_project_id: projectId, p_work_unit_id: workUnitId, p_error: message.slice(0, 500) });
    if (error) throw new Error(persistenceError(error, "release V2 Work Unit"));
  }

  async approveChapterCandidates(projectId: Hex, chapterId: number, workUnits: Parameters<ChapterQualityRepositoryV2["approveChapterCandidates"]>[2]): Promise<void> {
    const { error } = await this.client.rpc("approve_chapter_candidates_v2", {
      p_project_id: projectId, p_chapter_id: chapterId,
      p_work_units: workUnits.map((unit) => ({ work_unit_id: unit.workUnitId, worker_cards: unit.cards, cards_root: unit.cardsRoot, card_count: unit.cards.length })),
    });
    if (error) throw new Error(persistenceError(error, "approve V2 Chapter candidates"));
  }

  async requestChapterCandidateRepair(projectId: Hex, chapterId: number, message: string): Promise<void> {
    const { error } = await this.client.rpc("request_chapter_candidate_repair_v2", { p_project_id: projectId, p_chapter_id: chapterId, p_error: message.slice(0, 500) });
    if (error) throw new Error(persistenceError(error, "request V2 Chapter candidate repair"));
  }

  getChapterBundle(projectId: Hex, chapterId: number) {
    return loadChapterBundle(this.client, projectId, chapterId);
  }

  async markChapterRetryable(projectId: Hex, chapterId: number, message: string): Promise<void> {
    const { error } = await this.client.rpc("mark_chapter_retryable_v2", { p_project_id: projectId, p_chapter_id: chapterId, p_error: message.slice(0, 500) });
    if (error) throw new Error(persistenceError(error, "release V2 Chapter generation"));
  }

  recordProjectAgentEvent(event: Parameters<WorkUnitGenerationRepositoryV2["recordProjectAgentEvent"]>[0]) {
    return recordProjectAgentEvent(this.client, event);
  }
}
