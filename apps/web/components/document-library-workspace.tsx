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
  Clock3,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  LayoutGrid,
  Library,
  LoaderCircle,
  LogOut,
  Menu,
  MoreHorizontal,
  Move,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Upload,
  Wallet,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { SiweMessage } from "siwe";
import { useAccount, useConnect, useDisconnect, useSignMessage, useSwitchChain } from "wagmi";
import { monadChain } from "@/lib/client/chain";

type ApiErrorBody = { error?: { message?: string } };
type LibraryFilter = "all" | "folders" | "pdf" | "ready" | "due";
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

async function parseApi<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & ApiErrorBody;
  if (!response.ok) throw new Error(body.error?.message ?? "请求失败");
  return body;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function documentName(document: LibraryDocument): string {
  return document.sourceFilename ?? `${document.title}.pdf`;
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
  const [sessionAddress, setSessionAddress] = useState<string | null>(null);
  const [library, setLibrary] = useState<DocumentLibraryResponse | null>(null);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [sort, setSort] = useState<SortMode>("updated");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folderBusy, setFolderBusy] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [moveDocument, setMoveDocument] = useState<LibraryDocument | null>(null);
  const [moveFolderId, setMoveFolderId] = useState<string>("");
  const { address, chainId, isConnected } = useAccount();
  const { connectors, connectAsync } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const { switchChainAsync } = useSwitchChain();
  const loggedIn = Boolean(address && sessionAddress && address.toLowerCase() === sessionAddress);

  useEffect(() => {
    fetch("/api/auth/session")
      .then((response) => response.ok ? response.json() : null)
      .then((body: { session?: { address?: string } } | null) => {
        setCurrentFolderId(new URLSearchParams(window.location.search).get("folder") || null);
        setSessionAddress(body?.session?.address ?? null);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!loggedIn) return;
    let active = true;
    const suffix = currentFolderId ? `?folderId=${encodeURIComponent(currentFolderId)}` : "";
    void fetch(`/api/library${suffix}`)
      .then((response) => parseApi<DocumentLibraryResponse>(response))
      .then((response) => { if (active) setLibrary(response); })
      .catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : "资料库加载失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [loggedIn, currentFolderId, refreshToken]);

  const currentFolder = library?.folders.find((folder) => folder.folderId === currentFolderId) ?? null;
  const childFolders = useMemo(() => (library?.folders ?? []).filter((folder) => (
    folder.parentFolderId === currentFolderId
  )), [library, currentFolderId]);
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
    if (filter === "pdf" || filter === "ready" || filter === "due") return [];
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return childFolders.filter((folder) => !normalized || folder.name.toLocaleLowerCase("zh-CN").includes(normalized));
  }, [childFolders, filter, query]);

  const visibleDocuments = useMemo(() => {
    if (filter === "folders") return [];
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    const rows = (library?.documents ?? []).filter((document) => {
      if (normalized && !`${document.title} ${documentName(document)}`.toLocaleLowerCase("zh-CN").includes(normalized)) return false;
      if (filter === "ready" && document.status !== "READY") return false;
      if (filter === "due" && document.dueCount === 0) return false;
      return true;
    });
    return [...rows].sort((left, right) => sort === "name"
      ? documentName(left).localeCompare(documentName(right), "zh-CN")
      : Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }, [library, filter, query, sort]);

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
    setError(null);
    try {
      if (loggedIn) {
        await fetch("/api/auth/logout", { method: "POST" });
        setSessionAddress(null);
        setLibrary(null);
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
    if (folderId === currentFolderId) {
      setSidebarOpen(false);
      setOpenMenuId(null);
      return;
    }
    setLoading(true);
    setError(null);
    setCurrentFolderId(folderId);
    setSidebarOpen(false);
    setOpenMenuId(null);
    const url = folderId ? `/learn?folder=${encodeURIComponent(folderId)}` : "/learn";
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
      setRefreshToken((value) => value + 1);
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
      setRefreshToken((value) => value + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "文件夹重命名失败");
    }
  }

  async function deleteFolder(folder: LibraryFolder) {
    if (!window.confirm(`删除空文件夹“${folder.name}”？`)) return;
    setOpenMenuId(null);
    try {
      const response = await fetch(`/api/folders/${folder.folderId}`, { method: "DELETE" });
      if (!response.ok) await parseApi(response);
      setRefreshToken((value) => value + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "只能删除空文件夹");
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
      setRefreshToken((value) => value + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "资料移动失败");
    } finally {
      setFolderBusy(false);
    }
  }

  const sidebar = (
    <aside className="library-sidebar" data-open={sidebarOpen}>
      <div className="library-brand">
        <span className="library-brand-mark"><BookOpen /></span>
        <div><strong>Mindmark</strong><small>资料学习库</small></div>
        <button type="button" className="library-mobile-close" onClick={() => setSidebarOpen(false)} aria-label="关闭导航" title="关闭导航"><X /></button>
      </div>
      <nav className="library-nav" aria-label="资料库导航">
        <button type="button" data-active={filter === "all"} onClick={() => { setFilter("all"); openFolder(null); }}><Library /><span>资料和文件夹</span></button>
        <button type="button" data-active={filter === "due"} onClick={() => { setFilter("due"); setSidebarOpen(false); }}><Clock3 /><span>今日复习</span></button>
        <button type="button" data-active={filter === "ready"} onClick={() => { setFilter("ready"); setSidebarOpen(false); }}><LayoutGrid /><span>可学习资料</span></button>
        <button type="button" onClick={() => router.push(uploadHref())}><Plus /><span>新建资料</span></button>
      </nav>
      <div className="library-folder-tree">
        <div className="library-sidebar-label"><span>文件夹</span><button type="button" onClick={() => setFolderDialogOpen(true)} aria-label="新建文件夹" title="新建文件夹"><FolderPlus /></button></div>
        <button type="button" className="library-tree-row library-tree-root" data-active={currentFolderId === null} onClick={() => openFolder(null)}>
          <span className="library-tree-chevron" />
          {currentFolderId === null ? <FolderOpen /> : <Folder />}
          <span>全部资料</span>
        </button>
        <FolderTree folders={library?.folders ?? []} parentId={null} currentFolderId={currentFolderId} onOpen={(id) => openFolder(id)} />
      </div>
      <div className="library-sidebar-bottom">
        <button type="button" disabled><Settings /><span>设置</span></button>
        <button type="button" onClick={() => void handleAuth()} disabled={authBusy}>
          {authBusy ? <LoaderCircle className="animate-spin" /> : loggedIn ? <LogOut /> : <Wallet />}
          <span>{loggedIn && address ? shortAddress(address) : "连接钱包"}</span>
        </button>
      </div>
    </aside>
  );

  return (
    <main className="library-shell">
      {sidebar}
      {sidebarOpen ? <button type="button" className="library-sidebar-scrim" aria-label="关闭导航" onClick={() => setSidebarOpen(false)} /> : null}
      <section className="library-main">
        <header className="library-mobile-header">
          <button type="button" onClick={() => setSidebarOpen(true)} aria-label="打开导航" title="打开导航"><Menu /></button>
          <strong>Mindmark</strong>
          <button type="button" onClick={() => router.push(uploadHref())} aria-label="上传 PDF" title="上传 PDF"><Upload /></button>
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
            <div className="library-titlebar">
              <div>
                <div className="library-breadcrumbs">
                  <button type="button" onClick={() => openFolder(null)}>资料库</button>
                  {folderTrail.map((folder) => <span key={folder.folderId}><ChevronRight /><button type="button" onClick={() => openFolder(folder.folderId)}>{folder.name}</button></span>)}
                </div>
                <h1>{currentFolder?.name ?? "资料和文件夹"}</h1>
                <p>{currentFolder ? `${currentFolder.documentCount} 份资料` : "整理资料，然后从 PDF 进入章节学习"}</p>
              </div>
              <div className="library-title-actions">
                <button type="button" className="command-button command-button-quiet" onClick={() => setFolderDialogOpen(true)}><FolderPlus />新建文件夹</button>
                <button type="button" className="command-button command-button-accent" onClick={() => router.push(uploadHref())}><Upload />上传并学习 PDF</button>
              </div>
            </div>

            <div className="library-toolbar">
              <label className="library-search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前文件夹" /></label>
              <div className="library-filters" role="group" aria-label="资料筛选">
                {([ ["all", "全部"], ["folders", "文件夹"], ["pdf", "PDF"], ["ready", "可学习"], ["due", "待复习"] ] as Array<[LibraryFilter, string]>).map(([value, label]) => (
                  <button key={value} type="button" data-active={filter === value} onClick={() => setFilter(value)}>{label}</button>
                ))}
              </div>
              <label className="library-sort"><span>排序</span><select value={sort} onChange={(event) => setSort(event.target.value as SortMode)}><option value="updated">最近更新</option><option value="name">名称</option></select><ChevronDown /></label>
              <button type="button" className="icon-button" onClick={() => { setLoading(true); setError(null); setRefreshToken((value) => value + 1); }} aria-label="刷新资料库" title="刷新资料库"><RefreshCw /></button>
            </div>

            {error ? <div className="library-error"><span>{error}</span><button type="button" onClick={() => { setLoading(true); setError(null); setRefreshToken((value) => value + 1); }}>重试</button></div> : null}

            <div className="library-table" aria-busy={loading}>
              <div className="library-table-head"><span>名称</span><span>学习进度</span><span>更新于</span><span /></div>
              {loading ? Array.from({ length: 6 }, (_, index) => <div className="library-row library-row-loading" key={index}><span /><span /><span /></div>) : null}

              {!loading && visibleFolders.map((folder) => (
                <div className="library-row library-folder-row" key={folder.folderId}>
                  <button type="button" className="library-row-primary" onClick={() => openFolder(folder.folderId)}>
                    <span className="library-file-icon library-folder-icon"><Folder /></span>
                    <span className="library-file-copy"><strong>{folder.name}</strong><small>文件夹 · {folder.documentCount} 份资料</small></span>
                  </button>
                  <span className="library-row-progress">{folder.documentCount ? `${folder.documentCount} 份 PDF` : "空文件夹"}</span>
                  <time>{formatUpdatedAt(folder.updatedAt)}</time>
                  <div className="library-row-menu">
                    <button type="button" onClick={() => setOpenMenuId(openMenuId === folder.folderId ? null : folder.folderId)} aria-label={`${folder.name} 更多操作`} title="更多操作"><MoreHorizontal /></button>
                    {openMenuId === folder.folderId ? <div className="library-menu"><button type="button" onClick={() => void renameFolder(folder)}>重命名</button><button type="button" className="danger" onClick={() => void deleteFolder(folder)}><Trash2 />删除空文件夹</button></div> : null}
                  </div>
                </div>
              ))}

              {!loading && visibleDocuments.map((document) => {
                const percent = document.chapterCount ? Math.round(document.readyChapterCount * 100 / document.chapterCount) : 0;
                return (
                  <div className="library-row library-document-row" key={document.projectId}>
                    <button type="button" className="library-row-primary" onClick={() => openDocument(document)}>
                      <span className="library-file-icon library-pdf-icon"><FileText /><b>PDF</b></span>
                      <span className="library-file-copy"><strong>{documentName(document)}</strong><small>{document.title}{document.sourcePageCount ? ` · ${document.sourcePageCount} 页` : ""}</small></span>
                    </button>
                    <button type="button" className="library-row-progress library-document-progress" onClick={() => openDocument(document)}>
                      <span><i style={{ width: `${percent}%` }} /></span>
                      <small>{document.chapterCount ? `${document.readyChapterCount}/${document.chapterCount} 章节` : projectStatusLabels[document.status]}</small>
                      {document.dueCount > 0 ? <b>{document.dueCount} 待复习</b> : null}
                    </button>
                    <time>{formatUpdatedAt(document.updatedAt)}<small className={statusClass(document.status)}>{projectStatusLabels[document.status] ?? document.status}</small></time>
                    <div className="library-row-menu">
                      <button type="button" onClick={() => setOpenMenuId(openMenuId === document.projectId ? null : document.projectId)} aria-label={`${documentName(document)} 更多操作`} title="更多操作"><MoreHorizontal /></button>
                      {openMenuId === document.projectId ? <div className="library-menu"><button type="button" onClick={() => openDocument(document)}><BookOpen />打开章节</button><button type="button" onClick={() => { setMoveDocument(document); setMoveFolderId(document.folderId ?? ""); setOpenMenuId(null); }}><Move />移动到</button></div> : null}
                    </div>
                  </div>
                );
              })}

              {!loading && visibleFolders.length === 0 && visibleDocuments.length === 0 ? (
                <div className="library-empty"><FolderOpen /><h2>{query || filter !== "all" ? "没有匹配的资料" : "这个文件夹还是空的"}</h2><p>{query || filter !== "all" ? "换一个关键词或筛选条件。" : "上传 PDF，系统会先分析成章节，再为每章生成知识卡。"}</p>{!query && filter === "all" ? <button type="button" className="command-button command-button-accent" onClick={() => router.push(uploadHref())}><FilePlus2 />上传 PDF</button> : null}</div>
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
    </main>
  );
}
