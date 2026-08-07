# Mindmark 系统架构优化方案

> 历史说明：本文记录 2026-07 的 V1 -> V2 收敛实施。Card Pack、原版 PDF、三视图与 Chapter AI Tutor 上线后的当前演进方案见 [Mindmark 整体架构优化与演进方案](OVERALL_ARCHITECTURE_OPTIMIZATION_PLAN.md)。下文“Runner-only AI”仅指会生成或修改学习内容的异步 AI；同步、只读的 Chapter AI Tutor 属于后续 Web 能力。

> 状态：本地架构实施完成，待真实环境演练  
> 前提：旧业务数据可以丢弃；新版本尚未对外承载正式用户数据  
> 范围：Web、Runner、共享领域代码、Supabase、Monad 合约集成、测试和运维  
> 不变的产品模型：`文件夹 -> Learning Project（一个资料） -> Chapter -> Knowledge Card`

## 1. 决策摘要

本次优化采用 **V2 收敛，而不是继续兼容 V1** 的策略。

1. `Learning Project -> Chapter -> Knowledge Card` 成为唯一可写、可学习、可结算的领域模型；`Learning Journey -> Chunk` 完全退出运行路径。
2. 系统保持“一个 Next.js Web BFF + 一个独立 Runner + Supabase + Monad”的模块化单体形态，不引入消息中间件或微服务集群。
3. Supabase 是学习状态、任务状态和审计记录的权威来源；Monad 只保存不可篡改承诺和确认结果，不承担业务调度。
4. Web 只处理身份、资料上传、命令提交和视图读取。所有模型调用、链上写入、质量门和奖励结算只在 Runner 内执行。
5. 因为历史数据可丢弃，数据库采用一次性 **V2 基线重建**，而不是在 V1/V2 混合 schema 上继续叠加迁移。
6. 文件夹始终只是资料组织元数据，不能影响 source hash、outline hash、Work Unit、链上承诺、知识卡引用或复习记录。

这样可以删除双模型、双 Runner 和双合约适配器带来的长期复杂度，同时保留当前已经实现的“资料先分章节，再生成多张知识卡”的正确业务方向。

## 实施进度

- 已完成：V1 `Learning Journey -> Chunk` 运行路径、合约、迁移、共享计算和测试已移除；V2 成为唯一模型。
- 已完成：迁移链重建为 V2 基线，资料库与文件夹保持为不参与承诺的组织元数据。
- 已完成：`PLAN_OUTLINE` 已接入 `workflow_jobs`。Web 只登记/读取操作，Runner 负责 AI 规划、确定性降级、卡片策略和草稿落库。
- 已完成：`RECONCILE_PROJECT`、`GENERATE_WORK_UNIT`、`QUALITY_CHECK_CHAPTER`、`ASSEMBLE_CHAPTER`、`FINALIZE_PROJECT` 和 `SETTLE_WORK_UNIT_REWARD` 已接入同一队列。Coordinator 只恢复和分发 job；旧的全局扫描领取 RPC 已从运行路径和最终 schema 删除。
- 已完成：`PLAN_OUTLINE` 也已收敛到同一 Workflow Dispatcher。Outline Planner 只负责已领取任务的规划与草稿持久化，claim、complete、retry 统一由 Dispatcher 处理；Coordinator 不再维护第二套大纲轮询循环。
- 已完成：受限 `/operations` 页面、脱敏工作流事件、队列/奖励指标、核心告警和带 request ID 的稳定错误合同已接入；旧 Journey/Chunk 实施文档已删除。
- 待真实环境：按 `PRODUCTION_REHEARSAL_RUNBOOK.md` 重建可丢弃 Supabase、部署 V2 Registry 并执行真实 PDF、Monad、模型、Moss 和故障注入验收。

## 2. 现状与问题

### 2.1 已具备的正确能力

- V2 已有稳定的 Source Block、Chapter、Work Unit、Knowledge Card、逐卡 FSRS 和章节级进度模型。
- 已实现资料库、文件夹、一个资料对应一个 Learning Project、章节学习页和质量门。
- Source Block 已保存 `headingLevel`，确定性 Chapter Planner 会优先使用最高层级标题，不再把所有小节都直接升级为 Chapter。
- Chapter 已有 `minCardCount / targetCardCount / maxCardCount`，质量门会在链上 Work Unit commitment 之前拒绝不满足最小卡数的候选集。
- 链上创建回调丢失时，Runner 已能通过 Registry reconciliation 重新推进 `AWAITING_REGISTRY` 项目。

### 2.2 架构摩擦

| 优先级 | Module | 证据 | 问题 |
| --- | --- | --- | --- |
| P0 | V1/V2 运行路径 | `apps/agent-runner/src/runtime.ts` 仍以 `RUNNER_VERSION` 启动两套 Coordinator；Web 仍保留 `/api/journeys`、`/learn/legacy`；合约和测试也有两套 | 每次修改领域规则、环境变量、部署、测试和排障都要理解两套不兼容模型。 |
| P0 | Supabase migration Module | 当前 10 个 migration 先创建 V1，再用多个 `create or replace` 补出 V2 和纠偏规则 | 新环境必须理解历史顺序；schema 的最终形态分散，旧表和旧 RPC 仍可被误调用。 |
| P0 | Chapter Planning Module | `apps/web/lib/server/chapter-planner.ts` 和 `apps/agent-runner/src/chapter-planner.ts` 各自实现模型协议、工具定义和降级逻辑 | 同一 AI 行为有两个实现，提示词、超时、验证和失败语义容易漂移；Web 也被迫持有 AI 密钥。 |
| P1 | Workflow Module | Runner 轮询中顺序扫描 reconciliation、Work Unit、质量门、组装、项目完成和奖励 | 阶段交接依赖多个专用 RPC 和固定轮询顺序；重试、可观测性和扩展新阶段的 Locality 较差。 |
| P1 | Web application Module | `project-study.ts`、`projects.ts`、`library.ts` 同时包含用例、Supabase 查询、行映射和错误转换 | 领域用例的 Interface 被数据库细节放大，单测需要了解大量表字段，替换或演进 Adapter 的成本较高。 |
| P1 | Chain integration Module | Web 创建回执校验、Runner reconciliation、Runner 写链各自读取 Registry | 链上读取、事件校验、幂等和故障分类没有单一实现，存在规则重复。 |
| P2 | 构建与验证 Module | `packages/shared/src` 中同时存在 TypeScript 源码和历史 JavaScript/声明文件；当前测试仍包含 V1 与 V2 | 产物来源不清晰，测试信号被历史路径稀释，未来改动容易误碰旧代码。 |

### 2.3 删除测试

删除 V1 Module 后，不会迫使复杂度重新分散：正常学习、资料库、复习、Worker、奖励和链上承诺都已由 V2 表、V2 Registry 和 V2 Runner 覆盖。因此 V1 当前是纯兼容负担，不再提供运行期 Leverage，应当删除而不是继续加 Adapter。

## 3. 目标架构

```text
Browser
  -> Next.js Web BFF
       - SIWE wallet session
       - Command API: register source / request outline / confirm outline / review
       - Query API: library / project / chapter / study queue / operation status
  -> Supabase PostgreSQL
       - V2 domain data and transactional command functions
       - Workflow job outbox and immutable operational events
       - RLS and service-role-only data access

Independent Runner
  -> claims one Workflow Job at a time
       - Outline Planner
       - Work Unit Worker Pool
       - Chapter Quality Gate
       - Chapter Assembler
       - Project Finalizer
       - Registry Reconciler
       - Settlement Agent
  -> AI Model Adapter / Monad Registry Adapter / Moss Adapter

Monad
  -> V2 LearningProjectRegistry commitments and receipts only
```

### 3.1 权威性划分

| 数据或行为 | 权威 Module | 其他系统的职责 |
| --- | --- | --- |
| 资料、章节、知识卡、FSRS、任务状态 | Supabase V2 schema 和事务函数 | Web/Runner 只通过受限 Interface 读写。 |
| 用户身份和资源归属 | Web 的 SIWE session Module | 客户端不提交 owner address；数据库按 server-side owner 校验。 |
| 章节边界、卡片策略、哈希、Merkle 规则 | Shared Domain Module | AI 只能提交候选内容，不能选择 ID、hash、proof 或状态。 |
| AI 生成与修复 | Runner Model Adapter | Web 只显示 Operation 状态和最终结果。 |
| 链上事实 | V2 Registry Adapter | Supabase 保存已验证 receipt 和可恢复的创建/提交意图。 |
| Worker Reward | Settlement Agent | 奖励失败只能阻塞该 Reward，绝不回滚 Chapter 或 Project 的 `READY`。 |

## 4. Module 收敛设计

不以技术层名强行拆分 package，而是围绕领域概念建立深 Module。每个 Module 的 Interface 要小于其 Implementation；数据库、模型和链的细节保留在 Adapter 内。

### 4.1 Shared Domain Module

保留 `@mindmark/shared` 作为纯领域 package，并按概念重组为：

```text
packages/shared/src/
  learning-project/     # status、Chapter、Work Unit、Knowledge Card、card policy
  source/               # intake、heading level、citation、source hashes
  commitments/          # domain-separated hash、Merkle、Registry ABI types
  study/                # FSRS input/output schema，不访问数据库
  library/              # folder 和 document query schema
  index.ts
```

Interface 只包含 schema、纯函数、领域错误和 test vectors。它不读取环境变量、不调用 Supabase、不发 HTTP、不调用模型、不签链上交易。

`Source Intake`、`Chapter Planning`、`Work Planning` 和 `Chapter Card Policy` 继续是独立深 Module：调用方只传结构化 Source Block 和明确输入，内部隐藏标题层级、连续覆盖、短章节合并、卡片数约束、hash 与 proof 细节。

### 4.2 Learning Project Workflow Module

新增统一的异步 Workflow Module，替代“Coordinator 固定轮询顺序 + 多个孤立 claim RPC”的扩散状态机。

```ts
type WorkflowJobKind =
  | "PLAN_OUTLINE"
  | "RECONCILE_PROJECT"
  | "GENERATE_WORK_UNIT"
  | "QUALITY_CHECK_CHAPTER"
  | "ASSEMBLE_CHAPTER"
  | "FINALIZE_PROJECT"
  | "SETTLE_WORK_UNIT_REWARD";

type WorkflowJob = {
  id: string;
  kind: WorkflowJobKind;
  projectId: Hex;
  chapterId?: number;
  workUnitId?: number;
  attempt: number;
  availableAt: string;
};
```

数据库增加 `workflow_jobs`（可领取队列）和 `workflow_events`（只追加审计日志）。每个命令在同一数据库事务中同时完成领域状态变更和 job/outbox 写入，例如：

```text
register source        -> PLAN_OUTLINE
confirm outline        -> RECONCILE_PROJECT
Registry created       -> GENERATE_WORK_UNIT × N
all candidates ready   -> QUALITY_CHECK_CHAPTER
quality approved       -> GENERATE_WORK_UNIT（仅修复项）或 ASSEMBLE_CHAPTER
chapter ready          -> FINALIZE_PROJECT（仅最后一章）
work unit confirmed    -> SETTLE_WORK_UNIT_REWARD
```

`claim_workflow_job_v2` 使用 `FOR UPDATE SKIP LOCKED`、lease、指数退避和唯一幂等键。它是 Runner 的唯一队列 Interface；具体 Handler 再调用所属领域 Module。数据库仍然最终校验状态迁移和 owner，不能只依赖 Runner 内存。

这不是引入外部消息队列：项目最多 48 个 Work Unit，PostgreSQL 足以提供所需的吞吐和恢复能力。一个 job 的失败、重试、耗时和最后错误都集中在同一 Module，提供更好的 Locality 和运维 Leverage。

### 4.3 Model Generation Module

将 Web 与 Runner 中重复的 Chapter Planner 合并到 Runner。抽取唯一的模型协议和工具定义：

```text
apps/agent-runner/src/model/
  gateway.ts            # OpenAI-compatible transport, timeout, error classification
  chapter-planner.ts    # tool loop + deterministic fallback
  card-generator.ts     # Work Unit tool loop
  prompts.ts            # versioned prompts and tool schemas
```

- `PLAN_OUTLINE` job 从 Source Block 读取资料，AI Planner Adapter 产出 proposal，Shared Domain Module 统一验证连续覆盖和 card policy；任一模型、schema 或覆盖错误都在该 Module 内降级为确定性 Planner。
- `GENERATE_WORK_UNIT` job 只产出候选卡；所有引用、card count、hash 和 proof 都由服务端验证、派生和保存。
- prompt/version、模型名、耗时、token 使用量（可用时）和拒绝原因进入 `workflow_events`。不得记录原始密钥、完整私密资料或完整模型 transcript。
- Web 的异步 Project/Chapter 生成路径不再需要 AI 配置；后续 Chapter AI Tutor 通过 Web server-only 环境使用独立白名单配置，密钥不进入浏览器。

AI Planner Adapter 与 Deterministic Planner Adapter 是两个真实 Adapter，因此该 seam 有清晰价值；不为只有一个 Supabase 实现的简单查询引入无意义的 Repository 抽象。

### 4.4 Application Module 与 Adapter

Web 的 server 代码按用例收敛，而不是让每个文件同时承担 HTTP、领域、Supabase 和 DTO 映射。

```text
apps/web/lib/server/
  application/
    library.ts          # list/create/rename/move/delete folder
    project-intake.ts   # register source, request/retry outline, confirm outline
    project-query.ts    # project/chapter/operation views
    study.ts            # chapter/project queue, score, complete session
    auth.ts             # nonce, SIWE verification, session lifecycle
  adapters/
    supabase/           # one adapter per real persistence interface
    registry/           # read-only receipt validation client
  http/
    errors.ts
    request-schemas.ts
```

Route Handler 只做四件事：读取 session、解析 schema、调用 application Module、转换为稳定 HTTP 错误。SQL 行名和 Supabase error 文本不得越过 application Module。

Runner 使用同一原则：`workflow/handlers/*` 只依赖小 Interface（job claim、project bundle、event recorder、Registry Gateway、Model Gateway）。`SupabaseWorkflowAdapter`、`ViemRegistryAdapter` 和 `MossRewardAdapter` 是具体 Adapter。

### 4.5 Chain Integration Module

合并 Web 的创建回执验证与 Runner 的 chain read 逻辑，提供一个 V2-only `Registry Gateway`：

```ts
interface RegistryGatewayV2 {
  verifyProjectCreated(intent: ProjectCreationIntent, txHash: Hex): Promise<VerifiedReceipt>;
  readProject(projectId: Hex): Promise<OnChainProject | null>;
  commitWorkUnit(input: WorkUnitCommitment): Promise<VerifiedReceipt>;
  finalizeChapter(input: ChapterCommitment): Promise<VerifiedReceipt>;
  finalizeProject(input: ProjectCommitment): Promise<VerifiedReceipt>;
}
```

浏览器回调只是“尽快验证”的优化：它记录 tx hash 并入队 `RECONCILE_PROJECT`。Runner 的 reconciliation 才是最终补偿机制。所有 receipt、event 参数和合约地址都由同一个 Gateway 验证，避免 Web 和 Runner 规则漂移。

ABI 从 Foundry 构建产物生成到一个明确的受控目录；TypeScript 不再手写并长期维护另一份 ABI。V1 `LearningJourneyRegistry` 及其部署脚本、ABI 和测试移入历史归档后删除，不再打包或部署。

## 5. 数据库与迁移方案

### 5.1 最终 V2 schema

保留并收敛为以下表组：

| 表组 | 表 | 责任 |
| --- | --- | --- |
| 身份 | `auth_nonces`、`wallet_sessions` | SIWE 验证和短期 Web session。 |
| 资料库 | `project_folders`、`learning_projects`、`source_blocks` | 文件夹与一个资料对应一个 Project。 |
| 大纲 | `project_outline_versions`、`project_outline_items`、`chapters` | 草稿版本和已确认的稳定 Chapter。 |
| 执行 | `work_units`、`workflow_jobs`、`workflow_events` | 内部并行、恢复、重试和审计；学习者界面绝不展示 Work Unit。 |
| 学习 | `knowledge_cards`、`card_learning_states`、`review_sessions`、`project_review_logs` | 卡片、FSRS 和可审计复习。 |
| 奖励 | `work_unit_rewards` | 与 Work Unit commitment 一对一且独立于学习状态。 |

删除 V1 专属表、函数、索引、测试数据和运行代码：

```text
learning_journeys, source_chunks, review_logs, agent_events,
session_summaries, worker_rewards, prepare_learning_journey,
claim_journey_generation, claim_chunk_generation, ...
```

`auth_nonces` 与 `wallet_sessions` 虽然最初随 V1 migration 创建，但仍是当前身份 Module 的有效表，必须保留并纳入 V2 baseline。

### 5.2 一次性重建，而非数据迁移

由于已经确认旧数据可不要，推荐在首次正式上线前执行以下流程：

1. 进入维护窗口，阻止 Web 和 Runner 写入；保留一次加密备份仅供故障回看。
2. 使用新的单一 `supabase/migrations/<timestamp>_v2_baseline.sql` 重建 `public` schema，包含上述最终表、约束、函数、索引、RLS、RPC grant 和初始 metadata。
3. 清理远程 migration history 后仅登记该 baseline；仓库内旧 migration 移到 `supabase/legacy-migrations/`，不能再被部署工具自动执行。
4. 以空数据库运行 baseline integration test、RLS test 和真实 wallet 的 smoke test。
5. 只在全部闸门通过后重新开放 Web 和 Runner。

这是一次 **数据库重建**，不是“把旧 Journey 数据转成 Project”的数据迁移。它会清空旧的 V1 与当前 V2 测试数据；执行前必须再次确认该时点没有需要保留的新资料。

### 5.3 约束与安全要求

- 每个写入 RPC 都以 owner、当前状态、版本或 idempotency key 做条件；冲突返回明确业务错误，不使用静默覆盖。
- 所有持久化层不变量同时由 `CHECK` / `FK` / 唯一索引和事务函数表达：完整 Source Block 覆盖、Work Unit 不跨 Chapter、Chapter 的最小卡数、卡片引用范围、同一资料请求幂等、同一奖励只创建一次。
- 使用 `security definer` 的函数固定 `search_path`，撤销 `anon`/`authenticated` 的表与函数访问，只授予 service role 最小必需执行权限。
- 浏览器永远不能获得 service role、AI key、Worker 私钥、Reward Treasury 私钥或未过滤的操作日志。
- Source Block 和卡片正文包含用户资料，日志只记录 id、hash、计数和受限错误摘要；原文不得进入标准运行日志。

## 6. 前端与 API 收敛

### 6.1 视图与操作分离

```text
GET  /api/library                         -> 文件夹与当前目录的资料摘要
POST /api/projects/intake                 -> 只登记资料，返回 projectId / operationId
POST /api/projects/:id/outline/request    -> 幂等请求 PLAN_OUTLINE
GET  /api/projects/:id/operations/:id     -> 大纲或生成进度
POST /api/projects/:id/outline/confirm    -> 确认指定草稿版本
POST /api/projects/:id/create-tx          -> 记录 tx hash 并触发 reconciliation
GET  /api/projects/:id                    -> Project + Chapter 摘要
GET  /api/projects/:id/chapters/:chapterId -> Chapter 与卡片/队列
POST /api/projects/:id/.../reviews        -> 原子评分
```

所有 API 错误使用稳定的 `{ code, message, requestId }` 合同。对运行中任务返回 `202 Accepted` 和 Operation 视图，不把“数据库已写入”误报为“章节已经生成完成”。

### 6.2 前端信息架构

- `/learn` 是资料库；文件夹和 PDF/资料为主列表，草稿明确标注为“待分析资料结构”。
- 用户点击已确认资料后进入 Project 工作区；左侧是 Chapter，右侧是 Chapter 内容、卡片和复习入口。
- Chapter 是资料的连续范围，界面不得使用“AI 生成章节内容”这样的文案；生成的是 Knowledge Card。
- Work Unit、链上 proof、Worker 地址和结算细节仅进入运营诊断页，不进入学习者页面。
- 大型 `learning-workbench.tsx`、`journey-workspace.tsx` 和 V1 页面随 V1 删除；V2 的 library、creation、project workspace 按 data hook、状态机和展示组件拆分，避免单个客户端组件同时处理路由、请求、钱包、表单和页面渲染。

## 7. Runner 与运行可靠性

### 7.1 Job Handler 规则

- 一个 Handler 只处理一个已领取的 job；必须可以安全重复执行。
- 先保存候选内容，再写链上；链上 tx hash 一产生即持久化；receipt 成功后才推进最终状态。
- 外部调用必须有超时、可分类错误、指数退避和最大尝试次数。超出次数后进入人工可见的 `FAILED_RETRYABLE`，不得无限循环。
- lease 到期由 job reclaim 统一恢复，不能依赖进程内 `setInterval` 状态。
- `ProjectCoordinatorV2` 收敛为 job polling loop，不再了解每个业务阶段的固定顺序；阶段依赖由发出 job 的数据库事务保证。

### 7.2 可观测性

每个 request、job、链上交易和奖励使用关联 ID。至少记录和告警：

- `outline / work unit / chapter / project` 各阶段耗时与失败率；
- job backlog、lease 超时、重试次数、死信数量；
- 卡片候选数、去重率、引用失败率、最低卡数修复率；
- 链上确认延迟、receipt mismatch、RPC 错误率；
- Reward 的 pending/blocked/settled 数量；
- Web API 的 4xx/5xx、session 验证失败和 Supabase RPC 错误。

运营视图只读取 `workflow_events` 与聚合指标，不从 learner UI 推断 Runner 状态。

## 8. 测试与质量闸门

### 8.1 分层测试

| 层 | 必须验证 |
| --- | --- |
| Shared Domain Module | hash vectors、标题层级、完整覆盖、短 Chapter 合并、card policy、Work Unit 不跨章、引用范围和状态转移。 |
| Supabase baseline | 空库只执行一次 baseline；所有 RPC 的正常、并发、重复请求、非法 owner、非法状态、RLS 和索引计划。 |
| Workflow Module | 每种 job 至少覆盖成功、重复执行、lease 过期、模型失败、链上 pending/成功/失败、质量修复、最后一章完成和奖励失败。 |
| Adapter contract | Fake Model、Fake Registry、真实 Supabase RPC、真实 V2 ABI receipt 解码的合同测试。 |
| Web E2E | 钱包 session 后创建文件夹、上传 PDF、等待大纲、确认、进入章节、完成一张卡、刷新后进度正确；覆盖桌面与移动视口。 |
| Solidity | V2 Registry 的 Project/Work Unit/Chapter/Project 完成状态机、权限、重放、Merkle proof 和 hash vector。 |

### 8.2 发布闸门

1. `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`forge test` 和 `git diff --check` 全部通过。
2. baseline 在全新 PGlite/Postgres 上可重复部署；远程 migration history 与本地只含 V2 baseline 一致。
3. 真实 Supabase 环境的 RLS 与 service-role RPC smoke test 通过。
4. 使用一份 PDF 走通“资料 -> 多个 Chapter -> 每章至少两张 Knowledge Card -> 复习 -> 刷新恢复”。
5. 注入模型超时、浏览器在链上交易后关闭、Runner 重启、RPC 超时、奖励失败，确认学习状态不会卡死或回滚。

## 9. 实施顺序

### Phase 0：冻结决策与安全基线

- 记录本方案中的 V2-only、Supabase 权威、异步内容生成只在 Runner、Postgres job queue 四项决策。
- 删除或撤销曾写入本地环境的高权限 token；确认 `.env*` 没有被提交。
- 对当前 V2 路径跑一次完整回归，建立重构前基线。

### Phase 1：清理 V1 与建立 V2 baseline

- 删除 V1 Web routes、UI、Runner、Shared schema、Solidity 合约、部署脚本、fixtures 和测试。
- 生成并测试单一 V2 baseline migration；保留 auth 表，加入 workflow 表。
- 在可丢弃环境重建 `public` schema，登记新的 migration history。
- **验收**：仓库中没有 `RUNNER_VERSION`、`Journey`、`Chunk`、`/api/journeys` 或 V1 Registry 的运行引用；空库测试可直接启动。

### Phase 2：统一 Application、Model 与 Registry Module

- 将 Web 的 Chapter Planner 移至 Runner，Web 改成 operation command/query。
- 统一 V2 Registry Gateway、错误分类、receipt 校验和 reconciliation。
- 整理 Web application Module 与 Supabase Adapter，Route Handler 变薄。
- **验收**：Web 不执行异步内容生成；`propose_chapters` 模型协议只存在 Runner；所有浏览器链上回调都可由 Runner 恢复。后续同步 Chapter AI Tutor 的 server-only 配置不改变此约束。

### Phase 3：实现 Workflow Job Queue（已完成）

- 新建 `workflow_jobs`、`workflow_events`、claim/complete/retry RPC 及状态迁移约束。
- 已将 V2 的 reconciliation、Work Unit 生成、质量门、Chapter 组装、Project 完成和 Reward 结算逐项接入 job queue；Coordinator 不再按固定顺序扫描领域状态。
- 旧的 `claim_next_*` / `recover_stale_work_units_v2` RPC 已删除；保留精确资源的 claim RPC，作为单个 Handler 内部的事务状态转换。
- **验收**：Runner 被中断或同一 job 被再次执行时，不重复创建卡片、commitment、Chapter 或 Reward；每个失败可定位到 job 和关联 ID。

### Phase 4：前端收敛与运营可见性（已完成）

- 已删除 legacy 页面和相互冲突的 V1 实施手册；V2 客户端只展示资料、Chapter、Knowledge Card 和学习进度。
- Outline Operation 已接入创建流程；API 错误统一返回 `code / message / requestId`。
- `/operations` 仅允许 `OPERATOR_WALLET_ADDRESSES` 白名单会话读取，展示脱敏 job/event、队列与 Reward 指标，以及 stale/failed/blocked 告警。
- 数据库、Web application 和 Runner 的集成测试覆盖 operation、workflow dispatch、质量修复和完整 Project pipeline；真实钱包浏览器 E2E 纳入 Phase 5 演练。
- **验收**：学习者只看到资料、Chapter、Knowledge Card 和学习进度；运营人员能在不查数据库原表的情况下诊断卡住任务。

### Phase 5：生产演练（待真实环境）

- 按 `PRODUCTION_REHEARSAL_RUNBOOK.md` 在独立 Supabase project 和测试网完成全流程与故障注入。
- 仅在数据确认为可清空时，按 5.2 的维护流程重建正式环境；部署 Web、Runner、V2 Registry 地址和监控配置。
- **验收**：发布闸门全部通过后再开放上传入口。

## 10. 非目标与风险控制

- 不将 Supabase 替换为自建数据库、Kafka、Temporal 或微服务。这些会增加 Interface、部署和运维复杂度，当前规模没有相应 Leverage。
- 不把 Folder 纳入链上承诺，也不把 Work Unit 暴露为产品层级。
- 不尝试把旧 Journey/Chunk 数据自动转为 Project/Chapter；已经明确其数据可丢弃。
- 不在没有验证 migration history 的情况下直接对远程 schema 执行局部 SQL。

最大风险是“已有人在新 V2 库中上传资料后再重建数据库”。因此最终重建前必须重新检查 Project 数量、暂停写入并获得一次明确确认；之后所有 schema 演进都从 V2 baseline 继续新增、不可改写已部署 migration。

## 11. 完成定义

当以下条件同时满足时，本次架构优化完成：

1. 仓库和部署环境仅有一个 V2 学习模型、一个 Runner 启动模式、一个 Registry Gateway 和一个数据库 baseline。
2. 一份资料只生成一个 Learning Project；Project 下有稳定连续的 Chapter；每个 `READY` Chapter 至少有两张通过引用验证的 Knowledge Card。
3. AI、链上交易和奖励的任一失败都可重试、可观测，且不会破坏已经 `READY` 的学习内容。
4. Web、Runner、Supabase 与 Monad 的职责边界清晰，调用者不需要理解 Work Unit、SQL 行结构或链上 receipt 才能使用学习功能。
5. 上述测试、RLS、恢复演练和真实资料验收均可重复通过。
