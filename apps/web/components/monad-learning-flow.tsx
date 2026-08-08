import { Check, CircleAlert, CircleDot, ShieldCheck } from "lucide-react";
import type { LearnerProjectProgress } from "@mindmark/shared/learning-project";

type FlowState = "pending" | "active" | "complete" | "error";

function chainState(stage: LearnerProjectProgress["stage"]): FlowState {
  if (stage === "AWAITING_MONAD") return "active";
  return ["GENERATING_CARDS", "CHECKING_QUALITY", "REPAIRING_CARDS", "ASSEMBLING_CHAPTERS", "READY", "ACTION_REQUIRED", "FAILED"].includes(stage)
    ? "complete"
    : "pending";
}

function workerState(stage: LearnerProjectProgress["stage"]): FlowState {
  if (["GENERATING_CARDS", "CHECKING_QUALITY", "REPAIRING_CARDS", "ASSEMBLING_CHAPTERS"].includes(stage)) return "active";
  if (["ACTION_REQUIRED", "FAILED"].includes(stage)) return "error";
  if (["READY"].includes(stage)) return "complete";
  return "pending";
}

function escrowState(stage: LearnerProjectProgress["stage"]): FlowState {
  if (stage === "AWAITING_MONAD") return "active";
  return ["GENERATING_CARDS", "CHECKING_QUALITY", "REPAIRING_CARDS", "ASSEMBLING_CHAPTERS", "READY", "ACTION_REQUIRED", "FAILED"].includes(stage)
    ? "complete"
    : "pending";
}

function mossState(stage: LearnerProjectProgress["stage"]): FlowState {
  return stage === "READY" ? "active" : "pending";
}

function FlowItem(props: { index: string; label: string; detail: string; state: FlowState; icon: typeof Check }) {
  const Icon = props.state === "error" ? CircleAlert : props.icon;
  return <div className="monad-learning-flow-item" data-state={props.state}>
    <span>{props.state === "complete" ? <Check /> : <Icon />}</span>
    <div><small>{props.index}</small><strong>{props.label}</strong><em>{props.detail}</em></div>
  </div>;
}

export function MonadLearningFlow(props: { progress: LearnerProjectProgress }) {
  const { stage } = props.progress;
  return <section className="monad-learning-flow" aria-label="Monad 与 Moss 学习链路">
    <div className="monad-learning-flow-heading">
      <span>ONCHAIN LEARNING TRACE</span>
      <small>生成状态与链上安全边界</small>
    </div>
    <div className="monad-learning-flow-grid">
      <FlowItem index="01" label="Monad Registry" detail={chainState(stage) === "active" ? "等待钱包签名" : chainState(stage) === "complete" ? "项目已登记" : "章节确认后登记"} state={chainState(stage)} icon={CircleDot} />
      <FlowItem index="02" label="Sponsor Escrow" detail={escrowState(stage) === "active" ? "等待项目预算锁定" : escrowState(stage) === "complete" ? "完整预算已锁定" : "等待 Monad 登记"} state={escrowState(stage)} icon={CircleDot} />
      <FlowItem index="03" label="AI Workers" detail={workerState(stage) === "active" ? "生成与质量检查中" : workerState(stage) === "complete" ? "生成流程完成" : workerState(stage) === "error" ? "生成流程需要处理" : "等待项目预算"} state={workerState(stage)} icon={CircleDot} />
      <FlowItem index="04" label="Moss Agent" detail={mossState(stage) === "active" ? "奖励与凭证可审阅" : "Quality Gate 后审阅释放"} state={mossState(stage)} icon={ShieldCheck} />
    </div>
    <p className="monad-learning-flow-note">Moss 审阅每笔 Escrow release，但不持有 Treasury 私钥；原始资料和卡片正文不会写入 Monad。</p>
  </section>;
}
