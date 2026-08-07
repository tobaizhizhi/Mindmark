"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ChapterListResponse,
  ChapterReadingResponse,
  ChapterStudyResponse,
  LearnerProjectProgress,
  ProjectListResponse,
  ProjectSourceFileResponse,
  ProjectStudyResponse,
  ProjectSummary,
} from "@mindmark/shared";
import {
  shouldPollProjectProgress,
  shouldRefreshWorkspaceResources,
} from "./project-progress-policy";
import { parseApiResponse as parseApi } from "@/lib/client/http";

type ProjectWorkspaceResponse = {
  project: ProjectSummary;
  chapters: ChapterListResponse;
  progress: LearnerProjectProgress;
};

async function getApi<T>(url: string, signal?: AbortSignal): Promise<T> {
  return parseApi<T>(await fetch(url, { signal }));
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function useLearningWorkspaceData(input: {
  loggedIn: boolean;
  projectId: `0x${string}` | null;
  chapterId: number | null;
  sourceFileRequested: boolean;
  readingRequested: boolean;
  onReadingUnavailable: () => void;
}) {
  const {
    loggedIn,
    projectId,
    chapterId,
    sourceFileRequested,
    readingRequested,
    onReadingUnavailable,
  } = input;
  const queryClient = useQueryClient();
  const [localError, setLocalError] = useState<string | null>(null);
  const [sourceFileUploading, setSourceFileUploading] = useState(false);
  const [sourceFileUploadError, setSourceFileUploadError] = useState<string | null>(null);
  const [generationRetrying, setGenerationRetrying] = useState(false);
  const [projectStudyRequested, setProjectStudyRequested] = useState(false);
  const previousProgress = useRef<LearnerProjectProgress | null>(null);

  const projectsQuery = useQuery({
    queryKey: ["learning-projects"],
    queryFn: ({ signal }) => getApi<ProjectListResponse>("/api/projects", signal),
    enabled: !projectId,
    retry: false,
    staleTime: 10_000,
  });

  const workspaceQuery = useQuery({
    queryKey: ["learning-project-workspace", projectId],
    queryFn: ({ signal }) => getApi<ProjectWorkspaceResponse>(
      `/api/projects/${projectId}/workspace`,
      signal,
    ),
    enabled: Boolean(projectId),
    retry: false,
    refetchInterval: (query) => shouldPollProjectProgress(
      (query.state.data as ProjectWorkspaceResponse | undefined)?.progress ?? null,
    ) ? 5_000 : false,
    refetchIntervalInBackground: false,
    staleTime: 2_000,
  });

  const projectStatus = workspaceQuery.data?.project.status ?? null;
  const projectKind = workspaceQuery.data?.project.projectKind ?? null;
  const projectStudyQuery = useQuery({
    queryKey: ["learning-project-study", projectId],
    queryFn: ({ signal }) => getApi<ProjectStudyResponse>(`/api/projects/${projectId}/study`, signal),
    enabled: Boolean(projectId)
      && chapterId === null
      && projectStatus === "READY"
      && projectStudyRequested,
    retry: false,
    staleTime: 10_000,
  });

  const chapterQuery = useQuery({
    queryKey: ["learning-chapter", projectId, chapterId],
    queryFn: ({ signal }) => getApi<ChapterStudyResponse>(
      `/api/projects/${projectId}/chapters/${chapterId}`,
      signal,
    ),
    enabled: Boolean(projectId) && chapterId !== null,
    retry: false,
    staleTime: 10_000,
  });

  const sourceFileQuery = useQuery({
    queryKey: ["learning-project-source-file", projectId],
    queryFn: ({ signal }) => getApi<ProjectSourceFileResponse>(
      `/api/projects/${projectId}/source-file`,
      signal,
    ),
    enabled: Boolean(projectId)
      && chapterId !== null
      && projectKind === "UPLOAD"
      && sourceFileRequested,
    retry: false,
    staleTime: 60_000,
  });

  const readingEnabled = Boolean(projectId)
    && chapterId !== null
    && chapterQuery.data?.status === "READY"
    && Boolean(projectKind)
    && (readingRequested || (projectKind === "UPLOAD" && sourceFileQuery.data?.available === false));
  const readingQuery = useQuery({
    queryKey: ["learning-chapter-reading", projectId, chapterId],
    queryFn: async ({ signal }) => {
      const response = await fetch(
        `/api/projects/${projectId}/chapters/${chapterId}/reading`,
        { signal },
      );
      if (response.status === 404 && projectKind === "PACK") return null;
      return parseApi<ChapterReadingResponse>(response);
    },
    enabled: readingEnabled,
    retry: false,
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    const next = workspaceQuery.data?.progress;
    if (!next) return;
    const previous = previousProgress.current;
    previousProgress.current = next;
    if (!previous || !projectId || !shouldRefreshWorkspaceResources(previous, next)) return;
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["learning-projects"], exact: true }),
      queryClient.invalidateQueries({ queryKey: ["learning-project-study", projectId], exact: true }),
      queryClient.invalidateQueries({ queryKey: ["learning-chapter", projectId] }),
    ]);
  }, [workspaceQuery.data?.progress, projectId, queryClient]);

  useEffect(() => {
    if (readingRequested && readingQuery.isSuccess && readingQuery.data === null) {
      onReadingUnavailable();
    }
  }, [onReadingUnavailable, readingQuery.data, readingQuery.isSuccess, readingRequested]);

  function refreshLifecycle() {
    setLocalError(null);
    if (!projectId) return;
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["learning-projects"], exact: true }),
      queryClient.invalidateQueries({ queryKey: ["learning-project-workspace", projectId], exact: true }),
      queryClient.invalidateQueries({ queryKey: ["learning-project-study", projectId], exact: true }),
      queryClient.invalidateQueries({ queryKey: ["learning-chapter", projectId] }),
    ]);
  }

  function refreshAll() {
    setLocalError(null);
    setSourceFileUploadError(null);
    if (!projectId) {
      void queryClient.invalidateQueries({ queryKey: ["learning-projects"], exact: true });
      return;
    }
    refreshLifecycle();
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["learning-project-source-file", projectId], exact: true }),
      queryClient.invalidateQueries({ queryKey: ["learning-chapter-reading", projectId] }),
    ]);
  }

  function retryReading() {
    setLocalError(null);
    void readingQuery.refetch();
  }

  async function loadProjectStudy(): Promise<ProjectStudyResponse | null> {
    setProjectStudyRequested(true);
    const result = await projectStudyQuery.refetch();
    if (result.error) {
      setLocalError(errorMessage(result.error, "今日复习加载失败"));
      return null;
    }
    return result.data ?? null;
  }

  async function uploadSourceFile(file: File): Promise<ProjectSourceFileResponse | null> {
    if (!projectId || projectKind !== "UPLOAD") return null;
    setSourceFileUploading(true);
    setSourceFileUploadError(null);
    try {
      const formData = new FormData();
      formData.set("file", file, file.name);
      const uploaded = await parseApi<ProjectSourceFileResponse>(await fetch(
        `/api/projects/${projectId}/source-file`,
        { method: "POST", body: formData },
      ));
      const readySourceFile = uploaded.available && !uploaded.url
        ? await getApi<ProjectSourceFileResponse>(`/api/projects/${projectId}/source-file`)
        : uploaded;
      queryClient.setQueryData(
        ["learning-project-source-file", projectId],
        readySourceFile,
      );
      return readySourceFile;
    } catch (error: unknown) {
      setSourceFileUploadError(errorMessage(error, "原版 PDF 上传失败"));
      return null;
    } finally {
      setSourceFileUploading(false);
    }
  }

  async function retryGeneration(): Promise<void> {
    if (!projectId || generationRetrying) return;
    setGenerationRetrying(true);
    setLocalError(null);
    try {
      await parseApi<{ queuedJobs: number }>(await fetch(
        `/api/projects/${projectId}/retry-generation`,
        { method: "POST" },
      ));
      refreshLifecycle();
    } catch (error: unknown) {
      setLocalError(errorMessage(error, "知识卡生成恢复失败"));
    } finally {
      setGenerationRetrying(false);
    }
  }

  const queryFailure = [
    [projectsQuery.error, "项目加载失败"],
    [workspaceQuery.error, "项目加载失败"],
    [projectStudyQuery.error, "今日复习加载失败"],
    [chapterQuery.error, "知识卡加载失败"],
  ].find(([error]) => Boolean(error));
  const dataError = localError ?? (loggedIn && queryFailure
    ? errorMessage(queryFailure[0], String(queryFailure[1]))
    : null);

  return {
    projects: projectsQuery.data?.projects ?? [],
    projectSummary: workspaceQuery.data?.project ?? null,
    projectProgress: workspaceQuery.data?.progress ?? null,
    chapters: workspaceQuery.data?.chapters.chapters ?? [],
    detail: chapterQuery.data ?? null,
    reading: readingQuery.data ?? null,
    sourceFile: sourceFileQuery.data ?? null,
    sourceFileLoading: sourceFileRequested && sourceFileQuery.isPending,
    projectStudy: projectStudyQuery.data ?? null,
    projectsLoading: projectsQuery.isPending,
    projectLoading: workspaceQuery.isPending,
    chaptersLoading: workspaceQuery.isPending,
    detailLoading: chapterQuery.isPending,
    projectStudyLoading: projectStudyQuery.isFetching,
    readingLoading: readingEnabled && readingQuery.isPending,
    readingError: readingQuery.error ? errorMessage(readingQuery.error, "章节正文加载失败") : null,
    sourceFileUploading,
    generationRetrying,
    sourceFileError: sourceFileUploadError ?? (sourceFileQuery.error
      ? errorMessage(sourceFileQuery.error, "原版 PDF 状态读取失败")
      : null),
    dataError,
    setDataError: setLocalError,
    refreshLifecycle,
    refreshAll,
    loadProjectStudy,
    retryReading,
    retryGeneration,
    uploadSourceFile,
  };
}
