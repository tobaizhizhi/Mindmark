"use client";

import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  FileText,
  LoaderCircle,
  Plus,
  Sparkles,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AuthNonceResponse,
  AuthVerifyResponse,
  ChapterProposal,
  OutlinePlanningOperation,
  ProjectConfirmationResponse,
  ProjectCreationView,
  ProjectDesignAcceptedResponse,
  ProjectIntakeResponse,
  ProjectSourceFileResponse,
  LearnerProjectProgress,
  ProjectSourceRegistrationResponse,
  SourcePage,
} from "@mindmark/shared";
import { learningProjectRegistryV2Abi, MAX_SOURCE_CHARACTERS } from "@mindmark/shared";
import {
  useAccount,
  useConnect,
  useSignMessage,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { monadChain, registryV2Address } from "@/lib/client/chain";
import { parseApiResponse } from "@/lib/client/http";
import {
  isEip1193Provider,
  monadCreationErrorMessage,
  refreshMonadWalletRpc,
} from "@/lib/client/monad-wallet-network";
import { extractPdfFile } from "@/lib/client/pdf-source";
import { createLatestRequestGate } from "@/lib/client/latest-request";
import { createWalletSignInMessage } from "@/lib/client/wallet-auth";
import {
  ProjectSourceInput,
  type ProjectSourceMode,
} from "./project-source-input";
import { ProjectProgressIndicator } from "@/features/learning-workspace/project-progress-indicator";
import { shouldPollProjectProgress } from "@/features/learning-workspace/project-progress-policy";
import { MonadRegistrationCard } from "./monad-registration-card";

type WalletSessionResponse = {
  session: { address: string; expiresAt?: string } | null;
};

function normalizeText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trim()).filter(Boolean).join("\n");
}

function splitPastedText(value: string): SourcePage[] {
  const pages = normalizeText(value)
    .split(/\n(?=第\s*\d+\s*页\b|Page\s+\d+\b)/iu)
    .map((text) => text.trim())
    .filter(Boolean);
  return pages.map((text, index) => ({ pageNumber: index + 1, text }));
}

function isCreatedProjectStatus(status: ProjectCreationView["status"]): boolean {
  return ["GENERATING", "FINALIZING", "READY"].includes(status);
}

function storedTransactionHash(value: string | null): `0x${string}` | null {
  return value && /^0x[0-9a-f]{64}$/u.test(value) ? value as `0x${string}` : null;
}

export function ProjectCreationWorkbench(props: { mode?: "intake" | "outline" } = {}) {
  const outlineOnly = props.mode === "outline";
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [text, setText] = useState("");
  const [sourceMode, setSourceMode] = useState<ProjectSourceMode>("pdf");
  const [pdfPages, setPdfPages] = useState<SourcePage[]>([]);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState("");
  const [project, setProject] = useState<ProjectIntakeResponse | null>(null);
  const [outlineOperation, setOutlineOperation] = useState<OutlinePlanningOperation | null>(null);
  const [proposals, setProposals] = useState<ChapterProposal[]>([]);
  const [confirmation, setConfirmation] = useState<ProjectConfirmationResponse | null>(null);
  const [designingCards, setDesigningCards] = useState(false);
  const [projectProgress, setProjectProgress] = useState<LearnerProjectProgress | null>(null);
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null);
  const [progressRefresh, setProgressRefresh] = useState(0);
  const [busy, setBusy] = useState<"extract" | "login" | "outline" | "confirm" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const clientRequestIdRef = useRef<string | null>(null);
  const outlineRequestsRef = useRef(createLatestRequestGate());
  const hasLocalSourceInteractionRef = useRef(false);
  const queryClient = useQueryClient();
  const router = useRouter();
  const { address, chainId, connector, isConnected } = useAccount();
  const { connectors, connectAsync } = useConnect();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const sessionQuery = useQuery({
    queryKey: ["wallet-session"],
    queryFn: async () => {
      const response = await fetch("/api/auth/session");
      if (!response.ok) throw new Error("登录状态读取失败");
      return response.json() as Promise<WalletSessionResponse>;
    },
    staleTime: 30_000,
  });
  const sessionAddress = sessionQuery.data?.session?.address?.toLowerCase() ?? null;
  const loggedIn = Boolean(address && sessionAddress && address.toLowerCase() === sessionAddress);
  const pastedPages = useMemo(() => splitPastedText(text), [text]);
  const pages = sourceMode === "pdf" ? pdfPages : pastedPages;
  const characterCount = pages.reduce((sum, page) => sum + page.text.length, 0);
  const outlinePlanningActive = Boolean(
    outlineOperation && ["QUEUED", "RUNNING", "RETRYABLE"].includes(outlineOperation.status),
  );
  const outlineOperationId = outlineOperation?.operationId ?? null;
  const outlineOperationProjectId = outlineOperation?.projectId ?? null;
  const progressProjectId = outlinePlanningActive ? null : createdProjectId
    ?? confirmation?.projectId
    ?? project?.projectId;

  function applyCreationView(view: ProjectCreationView) {
    setError(null);
    setTitle(view.title);
    setGoal(view.goal ?? "");
    setFileName(view.sourceFilename ?? "");
    if (view.outline) {
      setProject(view.outline);
      setProposals(view.outline.chapters.map((chapter) => ({
        title: chapter.title,
        summary: chapter.summary,
        startBlock: chapter.startBlock,
        endBlock: chapter.endBlock,
        importance: chapter.importance,
      })));
    }
    setConfirmation(view.confirmation);
    setDesigningCards(view.status === "DESIGNING_CARDS");
    setCreatedProjectId(isCreatedProjectStatus(view.status) ? view.projectId : null);
  }

  useEffect(() => {
    if (!sessionAddress) return;
    if (hasLocalSourceInteractionRef.current) return;
    const draftProjectId = new URLSearchParams(window.location.search).get("project");
    if (!draftProjectId) return;
    let cancelled = false;
    const request = outlineRequestsRef.current.begin();
    const isActive = () => !cancelled && request.isCurrent();
    void (async () => {
      try {
        const view = await parseApiResponse<ProjectCreationView>(await fetch(
          `/api/projects/${draftProjectId}/creation`,
          { cache: "no-store" },
        ));
        if (!isActive()) return;
        if (view.projectId !== draftProjectId) throw new Error("项目恢复结果与当前项目不匹配");
        applyCreationView(view);
        if (!view.outline && view.status === "OUTLINING") {
          const operation = await parseApiResponse<OutlinePlanningOperation>(await fetch(
            `/api/projects/${view.projectId}/outline/operation`,
            { cache: "no-store" },
          ));
          if (!isActive()) return;
          if (operation.projectId !== view.projectId) throw new Error("章节草稿任务与当前项目不匹配");
          request.commit(() => setOutlineOperation(operation));
        } else {
          request.commit(() => setOutlineOperation(null));
        }
      } catch (caught) {
        if (isActive()) {
          request.commit(() => setError(caught instanceof Error ? caught.message : "项目恢复失败"));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionAddress]);

  useEffect(() => {
    if (!sessionAddress || !outlineOperationId || !outlineOperationProjectId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const refresh = async () => {
      if (document.visibilityState !== "visible") {
        timer = setTimeout(() => void refresh(), 5_000);
        return;
      }
      try {
        const operation = await parseApiResponse<OutlinePlanningOperation>(await fetch(
          `/api/projects/${outlineOperationProjectId}/outline/operation?operationId=${outlineOperationId}`,
          { cache: "no-store", signal: controller.signal },
        ));
        if (cancelled) return;
        if (
          operation.operationId !== outlineOperationId
          || operation.projectId !== outlineOperationProjectId
        ) throw new Error("章节草稿任务与当前项目不匹配");
        setOutlineOperation(operation);
        if (operation.status === "SUCCEEDED") {
          const view = await parseApiResponse<ProjectCreationView>(await fetch(
            `/api/projects/${operation.projectId}/creation`,
            { cache: "no-store", signal: controller.signal },
          ));
          if (cancelled) return;
          if (view.projectId !== outlineOperationProjectId) throw new Error("章节草稿结果与当前项目不匹配");
          if (!view.outline) throw new Error("章节草稿尚未准备完成");
          applyCreationView(view);
          setOutlineOperation(null);
          return;
        }
        if (["FAILED", "CANCELLED"].includes(operation.status)) {
          setError(operation.lastError ?? "章节草稿生成失败，请重试");
          return;
        }
        timer = setTimeout(() => void refresh(), 2_000);
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "章节草稿状态读取失败");
          timer = setTimeout(() => void refresh(), 5_000);
        }
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [outlineOperationId, outlineOperationProjectId, sessionAddress]);

  useEffect(() => {
    if (!sessionAddress || !progressProjectId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const refresh = async () => {
      if (document.visibilityState !== "visible") {
        timer = setTimeout(() => void refresh(), 5_000);
        return;
      }
      try {
        const progress = await parseApiResponse<LearnerProjectProgress>(await fetch(
          `/api/projects/${progressProjectId}/progress`,
          { cache: "no-store", signal: controller.signal },
        ));
        if (cancelled) return;
        setProjectProgress(progress);
        if (designingCards && progress.stage === "AWAITING_MONAD") {
          const view = await parseApiResponse<ProjectCreationView>(await fetch(
            `/api/projects/${progressProjectId}/creation`,
            { cache: "no-store", signal: controller.signal },
          ));
          if (cancelled) return;
          if (!view.confirmation) throw new Error("知识卡教学设计尚未准备完成");
          applyCreationView(view);
          return;
        }
        if (designingCards && ["ACTION_REQUIRED", "FAILED"].includes(progress.stage)) {
          setDesigningCards(false);
          setError("知识卡教学设计未完成，请在运行诊断中查看失败任务");
          return;
        }
        if (shouldPollProjectProgress(progress)) {
          timer = setTimeout(() => void refresh(), 5_000);
        }
      } catch (caught) {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : "项目进度读取失败");
        timer = setTimeout(() => void refresh(), 4_000);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [designingCards, progressProjectId, progressRefresh, sessionAddress]);

  async function signIn(walletAddress: string, walletChainId: number | undefined) {
    setBusy("login");
    setError(null);
    try {
      if (walletChainId !== monadChain.id) await switchChainAsync({ chainId: monadChain.id });
      const nonce = await parseApiResponse<AuthNonceResponse>(await fetch("/api/auth/nonce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: walletAddress }),
      }));
      const message = createWalletSignInMessage({
        address: walletAddress,
        nonce,
      });
      const signature = await signMessageAsync({ message });
      const verified = await parseApiResponse<AuthVerifyResponse>(await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, signature }),
      }));
      queryClient.setQueryData<WalletSessionResponse>(["wallet-session"], {
        session: { address: verified.address.toLowerCase(), expiresAt: verified.expiresAt },
      });
    } catch (caught) {
      throw caught instanceof Error ? caught : new Error("登录失败");
    } finally {
      setBusy(null);
    }
  }

  async function connectAndSignIn() {
    try {
      if (isConnected && address) {
        if (!loggedIn) await signIn(address, chainId);
        return;
      }
      const connector = connectors[0];
      if (!connector) throw new Error("未检测到浏览器钱包");
      const connection = await connectAsync({ connector, chainId: monadChain.id });
      await signIn(connection.accounts[0], connection.chainId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "钱包登录失败");
    }
  }

  function resetOutline() {
    hasLocalSourceInteractionRef.current = true;
    outlineRequestsRef.current.invalidate();
    setBusy((current) => current === "outline" ? null : current);
    setProject(null);
    setOutlineOperation(null);
    setConfirmation(null);
    setDesigningCards(false);
    setProjectProgress(null);
    setProposals([]);
    clientRequestIdRef.current = null;
  }

  function changeSourceMode(mode: ProjectSourceMode) {
    setSourceMode(mode);
    setError(null);
    resetOutline();
    if (mode !== "pdf") setPdfFile(null);
  }

  async function selectPdf(file: File) {
    setBusy("extract");
    setError(null);
    resetOutline();
    try {
      const extracted = await extractPdfFile(file);
      setPdfPages(extracted);
      setPdfFile(file);
      setFileName(file.name);
      if (!title.trim()) setTitle(file.name.replace(/\.pdf$/iu, ""));
    } catch (caught) {
      setPdfPages([]);
      setPdfFile(null);
      setFileName("");
      setError(caught instanceof Error ? caught.message : "PDF 解析失败");
    } finally {
      setBusy(null);
    }
  }

  async function generateOutline() {
    if (!loggedIn) return setError("请先连接并登录钱包");
    if (!title.trim()) return setError("请填写项目名称");
    if (pages.length === 0 || characterCount > MAX_SOURCE_CHARACTERS) return setError("请先上传或粘贴有效资料");
    const request = outlineRequestsRef.current.begin();
    setBusy("outline");
    setError(null);
    try {
      clientRequestIdRef.current ??= crypto.randomUUID();
      const folderId = new URLSearchParams(window.location.search).get("folder");
      const registration = await parseApiResponse<ProjectSourceRegistrationResponse>(await fetch("/api/projects/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientRequestId: clientRequestIdRef.current,
          title,
          goal: goal.trim() || undefined,
          sourceFilename: sourceMode === "pdf" ? fileName : "pasted-text.txt",
          sourceMimeType: sourceMode === "pdf" ? "application/pdf" : "text/plain",
          folderId: folderId || undefined,
          pages,
        }),
      }));
      if (!request.isCurrent()) return;
      if (sourceMode === "pdf" && pdfFile) {
        const formData = new FormData();
        formData.set("file", pdfFile, pdfFile.name);
        await parseApiResponse<ProjectSourceFileResponse>(await fetch(
          `/api/projects/${registration.projectId}/source-file`,
          { method: "POST", body: formData },
        ));
      }
      const operation = await parseApiResponse<OutlinePlanningOperation>(await fetch(
        `/api/projects/${registration.projectId}/outline/plan`,
        { method: "POST" },
      ));
      if (!request.isCurrent()) return;
      if (operation.projectId !== registration.projectId) throw new Error("章节草稿任务与当前项目不匹配");
      request.commit(() => {
        setProject(null);
        setProposals([]);
        setOutlineOperation(operation);
        if (outlineOnly) {
          window.history.replaceState(null, "", `?project=${operation.projectId}${folderId ? `&folder=${folderId}` : ""}`);
        } else {
          router.replace(`/learn/projects/new/outline?project=${operation.projectId}${folderId ? `&folder=${folderId}` : ""}`);
        }
        setConfirmation(null);
      });
    } catch (caught) {
      request.commit(() => setError(caught instanceof Error ? caught.message : "资料结构分析失败"));
    } finally {
      request.commit(() => setBusy(null));
    }
  }

  function updateProposal(index: number, patch: Partial<ChapterProposal>) {
    setProposals((current) => current.map((proposal, proposalIndex) => proposalIndex === index ? { ...proposal, ...patch } : proposal));
  }

  function mergeProposal(index: number) {
    setProposals((items) => {
      if (items.length <= 1) return items;
      const leftIndex = index < items.length - 1 ? index : index - 1;
      const left = items[leftIndex]!;
      const right = items[leftIndex + 1]!;
      return [
        ...items.slice(0, leftIndex),
        {
          ...left,
          endBlock: right.endBlock,
          summary: `${left.summary} ${right.summary}`.trim().slice(0, 500),
          importance: Math.max(left.importance, right.importance),
        },
        ...items.slice(leftIndex + 2),
      ];
    });
  }

  function moveBoundary(index: number, delta: -1 | 1) {
    setProposals((items) => {
      const left = items[index];
      const right = items[index + 1];
      if (!left || !right) return items;
      const nextEnd = left.endBlock + delta;
      if (nextEnd < left.startBlock || nextEnd >= right.endBlock) return items;
      return items.map((item, itemIndex) => itemIndex === index
        ? { ...item, endBlock: nextEnd }
        : itemIndex === index + 1
          ? { ...item, startBlock: nextEnd + 1 }
          : item);
    });
  }

  function splitProposal(index: number) {
    const current = proposals[index];
    if (!current || current.endBlock <= current.startBlock) return;
    const midpoint = Math.floor((current.startBlock + current.endBlock) / 2);
    const next = {
      title: `${current.title}（下）`,
      summary: current.summary,
      startBlock: midpoint + 1,
      endBlock: current.endBlock,
      importance: current.importance,
    } satisfies ChapterProposal;
    setProposals((items) => [...items.slice(0, index), { ...current, title: `${current.title}（上）`, endBlock: midpoint }, next, ...items.slice(index + 1)]);
  }

  async function confirmOutline() {
    if (!project) return;
    setBusy("confirm");
    setError(null);
    try {
      const result = await parseApiResponse<ProjectDesignAcceptedResponse>(await fetch(`/api/projects/${project.projectId}/outline/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(proposals),
      }));
      setDesigningCards(result.status === "DESIGNING_CARDS");
      setProgressRefresh((value) => value + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "章节确认失败，请检查范围是否连续");
    } finally {
      setBusy(null);
    }
  }

  async function createOnMonad() {
    if (!confirmation || !address) return;
    if (!registryV2Address) return setError("尚未配置 V2 Registry 合约地址");
    setBusy("create");
    setError(null);
    try {
      const view = await parseApiResponse<ProjectCreationView>(await fetch(
        `/api/projects/${confirmation.projectId}/creation`,
        { cache: "no-store" },
      ));
      if (view.projectId !== confirmation.projectId) throw new Error("项目恢复结果与当前项目不匹配");
      if (isCreatedProjectStatus(view.status)) {
        applyCreationView(view);
        return;
      }
      if (!view.confirmation) throw new Error("项目尚未准备好进行 Monad 登记");

      if (chainId !== monadChain.id) await switchChainAsync({ chainId: monadChain.id });
      const provider = await connector?.getProvider();
      if (isEip1193Provider(provider)) {
        await refreshMonadWalletRpc(provider, {
          origin: window.location.origin,
          chainId: monadChain.id,
          chainName: monadChain.name,
          nativeCurrency: monadChain.nativeCurrency,
          publicRpcUrls: monadChain.rpcUrls.default.http,
          blockExplorerUrl: monadChain.blockExplorers.default.url,
        });
      }
      const storageKey = `mindmark:create-tx:${view.confirmation.projectId}`;
      let txHash = storedTransactionHash(window.sessionStorage.getItem(storageKey));
      if (!txHash) {
        const args = view.confirmation.createProjectArgs;
        txHash = await writeContractAsync({
          address: registryV2Address,
          abi: learningProjectRegistryV2Abi,
          functionName: "createProject",
          args: [
            args.projectId,
            args.sourceHash,
            args.goalHash,
            args.outlineHash,
            args.workUnitManifestRoot,
            args.chapters,
          ],
          chain: monadChain,
          account: address,
        });
        window.sessionStorage.setItem(storageKey, txHash);
      }
      const result = await parseApiResponse<{ projectId: string }>(await fetch(`/api/projects/${view.confirmation.projectId}/create-tx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txHash }),
      }));
      window.sessionStorage.removeItem(storageKey);
      setCreatedProjectId(result.projectId);
      setProgressRefresh((value) => value + 1);
    } catch (caught) {
      setError(monadCreationErrorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  function renderOutlineReview() {
    if (!project) {
      return (
        <main className="outline-review-page outline-review-page-loading">
          <header className="outline-review-header">
            <Link href="/learn/projects/new" className="outline-review-back"><ArrowLeft />返回资料分析</Link>
            <div className="outline-review-stepper" aria-label="创建步骤">
              <span>01 资料</span><i /><strong>02 章节结构</strong><i /><span>03 创建项目</span>
            </div>
            <button type="button" onClick={() => void connectAndSignIn()} disabled={Boolean(busy)} className="outline-review-wallet">
              {busy === "login" ? <LoaderCircle className="animate-spin" /> : <Wallet />}
              {loggedIn ? "已登录" : isConnected ? "完成登录" : "连接钱包"}
            </button>
          </header>
          <section className="outline-review-loading-card" aria-live="polite">
            <span className="outline-review-loading-icon"><LoaderCircle className="animate-spin" /></span>
            <p className="section-kicker">AI CHAPTER PLANNER</p>
            <h1>正在整理章节结构</h1>
            <p>{!sessionAddress
              ? "请先完成钱包登录，以恢复这份章节草稿。"
              : outlinePlanningActive
                ? `生成服务正在分析资料（第 ${outlineOperation?.attempt ?? 0} 次）。`
                : "正在从服务端恢复章节草稿，请稍候。"}</p>
            {projectProgress ? <ProjectProgressIndicator progress={projectProgress} compact /> : null}
            {error ? <div className="outline-review-error">{error}</div> : null}
          </section>
        </main>
      );
    }

    const sourceRange = proposals.length > 0
      ? `${proposals[0]?.startBlock ?? 0}–${proposals[proposals.length - 1]?.endBlock ?? 0}`
      : "—";
    const confirmed = Boolean(confirmation || designingCards);
    return (
      <main className="outline-review-page">
        <header className="outline-review-header">
          <Link href="/learn/projects/new" className="outline-review-back"><ArrowLeft />返回资料分析</Link>
          <div className="outline-review-stepper" aria-label="创建步骤">
            <span>01 资料</span><i /><strong>02 章节结构</strong><i /><span>03 创建项目</span>
          </div>
          <button type="button" onClick={() => void connectAndSignIn()} disabled={Boolean(busy)} className="outline-review-wallet">
            {busy === "login" ? <LoaderCircle className="animate-spin" /> : <Wallet />}
            {loggedIn ? "已登录" : isConnected ? "完成登录" : "连接钱包"}
          </button>
        </header>
        <div className="outline-review-content">
          <div className="outline-review-heading">
            <div>
              <p className="section-kicker">CHAPTER STRUCTURE</p>
              <h1>确认学习章节</h1>
              <p>AI 已将「{title || "这份资料"}」整理为可学习的章节。你可以调整标题、摘要和章节边界。</p>
            </div>
            <div className="outline-review-count"><strong>{proposals.length}</strong><span>个章节</span></div>
          </div>
          {error ? <div className="outline-review-error">{error}</div> : null}
          {projectProgress ? <ProjectProgressIndicator progress={projectProgress} compact /> : null}
          <div className="outline-review-layout">
            <section className="outline-review-list" aria-label="章节结构编辑器">
              <div className="outline-review-list-head"><span>章节目录</span><small>资料段落 {sourceRange} · 版本 {project.outlineVersion}</small></div>
              <div className="outline-review-chapters">
                {proposals.map((proposal, index) => (
                  <article key={`${index}-${proposal.startBlock}`} className={confirmed ? "outline-review-chapter outline-review-chapter-locked" : "outline-review-chapter"}>
                    <div className="outline-review-chapter-index"><small>学习单元</small><strong>{String(index + 1).padStart(2, "0")}</strong></div>
                    <div className="outline-review-chapter-main">
                      <div className="outline-review-chapter-fields">
                        <label><span>章节名称</span><input value={proposal.title} disabled={confirmed} onChange={(event) => updateProposal(index, { title: event.target.value })} /></label>
                        <label><span>章节摘要</span><textarea rows={2} value={proposal.summary} disabled={confirmed} onChange={(event) => updateProposal(index, { summary: event.target.value })} /></label>
                      </div>
                      <div className="outline-review-chapter-meta">
                        <span>资料段落 {proposal.startBlock}–{proposal.endBlock}</span>
                        <span>重要度 {proposal.importance}/5</span>
                      </div>
                      {!confirmed ? <div className="outline-review-chapter-actions">
                        <button type="button" className="outline-review-chapter-command" onClick={() => splitProposal(index)} disabled={proposal.endBlock <= proposal.startBlock}><Plus />拆分</button>
                        <button type="button" className="outline-review-chapter-command" onClick={() => mergeProposal(index)} disabled={proposals.length <= 1}><span className="outline-review-merge-icon">↔</span>合并</button>
                        {index < proposals.length - 1 ? <><button type="button" className="outline-review-boundary-button" onClick={() => moveBoundary(index, -1)} aria-label="分界向前" title="分界向前"><ArrowLeft /></button><button type="button" className="outline-review-boundary-button" onClick={() => moveBoundary(index, 1)} aria-label="分界向后" title="分界向后"><ArrowRight /></button></> : null}
                      </div> : null}
                    </div>
                  </article>
                ))}
              </div>
            </section>
            <aside className="outline-review-sidebar">
              <div className="outline-review-sidebar-heading"><span>结构摘要</span><FileText /></div>
              <div className="outline-review-stat"><strong>{proposals.length}</strong><span>学习章节</span></div>
              <div className="outline-review-stat"><strong>{sourceRange}</strong><span>覆盖资料段落</span></div>
              <p className="outline-review-note">章节会保持原资料顺序，确认后才会开始设计知识卡。</p>
              {project.excludedRanges?.length ? <div className="outline-review-exclusions"><strong>{project.excludedRanges.length}</strong><span>段非知识内容已排除</span></div> : null}
              <div className="outline-review-sidebar-action">
                {confirmation ? <MonadRegistrationCard
                  projectId={confirmation.projectId}
                  chainId={monadChain.id}
                  registryAddress={registryV2Address}
                  explorerUrl={monadChain.blockExplorers.default.url}
                  busy={busy === "create"}
                  onCreate={() => void createOnMonad()}
                /> : <button type="button" onClick={() => void confirmOutline()} disabled={Boolean(busy) || proposals.length === 0 || designingCards} className="command-button command-button-dark w-full">
                  {busy === "confirm" || designingCards ? <LoaderCircle className="size-4 animate-spin" /> : <Check className="size-4" />}
                  {designingCards ? "正在设计知识卡" : "确认章节并继续"}
                </button>}
              </div>
            </aside>
          </div>
        </div>
      </main>
    );
  }

  if (outlineOnly && !createdProjectId) return renderOutlineReview();

  if (createdProjectId) {
    const knowledgeCardsReady = projectProgress?.stage === "READY";
    return (
      <main className="min-h-screen bg-[var(--background)] px-5 py-12 text-[var(--ink)] md:px-8">
        <div className="mx-auto max-w-2xl rounded-lg border border-[var(--success-line)] bg-[var(--success-soft)] p-8">
          <Check className="size-8 text-[var(--success)]" />
          <p className="section-kicker mt-6">{knowledgeCardsReady ? "知识卡生成完成" : "项目创建完成"}</p>
          <h1 className="font-display mt-2 text-3xl font-semibold">{knowledgeCardsReady ? "全部知识卡已经准备好" : "章节已经登记，生成服务即将开始工作"}</h1>
          <p className="mt-4 text-sm leading-7 text-[var(--muted)]">{knowledgeCardsReady ? "现在可以开始学习，也可以返回资料库查看其他资料。" : "每个章节会独立进入可学习状态，你可以随时打开项目查看进度。"}</p>
          {projectProgress ? <div className="mt-6"><ProjectProgressIndicator progress={projectProgress} /></div> : null}
          <div className="mt-7 flex flex-wrap gap-3">
            <a href={`/learn/projects/${createdProjectId}`} className="command-button command-button-dark">{knowledgeCardsReady ? "开始学习" : "打开项目"} <ChevronRight className="size-4" /></a>
            {knowledgeCardsReady ? <Link href="/learn" className="command-button command-button-quiet"><ArrowLeft className="size-4" />返回资料库</Link> : null}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--ink)]">
      <header className="border-b border-[var(--line)] bg-white">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5 md:px-8">
          <a href="/learn" className="flex items-center gap-3 text-sm font-semibold"><ArrowLeft className="size-4" />返回项目</a>
          <button type="button" onClick={() => void connectAndSignIn()} disabled={Boolean(busy)} className="command-button command-button-dark">
            {busy === "login" ? <LoaderCircle className="size-4 animate-spin" /> : <Wallet className="size-4" />}
            {loggedIn ? "已登录" : isConnected ? "完成登录" : "连接并登录"}
          </button>
        </div>
      </header>
      <div className={`mx-auto grid max-w-6xl gap-8 px-5 py-8 md:px-8 ${project ? "lg:grid-cols-[minmax(0,1fr)_320px]" : "lg:grid-cols-1"} lg:py-10`}>
        <section>
          <p className="section-kicker">分章节生成</p>
          <h1 className="font-display mt-2 text-3xl font-semibold leading-10">先整理章节，再生成知识卡</h1>
          <p className="mt-4 max-w-2xl text-sm leading-7 text-[var(--muted)]">AI 先理解资料结构。你确认章节后，系统才会冻结承诺并在 Monad 创建学习项目。</p>
          <div className="mt-8 space-y-5">
            <label className="block"><span className="field-label">项目名称</span><input className="text-input mt-2" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：Monad 合约安全" /></label>
            <label className="block"><span className="field-label">学习目标 <span>可选</span></span><input className="text-input mt-2" value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="你希望掌握什么？" /></label>
            <ProjectSourceInput
              mode={sourceMode}
              onModeChange={changeSourceMode}
              text={text}
              onTextChange={(value) => {
                setText(value);
                setError(null);
                resetOutline();
              }}
              fileInputRef={fileInputRef}
              onFile={selectPdf}
              fileName={fileName}
              pageCount={pages.length}
              characterCount={characterCount}
              isExtracting={busy === "extract"}
            />
            {error ? <div className="border-l-2 border-[var(--danger)] bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]">{error}</div> : null}
            {projectProgress ? <ProjectProgressIndicator progress={projectProgress} /> : null}
            {!project ? <button type="button" onClick={() => void generateOutline()} disabled={Boolean(busy) || outlinePlanningActive} className="command-button command-button-accent"><Sparkles className="size-4" />{busy === "outline" || outlinePlanningActive ? "正在生成章节草稿" : outlineOperation?.status === "FAILED" ? "重新分析资料结构" : "分析资料结构"}<ChevronRight className="size-4" /></button> : null}
            {outlinePlanningActive ? <p className="text-sm leading-6 text-[var(--muted)]">生成服务正在整理章节结构（第 {outlineOperation?.attempt ?? 0} 次）。</p> : null}
          </div>
        </section>
        {project ? <aside className="border-t border-[var(--line)] bg-[var(--paper)] p-5 lg:border-l lg:border-t-0 lg:p-6">
          <div className="outline-intake-draft-heading"><p className="section-kicker outline-intake-draft-kicker">章节草稿</p>{project ? <span className="outline-intake-draft-version">版本 {project.outlineVersion}</span> : null}</div>
          <div className="mt-6 space-y-3">
            {proposals.map((proposal, index) => (
              <div key={`${index}-${proposal.startBlock}`} className="outline-intake-draft-card rounded-lg border border-[var(--line-strong)] bg-white p-4">
                <div className="flex items-start gap-3"><span className="outline-intake-draft-index">{String(index + 1).padStart(2, "0")}</span><div className="min-w-0 flex-1 space-y-2"><input className="outline-intake-draft-title w-full border-0 border-b border-[var(--line)] bg-transparent px-0 py-1 font-semibold outline-none" value={proposal.title} onChange={(event) => updateProposal(index, { title: event.target.value })} /><textarea className="outline-intake-draft-summary w-full resize-none border-0 bg-transparent px-0 py-1 outline-none" rows={2} value={proposal.summary} onChange={(event) => updateProposal(index, { summary: event.target.value })} /><p className="outline-intake-draft-range">资料段落 {proposal.startBlock}–{proposal.endBlock}</p></div></div>
                <div className="outline-intake-draft-actions"><button type="button" onClick={() => splitProposal(index)} className="text-command"><Plus className="size-3.5" />拆分</button><button type="button" onClick={() => mergeProposal(index)} disabled={proposals.length <= 1} className="text-command">合并</button>{index < proposals.length - 1 ? <><button type="button" onClick={() => moveBoundary(index, -1)} className="icon-button" aria-label="分界向前" title="分界向前"><ArrowLeft className="size-3.5" /></button><button type="button" onClick={() => moveBoundary(index, 1)} className="icon-button" aria-label="分界向后" title="分界向后"><ArrowRight className="size-3.5" /></button></> : null}</div>
              </div>
            ))}
          </div>
          <div className="mt-6 border-t border-[var(--line)] pt-5"><button type="button" onClick={() => void confirmOutline()} disabled={Boolean(busy) || proposals.length === 0 || Boolean(confirmation) || designingCards} className="command-button command-button-dark w-full">{busy === "confirm" || designingCards ? <LoaderCircle className="size-4 animate-spin" /> : <Check className="size-4" />}{confirmation ? "章节已确认" : designingCards ? "正在设计知识卡" : "确认章节"}</button></div>
          {confirmation ? <MonadRegistrationCard
            projectId={confirmation.projectId}
            chainId={monadChain.id}
            registryAddress={registryV2Address}
            explorerUrl={monadChain.blockExplorers.default.url}
            busy={busy === "create"}
            onCreate={() => void createOnMonad()}
          /> : null}
        </aside> : null}
      </div>
    </main>
  );
}
