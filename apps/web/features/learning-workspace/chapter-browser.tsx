"use client";

import { BookOpen, LoaderCircle, Upload } from "lucide-react";
import { useRef, useState } from "react";
import type {
  ChapterListResponse,
  ChapterReadingResponse,
  ChapterStudyResponse,
  ProjectSourceFileResponse,
  ProjectSummary,
} from "@mindmark/shared";
import { ChapterCardBrowser } from "@/components/chapter-card-browser";
import { ChapterReadingView } from "@/components/chapter-reading-view";
import { ChapterViewSwitcher, type ChapterBrowseView } from "@/components/chapter-view-switcher";
import { ChapterReaderNavigation } from "./chapter-reader-navigation";
import { PdfWorkspace } from "./pdf-workspace";

export function ChapterBrowser(props: {
  projectId: `0x${string}`;
  project: ProjectSummary;
  chapter: ChapterListResponse["chapters"][number];
  detail: ChapterStudyResponse;
  reading: ChapterReadingResponse | null;
  sourceFile: ProjectSourceFileResponse | null;
  sourceFileLoading: boolean;
  view: ChapterBrowseView;
  readingLoading: boolean;
  readingError: string | null;
  sourceFileUploading: boolean;
  sourceFileError: string | null;
  studyCardCount: number;
  onOpenProject: () => void;
  onStudy: () => void;
  onSelectView: (view: ChapterBrowseView, target?: string) => void;
  onUploadSourceFile: (file: File) => Promise<ProjectSourceFileResponse | null>;
  onRetryReading: () => void;
}) {
  const [targetBlockId, setTargetBlockId] = useState<string | null>(null);
  const [targetPdfPage, setTargetPdfPage] = useState<number | null>(null);
  const [targetCardId, setTargetCardId] = useState<string | null>(null);
  const sourceFileInputRef = useRef<HTMLInputElement>(null);
  const projectIsUpload = props.project.projectKind === "UPLOAD";
  const pdfAvailable = projectIsUpload && props.sourceFile?.available === true;
  const readingAvailable = projectIsUpload || props.reading !== null || props.detail.status === "READY";

  function selectView(view: ChapterBrowseView, target?: string) {
    if (view === "pdf" && target && /^\d+$/u.test(target)) setTargetPdfPage(Number(target));
    props.onSelectView(view, target);
  }

  function openReadingForCard(cardId: string) {
    const link = props.reading?.cardLinks.find((item) => item.cardId === cardId);
    if (!link) return;
    const block = props.reading?.blocks.find((item) => item.blockId === link.blockId);
    if (pdfAvailable && block?.pageNumber) {
      selectView("pdf", String(block.pageNumber));
      return;
    }
    setTargetBlockId(link.blockId);
    selectView("reading", link.blockId);
  }

  async function uploadSourceFile(file: File) {
    const uploaded = await props.onUploadSourceFile(file);
    if (sourceFileInputRef.current) sourceFileInputRef.current.value = "";
    if (uploaded?.available && uploaded.url) selectView("pdf");
  }

  const uploadControl = projectIsUpload && !pdfAvailable && !props.sourceFileLoading ? (
    <>
      <input ref={sourceFileInputRef} className="sr-only" type="file" accept="application/pdf,.pdf" onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) void uploadSourceFile(file);
      }} />
      <button type="button" className="command-button command-button-quiet reader-upload-command" disabled={props.sourceFileUploading} onClick={() => sourceFileInputRef.current?.click()}>
        {props.sourceFileUploading ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />}
        <span>{props.sourceFileUploading ? "正在上传 PDF" : "上传原版 PDF"}</span>
      </button>
    </>
  ) : null;
  const viewSwitcher = (
    <ChapterViewSwitcher
      view={props.view}
      readingLabel={props.project.projectKind === "PACK" ? "课程正文" : "原文"}
      pdfSupported={projectIsUpload}
      pdfAvailable={pdfAvailable}
      readingAvailable={readingAvailable}
      onChange={selectView}
    />
  );
  const readerNavigation = (
    <ChapterReaderNavigation
      chapterPosition={props.chapter.position}
      chapterTitle={props.chapter.title}
      onOpenProject={props.onOpenProject}
    />
  );

  return (
    <div className="document-knowledge-section" data-view={props.view}>
      {props.view !== "pdf" ? <div className="chapter-browse-toolbar">
        {readerNavigation}
        <div className="chapter-browse-modes">{viewSwitcher}</div>
        <div className="chapter-browse-actions">
          {uploadControl}
          <button
            type="button"
            className="reader-study-command"
            disabled={props.studyCardCount === 0}
            onClick={props.onStudy}
            title={props.studyCardCount > 0 ? `复习 ${props.studyCardCount} 张 · ${props.detail.dueCount} 到期` : "今日已完成"}
          >
            <BookOpen />
            <span>{props.studyCardCount > 0 ? "复习" : "已完成"}</span>
          </button>
        </div>
      </div> : null}
      {props.view === "pdf" ? (
        <PdfWorkspace
          projectId={props.projectId}
          chapterId={props.chapter.chapterId}
          chapterTitle={props.chapter.title}
          fileUrl={props.sourceFile?.url ?? null}
          loading={props.sourceFileLoading}
          pageStart={props.chapter.pageStart}
          pageEnd={props.chapter.pageEnd}
          targetPage={targetPdfPage}
          onUnavailable={() => selectView("reading")}
          uploadError={props.sourceFileError}
          uploading={props.sourceFileUploading}
          onUploadRequest={() => sourceFileInputRef.current?.click()}
          toolbarModes={<>{readerNavigation}{viewSwitcher}</>}
          toolbarSupplement={uploadControl}
          studyCardCount={props.studyCardCount}
          dueCount={props.detail.dueCount}
          onStudy={props.onStudy}
        />
      ) : props.view === "reading" ? (
        <ChapterReadingView
          reading={props.reading}
          loading={props.readingLoading || (!props.reading && !props.readingError)}
          error={props.readingError}
          targetBlockId={targetBlockId}
          onOpenCard={(cardId) => { setTargetCardId(cardId); selectView("cards", cardId); }}
          onRetry={props.onRetryReading}
        />
      ) : (
        <ChapterCardBrowser
          cards={props.detail.cards}
          reading={props.reading}
          readingAvailable={readingAvailable}
          targetCardId={targetCardId}
          onOpenReading={openReadingForCard}
        />
      )}
    </div>
  );
}
