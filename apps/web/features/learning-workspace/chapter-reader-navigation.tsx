"use client";

import { ArrowLeft } from "lucide-react";

export function ChapterReaderNavigation(props: {
  chapterPosition: number;
  chapterTitle: string;
  onOpenProject: () => void;
}) {
  return (
    <div className="reader-toolbar-navigation">
      <button
        type="button"
        className="reader-toolbar-icon"
        onClick={props.onOpenProject}
        aria-label="返回资料概览"
        title="返回资料概览"
      >
        <ArrowLeft />
      </button>
      <span className="reader-toolbar-divider" aria-hidden="true" />
      <span className="reader-toolbar-title" title={props.chapterTitle}>
        <small>第 {props.chapterPosition + 1} 章</small>
        <strong>{props.chapterTitle}</strong>
      </span>
    </div>
  );
}
