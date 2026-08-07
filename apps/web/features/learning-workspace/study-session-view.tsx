"use client";

import {
  ArrowLeft,
  Check,
  CircleAlert,
  Clock3,
  Code2,
  Eye,
  Gauge,
  Layers3,
  Lightbulb,
  LoaderCircle,
  MessageSquare,
  Pencil,
  RotateCcw,
  Send,
  ThumbsDown,
  ThumbsUp,
  Zap,
} from "lucide-react";
import { useState } from "react";
import type { SubmitKnowledgeCardFeedbackRequest } from "@mindmark/shared/study";
import type { StudyCard, StudyRating, StudyScope } from "./use-study-session";

export type CardFeedbackInput = Omit<SubmitKnowledgeCardFeedbackRequest, "chapterId" | "cardId">;

const cardTypeLabels: Record<StudyCard["type"], string> = {
  concept: "概念卡",
  qa: "问答卡",
  comparison: "对比卡",
  process: "流程卡",
  application: "应用卡",
  misconception: "误区卡",
  code_read: "读代码卡",
  code_write: "写代码卡",
  code_complete: "补全代码卡",
  code_debug: "修错卡",
  output_trace: "运行推理卡",
  security_review: "安全审查卡",
};

const cardStateLabels: Record<StudyCard["state"], string> = {
  NEW: "新卡",
  LEARNING: "学习中",
  DUE: "到期复习",
  SCHEDULED: "已安排",
};

function StudyCardFeedback(props: {
  onSubmit: (input: CardFeedbackInput) => Promise<void>;
}) {
  const [rating, setRating] = useState<CardFeedbackInput["rating"] | null>(null);
  const [reason, setReason] = useState("");
  const [showCorrection, setShowCorrection] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [keyPoint, setKeyPoint] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const needsReason = rating === "INCORRECT" || rating === "UNCLEAR";
  const choices: Array<{
    rating: CardFeedbackInput["rating"];
    label: string;
    icon: typeof ThumbsUp;
  }> = [
    { rating: "UP", label: "有帮助", icon: ThumbsUp },
    { rating: "DOWN", label: "没有帮助", icon: ThumbsDown },
    { rating: "INCORRECT", label: "事实有误", icon: CircleAlert },
    { rating: "UNCLEAR", label: "表述不清", icon: MessageSquare },
  ];

  async function submit() {
    if (!rating || submitted || busy) return;
    const normalizedReason = reason.trim();
    if (needsReason && !normalizedReason) {
      setError("请说明卡片的问题。");
      return;
    }
    const correctedContent = {
      ...(question.trim() ? { question: question.trim() } : {}),
      ...(answer.trim() ? { answer: answer.trim() } : {}),
      ...(keyPoint.trim() ? { keyPoint: keyPoint.trim() } : {}),
    };
    setBusy(true);
    setError(null);
    try {
      await props.onSubmit({
        rating,
        ...(normalizedReason ? { reason: normalizedReason } : {}),
        ...(Object.keys(correctedContent).length ? { correctedContent } : {}),
      });
      setSubmitted(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "反馈保存失败");
    } finally {
      setBusy(false);
    }
  }

  if (submitted) {
    return <p className="study-feedback-saved"><Check />反馈已记录</p>;
  }

  return (
    <section className="study-card-feedback" data-open={open} aria-label="知识卡反馈">
      <button type="button" className="study-feedback-trigger" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <MessageSquare />
        <span>报告卡片问题</span>
      </button>
      {open ? <div className="study-feedback-panel">
        <div className="study-feedback-heading">
          <p>这张卡片怎么样？</p>
          <div className="study-feedback-choices">
          {choices.map((choice) => {
            const Icon = choice.icon;
            const selected = rating === choice.rating;
            return (
              <button
                key={choice.rating}
                type="button"
                onClick={() => { setRating(choice.rating); setError(null); }}
                disabled={busy}
                aria-label={choice.label}
                aria-pressed={selected}
                title={choice.label}
                data-selected={selected}
              >
                <Icon />
              </button>
            );
          })}
        </div>
        </div>
      {rating ? (
        <div className="study-feedback-fields">
          <label>
            {needsReason ? "问题说明" : "补充说明（可选）"}
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy} required={needsReason} maxLength={500} rows={2} />
          </label>
          <div className="study-feedback-actions">
            <button type="button" onClick={() => setShowCorrection((value) => !value)} disabled={busy} className="study-feedback-edit" title="添加修订建议" aria-label="添加修订建议" aria-expanded={showCorrection}><Pencil /></button>
            <button type="button" onClick={() => void submit()} disabled={busy} className="study-feedback-submit">
              {busy ? <LoaderCircle className="animate-spin" /> : <Send />}提交反馈
            </button>
          </div>
          {showCorrection ? (
            <div className="study-feedback-correction">
              <label>建议问题<textarea value={question} onChange={(event) => setQuestion(event.target.value)} disabled={busy} maxLength={500} rows={2} /></label>
              <label>建议答案<textarea value={answer} onChange={(event) => setAnswer(event.target.value)} disabled={busy} maxLength={1500} rows={3} /></label>
              <label>建议关键点<textarea value={keyPoint} onChange={(event) => setKeyPoint(event.target.value)} disabled={busy} maxLength={500} rows={2} /></label>
            </div>
          ) : null}
          {error ? <p className="study-feedback-error" role="alert">{error}</p> : null}
        </div>
      ) : null}
      </div> : null}
    </section>
  );
}

function CodeBlock({ title, code }: { title: string; code: string }) {
  return (
    <div className="study-code-block">
      <div><span><Code2 />{title}</span><span>Solidity</span></div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

export function StudySessionView(props: {
  scope: StudyScope;
  cards: StudyCard[];
  currentCard: StudyCard | null;
  studyIndex: number;
  answerVisible: boolean;
  ratingBusy: boolean;
  studyDone: boolean;
  studyFinishing: boolean;
  onExit: () => void;
  onReveal: () => void;
  onRate: (rating: StudyRating) => void;
  onFeedback: (input: CardFeedbackInput) => Promise<void>;
}) {
  if (props.studyDone) {
    return (
      <div className="study-session-complete flex min-h-[70vh] flex-col items-center justify-center text-center">
        <span className="flex size-12 items-center justify-center rounded-lg bg-[var(--success)] text-white">{props.studyFinishing ? <LoaderCircle className="size-6 animate-spin" /> : <Check className="size-6" />}</span>
        <p className="section-kicker mt-6">复习完成</p>
        <h1 className="font-display mt-2 text-3xl font-semibold">{props.scope === "project" ? "项目今日复习完成" : "本章今日复习完成"}</h1>
        <p className="mt-3 text-sm text-[var(--muted)]">{props.studyFinishing ? "正在保存复习进度…" : `已更新 ${props.cards.length} 张卡片的下次复习时间。`}</p>
        <button type="button" onClick={props.onExit} disabled={props.studyFinishing} className="command-button command-button-dark mt-7"><ArrowLeft className="size-4" />{props.scope === "project" ? "返回项目" : "返回章节"}</button>
      </div>
    );
  }
  if (!props.currentCard) return null;
  const projectCard = "chapterTitle" in props.currentCard ? props.currentCard : null;
  const codeExercise = "code" in props.currentCard ? props.currentCard.code : undefined;
  return (
    <div className="study-session-view">
      <header className="study-session-toolbar">
        <button type="button" onClick={props.onExit} className="study-session-exit" aria-label="退出复习" title="退出复习"><ArrowLeft /><span>退出复习</span></button>
        <div className="study-session-counter"><span>{props.scope === "project" ? "项目复习" : "章节复习"}</span><strong>{String(props.studyIndex + 1).padStart(2, "0")}<i>/</i>{String(props.cards.length).padStart(2, "0")}</strong></div>
      </header>
      <div className="study-session-progress"><div style={{ width: `${(props.studyIndex + 1) * 100 / props.cards.length}%` }} /></div>
      <main className="study-session-card-stage">
        <div className="study-card-context">
          {projectCard ? <p>第 {String(projectCard.chapterPosition + 1).padStart(2, "0")} 章 · {projectCard.chapterTitle}</p> : <span />}
          <div className="study-card-classification"><span><Clock3 />{cardStateLabels[props.currentCard.state]}</span><span><Layers3 />{cardTypeLabels[props.currentCard.type]}</span></div>
        </div>
        <section className="study-question-panel" aria-labelledby="study-question">
          <span>问题 {String(props.studyIndex + 1).padStart(2, "0")}</span>
          <h1 id="study-question">{props.currentCard.question}</h1>
        </section>
        {codeExercise?.starterCode ? <CodeBlock title="题目代码" code={codeExercise.starterCode} /> : null}
        {!props.answerVisible ? <div className="study-reveal-action"><button type="button" onClick={props.onReveal}><Eye />显示答案</button></div> : (
          <section className="study-answer-panel" aria-label="答案">
            <div className="study-answer-heading"><span>答案</span></div>
            {codeExercise ? <CodeBlock title="参考写法" code={codeExercise.solutionCode} /> : null}
            <p className="study-answer-copy">{props.currentCard.answer}</p>
            {codeExercise?.expectedResult ? <p className="study-code-result"><strong>运行结果</strong>{codeExercise.expectedResult}</p> : null}
            <aside className="study-key-point"><Lightbulb /><div><span>关键点</span><p>{props.currentCard.keyPoint}</p></div></aside>
            {"kind" in props.currentCard.source ? (
              <div className="study-answer-source">
                {props.currentCard.source.quote ? <p>“{props.currentCard.source.quote}”</p> : null}
                <p>{props.currentCard.source.url ? <a href={props.currentCard.source.url} target="_blank" rel="noreferrer">{props.currentCard.source.label}</a> : props.currentCard.source.label}{props.currentCard.source.locator ? <span> · {props.currentCard.source.locator}</span> : null}</p>
              </div>
            ) : <blockquote className="study-answer-source">“{props.currentCard.source.quote}”<span>第 {props.currentCard.source.page} 页</span></blockquote>}
            <StudyCardFeedback key={props.currentCard.id} onSubmit={props.onFeedback} />
            <div className="study-rating-section">
              <span>掌握程度</span>
              <div className="study-rating-grid">
                <button type="button" data-rating="again" disabled={props.ratingBusy} onClick={() => props.onRate("again")}><RotateCcw /><span>忘记</span></button>
                <button type="button" data-rating="hard" disabled={props.ratingBusy} onClick={() => props.onRate("hard")}><Gauge /><span>困难</span></button>
                <button type="button" data-rating="good" disabled={props.ratingBusy} onClick={() => props.onRate("good")}><Check /><span>掌握</span></button>
                <button type="button" data-rating="easy" disabled={props.ratingBusy} onClick={() => props.onRate("easy")}><Zap /><span>轻松</span></button>
              </div>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
