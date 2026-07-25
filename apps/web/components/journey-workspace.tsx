"use client";

import {
  ArrowLeft,
  BookOpen,
  Check,
  CircleAlert,
  ExternalLink,
  Eye,
  EyeOff,
  Keyboard,
  LoaderCircle,
  LogOut,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  learningJourneyRegistryAbi,
  type CompleteSessionResponse,
  type JourneyDetailResponse,
  type ReviewRatingSchema,
} from "@mindmark/shared";
import { JourneyDetailResponseSchema } from "@mindmark/shared/schemas";
import { usePublicClient } from "wagmi";
import { z } from "zod";
import { formatEther } from "viem";
import { monadChain, registryAddress } from "@/lib/client/chain";
import { buildStudyChapters } from "@/lib/client/chapters";
import {
  verifyDeckAgainstChain,
  type DeckVerification,
} from "@/lib/client/verification";

type ReviewRating = z.infer<typeof ReviewRatingSchema>;
type ApiErrorBody = { error?: { message?: string } };

const statusLabels: Record<JourneyDetailResponse["chunks"][number]["status"], string> = {
  QUEUED: "等待",
  GENERATING: "Agent 生成",
  VALIDATING: "引用校验",
  SAVED: "结果已保存",
  SUBMITTING: "Monad 提交",
  CONFIRMED: "已确认",
  MERGED: "已合并",
  RETRYABLE: "等待重试",
};

const rewardStatusLabels: Record<JourneyDetailResponse["rewards"][number]["status"], string> = {
  PENDING: "等待 Moss",
  PROCESSING: "Moss 处理中",
  PREPARED: "模拟通过",
  SUBMITTING: "奖励提交",
  CONFIRMED: "已发放",
  RETRYABLE: "等待重试",
  BLOCKED: "已阻断",
};

const rewardStageLabels: Record<JourneyDetailResponse["rewards"][number]["mossStage"], string> = {
  PENDING: "等待资格",
  DISCOVERED: "已发现",
  LOADED: "已加载",
  BUILT: "已构建",
  SIMULATED: "已模拟",
};

const mossStages = ["DISCOVERED", "LOADED", "BUILT", "SIMULATED"] as const;

const ratingLabels: Array<{ rating: ReviewRating; label: string; className: string }> = [
  { rating: "again", label: "忘记", className: "rating-again" },
  { rating: "hard", label: "困难", className: "rating-hard" },
  { rating: "good", label: "记得", className: "rating-good" },
  { rating: "easy", label: "熟练", className: "rating-easy" },
];

async function parseResponse<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & ApiErrorBody;
  if (!response.ok) throw new Error(body.error?.message ?? "请求失败");
  return body;
}

function shortHex(value: string | null, head = 6): string {
  return value ? `${value.slice(0, head)}...${value.slice(-4)}` : "-";
}

function explorerTransaction(hash: string): string {
  return `${monadChain.blockExplorers.default.url}/tx/${hash}`;
}

function clockMs(): number {
  return Date.now();
}

function isoNow(): string {
  return new Date().toISOString();
}

export function JourneyWorkspace(props: {
  journeyId: `0x${string}`;
  address: string | null;
  onNew: () => void;
  onSignOut: () => Promise<void>;
}) {
  const publicClient = usePublicClient({ chainId: monadChain.id });
  const [detail, setDetail] = useState<JourneyDetailResponse | null>(null);
  const [tab, setTab] = useState<"progress" | "study">("progress");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verification, setVerification] = useState<DeckVerification | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null);
  const [reviewedCardIds, setReviewedCardIds] = useState<`0x${string}`[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sessionResult, setSessionResult] = useState<CompleteSessionResponse | null>(null);
  const initialTabSelected = useRef(false);
  const workspaceStateLoaded = useRef(false);
  const readyStateSeen = useRef(false);
  const sessionId = useRef<string | null>(null);
  const cardStartedAt = useRef(clockMs());

  const loadDetail = useCallback(async () => {
    try {
      const response = await fetch(`/api/journeys/${props.journeyId}`, { cache: "no-store" });
      const parsed = JourneyDetailResponseSchema.parse(
        await parseResponse<JourneyDetailResponse>(response),
      );
      if (!initialTabSelected.current) {
        initialTabSelected.current = true;
        let savedTab: "progress" | "study" | null = null;
        let savedChapterId: string | null = null;
        try {
          const saved = window.localStorage.getItem(`mindmark_workspace:${props.journeyId}`);
          if (saved) {
            const state = JSON.parse(saved) as { tab?: unknown; chapterId?: unknown };
            if (state.tab === "progress" || state.tab === "study") savedTab = state.tab;
            if (typeof state.chapterId === "string") savedChapterId = state.chapterId;
          }
        } catch {
          // A malformed local preference should never block opening a Journey.
        }
        setTab(parsed.status === "READY" && savedTab !== "progress" ? "study" : "progress");
        if (savedChapterId) setSelectedChapterId(savedChapterId);
        workspaceStateLoaded.current = true;
      }
      if (parsed.status === "READY") {
        if (!readyStateSeen.current) {
          readyStateSeen.current = true;
          cardStartedAt.current = clockMs();
        }
      } else {
        readyStateSeen.current = false;
      }
      setDetail(parsed);
      setError(null);
      return parsed;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "学习项目读取失败");
      return null;
    } finally {
      setLoading(false);
    }
  }, [props.journeyId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadDetail(), 0);
    return () => window.clearTimeout(timer);
  }, [loadDetail]);

  useEffect(() => {
    if (
      !detail ||
      (["READY", "CANCELLED"].includes(detail.status) &&
        !detail.rewards.some((reward) => !["CONFIRMED", "BLOCKED"].includes(reward.status)))
    ) return;
    const timer = window.setInterval(() => void loadDetail(), 3_000);
    return () => window.clearInterval(timer);
  }, [detail, loadDetail]);

  useEffect(() => {
    if (!workspaceStateLoaded.current) return;
    try {
      window.localStorage.setItem(
        `mindmark_workspace:${props.journeyId}`,
        JSON.stringify({ tab, chapterId: selectedChapterId }),
      );
    } catch {
      // Persistence is a convenience; private browsing must not break study.
    }
  }, [props.journeyId, selectedChapterId, tab]);

  const studyChapters = useMemo(
    () =>
      detail
        ? buildStudyChapters({
            chunks: detail.chunks,
            deck: detail.deck,
            studiedCardIds: detail.studiedCardIds,
            studyQueue: detail.studyQueue,
          })
        : [],
    [detail],
  );
  const reviewedCardIdSet = useMemo(() => new Set(reviewedCardIds), [reviewedCardIds]);
  const defaultChapter =
    studyChapters.find((chapter) => chapter.queue.length > 0) ?? studyChapters[0] ?? null;
  const activeChapter =
    studyChapters.find((chapter) => chapter.id === selectedChapterId) ?? defaultChapter;
  const activeItem =
    activeChapter?.queue.find((item) => !reviewedCardIdSet.has(item.card.id)) ?? null;
  const reviewedCount = reviewedCardIds.length;
  const totalStudyCards = detail?.studyQueue?.queue.length ?? 0;
  const allReviewed = Boolean(
    detail?.studyQueue &&
      detail.studyQueue.queue.length > 0 &&
      reviewedCount >= detail.studyQueue.queue.length,
  );
  const activeChapterTodayDone = activeChapter
    ? activeChapter.queue.filter((item) => reviewedCardIdSet.has(item.card.id)).length
    : 0;
  const learnedCardIdSet = useMemo(
    () => new Set([...(detail?.studiedCardIds ?? []), ...reviewedCardIds]),
    [detail?.studiedCardIds, reviewedCardIds],
  );
  const activeChapterStudied = activeChapter
    ? activeChapter.cards.filter((card) => learnedCardIdSet.has(card.id)).length
    : 0;
  const nextPendingChapter = activeChapter
    ? studyChapters.find(
        (chapter) =>
          chapter.id !== activeChapter.id &&
          chapter.queue.some((item) => !reviewedCardIdSet.has(item.card.id)),
      ) ?? null
    : null;

  async function verifyDeck() {
    if (!detail || !registryAddress || !publicClient) {
      setVerification({
        result: "无法验证：缺少数据",
        deckMatches: false,
        cardMatches: {},
        chunkMatches: {},
      });
      return;
    }
    const contractAddress = registryAddress;
    setVerifying(true);
    setError(null);
    try {
      const [journey, chunks] = await Promise.all([
        publicClient.readContract({
          address: contractAddress,
          abi: learningJourneyRegistryAbi,
          functionName: "journeys",
          args: [detail.journeyId],
        }),
        Promise.all(
          detail.chunks.map(async (chunk) => {
            const value = await publicClient.readContract({
              address: contractAddress,
              abi: learningJourneyRegistryAbi,
              functionName: "chunks",
              args: [detail.journeyId, chunk.chunkId],
            });
            return {
              chunkId: chunk.chunkId,
              sourceChunkHash: value[0],
              cardsRoot: value[1],
              agent: value[2],
              cardCount: value[4],
            };
          }),
        ),
      ]);
      setVerification(
        verifyDeckAgainstChain({
          detail,
          journey: {
            status: journey[8],
            sourceHash: journey[1],
            deckRoot: journey[4],
            totalCardCount: journey[7],
          },
          chunks,
        }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "链上验证失败");
      setVerification({
        result: "无法验证：缺少数据",
        deckMatches: false,
        cardMatches: {},
        chunkMatches: {},
      });
    } finally {
      setVerifying(false);
    }
  }

  const completeSession = useCallback(async () => {
    if (!sessionId.current) return;
    const result = await parseResponse<CompleteSessionResponse>(
      await fetch(`/api/journeys/${props.journeyId}/sessions/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessionId.current }),
      }),
    );
    setSessionResult(result);
    await loadDetail();
  }, [loadDetail, props.journeyId]);

  const rateCard = useCallback(async (rating: ReviewRating) => {
    if (!activeItem || submitting) return;
    sessionId.current ??= window.crypto.randomUUID();
    setSubmitting(true);
    setError(null);
    try {
      await parseResponse(
        await fetch(`/api/journeys/${props.journeyId}/reviews`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: sessionId.current,
            cardId: activeItem.card.id,
            rating,
            responseMs: Math.max(0, clockMs() - cardStartedAt.current),
            reviewedAt: isoNow(),
          }),
        }),
      );
      const nextReviewedCardIds = reviewedCardIdSet.has(activeItem.card.id)
        ? reviewedCardIds
        : [...reviewedCardIds, activeItem.card.id];
      const nextReviewedCardIdSet = new Set(nextReviewedCardIds);
      setReviewedCardIds(nextReviewedCardIds);
      setRevealed(false);
      cardStartedAt.current = clockMs();
      if (detail?.studyQueue && nextReviewedCardIds.length >= detail.studyQueue.queue.length) {
        await completeSession();
      } else if (
        activeChapter &&
        !activeChapter.queue.some((item) => !nextReviewedCardIdSet.has(item.card.id))
      ) {
        const currentIndex = studyChapters.findIndex((chapter) => chapter.id === activeChapter.id);
        const orderedChapters = [
          ...studyChapters.slice(currentIndex + 1),
          ...studyChapters.slice(0, currentIndex),
        ];
        const nextChapter = orderedChapters.find((chapter) =>
          chapter.queue.some((item) => !nextReviewedCardIdSet.has(item.card.id)),
        );
        if (nextChapter) setSelectedChapterId(nextChapter.id);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "复习记录提交失败");
    } finally {
      setSubmitting(false);
    }
  }, [activeChapter, activeItem, completeSession, detail, props.journeyId, reviewedCardIdSet, reviewedCardIds, studyChapters, submitting]);

  useEffect(() => {
    if (tab !== "study") return;

    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT"
      ) return;
      if (!activeItem || submitting) return;

      if (!revealed && (event.key === " " || event.key === "Enter")) {
        event.preventDefault();
        sessionId.current ??= window.crypto.randomUUID();
        setRevealed(true);
        return;
      }

      if (!revealed) return;
      const ratingByKey: Record<string, ReviewRating> = {
        "1": "again",
        "2": "hard",
        "3": "good",
        "4": "easy",
      };
      const rating = ratingByKey[event.key];
      if (!rating) return;
      event.preventDefault();
      void rateCard(rating);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeItem, rateCard, revealed, submitting, tab]);

  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--ink)]">
      <header className="border-b border-[var(--line)] bg-white">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-5 md:px-8">
          <div className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-md bg-[var(--ink)] text-white">
              <BookOpen aria-hidden="true" className="size-5" />
            </span>
            <div>
              <p className="font-display text-lg font-semibold leading-none">Mindmark</p>
              <p className="mt-1 font-mono text-[11px] text-[var(--muted)]">
                {shortHex(props.journeyId, 10)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={props.onNew} className="command-button command-button-quiet">
              <ArrowLeft aria-hidden="true" className="size-4" />
              返回首页
            </button>
            <span className="hidden font-mono text-xs text-[var(--muted)] md:inline">
              {props.address ? shortHex(props.address) : "已登录"}
            </span>
            <button
              type="button"
              onClick={() => void props.onSignOut()}
              className="icon-button"
              aria-label="退出登录"
              title="退出登录"
            >
              <LogOut aria-hidden="true" className="size-4" />
            </button>
          </div>
        </div>
      </header>

      <div className="border-b border-[var(--line)] bg-white">
        <div className="mx-auto flex w-full max-w-7xl items-end justify-between gap-5 px-5 pt-7 md:px-8">
          <div className="pb-5">
            <p className="section-kicker">Learning Journey</p>
            <h1 className="font-display mt-2 text-3xl font-semibold">知识卡工作台</h1>
          </div>
          <div className="workspace-tabs" role="tablist" aria-label="学习项目视图">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "progress"}
              aria-controls="journey-progress-panel"
              data-active={tab === "progress"}
              onClick={() => setTab("progress")}
            >
              生成与验证
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "study"}
              aria-controls="journey-study-panel"
              data-active={tab === "study"}
              onClick={() => setTab("study")}
              disabled={detail?.status !== "READY"}
            >
              今日学习
            </button>
          </div>
        </div>
      </div>

      {error ? (
        <div className="mx-auto mt-5 flex w-[calc(100%-40px)] max-w-7xl items-start gap-3 border-l-2 border-[var(--danger)] bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
          <button type="button" onClick={() => void loadDetail()} className="ml-auto font-semibold">重试</button>
        </div>
      ) : null}

      {loading && !detail ? (
        <div className="flex min-h-[55vh] items-center justify-center text-[var(--muted)]">
          <LoaderCircle aria-hidden="true" className="size-5 animate-spin" />
        </div>
      ) : detail && tab === "progress" ? (
        <div id="journey-progress-panel" role="tabpanel" aria-label="生成与验证" className="mx-auto w-full max-w-7xl px-5 py-7 md:px-8 md:py-9">
          <section className="mb-8 grid gap-0 border-y border-[var(--line)] bg-white md:grid-cols-5">
            <div className="metric-cell"><span>状态</span><strong>{detail.status}</strong></div>
            <div className="metric-cell"><span>Worker</span><strong>{detail.chunks.filter((chunk) => chunk.workerAddress).length} / {detail.chunks.length}</strong></div>
            <div className="metric-cell"><span>知识卡</span><strong>{detail.deck?.length ?? detail.chunks.reduce((sum, chunk) => sum + (chunk.cardCount ?? 0), 0)}</strong></div>
            <div className="metric-cell"><span>Monad 卡组</span><strong>{detail.finalizeTxHash ? "已确认" : "等待"}</strong></div>
            <div className="metric-cell"><span>Moss 奖励</span><strong>{detail.rewards.filter((reward) => reward.status === "CONFIRMED").length} / {detail.rewards.length || detail.chunks.length}</strong></div>
          </section>

          <section>
            <div className="mb-4 flex items-center justify-between">
              <div><p className="section-kicker">Parallel Agents</p><h2 className="font-display mt-1 text-xl font-semibold">分段执行记录</h2></div>
              <button type="button" onClick={() => void loadDetail()} className="icon-button" aria-label="刷新状态" title="刷新状态"><RefreshCw aria-hidden="true" className="size-4" /></button>
            </div>
            <div className="overflow-x-auto border-y border-[var(--line)] bg-white">
              <table className="progress-table">
                <thead><tr><th>章节</th><th>Worker</th><th>状态</th><th>卡片</th><th>交易</th><th>区块</th><th>Gas</th><th>确认</th><th>Moss 奖励</th></tr></thead>
                <tbody>
                  {detail.chunks.map((chunk) => (
                    <tr key={chunk.chunkId}>
                      <td><strong>{chunk.title}</strong><span>P.{chunk.pageStart}-{chunk.pageEnd}</span></td>
                      <td className="font-mono">{shortHex(chunk.workerAddress)}</td>
                      <td><span className={`status-chip status-${chunk.status.toLowerCase()}`}>{statusLabels[chunk.status]}</span></td>
                      <td className="font-mono">{chunk.cardCount ?? "-"}</td>
                      <td>{chunk.commitTxHash ? <a href={explorerTransaction(chunk.commitTxHash)} target="_blank" rel="noreferrer" className="inline-link">{shortHex(chunk.commitTxHash)}<ExternalLink aria-hidden="true" className="size-3" /></a> : "-"}</td>
                      <td className="font-mono">{chunk.confirmedBlock ?? "-"}</td>
                      <td className="font-mono">{chunk.gasUsed ? Number(chunk.gasUsed).toLocaleString() : "-"}</td>
                      <td className="font-mono">{chunk.confirmationMs === null ? "-" : `${chunk.confirmationMs} ms`}</td>
                      <td>
                        {(() => {
                          const reward = detail.rewards.find((candidate) => candidate.chunkId === chunk.chunkId);
                          if (!reward) return <span className="text-[var(--muted)]">等待 Chunk 确认</span>;
                          return (
                            <div className="reward-cell">
                              <span className={`status-chip status-${reward.status.toLowerCase()}`}>
                                {reward.status === "PROCESSING" ? `Moss ${rewardStageLabels[reward.mossStage]}` : rewardStatusLabels[reward.status]}
                              </span>
                              <span>{formatEther(BigInt(reward.amountWei))} MON</span>
                              {reward.txHash ? <a href={explorerTransaction(reward.txHash)} target="_blank" rel="noreferrer" className="inline-link">{shortHex(reward.txHash)}<ExternalLink aria-hidden="true" className="size-3" /></a> : null}
                            </div>
                          );
                        })()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-10">
            <div className="mb-4">
              <p className="section-kicker">Moss Settlement</p>
              <h2 className="font-display mt-1 text-xl font-semibold">Worker 奖励验证</h2>
            </div>
            <div className="moss-settlement-list">
              {detail.chunks.map((chunk) => {
                const reward = detail.rewards.find((candidate) => candidate.chunkId === chunk.chunkId);
                const reachedStage = reward ? mossStages.indexOf(
                  reward.mossStage as (typeof mossStages)[number],
                ) : -1;
                return (
                  <div className="moss-settlement-row" key={chunk.chunkId}>
                    <div className="moss-settlement-identity">
                      <span>Chunk {chunk.chunkId + 1}</span>
                      <strong>erc20.transfer</strong>
                      <small>{reward ? `${formatEther(BigInt(reward.amountWei))} MON` : "等待资格"}</small>
                    </div>
                    <div className="moss-stage-track" aria-label={`Chunk ${chunk.chunkId + 1} Moss 阶段`}>
                      {mossStages.map((stage, stageIndex) => (
                        <span
                          className="moss-stage"
                          data-complete={stageIndex <= reachedStage}
                          data-blocked={reward?.status === "BLOCKED" && stageIndex === Math.max(reachedStage, 0)}
                          key={stage}
                        >
                          {rewardStageLabels[stage]}
                        </span>
                      ))}
                    </div>
                    <dl className="moss-evidence">
                      <div><dt>Plan</dt><dd className="font-mono">{shortHex(reward?.mossPlanHash ?? null)}</dd></div>
                      <div><dt>Warnings</dt><dd className="font-mono">{reward?.simulationWarningCodes.length ?? "-"}</dd></div>
                      <div><dt>Sim Gas</dt><dd className="font-mono">{reward?.simulationGas ? Number(reward.simulationGas).toLocaleString() : "-"}</dd></div>
                      <div><dt>Result</dt><dd>{reward ? rewardStatusLabels[reward.status] : "等待"}</dd></div>
                    </dl>
                    {reward?.status === "BLOCKED" ? (
                      <p className="moss-settlement-reason moss-settlement-reason-danger">
                        安全模拟未通过，奖励不会发送；这不会影响你的学习内容。
                      </p>
                    ) : reward?.status === "RETRYABLE" ? (
                      <p className="moss-settlement-reason">
                        网络或余额暂时不可用，系统会自动重试；这不会影响你的学习内容。
                      </p>
                    ) : reward?.lastError ? (
                      <p className="moss-settlement-reason">结算遇到暂时问题，系统会继续处理。</p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="mt-10">
            <div className="mb-4"><p className="section-kicker">Commitment Check</p><h2 className="font-display mt-1 text-xl font-semibold">卡组验证</h2></div>
            <div className="verification-panel">
              <div>
                <p className="text-sm font-semibold">{verification?.result ?? (detail.status === "READY" ? "等待验证" : "等待 DeckFinalized")}</p>
                <p className="mt-2 text-sm leading-6 text-[var(--muted)]">Hash 匹配验证卡片未被篡改，不代表知识内容一定正确。</p>
              </div>
              <button type="button" onClick={() => void verifyDeck()} disabled={detail.status !== "READY" || verifying} className="command-button command-button-accent">
                {verifying ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <ShieldCheck aria-hidden="true" className="size-4" />}
                验证卡组
              </button>
            </div>
            {verification ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {detail.chunks.map((chunk) => (
                  <div key={chunk.chunkId} className="verification-row">
                    {verification.chunkMatches[chunk.chunkId] ? <Check aria-hidden="true" className="size-4 text-[var(--accent)]" /> : <CircleAlert aria-hidden="true" className="size-4 text-[var(--danger)]" />}
                    Chunk {chunk.chunkId + 1}
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        </div>
      ) : detail ? (
        <div id="journey-study-panel" role="tabpanel" aria-label="今日学习" className="chapter-study-shell">
          <aside className="study-chapter-rail" aria-label="学习章节">
            <div className="chapter-rail-heading">
              <div>
                <p className="section-kicker">Contents</p>
                <h2 className="font-display mt-1 text-xl font-semibold">章节目录</h2>
              </div>
              <span className="chapter-count">{studyChapters.length} 章</span>
            </div>

            <div className="chapter-today-overview">
              <div>
                <span>今日总进度</span>
                <strong>{reviewedCount} / {totalStudyCards}</strong>
              </div>
              <div className="chapter-progress-track" aria-hidden="true">
                <span
                  style={{
                    width: totalStudyCards > 0 ? `${(reviewedCount / totalStudyCards) * 100}%` : "0%",
                  }}
                />
              </div>
            </div>

            <nav className="chapter-nav">
              {studyChapters.map((chapter, index) => {
                const todayDone = chapter.queue.filter((item) =>
                  reviewedCardIdSet.has(item.card.id),
                ).length;
                const studiedCount = chapter.cards.filter((card) =>
                  learnedCardIdSet.has(card.id),
                ).length;
                const progress = chapter.cards.length > 0
                  ? (studiedCount / chapter.cards.length) * 100
                  : 0;
                return (
                  <button
                    key={chapter.id}
                    type="button"
                    data-active={chapter.id === activeChapter?.id}
                    data-complete={chapter.cards.length > 0 && studiedCount >= chapter.cards.length}
                    aria-current={chapter.id === activeChapter?.id ? "page" : undefined}
                    onClick={() => {
                      setSelectedChapterId(chapter.id);
                      setRevealed(false);
                      cardStartedAt.current = clockMs();
                    }}
                    className="chapter-nav-item"
                  >
                    <span className="chapter-number">{String(index + 1).padStart(2, "0")}</span>
                    <span className="chapter-nav-copy">
                      <strong>{chapter.title}</strong>
                      <span>P.{chapter.pageStart}–{chapter.pageEnd} · {chapter.cards.length} 张卡</span>
                      <span className="chapter-nav-progress">
                        <i><b style={{ width: `${progress}%` }} /></i>
                        <em>{studiedCount}/{chapter.cards.length}</em>
                      </span>
                      {chapter.queue.length > 0 ? (
                        <span className="chapter-today-count">今日 {todayDone}/{chapter.queue.length}</span>
                      ) : (
                        <span className="chapter-today-count is-clear">今日无待学卡</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </nav>

            <div className="chapter-rail-note">
              到期卡优先，每次最多 15 张。章节只负责组织学习顺序，不改变 FSRS 复习时间。
            </div>
          </aside>

          <section className="chapter-study-main">
            <div className="chapter-study-heading">
              <div>
                <p className="section-kicker">Today&apos;s Study</p>
                <h2 className="font-display mt-2 text-3xl font-semibold">{activeChapter?.title ?? "今日学习"}</h2>
                {activeChapter ? (
                  <p className="mt-2 text-sm text-[var(--muted)]">
                    P.{activeChapter.pageStart}–{activeChapter.pageEnd} · 共 {activeChapter.cards.length} 张卡 · 已学习 {activeChapterStudied} 张
                  </p>
                ) : null}
              </div>
              <div className="chapter-session-stats" aria-label="今日学习队列">
                <div><span>本章今日</span><strong>{activeChapterTodayDone}/{activeChapter?.queue.length ?? 0}</strong></div>
                <div><span>到期</span><strong>{detail.studyQueue?.dueCount ?? 0}</strong></div>
                <div><span>新卡</span><strong>{detail.studyQueue?.newCount ?? 0}</strong></div>
              </div>
            </div>

            {sessionResult || allReviewed ? (
              <div className="study-complete">
                <Check aria-hidden="true" className="size-6" />
                <h3 className="font-display text-2xl font-semibold">本次学习完成</h3>
                <p>{sessionResult?.summary.reviewedCount ?? reviewedCount} 张卡 · {sessionResult?.summary.forgottenCount ?? 0} 张忘记</p>
                <p className="text-sm text-[var(--muted)]">{sessionResult?.planUpdated ? "Learning Coach 已根据本次表现更新学习安排" : "继续使用 FSRS 到期队列"}</p>
              </div>
            ) : activeItem ? (
              <div className="study-card">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <span className="status-chip">{activeItem.reason === "due" ? "到期复习" : "新学习卡"}</span>
                    <span className="chapter-card-position">
                      本章 {activeChapterTodayDone + 1}/{activeChapter?.queue.length ?? 0}
                    </span>
                  </div>
                  <span className="font-mono text-xs text-[var(--muted)]">P.{activeItem.card.source.page}</span>
                </div>
                <div className="study-keyboard-hint" aria-label="键盘操作提示">
                  <Keyboard aria-hidden="true" className="size-3.5" />
                  <span>空格显示答案 · 1–4 评分</span>
                </div>
                <h3 className="font-display mt-8 text-2xl font-semibold leading-relaxed">{activeItem.card.question}</h3>
                {revealed ? (
                  <div className="mt-8 border-t border-[var(--line)] pt-6">
                    <p className="text-base leading-7">{activeItem.card.answer}</p>
                    <p className="mt-5 border-l-2 border-[var(--accent)] pl-4 text-sm italic leading-6 text-[var(--muted)]">“{activeItem.card.source.quote}”</p>
                    <div className="rating-grid mt-8">
                      {ratingLabels.map((item) => <button key={item.rating} type="button" onClick={() => void rateCard(item.rating)} disabled={submitting} className={item.className}>{item.label}</button>)}
                    </div>
                  </div>
                ) : (
                  <button type="button" onClick={() => { sessionId.current ??= window.crypto.randomUUID(); setRevealed(true); }} className="command-button command-button-dark mt-10"><Eye aria-hidden="true" className="size-4" />显示答案</button>
                )}
              </div>
            ) : activeChapter && activeChapter.queue.length > 0 ? (
              <div className="chapter-finished">
                <span className="chapter-finished-mark"><Check aria-hidden="true" className="size-5" /></span>
                <p className="section-kicker">Chapter Complete</p>
                <h3 className="font-display text-2xl font-semibold">本章今日任务已完成</h3>
                <p>本章今天安排的 {activeChapter.queue.length} 张卡已全部学习。</p>
                {nextPendingChapter ? (
                  <button
                    type="button"
                    className="command-button command-button-accent mt-3"
                    onClick={() => {
                      setSelectedChapterId(nextPendingChapter.id);
                      setRevealed(false);
                      cardStartedAt.current = clockMs();
                    }}
                  >
                    继续下一章
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="study-empty"><EyeOff aria-hidden="true" className="size-5" /><p>本章节今天没有到期或待学习卡片</p></div>
            )}
          </section>
        </div>
      ) : null}
    </main>
  );
}
