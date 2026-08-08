import { Check, Circle, CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import type { LearnerProjectProgress } from "@mindmark/shared/learning-project";
import { MonadLearningFlow } from "@/components/monad-learning-flow";

const stageLabels: Record<LearnerProjectProgress["stage"], string> = {
  ANALYZING_SOURCE: "正在分析资料",
  OUTLINE_READY: "章节草稿待确认",
  DESIGNING_CARDS: "正在设计知识卡",
  AWAITING_MONAD: "等待 Monad 登记",
  GENERATING_CARDS: "正在生成知识卡",
  CHECKING_QUALITY: "正在检查卡片质量",
  REPAIRING_CARDS: "正在自动修复知识卡",
  ASSEMBLING_CHAPTERS: "正在整理章节",
  READY: "项目可以学习",
  ACTION_REQUIRED: "生成流程需要处理",
  FAILED: "项目未能完成",
};

type PhaseKey = keyof LearnerProjectProgress["phaseCounts"];
type PhaseState = "pending" | "active" | "complete" | "error";

const phaseDefinitions: Array<{
  key: PhaseKey;
  label: string;
  activeStage: LearnerProjectProgress["stage"];
}> = [
  { key: "generation", label: "知识卡生成", activeStage: "GENERATING_CARDS" },
  { key: "qualityCheck", label: "质量检查", activeStage: "CHECKING_QUALITY" },
  { key: "automaticRepair", label: "自动修复", activeStage: "REPAIRING_CARDS" },
  { key: "assembly", label: "章节整理", activeStage: "ASSEMBLING_CHAPTERS" },
  { key: "completion", label: "项目完成", activeStage: "READY" },
];

function phaseState(
  progress: LearnerProjectProgress,
  phase: (typeof phaseDefinitions)[number],
): PhaseState {
  if (["ACTION_REQUIRED", "FAILED"].includes(progress.stage)) return "error";
  const counts = progress.phaseCounts[phase.key];
  if (phase.key === "automaticRepair" && counts.total === 0) return "complete";
  if (counts.total > 0 && counts.completed === counts.total) return "complete";
  if (progress.stage === phase.activeStage) return "active";
  return "pending";
}

function phaseCountLabel(
  key: PhaseKey,
  counts: LearnerProjectProgress["phaseCounts"][PhaseKey],
  stage: LearnerProjectProgress["stage"],
): string {
  if (key === "automaticRepair") {
    const repairCounts = counts as LearnerProjectProgress["phaseCounts"]["automaticRepair"];
    if (repairCounts.active > 0) return `${repairCounts.active} 章处理中`;
    if (repairCounts.total === 0) return "无需修复";
    return `${repairCounts.completed}/${repairCounts.total} 章`;
  }
  if (key === "generation") {
    return counts.total === 0
      ? stage === "READY" ? "已完成" : "等待生成计划"
      : `${counts.completed}/${counts.total} 批次`;
  }
  if (key === "completion") return `${counts.completed}/${counts.total} 项目`;
  if (counts.total === 0) return "等待章节";
  return `${counts.completed}/${counts.total} 章`;
}

export function ProjectProgressIndicator(props: {
  progress: LearnerProjectProgress;
  compact?: boolean;
  retryBusy?: boolean;
  onRetry?: () => void;
}) {
  const requiresAction = ["ACTION_REQUIRED", "FAILED"].includes(props.progress.stage);
  const detail = props.progress.currentChapter
    ? props.progress.currentChapter.title
    : props.progress.totalChapters > 0
      ? "正在准备学习内容"
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
      <div className="project-progress-phases" aria-label="知识卡生成阶段">
        {phaseDefinitions.map((phase) => {
          const state = phaseState(props.progress, phase);
          const counts = props.progress.phaseCounts[phase.key];
          return <div key={phase.key} className="project-progress-phase" data-state={state}>
            <span aria-hidden="true">
              {state === "complete"
                ? <Check />
                : state === "active"
                  ? <LoaderCircle className="animate-spin" />
                  : state === "error" ? <CircleAlert /> : <Circle />}
            </span>
            <strong>{phase.label}</strong>
            <small>{phaseCountLabel(phase.key, counts, props.progress.stage)}</small>
          </div>;
        })}
      </div>
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
