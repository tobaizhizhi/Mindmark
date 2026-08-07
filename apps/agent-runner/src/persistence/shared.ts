import {
  ChapterStatusSchema,
  SourceBlockSchema,
} from "@mindmark/shared/chapter";
import {
  ProjectStatusSchema,
  WorkUnitStatusSchema,
} from "@mindmark/shared/learning-project";
import {
  KnowledgeCardV2Schema,
  WorkerKnowledgeCardV2Schema,
} from "@mindmark/shared/knowledge-card";
import { AddressSchema, Bytes32Schema, ReviewPlanSchema } from "@mindmark/shared/schemas";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Hex } from "viem";
import type {
  ChapterBundleV2,
  ProjectBundleV2,
  RunnerChapterV2,
  RunnerProjectV2,
  RunnerWorkUnitV2,
  WorkUnitRewardV2,
  WorkflowJobV2,
} from "../types-v2.js";

const ProjectRowSchema = z.object({
  project_id: Bytes32Schema,
  owner_address: AddressSchema,
  goal: z.string().nullable(),
  source_hash: Bytes32Schema,
  goal_hash: Bytes32Schema,
  outline_hash: Bytes32Schema,
  work_unit_manifest_root: Bytes32Schema,
  status: ProjectStatusSchema,
  project_deck_root: Bytes32Schema.nullable(),
  initial_plan: z.unknown().nullable(),
  initial_plan_hash: Bytes32Schema.nullable(),
  total_card_count: z.number().int(),
  generation_policy_version: z.union([z.literal(2), z.literal(3)]).default(2),
});

const ChapterRowSchema = z.object({
  project_id: Bytes32Schema,
  chapter_id: z.number().int(),
  position: z.number().int(),
  title: z.string(),
  summary: z.string(),
  source_hash: Bytes32Schema,
  importance: z.number().int(),
  status: ChapterStatusSchema,
  cards_root: Bytes32Schema.nullable(),
  card_count: z.number().int(),
  min_card_count: z.number().int(),
  target_card_count: z.number().int(),
  max_card_count: z.number().int(),
  finalize_tx_hash: Bytes32Schema.nullable(),
});

const WorkUnitRowSchema = z.object({
  project_id: Bytes32Schema,
  work_unit_id: z.number().int(),
  chapter_id: z.number().int(),
  unit_index: z.number().int(),
  start_block: z.number().int(),
  end_block: z.number().int(),
  source_text: z.string().nullable(),
  source_blocks: z.unknown().nullable(),
  source_unit_hash: Bytes32Schema,
  manifest_proof: z.unknown(),
  card_minimum: z.number().int(),
  card_target: z.number().int(),
  card_budget: z.number().int(),
  worker_address: AddressSchema.nullable(),
  status: WorkUnitStatusSchema,
  attempt: z.number().int(),
  worker_cards: z.unknown(),
  cards_root: Bytes32Schema.nullable(),
  card_count: z.number().int().nullable(),
  commit_tx_hash: Bytes32Schema.nullable(),
});

const CardRowSchema = z.object({
  card_id: Bytes32Schema,
  project_id: Bytes32Schema,
  chapter_id: z.number().int(),
  work_unit_id: z.number().int(),
  position: z.number().int(),
  content: z.unknown(),
  card_hash: Bytes32Schema,
  worker_proof: z.unknown(),
  chapter_proof: z.unknown(),
});

const RewardRowSchema = z.object({
  project_id: Bytes32Schema,
  work_unit_id: z.number().int(),
  treasury_address: AddressSchema,
  recipient_address: AddressSchema,
  amount_wei: z.union([z.string(), z.number()]),
  status: z.enum(["PENDING", "PROCESSING", "PREPARED", "SUBMITTING", "CONFIRMED", "RETRYABLE", "BLOCKED"]),
  attempt: z.number().int(),
  moss_stage: z.enum(["PENDING", "DISCOVERED", "LOADED", "BUILT", "SIMULATED"]),
  moss_plan_hash: Bytes32Schema.nullable(),
  simulation_status: z.enum(["NOT_RUN", "PASSED", "FAILED"]),
  simulation_warning_codes: z.array(z.string()),
  simulation_gas: z.union([z.string(), z.number()]).nullable(),
  signed_transaction: z.string().nullable(),
  treasury_nonce: z.union([z.string(), z.number()]).nullable(),
  tx_hash: Bytes32Schema.nullable(),
});

const WorkflowJobRowSchema = z.object({
  job_id: z.string().uuid(),
  project_id: Bytes32Schema,
  kind: z.enum(["PLAN_OUTLINE", "DESIGN_CHAPTER", "FREEZE_PROJECT_DESIGN", "RECONCILE_PROJECT", "GENERATE_WORK_UNIT", "QUALITY_CHECK_CHAPTER", "ASSEMBLE_CHAPTER", "FINALIZE_PROJECT", "SETTLE_WORK_UNIT_REWARD"]),
  chapter_id: z.number().int().nullable(),
  work_unit_id: z.number().int().nullable(),
  status: z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "RETRYABLE", "FAILED", "CANCELLED"]),
  attempt: z.number().int(),
  input: z.record(z.string(), z.unknown()),
  last_error: z.string().nullable(),
});

export function persistenceError(error: { message: string } | null, operation: string): string {
  return error ? `${operation}: ${error.message}` : `${operation}: no row was updated`;
}

function projectFromRow(raw: unknown): RunnerProjectV2 {
  const row = ProjectRowSchema.parse(raw);
  return {
    projectId: row.project_id,
    ownerAddress: row.owner_address,
    goal: row.goal,
    sourceHash: row.source_hash,
    goalHash: row.goal_hash,
    outlineHash: row.outline_hash,
    workUnitManifestRoot: row.work_unit_manifest_root,
    status: row.status,
    projectDeckRoot: row.project_deck_root,
    initialPlan: row.initial_plan === null ? null : ReviewPlanSchema.parse(row.initial_plan),
    initialPlanHash: row.initial_plan_hash,
    totalCardCount: row.total_card_count,
    generationPolicyVersion: row.generation_policy_version,
  };
}

function chapterFromRow(raw: unknown): RunnerChapterV2 {
  const row = ChapterRowSchema.parse(raw);
  return {
    projectId: row.project_id,
    chapterId: row.chapter_id,
    position: row.position,
    title: row.title,
    summary: row.summary,
    sourceHash: row.source_hash,
    importance: row.importance,
    status: row.status,
    cardsRoot: row.cards_root,
    cardCount: row.card_count,
    minCardCount: row.min_card_count,
    targetCardCount: row.target_card_count,
    maxCardCount: row.max_card_count,
    finalizeTxHash: row.finalize_tx_hash,
  };
}

export function workUnitFromRow(raw: unknown): RunnerWorkUnitV2 {
  const row = WorkUnitRowSchema.parse(raw);
  return {
    projectId: row.project_id,
    workUnitId: row.work_unit_id,
    chapterId: row.chapter_id,
    unitIndex: row.unit_index,
    startBlock: row.start_block,
    endBlock: row.end_block,
    sourceText: row.source_text,
    sourceBlocks: row.source_blocks === null ? null : SourceBlockSchema.array().parse(row.source_blocks),
    sourceUnitHash: row.source_unit_hash,
    manifestProof: Bytes32Schema.array().parse(row.manifest_proof),
    cardMinimum: row.card_minimum,
    cardTarget: row.card_target,
    cardBudget: row.card_budget,
    workerAddress: row.worker_address,
    status: row.status,
    attempt: row.attempt,
    workerCards: WorkerKnowledgeCardV2Schema.array().parse(row.worker_cards ?? []),
    cardsRoot: row.cards_root,
    cardCount: row.card_count,
    commitTxHash: row.commit_tx_hash,
  };
}

function cardFromRow(raw: unknown) {
  const row = CardRowSchema.parse(raw);
  return KnowledgeCardV2Schema.parse({
    id: row.card_id,
    projectId: row.project_id,
    chapterId: row.chapter_id,
    workUnitId: row.work_unit_id,
    position: row.position,
    ...z.record(z.string(), z.unknown()).parse(row.content),
    cardHash: row.card_hash,
    workerProof: Bytes32Schema.array().parse(row.worker_proof),
    chapterProof: Bytes32Schema.array().parse(row.chapter_proof),
  });
}

export function rewardFromRow(raw: unknown): WorkUnitRewardV2 {
  const row = RewardRowSchema.parse(raw);
  return {
    projectId: row.project_id,
    workUnitId: row.work_unit_id,
    treasuryAddress: row.treasury_address,
    recipientAddress: row.recipient_address,
    amountWei: BigInt(row.amount_wei),
    status: row.status,
    attempt: row.attempt,
    mossStage: row.moss_stage,
    mossPlanHash: row.moss_plan_hash,
    simulationStatus: row.simulation_status,
    simulationWarningCodes: row.simulation_warning_codes,
    simulationGas: row.simulation_gas === null ? null : BigInt(row.simulation_gas),
    signedTransaction: row.signed_transaction as WorkUnitRewardV2["signedTransaction"],
    treasuryNonce: row.treasury_nonce === null ? null : BigInt(row.treasury_nonce),
    txHash: row.tx_hash,
  };
}

export function workflowJobFromRow(raw: unknown): WorkflowJobV2 {
  const row = WorkflowJobRowSchema.parse(raw);
  return { jobId: row.job_id, projectId: row.project_id, kind: row.kind, chapterId: row.chapter_id, workUnitId: row.work_unit_id, status: row.status, attempt: row.attempt, input: row.input, lastError: row.last_error };
}

export async function loadChapterBundle(client: SupabaseClient, projectId: Hex, chapterId: number): Promise<ChapterBundleV2> {
  const [projectResult, chapterResult, unitsResult] = await Promise.all([
    client.from("learning_projects").select("*").eq("project_id", projectId).maybeSingle(),
    client.from("chapters").select("*").eq("project_id", projectId).eq("chapter_id", chapterId).maybeSingle(),
    client.from("work_units").select("*").eq("project_id", projectId).eq("chapter_id", chapterId).order("unit_index"),
  ]);
  const error = projectResult.error ?? chapterResult.error ?? unitsResult.error;
  if (error || !projectResult.data || !chapterResult.data) throw new Error(persistenceError(error, "load V2 Chapter bundle"));
  return { project: projectFromRow(projectResult.data), chapter: chapterFromRow(chapterResult.data), workUnits: (unitsResult.data ?? []).map(workUnitFromRow) };
}

export async function loadProjectBundle(client: SupabaseClient, projectId: Hex): Promise<ProjectBundleV2> {
  const [projectResult, chaptersResult, cardsResult] = await Promise.all([
    client.from("learning_projects").select("*").eq("project_id", projectId).maybeSingle(),
    client.from("chapters").select("*").eq("project_id", projectId).order("position"),
    client.from("knowledge_cards").select("*").eq("project_id", projectId).order("chapter_id").order("position"),
  ]);
  const error = projectResult.error ?? chaptersResult.error ?? cardsResult.error;
  if (error || !projectResult.data) throw new Error(persistenceError(error, "load V2 Project bundle"));
  return { project: projectFromRow(projectResult.data), chapters: (chaptersResult.data ?? []).map(chapterFromRow), cards: (cardsResult.data ?? []).map(cardFromRow) };
}

export async function recordProjectAgentEvent(
  client: SupabaseClient,
  event: import("../types-v2.js").ProjectAgentEventV2,
): Promise<void> {
  const { error } = await client.from("project_agent_events").insert({
    project_id: event.projectId, chapter_id: event.chapterId ?? null, work_unit_id: event.workUnitId ?? null,
    agent_role: event.role, event_type: event.type, payload: event.payload ?? {}, tx_hash: event.txHash ?? null,
  });
  if (error) throw new Error(persistenceError(error, "record V2 agent event"));
}
