import {
  AddressSchema,
  Bytes32Schema,
  CardBlueprintSchema,
  ChapterConceptInventorySchema,
  ChapterOutlineItemSchema,
  ChapterStatusSchema,
  KnowledgeCardContentSchema,
  KnowledgeCardV2Schema,
  ProjectStatusSchema,
  ReviewPlanSchema,
  SourceBlockSchema,
  WorkerKnowledgeCardV2Schema,
  WorkUnitStatusSchema,
  type KnowledgeCardV2,
} from "@mindmark/shared";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Hex, TransactionSerialized } from "viem";
import type { PreparedWorkerReward, WorkerRewardReceipt } from "./runtime-types.js";
import type {
  ChapterAssemblyV2,
  ChapterDesignRepositoryV3,
  ChapterDesignRunV3,
  ChapterBundleV2,
  OutlinePlanningSourceV2,
  ProjectBundleV2,
  ProjectDesignFreezeRepositoryV3,
  ProjectRunnerRepositoryV2,
  RunnerChapterV2,
  RunnerProjectV2,
  RunnerWorkUnitV2,
  SavedWorkUnitResultV2,
  WorkflowJobKindV2,
  WorkflowDispatchRepositoryV2,
  WorkflowJobRepositoryV2,
  WorkflowJobStatusV2,
  WorkflowJobV2,
  WorkUnitRewardRepositoryV2,
  WorkUnitRewardV2,
} from "./types-v2.js";

const ProjectRowSchemaV2 = z.object({
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

const ChapterRowSchemaV2 = z.object({
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

const WorkUnitRowSchemaV2 = z.object({
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

const CardRowSchemaV2 = z.object({
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

const WorkUnitRewardRowSchemaV2 = z.object({
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

const WorkflowJobRowSchemaV2 = z.object({
  job_id: z.string().uuid(),
  project_id: Bytes32Schema,
  kind: z.enum([
    "PLAN_OUTLINE", "DESIGN_CHAPTER", "FREEZE_PROJECT_DESIGN", "RECONCILE_PROJECT", "GENERATE_WORK_UNIT", "QUALITY_CHECK_CHAPTER",
    "ASSEMBLE_CHAPTER", "FINALIZE_PROJECT", "SETTLE_WORK_UNIT_REWARD",
  ]),
  chapter_id: z.number().int().nullable(),
  work_unit_id: z.number().int().nullable(),
  status: z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "RETRYABLE", "FAILED", "CANCELLED"]),
  attempt: z.number().int(),
  input: z.record(z.string(), z.unknown()),
  last_error: z.string().nullable(),
});

const ChapterDesignRunRowSchemaV3 = z.object({
  design_run_id: z.string().uuid(),
  project_id: Bytes32Schema,
  chapter_id: z.number().int().min(0).max(15),
  outline_version: z.number().int().positive(),
  policy_version: z.literal(3),
  status: z.enum(["RUNNING", "COMPLETED", "REPAIR_EXHAUSTED", "FAILED", "CANCELLED"]),
  attempt: z.number().int().positive(),
});

function errorMessage(error: { message: string } | null, operation: string): string {
  return error ? `${operation}: ${error.message}` : `${operation}: no row was updated`;
}

function projectFromRow(raw: unknown): RunnerProjectV2 {
  const row = ProjectRowSchemaV2.parse(raw);
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
  const row = ChapterRowSchemaV2.parse(raw);
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

function workUnitFromRow(raw: unknown): RunnerWorkUnitV2 {
  const row = WorkUnitRowSchemaV2.parse(raw);
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
    workerCards: WorkerKnowledgeCardV2Schema.array().parse(row.worker_cards),
    cardsRoot: row.cards_root,
    cardCount: row.card_count,
    commitTxHash: row.commit_tx_hash,
  };
}

function cardFromRow(raw: unknown): KnowledgeCardV2 {
  const row = CardRowSchemaV2.parse(raw);
  return KnowledgeCardV2Schema.parse({
    ...KnowledgeCardContentSchema.parse(row.content),
    id: row.card_id,
    projectId: row.project_id,
    chapterId: row.chapter_id,
    workUnitId: row.work_unit_id,
    position: row.position,
    cardHash: row.card_hash,
    workerProof: Bytes32Schema.array().parse(row.worker_proof),
    chapterProof: Bytes32Schema.array().parse(row.chapter_proof),
  });
}

function rewardFromRow(raw: unknown): WorkUnitRewardV2 {
  const row = WorkUnitRewardRowSchemaV2.parse(raw);
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
    signedTransaction: row.signed_transaction as TransactionSerialized | null,
    treasuryNonce: row.treasury_nonce === null ? null : BigInt(row.treasury_nonce),
    txHash: row.tx_hash,
  };
}

function workflowJobFromRow(raw: unknown): WorkflowJobV2 {
  const row = WorkflowJobRowSchemaV2.parse(raw);
  return {
    jobId: row.job_id,
    projectId: row.project_id,
    kind: row.kind as WorkflowJobKindV2,
    chapterId: row.chapter_id,
    workUnitId: row.work_unit_id,
    status: row.status as WorkflowJobStatusV2,
    attempt: row.attempt,
    input: row.input,
    lastError: row.last_error,
  };
}

function chapterDesignRunFromRow(raw: unknown): ChapterDesignRunV3 {
  const row = ChapterDesignRunRowSchemaV3.parse(raw);
  return {
    designRunId: row.design_run_id,
    projectId: row.project_id,
    chapterId: row.chapter_id,
    outlineVersion: row.outline_version,
    policyVersion: row.policy_version,
    status: row.status,
    attempt: row.attempt,
  };
}

export class SupabaseProjectRunnerRepositoryV2 implements ProjectRunnerRepositoryV2, WorkflowJobRepositoryV2, WorkflowDispatchRepositoryV2, WorkUnitRewardRepositoryV2, ChapterDesignRepositoryV3, ProjectDesignFreezeRepositoryV3 {
  static connect(
    url: string,
    serviceRoleKey: string,
    rewardIntent: { treasuryAddress: `0x${string}`; amountWei: bigint },
  ) {
    return new SupabaseProjectRunnerRepositoryV2(
      createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }),
      rewardIntent,
    );
  }

  constructor(
    private readonly client: SupabaseClient,
    private readonly rewardIntent: { treasuryAddress: `0x${string}`; amountWei: bigint },
  ) {}

  async recoverStaleWorkflowJobs(): Promise<number> {
    const { data, error } = await this.client.rpc("recover_stale_workflow_jobs_v2");
    if (error) throw new Error(errorMessage(error, "recover stale workflow jobs"));
    return Number(data ?? 0);
  }

  async claimNextWorkflowJob(kinds: WorkflowJobKindV2[]): Promise<WorkflowJobV2 | null> {
    const { data, error } = await this.client.rpc("claim_next_workflow_job_v2", { p_kinds: kinds });
    if (error) throw new Error(errorMessage(error, "claim next workflow job"));
    const row = Array.isArray(data) ? data[0] : data;
    return row ? workflowJobFromRow(row) : null;
  }

  async completeWorkflowJob(jobId: string, output: Record<string, unknown>): Promise<void> {
    const { error } = await this.client.rpc("complete_workflow_job_v2", {
      p_job_id: jobId,
      p_output: output,
    });
    if (error) throw new Error(errorMessage(error, "complete workflow job"));
  }

  async retryWorkflowJob(jobId: string, message: string): Promise<void> {
    const { error } = await this.client.rpc("retry_workflow_job_v2", {
      p_job_id: jobId,
      p_error: message.slice(0, 500),
    });
    if (error) throw new Error(errorMessage(error, "retry workflow job"));
  }

  async loadOutlinePlanningSource(projectId: Hex): Promise<OutlinePlanningSourceV2> {
    const [projectResult, headResult, blocksResult] = await Promise.all([
      this.client.from("learning_projects")
        .select("project_id,owner_address,goal,source_hash")
        .eq("project_id", projectId).maybeSingle(),
      this.client.from("project_outline_versions").select("version")
        .eq("project_id", projectId).order("version", { ascending: false }).limit(1).maybeSingle(),
      this.client.from("source_blocks").select("block_index,page_number,kind,text,block_hash,heading_level")
        .eq("project_id", projectId).order("block_index"),
    ]);
    const error = projectResult.error ?? headResult.error ?? blocksResult.error;
    if (error || !projectResult.data) throw new Error(errorMessage(error, "load outline planning source"));
    const project = z.object({
      project_id: Bytes32Schema,
      owner_address: AddressSchema,
      goal: z.string().nullable(),
      source_hash: Bytes32Schema,
    }).parse(projectResult.data);
    return {
      projectId: project.project_id,
      ownerAddress: project.owner_address,
      goal: project.goal,
      sourceHash: project.source_hash,
      headVersion: headResult.data ? z.number().int().parse(headResult.data.version) : null,
      sourceBlocks: SourceBlockSchema.array().min(1).parse((blocksResult.data ?? []).map((block) => ({
        blockIndex: block.block_index,
        pageNumber: block.page_number,
        kind: block.kind,
        text: block.text,
        blockHash: block.block_hash,
        headingLevel: block.heading_level,
      }))),
    };
  }

  async saveProjectOutlineDraft(input: Parameters<WorkflowJobRepositoryV2["saveProjectOutlineDraft"]>[0]): Promise<number> {
    const { data, error } = await this.client.rpc("save_project_outline_draft_v2", {
      p_project_id: input.projectId,
      p_owner: input.ownerAddress,
      p_expected_head_version: input.expectedHeadVersion,
      p_outline_hash: input.outlineHash,
      p_planner_version: input.plannerVersion,
      p_items: input.chapters,
    });
    if (error) throw new Error(errorMessage(error, "save Project Outline Draft"));
    return Number(data);
  }

  async loadChapterDesignSource(projectId: Hex, chapterId: number) {
    const [projectResult, chapterResult] = await Promise.all([
      this.client.from("learning_projects")
        .select("project_id,goal,outline_version")
        .eq("project_id", projectId).maybeSingle(),
      this.client.from("chapters")
        .select("chapter_id,position,title,summary,start_block,end_block,page_start,page_end,source_hash,importance")
        .eq("project_id", projectId).eq("chapter_id", chapterId).maybeSingle(),
    ]);
    const error = projectResult.error ?? chapterResult.error;
    if (error || !projectResult.data || !chapterResult.data) {
      throw new Error(errorMessage(error, "load Chapter Design source"));
    }
    const project = z.object({
      project_id: Bytes32Schema,
      goal: z.string().nullable(),
      outline_version: z.number().int().positive(),
    }).parse(projectResult.data);
    const chapter = ChapterOutlineItemSchema.parse({
      chapterId: chapterResult.data.chapter_id,
      position: chapterResult.data.position,
      title: chapterResult.data.title,
      summary: chapterResult.data.summary,
      startBlock: chapterResult.data.start_block,
      endBlock: chapterResult.data.end_block,
      pageStart: chapterResult.data.page_start,
      pageEnd: chapterResult.data.page_end,
      sourceHash: chapterResult.data.source_hash,
      importance: chapterResult.data.importance,
    });
    const { data: blockRows, error: blocksError } = await this.client.from("source_blocks")
      .select("block_index,page_number,kind,text,block_hash,heading_level")
      .eq("project_id", projectId)
      .gte("block_index", chapter.startBlock)
      .lte("block_index", chapter.endBlock)
      .order("block_index");
    if (blocksError) throw new Error(errorMessage(blocksError, "load Chapter Design Source Blocks"));
    return {
      projectId: project.project_id,
      goal: project.goal,
      outlineVersion: project.outline_version,
      chapter,
      sourceBlocks: SourceBlockSchema.array().min(1).parse((blockRows ?? []).map((block) => ({
        blockIndex: block.block_index,
        pageNumber: block.page_number,
        kind: block.kind,
        text: block.text,
        blockHash: block.block_hash,
        headingLevel: block.heading_level,
      }))),
    };
  }

  async startChapterDesign(projectId: Hex, chapterId: number, outlineVersion: number) {
    const { data, error } = await this.client.rpc("start_chapter_design_v3", {
      p_project_id: projectId,
      p_chapter_id: chapterId,
      p_outline_version: outlineVersion,
      p_policy_version: 3,
    });
    if (error) throw new Error(errorMessage(error, "start Chapter Design"));
    const { data: row, error: rowError } = await this.client.from("chapter_design_runs")
      .select("design_run_id,project_id,chapter_id,outline_version,policy_version,status,attempt")
      .eq("design_run_id", z.string().uuid().parse(data)).single();
    if (rowError) throw new Error(errorMessage(rowError, "load started Chapter Design"));
    return chapterDesignRunFromRow(row);
  }

  async completeChapterDesign(input: Parameters<ChapterDesignRepositoryV3["completeChapterDesign"]>[0]): Promise<void> {
    const { error } = await this.client.rpc("complete_chapter_design_v3", {
      p_design_run_id: input.designRunId,
      p_inventory: input.inventory,
      p_blueprint: input.blueprint,
      p_inventory_hash: input.inventoryHash,
      p_blueprint_hash: input.blueprintHash,
      p_prompt_version: input.promptVersion,
      p_model_id: input.modelId,
      p_metrics: input.metrics,
    });
    if (error) throw new Error(errorMessage(error, "complete Chapter Design"));
  }

  async failChapterDesign(designRunId: string, message: string, exhausted = false): Promise<void> {
    const { error } = await this.client.rpc("fail_chapter_design_v3", {
      p_design_run_id: designRunId,
      p_error: message.slice(0, 500),
      p_exhausted: exhausted,
    });
    if (error) throw new Error(errorMessage(error, "fail Chapter Design"));
  }

  async loadProjectDesignFreezeSource(projectId: Hex) {
    const [projectResult, chaptersResult, blocksResult, runsResult] = await Promise.all([
      this.client.from("learning_projects")
        .select("project_id,source_hash,goal_hash,outline_hash,outline_version")
        .eq("project_id", projectId).single(),
      this.client.from("chapters")
        .select("chapter_id,position,title,summary,start_block,end_block,page_start,page_end,source_hash,importance")
        .eq("project_id", projectId).order("position"),
      this.client.from("source_blocks")
        .select("block_index,page_number,kind,text,block_hash,heading_level")
        .eq("project_id", projectId).order("block_index"),
      this.client.from("chapter_design_runs")
        .select("chapter_id,inventory,blueprint,inventory_hash,blueprint_hash")
        .eq("project_id", projectId).eq("status", "COMPLETED").order("chapter_id"),
    ]);
    const error = projectResult.error ?? chaptersResult.error ?? blocksResult.error ?? runsResult.error;
    if (error || !projectResult.data) throw new Error(errorMessage(error, "load Project Design freeze source"));
    const project = z.object({
      project_id: Bytes32Schema,
      source_hash: Bytes32Schema,
      goal_hash: Bytes32Schema,
      outline_hash: Bytes32Schema,
      outline_version: z.number().int().positive(),
    }).parse(projectResult.data);
    const chapters = (chaptersResult.data ?? []).map((chapter) => ChapterOutlineItemSchema.parse({
      chapterId: chapter.chapter_id,
      position: chapter.position,
      title: chapter.title,
      summary: chapter.summary,
      startBlock: chapter.start_block,
      endBlock: chapter.end_block,
      pageStart: chapter.page_start,
      pageEnd: chapter.page_end,
      sourceHash: chapter.source_hash,
      importance: chapter.importance,
    }));
    return {
      projectId: project.project_id,
      sourceHash: project.source_hash,
      goalHash: project.goal_hash,
      outlineHash: project.outline_hash,
      outlineVersion: project.outline_version,
      chapters,
      sourceBlocks: SourceBlockSchema.array().min(1).parse((blocksResult.data ?? []).map((block) => ({
        blockIndex: block.block_index,
        pageNumber: block.page_number,
        kind: block.kind,
        text: block.text,
        blockHash: block.block_hash,
        headingLevel: block.heading_level,
      }))),
      designs: (runsResult.data ?? []).map((run) => ({
        chapterId: z.number().int().min(0).max(15).parse(run.chapter_id),
        inventory: ChapterConceptInventorySchema.parse(run.inventory),
        blueprint: CardBlueprintSchema.parse(run.blueprint),
        inventoryHash: Bytes32Schema.parse(run.inventory_hash),
        blueprintHash: Bytes32Schema.parse(run.blueprint_hash),
      })),
    };
  }

  async freezeProjectDesign(input: Parameters<ProjectDesignFreezeRepositoryV3["freezeProjectDesign"]>[0]): Promise<void> {
    const { error } = await this.client.rpc("freeze_project_design_v3", {
      p_project_id: input.projectId,
      p_outline_version: input.outlineVersion,
      p_work_unit_manifest_root: input.workUnitManifestRoot,
      p_work_units: input.workUnits,
      p_slot_assignments: input.slotAssignments,
      p_frozen_design_hash: input.frozenDesignHash,
      p_creation_intent: input.creationIntent,
    });
    if (error) throw new Error(errorMessage(error, "freeze Project Design"));
  }

  async claimWorkflowWorkUnit(
    projectId: Hex,
    workUnitId: number,
    workerAddress: `0x${string}`,
  ): Promise<RunnerWorkUnitV2 | null> {
    const { data, error } = await this.client.rpc("claim_work_unit_for_workflow_v2", {
      p_project_id: projectId,
      p_work_unit_id: workUnitId,
      p_worker_address: workerAddress,
    });
    if (error) throw new Error(errorMessage(error, "claim workflow Work Unit"));
    const row = Array.isArray(data) ? data[0] : data;
    return row ? workUnitFromRow(row) : null;
  }

  async claimWorkflowChapterQualityCheck(projectId: Hex, chapterId: number): Promise<boolean> {
    const { data, error } = await this.client.rpc("claim_chapter_quality_check_for_workflow_v2", {
      p_project_id: projectId,
      p_chapter_id: chapterId,
    });
    if (error) throw new Error(errorMessage(error, "claim workflow Chapter quality check"));
    return Boolean(data);
  }

  async claimWorkflowChapterAssembly(projectId: Hex, chapterId: number): Promise<boolean> {
    const { data, error } = await this.client.rpc("claim_chapter_assembly_for_workflow_v2", {
      p_project_id: projectId,
      p_chapter_id: chapterId,
    });
    if (error) throw new Error(errorMessage(error, "claim workflow Chapter assembly"));
    return Boolean(data);
  }

  async claimWorkflowProjectFinalization(projectId: Hex): Promise<boolean> {
    const { data, error } = await this.client.rpc("claim_project_finalization_for_workflow_v2", {
      p_project_id: projectId,
    });
    if (error) throw new Error(errorMessage(error, "claim workflow Project finalization"));
    return Boolean(data);
  }

  async claimWorkflowWorkUnitReward(projectId: Hex, workUnitId: number): Promise<WorkUnitRewardV2 | null> {
    const { data, error } = await this.client.rpc("claim_work_unit_reward_for_workflow_v2", {
      p_project_id: projectId,
      p_work_unit_id: workUnitId,
    });
    if (error) throw new Error(errorMessage(error, "claim workflow Work Unit reward"));
    const row = Array.isArray(data) ? data[0] : data;
    return row ? rewardFromRow(row) : null;
  }

  async listPendingRegistryProjects(limit: number) {
    const { data, error } = await this.client.from("learning_projects").select(
      "project_id,owner_address,source_hash,goal_hash,outline_hash,work_unit_manifest_root,chapters(count),work_units(count)",
    ).eq("status", "AWAITING_REGISTRY").order("updated_at").limit(limit);
    if (error) throw new Error(errorMessage(error, "list V2 Registry reconciliation intents"));
    return (data ?? []).map((raw) => {
      const row = raw as unknown as {
        project_id: unknown;
        owner_address: unknown;
        source_hash: unknown;
        goal_hash: unknown;
        outline_hash: unknown;
        work_unit_manifest_root: unknown;
        chapters: Array<{ count: number }>;
        work_units: Array<{ count: number }>;
      };
      return {
        projectId: Bytes32Schema.parse(row.project_id),
        ownerAddress: AddressSchema.parse(row.owner_address),
        sourceHash: Bytes32Schema.parse(row.source_hash),
        goalHash: Bytes32Schema.parse(row.goal_hash),
        outlineHash: Bytes32Schema.parse(row.outline_hash),
        workUnitManifestRoot: Bytes32Schema.parse(row.work_unit_manifest_root),
        chapterCount: Number(row.chapters?.[0]?.count ?? 0),
        workUnitCount: Number(row.work_units?.[0]?.count ?? 0),
      };
    });
  }

  async markProjectRegistryReconciled(projectId: Hex): Promise<void> {
    const { data, error } = await this.client.from("learning_projects")
      .update({ status: "GENERATING", last_error: null })
      .eq("project_id", projectId).eq("status", "AWAITING_REGISTRY")
      .select("project_id").maybeSingle();
    if (error || !data) throw new Error(errorMessage(error, "reconcile V2 Registry Project"));
  }

  async getWorkUnit(projectId: Hex, workUnitId: number): Promise<RunnerWorkUnitV2> {
    const { data, error } = await this.client.from("work_units").select("*")
      .eq("project_id", projectId).eq("work_unit_id", workUnitId).maybeSingle();
    if (error || !data) throw new Error(errorMessage(error, "load V2 Work Unit"));
    return workUnitFromRow(data);
  }

  async getWorkUnitBlueprintContext(projectId: Hex, workUnitId: number) {
    const unit = await this.getWorkUnit(projectId, workUnitId);
    const [runResult, slotsResult] = await Promise.all([
      this.client.from("chapter_design_runs")
        .select("design_run_id,inventory,blueprint")
        .eq("project_id", projectId).eq("chapter_id", unit.chapterId)
        .eq("status", "COMPLETED").single(),
      this.client.from("card_blueprint_slots")
        .select("slot_id")
        .eq("project_id", projectId).eq("chapter_id", unit.chapterId)
        .eq("assigned_work_unit_id", workUnitId).order("created_at"),
    ]);
    const error = runResult.error ?? slotsResult.error;
    if (error || !runResult.data) throw new Error(errorMessage(error, "load V3 Work Unit Blueprint"));
    const blueprint = CardBlueprintSchema.parse(runResult.data.blueprint);
    const assignedSlotIds = new Set((slotsResult.data ?? []).map((slot) => Bytes32Schema.parse(slot.slot_id)));
    const slots = blueprint.slots.filter((slot) => assignedSlotIds.has(slot.slotId));
    if (slots.length !== assignedSlotIds.size || slots.length === 0) {
      throw new Error("V3 Work Unit Blueprint Slot assignment is incomplete");
    }
    return {
      designRunId: z.string().uuid().parse(runResult.data.design_run_id),
      inventory: ChapterConceptInventorySchema.parse(runResult.data.inventory),
      blueprint,
      slots,
    };
  }

  async markWorkUnitValidating(projectId: Hex, workUnitId: number): Promise<void> {
    const { data, error } = await this.client.from("work_units")
      .update({ status: "VALIDATING", lease_until: new Date(Date.now() + 60_000).toISOString() })
      .eq("project_id", projectId).eq("work_unit_id", workUnitId).eq("status", "GENERATING")
      .select("work_unit_id").maybeSingle();
    if (error || !data) throw new Error(errorMessage(error, "mark V2 Work Unit validating"));
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
        p_project_id: projectId,
        p_work_unit_id: workUnitId,
        p_cards_root: result.cardsRoot,
        p_generation_ms: result.generationMs,
        p_candidates: candidates,
      });
      if (error) throw new Error(errorMessage(error, "save V3 Work Unit candidates"));
      return;
    }
    const { data, error } = await this.client.from("work_units").update({
      worker_cards: result.cards,
      cards_root: result.cardsRoot,
      card_count: result.cards.length,
      generation_ms: result.generationMs,
      status: "CANDIDATE_READY",
      lease_until: null,
      last_error: null,
    }).eq("project_id", projectId).eq("work_unit_id", workUnitId)
      .in("status", ["GENERATING", "VALIDATING"]).select("work_unit_id").maybeSingle();
    if (error || !data) throw new Error(errorMessage(error, "save V2 Work Unit cards"));
  }

  async markWorkUnitSubmitting(projectId: Hex, workUnitId: number, txHash: Hex): Promise<void> {
    const { data, error } = await this.client.from("work_units")
      .update({ status: "SUBMITTING", commit_tx_hash: txHash, last_error: null })
      .eq("project_id", projectId).eq("work_unit_id", workUnitId)
      .in("status", ["APPROVED", "SUBMITTING"]).select("work_unit_id").maybeSingle();
    if (error || !data) throw new Error(errorMessage(error, "mark V2 Work Unit submitting"));
  }

  async markWorkUnitConfirmed(
    projectId: Hex,
    workUnitId: number,
    confirmation: { txHash: Hex | null; blockNumber: bigint; gasUsed: bigint | null; confirmationMs: number },
  ): Promise<void> {
    const { error } = await this.client.rpc("confirm_work_unit_and_enqueue_reward_v2", {
      p_project_id: projectId,
      p_work_unit_id: workUnitId,
      p_tx_hash: confirmation.txHash,
      p_block_number: confirmation.blockNumber.toString(),
      p_gas_used: confirmation.gasUsed?.toString() ?? null,
      p_confirmation_ms: confirmation.confirmationMs,
      p_treasury_address: this.rewardIntent.treasuryAddress,
      p_amount_wei: this.rewardIntent.amountWei.toString(),
    });
    if (error) throw new Error(errorMessage(error, "confirm V2 Work Unit"));
  }

  async markWorkUnitRetryable(projectId: Hex, workUnitId: number, message: string): Promise<void> {
    const { error } = await this.client.rpc("mark_work_unit_retryable_v2", {
      p_project_id: projectId,
      p_work_unit_id: workUnitId,
      p_error: message.slice(0, 500),
    });
    if (error) throw new Error(errorMessage(error, "release V2 Work Unit"));
  }

  async approveChapterCandidates(
    projectId: Hex,
    chapterId: number,
    workUnits: Parameters<ProjectRunnerRepositoryV2["approveChapterCandidates"]>[2],
  ): Promise<void> {
    const { error } = await this.client.rpc("approve_chapter_candidates_v2", {
      p_project_id: projectId,
      p_chapter_id: chapterId,
      p_work_units: workUnits.map((unit) => ({
        work_unit_id: unit.workUnitId,
        worker_cards: unit.cards,
        cards_root: unit.cardsRoot,
        card_count: unit.cards.length,
      })),
    });
    if (error) throw new Error(errorMessage(error, "approve V2 Chapter candidates"));
  }

  async requestChapterCandidateRepair(
    projectId: Hex,
    chapterId: number,
    message: string,
  ): Promise<void> {
    const { error } = await this.client.rpc("request_chapter_candidate_repair_v2", {
      p_project_id: projectId,
      p_chapter_id: chapterId,
      p_error: message.slice(0, 500),
    });
    if (error) throw new Error(errorMessage(error, "request V2 Chapter candidate repair"));
  }

  async getChapterBundle(projectId: Hex, chapterId: number): Promise<ChapterBundleV2> {
    const [projectResult, chapterResult, unitsResult] = await Promise.all([
      this.client.from("learning_projects").select("*").eq("project_id", projectId).maybeSingle(),
      this.client.from("chapters").select("*").eq("project_id", projectId).eq("chapter_id", chapterId).maybeSingle(),
      this.client.from("work_units").select("*").eq("project_id", projectId).eq("chapter_id", chapterId).order("unit_index"),
    ]);
    const error = projectResult.error ?? chapterResult.error ?? unitsResult.error;
    if (error || !projectResult.data || !chapterResult.data) throw new Error(errorMessage(error, "load V2 Chapter bundle"));
    return {
      project: projectFromRow(projectResult.data),
      chapter: chapterFromRow(chapterResult.data),
      workUnits: (unitsResult.data ?? []).map(workUnitFromRow),
    };
  }

  async saveChapterAssembly(projectId: Hex, chapterId: number, assembly: ChapterAssemblyV2): Promise<void> {
    const cards = assembly.cards.map((card) => ({
      card_id: card.id,
      project_id: card.projectId,
      chapter_id: card.chapterId,
      work_unit_id: card.workUnitId,
      position: card.position,
      content: {
        type: card.type, question: card.question, answer: card.answer, keyPoint: card.keyPoint,
        source: card.source, tags: card.tags, importance: card.importance,
        initialDifficulty: card.initialDifficulty,
      },
      card_hash: card.cardHash,
      worker_proof: card.workerProof,
      chapter_proof: card.chapterProof,
    }));
    const { error } = await this.client.rpc("save_chapter_assembly_v2", {
      p_project_id: projectId,
      p_chapter_id: chapterId,
      p_cards_root: assembly.cardsRoot,
      p_cards: cards,
    });
    if (error) throw new Error(errorMessage(error, "save V2 Chapter assembly"));
  }

  async markChapterReady(projectId: Hex, chapterId: number, txHash: Hex | null): Promise<void> {
    const { error } = await this.client.rpc("mark_chapter_ready_v2", {
      p_project_id: projectId, p_chapter_id: chapterId, p_tx_hash: txHash,
    });
    if (error) throw new Error(errorMessage(error, "mark V2 Chapter ready"));
  }

  async markChapterRetryable(projectId: Hex, chapterId: number, message: string): Promise<void> {
    const { error } = await this.client.rpc("mark_chapter_retryable_v2", {
      p_project_id: projectId, p_chapter_id: chapterId, p_error: message.slice(0, 500),
    });
    if (error) throw new Error(errorMessage(error, "release V2 Chapter assembly"));
  }

  async getProjectBundle(projectId: Hex): Promise<ProjectBundleV2> {
    const [projectResult, chaptersResult, cardsResult] = await Promise.all([
      this.client.from("learning_projects").select("*").eq("project_id", projectId).maybeSingle(),
      this.client.from("chapters").select("*").eq("project_id", projectId).order("position"),
      this.client.from("knowledge_cards").select("*").eq("project_id", projectId).order("chapter_id").order("position"),
    ]);
    const error = projectResult.error ?? chaptersResult.error ?? cardsResult.error;
    if (error || !projectResult.data) throw new Error(errorMessage(error, "load V2 Project bundle"));
    return {
      project: projectFromRow(projectResult.data),
      chapters: (chaptersResult.data ?? []).map(chapterFromRow),
      cards: (cardsResult.data ?? []).map(cardFromRow),
    };
  }

  async saveProjectFinalization(
    input: Parameters<ProjectRunnerRepositoryV2["saveProjectFinalization"]>[0],
  ): Promise<void> {
    const { error } = await this.client.rpc("save_project_finalization_v2", {
      p_project_id: input.projectId,
      p_project_deck_root: input.projectDeckRoot,
      p_initial_plan: input.initialPlan,
      p_initial_plan_hash: input.initialPlanHash,
      p_total_card_count: input.totalCardCount,
    });
    if (error) throw new Error(errorMessage(error, "save V2 Project finalization"));
  }

  async markProjectReady(input: Parameters<ProjectRunnerRepositoryV2["markProjectReady"]>[0]): Promise<void> {
    const { error } = await this.client.rpc("mark_project_ready_v2", {
      p_project_id: input.projectId,
      p_project_deck_root: input.projectDeckRoot,
      p_initial_plan: input.initialPlan,
      p_initial_plan_hash: input.initialPlanHash,
      p_total_card_count: input.totalCardCount,
      p_tx_hash: input.txHash,
    });
    if (error) throw new Error(errorMessage(error, "mark V2 Project ready"));
  }

  async markProjectRetryable(projectId: Hex, message: string): Promise<void> {
    const { error } = await this.client.rpc("mark_project_retryable_v2", {
      p_project_id: projectId, p_error: message.slice(0, 500),
    });
    if (error) throw new Error(errorMessage(error, "release V2 Project finalization"));
  }

  async recordProjectAgentEvent(event: Parameters<ProjectRunnerRepositoryV2["recordProjectAgentEvent"]>[0]): Promise<void> {
    const { error } = await this.client.from("project_agent_events").insert({
      project_id: event.projectId,
      chapter_id: event.chapterId ?? null,
      work_unit_id: event.workUnitId ?? null,
      agent_role: event.role,
      event_type: event.type,
      payload: event.payload ?? {},
      tx_hash: event.txHash ?? null,
    });
    if (error) throw new Error(errorMessage(error, "record V2 agent event"));
  }

  async markWorkUnitRewardStage(
    projectId: Hex,
    workUnitId: number,
    stage: "DISCOVERED" | "LOADED" | "BUILT",
  ): Promise<void> {
    const { error } = await this.client.from("work_unit_rewards")
      .update({ moss_stage: stage, lease_until: new Date(Date.now() + 90_000).toISOString() })
      .eq("project_id", projectId).eq("work_unit_id", workUnitId);
    if (error) throw new Error(errorMessage(error, "advance V2 Moss reward stage"));
  }

  async markWorkUnitRewardPrepared(
    projectId: Hex,
    workUnitId: number,
    prepared: PreparedWorkerReward,
  ): Promise<void> {
    const { error } = await this.client.from("work_unit_rewards").update({
      status: "PREPARED",
      moss_stage: "SIMULATED",
      moss_plan_hash: prepared.mossPlanHash,
      simulation_status: "PASSED",
      simulation_warning_codes: prepared.simulationWarningCodes,
      simulation_gas: prepared.simulationGas?.toString() ?? null,
      signed_transaction: prepared.signedTransaction,
      treasury_nonce: prepared.treasuryNonce.toString(),
      tx_hash: prepared.txHash,
      lease_until: new Date(Date.now() + 90_000).toISOString(),
      last_error: null,
    }).eq("project_id", projectId).eq("work_unit_id", workUnitId);
    if (error) throw new Error(errorMessage(error, "persist prepared V2 Moss reward"));
  }

  async markWorkUnitRewardSubmitting(projectId: Hex, workUnitId: number, txHash: Hex): Promise<void> {
    const { error } = await this.client.from("work_unit_rewards").update({
      status: "SUBMITTING", tx_hash: txHash,
      lease_until: new Date(Date.now() + 90_000).toISOString(), last_error: null,
    }).eq("project_id", projectId).eq("work_unit_id", workUnitId);
    if (error) throw new Error(errorMessage(error, "mark V2 Moss reward submitting"));
  }

  async markWorkUnitRewardConfirmed(
    projectId: Hex,
    workUnitId: number,
    receipt: WorkerRewardReceipt,
  ): Promise<void> {
    const { error } = await this.client.from("work_unit_rewards").update({
      status: "CONFIRMED", tx_hash: receipt.txHash,
      confirmed_block: receipt.blockNumber.toString(), gas_used: receipt.gasUsed.toString(),
      confirmation_ms: receipt.confirmationMs, lease_until: null, last_error: null,
    }).eq("project_id", projectId).eq("work_unit_id", workUnitId);
    if (error) throw new Error(errorMessage(error, "confirm V2 Moss reward"));
  }

  async markWorkUnitRewardRetryable(projectId: Hex, workUnitId: number, message: string): Promise<void> {
    const { error } = await this.client.rpc("release_work_unit_reward_v2", {
      p_project_id: projectId, p_work_unit_id: workUnitId, p_error: message.slice(0, 500),
    });
    if (error) throw new Error(errorMessage(error, "release V2 Moss reward"));
  }

  async markWorkUnitRewardBlocked(
    projectId: Hex,
    workUnitId: number,
    message: string,
    warningCodes: string[] = [],
  ): Promise<void> {
    const { error } = await this.client.from("work_unit_rewards").update({
      status: "BLOCKED", simulation_status: "FAILED",
      simulation_warning_codes: warningCodes, lease_until: null,
      last_error: message.slice(0, 500),
    }).eq("project_id", projectId).eq("work_unit_id", workUnitId);
    if (error) throw new Error(errorMessage(error, "block invalid V2 Moss reward"));
  }
}
