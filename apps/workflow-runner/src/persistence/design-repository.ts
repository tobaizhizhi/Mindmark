import {
  CardBlueprintSchema,
  ChapterCardPolicySchema,
  ChapterConceptInventorySchema,
  ChapterOutlineItemSchema,
  SourceBlockSchema,
  SourceExclusionRangeListSchema,
  filterExcludedSourceBlocks,
} from "@mindmark/shared/chapter";
import { Bytes32Schema } from "@mindmark/shared/schemas";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Hex } from "viem";
import type {
  ChapterDesignRepositoryV3,
  ChapterDesignRunV3,
  ProjectDesignFreezeRepositoryV3,
} from "../types-v2.js";
import { persistenceError } from "./shared.js";

const DesignRunRowSchema = z.object({
  design_run_id: z.string().uuid(), project_id: Bytes32Schema,
  chapter_id: z.number().int().min(0).max(15), outline_version: z.number().int().positive(),
  policy_version: z.literal(3), status: z.enum(["RUNNING", "COMPLETED", "REPAIR_EXHAUSTED", "FAILED", "CANCELLED"]),
  attempt: z.number().int().positive(),
});

function designRunFromRow(raw: unknown): ChapterDesignRunV3 {
  const row = DesignRunRowSchema.parse(raw);
  return { designRunId: row.design_run_id, projectId: row.project_id, chapterId: row.chapter_id, outlineVersion: row.outline_version, policyVersion: row.policy_version, status: row.status, attempt: row.attempt };
}

export class SupabaseDesignRepositoryV3 implements ChapterDesignRepositoryV3, ProjectDesignFreezeRepositoryV3 {
  constructor(private readonly client: SupabaseClient) {}

  async loadChapterDesignSource(projectId: Hex, chapterId: number) {
    const [projectResult, chapterResult] = await Promise.all([
      this.client.from("learning_projects").select("project_id,goal,outline_version").eq("project_id", projectId).maybeSingle(),
      this.client.from("chapters").select("chapter_id,position,title,summary,start_block,end_block,page_start,page_end,source_hash,importance,min_card_count,target_card_count,max_card_count,card_policy_version").eq("project_id", projectId).eq("chapter_id", chapterId).maybeSingle(),
    ]);
    const error = projectResult.error ?? chapterResult.error;
    if (error || !projectResult.data || !chapterResult.data) throw new Error(persistenceError(error, "load Chapter Design source"));
    const project = z.object({ project_id: Bytes32Schema, goal: z.string().nullable(), outline_version: z.number().int().positive() }).parse(projectResult.data);
    const chapter = ChapterOutlineItemSchema.parse({
      chapterId: chapterResult.data.chapter_id, position: chapterResult.data.position, title: chapterResult.data.title,
      summary: chapterResult.data.summary, startBlock: chapterResult.data.start_block, endBlock: chapterResult.data.end_block,
      pageStart: chapterResult.data.page_start, pageEnd: chapterResult.data.page_end,
      sourceHash: chapterResult.data.source_hash, importance: chapterResult.data.importance,
    });
    const cardPolicy = ChapterCardPolicySchema.parse({
      chapterId: chapter.chapterId, minCardCount: chapterResult.data.min_card_count,
      targetCardCount: chapterResult.data.target_card_count, maxCardCount: chapterResult.data.max_card_count,
      policyVersion: chapterResult.data.card_policy_version,
    });
    const [blocksResult, exclusionsResult] = await Promise.all([
      this.client.from("source_blocks").select("block_index,page_number,kind,text,block_hash,heading_level").eq("project_id", projectId).gte("block_index", chapter.startBlock).lte("block_index", chapter.endBlock).order("block_index"),
      this.client.from("project_outline_exclusions").select("start_block,end_block,category,reason").eq("project_id", projectId).eq("outline_version", project.outline_version).order("exclusion_index"),
    ]);
    const sourceError = blocksResult.error ?? exclusionsResult.error;
    if (sourceError) throw new Error(persistenceError(sourceError, "load Chapter Design Source Blocks"));
    const exclusions = SourceExclusionRangeListSchema.parse((exclusionsResult.data ?? []).map((range) => ({ startBlock: range.start_block, endBlock: range.end_block, category: range.category, reason: range.reason })));
    const chapterBlocks = SourceBlockSchema.array().min(1).parse((blocksResult.data ?? []).map((block) => ({ blockIndex: block.block_index, pageNumber: block.page_number, kind: block.kind, text: block.text, blockHash: block.block_hash, headingLevel: block.heading_level })));
    const learningBlocks = filterExcludedSourceBlocks(chapterBlocks, exclusions);
    if (learningBlocks.length === 0) throw new Error("Chapter Design source contains only excluded blocks");
    return { projectId: project.project_id, goal: project.goal, outlineVersion: project.outline_version, chapter, cardPolicy, sourceBlocks: learningBlocks };
  }

  async startChapterDesign(projectId: Hex, chapterId: number, outlineVersion: number) {
    const { data, error } = await this.client.rpc("start_chapter_design_v3", { p_project_id: projectId, p_chapter_id: chapterId, p_outline_version: outlineVersion, p_policy_version: 3 });
    if (error) throw new Error(persistenceError(error, "start Chapter Design"));
    const { data: row, error: rowError } = await this.client.from("chapter_design_runs").select("design_run_id,project_id,chapter_id,outline_version,policy_version,status,attempt").eq("design_run_id", z.string().uuid().parse(data)).single();
    if (rowError) throw new Error(persistenceError(rowError, "load started Chapter Design"));
    return designRunFromRow(row);
  }

  async completeChapterDesign(input: Parameters<ChapterDesignRepositoryV3["completeChapterDesign"]>[0]): Promise<void> {
    const { error } = await this.client.rpc("complete_chapter_design_v3", {
      p_design_run_id: input.designRunId, p_inventory: input.inventory, p_blueprint: input.blueprint,
      p_inventory_hash: input.inventoryHash, p_blueprint_hash: input.blueprintHash,
      p_prompt_version: input.promptVersion, p_model_id: input.modelId, p_metrics: input.metrics,
    });
    if (error) throw new Error(persistenceError(error, "complete Chapter Design"));
  }

  async failChapterDesign(designRunId: string, message: string, exhausted = false): Promise<void> {
    const { error } = await this.client.rpc("fail_chapter_design_v3", { p_design_run_id: designRunId, p_error: message.slice(0, 500), p_exhausted: exhausted });
    if (error) throw new Error(persistenceError(error, "fail Chapter Design"));
  }

  async loadProjectDesignFreezeSource(projectId: Hex) {
    const [projectResult, chaptersResult, blocksResult, runsResult, exclusionsResult] = await Promise.all([
      this.client.from("learning_projects").select("project_id,source_hash,goal_hash,outline_hash,outline_version").eq("project_id", projectId).single(),
      this.client.from("chapters").select("chapter_id,position,title,summary,start_block,end_block,page_start,page_end,source_hash,importance,min_card_count,target_card_count,max_card_count,card_policy_version").eq("project_id", projectId).order("position"),
      this.client.from("source_blocks").select("block_index,page_number,kind,text,block_hash,heading_level").eq("project_id", projectId).order("block_index"),
      this.client.from("chapter_design_runs").select("chapter_id,inventory,blueprint,inventory_hash,blueprint_hash").eq("project_id", projectId).eq("status", "COMPLETED").order("chapter_id"),
      this.client.from("project_outline_exclusions").select("outline_version,start_block,end_block,category,reason").eq("project_id", projectId).order("outline_version", { ascending: false }).order("exclusion_index"),
    ]);
    const error = projectResult.error ?? chaptersResult.error ?? blocksResult.error ?? runsResult.error ?? exclusionsResult.error;
    if (error || !projectResult.data) throw new Error(persistenceError(error, "load Project Design freeze source"));
    const project = z.object({ project_id: Bytes32Schema, source_hash: Bytes32Schema, goal_hash: Bytes32Schema, outline_hash: Bytes32Schema, outline_version: z.number().int().positive() }).parse(projectResult.data);
    const chapters = (chaptersResult.data ?? []).map((chapter) => ChapterOutlineItemSchema.parse({ chapterId: chapter.chapter_id, position: chapter.position, title: chapter.title, summary: chapter.summary, startBlock: chapter.start_block, endBlock: chapter.end_block, pageStart: chapter.page_start, pageEnd: chapter.page_end, sourceHash: chapter.source_hash, importance: chapter.importance }));
    const chapterPolicies = (chaptersResult.data ?? []).map((chapter) => ChapterCardPolicySchema.parse({ chapterId: chapter.chapter_id, minCardCount: chapter.min_card_count, targetCardCount: chapter.target_card_count, maxCardCount: chapter.max_card_count, policyVersion: chapter.card_policy_version }));
    return {
      projectId: project.project_id, sourceHash: project.source_hash, goalHash: project.goal_hash, outlineHash: project.outline_hash, outlineVersion: project.outline_version,
      chapters, chapterPolicies,
      sourceBlocks: SourceBlockSchema.array().min(1).parse((blocksResult.data ?? []).map((block) => ({ blockIndex: block.block_index, pageNumber: block.page_number, kind: block.kind, text: block.text, blockHash: block.block_hash, headingLevel: block.heading_level }))),
      excludedRanges: SourceExclusionRangeListSchema.parse((exclusionsResult.data ?? []).filter((range) => range.outline_version === project.outline_version).map((range) => ({ startBlock: range.start_block, endBlock: range.end_block, category: range.category, reason: range.reason }))),
      designs: (runsResult.data ?? []).map((run) => ({ chapterId: z.number().int().min(0).max(15).parse(run.chapter_id), inventory: ChapterConceptInventorySchema.parse(run.inventory), blueprint: CardBlueprintSchema.parse(run.blueprint), inventoryHash: Bytes32Schema.parse(run.inventory_hash), blueprintHash: Bytes32Schema.parse(run.blueprint_hash) })),
    };
  }

  async freezeProjectDesign(input: Parameters<ProjectDesignFreezeRepositoryV3["freezeProjectDesign"]>[0]): Promise<void> {
    const { error } = await this.client.rpc("freeze_project_design_v3", {
      p_project_id: input.projectId, p_outline_version: input.outlineVersion,
      p_work_unit_manifest_root: input.workUnitManifestRoot, p_work_units: input.workUnits,
      p_slot_assignments: input.slotAssignments, p_frozen_design_hash: input.frozenDesignHash,
      p_creation_intent: input.creationIntent,
    });
    if (error) throw new Error(persistenceError(error, "freeze Project Design"));
  }
}
