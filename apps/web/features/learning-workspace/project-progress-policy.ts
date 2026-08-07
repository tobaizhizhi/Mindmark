import type { LearnerProjectProgress } from "@mindmark/shared/learning-project";

const AUTO_REFRESH_STAGES = new Set<LearnerProjectProgress["stage"]>([
  "ANALYZING_SOURCE",
  "DESIGNING_CARDS",
  "GENERATING_CARDS",
  "CHECKING_QUALITY",
]);

export function shouldPollProjectProgress(
  progress: LearnerProjectProgress | null,
): boolean {
  return Boolean(progress && (progress.retrying || AUTO_REFRESH_STAGES.has(progress.stage)));
}

export function shouldRefreshWorkspaceResources(
  previous: LearnerProjectProgress,
  next: LearnerProjectProgress,
): boolean {
  return previous.stage !== next.stage
    || previous.completedChapters !== next.completedChapters
    || previous.totalChapters !== next.totalChapters
    || previous.currentChapter?.chapterId !== next.currentChapter?.chapterId
    || previous.code !== next.code;
}
