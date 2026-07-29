# Mindmark

Mindmark 把一份上传资料整理为可确认的 Chapter，并在每个 Chapter 下生成带逐字引用的 Knowledge Card，使用 FSRS 安排复习。

```text
文件夹
  -> Learning Project（一个 PDF 或文本资料）
      -> Chapter（连续 Source Block 范围）
          -> Knowledge Card（引用原资料）
```

`Work Unit` 仅用于 Runner 并行、链上 commitment 和奖励结算，不出现在学习者导航中。

## 本地运行

要求 Node.js 22、pnpm 10 和 Foundry。

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
forge test
```

Web 与 Runner 分开启动：

```bash
pnpm --filter @mindmark/web dev
pnpm --filter @mindmark/agent-runner dev
```

配置见 `.env.example`。私钥、模型 Key、Supabase service role Key 和 Session Secret 只能放在服务端环境变量中。

## V2 流程

```text
上传 PDF / 文本
-> Source Intake
-> `PLAN_OUTLINE` Workflow Job
-> Runner 生成章节大纲（模型失败时确定性降级）
-> 用户确认 Chapter
-> `RECONCILE_PROJECT` Workflow Job 创建 Monad Learning Project V2
-> `GENERATE_WORK_UNIT` Workflow Job 生成候选 Knowledge Card 并提交 Work Unit commitment
-> `QUALITY_CHECK_CHAPTER` / `ASSEMBLE_CHAPTER` Workflow Job 形成 Chapter
-> Chapter READY，可立即学习
-> `FINALIZE_PROJECT` Workflow Job 形成 Project READY
-> `SETTLE_WORK_UNIT_REWARD` Workflow Job 独立结算 Worker Reward
```

Supabase 是学习状态、任务状态和审计记录的权威来源。所有 Runner 阶段都从 `workflow_jobs` 领取精确资源；Monad 只保存 Project、Work Unit、Chapter 和 Project 的不可篡改承诺，它不调度模型，也不判断知识卡语义。Reward Treasury 独立于 Registry 和 Worker 钱包，Moss 只用于验证原生 MON 转账计划，最终交易由 Treasury signer 广播。

## 数据库

当前仓库只保留 V2 migration。首次部署到可丢弃环境时，清空 `public` schema 和远程 migration history 后，按 `supabase/migrations` 文件名顺序执行。不要把旧 Journey/Chunk 数据迁入新的 Project/Chapter 模型。

详细设计与上线闸门见 [系统架构优化方案](docs/SYSTEM_ARCHITECTURE_OPTIMIZATION_PLAN.md)。

## 运营诊断

服务端配置 `OPERATOR_WALLET_ADDRESSES` 后，白名单钱包可访问 `/operations` 查看脱敏的 Workflow Job、最近事件、队列与 Reward 指标。学习者页面不会展示 Work Unit、Worker 地址或结算细节。

真实环境重建、V2 Registry 部署和故障注入步骤见 [生产演练手册](docs/PRODUCTION_REHEARSAL_RUNBOOK.md)。

## 已知限制

- 仅支持文本型、最多 30 页和 15 MB 的 PDF，提取文本最多 60,000 字符；扫描件需要粘贴文本。
- 卡片 Hash 可以证明内容未被 commitment 后篡改，不能证明知识内容必然正确。
- Runner、Supabase、Monad 与模型的生产验收需要有效凭据和 Gas。
