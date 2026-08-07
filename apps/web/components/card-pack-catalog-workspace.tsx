"use client";

import type { CardPackCatalogItem, CardPackCatalogResponse, PublishedCardPack } from "@mindmark/shared";
import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Clock3,
  ExternalLink,
  Layers3,
  LoaderCircle,
  PackageOpen,
  Search,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LearningPrimaryNavigation, type PrimaryNavigationTarget } from "@/components/learning-primary-navigation";
import { parseApiResponse as parseApi } from "@/lib/client/http";

type LevelFilter = "all" | CardPackCatalogItem["level"];

const levelLabels: Record<CardPackCatalogItem["level"], string> = {
  beginner: "入门",
  intermediate: "进阶",
  advanced: "高级",
};

const cardTypeLabels: Record<PublishedCardPack["chapters"][number]["cards"][number]["type"], string> = {
  concept: "概念",
  qa: "问答",
  comparison: "对比",
  process: "流程",
  application: "应用",
  misconception: "误区",
  code_read: "读代码",
  code_write: "写代码",
  code_complete: "补全代码",
  code_debug: "修错",
  output_trace: "运行推理",
  security_review: "安全审查",
};

function PackHeader({ detail = false, meta }: { detail?: boolean; meta?: string }) {
  const router = useRouter();
  function navigatePrimary(target: PrimaryNavigationTarget) {
    if (target === "library") router.push("/learn");
    if (target === "review") router.push("/learn?filter=due");
    if (target === "packs") router.push("/learn/packs");
    if (target === "new") router.push("/learn/projects/new");
  }
  return (
    <><LearningPrimaryNavigation variant="rail" active="packs" onNavigate={navigatePrimary} /><header className="pack-context-header"><div>{detail ? <button type="button" onClick={() => router.push("/learn/packs")} aria-label="返回全部卡包" title="返回全部卡包"><ArrowLeft /></button> : <PackageOpen />}<span><small>{detail ? "卡包详情" : "学习资源"}</small><strong>{detail ? "卡包详情" : "发现卡包"}</strong></span></div>{meta ? <small>{meta}</small> : null}</header></>
  );
}

export function CardPackCatalogWorkspace() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<LevelFilter>("all");
  const catalogQuery = useQuery({
    queryKey: ["card-pack-catalog"],
    queryFn: ({ signal }) => fetch("/api/packs", { signal })
      .then((response) => parseApi<CardPackCatalogResponse>(response)),
    staleTime: 5 * 60_000,
  });
  const catalog = catalogQuery.data ?? null;
  const loading = catalogQuery.isPending;
  const error = catalogQuery.error instanceof Error ? catalogQuery.error.message : null;

  const visiblePacks = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return (catalog?.packs ?? []).filter((pack) => (
      (level === "all" || pack.level === level)
      && (!normalized || `${pack.title} ${pack.description} ${pack.subject}`.toLocaleLowerCase("zh-CN").includes(normalized))
    ));
  }, [catalog, level, query]);

  return (
    <main className="pack-shell">
      <PackHeader meta={catalog ? `${catalog.packs.length} 个卡包` : "正在读取卡包"} />
      <div className="pack-content">
        <div className="pack-toolbar">
          <label className="library-search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索主题或卡包" /></label>
          <div className="library-filters" role="group" aria-label="难度筛选">
            {([ ["all", "全部"], ["beginner", "入门"], ["intermediate", "进阶"], ["advanced", "高级"] ] as Array<[LevelFilter, string]>).map(([value, label]) => (
              <button key={value} type="button" data-active={level === value} onClick={() => setLevel(value)}>{label}</button>
            ))}
          </div>
        </div>

        {error ? <div className="library-error"><span>{error}</span></div> : null}
        <div className="pack-catalog" aria-busy={loading}>
          <div className="pack-catalog-head"><span>卡包</span><span>内容</span><span>状态</span><span /></div>
          {loading ? Array.from({ length: 3 }, (_, index) => <div className="pack-row pack-row-loading" key={index}><i /><i /><i /></div>) : null}
          {!loading && visiblePacks.map((pack) => (
            <article className="pack-row" key={pack.packVersionId}>
              <button type="button" className="pack-row-main" onClick={() => router.push(`/learn/packs/${pack.packVersionId}`)}>
                <span className="pack-cover"><b>{pack.subject.slice(0, 3).toUpperCase()}</b><small>v{pack.version}</small></span>
                <span><strong>{pack.title}</strong><small>{pack.description}</small></span>
              </button>
              <div className="pack-row-stats">
                <span><Layers3 />{pack.chapterCount} 章</span>
                <span><BookOpen />{pack.cardCount} 卡</span>
                <span><Clock3 />{pack.estimatedMinutes} 分钟</span>
              </div>
              <div className="pack-row-status">
                <span>{levelLabels[pack.level]}</span>
                {pack.installedProjectId ? <b><Check />已添加</b> : <small>{pack.language}</small>}
              </div>
              <button type="button" className="icon-button" onClick={() => router.push(pack.installedProjectId ? `/learn/projects/${pack.installedProjectId}` : `/learn/packs/${pack.packVersionId}`)} aria-label={pack.installedProjectId ? "打开学习" : "查看卡包"} title={pack.installedProjectId ? "打开学习" : "查看卡包"}><ChevronRight /></button>
            </article>
          ))}
          {!loading && visiblePacks.length === 0 ? <div className="pack-empty"><PackageOpen /><strong>没有匹配的卡包</strong></div> : null}
        </div>
      </div>
    </main>
  );
}

export function CardPackDetailWorkspace({ packVersionId }: { packVersionId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const packQuery = useQuery({
    queryKey: ["card-pack", packVersionId],
    queryFn: ({ signal }) => fetch(`/api/packs/${packVersionId}`, { signal })
      .then((response) => parseApi<PublishedCardPack>(response)),
    staleTime: 5 * 60_000,
  });
  const pack = packQuery.data ?? null;
  const loading = packQuery.isPending;
  const error = installError ?? (packQuery.error instanceof Error ? packQuery.error.message : null);

  async function install() {
    if (!pack || installing) return;
    if (pack.installedProjectId) {
      router.push(`/learn/projects/${pack.installedProjectId}`);
      return;
    }
    setInstalling(true);
    setInstallError(null);
    try {
      const result = await parseApi<{ projectId: string }>(await fetch(`/api/packs/${pack.packVersionId}/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }));
      queryClient.setQueryData<PublishedCardPack>(["card-pack", pack.packVersionId], {
        ...pack,
        installedProjectId: result.projectId as `0x${string}`,
      });
      void queryClient.invalidateQueries({ queryKey: ["card-pack-catalog"], exact: true });
      router.push(`/learn/projects/${result.projectId}`);
    } catch (caught) {
      setInstallError(caught instanceof Error ? caught.message : "卡包添加失败");
    } finally {
      setInstalling(false);
    }
  }

  return (
    <main className="pack-shell">
      <PackHeader detail meta={pack?.title ?? "课程内容"} />
      <div className="pack-content">
        {loading ? <div className="pack-detail-loading"><LoaderCircle /><span>正在加载卡包</span></div> : null}
        {error ? <div className="library-error"><span>{error}</span>{!pack ? <button type="button" onClick={() => router.push("/learn/packs")}>返回目录</button> : null}</div> : null}
        {pack ? (
          <>
            <section className="pack-detail-title">
              <div className="pack-detail-cover"><b>{pack.subject}</b><span>{Number(pack.version.split(".")[0]) >= 4 ? "16 阶课程" : Number(pack.version.split(".")[0]) >= 3 ? "15 阶课程" : pack.version.startsWith("2.") ? "代码实战" : "基础入门"}</span><small>版本 {pack.version}</small></div>
              <div className="pack-detail-copy">
                <span className="section-kicker">{levelLabels[pack.level]} · {pack.language}</span>
                <h1>{pack.title}</h1>
                <p>{pack.description}</p>
                <dl>
                  <div><dt>章节</dt><dd>{pack.chapterCount}</dd></div>
                  <div><dt>知识卡</dt><dd>{pack.cardCount}</dd></div>
                  <div><dt>预计</dt><dd>{pack.estimatedMinutes} 分钟</dd></div>
                  <div><dt>许可</dt><dd>{pack.license}</dd></div>
                </dl>
              </div>
              <div className="pack-detail-action">
                <button type="button" className="command-button command-button-accent" onClick={() => void install()} disabled={installing}>
                  {installing ? <LoaderCircle className="animate-spin" /> : pack.installedProjectId ? <BookOpen /> : <PackageOpen />}
                  {pack.installedProjectId ? "打开学习" : "添加到我的学习"}
                </button>
              </div>
            </section>
            <section className="pack-chapters">
              <header><div><span className="section-kicker">课程目录</span><h2>章节与知识卡</h2></div><strong>{pack.cardCount} 张</strong></header>
              {pack.chapters.map((chapter) => {
                const prerequisites = (chapter.prerequisiteChapterIds ?? [])
                  .map((chapterId) => pack.chapters.find((item) => item.chapterId === chapterId)?.title)
                  .filter((title): title is string => Boolean(title));
                return (
                <details key={chapter.chapterId} id={chapter.stageId !== undefined && (chapter.position === 0 || chapter.stageId !== pack.chapters[chapter.position - 1]?.stageId) ? `pack-stage-${chapter.stageId}` : undefined} className="pack-chapter" open={chapter.position === 0}>
                  <summary>
                    <span>{String(chapter.position + 1).padStart(2, "0")}</span>
                    <div><strong>{chapter.title}</strong><small>{chapter.stageTitle ? `${chapter.stageTitle} · ` : ""}{chapter.summary}</small></div>
                    <div><b>{chapter.cardCount} 卡</b><small>{chapter.estimatedMinutes} 分钟</small></div>
                    <ChevronDown />
                  </summary>
                  {(chapter.learningObjectives?.length ?? 0) > 0 ? (
                    <div className="pack-chapter-plan">
                      <div><span>完成本章后</span><ul>{chapter.learningObjectives?.map((objective) => <li key={objective}>{objective}</li>)}</ul></div>
                      <div className="pack-chapter-route"><p><strong>本章新概念</strong>{chapter.newConcepts?.join(" · ") ?? "逐步掌握"}</p><p><strong>先修章节</strong>{prerequisites.length ? prerequisites.join(" -> ") : "无，从这里开始"}</p><p><strong>练习重点</strong>{chapter.practiceFocus ?? "完成本章代码练习"}</p><p><strong>项目里程碑</strong>{chapter.projectMilestone ?? "推进 LearningRegistry"}</p></div>
                    </div>
                  ) : null}
                  <div className="pack-preview-list">
                    {chapter.cards.map((card) => (
                      <details key={card.packCardId} className="pack-preview-card">
                        <summary><span>{cardTypeLabels[card.type]}</span><strong>{card.question}</strong><ChevronDown /></summary>
                        <div>
                          {card.code?.starterCode ? <pre className="mb-3 overflow-x-auto bg-[var(--code-surface)] p-3 text-xs leading-5 text-[var(--code-text)]"><code>{card.code.starterCode}</code></pre> : null}
                          {card.code ? <p className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-[var(--accent)]"><Code2 className="size-3.5" />包含 Solidity 写法与参考实现</p> : null}
                          <p>{card.answer}</p><b>{card.keyPoint}</b><small>{card.source.url ? <a href={card.source.url} target="_blank" rel="noreferrer">{card.source.label}<ExternalLink /></a> : card.source.label}</small>
                        </div>
                      </details>
                    ))}
                  </div>
                </details>
                );
              })}
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}
