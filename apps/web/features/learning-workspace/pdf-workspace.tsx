"use client";

import { BookOpen, Bot } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ChapterAiTutor } from "@/components/chapter-ai-tutor";
import { PdfDocumentViewer } from "@/components/pdf-document-viewer";

export function PdfWorkspace(props: {
  projectId: `0x${string}`;
  chapterId: number;
  chapterTitle: string;
  fileUrl: string | null;
  loading: boolean;
  pageStart: number | null;
  pageEnd: number | null;
  targetPage: number | null;
  uploadError: string | null;
  uploading: boolean;
  onUnavailable: () => void;
  onUploadRequest: () => void;
  toolbarModes: ReactNode;
  toolbarSupplement?: ReactNode;
  studyCardCount: number;
  dueCount: number;
  onStudy: () => void;
}) {
  const [tutorOpen, setTutorOpen] = useState(false);
  const [activePage, setActivePage] = useState<number | null>(null);
  const [citationPage, setCitationPage] = useState<number | null>(null);

  return (
    <section className="pdf-workspace" aria-label="PDF 学习工作台">
      <div className="pdf-tutor-layout" data-tutor-open={tutorOpen}>
        <PdfDocumentViewer
          fileUrl={props.fileUrl}
          pageStart={props.pageStart}
          pageEnd={props.pageEnd}
          targetPage={citationPage ?? props.targetPage}
          onUnavailable={props.onUnavailable}
          uploadError={props.uploadError}
          uploading={props.uploading}
          onUploadRequest={props.onUploadRequest}
          onPageChange={setActivePage}
          sourceLoading={props.loading}
          toolbarModes={<>{props.toolbarModes}{props.toolbarSupplement}</>}
          toolbarEnd={(
            <>
              <button
                type="button"
                className="pdf-reader-study-button"
                disabled={props.studyCardCount === 0}
                aria-label={props.studyCardCount > 0 ? `复习 ${props.studyCardCount} 张知识卡` : "今日已完成"}
                title={props.studyCardCount > 0 ? `复习 ${props.studyCardCount} 张 · ${props.dueCount} 到期` : "今日已完成"}
                onClick={props.onStudy}
              >
                <BookOpen />
              </button>
              <button
                type="button"
                className="pdf-reader-ai-button"
                data-active={tutorOpen}
                aria-label={tutorOpen ? "关闭 AI 导师" : "打开 AI 导师"}
                title={tutorOpen ? "关闭 AI 导师" : "打开 AI 导师"}
                onClick={() => setTutorOpen((open) => !open)}
              >
                <Bot />
              </button>
            </>
          )}
        />
        {tutorOpen ? (
          <ChapterAiTutor
            projectId={props.projectId}
            chapterId={props.chapterId}
            chapterTitle={props.chapterTitle}
            currentPage={activePage ?? props.pageStart}
            onClose={() => setTutorOpen(false)}
            onOpenPage={setCitationPage}
          />
        ) : null}
      </div>
    </section>
  );
}
