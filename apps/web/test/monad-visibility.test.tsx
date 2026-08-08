import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LearnerProjectProgress } from "@mindmark/shared/learning-project";
import { MonadLearningFlow } from "@/components/monad-learning-flow";
import { MonadRegistrationCard } from "@/components/monad-registration-card";
import { MossOnchainAgentBanner } from "@/components/moss-onchain-agent-banner";

const progress: LearnerProjectProgress = {
  projectId: `0x${"11".repeat(32)}`,
  stage: "AWAITING_MONAD",
  progressPercent: 40,
  currentChapter: null,
  completedChapters: 0,
  totalChapters: 4,
  phaseCounts: {
    generation: { completed: 0, total: 4 },
    qualityCheck: { completed: 0, total: 4 },
    automaticRepair: { completed: 0, total: 0, active: 0 },
    assembly: { completed: 0, total: 4 },
    completion: { completed: 0, total: 1 },
  },
  retrying: false,
  updatedAt: "2026-08-07T00:00:00.000Z",
  operationId: null,
  code: null,
};

describe("Monad visibility components", () => {
  it("explains the real Monad registration boundary and reward economics", () => {
    const markup = renderToStaticMarkup(
      <MonadRegistrationCard
        projectId={progress.projectId}
        chainId={10143}
        registryAddress={`0x${"22".repeat(20)}`}
        explorerUrl="https://testnet.monadexplorer.com"
        busy={false}
        onCreate={() => undefined}
      />,
    );
    expect(markup).toContain("MONAD REGISTRY / V2");
    expect(markup).toContain("在 Monad 创建项目");
    expect(markup).toContain("Sponsor Treasury 为全部 Work Unit 锁定生成预算");
    expect(markup).toContain("查看合约");
  });

  it("shows Monad, AI Worker, and Moss stages without claiming Moss generates cards", () => {
    const markup = renderToStaticMarkup(<MonadLearningFlow progress={progress} />);
    expect(markup).toContain("Monad Registry");
    expect(markup).toContain("AI Workers");
    expect(markup).toContain("Moss Agent");
    expect(markup).toContain("等待钱包签名");
    expect(markup).toContain("Moss 审阅每笔 Escrow release");
    expect(markup).toContain("Sponsor Escrow");
  });

  it("shows a failed AI Worker stage as requiring action", () => {
    const markup = renderToStaticMarkup(<MonadLearningFlow progress={{
      ...progress,
      stage: "ACTION_REQUIRED",
    }} />);
    expect(markup).toContain("生成流程需要处理");
    expect(markup).toContain('data-state="error"');
    expect(markup).not.toContain("生成与质量检查中");
  });

  it("makes Moss visible before the per-reward evidence details", () => {
    const markup = renderToStaticMarkup(<MossOnchainAgentBanner rewardCount={3} verifiedCount={2} />);
    expect(markup).toContain("MOSS ONCHAIN AGENT");
    expect(markup).toContain("Discover → Load → Action → Simulate");
    expect(markup).toContain("2 / 3");
    expect(markup).toContain("不持有私钥、不签名、不广播交易");
  });
});
