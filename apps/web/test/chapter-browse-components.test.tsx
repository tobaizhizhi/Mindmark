import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChapterStudyCard } from "@mindmark/shared";
import { ChapterCardBrowser } from "@/components/chapter-card-browser";
import { ChapterAiTutor, readChapterTutorEventStream } from "@/components/chapter-ai-tutor";
import { PdfWorkspace } from "@/features/learning-workspace/pdf-workspace";
import { ChapterViewSwitcher } from "@/components/chapter-view-switcher";
import { copyPdfText, nearbyPdfPages, PdfDocumentViewer } from "@/components/pdf-document-viewer";

const card: ChapterStudyCard = {
  id: `0x${"42".repeat(32)}`,
  position: 0,
  type: "concept",
  question: "public 状态变量会生成什么？",
  answer: "编译器会生成同名 getter。",
  keyPoint: "getter 只读，不写状态。",
  source: { kind: "pack_reference", label: "Solidity 官方文档" },
  tags: ["getter"],
  importance: 5,
  initialDifficulty: 2,
  readingBlockId: "contract-shell-concepts",
  state: "NEW",
  dueAt: null,
  reps: 0,
  lapses: 0,
};

describe("Chapter browse components", () => {
  it("keeps the reader toolbar navigation in one compact row", async () => {
    const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
    expect(css).toMatch(
      /\.learning-workspace-shell\[data-reader-mode="true"\]\s+\.chapter-browse-toolbar\s*>\s*\.reader-toolbar-navigation\s*\{[^}]*display:\s*flex/su,
    );
    expect(css).toMatch(
      /\.learning-workspace-shell\[data-reader-mode="true"\]\s+\.chapter-browse-toolbar\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+minmax\(0,\s*1fr\)/su,
    );
  });

  it("keeps the AI Tutor command inside the PDF Workspace", () => {
    const markup = renderToStaticMarkup(<PdfWorkspace
      projectId={`0x${"41".repeat(32)}`}
      chapterId={0}
      chapterTitle="CPU 调度"
      fileUrl={null}
      loading={false}
      pageStart={10}
      pageEnd={12}
      targetPage={null}
      uploadError={null}
      uploading={false}
      onUnavailable={() => undefined}
      onUploadRequest={() => undefined}
      toolbarModes={<span>阅读模式</span>}
      studyCardCount={1}
      dueCount={0}
      onStudy={() => undefined}
    />);
    expect(markup).toContain("PDF 学习工作台");
    expect(markup).toContain('aria-label="打开 AI 导师"');
    expect(markup).toContain("阅读模式");
    expect(markup).toContain("原版 PDF");
    expect(markup).not.toContain("pdf-workspace-actions");
  });

  it("renders stable reading and card browse tabs", () => {
    const markup = renderToStaticMarkup(
      <ChapterViewSwitcher view="reading" readingLabel="课程正文" readingAvailable onChange={() => undefined} />,
    );
    expect(markup).toContain("阅读");
    expect(markup).toContain('aria-label="课程正文"');
    expect(markup).toContain("知识卡");
    expect(markup).toContain('aria-selected="true"');
  });

  it("exposes the original PDF tab when a source file is available", () => {
    const markup = renderToStaticMarkup(
      <ChapterViewSwitcher view="pdf" readingLabel="原文" pdfAvailable readingAvailable onChange={() => undefined} />,
    );
    expect(markup).toContain("原版 PDF");
    expect(markup).toContain('aria-selected="true"');
  });

  it("keeps the original PDF entry visible while an upload is not ready", () => {
    const markup = renderToStaticMarkup(
      <ChapterViewSwitcher view="reading" readingLabel="原文" pdfSupported pdfAvailable={false} readingAvailable onChange={() => undefined} />,
    );
    expect(markup).toContain("原版 PDF");
    expect(markup).toContain("尚未上传");
  });

  it("keeps FSRS rating commands out of the card browser", () => {
    const markup = renderToStaticMarkup(
      <ChapterCardBrowser cards={[card]} reading={null} readingAvailable={false} targetCardId={null} onOpenReading={() => undefined} />,
    );
    expect(markup).toContain("概念卡 · 新卡");
    expect(markup).not.toMatch(/忘记|困难|掌握|轻松/u);
  });

  it("offers an upload action when the original PDF is missing", () => {
    const markup = renderToStaticMarkup(
      <PdfDocumentViewer
        fileUrl={null}
        pageStart={1}
        pageEnd={2}
        uploadError={null}
        uploading={false}
        onUploadRequest={() => undefined}
      />,
    );
    expect(markup).toContain("这个项目还没有保存原版 PDF");
    expect(markup).toContain("重新上传 PDF");
  });

  it("limits PDF rendering to the current page and its neighbours", () => {
    const pages = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(nearbyPdfPages(pages, 10)).toEqual([9, 10, 11]);
    expect(nearbyPdfPages(pages, 1)).toEqual([1, 2]);
  });

  it("keeps the PDF.js 6 text layer aligned and selectable", async () => {
    const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
    expect(css).toContain("--total-scale-factor: 1");
    expect(css).toContain("--text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size))");
    expect(css).toContain("font-size: calc(var(--text-scale-factor) * var(--font-height))");
    expect(css).toMatch(/\.pdf-text-layer :is\(span, br\)[^{]*\{[^}]*user-select: text/su);
  });

  it("falls back when the browser Clipboard API rejects PDF text", async () => {
    const legacyCopy = vi.fn(() => true);
    await copyPdfText("重入攻击", {
      writeText: vi.fn().mockRejectedValue(new Error("NotAllowedError")),
    }, legacyCopy);
    expect(legacyCopy).toHaveBeenCalledWith("重入攻击");
  });

  it("renders a page-aware AI Tutor beside the PDF", () => {
    const markup = renderToStaticMarkup(
      <ChapterAiTutor
        projectId={`0x${"42".repeat(32)}`}
        chapterId={0}
        chapterTitle="CPU 调度算法"
        currentPage={12}
        onClose={() => undefined}
        onOpenPage={() => undefined}
      />,
    );
    expect(markup).toContain("AI 导师");
    expect(markup).toContain("正在阅读第 12 页");
    expect(markup).toContain("引用选中文字");
  });

  it("reads fragmented Tutor SSE events in order", async () => {
    const events = [
      { type: "answer_delta", delta: "先给结论。" },
      {
        type: "result",
        response: {
          answer: "先给结论。再解释原因。",
          citations: [],
          suggestedQuestions: ["为什么？"],
        },
      },
    ];
    const payload = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("");
    const encoded = new TextEncoder().encode(payload);
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 13));
        controller.enqueue(encoded.slice(13, 57));
        controller.enqueue(encoded.slice(57));
        controller.close();
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
    const received: unknown[] = [];

    await readChapterTutorEventStream(response, (event) => received.push(event));

    expect(received).toEqual(events);
  });
});
