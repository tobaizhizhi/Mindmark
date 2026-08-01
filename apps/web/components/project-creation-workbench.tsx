"use client";

import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  LoaderCircle,
  Plus,
  Sparkles,
  Wallet,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SiweMessage } from "siwe";
import type {
  AuthNonceResponse,
  AuthVerifyResponse,
  ChapterProposal,
  OutlinePlanningOperation,
  ProjectConfirmationResponse,
  ProjectCreationView,
  ProjectDesignAcceptedResponse,
  ProjectDesignProgress,
  ProjectIntakeResponse,
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
import { extractPdfFile } from "@/lib/client/pdf-source";
import { createLatestRequestGate } from "@/lib/client/latest-request";
import {
  ProjectSourceInput,
  type ProjectSourceMode,
} from "./project-source-input";

type ApiErrorBody = { error?: { code?: string; message?: string } };

class ClientApiError extends Error {
  constructor(public readonly code: string | undefined, message: string) {
    super(message);
  }
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & ApiErrorBody;
  if (!response.ok) throw new ClientApiError(body.error?.code, body.error?.message ?? "请求失败");
  return body;
}

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

export function ProjectCreationWorkbench() {
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [text, setText] = useState("");
  const [sourceMode, setSourceMode] = useState<ProjectSourceMode>("pdf");
  const [pdfPages, setPdfPages] = useState<SourcePage[]>([]);
  const [fileName, setFileName] = useState("");
  const [project, setProject] = useState<ProjectIntakeResponse | null>(null);
  const [outlineOperation, setOutlineOperation] = useState<OutlinePlanningOperation | null>(null);
  const [proposals, setProposals] = useState<ChapterProposal[]>([]);
  const [confirmation, setConfirmation] = useState<ProjectConfirmationResponse | null>(null);
  const [designingCards, setDesigningCards] = useState(false);
  const [designProgress, setDesignProgress] = useState<ProjectDesignProgress | null>(null);
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null);
  const [sessionAddress, setSessionAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState<"extract" | "login" | "outline" | "confirm" | "create" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const clientRequestIdRef = useRef<string | null>(null);
  const outlineRequestsRef = useRef(createLatestRequestGate());
  const hasLocalSourceInteractionRef = useRef(false);
  const { address, chainId, isConnected } = useAccount();
  const { connectors, connectAsync } = useConnect();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const loggedIn = Boolean(address && sessionAddress && address.toLowerCase() === sessionAddress);
  const pastedPages = useMemo(() => splitPastedText(text), [text]);
  const pages = sourceMode === "pdf" ? pdfPages : pastedPages;
  const characterCount = pages.reduce((sum, page) => sum + page.text.length, 0);
  const outlinePlanningActive = Boolean(
    outlineOperation && ["QUEUED", "RUNNING", "RETRYABLE"].includes(outlineOperation.status),
  );
  const outlineOperationId = outlineOperation?.operationId ?? null;
  const outlineOperationProjectId = outlineOperation?.projectId ?? null;

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
    setDesignProgress(view.designProgress);
    setCreatedProjectId(isCreatedProjectStatus(view.status) ? view.projectId : null);
  }

  useEffect(() => {
    fetch("/api/auth/session")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { session?: { address?: string } } | null) => setSessionAddress(body?.session?.address ?? null))
      .catch(() => undefined);
  }, []);

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
    const refresh = async () => {
      try {
        const operation = await parseApiResponse<OutlinePlanningOperation>(await fetch(
          `/api/projects/${outlineOperationProjectId}/outline/operation?operationId=${outlineOperationId}`,
          { cache: "no-store" },
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
            { cache: "no-store" },
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
        timer = setTimeout(() => void refresh(), 1_000);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "章节草稿状态读取失败");
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [outlineOperationId, outlineOperationProjectId, sessionAddress]);

  useEffect(() => {
    if (!sessionAddress || !project?.projectId || !designingCards) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const view = await parseApiResponse<ProjectCreationView>(await fetch(
          `/api/projects/${project.projectId}/creation`,
          { cache: "no-store" },
        ));
        if (cancelled) return;
        if (view.projectId !== project.projectId) throw new Error("知识卡设计结果与当前项目不匹配");
        setDesignProgress(view.designProgress);
        if (view.confirmation) {
          setError(null);
          setConfirmation(view.confirmation);
          setDesigningCards(false);
          return;
        }
        if (view.status === "FAILED_RETRYABLE" || view.status === "CANCELLED") {
          setDesigningCards(false);
          setError("知识卡教学设计未完成，请在运行诊断中查看失败任务");
          return;
        }
        timer = setTimeout(() => void refresh(), 1_000);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "教学设计状态读取失败");
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [designingCards, project?.projectId, sessionAddress]);

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
      const verified = await parseApiResponse<AuthVerifyResponse>(await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, signature }),
      }));
      setSessionAddress(verified.address.toLowerCase());
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
    setDesignProgress(null);
    setProposals([]);
    clientRequestIdRef.current = null;
  }

  function changeSourceMode(mode: ProjectSourceMode) {
    setSourceMode(mode);
    setError(null);
    resetOutline();
  }

  async function selectPdf(file: File) {
    setBusy("extract");
    setError(null);
    resetOutline();
    try {
      const extracted = await extractPdfFile(file);
      setPdfPages(extracted);
      setFileName(file.name);
      if (!title.trim()) setTitle(file.name.replace(/\.pdf$/iu, ""));
    } catch (caught) {
      setPdfPages([]);
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
        window.history.replaceState(null, "", `?project=${operation.projectId}${folderId ? `&folder=${folderId}` : ""}`);
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
      setDesignProgress({ completedChapters: 0, totalChapters: result.chapterCount, failedChapters: 0 });
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
      if (!view.confirmation) throw new Error("Project 尚未准备好进行 Monad 登记");

      if (chainId !== monadChain.id) await switchChainAsync({ chainId: monadChain.id });
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
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Monad 交易失败");
    } finally {
      setBusy(null);
    }
  }

  if (createdProjectId) {
    return (
      <main className="min-h-screen bg-[var(--background)] px-5 py-12 text-[var(--ink)] md:px-8">
        <div className="mx-auto max-w-2xl border border-[var(--success-line)] bg-[var(--success-soft)] p-8">
          <Check className="size-8 text-[var(--success)]" />
          <p className="section-kicker mt-6">Project Created</p>
          <h1 className="font-display mt-2 text-3xl font-semibold">章节已经登记，Worker 即将开始生成</h1>
          <p className="mt-4 text-sm leading-7 text-[var(--muted)]">你可以先回到项目列表。Chapter 会独立进入可学习状态。</p>
          <a href={`/learn/projects/${createdProjectId}`} className="command-button command-button-dark mt-7">打开 Project <ChevronRight className="size-4" /></a>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--ink)]">
      <header className="border-b border-[var(--line)] bg-white">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 md:px-8">
          <a href="/learn" className="flex items-center gap-3 text-sm font-semibold"><ArrowLeft className="size-4" />返回项目</a>
          <button type="button" onClick={() => void connectAndSignIn()} disabled={Boolean(busy)} className="command-button command-button-dark">
            {busy === "login" ? <LoaderCircle className="size-4 animate-spin" /> : <Wallet className="size-4" />}
            {loggedIn ? "已登录" : isConnected ? "完成登录" : "连接并登录"}
          </button>
        </div>
      </header>
      <div className="mx-auto grid max-w-6xl gap-8 px-5 py-10 md:px-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section>
          <p className="section-kicker">Chapter-first Project</p>
          <h1 className="font-display mt-2 text-4xl font-semibold">先整理章节，再生成知识卡</h1>
          <p className="mt-4 max-w-2xl text-sm leading-7 text-[var(--muted)]">AI 只负责理解资料结构。你确认章节后，系统才会冻结承诺并创建 Monad Project。</p>
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
            {!project ? <button type="button" onClick={() => void generateOutline()} disabled={Boolean(busy) || outlinePlanningActive} className="command-button command-button-accent"><Sparkles className="size-4" />{busy === "outline" || outlinePlanningActive ? "正在生成章节草稿" : outlineOperation?.status === "FAILED" ? "重新分析资料结构" : "分析资料结构"}<ChevronRight className="size-4" /></button> : null}
            {outlinePlanningActive ? <p className="text-sm leading-6 text-[var(--muted)]">Runner 正在整理章节结构（第 {outlineOperation?.attempt ?? 0} 次）。</p> : null}
          </div>
        </section>
        <aside className="border-l border-[var(--line)] bg-[var(--paper)] p-6">
          <div className="flex items-center justify-between"><p className="section-kicker">Outline Review</p>{project ? <span className="font-mono text-xs text-[var(--muted)]">v{project.outlineVersion}</span> : null}</div>
          {!project ? <p className="mt-8 text-sm leading-7 text-[var(--muted)]">章节草稿会显示在这里。你可以重命名、拆分或删除章节，但必须覆盖全部资料范围。</p> : (
            <>
              <div className="mt-6 space-y-3">
                {proposals.map((proposal, index) => (
                  <div key={`${index}-${proposal.startBlock}`} className="border border-[var(--line-strong)] bg-white p-4">
                    <div className="flex items-start gap-3"><span className="font-mono text-xs text-[var(--accent)]">{String(index + 1).padStart(2, "0")}</span><div className="min-w-0 flex-1 space-y-2"><input className="w-full border-0 border-b border-[var(--line)] bg-transparent px-0 py-1 text-sm font-semibold outline-none" value={proposal.title} onChange={(event) => updateProposal(index, { title: event.target.value })} /><textarea className="w-full resize-none border-0 bg-transparent px-0 py-1 text-xs leading-5 text-[var(--muted)] outline-none" rows={2} value={proposal.summary} onChange={(event) => updateProposal(index, { summary: event.target.value })} /><p className="font-mono text-[10px] text-[var(--muted)]">blocks {proposal.startBlock}–{proposal.endBlock}</p></div></div>
                    <div className="mt-3 flex items-center gap-3"><button type="button" onClick={() => splitProposal(index)} className="text-command text-xs"><Plus className="size-3" />拆分</button><button type="button" onClick={() => mergeProposal(index)} disabled={proposals.length <= 1} className="text-command text-xs">合并</button>{index < proposals.length - 1 ? <><button type="button" onClick={() => moveBoundary(index, -1)} className="icon-button size-7" aria-label="分界向前" title="分界向前"><ArrowLeft className="size-3" /></button><button type="button" onClick={() => moveBoundary(index, 1)} className="icon-button size-7" aria-label="分界向后" title="分界向后"><ArrowRight className="size-3" /></button></> : null}</div>
                  </div>
                ))}
              </div>
              <div className="mt-6 border-t border-[var(--line)] pt-5"><button type="button" onClick={() => void confirmOutline()} disabled={Boolean(busy) || proposals.length === 0 || Boolean(confirmation) || designingCards} className="command-button command-button-dark w-full">{busy === "confirm" || designingCards ? <LoaderCircle className="size-4 animate-spin" /> : <Check className="size-4" />}{confirmation ? "章节已确认" : designingCards ? "正在设计知识卡" : "确认章节"}</button></div>
              {designingCards ? <div className="mt-5 border border-[var(--line-strong)] bg-white p-4"><p className="text-sm font-semibold">正在规划章节知识结构</p><p className="mt-2 text-xs leading-5 text-[var(--muted)]">已完成 {designProgress?.completedChapters ?? 0} / {designProgress?.totalChapters ?? proposals.length} 个章节</p></div> : null}
              {confirmation ? <div className="mt-5 border border-[var(--success-line)] bg-[var(--success-soft)] p-4"><p className="text-sm font-semibold text-[var(--success)]">章节结构已确认</p><p className="mt-2 text-xs leading-5 text-[var(--muted)]">共 {confirmation.chapterCount} 个章节，确认上链后开始生成知识卡。</p><button type="button" onClick={() => void createOnMonad()} disabled={Boolean(busy)} className="command-button command-button-accent mt-4 w-full">{busy === "create" ? <LoaderCircle className="size-4 animate-spin" /> : <ChevronRight className="size-4" />}在 Monad 创建 Project</button></div> : null}
            </>
          )}
        </aside>
      </div>
    </main>
  );
}
