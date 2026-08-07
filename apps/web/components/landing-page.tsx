import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  BrainCircuit,
  CalendarDays,
  Layers3,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";

export function LandingPage() {
  return (
    <main className="home-shell min-h-screen text-[var(--ink)]">
      <header className="home-header">
        <div className="mx-auto flex h-[72px] w-full max-w-7xl items-center justify-between px-5 md:px-8">
          <div className="flex items-center gap-3">
            <span className="home-logo-mark">
              <BookOpen aria-hidden="true" className="size-5" />
            </span>
            <div>
              <p className="font-display text-xl font-semibold leading-none">Mindmark</p>
              <p className="mt-1 font-mono text-[10px] text-[var(--muted)]">
                可验证学习系统
              </p>
            </div>
          </div>
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
          <p className="home-eyebrow">
            <span /> AI 学习助手 × Monad
          </p>
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
              进入学习页
              <ArrowRight aria-hidden="true" className="size-5" />
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
            <div>
              <span>实时生成流程</span>
              <strong>资料到知识卡</strong>
            </div>
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
            <div>
              <span>已验证卡组</span>
              <strong>18 张知识卡已形成可验证承诺</strong>
            </div>
            <span className="font-mono text-[11px]">0x7c…a91f</span>
          </div>
        </div>
      </section>

      <section className="home-principles border-y border-[var(--line)]">
        <div className="mx-auto grid w-full max-w-7xl md:grid-cols-3">
          <div>
            <Layers3 aria-hidden="true" className="size-5" />
            <span>01 / AI 拆解</span>
            <strong>不是整章摘要，而是可以独立回忆的原子知识卡</strong>
          </div>
          <div>
            <ShieldCheck aria-hidden="true" className="size-5" />
            <span>02 / Monad 验证</span>
            <strong>记录生成者身份、分段承诺与最终卡组根哈希</strong>
          </div>
          <div>
            <CalendarDays aria-hidden="true" className="size-5" />
            <span>03 / 间隔复习</span>
            <strong>到期卡优先，FSRS 为每张卡安排独立节奏</strong>
          </div>
        </div>
      </section>

      <section className="landing-closing mx-auto w-full max-w-7xl px-5 py-18 md:px-8 md:py-24">
        <div>
          <p className="section-kicker">从资料开始</p>
          <h2 className="font-display mt-3 max-w-3xl text-4xl font-semibold leading-tight md:text-6xl">
            让 AI 负责整理，<br />把时间留给真正的理解与记忆。
          </h2>
        </div>
        <Link href="/learn" className="home-primary-action">
          打开学习工作台
          <ArrowRight aria-hidden="true" className="size-5" />
        </Link>
      </section>
    </main>
  );
}
