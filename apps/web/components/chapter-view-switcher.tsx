"use client";

import { BookOpenText, FileText, Layers3 } from "lucide-react";

export type ChapterBrowseView = "pdf" | "reading" | "cards";

export function ChapterViewSwitcher(props: {
  view: ChapterBrowseView;
  readingLabel: "原文" | "课程正文";
  pdfSupported?: boolean;
  pdfAvailable?: boolean;
  readingAvailable: boolean;
  onChange: (view: ChapterBrowseView) => void;
}) {
  const showPdf = props.pdfSupported ?? props.pdfAvailable === true;
  const pdfStatusKnown = props.pdfAvailable !== undefined;
  return (
    <div className="chapter-view-switcher" role="tablist" aria-label="章节浏览方式">
      {showPdf ? (
        <button
          type="button"
          role="tab"
          aria-selected={props.view === "pdf"}
          aria-label={props.pdfAvailable || !pdfStatusKnown ? "原版 PDF" : "原版 PDF 尚未上传"}
          title={!props.pdfAvailable && pdfStatusKnown ? "原版 PDF 尚未上传，可重新上传" : undefined}
          onClick={() => props.onChange("pdf")}
        >
          <FileText />
          <span>PDF</span>
        </button>
      ) : null}
      {props.readingAvailable ? (
        <button
          type="button"
          role="tab"
          aria-selected={props.view === "reading"}
          aria-label={props.readingLabel}
          title={props.readingLabel}
          onClick={() => props.onChange("reading")}
        >
          <BookOpenText />
          <span>阅读</span>
        </button>
      ) : null}
      <button
        type="button"
        role="tab"
        aria-selected={props.view === "cards"}
        onClick={() => props.onChange("cards")}
      >
        <Layers3 />
        <span>知识卡</span>
      </button>
    </div>
  );
}
