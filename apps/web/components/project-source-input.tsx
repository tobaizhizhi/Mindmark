"use client";

import { BookOpen, FileText, LoaderCircle, Upload } from "lucide-react";
import type { RefObject } from "react";
import { MAX_SOURCE_CHARACTERS, MAX_SOURCE_PAGES } from "@mindmark/shared";

export type ProjectSourceMode = "pdf" | "text";

type ProjectSourceInputProps = {
  mode: ProjectSourceMode;
  onModeChange: (mode: ProjectSourceMode) => void;
  text: string;
  onTextChange: (text: string) => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFile: (file: File) => void | Promise<void>;
  fileName: string;
  pageCount: number;
  characterCount: number;
  isExtracting: boolean;
};

export function ProjectSourceInput({
  mode,
  onModeChange,
  text,
  onTextChange,
  fileInputRef,
  onFile,
  fileName,
  pageCount,
  characterCount,
  isExtracting,
}: ProjectSourceInputProps) {
  return (
    <div>
      <div className="mb-2 flex items-end justify-between gap-4">
        <span className="field-label">学习资料</span>
        <span className="font-mono text-xs text-[var(--muted)]">
          {characterCount.toLocaleString()} / {MAX_SOURCE_CHARACTERS.toLocaleString()}
        </span>
      </div>

      <div className="segmented-control mb-4" aria-label="资料输入方式">
        <button
          type="button"
          data-active={mode === "pdf"}
          onClick={() => onModeChange("pdf")}
        >
          <FileText aria-hidden="true" className="size-4" /> PDF
        </button>
        <button
          type="button"
          data-active={mode === "text"}
          onClick={() => onModeChange("text")}
        >
          <BookOpen aria-hidden="true" className="size-4" /> 文本
        </button>
      </div>

      {mode === "pdf" ? (
        <label
          htmlFor="project-pdf-source"
          className="upload-surface cursor-pointer"
          aria-busy={isExtracting}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const file = event.dataTransfer.files[0];
            if (file) void onFile(file);
          }}
        >
          <input
            ref={fileInputRef}
            id="project-pdf-source"
            type="file"
            accept=".pdf,application/pdf"
            className="sr-only"
            disabled={isExtracting}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void onFile(file);
            }}
          />
          <span className="upload-icon">
            {isExtracting ? (
              <LoaderCircle aria-hidden="true" className="size-6 animate-spin" />
            ) : (
              <Upload aria-hidden="true" className="size-6" />
            )}
          </span>
          <span className="font-display mt-4 text-xl font-semibold">
            {isExtracting ? "正在读取 PDF" : fileName || "选择 PDF 资料"}
          </span>
          <span className="mt-2 text-sm text-[var(--muted)]">
            {pageCount > 0
              ? `${pageCount} 页 · ${characterCount.toLocaleString()} 字符`
              : `点击选择或拖放到这里 · 最多 ${MAX_SOURCE_PAGES} 页 · 15 MB`}
          </span>
          <span className="mt-1 text-xs text-[var(--muted)]">
            PDF 只在浏览器中提取文字，原文件不会上传
          </span>
        </label>
      ) : (
        <textarea
          className="source-textarea"
          value={text}
          maxLength={MAX_SOURCE_CHARACTERS}
          onChange={(event) => onTextChange(event.target.value)}
          placeholder="粘贴课程笔记、文章或技术资料"
        />
      )}
    </div>
  );
}
