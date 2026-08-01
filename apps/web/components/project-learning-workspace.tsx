"use client";

import {
  ArrowLeft,
  BookOpen,
  CalendarCheck2,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileText,
  FilePlus2,
  Layers3,
  LoaderCircle,
  LogOut,
  MessageSquare,
  Pencil,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Wallet,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { SiweMessage } from "siwe";
import type {
  AuthNonceResponse,
  AuthVerifyResponse,
  ChapterListResponse,
  ChapterStudyCard,
  ChapterStudyResponse,
  KnowledgeCardFeedback,
  ProjectListResponse,
  ProjectStudyCard,
  ProjectStudyResponse,
  ProjectSummary,
  SubmitKnowledgeCardFeedbackRequest,
  SubmitReviewResponse,
} from "@mindmark/shared";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSignMessage,
  useSwitchChain,
} from "wagmi";
import { monadChain } from "@/lib/client/chain";
import {
  createPersistedReviewSessionIds,
  createSerialTaskQueue,
  MAX_CARDS_PER_PERSISTED_REVIEW_SESSION,
  persistedReviewSessionIdForCard,
} from "@/lib/client/serial-task-queue";

type ApiErrorBody = { error?: { code?: string; message?: string } };
type StudyCard = ChapterStudyCard | ProjectStudyCard;
type CardFeedbackInput = Omit<SubmitKnowledgeCardFeedbackRequest, "chapterId" | "cardId">;

const cardTypeLabels: Record<StudyCard["type"], string> = {
  concept: "概念卡",
  qa: "问答卡",
};

const cardStateLabels: Record<StudyCard["state"], string> = {
  NEW: "新卡",
  LEARNING: "学习中",
  DUE: "到期复习",
  SCHEDULED: "已安排",
};

async function parseApi<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & ApiErrorBody;
  if (!response.ok) throw new Error(body.error?.message ?? "请求失败");
  return body;
}

const projectStatusLabels: Record<string, string> = {
  UPLOADED: "资料已上传",
  OUTLINING: "正在整理章节",
  OUTLINE_READY: "等待确认章节",
  DESIGNING_CARDS: "正在规划知识卡",
  AWAITING_REGISTRY: "等待 Monad 登记",
  GENERATING: "正在生成知识卡",
  FINALIZING: "正在完成项目",
  READY: "可以学习",
  FAILED_RETRYABLE: "正在恢复",
  CANCELLED: "已取消",
};

const chapterStatusLabels: Record<string, string> = {
  DRAFT: "章节草稿",
  CONFIRMED: "等待生成",
  GENERATING: "AI 生成中",
  QUALITY_CHECK: "质量检查中",
  ASSEMBLING: "正在整理卡片",
  READY: "可以学习",
  FAILED_RETRYABLE: "正在恢复",
};

function shortAddress(value: string) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function statusTone(status: string) {
  return status === "READY"
    ? "text-[var(--success)]"
    : status === "FAILED_RETRYABLE"
      ? "text-[var(--danger)]"
      : "text-[var(--muted)]";
}

function LoadingRows({ count = 4 }: { count?: number }) {
  return (
    <div className="divide-y divide-[var(--line)] border-y border-[var(--line)] bg-white/55" aria-label="正在加载">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="animate-pulse px-6 py-6">
          <div className="h-3 w-2/3 bg-[var(--line)]" />
          <div className="mt-3 h-2 w-1/3 bg-[var(--paper)]" />
        </div>
      ))}
    </div>
  );
}

function EmptyState(props: { title: string; detail: string; action?: React.ReactNode }) {
  return (
    <div className="flex min-h-80 flex-col items-start justify-center border-y border-[var(--line)] bg-white/45 px-10 py-14">
      <span className="flex size-10 items-center justify-center border border-[var(--line-strong)] bg-white text-[var(--accent)]">
        <Layers3 className="size-5" />
      </span>
      <h2 className="font-display mt-5 text-xl font-semibold">{props.title}</h2>
      <p className="mt-2 max-w-md text-sm leading-7 text-[var(--muted)]">{props.detail}</p>
      {props.action ? <div className="mt-6">{props.action}</div> : null}
    </div>
  );
}

function StudyCardFeedback(props: {
  cardId: string;
  onSubmit: (input: CardFeedbackInput) => Promise<void>;
}) {
  const [rating, setRating] = useState<CardFeedbackInput["rating"] | null>(null);
  const [reason, setReason] = useState("");
  const [showCorrection, setShowCorrection] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [keyPoint, setKeyPoint] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsReason = rating === "INCORRECT" || rating === "UNCLEAR";
  const choices: Array<{
    rating: CardFeedbackInput["rating"];
    label: string;
    icon: typeof ThumbsUp;
  }> = [
    { rating: "UP", label: "有帮助", icon: ThumbsUp },
    { rating: "DOWN", label: "没有帮助", icon: ThumbsDown },
    { rating: "INCORRECT", label: "事实有误", icon: CircleAlert },
    { rating: "UNCLEAR", label: "表述不清", icon: MessageSquare },
  ];

  async function submit() {
    if (!rating || submitted || busy) return;
    const normalizedReason = reason.trim();
    if (needsReason && !normalizedReason) {
      setError("请说明卡片的问题。");
      return;
    }
    const correctedContent = {
      ...(question.trim() ? { question: question.trim() } : {}),
      ...(answer.trim() ? { answer: answer.trim() } : {}),
      ...(keyPoint.trim() ? { keyPoint: keyPoint.trim() } : {}),
    };
    setBusy(true);
    setError(null);
    try {
      await props.onSubmit({
        rating,
        ...(normalizedReason ? { reason: normalizedReason } : {}),
        ...(Object.keys(correctedContent).length ? { correctedContent } : {}),
      });
      setSubmitted(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "反馈保存失败");
    } finally {
      setBusy(false);
    }
  }

  if (submitted) {
    return <p className="mt-5 flex items-center gap-2 text-xs text-[var(--success)]"><Check className="size-4" />反馈已记录</p>;
  }

  return (
    <section className="mt-7 border-t border-[var(--line)] pt-5" aria-label="知识卡反馈">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold text-[var(--muted)]">卡片反馈</p>
        <div className="flex items-center gap-1.5">
          {choices.map((choice) => {
            const Icon = choice.icon;
            const selected = rating === choice.rating;
            return (
              <button
                key={choice.rating}
                type="button"
                onClick={() => { setRating(choice.rating); setError(null); }}
                disabled={busy}
                aria-label={choice.label}
                aria-pressed={selected}
                title={choice.label}
                className={`flex size-9 items-center justify-center border transition-colors ${selected ? "border-[var(--accent)] bg-[var(--success-soft)] text-[var(--accent)]" : "border-[var(--line-strong)] bg-white text-[var(--muted)] hover:border-[var(--ink)] hover:text-[var(--ink)]"}`}
              >
                <Icon className="size-4" />
              </button>
            );
          })}
        </div>
      </div>
      {rating ? (
        <div className="mt-4 space-y-3">
          <label className="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">
            {needsReason ? "问题说明" : "补充说明（可选）"}
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={busy}
              required={needsReason}
              maxLength={500}
              rows={2}
              className="w-full resize-y border border-[var(--line-strong)] bg-white px-3 py-2 text-sm font-normal leading-6 text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent)] disabled:bg-[var(--paper)]"
            />
          </label>
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setShowCorrection((value) => !value)}
              disabled={busy}
              className="icon-button size-8"
              title="添加修订建议"
              aria-label="添加修订建议"
              aria-expanded={showCorrection}
            >
              <Pencil className="size-3.5" />
            </button>
            <button type="button" onClick={() => void submit()} disabled={busy} className="command-button command-button-quiet min-h-8 px-3 text-xs">
              {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}提交反馈
            </button>
          </div>
          {showCorrection ? (
            <div className="grid gap-3 border-l-2 border-[var(--accent)] bg-white/60 p-3">
              <label className="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">建议问题
                <textarea value={question} onChange={(event) => setQuestion(event.target.value)} disabled={busy} maxLength={500} rows={2} className="w-full resize-y border border-[var(--line-strong)] bg-white px-3 py-2 text-sm font-normal leading-6 text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent)] disabled:bg-[var(--paper)]" />
              </label>
              <label className="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">建议答案
                <textarea value={answer} onChange={(event) => setAnswer(event.target.value)} disabled={busy} maxLength={1500} rows={3} className="w-full resize-y border border-[var(--line-strong)] bg-white px-3 py-2 text-sm font-normal leading-6 text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent)] disabled:bg-[var(--paper)]" />
              </label>
              <label className="grid gap-1.5 text-xs font-semibold text-[var(--muted)]">建议关键点
                <textarea value={keyPoint} onChange={(event) => setKeyPoint(event.target.value)} disabled={busy} maxLength={500} rows={2} className="w-full resize-y border border-[var(--line-strong)] bg-white px-3 py-2 text-sm font-normal leading-6 text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent)] disabled:bg-[var(--paper)]" />
              </label>
            </div>
          ) : null}
          {error ? <p className="text-xs text-[var(--danger)]" role="alert">{error}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function StudySessionView(props: {
  scope: "project" | "chapter";
  cards: StudyCard[];
  currentCard: StudyCard | null;
  studyIndex: number;
  answerVisible: boolean;
  ratingBusy: boolean;
  studyDone: boolean;
  studyFinishing: boolean;
  onExit: () => void;
  onReveal: () => void;
  onRate: (rating: "again" | "hard" | "good" | "easy") => void;
  onFeedback: (input: CardFeedbackInput) => Promise<void>;
}) {
  if (props.studyDone) {
    return (
      <div className="flex min-h-[70vh] flex-col items-center justify-center text-center">
        <span className="flex size-12 items-center justify-center bg-[var(--success)] text-white">
          {props.studyFinishing ? <LoaderCircle className="size-6 animate-spin" /> : <Check className="size-6" />}
        </span>
        <p className="section-kicker mt-6">Session complete</p>
        <h1 className="font-display mt-2 text-3xl font-semibold">{props.scope === "project" ? "项目今日复习完成" : "本章今日复习完成"}</h1>
        <p className="mt-3 text-sm text-[var(--muted)]">
          {props.studyFinishing ? "正在保存复习进度…" : `已更新 ${props.cards.length} 张卡片的下次复习时间。`}
        </p>
        <button type="button" onClick={props.onExit} disabled={props.studyFinishing} className="command-button command-button-dark mt-7"><ArrowLeft className="size-4" />{props.scope === "project" ? "返回项目" : "返回章节"}</button>
      </div>
    );
  }

  if (!props.currentCard) return null;
  const projectCard = "chapterTitle" in props.currentCard ? props.currentCard : null;
  return (
    <div className="mx-auto flex min-h-[calc(100vh-9rem)] max-w-3xl flex-col py-3">
      <div className="flex items-center justify-between border-b border-[var(--line)] pb-4">
        <button type="button" onClick={props.onExit} className="text-command"><ArrowLeft className="size-4" />退出复习</button>
        <span className="font-mono text-xs text-[var(--muted)]">{props.studyIndex + 1} / {props.cards.length}</span>
      </div>
      <div className="h-1 bg-[var(--line)]"><div className="h-full bg-[var(--accent)] transition-[width]" style={{ width: `${(props.studyIndex + 1) * 100 / props.cards.length}%` }} /></div>
      <div className="flex flex-1 flex-col justify-center py-12">
        {projectCard ? <p className="mb-3 text-xs font-semibold text-[var(--muted)]">Chapter {String(projectCard.chapterPosition + 1).padStart(2, "0")} · {projectCard.chapterTitle}</p> : null}
        <div className="flex items-center gap-3 text-[10px] font-bold text-[var(--accent)]">
          <span className="flex items-center gap-1.5"><Clock3 className="size-3.5" />{cardStateLabels[props.currentCard.state]}</span>
          <span className="flex items-center gap-1.5 border-l border-[var(--line-strong)] pl-3 text-[var(--muted)]"><Layers3 className="size-3.5" />{cardTypeLabels[props.currentCard.type]}</span>
        </div>
        <h1 className="font-display mt-5 text-3xl font-semibold leading-10">{props.currentCard.question}</h1>
        {!props.answerVisible ? (
          <button type="button" onClick={props.onReveal} className="command-button command-button-dark mt-10 w-full">显示答案</button>
        ) : (
          <div className="mt-9 border-t border-[var(--line-strong)] pt-7">
            <p className="text-sm leading-8">{props.currentCard.answer}</p>
            <blockquote className="mt-6 border-l-2 border-[var(--accent)] bg-white px-4 py-3 text-xs leading-6 text-[var(--muted)]">“{props.currentCard.source.quote}”<span className="ml-2 font-mono">p.{props.currentCard.source.page}</span></blockquote>
            <StudyCardFeedback key={props.currentCard.id} cardId={props.currentCard.id} onSubmit={props.onFeedback} />
            <div className="mt-8 grid grid-cols-4 gap-2">
              <button type="button" disabled={props.ratingBusy} onClick={() => props.onRate("again")} className="command-button border border-[#d7aaa5] bg-white text-[var(--danger)]"><RotateCcw className="size-4" />忘记</button>
              <button type="button" disabled={props.ratingBusy} onClick={() => props.onRate("hard")} className="command-button command-button-quiet">困难</button>
              <button type="button" disabled={props.ratingBusy} onClick={() => props.onRate("good")} className="command-button command-button-accent">掌握</button>
              <button type="button" disabled={props.ratingBusy} onClick={() => props.onRate("easy")} className="command-button command-button-dark">轻松</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
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
  const selectedProjectId = props.initialProjectId ?? null;
  const selectedChapterId = props.initialChapterId ?? null;
  const [sessionAddress, setSessionAddress] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectListResponse["projects"]>([]);
  const [projectSummary, setProjectSummary] = useState<ProjectSummary | null>(null);
  const [chapters, setChapters] = useState<ChapterListResponse["chapters"]>([]);
  const [detail, setDetail] = useState<ChapterStudyResponse | null>(null);
  const [projectStudy, setProjectStudy] = useState<ProjectStudyResponse | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectLoading, setProjectLoading] = useState(true);
  const [chaptersLoading, setChaptersLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(true);
  const [projectStudyLoading, setProjectStudyLoading] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [studyActive, setStudyActive] = useState(false);
  const [studyScope, setStudyScope] = useState<"project" | "chapter" | null>(null);
  const [sessionCards, setSessionCards] = useState<StudyCard[]>([]);
  const [studyIndex, setStudyIndex] = useState(0);
  const [answerVisible, setAnswerVisible] = useState(false);
  const [ratingBusy, setRatingBusy] = useState(false);
  const [studyDone, setStudyDone] = useState(false);
  const [studyFinishing, setStudyFinishing] = useState(false);
  const sessionIds = useRef<string[]>([]);
  const shownAt = useRef(0);
  const reviewWrites = useRef(createSerialTaskQueue());
  const { address, chainId, isConnected } = useAccount();
  const { connectors, connectAsync } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();
  const loggedIn = Boolean(address && sessionAddress && address.toLowerCase() === sessionAddress);
  const selectedChapter = chapters.find((chapter) => chapter.chapterId === selectedChapterId) ?? null;
  const chapterStudyCards = useMemo(() => {
    if (!detail) return [];
    const cards = new Map(detail.cards.map((card) => [card.id, card]));
    return detail.queue.flatMap((id) => {
      const card = cards.get(id);
      return card ? [card] : [];
    });
  }, [detail]);
  const selectedStudyCards: StudyCard[] = studyScope === "project"
    ? projectStudy?.queue ?? []
    : chapterStudyCards;
  const studyCards = studyActive ? sessionCards : selectedStudyCards;
  const currentStudyCard = studyCards[studyIndex] ?? null;

  useEffect(() => {
    fetch("/api/auth/session")
      .then((response) => response.ok ? response.json() : null)
      .then((body: { session?: { address?: string } } | null) => setSessionAddress(body?.session?.address ?? null))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!loggedIn || selectedProjectId) return;
    let active = true;
    void fetch("/api/projects").then((response) => parseApi<ProjectListResponse>(response))
      .then((response) => { if (active) setProjects(response.projects); })
      .catch((error: unknown) => { if (active) setDataError(error instanceof Error ? error.message : "项目加载失败"); })
      .finally(() => { if (active) setProjectsLoading(false); });
    return () => { active = false; };
  }, [loggedIn, selectedProjectId, refreshToken]);

  useEffect(() => {
    if (!loggedIn || !selectedProjectId) return;
    let active = true;
    void fetch(`/api/projects/${selectedProjectId}`).then((response) => parseApi<ProjectSummary>(response))
      .then((response) => { if (active) setProjectSummary(response); })
      .catch((error: unknown) => { if (active) setDataError(error instanceof Error ? error.message : "项目加载失败"); })
      .finally(() => { if (active) setProjectLoading(false); });
    return () => { active = false; };
  }, [loggedIn, selectedProjectId, refreshToken]);

  useEffect(() => {
    if (!loggedIn || !selectedProjectId) return;
    let active = true;
    void fetch(`/api/projects/${selectedProjectId}/chapters`).then((response) => parseApi<ChapterListResponse>(response))
      .then((response) => { if (active) setChapters(response.chapters); })
      .catch((error: unknown) => { if (active) setDataError(error instanceof Error ? error.message : "章节加载失败"); })
      .finally(() => { if (active) setChaptersLoading(false); });
    return () => { active = false; };
  }, [loggedIn, selectedProjectId, refreshToken]);

  useEffect(() => {
    if (!loggedIn || !selectedProjectId || selectedChapterId !== null) return;
    let active = true;
    void fetch(`/api/projects/${selectedProjectId}/study`).then((response) => parseApi<ProjectStudyResponse>(response))
      .then((response) => { if (active) setProjectStudy(response); })
      .catch((error: unknown) => { if (active) setDataError(error instanceof Error ? error.message : "今日复习加载失败"); })
      .finally(() => { if (active) setProjectStudyLoading(false); });
    return () => { active = false; };
  }, [loggedIn, selectedProjectId, selectedChapterId, refreshToken]);

  useEffect(() => {
    if (!loggedIn || !selectedProjectId || selectedChapterId === null) return;
    let active = true;
    void fetch(`/api/projects/${selectedProjectId}/chapters/${selectedChapterId}`).then((response) => parseApi<ChapterStudyResponse>(response))
      .then((response) => { if (active) setDetail(response); })
      .catch((error: unknown) => { if (active) setDataError(error instanceof Error ? error.message : "知识卡加载失败"); })
      .finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [loggedIn, selectedProjectId, selectedChapterId, refreshToken]);

  useEffect(() => {
    if (
      !loggedIn ||
      !selectedProjectId ||
      !projectSummary ||
      projectSummary.status === "READY" ||
      projectSummary.status === "CANCELLED"
    ) return;
    const timer = window.setInterval(() => setRefreshToken((value) => value + 1), 5_000);
    return () => window.clearInterval(timer);
  }, [loggedIn, projectSummary, selectedProjectId]);

  async function signIn(walletAddress: string, walletChainId: number | undefined) {
    if (walletChainId !== monadChain.id) await switchChainAsync({ chainId: monadChain.id });
    const nonce = await parseApi<AuthNonceResponse>(await fetch("/api/auth/nonce", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: walletAddress }),
    }));
    const message = new SiweMessage({
      domain: nonce.domain,
      address: walletAddress,
      statement: "Sign in to Mindmark",
      uri: nonce.uri,
      version: "1",
      chainId: nonce.chainId,
      nonce: nonce.nonce,
      issuedAt: new Date().toISOString(),
      expirationTime: nonce.expiresAt,
    }).prepareMessage();
    const signature = await signMessageAsync({ message });
    const verified = await parseApi<AuthVerifyResponse>(await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, signature }),
    }));
    setSessionAddress(verified.address.toLowerCase());
  }

  async function handleAuth() {
    setAuthBusy(true);
    setAuthError(null);
    try {
      if (loggedIn) {
        await fetch("/api/auth/logout", { method: "POST" });
        setSessionAddress(null);
        await disconnectAsync();
        router.push("/learn");
        return;
      }
      if (isConnected && address) {
        await signIn(address, chainId);
        return;
      }
      const connector = connectors[0];
      if (!connector) throw new Error("未检测到浏览器钱包");
      const connection = await connectAsync({ connector, chainId: monadChain.id });
      await signIn(connection.accounts[0], connection.chainId);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "钱包登录失败");
    } finally {
      setAuthBusy(false);
    }
  }

  function startStudy(scope: "project" | "chapter") {
    const cards = scope === "project" ? projectStudy?.queue ?? [] : chapterStudyCards;
    if (cards.length === 0) return;
    sessionIds.current = createPersistedReviewSessionIds(cards.length, () => crypto.randomUUID());
    reviewWrites.current = createSerialTaskQueue();
    shownAt.current = Date.now();
    setStudyIndex(0);
    setAnswerVisible(false);
    setStudyDone(false);
    setStudyFinishing(false);
    setSessionCards(cards);
    setStudyScope(scope);
    setStudyActive(true);
  }

  function exitStudy() {
    setStudyActive(false);
    setStudyScope(null);
  }

  function refreshData() {
    setDataError(null);
    setProjectsLoading(true);
    setProjectLoading(true);
    setChaptersLoading(true);
    setDetailLoading(true);
    setProjectStudyLoading(true);
    setRefreshToken((value) => value + 1);
  }

  async function rateCard(rating: "again" | "hard" | "good" | "easy") {
    if (!selectedProjectId || !currentStudyCard || sessionIds.current.length === 0) return;
    const ratedCard = currentStudyCard;
    const activeSessionId = persistedReviewSessionIdForCard(sessionIds.current, studyIndex);
    const completesPersistedSession = (studyIndex + 1) % MAX_CARDS_PER_PERSISTED_REVIEW_SESSION === 0
      || studyIndex + 1 === studyCards.length;
    const chapterId = studyScope === "project" && "chapterId" in ratedCard
      ? ratedCard.chapterId
      : selectedChapterId;
    if (chapterId === null) return;
    const responseMs = Math.min(3_600_000, Date.now() - shownAt.current);
    const reviewedAt = new Date().toISOString();
    const reviewScope = studyScope === "project" ? "PROJECT" : "CHAPTER";
    setRatingBusy(true);
    setDataError(null);
    const persistence = reviewWrites.current.enqueue(async () => {
      await parseApi<SubmitReviewResponse>(await fetch(
        `/api/projects/${selectedProjectId}/chapters/${chapterId}/reviews`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: activeSessionId,
            cardId: ratedCard.id,
            rating,
            responseMs,
            reviewedAt,
            scope: reviewScope,
          }),
        },
      ));
      if (completesPersistedSession) {
        await parseApi(await fetch(`/api/projects/${selectedProjectId}/sessions/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: activeSessionId }),
        }));
      }
    });

    if (studyIndex + 1 < studyCards.length) {
      setStudyIndex((value) => value + 1);
      setAnswerVisible(false);
      shownAt.current = Date.now();
      setRatingBusy(false);
      void persistence.catch((error: unknown) => {
        setDataError(error instanceof Error ? `上一张卡评分保存失败：${error.message}` : "上一张卡评分保存失败");
      });
      return;
    }

    setStudyDone(true);
    setStudyFinishing(true);
    try {
      await persistence;
      await reviewWrites.current.onIdle();
      setStudyFinishing(false);
      setRefreshToken((value) => value + 1);
    } catch (error) {
      setStudyDone(false);
      setStudyFinishing(false);
      setDataError(error instanceof Error ? error.message : "评分保存失败");
    } finally {
      setRatingBusy(false);
    }
  }

  async function submitCardFeedback(input: CardFeedbackInput) {
    const card = currentStudyCard;
    if (!selectedProjectId || !card) throw new Error("当前知识卡不可用");
    const chapterId = studyScope === "project" && "chapterId" in card
      ? card.chapterId
      : selectedChapterId;
    if (chapterId === null) throw new Error("无法确定知识卡所属章节");
    await parseApi<KnowledgeCardFeedback>(await fetch(`/api/projects/${selectedProjectId}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chapterId, cardId: card.id, ...input }),
    }));
  }

  function renderProjectList() {
    if (projectsLoading) return <LoadingRows count={6} />;
    if (projects.length === 0) {
      return <EmptyState title="还没有项目" detail="上传资料后，项目会显示在这里。" action={
        <button type="button" onClick={() => router.push("/learn/projects/new")} className="command-button command-button-accent"><FilePlus2 className="size-4" />新建项目</button>
      } />;
    }
    return (
      <div className="grid grid-cols-3 gap-4">
        {projects.map((project) => {
          const percent = project.chapterCount
            ? Math.round(project.readyChapterCount * 100 / project.chapterCount)
            : 0;
          return (
            <button key={project.projectId} type="button" onClick={() => router.push(`/learn/projects/${project.projectId}`)} className="group min-h-56 rounded-md border border-[var(--line-strong)] bg-white p-6 text-left transition-[border-color,transform] hover:-translate-y-0.5 hover:border-[var(--ink)]">
              <div className="flex items-start justify-between gap-5">
                <span className="flex size-9 items-center justify-center bg-[var(--paper)] text-[var(--accent)]"><BookOpen className="size-4" /></span>
                <ChevronRight className="size-4 text-[var(--line-strong)] group-hover:text-[var(--ink)]" />
              </div>
              <h2 className="font-display mt-6 line-clamp-2 text-xl font-semibold leading-7">{project.title}</h2>
              <p className={`mt-2 text-xs ${statusTone(project.status)}`}>{projectStatusLabels[project.status] ?? project.status}</p>
              <div className="mt-6 h-1 bg-[var(--line)]"><div className="h-full bg-[var(--accent)]" style={{ width: `${percent}%` }} /></div>
              <div className="mt-3 flex items-center justify-between text-[11px] text-[var(--muted)]">
                <span>{project.readyChapterCount}/{project.chapterCount} 章节</span>
                <span>{project.cardCount} 卡片 · {project.dueCount} 到期</span>
              </div>
            </button>
          );
        })}
      </div>
    );
  }

  function renderProjectPage() {
    if (projectLoading || chaptersLoading || projectStudyLoading || !projectSummary || !projectStudy) {
      return <LoadingRows count={6} />;
    }
    const readyPercent = projectSummary.chapterCount
      ? Math.round(projectSummary.readyChapterCount * 100 / projectSummary.chapterCount)
      : 0;
    return (
      <div className="document-study-layout">
        {renderDocumentChapterRail(null)}
        <section className="document-study-content">
          <div className="document-study-heading">
            <div>
              <p className="section-kicker">PDF 学习资料</p>
              <h1>{projectSummary.title}</h1>
              {projectSummary.goal ? <p>{projectSummary.goal}</p> : null}
            </div>
            <button type="button" onClick={() => startStudy("project")} disabled={projectStudy.queue.length === 0} className="command-button command-button-accent">
              <CalendarCheck2 className="size-4" />{projectStudy.queue.length > 0
                ? `复习 ${projectStudy.queue.length} 张 · ${projectStudy.dueCount} 到期 / ${projectStudy.newCount} 新卡`
                : "今日已完成"}
            </button>
          </div>
          <div className="document-study-metrics">
            <div><strong>{projectSummary.chapterCount}</strong><span>章节</span></div>
            <div><strong>{projectSummary.readyChapterCount}</strong><span>可学习章节</span></div>
            <div><strong>{projectSummary.cardCount}</strong><span>知识卡</span></div>
            <div><strong>{readyPercent}%</strong><span>资料就绪</span></div>
          </div>
          <div className="document-section-heading">
            <div><span>目录</span><h2>章节</h2></div>
            <button type="button" onClick={refreshData} className="icon-button" title="刷新" aria-label="刷新"><RefreshCw className="size-4" /></button>
          </div>
          {chapters.length === 0 ? <EmptyState title="尚未确认章节" detail="请先完成资料结构确认。" /> : (
            <div className="document-chapter-list">
              {chapters.map((chapter) => (
                <button key={chapter.chapterId} type="button" onClick={() => router.push(`/learn/projects/${selectedProjectId}/chapters/${chapter.chapterId}`)} className="document-chapter-row">
                  <span className="document-chapter-number">{String(chapter.position + 1).padStart(2, "0")}</span>
                  <span className="document-chapter-copy"><strong>{chapter.title}</strong><small>{chapter.summary}</small></span>
                  <span className="document-chapter-meta"><b>{chapter.cardCount} 卡片</b><small>{chapter.dueCount ? `${chapter.dueCount} 待复习` : chapterStatusLabels[chapter.status] ?? chapter.status}</small></span>
                  <span className="document-chapter-progress"><i><b style={{ width: `${chapter.progressPercent}%` }} /></i><small>{chapter.progressPercent}%</small></span>
                  <ChevronRight />
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    );
  }

  function renderDocumentChapterRail(activeChapterId: number | null) {
    if (!projectSummary) return null;
    return (
      <aside className="document-chapter-rail">
        <button type="button" className="document-back-library" onClick={() => router.push("/learn")}><ArrowLeft />资料库</button>
        <div className="document-rail-file"><span><FileText /></span><div><strong>{projectSummary.title}</strong><small>{projectSummary.chapterCount} 章节 · {projectSummary.cardCount} 知识卡</small></div></div>
        <nav aria-label="资料章节">
          <button type="button" data-active={activeChapterId === null} onClick={() => router.push(`/learn/projects/${selectedProjectId}`)}><BookOpen /><span>资料概览</span></button>
          {chapters.map((chapter) => (
            <button key={chapter.chapterId} type="button" data-active={activeChapterId === chapter.chapterId} onClick={() => router.push(`/learn/projects/${selectedProjectId}/chapters/${chapter.chapterId}`)}>
              <b>{String(chapter.position + 1).padStart(2, "0")}</b><span>{chapter.title}</span>{chapter.status === "READY" ? <i /> : null}
            </button>
          ))}
        </nav>
        <div className="document-rail-status"><span className={statusTone(projectSummary.status)}>{projectStatusLabels[projectSummary.status]}</span><button type="button" onClick={refreshData} title="刷新状态" aria-label="刷新状态"><RefreshCw /></button></div>
      </aside>
    );
  }

  function renderChapterPage() {
    if (projectLoading || chaptersLoading || detailLoading || !projectSummary || !selectedChapter || !detail) {
      return <LoadingRows count={6} />;
    }
    return (
      <div className="document-study-layout">
        {renderDocumentChapterRail(selectedChapter.chapterId)}
        <section className="document-study-content">
        <div className="document-study-heading">
          <div className="max-w-3xl">
            <p className="section-kicker">Chapter {String(selectedChapter.position + 1).padStart(2, "0")}</p>
            <h1>{selectedChapter.title}</h1>
            <p>{selectedChapter.summary}</p>
          </div>
          {detail.status === "READY" ? (
            <button type="button" onClick={() => startStudy("chapter")} disabled={chapterStudyCards.length === 0} className="command-button command-button-accent shrink-0">
              <BookOpen className="size-4" />{chapterStudyCards.length > 0
                ? `复习 ${chapterStudyCards.length} 张 · ${detail.dueCount} 到期 / ${detail.newCount} 新卡`
                : "今日已完成"}
            </button>
          ) : null}
        </div>
        <div className="document-study-metrics">
          <div><strong>{detail.cards.length}</strong><span>知识卡</span></div>
          <div><strong>{detail.dueCount}</strong><span>到期复习</span></div>
          <div><strong>{selectedChapter.masteredCount}</strong><span>已掌握</span></div>
          <div><strong>{selectedChapter.progressPercent}%</strong><span>学习进度</span></div>
        </div>
        {detail.status !== "READY" ? (
          <div className="flex min-h-80 flex-col items-center justify-center text-center">
            <Sparkles className="size-7 text-[var(--accent)]" />
            <h2 className="font-display mt-5 text-xl font-semibold">{chapterStatusLabels[detail.status]}</h2>
            <button type="button" onClick={refreshData} className="command-button command-button-quiet mt-6"><RefreshCw className="size-4" />刷新状态</button>
          </div>
        ) : (
          <div className="document-knowledge-section">
            <div className="document-section-heading"><div><span>第 {selectedChapter.pageStart}–{selectedChapter.pageEnd} 页</span><h2>知识卡</h2></div></div>
            <div className="document-card-list">
              {detail.cards.map((card) => (
                <article key={card.id} className="grid grid-cols-[48px_minmax(0,1fr)_120px] items-start gap-4 px-6 py-6">
                  <span className="font-mono text-[10px] text-[var(--muted)]">{String(card.position + 1).padStart(2, "0")}</span>
                  <div className="min-w-0"><h3 className="text-sm font-semibold leading-6">{card.question}</h3><p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--muted)]">{card.keyPoint}</p></div>
                  <span className={`w-fit text-[10px] font-bold ${card.state === "DUE" ? "text-[var(--danger)]" : card.state === "NEW" ? "text-[var(--accent)]" : "text-[var(--muted)]"}`}>{cardTypeLabels[card.type]} · {cardStateLabels[card.state]}</span>
                </article>
              ))}
            </div>
          </div>
        )}
        </section>
      </div>
    );
  }

  let content: React.ReactNode;
  if (studyActive) {
    content = (
      <StudySessionView
        scope={studyScope ?? "chapter"}
        cards={studyCards}
        currentCard={currentStudyCard}
        studyIndex={studyIndex}
        answerVisible={answerVisible}
        ratingBusy={ratingBusy}
        studyDone={studyDone}
        studyFinishing={studyFinishing}
        onExit={exitStudy}
        onReveal={() => setAnswerVisible(true)}
        onRate={(rating) => void rateCard(rating)}
        onFeedback={submitCardFeedback}
      />
    );
  } else if (!selectedProjectId) {
    content = (
      <>
        <div className="mb-9 flex items-end justify-between border-b border-[var(--line-strong)] pb-7">
          <div><p className="section-kicker">Projects</p><h1 className="font-display mt-3 text-4xl font-semibold">学习项目</h1></div>
          <button type="button" onClick={() => router.push("/learn/projects/new")} className="command-button command-button-accent"><FilePlus2 className="size-4" />新建项目</button>
        </div>
        {renderProjectList()}
      </>
    );
  } else if (selectedChapterId === null) {
    content = renderProjectPage();
  } else {
    content = renderChapterPage();
  }

  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--ink)]">
      <header className="sticky top-0 z-30 border-b border-[var(--line-strong)] bg-[var(--background)]/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-8">
          <button type="button" onClick={() => router.push("/learn")} className="flex min-w-0 items-center gap-3 text-left">
            <span className="flex size-9 shrink-0 items-center justify-center bg-[var(--ink)] text-[#b8e265]"><BookOpen className="size-4" /></span>
            <span className="min-w-0"><strong className="block truncate font-display text-base">Mindmark</strong><span className="block text-[10px] font-semibold uppercase text-[var(--muted)]">Learning workspace</span></span>
          </button>
          <div className="flex items-center gap-2">
            {loggedIn ? (
              <>
                <button type="button" onClick={() => router.push("/learn/projects/new")} className="icon-button" title="新建项目" aria-label="新建项目"><FilePlus2 className="size-4" /></button>
              </>
            ) : null}
            <button type="button" onClick={() => void handleAuth()} disabled={authBusy} className="command-button command-button-dark">
              {authBusy ? <LoaderCircle className="size-4 animate-spin" /> : loggedIn ? <LogOut className="size-4" /> : <Wallet className="size-4" />}
              {loggedIn && address ? shortAddress(address) : isConnected ? "完成登录" : "连接并登录"}
            </button>
          </div>
        </div>
      </header>

      {authError ? <div className="border-b border-[var(--danger)] bg-[var(--danger-soft)] px-8 py-3 text-sm text-[var(--danger)]">{authError}</div> : null}
      {dataError ? (
        <div className="flex items-center justify-between gap-4 border-b border-[var(--danger)] bg-[var(--danger-soft)] px-8 py-3 text-sm text-[var(--danger)]">
          <span className="flex min-w-0 items-center gap-2"><CircleAlert className="size-4 shrink-0" />{dataError}</span>
          <button type="button" onClick={refreshData} className="icon-button size-8" title="重试" aria-label="重试"><RefreshCw className="size-3.5" /></button>
        </div>
      ) : null}

      {!loggedIn ? (
        <div className="mx-auto max-w-7xl px-8 py-28">
          <p className="section-kicker">Your knowledge library</p>
          <h1 className="font-display mt-3 max-w-2xl text-5xl font-semibold">从项目进入章节，再开始专注复习</h1>
        </div>
      ) : (
        <div className={selectedProjectId && !studyActive ? "project-document-frame" : "mx-auto max-w-7xl px-8 py-10"}>{content}</div>
      )}
    </main>
  );
}
