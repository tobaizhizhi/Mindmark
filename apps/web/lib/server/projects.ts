import { randomBytes } from "node:crypto";
import {
  Bytes32Schema,
  ChapterListResponseSchema,
  ChapterProposalListSchema,
  OutlinePlanningOperationSchema,
  ProjectSourceRegistrationResponseSchema,
  ProjectIntakeResponseSchema,
  ProjectConfirmationResponseSchema,
  ProjectDesignAcceptedResponseSchema,
  ProjectCreationViewSchema,
  ProjectListResponseSchema,
  ProjectSummarySchema,
  SourceExclusionRangeListSchema,
  filterExcludedSourceBlocks,
  hashGoal,
  intakeSource,
  materializeChapterOutline,
  planChapterCardPolicy,
  SourceBlockSchema,
  type ChapterListResponse,
  type ChapterProposal,
  type OutlinePlanningOperation,
  type ProjectIntakeRequest,
  type ProjectSourceRegistrationResponse,
  type ProjectListResponse,
  type ProjectSummary,
  type SourceExclusionRange,
} from "@mindmark/shared";
import type { Hex } from "viem";
import { ApiError } from "./http";
import { getSupabaseAdmin } from "./supabase";

type ProjectSummaryRow = {
  project_id: Hex;
  title: string;
  goal: string | null;
  status: string;
  registry_version: number;
  chapter_count: number | string;
  ready_chapter_count: number | string;
  card_count: number | string;
  due_count: number | string;
  updated_at: string;
};

type ChapterSummaryRow = {
  project_id: Hex;
  chapter_id: number;
  position: number;
  title: string;
  summary: string;
  page_start: number;
  page_end: number;
  importance: number;
  status: string;
  card_count: number | string;
  studied_count: number | string;
  due_count: number | string;
  new_count: number | string;
  mastered_count: number | string;
  last_reviewed_at: string | null;
  progress_percent: number | string;
};

export interface ProjectSourceStore {
  registerSource(
    project: Record<string, unknown>,
    sourceBlocks: Record<string, unknown>[],
  ): Promise<Hex>;
}

export interface ProjectOutlineOperationStore {
  enqueue(projectId: Hex, owner: `0x${string}`): Promise<string>;
  get(
    projectId: Hex,
    owner: `0x${string}`,
    operationId?: string,
  ): Promise<OutlinePlanningOperation | null>;
}

type ProjectSourceRow = {
  project_id: Hex;
  owner_address: `0x${string}`;
  title: string;
  goal: string | null;
  source_hash: Hex;
  goal_hash: Hex;
  outline_version: number;
  outline_hash: Hex | null;
  status: string;
};

type OutlineDraftInput = {
  projectId: Hex;
  owner: `0x${string}`;
  expectedHeadVersion: number | null;
  outlineHash: Hex;
  plannerVersion: string;
  chapters: Record<string, unknown>[];
  exclusions: Record<string, unknown>[];
};

export interface ProjectSummaryStore {
  listOwned(owner: `0x${string}`, now: string): Promise<ProjectSummaryRow[]>;
}

export interface ChapterSummaryStore {
  listOwned(
    owner: `0x${string}`,
    projectId: Hex,
    now: string,
  ): Promise<ChapterSummaryRow[]>;
}

type ProjectDraftRow = ProjectSourceRow;

type DraftChapterRow = {
  chapter_id: number;
  position: number;
  title: string;
  summary: string;
  start_block: number;
  end_block: number;
  page_start: number;
  page_end: number;
  source_hash: Hex;
  importance: number;
  min_card_count: number;
  target_card_count: number;
  max_card_count: number;
};

type ProjectSourceBlockRow = {
  block_index: number;
  page_number: number;
  kind: string;
  text: string;
  block_hash: Hex;
  heading_level: number | null;
};

export interface ProjectConfirmationStore {
  loadDraft(
    projectId: Hex,
    owner: `0x${string}`,
  ): Promise<{
    project: ProjectDraftRow;
    chapters: DraftChapterRow[];
    sourceBlocks: ProjectSourceBlockRow[];
    exclusions: SourceExclusionRange[];
  } | null>;
  saveDraft(input: OutlineDraftInput): Promise<number>;
  confirmOutlineDesign(input: {
    projectId: Hex;
    owner: `0x${string}`;
    outlineVersion: number;
    outlineHash: Hex;
    chapters: Record<string, unknown>[];
  }): Promise<void>;
}

export class SupabaseProjectSourceStore implements ProjectSourceStore {
  async registerSource(
    project: Record<string, unknown>,
    sourceBlocks: Record<string, unknown>[],
  ): Promise<Hex> {
    const { data, error } = await getSupabaseAdmin().rpc("register_learning_project_source_v2", {
      p_project: project,
      p_source_blocks: sourceBlocks,
    });
    if (error) throw new Error(`Could not register Learning Project source: ${error.message}`);
    return Bytes32Schema.parse(data);
  }
}

async function loadProjectSource(
  projectId: Hex,
  owner: `0x${string}`,
): Promise<{
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
    client.from("source_blocks")
      .select("block_index,page_number,kind,text,block_hash,heading_level")
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

  async get(
    projectId: Hex,
    owner: `0x${string}`,
    operationId?: string,
  ): Promise<OutlinePlanningOperation | null> {
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
    const { data, error } = await getSupabaseAdmin().rpc("get_project_summaries_v2", {
      p_owner: owner,
      p_now: now,
    });
    if (error) throw new Error(`Could not list Learning Projects: ${error.message}`);
    return (data ?? []) as ProjectSummaryRow[];
  }
}

export class SupabaseChapterSummaryStore implements ChapterSummaryStore {
  async listOwned(
    owner: `0x${string}`,
    projectId: Hex,
    now: string,
  ): Promise<ChapterSummaryRow[]> {
    const { data, error } = await getSupabaseAdmin().rpc("get_chapter_summaries_v2", {
      p_owner: owner,
      p_project_id: projectId,
      p_now: now,
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
      .select(
        "position,title,summary,start_block,end_block,page_start,page_end,source_hash,importance,min_card_count,target_card_count,max_card_count",
      )
      .eq("project_id", projectId).eq("outline_version", source.headVersion).order("position");
    if (error) throw new Error(`Could not load Project Outline Draft: ${error.message}`);
    const exclusionsResult = await getSupabaseAdmin().from("project_outline_exclusions")
      .select("start_block,end_block,category,reason")
      .eq("project_id", projectId).eq("outline_version", source.headVersion)
      .order("exclusion_index");
    if (exclusionsResult.error) throw new Error(`Could not load Project Outline exclusions: ${exclusionsResult.error.message}`);
    return {
      project: source.project as ProjectDraftRow,
      chapters: (data ?? []) as DraftChapterRow[],
      sourceBlocks: source.sourceBlocks,
      exclusions: SourceExclusionRangeListSchema.parse((exclusionsResult.data ?? []).map((range) => ({
        startBlock: range.start_block,
        endBlock: range.end_block,
        category: range.category,
        reason: range.reason,
      }))),
    };
  }

  saveDraft = saveOutlineDraft;

  async confirmOutlineDesign(input: {
    projectId: Hex;
    owner: `0x${string}`;
    outlineVersion: number;
    outlineHash: Hex;
    chapters: Record<string, unknown>[];
  }): Promise<void> {
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

export function randomProjectId(): Hex {
  return `0x${randomBytes(32).toString("hex")}`;
}

function projectSummaryFromRow(row: ProjectSummaryRow): ProjectSummary {
  return ProjectSummarySchema.parse({
    projectId: row.project_id,
    title: row.title,
    goal: row.goal,
    status: row.status,
    registryVersion: row.registry_version,
    chapterCount: Number(row.chapter_count),
    readyChapterCount: Number(row.ready_chapter_count),
    cardCount: Number(row.card_count),
    dueCount: Number(row.due_count),
    updatedAt: row.updated_at,
  });
}

export async function registerProjectSourceForOwner(
  request: ProjectIntakeRequest,
  owner: `0x${string}`,
  store: ProjectSourceStore = new SupabaseProjectSourceStore(),
  projectId: Hex = randomProjectId(),
): Promise<ProjectSourceRegistrationResponse> {
  const source = intakeSource(request.pages);
  const registeredProjectId = await store.registerSource(
    {
      project_id: projectId,
      owner_address: owner,
      client_request_id: request.clientRequestId,
      title: request.title.trim(),
      goal: request.goal?.trim() || null,
      source_hash: source.sourceHash,
      goal_hash: hashGoal(request.goal ?? ""),
      source_filename: request.sourceFilename ?? null,
      source_mime_type: request.sourceMimeType ?? null,
      folder_id: request.folderId ?? null,
      source_page_count: request.pages.length,
      source_character_count: source.blocks.reduce((sum, block) => sum + block.text.length, 0),
    },
    source.blocks.map((block) => ({
      block_index: block.blockIndex,
      page_number: block.pageNumber,
      kind: block.kind,
      text: block.text,
      block_hash: block.blockHash,
      heading_level: block.headingLevel,
    })),
  );

  return ProjectSourceRegistrationResponseSchema.parse({
    projectId: registeredProjectId,
    status: "UPLOADED",
    sourceHash: source.sourceHash,
    sourcePageCount: request.pages.length,
    sourceCharacterCount: source.blocks.reduce((sum, block) => sum + block.text.length, 0),
  });
}

export const intakeProjectForOwner = registerProjectSourceForOwner;

function sourceBlocksFromRows(rows: ProjectSourceBlockRow[]) {
  return SourceBlockSchema.array().parse(rows.map((block) => ({
    blockIndex: block.block_index,
    pageNumber: block.page_number,
    kind: block.kind,
    text: block.text,
    blockHash: block.block_hash,
    headingLevel: block.heading_level,
  })));
}

function outlineChapterRows(
  chapters: import("@mindmark/shared").ChapterOutlineItem[],
  sourceBlocks: import("@mindmark/shared").SourceBlock[],
  exclusions: SourceExclusionRange[] = [],
) {
  return chapters.map((chapter) => {
    const policy = planChapterCardPolicy(
      chapter,
      filterExcludedSourceBlocks(
        sourceBlocks.slice(chapter.startBlock, chapter.endBlock + 1),
        exclusions,
      ),
    );
    return {
      item_id: `chapter-${chapter.chapterId}`,
      chapter_id: chapter.chapterId,
      position: chapter.position,
      title: chapter.title,
      summary: chapter.summary,
      start_block: chapter.startBlock,
      end_block: chapter.endBlock,
      page_start: chapter.pageStart,
      page_end: chapter.pageEnd,
      source_hash: chapter.sourceHash,
      importance: chapter.importance,
      min_card_count: policy.minCardCount,
      target_card_count: policy.targetCardCount,
      max_card_count: policy.maxCardCount,
      card_policy_version: policy.policyVersion,
    };
  });
}

export async function requestProjectOutlinePlanningForOwner(
  projectId: Hex,
  owner: `0x${string}`,
  store: ProjectOutlineOperationStore = new SupabaseProjectOutlineOperationStore(),
): Promise<OutlinePlanningOperation> {
  const operationId = await store.enqueue(projectId, owner);
  const operation = await store.get(projectId, owner, operationId);
  if (!operation) {
    throw new ApiError(404, "project_source_not_found", "Editable Learning Project source was not found");
  }
  return operation;
}

export async function getProjectOutlinePlanningOperationForOwner(
  projectId: Hex,
  owner: `0x${string}`,
  operationId?: string,
  store: ProjectOutlineOperationStore = new SupabaseProjectOutlineOperationStore(),
): Promise<OutlinePlanningOperation> {
  const operation = await store.get(projectId, owner, operationId);
  if (!operation) {
    throw new ApiError(404, "outline_operation_not_found", "Project Outline planning operation was not found");
  }
  return operation;
}

export async function confirmProjectOutlineForOwner(
  projectId: Hex,
  owner: `0x${string}`,
  rawProposals: ChapterProposal[],
  store: ProjectConfirmationStore = new SupabaseProjectConfirmationStore(),
): Promise<import("@mindmark/shared").ProjectDesignAcceptedResponse> {
  const proposals = ChapterProposalListSchema.parse(rawProposals);
  const draft = await store.loadDraft(projectId, owner);
  if (!draft || draft.project.status !== "OUTLINE_READY") {
    throw new ApiError(404, "outline_not_found", "Editable Project outline was not found");
  }
  const sourceBlocks = sourceBlocksFromRows(draft.sourceBlocks);
  let outline;
  try {
    outline = materializeChapterOutline(
      projectId,
      sourceBlocks,
      proposals,
      draft.project.outline_version,
      draft.exclusions,
    );
    if (outline.outlineHash !== draft.project.outline_hash) {
      outline = materializeChapterOutline(
        projectId,
        sourceBlocks,
        proposals,
        draft.project.outline_version + 1,
        draft.exclusions,
      );
      const savedVersion = await store.saveDraft({
        projectId,
        owner,
        expectedHeadVersion: draft.project.outline_version,
        outlineHash: outline.outlineHash,
        plannerVersion: "learner-edited-v1",
        chapters: outlineChapterRows(outline.chapters, sourceBlocks, draft.exclusions),
        exclusions: draft.exclusions.map((range) => ({
          start_block: range.startBlock,
          end_block: range.endBlock,
          category: range.category,
          reason: range.reason,
        })),
      });
      if (savedVersion !== outline.outlineVersion) {
        throw new Error("Saved Outline Draft version does not match the edited outline");
      }
    }
  } catch (error) {
    throw new ApiError(
      400,
      "invalid_outline",
      error instanceof Error ? error.message : "Chapter outline is invalid",
    );
  }
  const chapterRows = outlineChapterRows(outline.chapters, sourceBlocks, draft.exclusions);
  await store.confirmOutlineDesign({
    projectId,
    owner,
    outlineVersion: outline.outlineVersion,
    outlineHash: outline.outlineHash,
    chapters: chapterRows,
  });

  return ProjectDesignAcceptedResponseSchema.parse({
    projectId,
    status: "DESIGNING_CARDS",
    outlineVersion: outline.outlineVersion,
    outlineHash: outline.outlineHash,
    chapterCount: outline.chapters.length,
  });
}

export async function getProjectCreationViewForOwner(
  projectId: Hex,
  owner: `0x${string}`,
): Promise<import("@mindmark/shared").ProjectCreationView> {
  const client = getSupabaseAdmin();
  const projectResult = await client.from("learning_projects").select(
    "project_id,title,goal,status,source_hash,outline_version,outline_hash,work_unit_manifest_root,source_filename,source_mime_type,source_page_count,source_character_count,creation_intent",
  ).eq("project_id", projectId).eq("owner_address", owner).maybeSingle();
  if (projectResult.error) throw new Error(`Could not load Project creation state: ${projectResult.error.message}`);
  if (!projectResult.data) throw new ApiError(404, "project_not_found", "Learning Project was not found");
  const project = projectResult.data as {
    project_id: Hex;
    title: string;
    goal: string | null;
    status: string;
    source_hash: Hex;
    outline_version: number;
    outline_hash: Hex | null;
    work_unit_manifest_root: Hex | null;
    source_filename: string | null;
    source_mime_type: string | null;
    source_page_count: number | null;
    source_character_count: number | null;
    creation_intent: Record<string, unknown> | null;
  };
  const [itemsResult, chaptersResult, unitsResult, designsResult, exclusionsResult] = await Promise.all([
    client.from("project_outline_items").select(
      "position,title,summary,start_block,end_block,page_start,page_end,source_hash,importance",
    ).eq("project_id", projectId).eq("outline_version", project.outline_version).order("position"),
    client.from("chapters").select("chapter_id", { count: "exact", head: true }).eq("project_id", projectId),
    client.from("work_units").select("work_unit_id", { count: "exact", head: true }).eq("project_id", projectId),
    client.from("chapter_design_runs").select("chapter_id,status")
      .eq("project_id", projectId).eq("outline_version", project.outline_version),
    client.from("project_outline_exclusions").select("start_block,end_block,category,reason")
      .eq("project_id", projectId).eq("outline_version", project.outline_version).order("exclusion_index"),
  ]);
  const error = itemsResult.error ?? chaptersResult.error ?? unitsResult.error ?? designsResult.error ?? exclusionsResult.error;
  if (error) throw new Error(`Could not load Project creation details: ${error.message}`);
  const outline = project.outline_hash && (itemsResult.data?.length ?? 0) > 0
    ? ProjectIntakeResponseSchema.parse({
        projectId,
        status: "OUTLINE_READY",
        sourceHash: project.source_hash,
        outlineVersion: project.outline_version,
        outlineHash: project.outline_hash,
        chapters: (itemsResult.data ?? []).map((item, chapterId) => ({
          chapterId,
          position: Number(item.position),
          title: item.title,
          summary: item.summary,
          startBlock: Number(item.start_block),
          endBlock: Number(item.end_block),
          pageStart: Number(item.page_start),
          pageEnd: Number(item.page_end),
          sourceHash: item.source_hash,
          importance: Number(item.importance),
        })),
        excludedRanges: SourceExclusionRangeListSchema.parse((exclusionsResult.data ?? []).map((range) => ({
          startBlock: range.start_block,
          endBlock: range.end_block,
          category: range.category,
          reason: range.reason,
        }))),
      })
    : null;
  const confirmation = project.status === "AWAITING_REGISTRY" && project.creation_intent
    ? ProjectConfirmationResponseSchema.parse({
        projectId,
        status: "AWAITING_REGISTRY",
        outlineVersion: project.outline_version,
        outlineHash: project.outline_hash,
        workUnitManifestRoot: project.work_unit_manifest_root,
        chapterCount: chaptersResult.count ?? 0,
        workUnitCount: unitsResult.count ?? 0,
        createProjectArgs: project.creation_intent,
      })
    : null;
  const completedDesignChapters = new Set(
    (designsResult.data ?? []).filter((run) => run.status === "COMPLETED").map((run) => Number(run.chapter_id)),
  );
  const failedDesignChapters = new Set(
    (designsResult.data ?? []).filter((run) => ["FAILED", "REPAIR_EXHAUSTED"].includes(run.status))
      .map((run) => Number(run.chapter_id)),
  );
  return ProjectCreationViewSchema.parse({
    projectId,
    status: project.status,
    title: project.title,
    goal: project.goal,
    sourceFilename: project.source_filename,
    sourceMimeType: project.source_mime_type,
    sourcePageCount: project.source_page_count,
    sourceCharacterCount: project.source_character_count,
    outline,
    confirmation,
    designProgress: project.status === "DESIGNING_CARDS" || project.status === "FAILED_RETRYABLE"
      ? {
          completedChapters: completedDesignChapters.size,
          totalChapters: chaptersResult.count ?? 0,
          failedChapters: failedDesignChapters.size,
        }
      : null,
  });
}

export async function listProjectsForOwner(
  owner: `0x${string}`,
  store: ProjectSummaryStore = new SupabaseProjectSummaryStore(),
  now = new Date(),
): Promise<ProjectListResponse> {
  const rows = await store.listOwned(owner, now.toISOString());
  return ProjectListResponseSchema.parse({
    projects: rows.slice(0, 24).map(projectSummaryFromRow),
  });
}

export async function getProjectSummaryForOwner(
  projectId: Hex,
  owner: `0x${string}`,
  store: ProjectSummaryStore = new SupabaseProjectSummaryStore(),
  now = new Date(),
): Promise<ProjectSummary> {
  const rows = await store.listOwned(owner, now.toISOString());
  const row = rows.find((candidate) => candidate.project_id === projectId);
  if (!row) throw new ApiError(404, "project_not_found", "Learning Project was not found");
  return projectSummaryFromRow(row);
}

export async function listChaptersForOwner(
  projectId: Hex,
  owner: `0x${string}`,
  store: ChapterSummaryStore = new SupabaseChapterSummaryStore(),
  now = new Date(),
): Promise<ChapterListResponse> {
  const rows = await store.listOwned(owner, projectId, now.toISOString());
  if (rows.length === 0) {
    throw new ApiError(404, "project_not_found", "Learning Project was not found");
  }
  return ChapterListResponseSchema.parse({
    projectId,
    chapters: rows.map((row) => ({
      projectId: row.project_id,
      chapterId: row.chapter_id,
      position: row.position,
      title: row.title,
      summary: row.summary,
      pageStart: row.page_start,
      pageEnd: row.page_end,
      importance: row.importance,
      status: row.status,
      cardCount: Number(row.card_count),
      studiedCount: Number(row.studied_count),
      dueCount: Number(row.due_count),
      newCount: Number(row.new_count),
      masteredCount: Number(row.mastered_count),
      lastReviewedAt: row.last_reviewed_at,
      progressPercent: Number(row.progress_percent),
    })),
  });
}
