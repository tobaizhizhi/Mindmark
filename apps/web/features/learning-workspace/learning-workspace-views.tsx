"use client";

import {
  BookOpen,
  CalendarCheck2,
  ChevronRight,
  FilePlus2,
  FileText,
  Layers3,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
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
import type { ChapterBrowseView } from "@/components/chapter-view-switcher";
import { ChapterReaderNavigation } from "./chapter-reader-navigation";
import { ChapterBrowser } from "./chapter-browser";
import { LearningCompletionClaim } from "./learning-completion-claim";
import { ProjectProgressIndicator } from "./project-progress-indicator";

const projectStatusLabels: Record<string, string> = {
  UPLOADED: "资料已上传", OUTLINING: "正在整理章节", OUTLINE_READY: "等待确认章节",
  DESIGNING_CARDS: "正在规划知识卡", AWAITING_REGISTRY: "等待 Monad 登记", GENERATING: "正在生成知识卡",
  FINALIZING: "正在完成项目", READY: "可以学习", FAILED_RETRYABLE: "正在恢复", CANCELLED: "已取消",
};

const chapterStatusLabels: Record<string, string> = {
  DRAFT: "章节草稿", CONFIRMED: "等待生成", GENERATING: "AI 生成中", QUALITY_CHECK: "质量检查中",
  ASSEMBLING: "正在整理卡片", READY: "可以学习", FAILED_RETRYABLE: "正在恢复",
};

const activeChapterStageLabels: Partial<Record<LearnerProjectProgress["stage"], string>> = {
  GENERATING_CARDS: "知识卡生成中",
  CHECKING_QUALITY: "质量检查中",
  REPAIRING_CARDS: "自动修复中",
  ASSEMBLING_CHAPTERS: "章节整理中",
  READY: "已完成",
};

function chapterStatusLabel(
  chapterId: number,
  status: string,
  progress: LearnerProjectProgress | null,
) {
  if (progress?.currentChapter?.chapterId === chapterId) {
    const stageLabel = activeChapterStageLabels[progress.stage];
    if (stageLabel) return stageLabel;
  }
  return chapterStatusLabels[status] ?? status;
}

function statusTone(status: string) {
  return status === "READY" ? "text-[var(--success)]" : status === "FAILED_RETRYABLE" ? "text-[var(--danger)]" : "text-[var(--muted)]";
}

export function LoadingRows({ count = 4 }: { count?: number }) {
  return <div className="ui-loading-list" aria-label="正在加载" aria-busy="true">
    {Array.from({ length: count }, (_, index) => <div key={index} className="ui-loading-row"><span /><span /></div>)}
  </div>;
}

function EmptyState(props: { title: string; detail: string; action?: React.ReactNode }) {
  return <div className="ui-state ui-state-empty">
    <span className="ui-state-icon"><Layers3 /></span>
    <h2>{props.title}</h2><p>{props.detail}</p>{props.action ? <div className="ui-state-action">{props.action}</div> : null}
  </div>;
}

export function ProjectListView(props: {
  projects: ProjectListResponse["projects"];
  loading: boolean;
  onOpenProject: (projectId: `0x${string}`) => void;
  onCreateProject: () => void;
}) {
  if (props.loading) return <LoadingRows count={6} />;
  if (props.projects.length === 0) return <EmptyState title="还没有项目" detail="上传资料后，项目会显示在这里。" action={<button type="button" onClick={props.onCreateProject} className="command-button command-button-accent"><FilePlus2 className="size-4" />新建项目</button>} />;
  return <div className="project-list-grid">{props.projects.map((project) => {
    const percent = project.chapterCount ? Math.round(project.readyChapterCount * 100 / project.chapterCount) : 0;
    return <button key={project.projectId} type="button" onClick={() => props.onOpenProject(project.projectId)} className="project-list-card group">
      <div className="flex items-start justify-between gap-5"><span className="flex size-9 items-center justify-center bg-[var(--paper)] text-[var(--accent)]"><BookOpen className="size-4" /></span><ChevronRight className="size-4 text-[var(--line-strong)] group-hover:text-[var(--ink)]" /></div>
      <h2 className="font-display mt-6 line-clamp-2 text-xl font-semibold leading-7">{project.title}</h2><p className={`mt-2 text-xs ${statusTone(project.status)}`}>{projectStatusLabels[project.status] ?? project.status}</p>
      <div className="mt-6 h-1 bg-[var(--line)]"><div className="h-full bg-[var(--accent)]" style={{ width: `${percent}%` }} /></div><div className="mt-3 flex items-center justify-between text-[11px] text-[var(--muted)]"><span>{project.readyChapterCount}/{project.chapterCount} 章节</span><span>{project.cardCount} 卡片 · {project.dueCount} 到期</span></div>
    </button>;
  })}</div>;
}

export function ProjectOverviewView(props: { projectId: `0x${string}`; project: ProjectSummary; progress: LearnerProjectProgress | null; chapters: ChapterListResponse["chapters"]; study: ProjectStudyResponse | null; studyLoading: boolean; generationRetrying?: boolean; onNavigate: (path: string) => void; onRefresh: () => void; onRetryGeneration?: () => void; onOpenPdf: () => void; onStudy: () => void }) {
  const masteredCount = props.chapters.reduce((total, chapter) => total + chapter.masteredCount, 0);
  return <div className="document-study-layout document-study-layout-single" aria-label={`${props.project.title}资料概览`}><section className="document-study-content">
    <div className="document-overview-actions">{props.project.goal ? <p>{props.project.goal}</p> : <span />}<div>{props.project.projectKind === "UPLOAD" ? <><button type="button" onClick={() => props.onNavigate(`/verify/${props.projectId}`)} className="command-button command-button-quiet"><ShieldCheck className="size-4" />Monad 验证</button><button type="button" onClick={props.onOpenPdf} disabled={props.chapters.length === 0} className="command-button command-button-quiet"><FileText className="size-4" />打开 PDF</button></> : null}<button type="button" onClick={props.onStudy} disabled={props.studyLoading || props.project.status !== "READY" || Boolean(props.study && props.study.queue.length === 0)} className="command-button command-button-accent">{props.studyLoading ? <LoaderCircle className="size-4 animate-spin" /> : <CalendarCheck2 className="size-4" />}{props.studyLoading ? "正在加载复习卡" : props.study && props.study.queue.length > 0 ? `复习 ${props.study.queue.length} 张 · ${props.study.dueCount} 到期 / ${props.study.newCount} 新卡` : props.study ? "今日已完成" : props.project.status === "READY" ? `开始复习${props.project.dueCount ? ` · ${props.project.dueCount} 到期` : ""}` : "生成完成后可复习"}</button></div></div>
    {props.progress ? <ProjectProgressIndicator progress={props.progress} retryBusy={props.generationRetrying} onRetry={props.onRetryGeneration} /> : null}
    {props.project.projectKind === "UPLOAD" && props.project.status === "READY" ? <LearningCompletionClaim projectId={props.projectId} cardCount={props.project.cardCount} masteredCount={masteredCount} /> : null}
    <div className="document-section-heading"><div><span>目录</span><h2>章节</h2></div><button type="button" onClick={props.onRefresh} className="icon-button" title="刷新" aria-label="刷新"><RefreshCw className="size-4" /></button></div>
    {props.chapters.length === 0 ? <EmptyState title="尚未确认章节" detail="请先完成资料结构确认。" /> : <div className="document-chapter-list">{props.chapters.map((chapter) => <button key={chapter.chapterId} type="button" onClick={() => props.onNavigate(`/learn/projects/${props.projectId}/chapters/${chapter.chapterId}`)} className="document-chapter-row"><span className="document-chapter-number">{String(chapter.position + 1).padStart(2, "0")}</span><span className="document-chapter-copy"><strong>{chapter.title}</strong><small>{chapter.summary}</small></span><span className="document-chapter-meta"><b>{chapter.cardCount} 卡片</b><small>{chapter.dueCount ? `${chapter.dueCount} 待复习` : chapterStatusLabel(chapter.chapterId, chapter.status, props.progress)}</small></span><span className="document-chapter-progress"><i><b style={{ width: `${chapter.progressPercent}%` }} /></i><small>{chapter.progressPercent}%</small></span><ChevronRight /></button>)}</div>}
  </section></div>;
}

export function ChapterLearningView(props: { projectId: `0x${string}`; project: ProjectSummary; progress: LearnerProjectProgress | null; chapters: ChapterListResponse["chapters"]; chapter: ChapterListResponse["chapters"][number]; detail: ChapterStudyResponse; reading: ChapterReadingResponse | null; sourceFile: ProjectSourceFileResponse | null; sourceFileLoading: boolean; view: ChapterBrowseView; studyCardCount: number; readingLoading: boolean; readingError: string | null; sourceFileUploading: boolean; sourceFileError: string | null; generationRetrying?: boolean; onNavigate: (path: string) => void; onRefresh: () => void; onRetryGeneration?: () => void; onStudy: () => void; onSelectView: (view: ChapterBrowseView, target?: string) => void; onUploadSourceFile: (file: File) => Promise<ProjectSourceFileResponse | null>; onRetryReading: () => void }) {
  const focusMode = props.view === "pdf" && props.detail.status === "READY";
  const openProject = () => props.onNavigate(`/learn/projects/${props.projectId}`);
  const readerNavigation = <ChapterReaderNavigation
    chapterPosition={props.chapter.position}
    chapterTitle={props.chapter.title}
    onOpenProject={openProject}
  />;

  return <div className="document-study-layout document-study-layout-single reader-document-layout" data-focus-mode={focusMode}>
    <section className="document-study-content">
      {props.detail.status !== "READY" ? <>
        <div className="chapter-browse-toolbar chapter-generation-toolbar">
          {readerNavigation}
          <button type="button" onClick={props.onRefresh} className="reader-study-command"><RefreshCw /><span>刷新</span></button>
        </div>
        {props.progress ? <ProjectProgressIndicator progress={props.progress} compact retryBusy={props.generationRetrying} onRetry={props.onRetryGeneration} /> : null}
        <div className="ui-state ui-state-working"><span className="ui-state-icon"><Sparkles /></span><h2>{chapterStatusLabel(props.chapter.chapterId, props.detail.status, props.progress)}</h2><p>知识卡会在生成完成后自动出现在这里。</p><div className="ui-state-action"><button type="button" onClick={props.onRefresh} className="command-button command-button-quiet"><RefreshCw className="size-4" />刷新状态</button></div></div>
      </> : <ChapterBrowser {...props} onOpenProject={openProject} onStudy={props.onStudy} />}
    </section>
  </div>;
}
