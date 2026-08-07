"use client";

import { ArrowRight, CircleAlert, LoaderCircle } from "lucide-react";
import { useEffect, useMemo } from "react";
import type { ChapterReadingResponse } from "@mindmark/shared";

export function ChapterReadingView(props: {
  reading: ChapterReadingResponse | null;
  loading: boolean;
  error: string | null;
  targetBlockId: string | null;
  onOpenCard: (cardId: string) => void;
  onRetry: () => void;
}) {
  const cardsByBlock = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const link of props.reading?.cardLinks ?? []) {
      result.set(link.blockId, [...(result.get(link.blockId) ?? []), link.cardId]);
    }
    return result;
  }, [props.reading]);

  useEffect(() => {
    if (!props.reading) return;
    const targetBlockId = props.targetBlockId ?? (typeof window === "undefined" ? "" : window.location.hash.slice(1));
    if (!targetBlockId) return;
    const element = document.getElementById(targetBlockId);
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    element.setAttribute("data-source-target", "true");
    const timer = window.setTimeout(() => element.removeAttribute("data-source-target"), 2_400);
    return () => window.clearTimeout(timer);
  }, [props.reading, props.targetBlockId]);

  if (props.loading) {
    return <div className="chapter-reading-state"><LoaderCircle className="animate-spin" /><span>正在加载章节正文</span></div>;
  }
  if (props.error) {
    return (
      <div className="chapter-reading-state chapter-reading-error">
        <CircleAlert />
        <span>{props.error}</span>
        <button type="button" onClick={props.onRetry}>重试</button>
      </div>
    );
  }
  if (!props.reading) return null;

  return (
    <article className="chapter-reading-column" aria-label={props.reading.origin === "PACK_LESSON" ? "课程正文" : "资料原文"}>
      {props.reading.blocks.map((block, index, blocks) => {
        const startsPage = block.pageNumber !== null && block.pageNumber !== blocks[index - 1]?.pageNumber;
        const cardIds = cardsByBlock.get(block.blockId) ?? [];
        return (
          <section key={block.blockId} className="chapter-reading-block-wrap">
            {startsPage ? <div className="chapter-page-separator"><span>第 {block.pageNumber} 页</span></div> : null}
            <div id={block.blockId} className="chapter-reading-block" data-kind={block.kind}>
              {block.kind === "heading" ? <h2>{block.text}</h2> : null}
              {block.kind === "paragraph" ? <p>{block.text}</p> : null}
              {block.kind === "code" ? <pre><code data-language={block.language ?? undefined}>{block.text}</code></pre> : null}
              {block.kind === "callout" ? <aside>{block.text}</aside> : null}
              {cardIds.length ? (
                <div className="chapter-reading-card-links" aria-label="关联知识卡">
                  {cardIds.map((cardId, index) => (
                    <button key={cardId} type="button" onClick={() => props.onOpenCard(cardId)} title="打开关联知识卡">
                      卡 {index + 1}<ArrowRight />
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </section>
        );
      })}
    </article>
  );
}
