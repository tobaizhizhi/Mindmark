"use client";

import { BookOpenText, ChevronDown, Code2, ExternalLink } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ChapterReadingResponse, ChapterStudyCard } from "@mindmark/shared";

const typeLabels: Record<ChapterStudyCard["type"], string> = {
  concept: "概念卡", qa: "问答卡", comparison: "对比卡", process: "流程卡",
  application: "应用卡", misconception: "误区卡", code_read: "读代码卡",
  code_write: "写代码卡", code_complete: "补全代码卡", code_debug: "修错卡",
  output_trace: "运行推理卡", security_review: "安全审查卡",
};

const stateLabels: Record<ChapterStudyCard["state"], string> = {
  NEW: "新卡", LEARNING: "学习中", DUE: "到期复习", SCHEDULED: "已安排",
};

function BrowserCodeBlock(props: { title: string; code: string }) {
  return <div className="chapter-browser-code"><span><Code2 />{props.title}</span><pre><code>{props.code}</code></pre></div>;
}

export function ChapterCardBrowser(props: {
  cards: ChapterStudyCard[];
  reading: ChapterReadingResponse | null;
  readingAvailable: boolean;
  targetCardId: string | null;
  onOpenReading: (cardId: string) => void;
}) {
  const [openCards, setOpenCards] = useState<Set<string>>(() => new Set());
  const linkedCards = useMemo(() => new Set((props.reading?.cardLinks ?? []).map((link) => link.cardId)), [props.reading]);

  useEffect(() => {
    const targetCardId = props.targetCardId ?? (typeof window === "undefined" ? "" : window.location.hash.replace(/^#card-/u, ""));
    if (!targetCardId || targetCardId === window.location.hash) return;
    const frame = window.requestAnimationFrame(() => {
      setOpenCards((current) => new Set(current).add(targetCardId));
      window.requestAnimationFrame(() => {
        document.getElementById(`browse-card-${targetCardId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [props.targetCardId]);

  return (
    <div className="chapter-card-browser">
      {props.cards.map((card) => {
        const open = openCards.has(card.id);
        const code = "code" in card ? card.code : undefined;
        return (
          <article key={card.id} id={`browse-card-${card.id}`} data-open={open}>
            <button
              type="button"
              className="chapter-card-question"
              onClick={() => setOpenCards((current) => {
                const next = new Set(current);
                if (next.has(card.id)) next.delete(card.id); else next.add(card.id);
                return next;
              })}
              aria-expanded={open}
            >
              <span className="chapter-card-index">{String(card.position + 1).padStart(2, "0")}</span>
              <span className="chapter-card-copy"><strong>{card.question}</strong><small>{card.keyPoint}</small></span>
              <span className={`chapter-card-badge state-${card.state.toLowerCase()}`}>{typeLabels[card.type]} · {stateLabels[card.state]}</span>
              <ChevronDown />
            </button>
            {open ? (
              <div className="chapter-card-answer">
                {code?.starterCode ? <BrowserCodeBlock title="题目代码" code={code.starterCode} /> : null}
                {code ? <BrowserCodeBlock title="参考写法" code={code.solutionCode} /> : null}
                <p>{card.answer}</p>
                {code?.expectedResult ? <aside><strong>运行结果：</strong>{code.expectedResult}</aside> : null}
                <div className="chapter-card-source">
                  {"kind" in card.source ? (
                    <span>
                      {card.source.url ? <a href={card.source.url} target="_blank" rel="noreferrer">{card.source.label}<ExternalLink /></a> : card.source.label}
                      {card.source.locator ? ` · ${card.source.locator}` : ""}
                    </span>
                  ) : <span>第 {card.source.page} 页 · “{card.source.quote}”</span>}
                  {props.readingAvailable && linkedCards.has(card.id) ? (
                    <button type="button" onClick={() => props.onOpenReading(card.id)}><BookOpenText />查看来源</button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
