# Mindmark

Mindmark 把上传资料整理为可确认的 Chapter，并在每个 Chapter 下生成带逐字引用的 Knowledge Card；也支持安装经过校验的预置 Card Pack。编程卡包支持读代码、写代码、补全、修错、运行推理和安全审查。两种来源共用 FSRS 复习，但卡包不会进入 AI、Runner 或 Monad 流程。

```text
文件夹
  -> Learning Project（UPLOAD 资料或 PACK 卡包）
      -> Chapter（连续 Source Block 范围）
          -> Knowledge Card（引用原资料或卡包参考）
```

`Work Unit` 仅用于 Runner 并行、链上 commitment 和奖励结算，不出现在学习者导航中。

## 本地运行

要求 Node.js 22、pnpm 10 和 Foundry。

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @mindmark/shared build
pnpm --filter @mindmark/ai-gateway build
pnpm --filter @mindmark/agent-runner build
pnpm --filter @mindmark/web build
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
-> `RECONCILE_PROJECT` Workflow Job 核验 Monad Project，并由 Sponsor Treasury 锁定完整 Escrow 预算
-> `GENERATE_WORK_UNIT` Workflow Job 生成候选 Knowledge Card
-> `QUALITY_CHECK_CHAPTER` 验收引用、Rubric、重复项与 Blueprint 覆盖
-> 通过后 Worker 才提交 Work Unit commitment，并创建已冻结报价的 Reward entitlement
-> `ASSEMBLE_CHAPTER` Workflow Job 形成 Chapter
-> Chapter READY，可立即学习
-> `FINALIZE_PROJECT` Workflow Job 形成 Project READY
-> `SETTLE_WORK_UNIT_REWARD` Workflow Job 独立结算 Worker Reward
```

Supabase 是学习状态、任务状态和审计记录的权威来源。所有 Runner 阶段都从 `workflow_jobs` 领取精确资源；Monad 保存 Project、Work Unit、Chapter、Project 承诺和 Sponsor Escrow 预算，它不调度模型，也不判断知识卡语义。每个 Work Unit 在生成前按原文规模、Blueprint Slot 类型与难度确定 `S/M/L/XL` 报价，Sponsor 锁定全部报价之和。Reward Treasury 独立于 Registry 和 Worker 钱包；Moss 验证精确的 Escrow release Plan 和模拟结果，最终交易由 Treasury signer 广播。

## 数据库

当前仓库以 V2 学习流程为基线，并包含 PACK 卡包的增量 migration。首次部署到可丢弃环境时，清空 `public` schema 和远程 migration history 后，按 `supabase/migrations` 文件名顺序执行。不要把旧 Journey/Chunk 数据迁入新的 Project/Chapter 模型。

已有环境升级时必须按顺序执行 `20260807000200_generation_failure_recovery.sql`、`20260807000300_dynamic_work_unit_pricing.sql` 和 `20260807000400_legacy_escrow_pricing_recovery.sql`。`002` 会把已耗尽重试的学习 Job 投影为 `FAILED_RETRYABLE`；`003` 冻结每个 Work Unit 的动态报价；`004` 保持迁移前已入金的固定价 Project 可确认，并让已通过 Quality Gate 的 Work Unit 只重放链上提交而不重新调用模型。项目页出现“生成流程需要处理”后可点击“继续处理”。

当前整体设计、模块优化顺序与上线闸门见 [整体架构优化与演进方案](docs/OVERALL_ARCHITECTURE_OPTIMIZATION_PLAN.md)。
V1 到 V2 的历史收敛记录见 [系统架构优化方案](docs/SYSTEM_ARCHITECTURE_OPTIMIZATION_PLAN.md)。
预置学习卡包设计见 [预置学习卡包架构方案](docs/CARD_PACK_ARCHITECTURE.md)。
原文阅读、知识卡浏览和正式复习的双视图设计见 [原文阅读与知识卡双视图实施方案](docs/DOCUMENT_CARD_DUAL_VIEW_IMPLEMENTATION_PLAN.md)。
原版 PDF 预览、可复制文字和私有文件存储见 [原版 PDF 预览架构方案](docs/ORIGINAL_PDF_PREVIEW_ARCHITECTURE.md)。
公开 Monad 证据页、Worker Reward 核验与学习完成凭证见 [Monad 可验证学习层实施文档](docs/MONAD_VERIFIABLE_LEARNING_IMPLEMENTATION.md)。
项目级生成预算、Escrow 与部署顺序见 [Project Sponsor Escrow 实施文档](docs/PROJECT_SPONSOR_ESCROW_IMPLEMENTATION.md)。

默认预置课程为 `solidity-foundations@5.0.0`：16 个线性递进章节、112 张知识卡、48 张 Solidity 代码练习，并为每章提供作者编写的课程正文。按六个阶段展示新概念、先修概念、练习重点和 LearningRegistry 里程碑。课程顺序参考 WTF Academy Solidity 101，但正文、问答和代码均由 Mindmark 重新编写；每章都依赖上一章。

卡包部署顺序：按文件名执行以下 migration：

```text
supabase/migrations/20260801000100_card_packs.sql
supabase/migrations/20260801000200_card_pack_code_exercises.sql
supabase/migrations/20260801000300_card_pack_curriculum_progression.sql
supabase/migrations/20260802000100_card_pack_curriculum_v4.sql
supabase/migrations/20260802000200_card_pack_curriculum_v4_constraints.sql
supabase/migrations/20260802000300_card_pack_reading_v5.sql
supabase/migrations/20260802000400_original_pdf_storage.sql
supabase/migrations/20260803000100_schema_capabilities.sql
```

最后使用 service role 调用 `get_schema_capabilities_v1()`，必须返回 `schemaVersion = 2026-08-07.2`，并且 `coreLearningV2`、`learningDesignV3`、`cardPackReadingV5`、`originalPdfStorage`、`learnerProgress`、`sponsorEscrow` 六项 capability 全部为 `true`、`missing = []`。Web 和 Runner 在启动时都会检查该合同；缺迁移会明确返回 `deployment_schema_outdated`，不会进入 AI 或 Monad 工作流。

然后生成、校验并发布固定内容：

```bash
pnpm packs:generate:solidity:v5
pnpm packs:validate
pnpm packs:publish
```

卡包目录入口为 `/learn/packs`。`packs:publish` 只发布仓库内通过校验的固定版本，重复执行同一 hash 的版本是幂等的。

## 运营诊断

服务端配置 `OPERATOR_WALLET_ADDRESSES` 后，白名单钱包可访问 `/operations` 查看脱敏的 Workflow Job、最近事件、队列与 Reward 指标。学习者页面不会展示 Work Unit、Worker 地址或结算细节。

Upload Learning Project 的公开链上证据入口为 `/verify/[projectId]`。该页面不需要登录，只展示 Registry V2 已公开的地址、哈希、数量、交易引用和经 Monad 交易复核的 Worker Reward，不展示 PDF、Knowledge Card 正文或 FSRS 状态。

`LearningCompletionRegistry` 是可选的独立部署。未配置时不会影响上传、生成、学习或公开验证页；部署并同时配置 server/private 与 browser/public 地址后，全部 Knowledge Card 满足 `reps >= 3 && lapses = 0` 的 learner 才会看到领取入口。详细配置和安全模型见实施文档。

真实环境重建、V2 Registry 部署和故障注入步骤见 [生产演练手册](docs/PRODUCTION_REHEARSAL_RUNBOOK.md)。
保持 Monad Testnet 并把 Web/Runner 部署到公网的具体配置见 [公网 Testnet 部署手册](docs/PUBLIC_TESTNET_DEPLOYMENT.md)。

## 已知限制

- 仅支持文本型、最多 30 页和 15 MB 的 PDF，提取文本最多 60,000 字符；扫描件需要粘贴文本。
- 卡片 Hash 可以证明内容未被 commitment 后篡改，不能证明知识内容必然正确。
- Runner、Supabase、Monad 与模型的生产验收需要有效凭据和 Gas。
