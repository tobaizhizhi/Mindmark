import { CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import type { LearnerProjectProgress } from "@mindmark/shared/learning-project";
import { MonadLearningFlow } from "@/components/monad-learning-flow";

const stageLabels: Record<LearnerProjectProgress["stage"], string> = {
  ANALYZING_SOURCE: "正在分析资料",
  OUTLINE_READY: "章节草稿待确认",
  DESIGNING_CARDS: "正在设计知识卡",
  AWAITING_MONAD: "等待 Monad 登记",
  GENERATING_CARDS: "正在生成知识卡",
  CHECKING_QUALITY: "正在检查卡片质量",
  READY: "项目可以学习",
  ACTION_REQUIRED: "生成流程需要处理",
  FAILED: "项目未能完成",
};

export function ProjectProgressIndicator(props: {
  progress: LearnerProjectProgress;
  compact?: boolean;
  retryBusy?: boolean;
  onRetry?: () => void;
}) {
  const requiresAction = ["ACTION_REQUIRED", "FAILED"].includes(props.progress.stage);
  const detail = props.progress.currentChapter
    ? `${props.progress.currentChapter.title} · ${props.progress.completedChapters}/${props.progress.totalChapters} 章节完成`
    : props.progress.totalChapters > 0
      ? `${props.progress.completedChapters}/${props.progress.totalChapters} 章节完成`
      : "正在准备学习结构";
  const diagnostic = requiresAction && props.progress.operationId
    ? `操作 ${props.progress.operationId.slice(0, 8)}`
    : null;
  return (
    <section className={props.compact ? "project-progress-indicator project-progress-indicator-compact" : "project-progress-indicator"} aria-label="项目生成进度">
      <div className="project-progress-copy">
        <span className={requiresAction ? "text-[var(--danger)]" : "text-[var(--accent)]"}>
          {requiresAction ? <CircleAlert /> : props.progress.stage === "READY" ? null : <LoaderCircle className="animate-spin" />}
          {stageLabels[props.progress.stage]}
          {props.progress.retrying ? " · 正在重试" : ""}
        </span>
        <small title={requiresAction ? props.progress.operationId ?? undefined : undefined}>
          {detail}{diagnostic ? ` · ${diagnostic}` : ""}
        </small>
      </div>
      <strong>{props.progress.progressPercent}%</strong>
      <div className="project-progress-track"><i style={{ width: `${props.progress.progressPercent}%` }} /></div>
      {props.progress.stage === "ACTION_REQUIRED" && props.onRetry ? <button
        type="button"
        className="project-progress-retry command-button command-button-quiet"
        disabled={props.retryBusy}
        onClick={props.onRetry}
      >
        {props.retryBusy ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
        {props.retryBusy ? "正在恢复" : "继续处理"}
      </button> : null}
      {!props.compact ? <MonadLearningFlow progress={props.progress} /> : null}
    </section>
  );
}
