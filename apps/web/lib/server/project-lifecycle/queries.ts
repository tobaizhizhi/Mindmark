import {
  ProjectListResponseSchema,
  ProjectSummarySchema,
  type ProjectListResponse,
  type ProjectSummary,
} from "@mindmark/shared/learning-project";
import { ChapterListResponseSchema, type ChapterListResponse } from "@mindmark/shared/chapter";
import type { Hex } from "viem";
import { ApiError } from "../http";
import { SupabaseChapterSummaryStore, SupabaseProjectSummaryStore } from "./supabase-adapter";
import type { ChapterSummaryStore, ProjectSummaryRow, ProjectSummaryStore } from "./types";

function projectSummaryFromRow(row: ProjectSummaryRow): ProjectSummary {
  return ProjectSummarySchema.parse({
    projectId: row.project_id,
    title: row.title,
    goal: row.goal,
    status: row.status,
    ...(row.project_kind ? { projectKind: row.project_kind } : {}),
    ...(row.pack_version_id !== undefined ? { packVersionId: row.pack_version_id } : {}),
    registryVersion: row.registry_version,
    chapterCount: Number(row.chapter_count),
    readyChapterCount: Number(row.ready_chapter_count),
    cardCount: Number(row.card_count),
    dueCount: Number(row.due_count),
    updatedAt: row.updated_at,
  });
}

export async function listProjectsForOwner(
  owner: `0x${string}`,
  store: ProjectSummaryStore = new SupabaseProjectSummaryStore(),
  now = new Date(),
): Promise<ProjectListResponse> {
  const rows = await store.listOwned(owner, now.toISOString());
  return ProjectListResponseSchema.parse({ projects: rows.slice(0, 24).map(projectSummaryFromRow) });
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
  if (rows.length === 0) throw new ApiError(404, "project_not_found", "Learning Project was not found");
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
