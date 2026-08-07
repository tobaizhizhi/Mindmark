import { OutlinePlanningOperationSchema } from "@mindmark/shared/learning-project";
import { Bytes32Schema } from "@mindmark/shared/schemas";
import { SourceExclusionRangeListSchema } from "@mindmark/shared/chapter";
import type { Hex } from "viem";
import { ApiError } from "../http";
import { getSupabaseAdmin } from "../supabase";
import type {
  ChapterSummaryRow,
  ChapterSummaryStore,
  DraftChapterRow,
  OutlineDraftInput,
  ProjectConfirmationStore,
  ProjectOutlineOperationStore,
  ProjectSourceBlockRow,
  ProjectSourceRow,
  ProjectSourceStore,
  ProjectSummaryRow,
  ProjectSummaryStore,
} from "./types";

export class SupabaseProjectSourceStore implements ProjectSourceStore {
  async registerSource(project: Record<string, unknown>, sourceBlocks: Record<string, unknown>[]): Promise<Hex> {
    const { data, error } = await getSupabaseAdmin().rpc("register_learning_project_source_v2", {
      p_project: project,
      p_source_blocks: sourceBlocks,
    });
    if (error) throw new Error(`Could not register Learning Project source: ${error.message}`);
    return Bytes32Schema.parse(data);
  }
}

async function loadProjectSource(projectId: Hex, owner: `0x${string}`): Promise<{
  project: ProjectSourceRow;
  headVersion: number | null;
  sourceBlocks: ProjectSourceBlockRow[];
} | null> {
  const client = getSupabaseAdmin();
  const [projectResult, headResult, blocksResult] = await Promise.all([
    client.from("learning_projects")
      .select("project_id,owner_address,title,goal,source_hash,goal_hash,outline_version,outline_hash,status")
      .eq("project_id", projectId).eq("owner_address", owner).maybeSingle(),
    client.from("project_outline_versions").select("version")
      .eq("project_id", projectId).order("version", { ascending: false }).limit(1).maybeSingle(),
    client.from("source_blocks").select("block_index,page_number,kind,text,block_hash,heading_level")
      .eq("project_id", projectId).order("block_index"),
  ]);
  const error = projectResult.error ?? headResult.error ?? blocksResult.error;
  if (error) throw new Error(`Could not load Learning Project source: ${error.message}`);
  if (!projectResult.data) return null;
  return {
    project: projectResult.data as ProjectSourceRow,
    headVersion: headResult.data ? Number(headResult.data.version) : null,
    sourceBlocks: (blocksResult.data ?? []) as ProjectSourceBlockRow[],
  };
}

async function saveOutlineDraft(input: OutlineDraftInput): Promise<number> {
  const { data, error } = await getSupabaseAdmin().rpc("save_project_outline_draft_v2", {
    p_project_id: input.projectId,
    p_owner: input.owner,
    p_expected_head_version: input.expectedHeadVersion,
    p_outline_hash: input.outlineHash,
    p_planner_version: input.plannerVersion,
    p_items: input.chapters,
    p_exclusions: input.exclusions,
  });
  if (error) throw new Error(`Could not save Project Outline Draft: ${error.message}`);
  return Number(data);
}

export class SupabaseProjectOutlineOperationStore implements ProjectOutlineOperationStore {
  async enqueue(projectId: Hex, owner: `0x${string}`): Promise<string> {
    const { data, error } = await getSupabaseAdmin().rpc("enqueue_outline_planning_v2", {
      p_project_id: projectId,
      p_owner: owner,
    });
    if (error) {
      if (error.message.includes("editable Learning Project source was not found")) {
        throw new ApiError(404, "project_source_not_found", "Editable Learning Project source was not found");
      }
      throw new Error(`Could not enqueue Project Outline planning: ${error.message}`);
    }
    return OutlinePlanningOperationSchema.shape.operationId.parse(data);
  }

  async get(projectId: Hex, owner: `0x${string}`, operationId?: string) {
    const client = getSupabaseAdmin();
    const projectResult = await client.from("learning_projects").select("project_id")
      .eq("project_id", projectId).eq("owner_address", owner).maybeSingle();
    if (projectResult.error) throw new Error(`Could not load Learning Project operation: ${projectResult.error.message}`);
    if (!projectResult.data) return null;
    let query = client.from("workflow_jobs")
      .select("job_id,project_id,status,attempt,last_error")
      .eq("project_id", projectId).eq("kind", "PLAN_OUTLINE")
      .order("created_at", { ascending: false }).limit(1);
    if (operationId) query = query.eq("job_id", OutlinePlanningOperationSchema.shape.operationId.parse(operationId));
    const { data, error } = await query.maybeSingle();
    if (error) throw new Error(`Could not load Project Outline operation: ${error.message}`);
    if (!data) return null;
    return OutlinePlanningOperationSchema.parse({
      operationId: data.job_id,
      projectId: data.project_id,
      status: data.status,
      attempt: data.attempt,
      lastError: data.last_error,
    });
  }
}

export class SupabaseProjectSummaryStore implements ProjectSummaryStore {
  async listOwned(owner: `0x${string}`, now: string): Promise<ProjectSummaryRow[]> {
    const { data, error } = await getSupabaseAdmin().rpc("get_project_summaries_v2", { p_owner: owner, p_now: now });
    if (error) throw new Error(`Could not list Learning Projects: ${error.message}`);
    return (data ?? []) as ProjectSummaryRow[];
  }
}

export class SupabaseChapterSummaryStore implements ChapterSummaryStore {
  async listOwned(owner: `0x${string}`, projectId: Hex, now: string): Promise<ChapterSummaryRow[]> {
    const { data, error } = await getSupabaseAdmin().rpc("get_chapter_summaries_v2", {
      p_owner: owner, p_project_id: projectId, p_now: now,
    });
    if (error) throw new Error(`Could not list Chapter progress: ${error.message}`);
    return (data ?? []) as ChapterSummaryRow[];
  }
}

export class SupabaseProjectConfirmationStore implements ProjectConfirmationStore {
  async loadDraft(projectId: Hex, owner: `0x${string}`) {
    const source = await loadProjectSource(projectId, owner);
    if (!source || source.headVersion === null) return null;
    const { data, error } = await getSupabaseAdmin().from("project_outline_items")
      .select("position,title,summary,start_block,end_block,page_start,page_end,source_hash,importance,min_card_count,target_card_count,max_card_count")
      .eq("project_id", projectId).eq("outline_version", source.headVersion).order("position");
    if (error) throw new Error(`Could not load Project Outline Draft: ${error.message}`);
    const exclusionsResult = await getSupabaseAdmin().from("project_outline_exclusions")
      .select("start_block,end_block,category,reason")
      .eq("project_id", projectId).eq("outline_version", source.headVersion).order("exclusion_index");
    if (exclusionsResult.error) throw new Error(`Could not load Project Outline exclusions: ${exclusionsResult.error.message}`);
    return {
      project: source.project,
      chapters: (data ?? []) as DraftChapterRow[],
      sourceBlocks: source.sourceBlocks,
      exclusions: SourceExclusionRangeListSchema.parse((exclusionsResult.data ?? []).map((range) => ({
        startBlock: range.start_block, endBlock: range.end_block, category: range.category, reason: range.reason,
      }))),
    };
  }

  saveDraft = saveOutlineDraft;

  async confirmOutlineDesign(input: Parameters<ProjectConfirmationStore["confirmOutlineDesign"]>[0]): Promise<void> {
    const { error } = await getSupabaseAdmin().rpc("confirm_project_outline_design_v3", {
      p_project_id: input.projectId,
      p_owner: input.owner,
      p_outline_version: input.outlineVersion,
      p_outline_hash: input.outlineHash,
      p_chapters: input.chapters,
    });
    if (error) throw new Error(`Could not start Project learning design: ${error.message}`);
  }
}
