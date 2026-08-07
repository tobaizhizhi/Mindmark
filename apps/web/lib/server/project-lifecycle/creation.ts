import {
  ProjectConfirmationResponseSchema,
  ProjectCreationViewSchema,
  ProjectIntakeResponseSchema,
  type ProjectCreationView,
} from "@mindmark/shared/learning-project";
import { SourceExclusionRangeListSchema } from "@mindmark/shared/chapter";
import type { Hex } from "viem";
import { ApiError } from "../http";
import { getSupabaseAdmin } from "../supabase";

export async function getProjectCreationViewForOwner(
  projectId: Hex,
  owner: `0x${string}`,
): Promise<ProjectCreationView> {
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
  const [itemsResult, chaptersResult, unitsResult, exclusionsResult] = await Promise.all([
    client.from("project_outline_items").select(
      "position,title,summary,start_block,end_block,page_start,page_end,source_hash,importance",
    ).eq("project_id", projectId).eq("outline_version", project.outline_version).order("position"),
    client.from("chapters").select("chapter_id", { count: "exact", head: true }).eq("project_id", projectId),
    client.from("work_units").select("work_unit_id", { count: "exact", head: true }).eq("project_id", projectId),
    client.from("project_outline_exclusions").select("start_block,end_block,category,reason")
      .eq("project_id", projectId).eq("outline_version", project.outline_version).order("exclusion_index"),
  ]);
  const error = itemsResult.error ?? chaptersResult.error ?? unitsResult.error ?? exclusionsResult.error;
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
  });
}
