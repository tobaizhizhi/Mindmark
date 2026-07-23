"use client";

import {
  ArrowLeft,
  BookOpen,
  Check,
  CircleAlert,
  ExternalLink,
  Eye,
  EyeOff,
  LoaderCircle,
  LogOut,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  learningJourneyRegistryAbi,
  type CompleteSessionResponse,
  type JourneyDetailResponse,
  type ReviewRatingSchema,
} from "@mindmark/shared";
import { JourneyDetailResponseSchema } from "@mindmark/shared/schemas";
import { usePublicClient } from "wagmi";
import { z } from "zod";
import { monadChain, registryAddress } from "@/lib/client/chain";
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
  const [cardIndex, setCardIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [sessionResult, setSessionResult] = useState<CompleteSessionResponse | null>(null);
  const initialTabSelected = useRef(false);
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
        setTab(parsed.status === "READY" ? "study" : "progress");
      }
      if (parsed.status === "READY") cardStartedAt.current = clockMs();
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
    if (!detail || ["READY", "CANCELLED"].includes(detail.status)) return;
    const timer = window.setInterval(() => void loadDetail(), 3_000);
    return () => window.clearInterval(timer);
  }, [detail, loadDetail]);

  const activeItem = detail?.studyQueue?.queue[cardIndex] ?? null;
  const reviewedCount = Math.min(cardIndex, detail?.studyQueue?.queue.length ?? 0);
  const allReviewed = Boolean(
    detail?.studyQueue &&
      detail.studyQueue.queue.length > 0 &&
      cardIndex >= detail.studyQueue.queue.length,
  );
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

  async function completeSession() {
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
  }

  async function rateCard(rating: ReviewRating) {
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
      const nextIndex = cardIndex + 1;
      setCardIndex(nextIndex);
      setRevealed(false);
      cardStartedAt.current = clockMs();
      if (detail?.studyQueue && nextIndex >= detail.studyQueue.queue.length) {
        await completeSession();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "复习记录提交失败");
    } finally {
      setSubmitting(false);
    }
  }

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
            <button type="button" data-active={tab === "progress"} onClick={() => setTab("progress")}>生成与验证</button>
            <button type="button" data-active={tab === "study"} onClick={() => setTab("study")} disabled={detail?.status !== "READY"}>今日学习</button>
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
        <div className="mx-auto w-full max-w-7xl px-5 py-7 md:px-8 md:py-9">
          <section className="mb-8 grid gap-0 border-y border-[var(--line)] bg-white md:grid-cols-4">
            <div className="metric-cell"><span>状态</span><strong>{detail.status}</strong></div>
            <div className="metric-cell"><span>Worker</span><strong>{detail.chunks.filter((chunk) => chunk.workerAddress).length} / {detail.chunks.length}</strong></div>
            <div className="metric-cell"><span>知识卡</span><strong>{detail.deck?.length ?? detail.chunks.reduce((sum, chunk) => sum + (chunk.cardCount ?? 0), 0)}</strong></div>
            <div className="metric-cell"><span>Monad 卡组</span><strong>{detail.finalizeTxHash ? "已确认" : "等待"}</strong></div>
          </section>

          <section>
            <div className="mb-4 flex items-center justify-between">
              <div><p className="section-kicker">Parallel Agents</p><h2 className="font-display mt-1 text-xl font-semibold">分段执行记录</h2></div>
              <button type="button" onClick={() => void loadDetail()} className="icon-button" aria-label="刷新状态" title="刷新状态"><RefreshCw aria-hidden="true" className="size-4" /></button>
            </div>
            <div className="overflow-x-auto border-y border-[var(--line)] bg-white">
              <table className="progress-table">
                <thead><tr><th>章节</th><th>Worker</th><th>状态</th><th>卡片</th><th>交易</th><th>区块</th><th>Gas</th><th>确认</th></tr></thead>
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
                    </tr>
                  ))}
                </tbody>
              </table>
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
        <div className="mx-auto grid w-full max-w-6xl gap-8 px-5 py-8 md:px-8 lg:grid-cols-[minmax(0,1fr)_280px]">
          <section>
            <div className="mb-5 flex items-center justify-between border-b border-[var(--line)] pb-4">
              <div><p className="section-kicker">Session</p><h2 className="font-display mt-1 text-2xl font-semibold">今日学习</h2></div>
              <span className="font-mono text-sm text-[var(--muted)]">{reviewedCount} / {detail.studyQueue?.queue.length ?? 0}</span>
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
                <div className="flex items-center justify-between"><span className="status-chip">{activeItem.reason === "due" ? "到期复习" : "新学习卡"}</span><span className="font-mono text-xs text-[var(--muted)]">P.{activeItem.card.source.page}</span></div>
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
            ) : (
              <div className="study-empty"><EyeOff aria-hidden="true" className="size-5" /><p>当前没有到期或待学习卡片</p></div>
            )}
          </section>
          <aside className="study-sidebar">
            <p className="section-kicker">Queue</p>
            <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-1">
              <div><span>到期</span><strong>{detail.studyQueue?.dueCount ?? 0}</strong></div>
              <div><span>新卡</span><strong>{detail.studyQueue?.newCount ?? 0}</strong></div>
            </div>
            <div className="mt-6 border-t border-[var(--line)] pt-5 text-sm leading-6 text-[var(--muted)]">FSRS 到期卡优先，单次最多 15 张。</div>
          </aside>
        </div>
      ) : null}
    </main>
  );
}
