import {
  LearnerProjectProgressSchema,
  type LearnerProjectProgress,
  type LearnerProjectStage,
  type ProjectStatus,
} from "@mindmark/shared/learning-project";
import type { Hex } from "viem";
import { ApiError } from "../http";
import { getSupabaseAdmin } from "../supabase";

type ProgressProject = {
  projectId: Hex;
  status: ProjectStatus;
  updatedAt: string;
};

type ProgressChapter = {
  chapterId: number;
  title: string;
  status: string;
};

type ProgressJob = {
  jobId: string;
  kind: string;
  chapterId: number | null;
  status: string;
  attempt: number;
  lastError: string | null;
};

type ProgressDesignRun = {
  chapterId: number;
  status: string;
};

export interface ProjectProgressStore {
  load(projectId: Hex, owner: `0x${string}`): Promise<{
    project: ProgressProject;
    chapters: ProgressChapter[];
    latestJob: ProgressJob | null;
    designRuns: ProgressDesignRun[];
  } | null>;
}

class SupabaseProjectProgressStore implements ProjectProgressStore {
  async load(projectId: Hex, owner: `0x${string}`) {
    const client = getSupabaseAdmin();
    const { data, error } = await client.from("learning_projects").select(
      "project_id,status,updated_at,chapters(chapter_id,title,status,position),workflow_jobs(job_id,kind,chapter_id,status,attempt,last_error,created_at),chapter_design_runs(chapter_id,status)",
    )
      .eq("project_id", projectId)
      .eq("owner_address", owner)
      .neq("workflow_jobs.kind", "SETTLE_WORK_UNIT_REWARD")
      .in("workflow_jobs.status", ["QUEUED", "RUNNING", "RETRYABLE", "FAILED"])
      .order("position", { referencedTable: "chapters" })
      .order("created_at", { referencedTable: "workflow_jobs", ascending: false })
      .limit(1, { referencedTable: "workflow_jobs" })
      .maybeSingle();
    if (error) throw new Error(`Could not load Learning Project progress: ${error.message}`);
    if (!data) return null;
    const chapters = data.chapters as Array<{ chapter_id: number; title: string; status: string }>;
    const jobs = data.workflow_jobs as Array<{
      job_id: string;
      kind: string;
      chapter_id: number | null;
      status: string;
      attempt: number;
      last_error: string | null;
    }>;
    const designs = data.chapter_design_runs as Array<{ chapter_id: number; status: string }>;
    const latestJob = jobs[0] ?? null;
    return {
      project: {
        projectId: data.project_id as Hex,
        status: data.status as ProjectStatus,
        updatedAt: data.updated_at,
      },
      chapters: chapters.map((chapter) => ({
        chapterId: Number(chapter.chapter_id),
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
      designRuns: designs.map((run) => ({
        chapterId: Number(run.chapter_id),
        status: run.status,
      })),
    };
  }
}

function stageFor(input: {
  status: ProjectStatus;
  latestJob: ProgressJob | null;
  chapters: ProgressChapter[];
}): LearnerProjectStage {
  if (input.status === "READY") return "READY";
  if (input.status === "CANCELLED") return "FAILED";
  if (input.latestJob?.status === "FAILED") return "ACTION_REQUIRED";
  if (input.status === "FAILED_RETRYABLE") {
    return input.latestJob && ["QUEUED", "RUNNING", "RETRYABLE"].includes(input.latestJob.status)
      ? input.latestJob.kind === "PLAN_OUTLINE"
        ? "ANALYZING_SOURCE"
        : ["DESIGN_CHAPTER", "FREEZE_PROJECT_DESIGN"].includes(input.latestJob.kind)
        ? "DESIGNING_CARDS"
        : input.latestJob.kind === "QUALITY_CHECK_CHAPTER" ? "CHECKING_QUALITY" : "GENERATING_CARDS"
      : "ACTION_REQUIRED";
  }
  if (["UPLOADED", "OUTLINING"].includes(input.status)) return "ANALYZING_SOURCE";
  if (input.status === "OUTLINE_READY") return "OUTLINE_READY";
  if (input.status === "DESIGNING_CARDS") return "DESIGNING_CARDS";
  if (input.status === "AWAITING_REGISTRY") return "AWAITING_MONAD";
  if (input.latestJob?.kind === "QUALITY_CHECK_CHAPTER") return "CHECKING_QUALITY";
  if (input.chapters.some((chapter) => chapter.status === "QUALITY_CHECK")) return "CHECKING_QUALITY";
  return "GENERATING_CARDS";
}

function percentFor(
  status: ProjectStatus,
  chapters: ProgressChapter[],
  designRuns: ProgressDesignRun[],
): number {
  if (status === "READY") return 100;
  if (status === "CANCELLED") return 0;
  if (status === "UPLOADED") return 5;
  if (status === "OUTLINING") return 12;
  if (status === "OUTLINE_READY") return 20;
  const total = chapters.length;
  const designComplete = new Set(
    designRuns.filter((run) => run.status === "COMPLETED").map((run) => run.chapterId),
  ).size;
  if (status === "DESIGNING_CARDS") return Math.min(40, 20 + Math.round(20 * designComplete / Math.max(1, total)));
  if (status === "AWAITING_REGISTRY") return 40;
  if (total === 0) return 40;
  const chapterWeight: Record<string, number> = {
    DRAFT: 0,
    CONFIRMED: 0,
    GENERATING: 0.25,
    QUALITY_CHECK: 0.65,
    ASSEMBLING: 0.85,
    READY: 1,
    FAILED_RETRYABLE: 0.25,
  };
  const completion = chapters.reduce((sum, chapter) => sum + (chapterWeight[chapter.status] ?? 0), 0) / total;
  return Math.min(99, 40 + Math.round(60 * completion));
}

export function projectProgressFromState(input: {
  project: ProgressProject;
  chapters: ProgressChapter[];
  latestJob: ProgressJob | null;
  designRuns?: ProgressDesignRun[];
}): LearnerProjectProgress {
  const latestJob = input.latestJob?.kind === "SETTLE_WORK_UNIT_REWARD" ? null : input.latestJob;
  const completedChapters = input.chapters.filter((chapter) => chapter.status === "READY").length;
  const activeChapter = latestJob?.chapterId === null || latestJob?.chapterId === undefined
    ? null
    : input.chapters.find((chapter) => chapter.chapterId === latestJob?.chapterId) ?? null;
  const currentChapter = activeChapter
    ?? input.chapters.find((chapter) => chapter.status !== "READY")
    ?? null;
  const retrying = Boolean(latestJob && (
    latestJob.status === "RETRYABLE"
    || (latestJob.status === "RUNNING" && latestJob.attempt > 1)
  ));
  const stage = stageFor({ status: input.project.status, latestJob, chapters: input.chapters });
  return LearnerProjectProgressSchema.parse({
    projectId: input.project.projectId,
    stage,
    progressPercent: percentFor(input.project.status, input.chapters, input.designRuns ?? []),
    currentChapter: currentChapter ? { chapterId: currentChapter.chapterId, title: currentChapter.title } : null,
    completedChapters,
    totalChapters: input.chapters.length,
    retrying,
    updatedAt: input.project.updatedAt,
    operationId: latestJob?.jobId ?? null,
    code: stage === "ACTION_REQUIRED"
      ? "workflow_action_required"
      : stage === "FAILED" ? "project_cancelled" : null,
  });
}

export async function getProjectProgressForOwner(
  projectId: Hex,
  owner: `0x${string}`,
  store: ProjectProgressStore = new SupabaseProjectProgressStore(),
): Promise<LearnerProjectProgress> {
  const state = await store.load(projectId, owner);
  if (!state) throw new ApiError(404, "project_not_found", "Learning Project was not found");
  return projectProgressFromState(state);
}
