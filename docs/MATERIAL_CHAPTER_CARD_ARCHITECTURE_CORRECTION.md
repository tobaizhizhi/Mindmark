# Mindmark 资料、章节与知识卡架构纠偏方案

> 状态：已实施  
> 日期：2026-07-27  
> 适用范围：Chapter-first V2 之后的新 Learning Project  
> 目的：修正“把标题都当成 Chapter”和“Chapter 只产出一张 Knowledge Card 也能 READY”的实现偏差

现状说明：本文记录了 2026-07-27 的业务纠偏依据。当前运行路径已经收敛为 V2-only；最新实施状态、工作流设计和上线闸门以 `SYSTEM_ARCHITECTURE_OPTIMIZATION_PLAN.md` 为准。

## 1. 结论

正确的产品层级应当是：

```text
一份上传资料
  = 一个 Learning Project
      -> 多个 Chapter（原资料的连续范围，不是 AI 新写的内容）
          -> 多个 Knowledge Card（从该 Chapter 的原文生成并保留引用）
```

`Work Unit` 只用于内部并行生成、链上 commitment 和 Worker Reward，不属于学习者看到的内容层级。

当前代码已经有 `Learning Project -> Chapter -> Knowledge Card` 的表结构和页面路由，但没有把最关键的业务规则做成不可绕过的不变量：

1. `Chapter` 的确定性降级逻辑会把所有标题，包括二级、三级小节，都当成独立 Chapter。
2. `cardBudget` 只是最大值。Worker、校验、Chapter Assembler 和数据库都允许一个 Chapter 只有 1 张卡。
3. UI 把“分析资料结构”写成“生成章节”，并在章节已经存在后继续显示“章节正在生成”，造成 Chapter 本身也是生成内容的错觉。
4. Chapter 编辑器只有拆分和删除，没有保持资料完整覆盖的合并、移动分界命令。

因此，本次不应继续增加页面条件分支，而应修改 Chapter Planning 与 Knowledge Card Generation 两个核心 Module 的 Interface 和状态机。

## 2. 当前行为证据

### 2.1 Chapter 被过度拆分

`packages/shared/src/source-intake.ts:26` 的标题识别同时接受 `#` 到 `######`、`1`、`1.1`、`1.1.1` 等形式，但 `SourceBlock` 只保存 `kind: "heading"`，没有保存标题层级。

`packages/shared/src/chapter-planning.ts:26` 的 `headingRanges()` 随后把每一个 heading 都变成一个 Chapter 范围。用包含两个一级章和三个二级小节的资料运行现有确定性 Planner，实际得到 5 个 Chapter，而不是 2 个。

AI Planner 可在模型正常时缓解这个问题，但模型不可用或输出非法时会回到同一确定性逻辑。正确性不能依赖模型碰巧理解标题层级。

### 2.2 “每章多卡”没有被强制

目前各层允许的最少卡片数都是 1：

| 位置 | 当前规则 |
| --- | --- |
| `apps/agent-runner/src/worker-v2.ts:19` | Worker 草稿 `min(1)` |
| `apps/agent-runner/src/worker-v2.ts:153` | 提示词是 `at most cardBudget` |
| `apps/agent-runner/src/validation-v2.ts:58` | 卡片数组 `min(1)` |
| `apps/agent-runner/src/validation-v2.ts:65` | 只检查不能超过 `cardBudget` |
| `apps/agent-runner/src/chapter-assembler.ts:61` | 去重后只要求不为 0 |
| `supabase/migrations/20260726000100_v2_runner_pipeline.sql:238` | Chapter 允许 1 到 30 张卡 |

`packages/shared/src/work-planning.ts:90` 虽然为每个 Chapter 计算至少 3 张的预算，但预算只是上限分配，不是交付要求。模型返回 1 张时，整个流水线仍可成功。

### 2.3 流程和界面表达不一致

创建页实际顺序是：

```text
上传资料 -> 保存 Chapter 草稿 -> 确认大纲 -> 规划 Work Unit
-> 用户发送 Monad 交易 -> Runner 生成 Knowledge Card
```

但 `apps/web/components/project-creation-workbench.tsx:331` 使用“生成章节草稿”，确认后又直接向学习者展示 Work Unit。项目页在没有 Chapter 时显示“章节正在生成”，即使 Chapter 早在大纲确认时就已经存在。

正确的文案和信息架构应区分：

- Chapter 是对上传资料的结构化划分。
- Knowledge Card 才是后续生成内容。
- Work Unit 是内部执行细节。

### 2.4 为什么测试全绿仍会出错

本次核对中 shared、web 和 agent-runner 测试均通过，但当前测试只覆盖：

- 两个平级标题得到两个 Chapter。
- Work Unit 不跨 Chapter。
- 每个手工 Work Unit 生成 1 张卡后，Chapter 可以成功组装。

缺失的回归测试正是：

- 多级标题不能全部升级为 Chapter。
- 一个 READY Chapter 必须包含多张 Knowledge Card。
- 模型少生成卡片时不能提前提交链上 commitment。
- UI 必须呈现“一个 Project 下多个 Chapter，每章下多个 Knowledge Card”。

### 2.5 Outline Draft 被当成正式 Project 和 Chapter

`apps/web/lib/server/projects.ts:264` 的 intake 同时完成资料保存、AI 规划、Learning Project 插入和 DRAFT Chapter 插入。每点一次“生成章节草稿”都会产生一个新的 `projectId`，不是在同一份资料下生成新的 outline version。

`supabase/migrations/20260725000200_chapter_first_v2.sql:648` 的项目摘要查询又没有排除 `OUTLINE_READY` 草稿，因此这些零卡片项目会全部进入正常项目列表。用户看到的自然是“一堆生成的章节”，而不是“一份资料及其章节”。

当前还没有恢复草稿、重新规划、合并 Chapter 或删除草稿的 HTTP Adapter。资料的文件名、MIME、页数和字符数也没有持久化，刷新后 UI 只能展示 AI Chapter，无法明确展示它们共同来自哪一份资料。

### 2.6 创建和学习生命周期未闭环

- `createProjectArgs` 只保存在创建页内存中，确认大纲后刷新不能恢复交易参数。
- 链上 `ProjectCreated` 成功但浏览器未成功调用 `create-tx` 时，数据库会停在 `AWAITING_REGISTRY`，Runner 永远不会领取。
- AI 返回的 proposal 可以通过 schema、却在连续覆盖校验时失败；当前 `ResilientChapterPlanner` 只包住模型调用，无法在这个失败点触发确定性降级。
- Project 级复习把跨 Chapter 卡片复用同一个 `sessionId`，数据库却总以 `CHAPTER` scope 创建 Session，进入第二个 Chapter 后会拒绝评分。

这些问题说明当前“本地实现完成”的表述不成立。V2 已经具备主要实体，但缺少可恢复的工作流 Seam 和覆盖真实数据库、链上回执、跨 Chapter 会话的集成测试。

### 2.7 Deepening 优先级

| 顺序 | Files / Module | Problem | Solution | Benefits |
| --- | --- | --- | --- | --- |
| 1 | `projects.ts`、V2 migration / Learning Project Intake Module | 一次 outline 生成就创建新 Project 和 DRAFT Chapter | source upload 幂等化，Outline Draft 独立版本化 | 资料、草稿和正式 Chapter 的 Locality 清晰；可直接测试重试与恢复 |
| 2 | `source-intake.ts`、`chapter-planning.ts` / Chapter Planning Module | 标题层级丢失，所有 heading 都可能升级为 Chapter | 保留 headingLevel，并统一 AI 与确定性 Adapter 的验证 | 一个 Interface 隐藏层级识别、覆盖和降级，提升调用方 Leverage |
| 3 | `work-planning.ts`、`worker-v2.ts`、`chapter-assembler.ts` / Knowledge Card Generation Module | budget 只有上限，commitment 后才发现多卡不达标 | 候选生成、章级质量门、批准后 commitment | 数量、去重和引用规则集中，测试可锁定 READY 不变量 |
| 4 | `registry-v2.ts`、`coordinator-v2.ts` / Learning Project Workflow Module | 浏览器回调是链上状态推进的唯一入口 | 可恢复创建意图和事件 Reconciliation Adapter | 网络中断不再制造永久卡住的 Project |
| 5 | `project-study.ts`、review SQL / Study Session Module | Project 队列跨 Chapter，但 Session 被固定为 CHAPTER | 显式创建 PROJECT / CHAPTER Session | 跨 Chapter 评分规则集中，避免第二章评分失败 |

## 3. 必须固定的领域不变量

以下规则应同时进入 shared schema、数据库事务和测试，而不是只写在提示词中。

### 3.1 Learning Project

- 一次资料 intake 只创建一个 Learning Project。
- 一个 Learning Project 对应一份规范化后的上传资料和一个 `sourceHash`。
- 同一个 intake 请求重试必须幂等，不能创建多个 Learning Project。
- 重新分析资料结构只产生新的 Outline Draft version，不产生新的 Learning Project。
- 未确认的 Outline Draft 不属于正式 Chapter 列表。
- 普通资料建议规划 2 到 12 个 Chapter；硬上限保持 16。
- 资料过短或没有足够语义分界时允许 1 个 Chapter，但不得为了凑数量虚构章节。
- 已确认的 Source Block 范围和 Chapter 顺序不可原地改写；修改必须产生新的 outline version。

### 3.2 Chapter

- Chapter 是 Source Block 的连续范围，不是 AI 生成的一篇新内容。
- 同一 Learning Project 的 Chapter 必须完整、按顺序、无重叠地覆盖全部 Source Block。
- 小节标题默认属于最近的上级 Chapter，不能自动变成同级 Chapter。
- 太短、无法产生至少 2 张不同知识卡的候选 Chapter，必须在大纲确认前与相邻 Chapter 合并。
- Chapter 只有在最终唯一卡片数达到 `minCardCount` 后才能进入 `READY`。

### 3.3 Knowledge Card

- 每个 READY Chapter 至少 2 张 Knowledge Card；普通 Chapter 默认目标不少于 3 张。
- 每张 Knowledge Card 只属于一个 Chapter，并保留一个 Work Unit provenance。
- 引用必须逐字命中该 Chapter 范围内的 Source Block。
- 不允许用重复问题、改写同一问题或无来源填充卡片来满足数量下限。
- 去重、引用和数量检查必须发生在链上 commitment 之前。

建议的初始卡片策略：

```text
absoluteMin = 2
defaultMin  = 3
target      = clamp(round(nonHeadingCharacters / 800) + importance, 3, 20)
max         = min(30, target + max(2, ceil(target * 0.25)))
```

这组数值必须集中在一个版本化策略中，不能散落在 Web、Worker 和 SQL 中。短 Chapter 如果不能产出 `absoluteMin` 张高质量卡，应合并或拒绝大纲，而不是降低到 1 张。

### 3.4 Work Unit

- 一个 Work Unit 只能位于一个 Chapter 内。
- Work Unit 负责并行和 provenance，不决定用户看到的章节结构。
- 一个 Chapter 可以有多个 Work Unit，但 Knowledge Card 下限属于 Chapter，不属于单个 Work Unit。
- Work Unit 在候选卡通过 Chapter 级质量门之前不得提交最终 cards root。

## 4. 目标数据流

```text
上传 PDF / 文本
  -> Source Intake Module
       创建一个可恢复的 Learning Project，保存资料元数据
       输出有序 Source Block，并保留 headingLevel / headingPath
  -> Chapter Planning Module
       AI Proposal Adapter 或 Deterministic Adapter 提议范围
       服务端统一验证层级、连续覆盖、最小内容量
       保存为版本化 Outline Draft，不写入正式 Chapter
  -> 用户确认 Outline Draft
       原子物化多个稳定 Chapter，仍然只有一个 Learning Project
  -> Work Planning Module
       每章计算 min / target / max 卡片数
       大章再拆成内部 Work Unit
  -> Worker 生成候选 Knowledge Card
       先保存，不提交链上 commitment
  -> Chapter Quality Gate
       跨 Work Unit 去重、引用验证、数量和覆盖验证
       不足则定向要求原 Work Unit 修复
  -> 候选卡冻结
       各 Worker 提交自己的最终 cards root
  -> Chapter Assembly Module
       写入最终 Knowledge Card，finalize Chapter
  -> Chapter READY
       学习者看到该 Chapter 下的多张 Knowledge Card
```

关键变化是把 Chapter 级质量门移动到 Worker commitment 之前。现状先提交 Work Unit，再做章内去重；一旦去重后只剩 1 张卡，固定 manifest 下已经没有干净的补卡位置。

## 5. 需要加深的 Module

### 5.1 Source Intake Module

**Interface**

输入 PDF 页或文本页，输出确定性、有序的 Source Block。

**Implementation 调整**

- 为 heading 增加 `headingLevel: 1..6 | null`。
- 增加可选 `headingPath`，例如 `["第一章", "1.2 状态更新"]`。
- Markdown、中文章/节、英文 Chapter/Section 和数字编号分别解析层级。
- 解析不确定时把它当普通 heading 信号，不直接决定 Chapter。
- `sourceHash` 仍只承诺稳定原文事实；规划元数据通过 `plannerVersion` 版本化，避免无意破坏既有 V2 commitment。

这个 Module 的 Depth 来自隐藏 PDF 行合并、标题层级识别和 Source Block 稳定化。调用方只使用结构化 Source Block，不再重复猜标题。

### 5.2 Chapter Planning Module

**Interface**

```ts
planChapterOutline({ projectId, blocks, goal, policyVersion })
  -> ValidatedChapterOutline
```

AI Planner Adapter 和 Deterministic Planner Adapter 是这个 Seam 上的两个真实 Adapter；两者的输出都必须经过同一个验证实现。

**Implementation 调整**

1. 先从标题层级建立资料树。
2. 优先选择最高稳定层级作为 Chapter 分界。
3. 二级及以下标题保留在父 Chapter 中。
4. 没有稳定标题时，再按语义转折和字符量提出连续范围。
5. 合并过短 Chapter，拆分超过模型上下文上限的 Chapter。
6. 验证完整覆盖、顺序、无重叠、内容量和可生成至少 2 张卡的能力。
7. AI proposal 的 schema、范围和覆盖任一验证失败时，都在 Module 内触发确定性 Adapter，而不是把非法结果传给调用方。

删除这个 Module 后，层级判断、覆盖检查和合并规则会重新散落到 AI Adapter、Web 和测试，因此它应成为一个更深的 Module，而不是几个标题正则函数。

### 5.3 Work Planning Module

把单一 `cardBudget` 替换为显式策略：

```ts
type ChapterCardPolicy = {
  minCardCount: number;
  targetCardCount: number;
  maxCardCount: number;
  policyVersion: number;
};

type WorkUnitCardRequest = {
  requestedCardCount: number;
  maxCardCount: number;
};
```

`ChapterCardPolicy` 是验收约束，`WorkUnitCardRequest` 是内部工作分配。两者不能再混用为一个 `budget`。

### 5.4 Knowledge Card Generation Module

**Interface**

```ts
generateWorkUnitCandidates(workUnit, chapterContext, request)
  -> CandidateCardSet
```

**Implementation 调整**

- Worker 提示使用 `target`，而不是只有 `at most max`。
- 保存候选卡后进入 `CANDIDATE_READY`，不立即提交链上 commitment。
- 校验每张卡的引用、独立性、问题清晰度和本 Work Unit 归属。
- Chapter Quality Gate 可以返回定向修复意见，例如“缺少防御措施卡”或“去重后还差 2 张”，并只重跑相关 Work Unit。
- 同一 Work Unit 的最终候选集冻结后，Worker 才签名提交 commitment。

### 5.5 Chapter Assembly Module

**Interface**

```ts
prepareChapterCardSet(chapter, candidateSets, cardPolicy)
  -> ApprovedChapterCardSet | ChapterRepairRequest
```

**质量门**

- 所有候选卡 provenance 有效。
- 引用全部位于当前 Chapter。
- 跨 Work Unit 去重后数量不少于 `minCardCount`。
- 数量不超过 `maxCardCount`。
- 主要 Source Block 或关键主题达到配置的覆盖要求。
- 只有 `ApprovedChapterCardSet` 可以触发 Work Unit commitment 和最终 `finalizeChapter`。

这样数量和质量规则具有 Locality：改一次即可覆盖所有 Worker、重试路径和 Adapter。

### 5.6 Learning Project Workflow Module

当前创建流程分别散落在客户端状态、HTTP route、`projects.ts`、Registry receipt 和 Runner 中。建议把顺序约束集中为一个工作流 Interface：

```text
source uploaded -> outline draft ready -> outline confirmed
       -> candidate generation -> quality approved
       -> commitments confirmed -> chapter ready
```

具体命令：

```ts
uploadSource({ clientRequestId, metadata, pages }) -> LearningProject
planOutline(projectId) -> OutlineDraft
confirmOutline(projectId, outlineVersion) -> ConfirmedChapterSet
getCreationIntent(projectId) -> ProjectCreationIntent
reconcileRegistryEvents(cursor) -> ReconciliationResult
```

- `clientRequestId` 在 owner 范围内唯一，使上传和网络重试幂等。
- 重复 `planOutline` 只增加同一 Project 的 outline version。
- `chapters` 只保存已确认的稳定 Chapter；未确认 proposal 存在独立的 Outline Draft 表。
- 创建意图可在刷新后重新读取，不能只存在浏览器内存。
- Reconciliation Adapter 定期读取 `ProjectCreated` 事件，补偿“链上成功、浏览器回调丢失”。

Web 和 HTTP Adapter 只发命令、读取状态，不自行决定下一状态。Monad Registry 是该工作流的 Adapter，不应反向定义学习者的信息层级。

### 5.7 Study Session Module

Chapter Session 和 Project Session 是两个真实 Adapter 使用的同一复习 Seam。Project Session 必须允许同一个 `sessionId` 包含多个 Chapter 的卡，但每条 review log 仍记录原始 `chapterId`。

```ts
startStudySession({ owner, projectId, scope, chapterId? }) -> Session
submitReview({ sessionId, cardId, rating }) -> NextCardState
completeStudySession(sessionId) -> SessionSummary
```

Session 在开始时创建并固定 `scope_type`。卡片评分不能再隐式创建一个 `CHAPTER` Session，否则跨 Chapter 的 Project 队列永远无法正确工作。

## 6. 状态机调整

### 6.1 Chapter

```text
DRAFT
  -> CONFIRMED
  -> GENERATING_CANDIDATES
  -> QUALITY_CHECK
      -> REPAIRING -> GENERATING_CANDIDATES
      -> APPROVED
  -> COMMITTING
  -> ASSEMBLING
  -> READY
```

`READY` 的事务前置条件：

```text
uniqueValidCardCount >= minCardCount
all selected cards belong to this Chapter
all selected cards have confirmed Work Unit provenance
```

### 6.2 Work Unit

```text
QUEUED
  -> GENERATING
  -> CANDIDATE_READY
  -> APPROVED
  -> SUBMITTING
  -> CONFIRMED

GENERATING / CANDIDATE_READY
  -> REPAIRING
  -> GENERATING
```

Worker Reward 仍然只在 `CONFIRMED` 后创建。修复候选卡不创建额外奖励。

### 6.3 Learning Project 与 Outline Draft

```text
UPLOADED
  -> OUTLINING
  -> OUTLINE_READY
      -> OUTLINING       # 在同一 Project 上重新规划新 version
  -> AWAITING_REGISTRY
  -> GENERATING
  -> FINALIZING
  -> READY
```

Outline Draft 使用独立状态 `DRAFT | SUPERSEDED | CONFIRMED`。只有 `CONFIRMED` version 能物化正式 Chapter 和 Work Unit。Project 保持 `GENERATING` 时，已经 `READY` 的 Chapter 仍可独立学习，因此不需要再增加 `PARTIAL_READY` 状态。

## 7. 数据库修改

不要修改已经执行的 V2 migration；新增一份向前迁移。

### 7.1 `source_blocks`

新增：

- `heading_level smallint null check (heading_level between 1 and 6)`
- `heading_path jsonb null`
- `planner_version smallint not null default 2`

### 7.2 `learning_projects`

新增：

- `client_request_id uuid not null`
- `source_filename text null`
- `source_mime_type text null`
- `source_page_count smallint not null`
- `source_character_count integer not null`
- `planner_version smallint not null`
- `card_policy_version smallint not null`
- 可选 `pipeline_version smallint not null`

版本字段用于保证重试时继续使用最初确认的规则，不能因部署新公式而改变已确认 Project 的 root 或卡片要求。

调整：

- `unique(owner_address, client_request_id)` 保证 intake 幂等。
- `outline_hash` 在 Outline Draft 确认前允许为 `null`，使 `UPLOADED` 和 `OUTLINING` 成为真正可达状态。
- 正常项目摘要与 Outline Draft 查询分开，避免草稿充斥学习项目列表。

### 7.3 `chapter_outline_versions` 与 `chapter_outline_items`

新增独立草稿表，不再把 AI proposal 直接写入正式 `chapters`：

- `chapter_outline_versions(project_id, outline_version, status, planner_version, outline_hash, planner_provenance)`
- `chapter_outline_items(project_id, outline_version, position, title, summary, start_block, end_block, importance)`

确认事务验证完整覆盖后，才把对应 items 物化到 `chapters` 并生成 Work Unit。重新规划把旧 version 标记为 `SUPERSEDED`，不创建新 Learning Project。

### 7.4 `chapters`

新增：

- `min_card_count smallint not null check (min_card_count between 2 and 30)`
- `target_card_count smallint not null`
- `max_card_count smallint not null`
- `quality_attempt smallint not null default 0`
- `quality_feedback jsonb null`

增加约束：

```text
2 <= min_card_count <= target_card_count <= max_card_count <= 30
```

`mark_chapter_ready` 事务必须读取 `min_card_count` 并拒绝 `card_count < min_card_count`。不能继续只判断 `card_count > 0`。

Chapter status check 和 shared `ChapterStatusSchema` 同步加入 `GENERATING_CANDIDATES | QUALITY_CHECK | REPAIRING | APPROVED | COMMITTING`，删除新项目对含糊 `GENERATING` 状态的依赖。

### 7.5 `work_units`

新增或替换：

- `requested_card_count smallint`
- `max_card_count smallint`
- `candidate_cards jsonb`
- `candidate_count smallint`
- `candidate_revision smallint`
- `quality_status text`

旧 `card_budget` 在兼容期只读保留，新项目不再把它当作 Chapter 的质量要求。

Work Unit status check 和 shared `WorkUnitStatusSchema` 同步加入 `CANDIDATE_READY | APPROVED | REPAIRING`。数据库与 TypeScript 必须在同一提交中切换，避免 Runner 读到 schema 无法解析的状态。

### 7.6 数据库命令

建议新增事务函数：

- `save_work_unit_candidates_v2`
- `request_work_unit_repair_v2`
- `approve_chapter_candidates_v2`
- `confirm_approved_work_unit_v2`
- `mark_chapter_ready_with_policy_v2`
- `reconcile_project_created_event_v2`
- `create_project_study_session_v2`

这些命令应校验状态前置条件，避免客户端或 Runner 通过直接更新表绕过质量门。

## 8. Web 信息架构与文案

### 8.1 学习层级

```text
Project 列表
  -> 一个 Project 详情
      -> Chapter 列表
          -> 一个 Chapter 详情
              -> 该 Chapter 的 Knowledge Card 列表与复习
```

项目页只显示 Chapter 摘要和卡片数量；Chapter 详情才加载卡片正文。Work Unit 不出现在学习者页面。

### 8.2 新建流程

1. 上传一份资料。
2. 立即得到一个可恢复的资料项目；刷新不会丢失来源和状态。
3. “分析资料结构”，在同一 Project 下得到 Outline Draft。
4. 用户重命名、合并、拆分或移动相邻 Chapter 分界。
5. 服务端每次命令后返回完整、已验证的大纲。
6. 用户确认大纲，Outline Draft 才成为正式 Chapter。
7. 页面显示“正在为各章节生成知识卡”。
8. 某章满足多卡质量门后，立即显示该章的 Knowledge Card。

编辑命令应由服务端 Module 实现，而不是客户端直接拼数组：

- `renameChapter(chapterId, title)`
- `splitChapter(chapterId, splitAfterBlock)`
- `mergeAdjacentChapters(leftChapterId, rightChapterId)`
- `moveChapterBoundary(leftChapterId, endBlock)`

“删除 Chapter”必须等价于和相邻 Chapter 合并，不能留下 Source Block 缺口后等确认接口报错。

### 8.3 文案替换

| 当前文案 | 建议文案 |
| --- | --- |
| 生成章节草稿 | 分析资料结构 |
| 正在整理章节 | 正在识别章节结构 |
| 章节正在生成 | 正在为章节生成知识卡 |
| Work Unit 已规划 | 章节已确认，准备生成知识卡 |
| Chapter 会独立进入可学习状态 | 每章生成并验证多张知识卡后即可学习 |

## 9. 代码改造地图

### `packages/shared`

- `src/project-v2.ts`：增加 heading 层级、Chapter 卡片策略、候选状态 schema。
- `src/source-intake.ts`：解析并保存 headingLevel / headingPath。
- `src/chapter-planning.ts`：替换“每个 heading 一个 Chapter”的 `headingRanges()`。
- `src/work-planning.ts`：输出 ChapterCardPolicy 和 WorkUnitCardRequest，不再只输出上限。
- 新增 `src/card-policy.ts`：集中版本化公式和不变量。

### `apps/web`

- `lib/server/projects.ts`：把 source upload、outline command、确认和查询分到 Learning Project Workflow 后面的 Adapter。
- `lib/server/chapter-planner.ts`：AI 只提议语义范围，统一走 shared 验证。
- `components/project-creation-workbench.tsx`：调用服务端合并/拆分命令，不直接修改范围数组。
- `components/project-learning-workspace.tsx`：修正生成状态文案，移除 Work Unit 暴露。
- `app/api/projects/.../outline`：增加版本化 outline command、草稿恢复和重新规划路由。
- `lib/server/registry-v2.ts`：增加 ProjectCreated 事件 Reconciliation Adapter。
- `lib/server/project-study.ts`：显式创建 `PROJECT` 或 `CHAPTER` Session，再接受评分。

### `apps/agent-runner`

- `src/worker-v2.ts`：生成候选卡并等待 Chapter 级批准。
- `src/chapter-planner.ts`：删除重复 Planning 实现，或改成只调用 shared Chapter Planning Module 的 Adapter。
- `src/validation-v2.ts`：区分 Work Unit 校验与 Chapter policy 校验。
- `src/chapter-assembler.ts`：在 commitment 前增加去重、数量、覆盖质量门。
- `src/coordinator-v2.ts`：支持 `CANDIDATE_READY -> QUALITY_CHECK -> REPAIRING/APPROVED`。
- `src/repository-v2.ts`：通过事务命令推进状态，不直接拼接状态更新。

### `supabase`

- 新增 migration，不回写已确认项目的 outline 或 commitment。
- `mark_chapter_ready` 从 `card_count > 0` 改为读取并强制 `min_card_count`。
- 增加候选卡、修复和批准的原子命令。

### `contracts`

第一阶段可继续使用 `LearningProjectRegistryV2`。固定 Work Unit 不变，只把 commitment 延后到质量批准之后，因此现有合约 Interface 足够。

如果未来要求链上也证明最低卡片数，再部署 V3，将 `minCardCount` 纳入 Chapter seed 和 outline commitment。不要为了本次产品逻辑修复立即扩大合约范围。

## 10. 实施顺序

### Phase 0：先写失败测试

1. 加入多级标题 fixture，断言两个一级章只生成两个 Chapter。
2. 加入 Worker 只返回 1 张卡的 fixture，断言 Chapter 不能 READY。
3. 加入跨 Work Unit 重复卡 fixture，断言去重后不足会进入 REPAIRING。
4. 加入完整验收测试，断言一份资料只创建一个 Project，每章有多张卡。

### Phase 1：Source 与 Chapter Planning

1. 把 source upload 与 outline planning 分开，并使 intake 幂等。
2. 增加资料元数据、Outline Draft version 和草稿恢复。
3. 增加 headingLevel。
4. 实现结构树和 Chapter 分界策略。
5. 实现相邻合并、拆分和分界移动命令。
6. 保持所有 Source Block 完整覆盖。

### Phase 2：Card Policy 与数据迁移

1. 增加版本化 ChapterCardPolicy。
2. 新增数据库字段和事务命令。
3. 将 `card_count > 0` 的 READY 条件替换为 `card_count >= min_card_count`。

### Phase 3：Runner 两阶段生成

1. Worker 先保存候选卡。
2. Chapter Quality Gate 跨 Work Unit 验证。
3. 不足时定向修复，合格后冻结。
4. 冻结后再提交 commitment、组装 Chapter 和结算 Worker Reward。

### Phase 4：Web 纠偏

1. 调整创建流程文案。
2. 隐藏 Work Unit。
3. 增加可用的合并和分界移动操作。
4. 在 Chapter 下展示卡片数量、质量状态和最终 Knowledge Card。

### Phase 5：兼容与切换

1. 新项目使用新的 `plannerVersion` 和 `cardPolicyVersion`。
2. 已 `READY` 的 V2 项目保持只读兼容，不重写卡片和 root。
3. `OUTLINE_READY` 的旧草稿可重新规划。
4. 已进入 `GENERATING` 的旧项目继续旧策略完成，或由用户显式取消并重建；不能静默改 commitment。
5. 启动 Registry reconciliation，补偿已有 `AWAITING_REGISTRY` 项目中已成功的链上交易。
6. 修复 Project Session 后再开放跨 Chapter 今日复习入口。

## 11. 验收测试

建立固定 fixture：一份四页资料，包含两个一级 Chapter，每章各有两个二级小节。

验收必须同时满足：

1. intake 后数据库只有 1 个 Learning Project。
2. 同一 `clientRequestId` 重试、重新规划或刷新后仍然只有这个 Learning Project。
3. 未确认 proposal 只存在 Outline Draft，不出现在正式 Chapter 列表。
4. Planner 输出 2 个 Chapter，不是 6 个标题段。
5. 两个 Chapter 的 Source Block 范围连续、无重叠并覆盖全部资料。
6. 每个 Chapter 的 `minCardCount >= 2`，默认 target 不少于 3。
7. 模型第一次每章只返回 1 张卡时，系统进入修复，不产生 Work Unit commitment。
8. 修复后每章至少 2 张唯一、有效引用的 Knowledge Card。
9. 任意卡片的引用不能越过所属 Chapter 的 Source Block 范围。
10. Chapter 去重后少于下限时，数据库拒绝将其标记为 `READY`。
11. 链上创建成功但浏览器回调丢失时，Reconciliation Adapter 能推进到 `GENERATING`。
12. 项目页显示 2 个 Chapter；进入任一 Chapter 能看到该章的多张 Knowledge Card。
13. 学习者页面不出现 Work Unit、Worker lane 或内部 manifest。
14. 一个 Chapter READY 后即可学习，不等待其他 Chapter 或 Worker Reward。
15. Project Session 可以连续评分来自两个不同 Chapter 的卡。
16. Worker Reward 失败不影响 Chapter 和 Learning Project 的学习状态。

建议将这条验收链做成单一集成测试 Interface：

```text
fixture source
  -> intake
  -> outline confirm
  -> candidate generation
  -> quality repair
  -> commitments
  -> chapter query
```

这条测试通过，才表示“资料 -> Chapter -> 多 Knowledge Card”的用户逻辑真正成立；单独的 hash、schema、Adapter 和页面测试全绿不能替代它。

## 12. 明确不做

- 不把每个标题或小节都变成 Chapter。
- 不为每个 Chapter 创建一个独立 Learning Project。
- 不把 Work Unit 展示为用户章节。
- 不把最大 `cardBudget` 当作目标或最低交付量。
- 不用低质量重复卡片填满数量。
- 不让 AI 决定 ID、hash、proof、状态或数据库关系。
- 不原地修改已确认项目的 outline、root 或卡片归属。

## 13. 完成定义

只有以下陈述同时为真，改造才算完成：

> 用户上传一份资料后只得到一个 Learning Project；系统将原资料按稳定语义范围划分为多个 Chapter；每个可学习 Chapter 都包含多张带原文引用的 Knowledge Card；Work Unit 只在内部承担并行、证明和奖励职责。
