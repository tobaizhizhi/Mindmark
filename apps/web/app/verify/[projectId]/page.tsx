import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { unstable_cache } from "next/cache";
import {
  ArrowLeft,
  ArrowUpRight,
  Blocks,
  BookOpen,
  Braces,
  Check,
  ChevronDown,
  CircleAlert,
  CircleDashed,
  Clock3,
  Cpu,
  FileSearch,
  Landmark,
  Link2,
  ScanLine,
  Search,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import {
  Bytes32Schema,
  type MonadEvidenceState,
  type MossOnchainReview,
  type MonadVerificationSnapshot,
} from "@mindmark/shared";
import { formatEther } from "viem";
import { ApiError } from "@/lib/server/http";
import { getMonadVerificationSnapshot } from "@/lib/server/monad-verification";
import { MossOnchainAgentBanner } from "@/components/moss-onchain-agent-banner";

export const revalidate = 10;

export const metadata: Metadata = {
  title: "Monad 项目验证 | Mindmark",
  description: "公开核验 Mindmark Learning Project 的 Monad 生成承诺与 Worker Reward。",
};

const loadSnapshot = unstable_cache(
  (projectId: `0x${string}`) => getMonadVerificationSnapshot(projectId),
  ["monad-verification-snapshot-v3"],
  { revalidate: 10 },
);

const stateCopy: Record<MonadEvidenceState, { label: string; detail: string }> = {
  VERIFIED: { label: "已核验", detail: "关键承诺与 Monad 状态一致" },
  PENDING: { label: "进行中", detail: "仍有链上阶段尚未完成" },
  MISMATCH: { label: "证据冲突", detail: "本地索引与链上状态存在差异" },
  UNAVAILABLE: { label: "暂不可用", detail: "本次无法读取完整辅助证据" },
};

const projectStatusLabels = {
  NONE: "不存在",
  CREATED: "生成承诺已登记",
  READY: "最终卡组已登记",
  CANCELLED: "已取消",
} as const;

function shortHex(value: string, head = 10, tail = 8) {
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function explorerLink(snapshot: MonadVerificationSnapshot, kind: "tx" | "address", value: string) {
  return `${snapshot.explorerUrl.replace(/\/$/u, "")}/${kind}/${value}`;
}

function StateMark({ state, compact = false }: { state: MonadEvidenceState; compact?: boolean }) {
  const Icon = state === "VERIFIED" ? Check
    : state === "PENDING" ? Clock3
      : state === "MISMATCH" ? CircleAlert
        : CircleDashed;
  return <span className="verification-state" data-state={state} data-compact={compact}>
    <Icon aria-hidden="true" />
    <span>{stateCopy[state].label}</span>
  </span>;
}

function HashReference(props: {
  snapshot: MonadVerificationSnapshot;
  value: string;
  kind?: "tx" | "address";
  emptyLabel?: string;
}) {
  if (/^0x0+$/u.test(props.value)) return <span className="verification-empty">{props.emptyLabel ?? "尚未写入"}</span>;
  const content = <code title={props.value}>{shortHex(props.value)}</code>;
  if (!props.kind) return content;
  return <a
    className="verification-reference"
    href={explorerLink(props.snapshot, props.kind, props.value)}
    target="_blank"
    rel="noreferrer"
    title={`在 Monad Explorer 查看 ${props.value}`}
  >{content}<ArrowUpRight aria-hidden="true" /></a>;
}

function TransactionReference(props: { snapshot: MonadVerificationSnapshot; value: string | null }) {
  return props.value
    ? <HashReference snapshot={props.snapshot} value={props.value} kind="tx" />
    : <span className="verification-empty">暂无交易索引</span>;
}

function VerificationUnavailable(props: { projectId: string; message: string }) {
  return <main className="verification-shell">
    <header className="verification-topbar">
      <Link href="/" className="verification-brand"><span><BookOpen /></span><strong>Mindmark</strong></Link>
      <Link href="/learn" className="verification-back"><ArrowLeft />返回学习页</Link>
    </header>
    <section className="verification-error">
      <CircleAlert />
      <p>Monad 证据暂时无法读取</p>
      <h1>{props.message}</h1>
      <code>{props.projectId}</code>
    </section>
  </main>;
}

const mossStages = [
  { key: "DISCOVERED", label: "Discover", icon: Search },
  { key: "LOADED", label: "Load", icon: FileSearch },
  { key: "BUILT", label: "Action", icon: Braces },
  { key: "SIMULATED", label: "Simulate", icon: ScanLine },
] as const;

const mossStageOrder = ["PENDING", "DISCOVERED", "LOADED", "BUILT", "SIMULATED"] as const;

function MossRewardEvidence(props: { review: MossOnchainReview }) {
  const currentStage = mossStageOrder.indexOf(props.review.stage);
  const simulationPassed = props.review.simulation.status === "PASSED"
    && props.review.simulation.warningCodes.length === 0;
  return <details className="verification-moss-proof">
    <summary>
      <span><ShieldCheck />Moss 审阅证据</span>
      <small>{props.review.capability.protocol}.{props.review.capability.method}</small>
      <strong data-passed={simulationPassed}>{simulationPassed ? "模拟通过" : props.review.simulation.status}</strong>
      <ChevronDown />
    </summary>
    <div className="verification-moss-body">
      <div className="verification-moss-intent">
        <small>STRUCTURED INTENT</small>
        <p>{props.review.intent}</p>
        <span>{props.review.networkSupport === "EXPERIMENTAL_TESTNET" ? "实验性 Testnet 兼容" : "官方 Mainnet"} · SDK {props.review.sdkVersion}</span>
      </div>
      <ol className="verification-moss-stages">
        {mossStages.map((stage) => {
          const Icon = stage.icon;
          const complete = currentStage >= mossStageOrder.indexOf(stage.key);
          return <li key={stage.key} data-complete={complete}>
            <span><Icon /></span>
            <strong>{stage.label}</strong>
            {complete ? <Check /> : <Clock3 />}
          </li>;
        })}
      </ol>
      <div className="verification-moss-facts">
        <div><small>PLAN HASH</small>{props.review.planHash ? <code title={props.review.planHash}>{shortHex(props.review.planHash)}</code> : <span>尚未构造</span>}</div>
        <div><small>DECLARED RISK</small><strong>{props.review.capability.declaredRisks.length > 0 ? props.review.capability.declaredRisks.join(", ") : "无资产风险"}</strong></div>
        <div><small>SIMULATION GAS</small><strong>{props.review.simulation.gas ?? "不可估算"}</strong></div>
        <div><small>WARNINGS</small><strong data-passed={props.review.simulation.warningCodes.length === 0}>{props.review.simulation.warningCodes.length}</strong></div>
        <div><small>SIGNER OUTFLOW</small><strong>{formatEther(BigInt(props.review.expectedEffects.nativeOutWei))} MON</strong></div>
        <div><small>APPROVALS</small><strong>{props.review.expectedEffects.approvalCount}</strong></div>
      </div>
      {props.review.simulation.warningCodes.length > 0
        ? <p className="verification-moss-warning"><CircleAlert />{props.review.simulation.warningCodes.join(" · ")}</p>
        : <p className="verification-moss-boundary"><Wallet />Moss 只验证未签名交易；独立 Reward Treasury 保留签名和广播权。</p>}
    </div>
  </details>;
}

export default async function MonadVerificationPage(
  props: { params: Promise<{ projectId: string }> },
) {
  const { projectId: rawProjectId } = await props.params;
  const parsedProjectId = Bytes32Schema.safeParse(rawProjectId);
  if (!parsedProjectId.success) notFound();

  let snapshot: MonadVerificationSnapshot;
  try {
    snapshot = await loadSnapshot(parsedProjectId.data);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    const message = error instanceof ApiError
      ? error.message
      : "请稍后刷新，学习与复习功能不受影响。";
    return <VerificationUnavailable projectId={parsedProjectId.data} message={message} />;
  }
  const projectState = stateCopy[snapshot.overallState];
  const verifiedRewards = snapshot.rewards.filter((reward) => reward.evidenceState === "VERIFIED").length;

  return <main className="verification-shell">
    <header className="verification-topbar">
      <Link href="/" className="verification-brand"><span><BookOpen /></span><strong>Mindmark</strong></Link>
      <div className="verification-network"><i />Monad · Chain {snapshot.chainId}</div>
      <Link href="/learn" className="verification-back"><ArrowLeft />返回学习页</Link>
    </header>

    <div className="verification-page">
      <section className="verification-intro">
        <div>
          <p className="section-kicker">PUBLIC PROOF / REGISTRY V2</p>
          <h1>Monad 项目验证</h1>
          <p>生成内容保留在 Mindmark，身份、哈希承诺和结算结果在 Monad 上核验。</p>
        </div>
        <div className="verification-verdict" data-state={snapshot.overallState}>
          <ShieldCheck aria-hidden="true" />
          <span>{projectState.label}</span>
          <strong>{projectState.detail}</strong>
          <small>读取区块 {snapshot.observedBlock}</small>
        </div>
      </section>

      <section className="verification-project-band">
        <div className="verification-band-heading">
          <span><Blocks />Learning Project</span>
          <StateMark state={snapshot.overallState} />
        </div>
        <div className="verification-project-id">
          <small>PROJECT ID</small>
          <code title={snapshot.projectId}>{snapshot.projectId}</code>
        </div>
        <div className="verification-fact-grid">
          <div><small>链上状态</small><strong>{projectStatusLabels[snapshot.project.status]}</strong></div>
          <div><small>Learner</small><HashReference snapshot={snapshot} value={snapshot.project.learner} kind="address" /></div>
          <div><small>Registry</small><HashReference snapshot={snapshot} value={snapshot.registryAddress} kind="address" /></div>
          <div><small>Project Escrow</small><HashReference snapshot={snapshot} value={snapshot.escrowAddress} kind="address" /></div>
          <div><small>最终卡片</small><strong>{snapshot.project.totalCardCount} 张</strong></div>
          <div><small>创建交易</small><TransactionReference snapshot={snapshot} value={snapshot.project.createTransactionHash} /></div>
          <div><small>完成交易</small><TransactionReference snapshot={snapshot} value={snapshot.project.finalizeTransactionHash} /></div>
        </div>
      </section>

      <section className="verification-section">
        <div className="verification-section-heading">
          <div><span>01</span><h2>承诺根</h2></div>
          <p>原文和卡片不上链，链上只保留可比对的 bytes32 承诺。</p>
        </div>
        <div className="verification-hash-ledger">
          {[
            { label: "资料哈希", value: snapshot.project.sourceHash },
            { label: "学习目标哈希", value: snapshot.project.goalHash },
            { label: "章节大纲哈希", value: snapshot.project.outlineHash },
            { label: "Work Unit 清单根", value: snapshot.project.workUnitManifestRoot },
            { label: "最终卡组根", value: snapshot.project.projectDeckRoot },
            { label: "初始计划哈希", value: snapshot.project.initialPlanHash },
          ].map(({ label, value }) => <div key={label}><span>{label}</span><HashReference snapshot={snapshot} value={value} /></div>)}
        </div>
        <div className="verification-checks">
          {snapshot.checks.map((check) => <div key={check.key}>
            <StateMark state={check.state} compact />
            <strong>{check.label}</strong>
            <span>{check.detail}</span>
          </div>)}
        </div>
      </section>

      <section className="verification-section">
        <div className="verification-section-heading">
          <div><span>02</span><h2>章节完成</h2></div>
          <p>{snapshot.chapters.filter((chapter) => chapter.status === "READY").length} / {snapshot.project.chapterCount} 个 Chapter 已写入 cardsRoot。</p>
        </div>
        <div className="verification-table" role="table" aria-label="Chapter 链上证据">
          <div className="verification-table-head" role="row"><span>Chapter</span><span>Work Units</span><span>Cards Root</span><span>交易</span><span>状态</span></div>
          {snapshot.chapters.map((chapter) => <div className="verification-table-row" role="row" key={chapter.chapterId}>
            <span data-label="Chapter"><b>CH.{String(chapter.chapterId + 1).padStart(2, "0")}</b><small>{chapter.cardCount} 张卡片</small></span>
            <span data-label="Work Units"><code>{chapter.firstWorkUnitId}–{chapter.firstWorkUnitId + chapter.workUnitCount - 1}</code></span>
            <span data-label="Cards Root"><HashReference snapshot={snapshot} value={chapter.cardsRoot} /></span>
            <span data-label="交易"><TransactionReference snapshot={snapshot} value={chapter.transactionHash} /></span>
            <span data-label="状态"><StateMark state={chapter.evidenceState} compact /></span>
          </div>)}
        </div>
      </section>

      <section className="verification-section">
        <div className="verification-section-heading">
          <div><span>03</span><h2>Worker 承诺</h2></div>
          <p>{snapshot.workUnits.length} 个 Work Unit 已由 allowlisted Worker 提交。</p>
        </div>
        <div className="verification-worker-list">
          {snapshot.workUnits.length === 0 ? <p className="verification-empty-row">等待 Worker 提交链上承诺。</p> : snapshot.workUnits.map((workUnit) => <div key={workUnit.workUnitId}>
            <span className="verification-worker-index"><Cpu />WU.{String(workUnit.workUnitId).padStart(2, "0")}</span>
            <div><small>WORKER / CH.{workUnit.chapterId + 1}</small><HashReference snapshot={snapshot} value={workUnit.worker} kind="address" /></div>
            <div><small>CARDS ROOT / {workUnit.cardCount} 张</small><HashReference snapshot={snapshot} value={workUnit.workerCardsRoot} /></div>
            <div><small>COMMITTED BLOCK</small><strong>{workUnit.committedBlock}</strong></div>
            <TransactionReference snapshot={snapshot} value={workUnit.transactionHash} />
            <StateMark state={workUnit.evidenceState} compact />
          </div>)}
        </div>
        <p className="verification-disclosure"><CircleAlert />当前三个 Worker 由同一 Runner 部署协调，这是可验证多 Agent 结算原型，不代表开放的去中心化 Worker 市场。</p>
      </section>

      <section className="verification-section">
        <div className="verification-section-heading">
          <div><span>04</span><h2>Worker Reward</h2></div>
          <p>{verifiedRewards} / {snapshot.rewards.length} 笔 Escrow release 已完成独立核验。</p>
        </div>
        <div className="verification-sponsor-budget">
          <span><Landmark /></span>
          <div><small>SPONSOR BUDGET</small><strong>{formatEther(BigInt(snapshot.sponsorBudget.totalBudgetWei))} MON</strong></div>
          <div><small>PRICING POLICY</small><strong>{snapshot.sponsorBudget.pricingPolicyVersion ?? "等待 funding"}</strong></div>
          <div><small>REMAINING</small><strong>{formatEther(BigInt(snapshot.sponsorBudget.remainingBudgetWei))} MON</strong></div>
          <div><small>FUNDED BY</small><HashReference snapshot={snapshot} value={snapshot.sponsorBudget.sponsor} kind="address" /></div>
          <TransactionReference snapshot={snapshot} value={snapshot.sponsorBudget.fundingTransactionHash} />
          <StateMark state={snapshot.sponsorBudget.evidenceState} compact />
        </div>
        <div className="verification-reward-list verification-pricing-list">
          {snapshot.sponsorBudget.quotes.map((quote) => <div key={quote.workUnitId}>
            <span className="verification-reward-unit"><Landmark />WU.{String(quote.workUnitId).padStart(2, "0")}</span>
            <div><small>WORKLOAD</small><strong>{quote.workloadScore ?? "-"}</strong></div>
            <div><small>TIER</small><strong>{quote.rewardTier ?? "-"}</strong></div>
            <div><small>FROZEN REWARD</small><strong>{formatEther(BigInt(quote.amountWei))} MON</strong></div>
            <StateMark state={quote.evidenceState} compact />
          </div>)}
        </div>
        <MossOnchainAgentBanner rewardCount={snapshot.rewards.length} verifiedCount={verifiedRewards} />
        {snapshot.rewards.length === 0 ? <p className="verification-empty-row">尚无 Reward 结算记录。</p> : <div className="verification-reward-list">
          {snapshot.rewards.map((reward) => <div key={reward.workUnitId}>
            <span className="verification-reward-unit"><Landmark />WU.{String(reward.workUnitId).padStart(2, "0")}</span>
            <div><small>TREASURY</small><HashReference snapshot={snapshot} value={reward.treasury} kind="address" /></div>
            <div><small>ESCROW</small><HashReference snapshot={snapshot} value={reward.escrowAddress} kind="address" /></div>
            <div><small>RECIPIENT</small><HashReference snapshot={snapshot} value={reward.recipient} kind="address" /></div>
            <div><small>AMOUNT</small><strong>{formatEther(BigInt(reward.amountWei))} MON</strong></div>
            <TransactionReference snapshot={snapshot} value={reward.transactionHash} />
            <StateMark state={reward.evidenceState} compact />
            {reward.detail ? <p>{reward.detail}</p> : null}
            <MossRewardEvidence review={reward.mossReview} />
          </div>)}
        </div>}
        <p className="verification-disclosure"><Link2 />Sponsor Treasury 在生成前按冻结的 Work Unit 报价锁定完整预算；对应 Reward 只释放给通过 Quality Gate 并提交 commitment 的 Worker，不向学习者收费。</p>
      </section>

      <section className="verification-section verification-completion-section">
        <div className="verification-section-heading">
          <div><span>05</span><h2>学习完成凭证</h2></div>
          <p>生成完成与学习完成是两条独立证据。</p>
        </div>
        {snapshot.completion ? <div className="verification-completion-proof">
          <ShieldCheck />
          <div><small>LEARNER</small><HashReference snapshot={snapshot} value={snapshot.completion.learner} kind="address" /></div>
          <div><small>DECK ROOT</small><HashReference snapshot={snapshot} value={snapshot.completion.projectDeckRoot} /></div>
          <div><small>PROGRESS HASH</small><HashReference snapshot={snapshot} value={snapshot.completion.progressHash} /></div>
          <div><small>COMPLETED BLOCK</small><strong>{snapshot.completion.completedBlock}</strong></div>
          <StateMark state={snapshot.completion.evidenceState} />
        </div> : <p className="verification-empty-row">该 Project 尚未领取 Learning Completion Attestation。</p>}
      </section>

      <footer className="verification-footer">
        <span>Snapshot {new Date(snapshot.generatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</span>
        <a href={explorerLink(snapshot, "address", snapshot.registryAddress)} target="_blank" rel="noreferrer">在 Explorer 查看 Registry <ArrowUpRight /></a>
      </footer>
    </div>
  </main>;
}
