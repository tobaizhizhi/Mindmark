import { SourceBlockSchema } from "@mindmark/shared/chapter";
import { AddressSchema, Bytes32Schema } from "@mindmark/shared/schemas";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Hex } from "viem";
import type {
  OutlinePlanningSourceV2,
  SavedProjectOutlineDraftV2,
  WorkflowDispatchRepositoryV2,
  WorkflowJobKindV2,
  WorkflowJobV2,
  WorkUnitRewardV2,
  RunnerWorkUnitV2,
} from "../types-v2.js";
import { persistenceError, rewardFromRow, workflowJobFromRow, workUnitFromRow } from "./shared.js";

export class SupabaseWorkflowRepositoryV2 implements WorkflowDispatchRepositoryV2 {
  constructor(private readonly client: SupabaseClient) {}

  async recoverStaleWorkflowJobs(): Promise<number> {
    const { data, error } = await this.client.rpc("recover_stale_workflow_jobs_v2");
    if (error) throw new Error(persistenceError(error, "recover stale workflow jobs"));
    return Number(data ?? 0);
  }

  async claimNextWorkflowJob(kinds: WorkflowJobKindV2[]): Promise<WorkflowJobV2 | null> {
    const { data, error } = await this.client.rpc("claim_next_workflow_job_v2", { p_kinds: kinds });
    if (error) throw new Error(persistenceError(error, "claim next workflow job"));
    const row = Array.isArray(data) ? data[0] : data;
    return row ? workflowJobFromRow(row) : null;
  }

  async claimNextGenerationWorkflowJob(workerIndex: number): Promise<WorkflowJobV2 | null> {
    const { data, error } = await this.client.rpc("claim_next_generation_workflow_job_for_worker_v2", {
      p_worker_index: workerIndex,
    });
    if (error) throw new Error(persistenceError(error, "claim next generation workflow job for worker"));
    const row = Array.isArray(data) ? data[0] : data;
    return row ? workflowJobFromRow(row) : null;
  }

  async completeWorkflowJob(jobId: string, output: Record<string, unknown>): Promise<void> {
    const { error } = await this.client.rpc("complete_workflow_job_v2", { p_job_id: jobId, p_output: output });
    if (error) throw new Error(persistenceError(error, "complete workflow job"));
  }

  async retryWorkflowJob(jobId: string, message: string): Promise<void> {
    const { error } = await this.client.rpc("retry_workflow_job_v2", { p_job_id: jobId, p_error: message.slice(0, 500) });
    if (error) throw new Error(persistenceError(error, "retry workflow job"));
  }

  async loadOutlinePlanningSource(projectId: Hex): Promise<OutlinePlanningSourceV2> {
    const [projectResult, headResult, blocksResult] = await Promise.all([
      this.client.from("learning_projects").select("project_id,owner_address,goal,source_hash").eq("project_id", projectId).maybeSingle(),
      this.client.from("project_outline_versions").select("version").eq("project_id", projectId).order("version", { ascending: false }).limit(1).maybeSingle(),
      this.client.from("source_blocks").select("block_index,page_number,kind,text,block_hash,heading_level").eq("project_id", projectId).order("block_index"),
    ]);
    const error = projectResult.error ?? headResult.error ?? blocksResult.error;
    if (error || !projectResult.data) throw new Error(persistenceError(error, "load outline planning source"));
    const project = z.object({ project_id: Bytes32Schema, owner_address: AddressSchema, goal: z.string().nullable(), source_hash: Bytes32Schema }).parse(projectResult.data);
    return {
      projectId: project.project_id,
      ownerAddress: project.owner_address,
      goal: project.goal,
      sourceHash: project.source_hash,
      headVersion: headResult.data ? z.number().int().parse(headResult.data.version) : null,
      sourceBlocks: SourceBlockSchema.array().min(1).parse((blocksResult.data ?? []).map((block) => ({
        blockIndex: block.block_index, pageNumber: block.page_number, kind: block.kind, text: block.text,
        blockHash: block.block_hash, headingLevel: block.heading_level,
      }))),
    };
  }

  async saveProjectOutlineDraft(input: SavedProjectOutlineDraftV2): Promise<number> {
    const { data, error } = await this.client.rpc("save_project_outline_draft_v2", {
      p_project_id: input.projectId,
      p_owner: input.ownerAddress,
      p_expected_head_version: input.expectedHeadVersion,
      p_outline_hash: input.outlineHash,
      p_planner_version: input.plannerVersion,
      p_items: input.chapters,
      p_exclusions: input.exclusions,
    });
    if (error) throw new Error(persistenceError(error, "save Project Outline Draft"));
    return Number(data);
  }

  async getWorkUnit(projectId: Hex, workUnitId: number): Promise<RunnerWorkUnitV2> {
    const { data, error } = await this.client.from("work_units").select("*")
      .eq("project_id", projectId).eq("work_unit_id", workUnitId).maybeSingle();
    if (error || !data) throw new Error(persistenceError(error, "load V2 Work Unit for Workflow dispatch"));
    return workUnitFromRow(data);
  }

  async claimWorkflowWorkUnit(projectId: Hex, workUnitId: number, workerAddress: `0x${string}`): Promise<RunnerWorkUnitV2 | null> {
    const { data, error } = await this.client.rpc("claim_work_unit_for_workflow_v2", {
      p_project_id: projectId, p_work_unit_id: workUnitId, p_worker_address: workerAddress,
    });
    if (error) throw new Error(persistenceError(error, "claim workflow Work Unit"));
    const row = Array.isArray(data) ? data[0] : data;
    return row ? workUnitFromRow(row) : null;
  }

  async claimWorkflowChapterQualityCheck(projectId: Hex, chapterId: number): Promise<boolean> {
    const { data, error } = await this.client.rpc("claim_chapter_quality_check_for_workflow_v2", { p_project_id: projectId, p_chapter_id: chapterId });
    if (error) throw new Error(persistenceError(error, "claim workflow Chapter quality check"));
    return Boolean(data);
  }

  async claimWorkflowChapterAssembly(projectId: Hex, chapterId: number): Promise<boolean> {
    const { data, error } = await this.client.rpc("claim_chapter_assembly_for_workflow_v2", { p_project_id: projectId, p_chapter_id: chapterId });
    if (error) throw new Error(persistenceError(error, "claim workflow Chapter assembly"));
    return Boolean(data);
  }

  async claimWorkflowProjectFinalization(projectId: Hex): Promise<boolean> {
    const { data, error } = await this.client.rpc("claim_project_finalization_for_workflow_v2", { p_project_id: projectId });
    if (error) throw new Error(persistenceError(error, "claim workflow Project finalization"));
    return Boolean(data);
  }

  async claimWorkflowWorkUnitReward(projectId: Hex, workUnitId: number): Promise<WorkUnitRewardV2 | null> {
    const { data, error } = await this.client.rpc("claim_work_unit_reward_for_workflow_v2", { p_project_id: projectId, p_work_unit_id: workUnitId });
    if (error) throw new Error(persistenceError(error, "claim workflow Work Unit reward"));
    const row = Array.isArray(data) ? data[0] : data;
    return row ? rewardFromRow(row) : null;
  }
}
