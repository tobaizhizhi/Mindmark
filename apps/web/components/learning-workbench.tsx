"use client";

import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  FileText,
  Link2,
  LoaderCircle,
  LogOut,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Wallet,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SiweMessage } from "siwe";
import type {
  AuthNonceResponse,
  AuthVerifyResponse,
  PrepareJourneyResponse,
  SaveCreateTransactionResponse,
  SourcePage,
} from "@mindmark/shared";
import {
  learningJourneyRegistryAbi,
  MAX_SOURCE_CHARACTERS,
  MAX_SOURCE_PAGES,
} from "@mindmark/shared";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSignMessage,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { monadChain, registryAddress } from "@/lib/client/chain";
import { runJourneyDeletion } from "@/lib/client/deletion";
import { JourneyWorkspace } from "./journey-workspace";

type Phase =
  | "idle"
  | "extracting"
  | "preparing"
  | "wallet"
  | "confirming"
  | "created";

type ApiErrorBody = { error?: { code?: string; message?: string } };

class ClientApiError extends Error {
  constructor(
    public readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

type JourneyListItem = {
  journeyId: `0x${string}`;
  goal: string | null;
  status: string;
  cardCount: number;
  studiedCardCount: number;
  dueCount: number;
  planVersion: number;
  createdAt: string;
  updatedAt: string;
};

const MAX_PDF_BYTES = 15 * 1024 * 1024;

const journeyStatusLabels: Record<string, string> = {
  PREPARING: "准备资料",
  AWAITING_CREATE_TX: "等待上链",
  CREATED: "已登记",
  GENERATING: "AI 生成中",
  FINALIZING: "合并验证中",
  FAILED_RETRYABLE: "等待重试",
  READY: "可以复习",
  CANCELLED: "已取消",
};

async function parseApiResponse<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & ApiErrorBody;
  if (!response.ok) {
    throw new ClientApiError(body.error?.code, body.error?.message ?? "请求失败");
  }
  return body;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function shortJourneyId(journeyId: string): string {
  return `${journeyId.slice(0, 10)}…${journeyId.slice(-6)}`;
}

function formatUpdatedAt(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function normalizePageText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/gu, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function pdfItemsToText(items: readonly unknown[]): string {
  let output = "";
  let previousY: number | null = null;
  for (const value of items) {
    if (!value || typeof value !== "object" || !("str" in value)) continue;
    const item = value as { str: unknown; hasEOL?: unknown; transform?: unknown };
    if (typeof item.str !== "string") continue;
    const transform = Array.isArray(item.transform) ? item.transform : null;
    const y = transform && typeof transform[5] === "number" ? transform[5] : null;
    if (
      previousY !== null &&
      y !== null &&
      Math.abs(previousY - y) > 2.5 &&
      !output.endsWith("\n")
    ) {
      output += "\n";
    }
    output += item.str;
    if (item.hasEOL === true) {
      output += "\n";
      previousY = null;
    } else {
      output += " ";
      previousY = y;
    }
  }
  return output;
}

async function extractPdf(file: File): Promise<SourcePage[]> {
  if (file.size > MAX_PDF_BYTES) throw new Error("PDF 不能超过 15 MB");
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();
  const loadingTask = pdfjs.getDocument({ data: await file.arrayBuffer() });
  const document = await loadingTask.promise;
  if (document.numPages > MAX_SOURCE_PAGES) {
    await loadingTask.destroy();
    throw new Error(`PDF 不能超过 ${MAX_SOURCE_PAGES} 页`);
  }

  const pages: SourcePage[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = normalizePageText(pdfItemsToText(content.items));
    if (text) pages.push({ pageNumber, text });
  }
  await loadingTask.destroy();

  const totalCharacters = pages.reduce((total, page) => total + page.text.length, 0);
  if (totalCharacters === 0) throw new Error("没有检测到可提取文本，请改用粘贴文本");
  if (totalCharacters > MAX_SOURCE_CHARACTERS) {
    throw new Error(`提取文本不能超过 ${MAX_SOURCE_CHARACTERS.toLocaleString()} 字符`);
  }
  return pages;
}

function StepMarker({ done, active, index }: { done: boolean; active: boolean; index: number }) {
  return (
    <span
      className={`flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${
        done
          ? "border-[var(--accent)] bg-[var(--accent)] text-white"
          : active
            ? "border-[var(--ink)] bg-[var(--ink)] text-white"
            : "border-[var(--line-strong)] bg-white text-[var(--muted)]"
      }`}
    >
      {done ? <Check aria-hidden="true" className="size-4" /> : index}
    </span>
  );
}

function MindmarkHome(props: {
  address: string | undefined;
  isConnected: boolean;
  isConnecting: boolean;
  sessionMatchesWallet: boolean;
  phase: Phase;
  error: string | null;
  journeys: JourneyListItem[];
  journeysLoading: boolean;
  journeysError: string | null;
  lastJourneyId: `0x${string}` | null;
  onConnect: () => void;
  onSignOut: () => void;
  onCreate: () => void;
  onOpen: (journeyId: `0x${string}`) => void;
  onDelete: (journey: JourneyListItem) => void;
  onRetry: () => void;
}) {
  const authBusy = props.isConnecting || props.phase === "wallet";
  const [selectedJourneyId, setSelectedJourneyId] = useState<`0x${string}` | null>(null);
  const selectedJourney =
    props.journeys.find((journey) => journey.journeyId === selectedJourneyId) ??
    props.journeys.find((journey) => journey.journeyId === props.lastJourneyId) ??
    props.journeys[0];
  const showProjectRail =
    props.isConnected &&
    props.sessionMatchesWallet &&
    !props.journeysError &&
    (props.journeysLoading || Boolean(selectedJourney));

  return (
    <main className="home-shell min-h-screen text-[var(--ink)]">
      <header className="home-header home-workbench-header">
        <div className="mx-auto flex h-[72px] w-full max-w-7xl items-center justify-between px-5 md:px-8">
          <div className="flex items-center gap-3">
            <span className="home-logo-mark">
              <BookOpen aria-hidden="true" className="size-5" />
            </span>
            <div>
              <p className="font-display text-xl font-semibold leading-none">Mindmark</p>
              <p className="mt-1 font-mono text-[10px] tracking-[0.18em] text-[var(--muted)]">
                VERIFIABLE LEARNING
              </p>
            </div>
          </div>

          {props.isConnected && props.sessionMatchesWallet ? (
            <div className="flex items-center gap-2">
              <span className="hidden text-sm text-[var(--muted)] sm:inline">
                {props.sessionMatchesWallet
                  ? "学习档案已解锁"
                  : props.phase === "wallet"
                    ? "等待登录签名"
                    : "钱包已连接"}
              </span>
              <span className="home-wallet-address">
                {props.address ? shortAddress(props.address) : "-"}
              </span>
              <button
                type="button"
                onClick={props.onSignOut}
                className="icon-button"
                aria-label="退出钱包"
                title="退出钱包"
              >
                <LogOut aria-hidden="true" className="size-4" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={props.onConnect}
              disabled={authBusy}
              className="command-button command-button-dark"
            >
              {authBusy ? (
                <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
              ) : (
                <Wallet aria-hidden="true" className="size-4" />
              )}
              {props.isConnecting
                ? "正在连接"
                : props.phase === "wallet"
                  ? "请确认签名"
                  : props.isConnected
                    ? "完成登录"
                    : "连接并登录"}
            </button>
          )}
        </div>
      </header>

      <section
        id="learning-projects"
        className={`mx-auto w-full max-w-7xl px-5 py-10 md:px-8 md:py-14 ${showProjectRail ? "home-learning-section-with-rail" : ""}`}
      >
        <div className="flex flex-col justify-between gap-5 border-b border-[var(--line-strong)] pb-6 sm:flex-row sm:items-end">
          <div>
            <p className="section-kicker">学习工作台</p>
            <h1 className="font-display mt-2 text-3xl font-semibold md:text-4xl">新建或继续学习项目</h1>
          </div>
          <button type="button" onClick={props.onCreate} className="command-button command-button-accent">
            <Plus aria-hidden="true" className="size-4" />
            新建项目
          </button>
        </div>

        {props.error ? (
          <div className="mt-6 flex items-start gap-3 border-l-2 border-[var(--danger)] bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]">
            <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{props.error}</span>
          </div>
        ) : null}

        {!props.isConnected || !props.sessionMatchesWallet ? (
          <div className="home-auth-panel mt-8">
            <div>
              <span className="home-auth-icon"><Wallet aria-hidden="true" className="size-6" /></span>
              <p className="section-kicker mt-5">钱包学习档案</p>
              <h3 className="font-display mt-2 text-2xl font-semibold">
                {props.isConnected ? "完成钱包验证，查看以前的项目" : "连接钱包，找回学习进度"}
              </h3>
              <p className="mt-3 max-w-lg text-sm leading-7 text-[var(--muted)]">
                点击一次后会先连接钱包，再自动请求登录签名。签名不会发起交易，也不会消耗测试币。
              </p>
            </div>
          </div>
        ) : props.journeysLoading ? (
          <div className="home-project-browser mt-8" aria-label="正在载入学习项目">
            <div className="home-project-sidebar">
              <div className="home-project-sidebar-heading"><span>学习项目</span><strong>—</strong></div>
              {[0, 1, 2, 3].map((item) => <div key={item} className="home-project-row-skeleton" />)}
            </div>
            <div className="home-project-detail-skeleton" />
          </div>
        ) : props.journeysError ? (
          <div className="home-empty-state mt-8">
            <AlertCircle aria-hidden="true" className="size-6" />
            <h3>学习项目读取失败</h3>
            <p>{props.journeysError}</p>
            <button type="button" onClick={props.onRetry} className="command-button command-button-quiet">
              <RefreshCw aria-hidden="true" className="size-4" />重新读取
            </button>
          </div>
        ) : props.journeys.length === 0 ? (
          <div className="home-empty-state mt-8">
            <BookOpen aria-hidden="true" className="size-6" />
            <h3>还没有学习项目</h3>
            <p>上传第一份资料，AI 会生成知识卡并建立复习计划。</p>
            <button type="button" onClick={props.onCreate} className="command-button command-button-dark">
              <Plus aria-hidden="true" className="size-4" />新建第一个项目
            </button>
          </div>
        ) : selectedJourney ? (
          <div className="home-project-browser mt-8">
            <aside className="home-project-sidebar">
              <div className="home-project-sidebar-heading">
                <span>学习项目</span>
                <strong>{props.journeys.length}</strong>
              </div>
              <nav className="home-project-list" aria-label="学习项目列表">
                {props.journeys.map((journey, index) => {
                  const isSelected = journey.journeyId === selectedJourney.journeyId;
                  return (
                    <button
                      key={journey.journeyId}
                      type="button"
                      onClick={() => setSelectedJourneyId(journey.journeyId)}
                      className="home-project-row"
                      data-active={isSelected}
                      aria-current={isSelected ? "true" : undefined}
                      style={{ animationDelay: `${index * 45}ms` }}
                    >
                      <span className="home-project-dot" data-state={journey.status} />
                      <span className="home-project-row-copy">
                        <strong>{journey.goal || "未命名的知识卡学习项目"}</strong>
                        <small>
                          {journeyStatusLabels[journey.status] ?? journey.status}
                          <span>·</span>
                          {formatUpdatedAt(journey.updatedAt)}
                        </small>
                      </span>
                      {journey.status === "READY" && journey.dueCount > 0 ? (
                        <span className="home-project-due-badge">{journey.dueCount}</span>
                      ) : (
                        <ChevronRight aria-hidden="true" className="size-4" />
                      )}
                    </button>
                  );
                })}
              </nav>
            </aside>

            <section className="home-project-detail" aria-labelledby="selected-project-title">
              <div className="flex flex-wrap items-center gap-2">
                <span className="home-project-status" data-state={selectedJourney.status}>
                  {journeyStatusLabels[selectedJourney.status] ?? selectedJourney.status}
                </span>
                {selectedJourney.journeyId === props.lastJourneyId ? (
                  <span className="home-last-badge">上次打开</span>
                ) : null}
              </div>

              <p className="section-kicker mt-8">项目详情</p>
              <h2 id="selected-project-title" className="font-display mt-2 max-w-3xl text-3xl font-semibold leading-snug md:text-4xl">
                {selectedJourney.goal || "未命名的知识卡学习项目"}
              </h2>
              <p className="mt-3 font-mono text-[11px] text-[var(--muted)]">
                {shortJourneyId(selectedJourney.journeyId)}
              </p>

              <div className="home-project-detail-metrics">
                <div><span>知识卡</span><strong>{selectedJourney.cardCount || "—"}</strong></div>
                <div><span>已学习</span><strong>{selectedJourney.studiedCardCount}</strong></div>
                <div><span>当前到期</span><strong>{selectedJourney.status === "READY" ? selectedJourney.dueCount : "—"}</strong></div>
              </div>

              <div className="home-project-progress">
                <div>
                  <span>学习进度</span>
                  <strong>
                    {selectedJourney.cardCount > 0
                      ? `${Math.min(100, Math.round((selectedJourney.studiedCardCount / selectedJourney.cardCount) * 100))}%`
                      : "等待生成"}
                  </strong>
                </div>
                <span>
                  <i
                    style={{
                      width: selectedJourney.cardCount > 0
                        ? `${Math.min(100, (selectedJourney.studiedCardCount / selectedJourney.cardCount) * 100)}%`
                        : "0%",
                    }}
                  />
                </span>
              </div>

              <p className="home-project-detail-note">
                {selectedJourney.status === "READY"
                  ? selectedJourney.dueCount > 0
                    ? `当前有 ${selectedJourney.dueCount} 张知识卡需要复习，到期卡会优先出现。`
                    : "当前没有到期卡片，可以继续学习尚未接触的新卡。"
                  : "AI Agent 正在拆解资料并提交 Monad 记录，可以进入进度页查看各分段状态。"}
              </p>

              <div className="home-project-detail-actions">
                <span>更新于 {formatUpdatedAt(selectedJourney.updatedAt)}</span>
                <div>
                  <button
                    type="button"
                    onClick={() => props.onDelete(selectedJourney)}
                    className="command-button command-button-quiet"
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                    删除项目
                  </button>
                  <button
                    type="button"
                    onClick={() => props.onOpen(selectedJourney.journeyId)}
                    className="command-button command-button-accent"
                  >
                    {selectedJourney.status === "READY" ? "开始复习" : "查看生成进度"}
                    <ArrowRight aria-hidden="true" className="size-4" />
                  </button>
                </div>
              </div>
            </section>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function DeleteJourneyDialog(props: {
  journey: JourneyListItem;
  confirmation: string;
  phase: "idle" | "checking" | "cancelling" | "deleting";
  error: string | null;
  onConfirmationChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const busy = props.phase !== "idle";
  const activeOnChain = ["CREATED", "GENERATING", "FINALIZING", "FAILED_RETRYABLE"].includes(
    props.journey.status,
  );
  const actionLabel = {
    idle: "确认删除学习数据",
    checking: "正在检查 Monad 状态",
    cancelling: "等待 Monad 取消确认",
    deleting: "正在删除学习数据",
  }[props.phase];

  return (
    <div className="delete-dialog-backdrop" role="presentation">
      <section
        className="delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-dialog-title"
      >
        <div className="flex items-start justify-between gap-5">
          <div>
            <p className="section-kicker text-[var(--danger)]">危险操作</p>
            <h2 id="delete-dialog-title" className="font-display mt-2 text-3xl font-semibold">
              删除这个学习项目？
            </h2>
          </div>
          <button
            type="button"
            onClick={props.onCancel}
            disabled={busy}
            className="icon-button"
            aria-label="关闭删除确认"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>

        <div className="delete-project-reference">
          <strong>{props.journey.goal || "未命名的知识卡学习项目"}</strong>
          <span>{shortJourneyId(props.journey.journeyId)}</span>
        </div>

        <ul className="delete-effects-list">
          <li>Supabase 中的知识卡、复习状态和学习记录会永久删除。</li>
          <li>Monad 上已经产生的 Journey 和哈希承诺不会被抹除。</li>
          {activeOnChain ? (
            <li>该项目仍可能被 Worker 处理，将先调用 Monad 的 cancelJourney，需要少量测试 MON。</li>
          ) : null}
        </ul>

        <label className="mt-6 block">
          <span className="field-label">输入“删除”确认</span>
          <input
            value={props.confirmation}
            onChange={(event) => props.onConfirmationChange(event.target.value)}
            disabled={busy}
            autoFocus
            className="text-input mt-2"
            placeholder="删除"
          />
        </label>

        {props.error ? (
          <div className="mt-5 flex items-start gap-3 border-l-2 border-[var(--danger)] bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]">
            <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{props.error}</span>
          </div>
        ) : null}

        <div className="mt-7 flex flex-col-reverse gap-3 border-t border-[var(--line)] pt-6 sm:flex-row sm:justify-end">
          <button type="button" onClick={props.onCancel} disabled={busy} className="command-button command-button-quiet">
            保留项目
          </button>
          <button
            type="button"
            onClick={props.onConfirm}
            disabled={props.confirmation !== "删除" || busy}
            className="command-button delete-confirm-button"
          >
            {busy ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <Trash2 aria-hidden="true" className="size-4" />}
            {actionLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

export function LearningWorkbench() {
  const [view, setView] = useState<"home" | "create">("home");
  const [mode, setMode] = useState<"pdf" | "text">("pdf");
  const [pages, setPages] = useState<SourcePage[]>([]);
  const [pastedText, setPastedText] = useState("");
  const [fileName, setFileName] = useState("");
  const [goal, setGoal] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sessionAddress, setSessionAddress] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PrepareJourneyResponse | null>(null);
  const [confirmed, setConfirmed] = useState<SaveCreateTransactionResponse | null>(null);
  const [activeJourneyId, setActiveJourneyId] = useState<`0x${string}` | null>(null);
  const [lastJourneyId, setLastJourneyId] = useState<`0x${string}` | null>(null);
  const [journeys, setJourneys] = useState<JourneyListItem[]>([]);
  const [journeysLoading, setJourneysLoading] = useState(false);
  const [journeysError, setJourneysError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<JourneyListItem | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deletePhase, setDeletePhase] = useState<
    "idle" | "checking" | "cancelling" | "deleting"
  >("idle");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [demoLoaded, setDemoLoaded] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const { address, chainId, isConnected } = useAccount();
  const { connectors, connectAsync, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const activePages = useMemo<SourcePage[]>(() => {
    if (mode === "pdf") return pages;
    const text = normalizePageText(pastedText);
    return text ? [{ pageNumber: 1, text }] : [];
  }, [mode, pages, pastedText]);
  const characterCount = activePages.reduce((total, page) => total + page.text.length, 0);
  const sessionMatchesWallet =
    Boolean(address && sessionAddress) && address?.toLowerCase() === sessionAddress;
  const sourceReady = activePages.length > 0 && characterCount <= MAX_SOURCE_CHARACTERS;

  useEffect(() => {
    const restoreTimer = window.setTimeout(() => {
      const storedJourneyId = window.localStorage.getItem("mindmark_active_journey");
      if (/^0x[0-9a-fA-F]{64}$/u.test(storedJourneyId ?? "")) {
        setLastJourneyId(storedJourneyId as `0x${string}`);
      }
    }, 0);
    fetch("/api/auth/session")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { session?: { address?: string } } | null) => {
        setSessionAddress(body?.session?.address ?? null);
      })
      .catch(() => undefined);
    return () => window.clearTimeout(restoreTimer);
  }, []);

  async function loadJourneys() {
    if (!sessionMatchesWallet) {
      setJourneys([]);
      setJourneysError(null);
      return;
    }
    setJourneysLoading(true);
    setJourneysError(null);
    try {
      const response = await parseApiResponse<{ journeys: JourneyListItem[] }>(
        await fetch("/api/journeys"),
      );
      setJourneys(response.journeys);
    } catch (caught) {
      setJourneysError(caught instanceof Error ? caught.message : "学习项目读取失败");
    } finally {
      setJourneysLoading(false);
    }
  }

  useEffect(() => {
    if (!sessionMatchesWallet) return;
    let cancelled = false;
    const loadTimer = window.setTimeout(() => {
      setJourneysLoading(true);
      setJourneysError(null);
      fetch("/api/journeys")
        .then((response) => parseApiResponse<{ journeys: JourneyListItem[] }>(response))
        .then((response) => {
          if (!cancelled) setJourneys(response.journeys);
        })
        .catch((caught: unknown) => {
          if (!cancelled) {
            setJourneysError(caught instanceof Error ? caught.message : "学习项目读取失败");
          }
        })
        .finally(() => {
          if (!cancelled) setJourneysLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(loadTimer);
    };
  }, [sessionMatchesWallet]);

  async function selectFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setDemoLoaded(false);
    setPrepared(null);
    setConfirmed(null);
    setPhase("extracting");
    try {
      const extracted = await extractPdf(file);
      setPages(extracted);
      setFileName(file.name);
      setPhase("idle");
    } catch (caught) {
      setPhase("idle");
      setError(caught instanceof Error ? caught.message : "PDF 解析失败");
    }
  }

  async function loadDemo() {
    setError(null);
    setPhase("extracting");
    try {
      const response = await parseApiResponse<{ goal: string; pages: SourcePage[] }>(
        await fetch("/api/materials/demo"),
      );
      setMode("pdf");
      setPages(response.pages);
      setFileName("智能合约重入攻击学习资料.pdf");
      setGoal(response.goal);
      setDemoLoaded(true);
      setPrepared(null);
      setConfirmed(null);
      setPhase("idle");
    } catch (caught) {
      setPhase("idle");
      setError(caught instanceof Error ? caught.message : "示例资料载入失败");
    }
  }

  async function signIn(walletAddress: string | undefined = address, walletChainId = chainId) {
    if (!walletAddress) throw new Error("请先连接钱包");
    setError(null);
    setPhase("wallet");
    try {
      if (walletChainId !== monadChain.id) await switchChainAsync({ chainId: monadChain.id });
      const nonceResponse = await parseApiResponse<AuthNonceResponse>(
        await fetch("/api/auth/nonce", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: walletAddress }),
        }),
      );
      const message = new SiweMessage({
        domain: nonceResponse.domain,
        address: walletAddress,
        statement: "Sign in to Mindmark",
        uri: nonceResponse.uri,
        version: "1",
        chainId: nonceResponse.chainId,
        nonce: nonceResponse.nonce,
        issuedAt: new Date().toISOString(),
        expirationTime: nonceResponse.expiresAt,
      }).prepareMessage();
      const signature = await signMessageAsync({ message });
      const verified = await parseApiResponse<AuthVerifyResponse>(
        await fetch("/api/auth/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, signature }),
        }),
      );
      setJourneys([]);
      setJourneysError(null);
      setSessionAddress(verified.address.toLowerCase());
      setPhase("idle");
    } catch (caught) {
      setPhase("idle");
      setError(caught instanceof Error ? caught.message : "钱包登录失败");
    }
  }

  async function connectAndSignIn() {
    setError(null);
    try {
      if (isConnected && address) {
        if (sessionAddress?.toLowerCase() === address.toLowerCase()) return;
        await signIn(address, chainId);
        return;
      }

      const connector = connectors[0];
      if (!connector) throw new Error("未检测到浏览器钱包");
      const connection = await connectAsync({ connector, chainId: monadChain.id });
      const connectedAddress = connection.accounts[0];
      if (sessionAddress?.toLowerCase() === connectedAddress.toLowerCase()) return;
      await signIn(connectedAddress, connection.chainId);
    } catch (caught) {
      setPhase("idle");
      setError(caught instanceof Error ? caught.message : "钱包连接失败");
    }
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    setSessionAddress(null);
    setPrepared(null);
    setConfirmed(null);
    setActiveJourneyId(null);
    setLastJourneyId(null);
    setJourneys([]);
    setDeleteTarget(null);
    setDeleteConfirmation("");
    setDeleteError(null);
    setDeletePhase("idle");
    setView("home");
    window.localStorage.removeItem("mindmark_active_journey");
    disconnect();
  }

  async function prepare() {
    if (!sourceReady || !sessionMatchesWallet) return;
    setError(null);
    setPrepared(null);
    setConfirmed(null);
    setPhase("preparing");
    try {
      const result = await parseApiResponse<PrepareJourneyResponse>(
        await fetch("/api/journeys/prepare", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pages: activePages, goal: goal.trim() || undefined }),
        }),
      );
      setPrepared(result);
      setPhase("idle");
    } catch (caught) {
      setPhase("idle");
      setError(caught instanceof Error ? caught.message : "资料拆分失败");
    }
  }

  async function createOnMonad() {
    if (!prepared || !registryAddress) {
      setError("尚未配置已部署的 Registry 合约地址");
      return;
    }
    setError(null);
    setPhase("confirming");
    try {
      if (chainId !== monadChain.id) await switchChainAsync({ chainId: monadChain.id });
      const args = prepared.createJourneyArgs;
      const txHash = await writeContractAsync({
        address: registryAddress,
        abi: learningJourneyRegistryAbi,
        functionName: "createJourney",
        args: [
          args.journeyId,
          args.sourceHash,
          args.goalHash,
          args.chunkManifestRoot,
          args.chunkCount,
        ],
        chain: monadChain,
        account: address,
      });
      const result = await parseApiResponse<SaveCreateTransactionResponse>(
        await fetch(`/api/journeys/${prepared.journeyId}/create-tx`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ txHash }),
        }),
      );
      setConfirmed(result);
      setActiveJourneyId(result.journeyId);
      setLastJourneyId(result.journeyId);
      window.localStorage.setItem("mindmark_active_journey", result.journeyId);
      setPhase("created");
    } catch (caught) {
      setPhase("idle");
      setError(caught instanceof Error ? caught.message : "Monad 交易失败");
    }
  }

  function closeDeleteDialog() {
    if (deletePhase !== "idle") return;
    setDeleteTarget(null);
    setDeleteConfirmation("");
    setDeleteError(null);
  }

  async function deleteLearningProject() {
    if (!deleteTarget || deleteConfirmation !== "删除") return;
    const target = deleteTarget;
    const requestDeletion = async (cancellationTxHash?: `0x${string}`) =>
      parseApiResponse<{ deleted: true; journeyId: `0x${string}`; chainRecordRetained: boolean }>(
        await fetch(`/api/journeys/${target.journeyId}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cancellationTxHash ? { cancellationTxHash } : {}),
        }),
      );

    setDeleteError(null);
    try {
      await runJourneyDeletion({
        status: target.status,
        cancelOnMonad: async () => {
          if (!address) throw new Error("请重新连接创建该项目的钱包");
          if (!registryAddress) throw new Error("尚未配置已部署的 Registry 合约地址");
          if (chainId !== monadChain.id) await switchChainAsync({ chainId: monadChain.id });
          return writeContractAsync({
            address: registryAddress,
            abi: learningJourneyRegistryAbi,
            functionName: "cancelJourney",
            args: [target.journeyId],
            chain: monadChain,
            account: address,
          });
        },
        deleteFromServer: requestDeletion,
        isCancellationRequired: (caught) =>
          caught instanceof ClientApiError && caught.code === "chain_cancellation_required",
        onPhase: setDeletePhase,
      });

      setJourneys((current) =>
        current.filter((journey) => journey.journeyId !== target.journeyId),
      );
      if (lastJourneyId === target.journeyId) {
        setLastJourneyId(null);
        window.localStorage.removeItem("mindmark_active_journey");
      }
      setDeletePhase("idle");
      setDeleteTarget(null);
      setDeleteConfirmation("");
    } catch (caught) {
      setDeletePhase("idle");
      setDeleteError(caught instanceof Error ? caught.message : "学习项目删除失败");
    }
  }

  const busy = ["extracting", "preparing", "wallet", "confirming"].includes(phase);

  if (activeJourneyId) {
    return (
      <JourneyWorkspace
        key={activeJourneyId}
        journeyId={activeJourneyId}
        address={sessionAddress ?? address ?? null}
        onNew={() => {
          setActiveJourneyId(null);
          setPrepared(null);
          setConfirmed(null);
          setPhase("idle");
          setView("home");
          void loadJourneys();
        }}
        onSignOut={signOut}
      />
    );
  }

  if (view === "home") {
    return (
      <>
        <MindmarkHome
          address={address}
          isConnected={isConnected}
          isConnecting={isConnecting}
          sessionMatchesWallet={sessionMatchesWallet}
          phase={phase}
          error={error}
          journeys={journeys}
          journeysLoading={journeysLoading}
          journeysError={journeysError}
          lastJourneyId={lastJourneyId}
          onConnect={() => {
            void connectAndSignIn();
          }}
          onSignOut={() => void signOut()}
          onCreate={() => {
            setError(null);
            setView("create");
          }}
          onOpen={(journeyId) => {
            setError(null);
            setLastJourneyId(journeyId);
            setActiveJourneyId(journeyId);
            window.localStorage.setItem("mindmark_active_journey", journeyId);
          }}
          onDelete={(journey) => {
            setDeleteTarget(journey);
            setDeleteConfirmation("");
            setDeleteError(null);
          }}
          onRetry={() => void loadJourneys()}
        />
        {deleteTarget ? (
          <DeleteJourneyDialog
            journey={deleteTarget}
            confirmation={deleteConfirmation}
            phase={deletePhase}
            error={deleteError}
            onConfirmationChange={setDeleteConfirmation}
            onCancel={closeDeleteDialog}
            onConfirm={() => void deleteLearningProject()}
          />
        ) : null}
      </>
    );
  }

  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--ink)]">
      <header className="sticky top-0 z-20 border-b border-[var(--line)] bg-white">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5 md:px-8">
          <button
            type="button"
            onClick={() => setView("home")}
            className="flex items-center gap-3 border-0 bg-transparent text-left"
            aria-label="返回 Mindmark 首页"
          >
            <span className="flex size-9 items-center justify-center rounded-md bg-[var(--ink)] text-white">
              <BookOpen aria-hidden="true" className="size-5" />
            </span>
            <div>
              <p className="font-display text-lg font-semibold leading-none">Mindmark</p>
              <p className="mt-1 text-[11px] text-[var(--muted)]">MONAD LEARNING REGISTRY</p>
            </div>
          </button>

          {isConnected && sessionMatchesWallet ? (
            <div className="flex items-center gap-2">
              <span className="hidden text-sm text-[var(--muted)] sm:inline">
                {sessionMatchesWallet
                  ? "已登录"
                  : phase === "wallet"
                    ? "等待登录签名"
                    : "钱包已连接"}
              </span>
              <span className="rounded-md border border-[var(--line-strong)] bg-[var(--paper)] px-3 py-2 font-mono text-xs">
                {address ? shortAddress(address) : "-"}
              </span>
              <button
                type="button"
                onClick={signOut}
                className="icon-button"
                aria-label="退出钱包"
                title="退出钱包"
              >
                <LogOut aria-hidden="true" className="size-4" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void connectAndSignIn()}
              disabled={isConnecting || phase === "wallet"}
              className="command-button command-button-dark"
            >
              {isConnecting || phase === "wallet" ? (
                <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
              ) : (
                <Wallet aria-hidden="true" className="size-4" />
              )}
              {isConnecting
                ? "正在连接"
                : phase === "wallet"
                  ? "请确认签名"
                  : isConnected
                    ? "完成登录"
                    : "连接并登录"}
            </button>
          )}
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-6xl lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="px-5 py-8 md:px-8 md:py-10 lg:border-r lg:border-[var(--line)] lg:pr-10">
          <div className="mb-8 flex items-end justify-between gap-6 border-b border-[var(--line)] pb-6">
            <div>
              <button type="button" onClick={() => setView("home")} className="text-command mb-4">
                <ArrowLeft aria-hidden="true" className="size-4" />
                返回首页
              </button>
              <p className="section-kicker">新建学习项目</p>
              <h1 className="font-display mt-2 text-3xl font-semibold leading-tight md:text-4xl">
                导入学习资料
              </h1>
            </div>
            <button type="button" onClick={() => void loadDemo()} className="text-command">
              载入中文示例
              <ChevronRight aria-hidden="true" className="size-4" />
            </button>
          </div>

          <div className="segmented-control mb-5" aria-label="资料输入方式">
            <button
              type="button"
              data-active={mode === "pdf"}
              onClick={() => setMode("pdf")}
            >
              <FileText aria-hidden="true" className="size-4" /> PDF
            </button>
            <button
              type="button"
              data-active={mode === "text"}
              onClick={() => {
                setMode("text");
                setDemoLoaded(false);
              }}
            >
              <BookOpen aria-hidden="true" className="size-4" /> 文本
            </button>
          </div>

          {mode === "pdf" ? (
            <button
              type="button"
              className="upload-surface"
              onClick={() => fileInput.current?.click()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                void selectFile(event.dataTransfer.files[0]);
              }}
            >
              <input
                ref={fileInput}
                type="file"
                accept="application/pdf"
                className="sr-only"
                onChange={(event) => void selectFile(event.target.files?.[0])}
              />
              <span className="upload-icon">
                {phase === "extracting" ? (
                  <LoaderCircle aria-hidden="true" className="size-6 animate-spin" />
                ) : (
                  <Upload aria-hidden="true" className="size-6" />
                )}
              </span>
              <span className="font-display mt-4 text-xl font-semibold">
                {fileName || "选择 PDF 资料"}
              </span>
              <span className="mt-2 text-sm text-[var(--muted)]">
                {pages.length > 0
                  ? `${pages.length} 页 · ${characterCount.toLocaleString()} 字符`
                  : `最多 ${MAX_SOURCE_PAGES} 页 · 15 MB · ${MAX_SOURCE_CHARACTERS.toLocaleString()} 字符`}
              </span>
            </button>
          ) : (
            <div>
              <textarea
                value={pastedText}
                onChange={(event) => {
                  setPastedText(event.target.value);
                  setDemoLoaded(false);
                  setPrepared(null);
                  setConfirmed(null);
                }}
                maxLength={MAX_SOURCE_CHARACTERS}
                placeholder="粘贴课程笔记、文章或技术资料"
                className="source-textarea"
              />
              <p className="mt-2 text-right font-mono text-xs text-[var(--muted)]">
                {characterCount.toLocaleString()} / {MAX_SOURCE_CHARACTERS.toLocaleString()}
              </p>
            </div>
          )}

          <label className="mt-7 block">
            <span className="field-label">学习目标 <span>可选</span></span>
            <input
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              maxLength={500}
              placeholder="例如：理解重入攻击的调用顺序与防御方式"
              className="text-input mt-2"
            />
          </label>

          {error ? (
            <div className="mt-5 flex items-start gap-3 border-l-2 border-[var(--danger)] bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]">
              <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          <div className="mt-8 flex flex-col items-stretch justify-between gap-4 border-t border-[var(--line)] pt-6 sm:flex-row sm:items-center">
            <div className="flex items-center gap-2 text-sm text-[var(--muted)]">
              <ShieldCheck aria-hidden="true" className="size-4 text-[var(--accent)]" />
              原始文件保留在本机
            </div>
            {!sessionMatchesWallet ? (
              <span className="text-sm text-[var(--muted)]">
                {isConnected ? "请在顶部完成登录" : "登录后即可开始创建"}
              </span>
            ) : prepared ? (
              <button
                type="button"
                onClick={() => void createOnMonad()}
                disabled={busy || Boolean(confirmed)}
                className="command-button command-button-accent"
              >
                {phase === "confirming" ? (
                  <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                ) : (
                  <Link2 aria-hidden="true" className="size-4" />
                )}
                在 Monad 创建
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void prepare()}
                disabled={!sourceReady || busy}
                className="command-button command-button-accent"
              >
                {phase === "preparing" ? (
                  <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                ) : (
                  <Sparkles aria-hidden="true" className="size-4" />
                )}
                拆分资料
                <ArrowRight aria-hidden="true" className="size-4" />
              </button>
            )}
          </div>
        </section>

        <aside className="bg-[var(--paper)] px-5 py-8 md:px-8 md:py-10 lg:px-7">
          <p className="section-kicker">执行状态</p>
          <div className="mt-6 space-y-0">
            <div className="status-step">
              <StepMarker done={sourceReady} active={!sourceReady} index={1} />
              <div>
                <p className="status-title">{sourceReady ? "资料已载入" : "导入资料"}</p>
                <p className="status-detail">
                  {demoLoaded && sourceReady
                    ? "中文示例已载入，尚未拆分"
                    : sourceReady
                      ? `${activePages.length} 页 · ${characterCount.toLocaleString()} 字符`
                      : "等待资料"}
                </p>
              </div>
            </div>
            <div className="status-step">
              <StepMarker done={Boolean(prepared)} active={sourceReady && !prepared} index={2} />
              <div>
                <p className="status-title">语义分段</p>
                <p className="status-detail">
                  {prepared ? `${prepared.chunks.length} 个 chunk` : "Hash 与 Merkle 清单"}
                </p>
              </div>
            </div>
            <div className="status-step last">
              <StepMarker done={Boolean(confirmed)} active={Boolean(prepared && !confirmed)} index={3} />
              <div>
                <p className="status-title">Monad 创建</p>
                <p className="status-detail">
                  {confirmed ? `区块 ${confirmed.blockNumber}` : "等待钱包交易"}
                </p>
              </div>
            </div>
          </div>

          {prepared ? (
            <div className="mt-8 border-t border-[var(--line)] pt-6">
              <div className="mb-4 flex items-center justify-between">
                <p className="text-sm font-semibold">分段清单</p>
                <span className="font-mono text-xs text-[var(--muted)]">
                  {prepared.chunks.reduce((total, chunk) => total + chunk.cardBudget, 0)} 卡预算
                </span>
              </div>
              <div className="space-y-3">
                {prepared.chunks.map((chunk) => (
                  <div key={chunk.chunkId} className="chunk-row">
                    <span className="font-mono text-xs text-[var(--accent)]">
                      0{chunk.chunkId + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{chunk.title}</p>
                      <p className="mt-1 text-xs text-[var(--muted)]">
                        P.{chunk.pageStart}–{chunk.pageEnd} · {chunk.cardBudget} 卡
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="mt-10 border-t border-[var(--line)] pt-6">
              <p className="font-display text-lg font-semibold">三组独立承诺</p>
              <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                资料分段后，每个 Worker 将使用独立钱包提交自己的 cardsRoot。
              </p>
            </div>
          )}

          {confirmed ? (
            <div className="mt-8 border border-[var(--success-line)] bg-[var(--success-soft)] p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-[var(--success)]">
                <Check aria-hidden="true" className="size-4" />
                JourneyCreated 已确认
              </div>
              <p className="mt-3 break-all font-mono text-[11px] leading-5 text-[var(--muted)]">
                {confirmed.journeyId}
              </p>
            </div>
          ) : null}
        </aside>
      </div>
    </main>
  );
}
