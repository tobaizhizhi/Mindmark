import {
  ChapterListResponseSchema,
  ProjectSummarySchema,
  type ChapterListResponse,
  type LearnerProjectProgress,
  type ProjectSummary,
  type ProjectStatus,
} from "@mindmark/shared";
import type { Hex } from "viem";
import { ApiError } from "../http";
import { primeProjectFileCache, type ProjectFileRow } from "../project-files";
import { getSupabaseAdmin } from "../supabase";
import { projectProgressFromState } from "./progress";

type WorkspaceLearningStateRow = {
  reps: number;
  lapses: number;
  due_at: string | null;
  last_reviewed_at: string | null;
};

type WorkspaceCardRow = {
  card_id: Hex;
  card_learning_states: WorkspaceLearningStateRow[];
};

type WorkspaceChapterRow = {
  chapter_id: number;
  position: number;
  title: string;
  summary: string;
  page_start: number | null;
  page_end: number | null;
  importance: number;
  status: string;
  knowledge_cards: WorkspaceCardRow[];
  card_blueprint_slots: WorkspaceBlueprintSlotRow[];
};

type WorkspaceJobRow = {
  job_id: string;
  kind: string;
  chapter_id: number | null;
  status: string;
  attempt: number;
  last_error: string | null;
};

type WorkspaceDesignRunRow = {
  chapter_id: number;
  status: string;
};

type WorkspaceWorkUnitRow = {
  work_unit_id: number;
  chapter_id: number;
  status: string;
  attempt: number;
};

type WorkspaceBlueprintSlotRow = {
  chapter_id: number;
  assigned_work_unit_id: number | null;
  status: string;
};

type WorkspaceQualityEvaluationRow = {
  chapter_id: number;
  verdict: string;
};

export type ProjectWorkspaceRow = {
  project_id: Hex;
  title: string;
  goal: string | null;
  status: string;
  project_kind: "UPLOAD" | "PACK";
  pack_version_id?: string | null;
  registry_version: number;
  updated_at: string;
  source_filename: string | null;
  source_storage_bucket: string | null;
  source_storage_path: string | null;
  source_file_sha256: string | null;
  source_file_size: number | null;
  source_file_status: "MISSING" | "UPLOADING" | "READY" | "FAILED";
  chapters: WorkspaceChapterRow[];
  workflow_jobs: WorkspaceJobRow[];
  chapter_design_runs: WorkspaceDesignRunRow[];
  work_units: WorkspaceWorkUnitRow[];
  card_quality_evaluations: WorkspaceQualityEvaluationRow[];
};

export type ProjectWorkspaceResponse = {
  project: ProjectSummary;
  chapters: ChapterListResponse;
  progress: LearnerProjectProgress;
};

export interface ProjectWorkspaceStore {
  load(projectId: Hex, owner: `0x${string}`): Promise<ProjectWorkspaceRow | null>;
}

class SupabaseProjectWorkspaceStore implements ProjectWorkspaceStore {
  async load(projectId: Hex, owner: `0x${string}`): Promise<ProjectWorkspaceRow | null> {
    const { data, error } = await getSupabaseAdmin().from("learning_projects").select(
      "project_id,title,goal,status,project_kind,pack_version_id,registry_version,updated_at,source_filename,source_storage_bucket,source_storage_path,source_file_sha256,source_file_size,source_file_status,chapters(chapter_id,position,title,summary,page_start,page_end,importance,status,knowledge_cards(card_id,card_learning_states(reps,lapses,due_at,last_reviewed_at)),card_blueprint_slots(chapter_id,assigned_work_unit_id,status)),workflow_jobs(job_id,kind,chapter_id,status,attempt,last_error,created_at),chapter_design_runs(chapter_id,status),work_units(work_unit_id,chapter_id,status,attempt),card_quality_evaluations(chapter_id,verdict)",
    )
      .eq("project_id", projectId)
      .eq("owner_address", owner)
      .eq("card_quality_evaluations.verdict", "REPAIR_REQUESTED")
      .eq("chapters.knowledge_cards.card_learning_states.owner_address", owner)
      .neq("workflow_jobs.kind", "SETTLE_WORK_UNIT_REWARD")
      .in("workflow_jobs.status", ["QUEUED", "RUNNING", "RETRYABLE", "FAILED"])
      .order("position", { referencedTable: "chapters" })
      .order("created_at", { referencedTable: "workflow_jobs", ascending: false })
      .limit(1, { referencedTable: "workflow_jobs" })
      .maybeSingle();
    if (error) throw new Error(`Could not load Learning Project workspace: ${error.message}`);
    const row = data as ProjectWorkspaceRow | null;
    if (row) primeProjectFileCache(owner, row as ProjectFileRow);
    return row;
  }
}

function learningState(card: WorkspaceCardRow): WorkspaceLearningStateRow | null {
  return card.card_learning_states[0] ?? null;
}

function dueAtOrBefore(state: WorkspaceLearningStateRow | null, now: number): boolean {
  return Boolean(
    state
    && state.reps > 0
    && state.due_at
    && Date.parse(state.due_at) <= now,
  );
}

function projectWorkspaceFromRow(
  row: ProjectWorkspaceRow,
  now = new Date(),
): ProjectWorkspaceResponse {
  const nowMs = now.getTime();
  const chapterSummaries = row.chapters.map((chapter) => {
    const states = chapter.knowledge_cards.map(learningState);
    const cardCount = chapter.knowledge_cards.length;
    const studiedCount = states.filter((state) => state && state.reps > 0).length;
    const dueCount = states.filter((state) => dueAtOrBefore(state, nowMs)).length;
    const masteredCount = states.filter((state) => state && state.reps >= 3 && state.lapses === 0).length;
    const lastReviewedAt = states.reduce<string | null>((latest, state) => {
      if (!state?.last_reviewed_at) return latest;
      return !latest || Date.parse(state.last_reviewed_at) > Date.parse(latest)
        ? state.last_reviewed_at
        : latest;
    }, null);
    return {
      projectId: row.project_id,
      chapterId: Number(chapter.chapter_id),
      position: Number(chapter.position),
      title: chapter.title,
      summary: chapter.summary,
      pageStart: chapter.page_start,
      pageEnd: chapter.page_end,
      importance: Number(chapter.importance),
      status: chapter.status,
      cardCount,
      studiedCount,
      dueCount,
      newCount: cardCount - studiedCount,
      masteredCount,
      lastReviewedAt,
      progressPercent: cardCount === 0 ? 0 : Math.round(studiedCount * 1_000 / cardCount) / 10,
    };
  });
  const chapters = ChapterListResponseSchema.parse({
    projectId: row.project_id,
    chapters: chapterSummaries,
  });
  const cardCount = chapterSummaries.reduce((total, chapter) => total + chapter.cardCount, 0);
  const dueCount = chapterSummaries.reduce((total, chapter) => total + chapter.dueCount, 0);
  const project = ProjectSummarySchema.parse({
    projectId: row.project_id,
    title: row.title,
    goal: row.goal,
    status: row.status,
    ...(row.project_kind ? { projectKind: row.project_kind } : {}),
    ...(row.pack_version_id !== undefined ? { packVersionId: row.pack_version_id } : {}),
    registryVersion: Number(row.registry_version),
    chapterCount: chapterSummaries.length,
    readyChapterCount: chapterSummaries.filter((chapter) => chapter.status === "READY").length,
    cardCount,
    dueCount,
    updatedAt: row.updated_at,
  });
  const latestJob = row.workflow_jobs[0] ?? null;
  const progress = projectProgressFromState({
    project: {
      projectId: row.project_id,
      status: project.status as ProjectStatus,
      updatedAt: row.updated_at,
    },
    chapters: chapters.chapters.map((chapter) => ({
      chapterId: chapter.chapterId,
      title: chapter.title,
      status: chapter.status,
    })),
    latestJob: latestJob ? {
      jobId: latestJob.job_id,
      kind: latestJob.kind,
      chapterId: latestJob.chapter_id,
      status: latestJob.status,
      attempt: Number(latestJob.attempt),
      lastError: latestJob.last_error,
    } : null,
    designRuns: row.chapter_design_runs.map((run) => ({
      chapterId: Number(run.chapter_id),
      status: run.status,
    })),
    workUnits: row.work_units.map((unit) => ({
      workUnitId: Number(unit.work_unit_id),
      chapterId: Number(unit.chapter_id),
      status: unit.status,
      attempt: Number(unit.attempt),
    })),
    blueprintSlots: row.chapters.flatMap((chapter) => chapter.card_blueprint_slots).map((slot) => ({
      chapterId: Number(slot.chapter_id),
      assignedWorkUnitId: slot.assigned_work_unit_id === null
        ? null
        : Number(slot.assigned_work_unit_id),
      status: slot.status,
    })),
    qualityEvaluations: row.card_quality_evaluations.map((evaluation) => ({
      chapterId: Number(evaluation.chapter_id),
      verdict: evaluation.verdict,
    })),
  });
  return { project, chapters, progress };
}

export async function getProjectWorkspaceForOwner(
  projectId: Hex,
  owner: `0x${string}`,
  store: ProjectWorkspaceStore = new SupabaseProjectWorkspaceStore(),
  now = new Date(),
): Promise<ProjectWorkspaceResponse> {
  const row = await store.load(projectId, owner);
  if (!row) throw new ApiError(404, "project_not_found", "Learning Project was not found");
  return projectWorkspaceFromRow(row, now);
}
