import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  BrainCircuit,
  CalendarDays,
  Code2,
  ExternalLink,
  Layers3,
  ShieldCheck,
  WalletCards,
  Workflow,
  Zap,
} from "lucide-react";
import Link from "next/link";

const implementationDetails = [
  {
    index: "01",
    title: "把 AI 输出变成可验收的工作流",
    description: "从大纲、章节设计到 Worker 生成、质量门禁和最终组装，每一步都可恢复、可重试、可观察。",
    path: "apps/agent-runner/src / workflow-dispatcher-v2.ts",
    icon: Workflow,
  },
  {
    index: "02",
    title: "让链上支付只执行确定动作",
    description: "报价冻结、预算锁定、结果承诺和奖励释放分层建模；Moss 模拟后才交给独立 Treasury 签名。",
    path: "contracts/src / LearningProjectEscrow.sol",
    icon: ShieldCheck,
  },
  {
    index: "03",
    title: "把学习体验做成完整闭环",
    description: "原文定位、知识卡双视图、主动回忆、FSRS 复习调度和钱包会话，都在同一条端到端路径里协作。",
    path: "apps/web/features / learning-workspace",
    icon: BookOpen,
  },
  {
    index: "04",
    title: "用测试和迁移守住系统边界",
    description: "共享类型、Web、Runner 和合约分别验证；数据库能力检查让部署缺口在任务进入队列前暴露。",
    path: "packages/shared/test · supabase/migrations",
    icon: Code2,
  },
];

const stack = [
  ["产品层", "Next.js 16 · React 19 · TypeScript"],
  ["智能层", "OpenAI-compatible Gateway · 多 Agent Runner"],
  ["链上层", "Solidity · Foundry · viem · Monad"],
  ["数据层", "Supabase · PostgreSQL · Storage · FSRS"],
];

export function LandingPage() {
  return (
    <main className="home-shell project-showcase-shell min-h-screen text-[var(--ink)]">
      <header className="home-header">
        <div className="mx-auto flex h-[72px] w-full max-w-7xl items-center justify-between px-5 md:px-8">
          <Link href="/" className="flex items-center gap-3 text-[var(--ink)] no-underline" aria-label="Mindmark 首页">
            <span className="home-logo-mark">
              <BookOpen aria-hidden="true" className="size-5" />
            </span>
            <span>
              <span className="font-display block text-xl font-semibold leading-none">Mindmark</span>
              <span className="mt-1 block font-mono text-[10px] text-[var(--muted)]">可验证学习系统</span>
            </span>
          </Link>
          <Link href="/learn" className="landing-workbench-entry">
            <span className="landing-workbench-copy">
              <span className="landing-workbench-kicker">学习工作台</span>
              <span className="landing-workbench-label">进入学习页</span>
            </span>
            <span className="landing-workbench-arrow">
              <ArrowUpRight aria-hidden="true" className="size-4" />
            </span>
          </Link>
        </div>
      </header>

      <section className="home-hero mx-auto grid w-full max-w-7xl gap-12 px-5 pb-16 pt-14 md:px-8 md:pb-22 md:pt-20 lg:grid-cols-[minmax(0,1.08fr)_minmax(400px,0.92fr)] lg:items-center">
        <div className="home-reveal">
          <p className="home-eyebrow"><span /> AI 学习助手 × Monad</p>
          <h1 className="font-display mt-7 max-w-3xl text-[clamp(3rem,7vw,6.6rem)] font-semibold leading-[0.94]">
            让资料变成
            <span className="home-title-accent">真正记得住</span>
            的知识。
          </h1>
          <p className="mt-8 max-w-xl text-base leading-8 text-[var(--muted)] md:text-lg">
            上传课程资料，AI 生成服务并行拆成带出处的知识卡；Monad 记录生成承诺，FSRS 再根据你的记忆表现安排复习。
          </p>
          <div className="mt-9">
            <Link href="/learn" className="home-primary-action">
              进入学习页 <ArrowRight aria-hidden="true" className="size-5" />
            </Link>
          </div>
          <div className="landing-proof-line">
            <span>资料不直接上链</span>
            <span>卡片保留原文出处</span>
            <span>复习由 FSRS 调度</span>
          </div>
        </div>

        <div className="home-ledger home-reveal home-reveal-delay">
          <div className="home-ledger-heading">
            <div><span>实时生成流程</span><strong>资料到知识卡</strong></div>
            <span className="home-live-dot">Monad 测试网</span>
          </div>
          <div className="home-source-slip">
            <span className="font-mono text-[10px] text-[var(--accent)]">原始资料 / 08 页</span>
            <p>“外部调用会转移执行控制权……”</p>
            <div><span /><span /><span /></div>
          </div>
          <div className="home-worker-grid">
            {["概念拆解", "机制分析", "防御方法"].map((label, index) => (
              <div key={label} className="home-worker-node">
                <span>W.{index + 1}</span>
                <BrainCircuit aria-hidden="true" className="size-5" />
                <strong>{label}</strong>
                <small>独立生成 · 已引用</small>
              </div>
            ))}
          </div>
          <div className="home-chain-record">
            <ShieldCheck aria-hidden="true" className="size-5" />
            <div><span>已验证卡组</span><strong>18 张知识卡已形成可验证承诺</strong></div>
            <span className="font-mono text-[11px]">0x7c…a91f</span>
          </div>
        </div>
      </section>

      <section className="home-principles border-y border-[var(--line)]">
        <div className="mx-auto grid w-full max-w-7xl md:grid-cols-3">
          <div><Layers3 aria-hidden="true" className="size-5" /><span>01 / AI 拆解</span><strong>不是整章摘要，而是可以独立回忆的原子知识卡</strong></div>
          <div><ShieldCheck aria-hidden="true" className="size-5" /><span>02 / Monad 验证</span><strong>记录生成者身份、分段承诺与最终卡组根哈希</strong></div>
          <div><CalendarDays aria-hidden="true" className="size-5" /><span>03 / 间隔复习</span><strong>到期卡优先，FSRS 为每张卡安排独立节奏</strong></div>
        </div>
      </section>

      <section className="portfolio-section portfolio-case-study">
        <div className="portfolio-section-heading">
          <div>
            <p className="portfolio-kicker">PRODUCT FLOW / MINDMARK</p>
            <h2>从资料到复习与结算的完整链路。</h2>
          </div>
          <p>从用户上传资料开始，到 AI 结果被验证并结算结束，所有关键状态都有明确的边界。</p>
        </div>
        <div className="portfolio-case-grid">
          <article>
            <div className="portfolio-icon-box"><BrainCircuit aria-hidden="true" /></div>
            <span>01 / AI 生产</span>
            <h3>把生成拆成可以失败的 Work Unit</h3>
            <p>大纲、概念清单、卡片蓝图和候选内容分步执行，质量门禁只放行带引用、覆盖重点且难度合适的结果。</p>
          </article>
          <article>
            <div className="portfolio-icon-box"><WalletCards aria-hidden="true" /></div>
            <span>02 / 约束支付</span>
            <h3>用 Monad 记录可核验结果</h3>
            <p>Registry、Escrow、Completion 三个合约各自负责身份、预算和完成证明，报价在生成前冻结，奖励在验收后释放。</p>
          </article>
          <article>
            <div className="portfolio-icon-box"><Zap aria-hidden="true" /></div>
            <span>03 / 学习闭环</span>
            <h3>让内容真正进入人的记忆</h3>
            <p>原文与知识卡双视图、主动回忆和 FSRS 调度连接在一起，学习进度不依赖链上写入也能稳定恢复。</p>
          </article>
        </div>
      </section>

      <section className="portfolio-section portfolio-evidence-section">
        <div className="portfolio-section-heading">
          <div>
            <p className="portfolio-kicker">IMPLEMENTATION DETAILS</p>
            <h2>关键机制都有明确的实现边界。</h2>
          </div>
          <p>可恢复工作流、链上约束、学习状态与质量验证分别落在对应模块中。</p>
        </div>
        <div className="portfolio-evidence-list">
          {implementationDetails.map((item) => {
            const Icon = item.icon;
            return (
              <article key={item.index} className="portfolio-evidence-row">
                <span className="portfolio-evidence-index">{item.index}</span>
                <div className="portfolio-evidence-icon"><Icon aria-hidden="true" /></div>
                <div className="portfolio-evidence-copy">
                  <h3>{item.title}</h3>
                  <p>{item.description}</p>
                  <code>{item.path}</code>
                </div>
                <ArrowUpRight aria-hidden="true" className="portfolio-evidence-arrow" />
              </article>
            );
          })}
        </div>
      </section>

      <section className="portfolio-stack-section">
        <div className="portfolio-stack-heading">
          <p className="portfolio-kicker">TECH STACK / FOUR LAYERS</p>
          <h2>从学习界面到链上合约，保持清晰的系统边界。</h2>
        </div>
        <div className="portfolio-stack-list">
          {stack.map(([label, value]) => (
            <div key={label}><span>{label}</span><strong>{value}</strong><ArrowRight aria-hidden="true" /></div>
          ))}
        </div>
      </section>

      <section className="landing-closing mx-auto w-full max-w-7xl px-5 py-18 md:px-8 md:py-24">
        <div>
          <p className="section-kicker">从资料开始</p>
          <h2 className="font-display mt-3 max-w-3xl text-4xl font-semibold leading-tight md:text-6xl">
            让 AI 负责整理，<br />把时间留给真正的理解与记忆。
          </h2>
        </div>
        <div className="project-closing-actions">
          <Link href="/learn" className="home-primary-action">打开学习工作台 <ArrowRight aria-hidden="true" className="size-5" /></Link>
          <a href="https://github.com/tobaizhizhi/Mindmark" target="_blank" rel="noreferrer" className="home-secondary-action">查看项目源码 <ExternalLink aria-hidden="true" className="size-4" /></a>
        </div>
      </section>
    </main>
  );
}
