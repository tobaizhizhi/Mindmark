"use client";

import type {
  AuthNonceResponse,
  AuthVerifyResponse,
  DocumentLibraryResponse,
  FolderMutationResponse,
  LibraryDocument,
  LibraryFolder,
} from "@mindmark/shared";
import {
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Library,
  LoaderCircle,
  LogOut,
  Menu,
  MoreHorizontal,
  Move,
  PackageOpen,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Upload,
  Wallet,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, useConnect, useDisconnect, useSignMessage, useSwitchChain } from "wagmi";
import { monadChain } from "@/lib/client/chain";
import { parseApiResponse as parseApi } from "@/lib/client/http";
import { createWalletSignInMessage } from "@/lib/client/wallet-auth";
import { LearningPrimaryNavigation, type PrimaryNavigationTarget } from "@/components/learning-primary-navigation";

type WalletSessionResponse = {
  session: { address: string; expiresAt?: string } | null;
};
type SortMode = "updated" | "name";

const projectStatusLabels: Record<string, string> = {
  UPLOADED: "待分析",
  OUTLINING: "分析中",
  OUTLINE_READY: "待确认章节",
  AWAITING_REGISTRY: "待登记",
  GENERATING: "生成知识卡",
  FINALIZING: "整理知识卡",
  READY: "可学习",
  FAILED_RETRYABLE: "需要重试",
};

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function documentName(document: LibraryDocument): string {
  return document.sourceFilename ?? document.title;
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function statusClass(status: string): string {
  if (status === "READY") return "library-status-ready";
  if (status === "FAILED_RETRYABLE") return "library-status-error";
  if (["GENERATING", "FINALIZING", "OUTLINING"].includes(status)) return "library-status-working";
  return "library-status-muted";
}

function FolderTree({
  folders,
  parentId,
  currentFolderId,
  depth = 0,
  onOpen,
}: {
  folders: LibraryFolder[];
  parentId: string | null;
  currentFolderId: string | null;
  depth?: number;
  onOpen: (folderId: string) => void;
}) {
  return folders
    .filter((folder) => folder.parentFolderId === parentId)
    .map((folder) => {
      const children = folders.some((candidate) => candidate.parentFolderId === folder.folderId);
      const active = currentFolderId === folder.folderId;
      return (
        <div key={folder.folderId}>
          <button
            type="button"
            className="library-tree-row"
            data-active={active}
            style={{ paddingLeft: `${14 + depth * 16}px` }}
            onClick={() => onOpen(folder.folderId)}
            title={folder.name}
          >
            {children ? <ChevronRight className="library-tree-chevron" /> : <span className="library-tree-chevron" />}
            {active ? <FolderOpen /> : <Folder />}
            <span>{folder.name}</span>
            <small>{folder.documentCount}</small>
          </button>
          <FolderTree
            folders={folders}
            parentId={folder.folderId}
            currentFolderId={currentFolderId}
            depth={depth + 1}
            onOpen={onOpen}
          />
        </div>
      );
    });
}

export function DocumentLibraryWorkspace() {
  const router = useRouter();
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [localError, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [dueOnly, setDueOnly] = useState(false);
  const [sort, setSort] = useState<SortMode>("updated");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folderBusy, setFolderBusy] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [moveDocument, setMoveDocument] = useState<LibraryDocument | null>(null);
  const [moveFolderId, setMoveFolderId] = useState<string>("");
  const [deleteDocument, setDeleteDocument] = useState<LibraryDocument | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<LibraryFolder | null>(null);
  const [deleteFolderBusy, setDeleteFolderBusy] = useState(false);
  const queryClient = useQueryClient();
  const { address, chainId, isConnected } = useAccount();
  const { connectors, connectAsync } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();
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
  const loggedIn = Boolean(sessionAddress);
  const libraryQuery = useQuery({
    queryKey: ["document-library", currentFolderId],
    queryFn: ({ signal }) => {
      const suffix = currentFolderId ? `?folderId=${encodeURIComponent(currentFolderId)}` : "";
      return fetch(`/api/library${suffix}`, { signal })
        .then((response) => parseApi<DocumentLibraryResponse>(response));
    },
    retry: false,
    staleTime: 10_000,
  });
  const library = libraryQuery.data ?? null;
  const loading = libraryQuery.isPending;
  const error = localError
    ?? (sessionQuery.error instanceof Error ? sessionQuery.error.message : null)
    ?? (loggedIn && libraryQuery.error instanceof Error ? libraryQuery.error.message : null);

  useEffect(() => {
    void Promise.resolve().then(() => {
      const params = new URLSearchParams(window.location.search);
      setCurrentFolderId(params.get("folder") || null);
      setDueOnly(params.get("filter") === "due");
    });
  }, []);

  function refreshLibrary() {
    void queryClient.invalidateQueries({ queryKey: ["document-library"] });
  }

  const currentFolder = library?.folders.find((folder) => folder.folderId === currentFolderId) ?? null;
  const childFolders = useMemo(() => (library?.folders ?? []).filter((folder) => (
    folder.parentFolderId === currentFolderId
  )), [library, currentFolderId]);
  const deleteFolderChildCount = deleteFolderTarget
    ? library?.folders.filter((folder) => folder.parentFolderId === deleteFolderTarget.folderId).length ?? 0
    : 0;
  const deleteFolderEmpty = Boolean(
    deleteFolderTarget
    && deleteFolderTarget.documentCount === 0
    && deleteFolderChildCount === 0,
  );
  const folderTrail = useMemo(() => {
    if (!library || !currentFolderId) return [];
    const result: LibraryFolder[] = [];
    let cursor: string | null = currentFolderId;
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const folder = library.folders.find((candidate) => candidate.folderId === cursor);
      if (!folder) break;
      result.unshift(folder);
      cursor = folder.parentFolderId;
    }
    return result;
  }, [library, currentFolderId]);

  const visibleFolders = useMemo(() => {
    if (dueOnly) return [];
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return childFolders.filter((folder) => !normalized || folder.name.toLocaleLowerCase("zh-CN").includes(normalized));
  }, [childFolders, dueOnly, query]);

  const visibleDocuments = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    const rows = (library?.documents ?? []).filter((document) => {
      if (normalized && !`${document.title} ${documentName(document)}`.toLocaleLowerCase("zh-CN").includes(normalized)) return false;
      if (dueOnly && document.dueCount === 0) return false;
      return true;
    });
    return [...rows].sort((left, right) => sort === "name"
      ? documentName(left).localeCompare(documentName(right), "zh-CN")
      : Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }, [library, dueOnly, query, sort]);
  async function signIn(walletAddress: string, walletChainId: number | undefined) {
    if (walletChainId !== monadChain.id) await switchChainAsync({ chainId: monadChain.id });
    const nonce = await parseApi<AuthNonceResponse>(await fetch("/api/auth/nonce", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: walletAddress }),
    }));
    const message = createWalletSignInMessage({
      address: walletAddress,
      nonce,
    });
    const signature = await signMessageAsync({ message });
    const verified = await parseApi<AuthVerifyResponse>(await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, signature }),
    }));
    queryClient.setQueryData<WalletSessionResponse>(["wallet-session"], {
      session: { address: verified.address.toLowerCase(), expiresAt: verified.expiresAt },
    });
    void queryClient.invalidateQueries({ queryKey: ["document-library"] });
  }

  async function handleAuth() {
    setAuthBusy(true);
    setError(null);
    try {
      if (loggedIn) {
        await fetch("/api/auth/logout", { method: "POST" });
        queryClient.setQueryData<WalletSessionResponse>(["wallet-session"], { session: null });
        queryClient.removeQueries({ predicate: (query) => (
          typeof query.queryKey[0] === "string"
          && (query.queryKey[0].startsWith("learning-") || query.queryKey[0].startsWith("document-library"))
        ) });
        await disconnectAsync();
        return;
      }
      if (isConnected && address) return await signIn(address, chainId);
      const connector = connectors[0];
      if (!connector) throw new Error("未检测到浏览器钱包");
      const connection = await connectAsync({ connector, chainId: monadChain.id });
      await signIn(connection.accounts[0], connection.chainId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "钱包登录失败");
    } finally {
      setAuthBusy(false);
    }
  }

  function openFolder(folderId: string | null) {
    setDueOnly(false);
    const url = folderId ? `/learn?folder=${encodeURIComponent(folderId)}` : "/learn";
    if (folderId === currentFolderId) {
      setSidebarOpen(false);
      setOpenMenuId(null);
      window.history.pushState(null, "", url);
      return;
    }
    setError(null);
    setCurrentFolderId(folderId);
    setSidebarOpen(false);
    setOpenMenuId(null);
    window.history.pushState(null, "", url);
  }

  function openDocument(document: LibraryDocument) {
    if (["UPLOADED", "OUTLINING", "OUTLINE_READY"].includes(document.status)) {
      router.push(`/learn/projects/new?project=${document.projectId}${document.folderId ? `&folder=${document.folderId}` : ""}`);
      return;
    }
    router.push(`/learn/projects/${document.projectId}`);
  }

  function uploadHref(): string {
    return currentFolderId ? `/learn/projects/new?folder=${currentFolderId}` : "/learn/projects/new";
  }

  function navigatePrimary(target: PrimaryNavigationTarget) {
    if (target === "library") {
      setDueOnly(false);
      openFolder(null);
      return;
    }
    if (target === "review") {
      setDueOnly(true);
      setCurrentFolderId(null);
      setSidebarOpen(false);
      setOpenMenuId(null);
      window.history.pushState(null, "", "/learn?filter=due");
      return;
    }
    router.push(target === "packs" ? "/learn/packs" : uploadHref());
  }

  async function createFolder() {
    if (!folderName.trim()) return;
    setFolderBusy(true);
    setError(null);
    try {
      await parseApi<FolderMutationResponse>(await fetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: folderName, parentFolderId: currentFolderId }),
      }));
      setFolderName("");
      setFolderDialogOpen(false);
      refreshLibrary();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "文件夹创建失败");
    } finally {
      setFolderBusy(false);
    }
  }

  async function renameFolder(folder: LibraryFolder) {
    const name = window.prompt("文件夹名称", folder.name)?.trim();
    if (!name || name === folder.name) return;
    setOpenMenuId(null);
    try {
      await parseApi(await fetch(`/api/folders/${folder.folderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }));
      refreshLibrary();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "文件夹重命名失败");
    }
  }

  function requestFolderDeletion(folder: LibraryFolder) {
    setError(null);
    setOpenMenuId(null);
    setDeleteFolderTarget(folder);
  }

  async function deleteSelectedFolder() {
    if (!deleteFolderTarget) return;
    setDeleteFolderBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/folders/${deleteFolderTarget.folderId}`, { method: "DELETE" });
      if (!response.ok) await parseApi(response);
      setDeleteFolderTarget(null);
      refreshLibrary();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "文件夹删除失败");
    } finally {
      setDeleteFolderBusy(false);
    }
  }

  async function moveSelectedDocument() {
    if (!moveDocument) return;
    const target = moveFolderId || null;
    setFolderBusy(true);
    try {
      await parseApi(await fetch(`/api/projects/${moveDocument.projectId}/folder`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId: target }),
      }));
      setMoveDocument(null);
      setMoveFolderId("");
      refreshLibrary();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "资料移动失败");
    } finally {
      setFolderBusy(false);
    }
  }

  function requestDocumentDeletion(document: LibraryDocument) {
    setError(null);
    setOpenMenuId(null);
    setDeleteDocument(document);
  }

  async function deleteSelectedDocument() {
    if (!deleteDocument) return;
    const projectId = deleteDocument.projectId;
    setDeleteBusy(true);
    setError(null);
    try {
      await parseApi<{ deleted: true }>(await fetch(`/api/projects/${projectId}`, {
        method: "DELETE",
      }));
      queryClient.setQueriesData<DocumentLibraryResponse>(
        { queryKey: ["document-library"] },
        (cached) => cached ? {
          ...cached,
          documents: cached.documents.filter((document) => document.projectId !== projectId),
        } : cached,
      );
      queryClient.removeQueries({
        predicate: (cachedQuery) => cachedQuery.queryKey.some((part) => part === projectId),
      });
      setDeleteDocument(null);
      void queryClient.invalidateQueries({ queryKey: ["document-library"] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "资料删除失败");
    } finally {
      setDeleteBusy(false);
    }
  }

  const sidebar = (
    <LearningPrimaryNavigation
      variant="expanded"
      active={dueOnly ? "review" : "library"}
      open={sidebarOpen}
      onNavigate={navigatePrimary}
      onClose={() => setSidebarOpen(false)}
      footer={<><button type="button" disabled><Settings /><span>设置</span></button><button type="button" onClick={() => void handleAuth()} disabled={authBusy}>{authBusy ? <LoaderCircle className="animate-spin" /> : loggedIn ? <LogOut /> : <Wallet />}<span>{loggedIn && sessionAddress ? shortAddress(sessionAddress) : "连接钱包"}</span></button></>}
    >
      <div className="library-folder-tree">
        <div className="library-sidebar-label"><span>文件夹</span><button type="button" onClick={() => setFolderDialogOpen(true)} aria-label="新建文件夹" title="新建文件夹"><FolderPlus /></button></div>
        <button type="button" className="library-tree-row library-tree-root" data-active={currentFolderId === null} onClick={() => openFolder(null)}>
          <span className="library-tree-chevron" />
          {currentFolderId === null ? <FolderOpen /> : <Folder />}
          <span>全部资料</span>
        </button>
        <FolderTree folders={library?.folders ?? []} parentId={null} currentFolderId={currentFolderId} onOpen={(id) => openFolder(id)} />
      </div>
    </LearningPrimaryNavigation>
  );

  return (
    <main className="library-shell">
      {sidebar}
      {sidebarOpen ? <button type="button" className="library-sidebar-scrim" aria-label="关闭导航" onClick={() => setSidebarOpen(false)} /> : null}
      <section className="library-main">
        <header className="library-mobile-header">
          <button type="button" onClick={() => setSidebarOpen(true)} aria-label="打开导航" title="打开导航"><Menu /></button>
          <strong>Mindmark</strong>
          <span className="library-mobile-header-spacer" aria-hidden="true" />
        </header>

        {!loggedIn ? (
          <div className="library-auth-state">
            <span><Library /></span>
            <h1>打开你的资料库</h1>
            <p>连接钱包后，PDF、文件夹和章节学习进度会显示在这里。</p>
            {error ? <div className="library-error">{error}</div> : null}
            <button type="button" className="command-button command-button-dark" onClick={() => void handleAuth()} disabled={authBusy}>
              {authBusy ? <LoaderCircle className="size-4 animate-spin" /> : <Wallet className="size-4" />}连接并登录
            </button>
          </div>
        ) : (
          <div className="library-content">
            <header className="library-contextbar">
              <div className="library-context-title">
                <div className="library-breadcrumbs">
                  <button type="button" onClick={() => openFolder(null)}>资料库</button>
                  {folderTrail.map((folder) => <span key={folder.folderId}><ChevronRight /><button type="button" onClick={() => openFolder(folder.folderId)}>{folder.name}</button></span>)}
                </div>
                <h1 title={currentFolder?.name ?? "资料和文件夹"}>{currentFolder?.name ?? "资料和文件夹"}</h1>
              </div>
              <label className="library-search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前文件夹" /></label>
              <label className="library-sort"><span>排序</span><select value={sort} onChange={(event) => setSort(event.target.value as SortMode)}><option value="updated">最近更新</option><option value="name">名称</option></select><ChevronDown /></label>
              <div className="library-context-actions"><button type="button" className="icon-button" onClick={() => setFolderDialogOpen(true)} aria-label="新建文件夹" title="新建文件夹"><FolderPlus /></button><button type="button" className="icon-button" onClick={() => { setError(null); void libraryQuery.refetch(); }} aria-label="刷新资料库" title="刷新资料库"><RefreshCw className={libraryQuery.isFetching ? "animate-spin" : undefined} /></button><button type="button" className="command-button command-button-accent" onClick={() => router.push(uploadHref())}><Upload />上传 PDF</button></div>
            </header>

            {error ? <div className="library-error"><span>{error}</span><button type="button" onClick={() => { setError(null); void libraryQuery.refetch(); }}>重试</button></div> : null}

            <div className="library-table" aria-busy={libraryQuery.isFetching}>
              <div className="library-table-head"><span>名称</span><span>学习进度</span><span>更新于</span><span /></div>
              {loading && !library ? Array.from({ length: 6 }, (_, index) => <div className="library-row library-row-loading" key={index}><span /><span /><span /></div>) : null}

              {library && visibleFolders.map((folder) => (
                <div className="library-row library-folder-row" key={folder.folderId}>
                  <button type="button" className="library-row-primary" onClick={() => openFolder(folder.folderId)}>
                    <span className="library-file-icon library-folder-icon"><Folder /></span>
                    <span className="library-file-copy"><strong>{folder.name}</strong><small>文件夹 · {folder.documentCount} 份资料</small></span>
                    <ChevronRight className="library-row-open-icon" aria-hidden="true" />
                  </button>
                  <span className="library-row-progress">{folder.documentCount ? `${folder.documentCount} 个学习项目` : "空文件夹"}</span>
                  <time>{formatUpdatedAt(folder.updatedAt)}</time>
                  <div className="library-row-menu">
                    <button type="button" aria-expanded={openMenuId === folder.folderId} onClick={() => setOpenMenuId(openMenuId === folder.folderId ? null : folder.folderId)} aria-label={`${folder.name} 更多操作`} title="更多操作"><MoreHorizontal /></button>
                    {openMenuId === folder.folderId ? <div className="library-menu"><button type="button" onClick={() => void renameFolder(folder)}>重命名</button><button type="button" className="danger" onClick={() => requestFolderDeletion(folder)}><Trash2 />删除文件夹</button></div> : null}
                  </div>
                </div>
              ))}

              {library && visibleDocuments.map((document) => {
                const percent = document.chapterCount ? Math.round(document.readyChapterCount * 100 / document.chapterCount) : 0;
                return (
                  <div className="library-row library-document-row" key={document.projectId}>
                    <button type="button" className="library-row-primary" onClick={() => openDocument(document)}>
                      <span className={`library-file-icon ${document.projectKind === "PACK" ? "library-pack-icon" : "library-pdf-icon"}`}>{document.projectKind === "PACK" ? <PackageOpen /> : <FileText />}<b>{document.projectKind === "PACK" ? "PACK" : "PDF"}</b></span>
                      <span className="library-file-copy"><strong>{documentName(document)}</strong><small>{document.projectKind === "PACK" ? `${document.chapterCount} 章 · ${document.cardCount} 张知识卡` : <>{document.title}{document.sourcePageCount ? ` · ${document.sourcePageCount} 页` : ""}</>}</small></span>
                      <ChevronRight className="library-row-open-icon" aria-hidden="true" />
                    </button>
                    <button type="button" className="library-row-progress library-document-progress" onClick={() => openDocument(document)}>
                      <span><i style={{ width: `${percent}%` }} /></span>
                      <small>{document.chapterCount ? `${document.readyChapterCount}/${document.chapterCount} 章节` : projectStatusLabels[document.status]}</small>
                      {document.dueCount > 0 ? <b>{document.dueCount} 待复习</b> : null}
                    </button>
                    <time>{formatUpdatedAt(document.updatedAt)}<small className={statusClass(document.status)}><i aria-hidden="true" />{projectStatusLabels[document.status] ?? document.status}</small></time>
                    <div className="library-row-menu">
                      <button type="button" aria-expanded={openMenuId === document.projectId} onClick={() => setOpenMenuId(openMenuId === document.projectId ? null : document.projectId)} aria-label={`${documentName(document)} 更多操作`} title="更多操作"><MoreHorizontal /></button>
                      {openMenuId === document.projectId ? <div className="library-menu"><button type="button" onClick={() => openDocument(document)}><BookOpen />打开章节</button><button type="button" onClick={() => { setMoveDocument(document); setMoveFolderId(document.folderId ?? ""); setOpenMenuId(null); }}><Move />移动到</button><button type="button" className="danger" onClick={() => requestDocumentDeletion(document)}><Trash2 />删除资料</button></div> : null}
                    </div>
                  </div>
                );
              })}

              {!loading && library && visibleFolders.length === 0 && visibleDocuments.length === 0 ? (
                <div className="library-empty"><FolderOpen /><h2>{query ? "没有匹配的资料" : dueOnly ? "今天没有待复习资料" : "这个文件夹还是空的"}</h2><p>{query ? "换一个关键词再试。" : dueOnly ? "有知识卡到期后会显示在这里。" : "上传 PDF，系统会先分析成章节，再为每章生成知识卡。"}</p>{!query && !dueOnly ? <button type="button" className="command-button command-button-accent" onClick={() => router.push(uploadHref())}><FilePlus2 />上传 PDF</button> : null}</div>
              ) : null}
            </div>
          </div>
        )}
      </section>

      {folderDialogOpen ? (
        <div className="library-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setFolderDialogOpen(false); }}>
          <form className="library-dialog" onSubmit={(event) => { event.preventDefault(); void createFolder(); }}>
            <div className="library-dialog-icon"><FolderPlus /></div>
            <div><h2>新建文件夹</h2><p>{currentFolder ? `创建在“${currentFolder.name}”中` : "创建在资料库根目录"}</p></div>
            <label><span>文件夹名称</span><input autoFocus value={folderName} onChange={(event) => setFolderName(event.target.value)} maxLength={100} placeholder="例如：Solidity 安全" /></label>
            <div className="library-dialog-actions"><button type="button" className="command-button command-button-quiet" onClick={() => setFolderDialogOpen(false)}>取消</button><button type="submit" className="command-button command-button-accent" disabled={folderBusy || !folderName.trim()}>{folderBusy ? <LoaderCircle className="animate-spin" /> : <Check />}创建</button></div>
          </form>
        </div>
      ) : null}

      {moveDocument ? (
        <div className="library-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setMoveDocument(null); }}>
          <form className="library-dialog" onSubmit={(event) => { event.preventDefault(); void moveSelectedDocument(); }}>
            <div className="library-dialog-icon"><Move /></div>
            <div><h2>移动资料</h2><p className="truncate">{documentName(moveDocument)}</p></div>
            <label><span>目标文件夹</span><select autoFocus value={moveFolderId} onChange={(event) => setMoveFolderId(event.target.value)}><option value="">资料库根目录</option>{library?.folders.map((folder) => <option key={folder.folderId} value={folder.folderId}>{folder.name}</option>)}</select></label>
            <div className="library-dialog-actions"><button type="button" className="command-button command-button-quiet" onClick={() => setMoveDocument(null)}>取消</button><button type="submit" className="command-button command-button-accent" disabled={folderBusy}>{folderBusy ? <LoaderCircle className="animate-spin" /> : <Move />}移动</button></div>
          </form>
        </div>
      ) : null}

      {deleteFolderTarget ? (
        <div className="library-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (!deleteFolderBusy && event.target === event.currentTarget) setDeleteFolderTarget(null); }}>
          <form className="library-dialog library-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-folder-title" onSubmit={(event) => { event.preventDefault(); if (deleteFolderEmpty) void deleteSelectedFolder(); }}>
            <div className="library-dialog-icon library-dialog-icon-danger"><Trash2 /></div>
            <div><h2 id="delete-folder-title">{deleteFolderEmpty ? "删除这个文件夹？" : "这个文件夹还不能删除"}</h2><p className="truncate">{deleteFolderTarget.name}</p></div>
            <div className="library-delete-warning">
              <strong>{deleteFolderEmpty ? "此操作无法撤销" : "请先清空文件夹"}</strong>
              {deleteFolderEmpty ? <p>这里只会删除空文件夹，不会影响资料库里的其他内容。</p> : <ul>
                {deleteFolderTarget.documentCount > 0 ? <li>包含 {deleteFolderTarget.documentCount} 份资料，请先移动或删除</li> : null}
                {deleteFolderChildCount > 0 ? <li>包含 {deleteFolderChildCount} 个子文件夹，请先清空并删除</li> : null}
              </ul>}
            </div>
            {localError ? <div className="library-delete-error">{localError}</div> : null}
            <div className="library-dialog-actions"><button type="button" className="command-button command-button-quiet" disabled={deleteFolderBusy} onClick={() => setDeleteFolderTarget(null)}>{deleteFolderEmpty ? "取消" : "关闭"}</button>{deleteFolderEmpty ? <button type="submit" className="command-button command-button-danger" disabled={deleteFolderBusy}>{deleteFolderBusy ? <LoaderCircle className="animate-spin" /> : <Trash2 />}确认删除</button> : null}</div>
          </form>
        </div>
      ) : null}

      {deleteDocument ? (
        <div className="library-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (!deleteBusy && event.target === event.currentTarget) setDeleteDocument(null); }}>
          <form className="library-dialog library-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-document-title" onSubmit={(event) => { event.preventDefault(); void deleteSelectedDocument(); }}>
            <div className="library-dialog-icon library-dialog-icon-danger"><Trash2 /></div>
            <div><h2 id="delete-document-title">删除这份资料？</h2><p className="truncate">{documentName(deleteDocument)}</p></div>
            <div className="library-delete-warning">
              <strong>此操作无法撤销</strong>
              <ul>
                <li>{deleteDocument.projectKind === "PACK" ? "删除已安装的卡包副本、章节和知识卡" : "删除原始 PDF、章节和知识卡"}</li>
                <li>删除这份资料的学习记录和复习进度</li>
                {deleteDocument.projectKind === "PACK" ? <li>公共卡包本身不会被删除，之后仍可重新添加</li> : null}
                {["OUTLINING", "GENERATING", "FINALIZING"].includes(deleteDocument.status) ? <li>当前生成流程会停止保存后续结果</li> : null}
                <li>Monad 上已经确认的交易记录不会被撤回</li>
              </ul>
            </div>
            {localError ? <div className="library-delete-error">{localError}</div> : null}
            <div className="library-dialog-actions"><button type="button" className="command-button command-button-quiet" disabled={deleteBusy} onClick={() => setDeleteDocument(null)}>取消</button><button type="submit" className="command-button command-button-danger" disabled={deleteBusy}>{deleteBusy ? <LoaderCircle className="animate-spin" /> : <Trash2 />}确认删除</button></div>
          </form>
        </div>
      ) : null}
    </main>
  );
}
