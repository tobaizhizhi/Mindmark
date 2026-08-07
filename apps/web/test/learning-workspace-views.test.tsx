import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  ChapterListResponse,
  ChapterStudyResponse,
  LearnerProjectProgress,
  ProjectListResponse,
  ProjectSourceFileResponse,
  ProjectStudyResponse,
  ProjectSummary,
} from "@mindmark/shared";
import {
  ChapterLearningView,
  ProjectListView,
  ProjectOverviewView,
} from "@/features/learning-workspace/learning-workspace-views";
import { ProjectProgressIndicator } from "@/features/learning-workspace/project-progress-indicator";

const projectId = `0x${"12".repeat(32)}` as const;
const project: ProjectSummary = {
  projectId,
  projectKind: "UPLOAD",
  packVersionId: null,
  registryVersion: 2,
  title: "Solidity 基础",
  goal: "掌握合约语法",
  status: "READY",
  chapterCount: 1,
  readyChapterCount: 1,
  cardCount: 6,
  dueCount: 2,
  updatedAt: "2026-08-03T00:00:00.000Z",
};

const projects: ProjectListResponse["projects"] = [project];
const study: ProjectStudyResponse = {
  projectId,
  status: "READY",
  readyChapterCount: 1,
  dueCount: 2,
  newCount: 4,
  queue: [],
};
const chapter: ChapterListResponse["chapters"][number] = {
  projectId,
  chapterId: 0,
  position: 0,
  title: "Solidity 状态变量",
  summary: "理解状态变量的存储与访问方式。",
  pageStart: 1,
  pageEnd: 4,
  importance: 5,
  status: "READY",
  cardCount: 0,
  studiedCount: 0,
  dueCount: 0,
  newCount: 0,
  masteredCount: 0,
  lastReviewedAt: null,
  progressPercent: 0,
};
const detail: ChapterStudyResponse = {
  projectId,
  chapterId: 0,
  status: "READY",
  cards: [],
  queue: [],
  dueCount: 0,
  newCount: 0,
};
const missingSourceFile: ProjectSourceFileResponse = {
  projectId,
  available: false,
  status: "MISSING",
  url: null,
  filename: null,
  fileSize: null,
  expiresAt: null,
};

describe("Learning Workspace views", () => {
  it("renders project status and progress through the list view interface", () => {
    const markup = renderToStaticMarkup(
      <ProjectListView projects={projects} loading={false} onOpenProject={() => undefined} onCreateProject={() => undefined} />,
    );
    expect(markup).toContain("Solidity 基础");
    expect(markup).toContain("可以学习");
    expect(markup).toContain("1/1 章节");
  });

  it("keeps original PDF access in the upload project overview", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewView
        projectId={projectId}
        project={project}
        progress={null}
        chapters={[]}
        study={study}
        studyLoading={false}
        onNavigate={() => undefined}
        onRefresh={() => undefined}
        onOpenPdf={() => undefined}
        onStudy={() => undefined}
      />,
    );
    expect(markup).toContain("打开 PDF");
    expect(markup).toContain("尚未确认章节");
    expect(markup).toContain("document-study-layout-single");
    expect(markup).not.toContain("document-chapter-rail");
    expect(markup).not.toContain("可学习章节");
    expect(markup).not.toContain("资料就绪");
    expect(markup).not.toContain("document-study-metrics");
  });

  it("renders the project before the slower study queue has loaded", () => {
    const markup = renderToStaticMarkup(
      <ProjectOverviewView
        projectId={projectId}
        project={project}
        progress={null}
        chapters={[]}
        study={null}
        studyLoading
        onNavigate={() => undefined}
        onRefresh={() => undefined}
        onOpenPdf={() => undefined}
        onStudy={() => undefined}
      />,
    );
    expect(markup).toContain("Solidity 基础");
    expect(markup).toContain("正在加载复习卡");
  });

  it("uses one compact toolbar and removes chapter chrome in PDF focus mode", () => {
    const markup = renderToStaticMarkup(
      <ChapterLearningView
        projectId={projectId}
        project={project}
        progress={null}
        chapters={[chapter]}
        chapter={chapter}
        detail={detail}
        reading={null}
        sourceFile={missingSourceFile}
        sourceFileLoading={false}
        view="pdf"
        studyCardCount={0}
        readingLoading={false}
        readingError={null}
        sourceFileUploading={false}
        sourceFileError={null}
        onNavigate={() => undefined}
        onRefresh={() => undefined}
        onStudy={() => undefined}
        onSelectView={() => undefined}
        onUploadSourceFile={async () => null}
        onRetryReading={() => undefined}
      />,
    );
    expect(markup).toContain('data-focus-mode="true"');
    expect(markup).toContain("reader-document-layout");
    expect(markup).toContain('aria-label="返回资料概览"');
    expect(markup).toContain("pdf-viewer-toolbar");
    expect(markup.match(/pdf-viewer-toolbar/gu)).toHaveLength(1);
    expect(markup).not.toContain("document-study-heading");
    expect(markup).not.toContain("document-chapter-summary");
    expect(markup).not.toContain("document-study-metrics");
    expect(markup).not.toContain("document-chapter-summary");
    expect(markup).not.toContain("chapter-browse-toolbar");
    expect(markup).not.toContain("document-chapter-rail");
  });

  it("does not render the redundant chapter metrics strip", () => {
    const markup = renderToStaticMarkup(
      <ChapterLearningView
        projectId={projectId}
        project={project}
        progress={null}
        chapters={[chapter]}
        chapter={chapter}
        detail={detail}
        reading={null}
        sourceFile={missingSourceFile}
        sourceFileLoading={false}
        view="cards"
        studyCardCount={0}
        readingLoading={false}
        readingError={null}
        sourceFileUploading={false}
        sourceFileError={null}
        onNavigate={() => undefined}
        onRefresh={() => undefined}
        onStudy={() => undefined}
        onSelectView={() => undefined}
        onUploadSourceFile={async () => null}
        onRetryReading={() => undefined}
      />,
    );
    expect(markup).not.toContain("document-study-metrics");
  });

  it("uses distinct left, center, and right zones in the chapter toolbar", () => {
    const markup = renderToStaticMarkup(
      <ChapterLearningView
        projectId={projectId}
        project={project}
        progress={null}
        chapters={[chapter]}
        chapter={chapter}
        detail={detail}
        reading={null}
        sourceFile={missingSourceFile}
        sourceFileLoading={false}
        view="cards"
        studyCardCount={0}
        readingLoading={false}
        readingError={null}
        sourceFileUploading={false}
        sourceFileError={null}
        onNavigate={() => undefined}
        onRefresh={() => undefined}
        onStudy={() => undefined}
        onSelectView={() => undefined}
        onUploadSourceFile={async () => null}
        onRetryReading={() => undefined}
      />,
    );
    expect(markup).toMatch(
      /reader-toolbar-navigation[\s\S]*chapter-browse-modes[\s\S]*chapter-browse-actions/u,
    );
  });

  it("shows a traceable operation when generation requires action", () => {
    const progress: LearnerProjectProgress = {
      projectId,
      stage: "ACTION_REQUIRED",
      progressPercent: 55,
      currentChapter: { chapterId: 0, title: "Solidity 变量" },
      completedChapters: 0,
      totalChapters: 1,
      retrying: false,
      updatedAt: "2026-08-03T00:00:00.000Z",
      operationId: "00000000-0000-4000-8000-000000000123",
      code: "workflow_action_required",
    };
    const markup = renderToStaticMarkup(<ProjectProgressIndicator progress={progress} onRetry={() => undefined} />);
    expect(markup).toContain("生成流程需要处理");
    expect(markup).toContain("操作 00000000");
    expect(markup).toContain(progress.operationId!);
    expect(markup).toContain("继续处理");
    expect(markup).toContain("Monad Registry");
    expect(markup).toContain("Moss Agent");
  });
});
