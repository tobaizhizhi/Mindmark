"use client";

import {
  CircleAlert,
  FilePlus2,
  LoaderCircle,
  LogOut,
  RefreshCw,
  Wallet,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import type {
  KnowledgeCardFeedback,
} from "@mindmark/shared";
import { useStudySession } from "@/features/learning-workspace/use-study-session";
import { StudySessionView, type CardFeedbackInput } from "@/features/learning-workspace/study-session-view";
import { useLearningWorkspaceData } from "@/features/learning-workspace/use-learning-workspace-data";
import { useWalletSession } from "@/features/learning-workspace/use-wallet-session";
import {
  ChapterLearningView,
  LoadingRows,
  ProjectListView,
  ProjectOverviewView,
} from "@/features/learning-workspace/learning-workspace-views";
import type { ChapterBrowseView } from "@/components/chapter-view-switcher";
import { LearningPrimaryNavigation, type PrimaryNavigationTarget } from "@/components/learning-primary-navigation";
import { parseApiResponse as parseApi } from "@/lib/client/http";

function shortAddress(value: string) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function ProjectLearningWorkspace(props: {
  initialProjectId?: `0x${string}` | null;
  initialChapterId?: number | null;
}) {
  const workspaceKey = `${props.initialProjectId ?? "projects"}:${props.initialChapterId ?? "chapters"}`;
  return <ProjectLearningWorkspaceInner key={workspaceKey} {...props} />;
}

function ProjectLearningWorkspaceInner(props: {
  initialProjectId?: `0x${string}` | null;
  initialChapterId?: number | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedProjectId = props.initialProjectId ?? null;
  const selectedChapterId = props.initialChapterId ?? null;
  const requestedView = searchParams.get("view");
  const sourceFileRequested = requestedView === "pdf";
  const readingRequested = requestedView === "reading" || requestedView === "text";
  const onReadingUnavailable = useCallback(() => {
    if (!selectedProjectId || selectedChapterId === null) return;
    router.replace(`/learn/projects/${selectedProjectId}/chapters/${selectedChapterId}?view=cards`);
  }, [router, selectedChapterId, selectedProjectId]);
  const walletSession = useWalletSession({ onSignedOut: () => router.push("/learn") });
  const data = useLearningWorkspaceData({
    loggedIn: walletSession.loggedIn,
    projectId: selectedProjectId,
    chapterId: selectedChapterId,
    sourceFileRequested,
    readingRequested,
    onReadingUnavailable,
  });
  const {
    projects,
    projectSummary,
    projectProgress,
    chapters,
    detail,
    reading,
    sourceFile,
    sourceFileLoading,
    projectStudy,
    projectsLoading,
    projectLoading,
    chaptersLoading,
    detailLoading,
    projectStudyLoading,
    readingLoading,
    readingError,
    sourceFileUploading,
    generationRetrying,
    sourceFileError,
    dataError,
  } = data;
  const { address, isConnected, loggedIn, busy: authBusy, error: authError } = walletSession;
  const selectedChapter = chapters.find((chapter) => chapter.chapterId === selectedChapterId) ?? null;
  const currentSourceFile = sourceFile?.projectId === selectedProjectId ? sourceFile : null;
  const projectIsPack = projectSummary?.projectKind === "PACK";
  const projectIsUpload = Boolean(projectSummary && !projectIsPack);
  const chapterView: ChapterBrowseView = requestedView === "pdf"
    ? "pdf"
    : requestedView === "cards"
      ? "cards"
      : requestedView === "reading" || requestedView === "text"
        ? "reading"
        : "cards";
  const chapterStudyCards = useMemo(() => {
    if (!detail) return [];
    const cards = new Map(detail.cards.map((card) => [card.id, card]));
    return detail.queue.flatMap((id) => {
      const card = cards.get(id);
      return card ? [card] : [];
    });
  }, [detail]);
  const studySession = useStudySession({
    projectId: selectedProjectId,
    chapterId: selectedChapterId,
    onError: data.setDataError,
    onComplete: data.refreshLifecycle,
  });

  async function startStudy(scope: "project" | "chapter") {
    const projectCards = scope === "project"
      ? projectStudy ?? await data.loadProjectStudy()
      : null;
    const cards = scope === "project" ? projectCards?.queue ?? [] : chapterStudyCards;
    if (cards.length === 0) return;
    studySession.start(scope, cards);
  }

  function refreshData() {
    data.refreshAll();
  }

  function selectChapterView(view: ChapterBrowseView, target?: string) {
    if (!selectedProjectId || selectedChapterId === null) return;
    const normalizedView = view === "reading" ? "text" : view;
    const hash = target ? view === "cards" ? `#card-${target}` : `#${target}` : "";
    router.replace(`/learn/projects/${selectedProjectId}/chapters/${selectedChapterId}?view=${normalizedView}${hash}`, { scroll: false });
  }

  function openOriginalPdf() {
    if (!selectedProjectId || !projectIsUpload) return;
    const firstChapter = chapters.find((chapter) => chapter.status === "READY") ?? chapters[0];
    if (!firstChapter) return;
    router.push(`/learn/projects/${selectedProjectId}/chapters/${firstChapter.chapterId}?view=pdf`);
  }

  function navigatePrimary(target: PrimaryNavigationTarget) {
    if (target === "library") router.push("/learn");
    if (target === "review") router.push("/learn?filter=due");
    if (target === "packs") router.push("/learn/packs");
    if (target === "new") router.push("/learn/projects/new");
  }

  async function submitCardFeedback(input: CardFeedbackInput) {
    const card = studySession.currentCard;
    if (!selectedProjectId || !card) throw new Error("当前知识卡不可用");
    const chapterId = studySession.scope === "project" && "chapterId" in card
      ? card.chapterId
      : selectedChapterId;
    if (chapterId === null) throw new Error("无法确定知识卡所属章节");
    await parseApi<KnowledgeCardFeedback>(await fetch(`/api/projects/${selectedProjectId}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chapterId, cardId: card.id, ...input }),
    }));
  }

  function renderProjectPage() {
    if (projectLoading || chaptersLoading || !projectSummary) {
      return <LoadingRows count={6} />;
    }
    return (
      <ProjectOverviewView
        projectId={selectedProjectId!}
        project={projectSummary}
        progress={projectProgress}
        chapters={chapters}
        study={projectStudy}
        studyLoading={projectSummary.status === "READY" && projectStudyLoading}
        generationRetrying={generationRetrying}
        onNavigate={router.push}
        onRefresh={refreshData}
        onRetryGeneration={() => void data.retryGeneration()}
        onOpenPdf={openOriginalPdf}
        onStudy={() => void startStudy("project")}
      />
    );
  }

  function renderChapterPage() {
    if (projectLoading || chaptersLoading || detailLoading || !projectSummary || !selectedChapter || !detail) {
      return <LoadingRows count={6} />;
    }
    return <ChapterLearningView
      projectId={selectedProjectId!}
      project={projectSummary}
      progress={projectProgress}
      chapters={chapters}
      chapter={selectedChapter}
      detail={detail}
      reading={reading}
      sourceFile={currentSourceFile}
      sourceFileLoading={sourceFileLoading}
      view={chapterView}
      studyCardCount={chapterStudyCards.length}
      readingLoading={readingLoading}
      readingError={readingError}
      sourceFileUploading={sourceFileUploading}
      sourceFileError={sourceFileError}
      generationRetrying={generationRetrying}
      onNavigate={router.push}
      onRefresh={refreshData}
      onRetryGeneration={() => void data.retryGeneration()}
      onStudy={() => void startStudy("chapter")}
      onSelectView={selectChapterView}
      onUploadSourceFile={data.uploadSourceFile}
      onRetryReading={data.retryReading}
    />;
  }

  let content: React.ReactNode;
  if (studySession.active) {
    content = (
      <StudySessionView
        scope={studySession.scope ?? "chapter"}
        cards={studySession.cards}
        currentCard={studySession.currentCard}
        studyIndex={studySession.index}
        answerVisible={studySession.answerVisible}
        ratingBusy={studySession.ratingBusy}
        studyDone={studySession.done}
        studyFinishing={studySession.finishing}
        onExit={studySession.exit}
        onReveal={studySession.reveal}
        onRate={(rating) => void studySession.rate(rating)}
        onFeedback={submitCardFeedback}
      />
    );
  } else if (!selectedProjectId) {
    content = (
      <>
        <div className="mb-9 flex items-end justify-between border-b border-[var(--line-strong)] pb-7">
          <div><p className="section-kicker">我的资料</p><h1 className="font-display mt-3 text-4xl font-semibold">学习项目</h1></div>
          <button type="button" onClick={() => router.push("/learn/projects/new")} className="command-button command-button-accent"><FilePlus2 className="size-4" />新建项目</button>
        </div>
        <ProjectListView projects={projects} loading={projectsLoading} onOpenProject={(projectId) => router.push(`/learn/projects/${projectId}`)} onCreateProject={() => router.push("/learn/projects/new")} />
      </>
    );
  } else if (selectedChapterId === null) {
    content = renderProjectPage();
  } else {
    content = renderChapterPage();
  }

  const contextTitle = selectedChapter?.title ?? projectSummary?.title ?? (selectedProjectId ? "学习资料" : "我的学习");
  const contextLabel = selectedChapter
    ? `第 ${selectedChapter.position + 1} 章`
    : projectSummary
      ? "资料概览"
      : "学习工作台";
  const readerMode = loggedIn
    && selectedChapterId !== null
    && selectedChapter !== null
    && detail !== null
    && !studySession.active;

  return (
    <main className="learning-workspace-shell min-h-screen bg-[var(--background)] text-[var(--ink)]" data-reader-mode={readerMode} data-study-mode={studySession.active}>
      {!readerMode && !studySession.active ? <LearningPrimaryNavigation
        variant="rail"
        active={null}
        onNavigate={navigatePrimary}
        footer={<button type="button" onClick={() => void walletSession.authenticate()} disabled={authBusy} aria-label={loggedIn && address ? shortAddress(address) : isConnected ? "完成登录" : "连接并登录"} title={loggedIn && address ? shortAddress(address) : isConnected ? "完成登录" : "连接并登录"}>{authBusy ? <LoaderCircle className="animate-spin" /> : loggedIn ? <LogOut /> : <Wallet />}<span>{loggedIn && address ? shortAddress(address) : "连接钱包"}</span></button>}
      /> : null}
      {!readerMode && !studySession.active ? <header className="learning-context-header">
        <div className="learning-context-copy"><span>{contextLabel}</span><strong title={contextTitle}>{contextTitle}</strong></div>
      </header> : null}

      {authError ? <div className="learning-workspace-banner border-b border-[var(--danger)] bg-[var(--danger-soft)] px-8 py-3 text-sm text-[var(--danger)]">{authError}</div> : null}
      {dataError ? (
        <div className="learning-workspace-banner flex items-center justify-between gap-4 border-b border-[var(--danger)] bg-[var(--danger-soft)] px-8 py-3 text-sm text-[var(--danger)]">
          <span className="flex min-w-0 items-center gap-2"><CircleAlert className="size-4 shrink-0" />{dataError}</span>
          <button type="button" onClick={refreshData} className="icon-button size-8" title="重试" aria-label="重试"><RefreshCw className="size-3.5" /></button>
        </div>
      ) : null}

      {!loggedIn ? (
        <div className="learning-workspace-body mx-auto max-w-7xl px-8 py-28">
          <p className="section-kicker">个人学习资料库</p>
          <h1 className="font-display mt-3 max-w-2xl text-5xl font-semibold">从项目进入章节，再开始专注复习</h1>
        </div>
      ) : (
        <div className={`learning-workspace-body ${selectedProjectId && !studySession.active ? "project-document-frame" : "mx-auto max-w-7xl px-8 py-10"}`}>{content}</div>
      )}
    </main>
  );
}
