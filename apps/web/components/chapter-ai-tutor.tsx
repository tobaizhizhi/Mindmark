"use client";

import {
  Bot,
  BookOpenCheck,
  CircleAlert,
  LoaderCircle,
  Quote,
  Send,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  AiTutorCitation,
  AiTutorConversationMessage,
  AiTutorStreamEvent,
  AskChapterTutorResponse,
} from "@mindmark/shared";
import { AiTutorStreamEventSchema } from "@mindmark/shared";
import { parseApiResponse } from "@/lib/client/http";

type TutorMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: AiTutorCitation[];
  suggestions: string[];
  streaming?: boolean;
};

type AiTutorClientEvent = Exclude<AiTutorStreamEvent, { type: "error" }>;

const starterQuestions = [
  "解释当前页的核心内容",
  "用一个例子讲清楚",
  "根据本章内容考考我",
];

export async function readChapterTutorEventStream(
  response: Response,
  onEvent: (event: AiTutorClientEvent) => void,
): Promise<void> {
  if (!response.ok) {
    await parseApiResponse<never>(response, "AI 导师请求失败");
    return;
  }
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    onEvent({
      type: "result",
      response: await parseApiResponse<AskChapterTutorResponse>(response, "AI 导师请求失败"),
    });
    return;
  }
  if (!response.body) throw new Error("AI 导师没有返回可读取的数据流");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let completed = false;

  const emitFrame = () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    dataLines = [];
    const event = AiTutorStreamEventSchema.parse(JSON.parse(data));
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "result") completed = true;
    onEvent(event);
  };

  const processLine = (line: string) => {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /u, ""));
      return;
    }
    if (line === "") emitFrame();
  };

  const processBuffer = (final: boolean) => {
    const lines = buffer.split("\n");
    buffer = final ? "" : (lines.pop() ?? "");
    for (const line of lines) processLine(line.replace(/\r$/u, ""));
    if (final) {
      if (lines.length === 0 && buffer) processLine(buffer.replace(/\r$/u, ""));
      emitFrame();
    }
  };

  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
      processBuffer(chunk.done);
      if (chunk.done) break;
    }
  } finally {
    reader.releaseLock();
  }
  if (!completed) throw new Error("AI 导师连接提前结束，请重试");
}

function messageId(role: TutorMessage["role"]): string {
  return `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ChapterAiTutor(props: {
  projectId: `0x${string}`;
  chapterId: number;
  chapterTitle: string;
  currentPage: number | null;
  onClose: () => void;
  onOpenPage: (pageNumber: number) => void;
}) {
  const [messages, setMessages] = useState<TutorMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [selectedText, setSelectedText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const activeRequestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: busy ? "auto" : "smooth", block: "end" });
  }, [busy, messages]);

  useEffect(() => () => activeRequestRef.current?.abort(), []);

  function captureSelection() {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const rangeContainer = range?.commonAncestorContainer;
    const rangeElement = rangeContainer instanceof Element ? rangeContainer : rangeContainer?.parentElement;
    const text = selection?.toString().replace(/\s+/gu, " ").trim().slice(0, 2_000) ?? "";
    if (!text || !rangeElement?.closest(".pdf-text-layer")) {
      setError("请先在 PDF 中选中文字");
      return;
    }
    setError(null);
    setSelectedText(text);
    textareaRef.current?.focus();
  }

  async function ask(question: string) {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion || busy) return;
    const history: AiTutorConversationMessage[] = messages.slice(-8).map((message) => ({
      role: message.role,
      content: message.content,
    }));
    const userMessage: TutorMessage = {
      id: messageId("user"),
      role: "user",
      content: normalizedQuestion,
      citations: [],
      suggestions: [],
    };
    const assistantId = messageId("assistant");
    setMessages((current) => [...current, userMessage, {
      id: assistantId,
      role: "assistant",
      content: "",
      citations: [],
      suggestions: [],
      streaming: true,
    }]);
    setDraft("");
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    activeRequestRef.current = controller;
    try {
      let completed = false;
      await readChapterTutorEventStream(await fetch(
        `/api/projects/${props.projectId}/chapters/${props.chapterId}/tutor`,
        {
          method: "POST",
          headers: {
            Accept: "text/event-stream",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            question: normalizedQuestion,
            currentPage: props.currentPage,
            selectedText,
            history,
          }),
          signal: controller.signal,
        },
      ), (event) => {
        if (event.type === "answer_delta") {
          setMessages((current) => current.map((message) => message.id === assistantId
            ? { ...message, content: message.content + event.delta }
            : message));
          return;
        }
        completed = true;
        setMessages((current) => current.map((message) => message.id === assistantId
          ? {
            ...message,
            content: event.response.answer,
            citations: event.response.citations,
            suggestions: event.response.suggestedQuestions,
            streaming: false,
          }
          : message));
      });
      if (!completed) throw new Error("AI 导师连接提前结束，请重试");
      setSelectedText(null);
    } catch (caught) {
      setMessages((current) => current.filter((message) => message.id !== assistantId));
      if (!controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : "AI 导师暂时无法回答");
      }
    } finally {
      if (activeRequestRef.current === controller) activeRequestRef.current = null;
      setBusy(false);
    }
  }

  const latestSuggestions = [...messages].reverse().find((message) => (
    message.role === "assistant" && message.suggestions.length > 0
  ))?.suggestions ?? starterQuestions;
  const hasStreamingAnswer = messages.some((message) => (
    message.role === "assistant" && message.streaming && message.content.length > 0
  ));

  return (
    <aside className="chapter-ai-tutor" aria-label="AI 导师">
      <header className="chapter-ai-tutor-header">
        <div>
          <span><Bot />AI 导师</span>
          <strong>{props.chapterTitle}</strong>
        </div>
        <button type="button" onClick={() => { activeRequestRef.current?.abort(); props.onClose(); }} aria-label="关闭 AI 导师" title="关闭"><X /></button>
      </header>

      <div className="chapter-ai-tutor-page-context">
        <BookOpenCheck />
        <span>{props.currentPage ? `正在阅读第 ${props.currentPage} 页` : "当前章节"}</span>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={captureSelection}><Quote />引用选中文字</button>
      </div>

      <div className="chapter-ai-tutor-messages" aria-live="polite">
        {messages.length === 0 ? (
          <div className="chapter-ai-tutor-empty">
            <Bot />
            <h3>从这一页开始</h3>
            <div>
              {starterQuestions.map((question) => (
                <button key={question} type="button" onClick={() => void ask(question)}>{question}</button>
              ))}
            </div>
          </div>
        ) : messages.map((message) => (
          <article key={message.id} className="chapter-ai-tutor-message" data-role={message.role}>
            <span>{message.role === "user" ? "你" : "AI"}</span>
            <p>
              {message.content}
              {message.streaming ? <span className="chapter-ai-tutor-stream-cursor" aria-hidden="true" /> : null}
            </p>
            {message.citations.length > 0 ? (
              <div className="chapter-ai-tutor-citations">
                {message.citations.map((citation) => (
                  <button
                    key={citation.blockId}
                    type="button"
                    disabled={citation.pageNumber === null}
                    onClick={() => { if (citation.pageNumber) props.onOpenPage(citation.pageNumber); }}
                  >
                    <strong>{citation.pageNumber ? `第 ${citation.pageNumber} 页` : "章节正文"}</strong>
                    <span>{citation.quote}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </article>
        ))}
        {busy && !hasStreamingAnswer ? <div className="chapter-ai-tutor-thinking"><LoaderCircle className="animate-spin" />正在查找本章依据</div> : null}
        <div ref={messageEndRef} />
      </div>

      <div className="chapter-ai-tutor-composer">
        {selectedText ? (
          <div className="chapter-ai-tutor-selection"><Quote /><span>{selectedText}</span><button type="button" onClick={() => setSelectedText(null)}><X /></button></div>
        ) : null}
        {error ? <div className="chapter-ai-tutor-error"><CircleAlert />{error}</div> : null}
        {messages.length > 0 && !busy ? (
          <div className="chapter-ai-tutor-suggestions">
            {latestSuggestions.map((question) => (
              <button key={question} type="button" onClick={() => void ask(question)}>{question}</button>
            ))}
          </div>
        ) : null}
        <form onSubmit={(event) => { event.preventDefault(); void ask(draft); }}>
          <textarea
            ref={textareaRef}
            rows={3}
            value={draft}
            maxLength={1_200}
            placeholder="问这一章的任何问题"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void ask(draft);
              }
            }}
          />
          <button type="submit" disabled={busy || !draft.trim()} aria-label="发送问题" title="发送"><Send /></button>
        </form>
      </div>
    </aside>
  );
}
