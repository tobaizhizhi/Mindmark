# Mindmark 整体架构优化与演进方案

> 状态：Phase 0-5 已实施；Phase 6 的 Schema Capability 与 Module Interface 主路径已实施，待真实浏览器、模型与 Monad 测试网 smoke
>
> 日期：2026-08-03
>
> 适用范围：Web、Runner、Shared Domain、Supabase、Monad、AI Model、Card Pack、PDF 阅读、AI 导师、复习与运维
>
> 产品阶段：黑客松 MVP，优先保证演示稳定、生成质量、故障可恢复和后续可维护性
>
> 关联文档：[系统架构优化方案](SYSTEM_ARCHITECTURE_OPTIMIZATION_PLAN.md)、[AI 生成质量实施方案](AI_GENERATION_QUALITY_IMPLEMENTATION_PLAN.md)、[预置卡包架构](CARD_PACK_ARCHITECTURE.md)、[原版 PDF 预览架构](ORIGINAL_PDF_PREVIEW_ARCHITECTURE.md)

## 1. 决策摘要

Mindmark 不需要微服务化。目标架构继续保持一个 Next.js Web、一个独立 Runner、一个 Supabase Project 和一个 Monad Registry 的模块化单体形态，通过加深现有 Module 获得更高的 Locality 和 Leverage。

本轮采用以下决策：

1. `Learning Project -> Chapter -> Knowledge Card` 仍是唯一学习主模型；UPLOAD 和 PACK 只是 Learning Project 的两种来源。
2. Supabase 继续作为学习状态、工作流状态、复习状态和审计事件的权威来源；Monad 只保存不可变承诺和确认结果。
3. AI 分成两条不同生命周期：Runner 执行可恢复的异步内容生成；Web 执行低延迟、只读的 Chapter AI Tutor。两者不得共享业务状态机。
4. 保留 PostgreSQL `workflow_jobs`，不引入 Kafka、Temporal、LangGraph 工作流或额外队列。LangGraph 未来只能作为某个 AI Module 的内部 Implementation。
5. Web 不再用一个超大客户端 Module 同时管理认证、查询、PDF、Tutor、复习和反馈；按用户用例拆出深 Module 和明确状态所有权。
6. Runner 不再由一个 1,200 行持久化 Adapter 实现所有领域 Interface；按 Outline、Design、Generation、Commitment、Reward 拆分 Adapter，但继续共享一个 Supabase Client。
7. Shared Domain 按领域概念拆分公开入口，避免所有调用方都依赖 800 行的 `project-v2.ts` 总合同。
8. 优先完成 P0/P1 的低风险重构和观测补强；黑客松结束前不做数据库重建、合约升级或部署单元拆分。

### 1.1 实施结果（2026-08-03）

| Phase | 状态 | 结果 |
| --- | --- | --- |
| 0 | 完成 | 冻结测试基线、错误分类和关联标识约束 |
| 1 | 完成 | 新增 `@mindmark/ai-gateway`，Runner 与 Chapter AI Tutor 共用 Transport |
| 2 | 完成 | Learning Workspace 按 Wallet、Query、PDF/Tutor、Study Session 拆分，顶层约 275 行 |
| 3 | 完成 | Runner Persistence 拆为 Workflow、Design、Generation、Commitment、Reward Adapter |
| 4 | 完成 | Project Lifecycle 拆分；创建页和学习页共用 Learner Project Progress |
| 5 | 完成 | 新代码改用 Learning Project、Chapter、Knowledge Card、Study、Commitments 概念入口 |
| 6 | 部分完成 | Schema Capability、Web/Runner 启动预检、主演示 Module Interface 测试和部署手册已落地；真实浏览器 Playwright 主路径尚未实施 |

仓库自动验证覆盖完整迁移链、Progress、原 PDF、Reading、Tutor 引用回查和 Review。真实模型 tool call 与 Monad receipt 仍必须在具有外部凭据和测试网 Gas 的环境中执行，不能由本地 Fake 替代。

## 2. 当前架构基线

### 2.1 已具备的正确能力

- UPLOAD：PDF 提取为 Source Block，规划 Chapter，设计 Chapter Concept Inventory 与 Card Blueprint，生成并评测 Knowledge Card。
- PACK：版本化、不可变 Card Pack，可安装为用户独立的 PACK Learning Project，直接进入阅读和复习。
- 阅读：Chapter 内支持原版 PDF、提取正文/课程正文、知识卡三种浏览状态。
- AI 导师：可读取当前 Chapter Source Block、当前 PDF 页码和用户选择文字，返回可点击页码引用。
- 复习：Chapter 或 Project 范围的 FSRS 队列，评分通过串行写入避免高延迟阻塞下一张卡。
- 工作流：Runner 通过 `workflow_jobs` 执行 Outline、Design、Generation、Quality、Assembly、Finalization 和 Reward。
- Monad：保存 Project、Work Unit、Chapter 和 Project 完成承诺；奖励失败不回滚学习状态。
- 运维：受限 Operations 页面、Workflow Events、request ID 和基础质量指标已经存在。

### 2.2 当前运行拓扑

```text
Browser
  -> Next.js Web
       -> Supabase PostgreSQL / Storage
       -> Monad RPC（创建交易、读取状态）
       -> AI Model（Chapter AI Tutor，同步只读）

Independent Runner
  -> Supabase Workflow Jobs
  -> AI Model（规划、设计、生成、评测、Embedding）
  -> Monad Registry
  -> Moss Verification / Reward Treasury
```

这个拓扑本身合理。主要问题在拓扑内部的 Module 过宽、状态投影分散和两类 AI Transport 重复，不在于缺少更多基础设施。

## 3. 架构摩擦与证据

| 优先级 | Module | 当前证据 | 架构问题 | 直接影响 |
| --- | --- | --- | --- | --- |
| P0 | Learning Workspace Module | `project-learning-workspace.tsx` 约 1,100 行 | 一个客户端 Module 同时拥有认证、项目查询、Chapter 查询、PDF、Tutor、复习、反馈和渲染状态 | 修改任一交互都容易触发无关重新请求、状态串扰和难以复现的加载问题 |
| P0 | Runner Persistence Module | `repository-v2.ts` 约 1,240 行，实现 6 个以上 Interface | Outline、Design、Worker、Quality、Chain、Reward 的表结构和事务规则集中在一个巨型 Adapter | 变更影响面大，测试 Fake 必须理解不相关方法，故障缺少 Locality |
| P0 | AI Model Module | Runner `model.ts` 与 Web `chapter-ai-tutor.ts` 各自实现 OpenAI-compatible Transport | 超时、重试、错误分类、工具调用解析和模型元数据存在两个 Implementation | 同一上游故障在两条路径表现不同，配置和可观测性容易漂移 |
| P1 | Project Command/Query Module | `projects.ts` 约 700 行，包含 intake、outline、confirmation、creation、list 和 summary | 命令、查询、行解析与 Supabase Adapter 混在一个文件 | Outline schema 变化会连带项目列表；调用方必须理解过多 Interface |
| P1 | Shared Domain Module | `project-v2.ts` 约 830 行，同时导出状态、命令、查询、复习和阅读合同 | 领域概念已经稳定，但公开入口仍按历史文件增长 | 容易形成循环依赖，测试和调用方导入范围过宽 |
| P1 | Project Progress Projection | Project、Chapter、Workflow Job、Work Unit 各有状态，UI 自行组合文案和刷新 | 没有一个面向学习者的可恢复进度投影 | 用户常看到“AI 生成中”但无法判断卡在哪一阶段、是否在重试 |
| P1 | Database Evolution Module | 已累积 20 个迁移，Card Pack、V3 质量、PDF Storage 继续叠加 | 最终 Schema 和 RPC 合同分散在历史迁移中 | 本地测试通过不代表远端 Schema Cache 与函数签名已对齐 |
| P2 | Reading Context Module | PDF、Source Block、Card 引用与 Tutor 各自选择上下文 | 相同页码/引用解析规则没有统一的读取快照 | Tutor、卡片来源和 PDF 跳页可能对同一引用给出不同定位 |

### 3.1 删除测试

- 删除 Learning Workspace Module：认证、并行加载、Tutor、复习串行队列和视图 URL 状态会重新散落到多个页面，因此该 Module 应保留，但必须缩小 Interface、加深 Implementation。
- 删除 `repository-v2.ts` 巨型 Adapter：复杂度不会消失，只会回到每个 Agent。正确做法是把它拆成多个真实 Adapter，而不是删除持久化 Seam。
- 删除 Web 与 Runner 的 AI Transport 重复：重试、超时、错误分类和响应解析会回到每个 AI 调用方。它们值得成为共享的 server-only Transport Module。
- 为每张 Supabase 表创建 Repository Interface：一个表通常只有一个 Adapter，这会增加浅 Module。只有跨多个用例、存在事务规则或已有 Fake Adapter 的领域行为才建立 Seam。

## 4. 目标架构

```text
Browser
  -> Web Application Modules
       Auth Session
       Project Intake / Creation
       Learning Workspace
       Study Session
       Chapter Tutor
       Card Pack Catalog
            |
            +-> Query/Command Adapters -> Supabase
            +-> PDF File Adapter       -> Supabase Storage
            +-> Registry Read Adapter  -> Monad
            +-> AI Gateway             -> Model Provider

Supabase
  Learning data + Review state + Workflow jobs + Operational events
            |
            v
Runner Workflow Module
  Outline -> Chapter Design -> Work Generation -> Quality
          -> Commitments -> Assembly -> Finalization -> Reward
            |
            +-> AI Gateway
            +-> Registry Adapter
            +-> Reward Adapter

Monad
  Immutable commitments and receipts only
```

### 4.1 权威数据划分

| 数据或行为 | 权威 Module | 约束 |
| --- | --- | --- |
| Learning Project、Chapter、Knowledge Card | Supabase Learning Data | Web/Runner 不能以内存状态替代数据库事实 |
| Source Block 与原始 PDF | Supabase PostgreSQL / Private Storage | Source Block 用于检索和引用；PDF 用于视觉还原，两者哈希语义独立 |
| Outline Draft、Chapter Design、Workflow Job | Supabase Workflow | Runner 可重启、可重试，不能依赖进程内图状态 |
| 卡片质量规则、标题规则、hash、Merkle | Shared Domain | AI 只提供候选，不能决定稳定 ID、承诺或状态迁移 |
| FSRS 学习状态 | Supabase Review Data + Shared FSRS policy | 浏览知识卡和 AI 问答不得修改复习状态 |
| AI Tutor 对话 | 浏览器内存（MVP） | 不写链、不写复习状态；页面刷新可丢失 |
| Card Pack Version | Supabase immutable pack tables | 安装后复制为用户独立学习快照，后续版本不原地更新 |
| Project/Work Unit/Chapter 承诺 | Monad Registry | Supabase 保存已核验 receipt 和恢复意图 |
| Worker Reward | Supabase Reward + Treasury receipt | Reward 失败与 Learning Project `READY` 解耦 |

## 5. AI 双路径设计

### 5.1 异步 Learning Content Generation

Runner 负责会改变学习内容或承诺状态的 AI 行为：

```text
Source Blocks
  -> PLAN_OUTLINE
  -> DESIGN_CHAPTER
  -> FREEZE_PROJECT_DESIGN
  -> GENERATE_WORK_UNIT
  -> QUALITY_CHECK_CHAPTER
  -> ASSEMBLE_CHAPTER
  -> FINALIZE_PROJECT
```

要求：

- 每步必须由 Workflow Job 触发，拥有 lease、attempt、availableAt 和幂等键。
- AI 失败只产生 retryable/failed 结果，不允许创建半完成承诺。
- Prompt Version、Model ID、耗时和结构化失败代码进入 Operational Event。
- 确定性降级属于对应 AI Module 的内部 Adapter，调用方不负责判断何时降级。

### 5.2 同步 Chapter AI Tutor

Web 负责不改变学习内容的低延迟问答：

```text
Wallet Session
  -> owned Chapter Reading Snapshot
  -> Context Retrieval（当前页、选中文字、问题相关块）
  -> AI Gateway
  -> Grounded Response Validator
  -> answer + verified citations
```

要求：

- 只读取当前 owner 的 Chapter，不读取整个资料库。
- Source Block 是不可信内容，Prompt 必须防止资料内提示注入。
- 模型引用必须回查真实 blockId、页码和逐字 quote。
- 45 秒硬超时、每 owner 限流、`private, no-store`。
- MVP 对话不持久化；后续如需持久化，应增加独立 Tutor Conversation，而不是复用 Review Session。

### 5.3 共享 AI Gateway，分离业务 Module

新增 server-only package：

```text
packages/ai-gateway/
  src/
    chat-completions.ts
    tool-call.ts
    errors.ts
    telemetry.ts
    index.ts
```

它的 Interface 只隐藏以下 Transport 复杂度：

- base URL、Authorization、请求超时与 AbortSignal 合并；
- 429/5xx 的有限重试策略；
- JSON/tool-call 解析和统一错误分类；
- request duration、provider status、model ID 和 usage 元数据；
- 不记录 API Key、完整资料或完整 Prompt。

Runner 的 Outline/Design/Worker/Evaluator 与 Web 的 Chapter Tutor 是不同业务 Module，只复用 AI Gateway。不要把它们合成一个 `AiService`，也不要让 Web 创建 Workflow Job 来回答一次即时问题。

## 6. 六个深 Module

### 6.1 Shared Domain Module

**问题**：`project-v2.ts` 成为所有合同的聚集文件，Interface 过宽。

**目标目录**：

```text
packages/shared/src/
  learning-project/
    identity.ts
    lifecycle.ts
    commands.ts
    queries.ts
  chapter/
    planning.ts
    concepts.ts
    blueprint.ts
    title.ts
    reading.ts
  knowledge-card/
    content.ts
    policy.ts
    quality.ts
    citations.ts
  study/
    queue.ts
    review.ts
  card-pack/
    manifest.ts
    catalog.ts
    installation.ts
  commitments/
    hash.ts
    merkle.ts
    contract.ts
```

迁移方式：先建立目录内新入口并从旧文件 re-export，保持现有调用方可编译；再逐个调用方改为概念入口；最后删除旧总文件。禁止一次性全仓移动造成无业务价值的 diff。

**收益**：调用方只学习所需的 Interface；领域规则、错误和测试有更高 Locality。

### 6.2 Project Lifecycle Module

将 `projects.ts` 按命令和查询拆分：

```text
apps/web/lib/server/project-lifecycle/
  intake.ts
  outline.ts
  confirmation.ts
  creation.ts
  queries.ts
  supabase-adapter.ts
```

对 Route 暴露五个深 Interface：

```ts
intakeProjectForOwner(input): Promise<ProjectIntakeResult>
requestOutlineForOwner(projectId, owner): Promise<OperationRef>
confirmOutlineForOwner(projectId, owner, version): Promise<CreationIntent>
confirmRegistryCreationForOwner(input): Promise<ProjectCreationView>
getProjectViewForOwner(projectId, owner): Promise<ProjectView>
```

Route 只负责 Session、参数 Schema、调用和 `jsonError`。Supabase 行名、RPC 参数和 Schema Cache 兼容逻辑不泄漏给 Route 或 React。

### 6.3 Learning Workspace Module

将 `project-learning-workspace.tsx` 改为组合器，不再直接持有所有状态。

```text
apps/web/features/learning-workspace/
  learning-workspace.tsx       # 页面布局和子 Module 组合
  use-learning-project.ts      # Project/Chapter 查询与刷新
  chapter-browser.tsx          # pdf/text/cards URL 状态
  pdf-workspace.tsx            # PDF + Tutor 并排布局
  study-session.tsx            # queue、揭晓、评分、完成
  feedback-panel.tsx           # card feedback
  auth-gate.tsx                # wallet session
```

状态所有权：

| 状态 | 唯一 owner |
| --- | --- |
| 当前 Project/Chapter 与浏览视图 | URL |
| Project/Chapter/Reading/Source File 数据 | Query Hook cache |
| PDF active page、scale、target page | PDF Workspace |
| Tutor messages、selected text、busy | Chapter Tutor |
| Review queue、index、answer visible、write queue | Study Session |
| Wallet connection 与 SIWE session | Auth Gate |

选择轻量 query key，例如 `project(id)`、`chapters(id)`、`chapter(id, chapterId)`、`reading(id, chapterId)`、`sourceFile(id)`。评分后只更新 card state 和 counts，不重新请求 PDF 或 Tutor。

### 6.4 Runner Workflow Module

`ProjectWorkflowDispatcherV2` 保持唯一 job 分发 Interface，但 Handler 与持久化 Adapter 按领域拆分：

```text
apps/agent-runner/src/workflow/
  dispatcher.ts
  job-queue-adapter.ts
  handlers/
    plan-outline.ts
    design-chapter.ts
    freeze-design.ts
    reconcile-project.ts
    generate-work-unit.ts
    quality-check-chapter.ts
    assemble-chapter.ts
    finalize-project.ts
    settle-reward.ts

apps/agent-runner/src/persistence/
  workflow-repository.ts
  outline-repository.ts
  design-repository.ts
  generation-repository.ts
  commitment-repository.ts
  reward-repository.ts
  row-mappers.ts
```

这些是多个真实 Adapter，而不是每张表一个浅 Repository：

- Workflow Adapter：claim/complete/retry/recover。
- Design Adapter：Inventory、Blueprint 和 Design Freeze 事务。
- Generation Adapter：Work Unit、Candidate、Evaluation 和 Repair。
- Commitment Adapter：Chapter/Project bundle 与 receipt 持久化。
- Reward Adapter：Moss 阶段、Prepared Transaction 与 confirmation。

每个 Handler 只依赖它需要的最小 Interface；测试 Fake 不再实现整个 Runner 仓库。

### 6.5 Chapter Learning Context Module

统一 Chapter 阅读、来源定位和 Tutor 上下文：

```ts
type ChapterLearningSnapshot = {
  chapter: { id: number; title: string; pageStart: number | null; pageEnd: number | null };
  blocks: ChapterReadingBlock[];
  cardLinks: ChapterCardReadingLink[];
};

loadChapterLearningSnapshot(projectId, chapterId, owner)
  -> ChapterLearningSnapshot
```

在该 Module 内集中：

- UPLOAD Source Block 与 PACK Reading Block 的来源选择；
- 卡片 quote/page 到 blockId 的定位；
- PDF 页码有效范围；
- Tutor 检索排序和上下文预算；
- 模型引用回查。

原始 PDF Signed URL 仍由 Project File Module 提供，不能把 PDF 二进制塞进 Learning Snapshot。

### 6.6 Study Session Module

把 FSRS 队列构建、Session 状态和 Review 写入作为一个深 Module：

```ts
loadStudyQueue({ scope, projectId, chapterId?, owner, now })
submitReview({ sessionId, cardId, rating, expectedVersion })
completeStudySession({ sessionId, owner })
```

要求：

- 新卡无产品上限；持久化 Review Session 可继续按 9 张分段，但该细节隐藏在 Module 内。
- UI 评分后立即乐观前进；数据库写入保持串行并在退出前 flush。
- 并发冲突只重算当前卡一次，不能重新加载整个 Project。
- 浏览卡片、阅读 PDF、询问 Tutor 均不能创建 Review 或推进 FSRS。

## 7. Learner-facing Progress Projection

新增一个只读投影，避免 UI 根据十余种底层状态拼文案：

```ts
type LearnerProjectProgress = {
  stage:
    | "ANALYZING_SOURCE"
    | "OUTLINE_READY"
    | "DESIGNING_CARDS"
    | "AWAITING_MONAD"
    | "GENERATING_CARDS"
    | "CHECKING_QUALITY"
    | "READY"
    | "ACTION_REQUIRED"
    | "FAILED";
  progressPercent: number;
  currentChapter: { chapterId: number; title: string } | null;
  completedChapters: number;
  totalChapters: number;
  retrying: boolean;
  updatedAt: string;
  operationId: string | null;
};
```

投影由 Supabase View/RPC 或 Web Query Module 从权威状态生成，不能成为新的可写状态机。UI 只负责显示，不根据 `workflow_jobs` 猜业务迁移。

建议进度权重：

```text
Source/Outline  20%
Chapter Design  20%
Card Generation 35%
Quality/Repair  15%
Commit/Assemble 10%
```

失败时返回结构化 `stage + code + retrying + requestId/operationId`，不再只显示“The request could not be completed”或永久“AI 生成中”。

## 8. 数据库与迁移治理

### 8.1 当前阶段

- 不改写已经部署的历史 migration。
- 每次新增 RPC 都添加独立 migration，并在 `database-migration.test.ts` 中验证最终函数签名。
- Web/Runner 启动检查记录 `schema_capabilities`，例如 Tutor、PDF Storage、Card Pack v5、Learning Design v3 所需列和函数。
- Schema Cache 缺失错误必须映射为 `deployment_schema_outdated`，附需要执行的 migration 名，不直接抛原始 PostgREST 消息给用户。

已实现 `get_schema_capabilities_v1()`，稳定返回以下合同：

```ts
{
  schemaVersion: "2026-08-03.1";
  capabilities: {
    coreLearningV2: boolean;
    learningDesignV3: boolean;
    cardPackReadingV5: boolean;
    originalPdfStorage: boolean;
    learnerProgress: boolean;
  };
  missing: string[];
}
```

Web 通过 `instrumentation.ts` 在 Node Runtime 启动时预检，Runner 在构造模型和启动 Coordinator 前预检。RPC 缺失、缺列、缺表、缺函数和 PostgREST Schema Cache 错误统一映射为 HTTP `503 deployment_schema_outdated`，并指向 `20260803000100_schema_capabilities.sql`。原 PDF 查询不再把缺迁移静默伪装成 `MISSING` 文件。

`originalPdfStorage` 除了检查 `learning_projects` 的五个文件元数据列，还会在 Supabase Storage 存在时验证 `learning-source-files` bucket 为私有、上限 15 MB 且只接受 `application/pdf`。列已存在但 bucket 丢失或变为公开时，预检必须失败，不能等到用户上传才暴露。

### 8.2 黑客松后

若正式上线前允许清空环境，再生成一个经过验证的 current baseline；如果已经存在真实用户数据，则只追加 migration，不做基线重建。

### 8.3 事务规则

以下行为必须由数据库函数原子完成：

- Outline confirm 与 Chapter/Design Job 创建；
- Workflow Job 完成与下一阶段 Job 入队；
- Candidate approval/repair 与 Work Unit 状态变更；
- Work Unit confirmation 与 Reward 入队；
- Review state compare-and-set 与 Review Event 写入；
- Card Pack Installation 幂等创建。

## 9. 可观测性与错误合同

### 9.1 关联标识

```text
requestId -> operationId -> workflowJobId -> projectId/chapterId/workUnitId -> txHash
```

Web 响应、Runner Event 和 Operations 页面都应保留可用的关联标识。浏览器不需要看到内部 Work Unit，但错误详情可携带 operationId 供排障。

### 9.2 稳定错误分类

| 分类 | 示例 code | 是否重试 |
| --- | --- | --- |
| 认证/归属 | `authentication_required`, `project_not_found` | 用户动作 |
| 请求内容 | `invalid_request`, `pdf_invalid` | 修改输入 |
| 部署不一致 | `deployment_schema_outdated` | 运维修复 |
| AI 临时失败 | `ai_rate_limited`, `ai_timed_out`, `ai_model_failed` | 是 |
| AI 内容失败 | `ai_invalid_response`, `quality_rejected` | Runner 修复/有限重试 |
| 数据冲突 | `outline_version_conflict`, `review_conflict` | 重新读取后重试 |
| 链上失败 | `registry_pending`, `registry_reverted`, `receipt_mismatch` | 按分类处理 |
| Storage | `source_file_missing`, `source_file_unavailable` | 重传/重签 URL |

### 9.3 MVP 指标

- Outline p50/p95 总耗时和失败率；
- Chapter Design、Work Unit Generation、Quality Repair 各阶段耗时；
- 每章 target/accepted cards、引用失败率、duplicate rate、repair count；
- Workflow backlog、stale lease、attempt、failed job；
- Tutor p50/p95、超时率、无引用回答率和 429；
- Review click-to-next-card 前端延迟、持久化失败率和冲突率；
- PDF Signed URL 失败、页面渲染失败和重传次数；
- Monad receipt 确认耗时及 mismatch；
- Reward pending/blocked/confirmed，但 Reward 告警不得影响学习健康指标。

## 10. 缓存与性能策略

| 数据 | 缓存策略 | 失效条件 |
| --- | --- | --- |
| Card Pack Catalog/Detail | public, versioned cache | 新 Card Pack Version 发布 |
| Owner Project/Chapter | private short cache 或 query cache | lifecycle/feedback/review mutation |
| Chapter Reading Snapshot | private per chapter cache | UPLOAD immutable blocks 或 PACK version 固定，项目删除时失效 |
| Source File Signed URL | 浏览器内存，按 expiresAt 提前刷新 | 过期、403 或重传 |
| Tutor response | MVP 不缓存 | 每次问题含当前页/选区/历史 |
| Study Queue | 浏览器会话 cache | 每次评分局部更新，完成时重新校准 |
| Workflow Operations | 2-5 秒 polling，页面隐藏时降频 | Job event 更新 |

不要在 MVP 引入 Redis。不可变 Card Pack 和 Chapter Reading 可以优先利用 HTTP/Next cache；owner 数据必须保证鉴权先于缓存命中。

## 11. 安全与隐私

- `AI_API_KEY`、Supabase Service Role、私钥只存在 server/Runner 环境，禁止 `NEXT_PUBLIC_*`。
- Web 读取根 `.env` 时只加载明确白名单的 AI 配置，不能覆盖 Web `.env.local`。
- Tutor 和 Runner Prompt 将 Source Block 标记为不可信资料，忽略其中指令。
- Tutor 上下文限制 24,000 字符、最近 8 条消息；不发送整个 PDF 或其他 Chapter。
- Signed URL 短期有效，不写数据库/localStorage，不记录在日志。
- Operations 只展示脱敏事件，不展示原始资料、完整 Prompt、卡片纠正文案或私钥相关信息。
- 所有 owner-scoped Route 从 Session 获取 owner，拒绝客户端提交 owner address。

## 12. 测试策略

### 12.1 Interface 是测试表面

| Module | 必测内容 |
| --- | --- |
| Shared Domain | Chapter 连续覆盖、标题规范、Card Policy、引用、hash/Merkle、Card Pack 不可变、Review 合同 |
| Project Lifecycle | 重复 intake、重复 PDF、Outline 重试/版本冲突、确认恢复、链上回调丢失 |
| Workflow | 每个 Job 成功、重复执行、lease 过期、有限重试、下一 Job 入队和失败终态 |
| Generation/Quality | Inventory/Blueprint 覆盖、引用不足、语义重复、定向 repair、不可在质量通过前 commit |
| Chapter Learning Context | UPLOAD/PACK 两个 Adapter、page/quote 定位、Tutor 当前页优先、伪造引用过滤 |
| Study Session | due-first、新卡轮转、跨 Chapter、乐观前进、串行写、并发冲突、Session 分段 |
| AI Gateway | 200 tool call、429/5xx、timeout、Abort、invalid JSON、usage/telemetry 脱敏 |
| Supabase | migration 最终签名、RPC 原子性、RLS、幂等、并发 claim、Schema Cache smoke |
| Web E2E | 上传 -> Outline -> Monad -> Cards -> PDF/Tutor -> Review；桌面和移动端 |
| Solidity | Project/Work Unit/Chapter commitment、重放、权限、proof、receipt vectors |

### 12.2 发布闸门

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
forge test
git diff --check
```

另需两条真实 smoke：

1. 使用真实模型完成一次 Tutor tool call 和一个固定语料质量评测。
2. 使用测试钱包完成一次 ProjectCreated receipt 校验和至少一个 Work Unit commitment。

## 13. 分阶段实施路线

### Phase 0：基线与合同冻结（0.5 天，P0）

- 为本方案建立实施 checklist。
- 记录当前构建、测试、真实 Tutor tool call 和完整 Runner pipeline 基线。
- 为 `requestId -> operationId -> jobId -> txHash` 定义统一字段。
- 补齐 AI 与 Schema 不一致错误分类。

**验收**：现有功能零行为变化；失败都能归入稳定错误分类。

### Phase 1：AI Gateway 收敛（1 天，P0）

- 新建 `packages/ai-gateway` server-only package。
- Runner Tool Model 与 Web Chapter Tutor 改用同一 Transport。
- 保持各自 Prompt、Schema、上下文和重试预算独立。
- 增加 Adapter contract tests 和 telemetry。

**验收**：OpenAI-compatible HTTP/错误解析只存在一个 Implementation；Tutor 与 Runner 的业务测试保持不变。

### Phase 2：Learning Workspace 拆分（1-1.5 天，P0）

- 先抽 `StudySession`，因为它拥有独立状态机和串行写队列。
- 再抽 `PdfWorkspace` 和 `ChapterTutor`，限制 PDF 页码与 Tutor 会话刷新范围。
- 最后抽 query hooks 和 Auth Gate，让顶层只组合布局。
- 不在此阶段换 UI 框架或改视觉设计。

**验收**：顶层文件低于约 350 行；评分不触发 PDF/Reading 重新加载；切换 PDF/Tutor 不影响 Review Session。

### Phase 3：Runner Persistence 拆分（1.5-2 天，P0）

- 保持 `ProjectWorkflowDispatcherV2` 行为不变。
- 按 Workflow/Design/Generation/Commitment/Reward 拆出 Adapter。
- Handler 依赖最小 Interface；拆小测试 Fake。
- 所有事务继续调用现有 RPC，不在本阶段改 Schema。

**验收**：不存在实现六个以上领域 Interface 的单一类；每个 Handler 的测试只构造相关依赖。

### Phase 4：Lifecycle 与 Progress Projection（1 天，P1）

- 拆分 `projects.ts` 命令/查询。
- 增加 `LearnerProjectProgress` 只读投影。
- 创建页和学习页统一使用投影文案与 operationId。
- 对 schema 缺失返回可操作的 deployment 错误。

**验收**：用户可以看到准确阶段、进度、重试和动作要求，不再永久显示笼统“AI 生成中”。

### Phase 5：Shared Domain 渐进重组（1-2 天，P1）

- 使用 re-export 兼容层按领域目录迁移。
- 更新新代码导入，不强制一次改完全部历史调用方。
- 为每个概念入口建立聚焦测试。

**验收**：Web、Runner 不再直接依赖 `project-v2.ts` 总入口；无运行行为变化。

### Phase 6：数据库治理与 E2E（1 天，P1）

- 添加 schema capability smoke 和最终 RPC 签名测试。
- 将迁移应用检查加入部署 Runbook。
- 覆盖上传、Outline、Monad、Knowledge Card、PDF Tutor、Review 的 Playwright 主路径。

**验收**：全新环境和现有远端环境都能在部署前发现缺列/缺函数；主演示路径可自动重复。

**实施记录**：已添加最终 migration 和 PGlite 函数签名测试；Web/Runner 启动预检使用同一 Shared Schema 合同。自动主演示路径目前是 Module Interface 测试，串联 READY Progress、原 PDF Signed URL、Chapter Reading Snapshot、Tutor 当前页/选区和引用回查、Knowledge Card Queue 与 FSRS Review；它不等于 Playwright 浏览器 E2E。浏览器钱包签名、真实模型响应和 Monad receipt 继续作为生产演练 smoke，不在自动测试中伪造为成功。真实浏览器 Playwright 主路径是 Phase 6 剩余工作。

## 14. 黑客松取舍

### 必须完成

1. AI Gateway 的统一错误和超时行为。
2. Learning Workspace 中 Study Session 与 PDF/Tutor 的状态隔离。
3. Runner 巨型 Persistence Adapter 的最小拆分。
4. Learner Progress Projection 与可诊断错误。
5. 一条自动 E2E 主路径和一份真实模型/Monad smoke。

### 可以延后

- Tutor 会话持久化、向量数据库和跨 Chapter RAG。
- Redis、外部消息队列、独立检索系统。
- Card Pack 在线编辑器和多人协作。
- OCR、PDF 注释同步和全文搜索。
- 多模型智能路由、成本优化平台和 Prompt CMS。
- 数据库 current baseline 重建。

### 明确不做

- 不拆成多个可独立部署微服务。
- 不让 LangGraph 接管 Supabase Workflow Job。
- 不把 PDF、Tutor 对话或 FSRS 状态写入 Monad。
- 不为了架构整洁修改已确认的 hash/Merkle/Registry 语义。
- 不建立只有一个 Adapter、没有变化需求的抽象 Seam。

## 15. 风险与回滚

| 风险 | 控制方式 | 回滚方式 |
| --- | --- | --- |
| Workspace 拆分造成状态丢失 | 先用现有行为测试锁定 URL、评分、PDF 跳页和 Tutor | 保留顶层组合器兼容 props，逐个切回旧子树 |
| AI Gateway 改变 Provider 行为 | Adapter contract + 真实最小 tool call | Feature flag 切回原 Transport Adapter |
| Persistence 拆分破坏事务顺序 | 不改 RPC，只移动 Adapter 与依赖 | Dispatcher 保持旧构造路径直到新测试通过 |
| Progress Projection 与底层状态不一致 | 投影只读、覆盖所有状态组合 | UI 回退显示底层 status + operationId |
| 远端 Schema 落后 | capability smoke 在流量前失败 | 停止发布，执行明确 migration 后刷新 schema cache |
| 黑客松时间不足 | 按 Phase 独立提交，每阶段可单独停止 | 停在最近通过全部闸门的阶段 |

## 16. 完成定义

当以下条件同时满足时，整体架构优化完成：

1. 部署仍然只有 Web、Runner、Supabase 和 Monad，没有新增无必要基础设施。
2. Learning Workspace 的认证、读取、PDF/Tutor 和 Study Session 状态互不串扰。
3. Runner 每个 Handler 只依赖自己的小 Interface，持久化故障可以定位到一个领域 Adapter。
4. Runner 与 Tutor 复用统一 AI Transport，但保持异步生成和同步问答两套独立业务 Module。
5. 用户可以准确看到 Project 当前阶段、进度、重试或所需动作。
6. Shared Domain 的概念入口与 `CONTEXT.md` 一致，调用方不需要理解整个 V2 总合同。
7. Schema 不一致能在部署前发现；主演示路径可自动 E2E 重复。
8. 生成、阅读、Tutor、复习、Monad 承诺和 Reward 的现有领域不变量全部保持。

## 17. 推荐执行顺序

```text
P0-1  AI Gateway
  -> P0-2 Learning Workspace 状态隔离
  -> P0-3 Runner Persistence Adapter 拆分
  -> P1-1 Learner Progress Projection
  -> P1-2 Project Lifecycle 拆分
  -> P1-3 Shared Domain 渐进重组
  -> P1-4 Schema capability + E2E
```

这条顺序先解决真实故障面和演示稳定性，再改善目录和长期可维护性。每一步都可以独立合并、测试和回滚，不要求一次性重写系统。
