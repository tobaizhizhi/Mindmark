# Mindmark 预置学习卡包架构方案

> 状态：MVP 已实施，远端 Supabase 已部署并发布 Solidity 循序渐进卡包 v5
>
> 适用范围：在现有 `Learning Project -> Chapter -> Knowledge Card` 之外，增加 Solidity 等预置学习内容
>
> 目标：让用户浏览官方卡包、按章节预览、添加到自己的资料库并立即复习，同时不破坏现有 PDF 分析和 AI 生成流程。

课程正文与知识卡双视图的后续实施见 [原文阅读与知识卡双视图实施方案](DOCUMENT_CARD_DUAL_VIEW_IMPLEMENTATION_PLAN.md)。

## 实施状态（2026-08-01）

Phase 1 到 Phase 5 的 MVP 已经落地，v5 在 v4 结构化递进基础上增加不可变课程正文与双向阅读锚点：

- `packages/shared/src/card-pack.ts` 提供 manifest、Pack Card、目录、详情和安装合同，以及稳定 hash 和发布质量校验。
- `content/card-packs/solidity-foundations/v1` 到 `v4` 保留不可变历史版本；`v5` 提供 16 章、112 张循序渐进知识卡，其中 48 张为 Solidity 代码练习，并为每张卡绑定同章 `readingBlockId`。
- `supabase/migrations/20260801000100_card_packs.sql` 提供公开目录表、不可变发布、owner-scoped 幂等安装、删除安装和 PACK 执行隔离。
- `apps/web/lib/server/card-packs.ts` 和 `/api/packs/**` 提供目录、详情、安装与已安装卡包接口。
- `/learn/packs` 和 `/learn/packs/:packVersionId` 提供目录、章节预览、一键安装和已安装直达。
- 现有资料库和复习界面已区分 `UPLOAD` 与 `PACK`，PACK 引用不显示伪造 PDF 页码；编程卡可分别展示题目代码、参考写法和预期结果。
- Chapter 页面已提供 `原文/课程正文 | 知识卡` 浏览切换；阅读 API owner-scoped，卡片浏览不写入 ReviewLog，正文块与卡片支持双向定位。
- Shared、Web、Runner 的测试、类型检查、lint 和生产构建已通过；远程事务验证了重复安装幂等与双钱包复习状态隔离。
- `docs/PRODUCTION_REHEARSAL_RUNBOOK.md` 已加入“发现卡包 -> 预览 -> 添加 -> 立即复习”的演示路径。
- 当前远端已发布 `solidity-foundations@5.0.0`（16 章、112 卡、48 张代码练习和作者正文）；公开目录默认隐藏旧版，只对已安装旧版的学习者保留访问。
- `scripts/generate-solidity-curriculum-v4.ts` 固定生成结构化课程，`scripts/generate-solidity-curriculum-v5.ts` 从 v4 作者内容生成正文块并绑定卡片锚点；v5 发布函数和详情 API 保留每章学习目标、先修章节、阶段、概念、练习重点、项目里程碑和 reading blocks。

部署到新的 Supabase 环境时按以下顺序执行；代码练习字段由 v2 migration 保存，章节学习目标和先修关系由 v3 migration 保存，阶段化课程字段由 v4 migration 保存：

```bash
# 先通过迁移工具或 Supabase SQL Editor 执行
supabase/migrations/20260801000100_card_packs.sql
supabase/migrations/20260801000200_card_pack_code_exercises.sql
supabase/migrations/20260801000300_card_pack_curriculum_progression.sql
supabase/migrations/20260802000100_card_pack_curriculum_v4.sql
supabase/migrations/20260802000200_card_pack_curriculum_v4_constraints.sql
supabase/migrations/20260802000300_card_pack_reading_v5.sql

# 再使用服务端环境变量发布仓库内固定卡包
pnpm packs:generate:solidity:v5
pnpm packs:validate
pnpm packs:publish
```

`pnpm packs:validate` 可在任何发布前验证内容并打印 manifest/content hash。迁移未执行时，PostgREST 会返回 `PGRST202`，这是 schema 未部署，不是页面或卡包内容错误。

## 1. 决策摘要

Mindmark 增加一个独立的 **Card Pack** 内容目录，但用户安装卡包后，仍然得到一个普通的、归属于自己的 **Learning Project**。这样学习者最终只需要理解一套章节和复习界面；卡包只是 Learning Project 的另一种内容来源。

```text
公开卡包目录
  -> Card Pack Version（不可变版本）
      -> Pack Chapter
          -> Pack Card

用户点击“添加到我的学习”
  -> Pack Installation
      -> 用户自己的 Learning Project（kind = PACK）
          -> Chapter
              -> Knowledge Card
                  -> 用户自己的 FSRS 复习状态
```

必须固定以下边界：

1. 卡包是预先制作并经过校验的学习内容，不是用户上传的资料。
2. 卡包安装不调用模型、不创建 Workflow Job、不创建 Work Unit、不提交 Monad 交易、不产生 Worker Reward。
3. 卡包安装后复制为用户自己的 Learning Project；卡包目录的后续版本不会静默改写用户已经开始学习的内容。
4. 复习进度属于用户和安装后的卡片，不属于公开卡包。不同用户之间绝不共享 FSRS 状态。
5. 现有 PDF Learning Project 的链上 commitment、Source Block 引用和 Runner 流程保持不变。

## 2. 为什么不把卡包当成 PDF

直接把卡包伪装成上传 PDF 会造成四个结构性问题：

- 卡包没有真实的 PDF Source Block，却会被迫创建伪造的页码、引用和 source hash。
- 卡包不需要 AI 规划章节，也不需要 Worker 并行生成 Knowledge Card；让它进入 Runner 只会增加等待和失败点。
- 卡包不需要用户发起 Monad Project 创建交易，混用链上状态会让“添加卡包”看起来像区块链交易失败。
- 公开卡包是多用户复用的只读内容，用户的学习进度却必须独立；把公开卡片直接当成用户卡片会污染状态边界。

因此，卡包需要自己的内容来源标识，但安装后复用现有 Learning Project 的学习界面和复习接口。

## 3. 领域语言

### 3.1 Card Pack

一个可浏览、可安装的主题学习内容集合，例如“Solidity 基础”“Solidity 重入攻击”“EVM 存储布局”。Card Pack 只有目录元数据，不直接保存用户复习进度。

### 3.2 Card Pack Version

Card Pack 的不可变发布版本。卡片内容、章节顺序、卡片数量、内容 hash 和许可证在版本发布后不能原地修改。修正文案或增加卡片必须创建新版本。

### 3.3 Pack Chapter

属于一个 Card Pack Version 的公开章节。它与用户安装后 Project 中的 Chapter 一一对应，但两者不是同一条数据库记录。

### 3.4 Pack Card

属于一个 Pack Chapter 的预置 Knowledge Card。它有稳定的 `packCardId`，并保存来源参考、卡片类型、难度和标签。它不需要 Work Unit provenance。

### 3.5 Pack Installation

用户将一个 Card Pack Version 添加到自己账户的操作记录。一次安装会原子地创建一个用户拥有的 PACK Learning Project，以及该 Project 的 Chapters 和 Knowledge Cards。

### 3.6 PACK Learning Project

由 Card Pack Installation 创建的用户学习空间。它沿用 Project 查询、Chapter 导航、Knowledge Card 展示和 FSRS 复习，但不进入 PDF 分析、AI 生成、Monad 或 Worker Reward 流程。

## 4. MVP 的内容来源模型

### 4.1 两类 Learning Project

```text
Learning Project
├── UPLOAD
│   ├── source_blocks
│   ├── outline / Chapter Planning
│   ├── Work Units / Workers
│   ├── Monad commitments
│   └── AI-generated Knowledge Cards
└── PACK
    ├── pack_version_id
    ├── copied Chapters / Knowledge Cards
    ├── no Workflow Jobs
    ├── no Work Units
    ├── no Monad transaction
    └── no Worker Reward
```

`project_kind` 必须是服务端和数据库都验证的字段，不能由浏览器提交后直接决定权限。Runner 领取任务、Registry reconciliation、奖励结算和创建交易 API 都只接受 `UPLOAD` Project。

### 4.2 安装时复制，而不是运行时共享

MVP 采用“安装时复制”策略：

- 卡包目录表保存一份公开的不可变内容。
- 安装事务复制章节元数据和卡片内容到用户自己的 Project。
- 复制后的卡片生成新的用户 Project 内 `card_id`，并通过 `origin_pack_card_id` 保留来源。
- 用户的 `card_learning_states` 继续使用现有 `(owner_address, card_id)` 主键，不需要让多个账户共享同一张卡的状态。
- 卡包新版本不会改写旧安装；以后可以提供“升级卡包”操作，但升级必须是用户明确确认的新安装或迁移。

这比在每次复习时动态 union 公开卡片和用户状态更适合当前 MVP：现有项目复习接口可以继续使用，权限和状态都集中在用户自己的 Project 上。

## 5. 数据库设计

### 5.1 公开卡包目录

新增表：

```text
card_packs
  pack_id uuid primary key
  slug text unique not null
  title text not null
  description text not null
  subject text not null
  language text not null
  level text not null              -- beginner / intermediate / advanced
  status text not null              -- DRAFT / PUBLISHED / RETIRED
  owner_type text not null          -- SYSTEM / CONTRIBUTOR
  created_at / updated_at

card_pack_versions
  pack_version_id uuid primary key
  pack_id uuid references card_packs
  version text not null
  manifest_hash text not null
  content_hash text not null
  card_count integer not null
  chapter_count integer not null
  license text not null
  attribution text
  status text not null              -- DRAFT / PUBLISHED / RETIRED
  published_at timestamptz
  unique (pack_id, version)

card_pack_chapters
  pack_version_id uuid references card_pack_versions
  chapter_id smallint not null
  position smallint not null
  slug text not null
  title text not null
  summary text not null
  estimated_minutes smallint
  card_count smallint not null
  primary key (pack_version_id, chapter_id)

card_pack_cards
  pack_card_id text primary key
  pack_version_id uuid references card_pack_versions
  chapter_id smallint not null
  position smallint not null
  content jsonb not null
  content_hash text not null
  source_reference jsonb not null
```

数据库必须保证：

- 只有 `PUBLISHED` Pack Version 能被公开浏览和安装。
- Pack Chapter 的 `position` 和 Pack Card 的 `(chapter_id, position)` 唯一。
- `card_count` 必须等于实际 Pack Card 数量；发布校验事务拒绝不一致的 manifest。
- 发布后不允许更新 `content`、`position`、`source_reference` 或 hash。
- `pack_card_id` 在版本内稳定，建议使用规范化内容 hash，而不是依赖数据库自增值。

### 5.2 用户安装记录

新增表：

```text
card_pack_installations
  installation_id uuid primary key
  owner_address text not null
  pack_version_id uuid references card_pack_versions
  project_id text unique references learning_projects(project_id)
  folder_id uuid null references project_folders(folder_id)
  installed_at timestamptz not null
  last_opened_at timestamptz
  unique (owner_address, pack_version_id)
```

`unique (owner_address, pack_version_id)` 让安装操作幂等。用户重复点击或网络重试只返回原来的 Project，不会生成多个重复卡包。

### 5.3 对现有表的最小扩展

在 `learning_projects` 增加：

```text
project_kind text not null default 'UPLOAD'
  check (project_kind in ('UPLOAD', 'PACK'))
pack_version_id uuid null references card_pack_versions(pack_version_id)
```

在 `chapters` 增加：

```text
pack_chapter_id smallint null
```

在 `knowledge_cards` 增加：

```text
origin_type text not null default 'WORK_UNIT'
  check (origin_type in ('WORK_UNIT', 'PACK'))
origin_pack_card_id text null references card_pack_cards(pack_card_id)
```

同时调整现有约束：

```text
UPLOAD Project:
  project_kind = UPLOAD
  pack_version_id is null
  knowledge_cards.origin_type = WORK_UNIT
  knowledge_cards.work_unit_id is not null

PACK Project:
  project_kind = PACK
  pack_version_id is not null
  knowledge_cards.origin_type = PACK
  knowledge_cards.origin_pack_card_id is not null
  knowledge_cards.work_unit_id is null
```

现有 `chapters.start_block/end_block` 对 PACK 没有实际意义。推荐将它们改为对 PACK 可为空，并新增数据库检查：UPLOAD 必须有 Source Block 范围，PACK 必须有 `pack_chapter_id`。不要为卡包伪造 Source Block 页码或 Work Unit。

现有 `knowledge_cards.content` 的 `source` 字段需要做版本化 union：

```ts
type GeneratedCitation = {
  kind: "source_block";
  page: number;
  quote: string;
};

type PackReference = {
  kind: "pack_reference";
  label: string;
  url?: string;
  locator?: string;
  quote?: string;
};
```

旧的 UPLOAD 卡片继续使用 `source_block`。PACK 卡片使用 `pack_reference`，页面明确显示“卡包来源”，不能把外部参考伪装成逐字 PDF 引用。

## 6. 安装事务与状态流转

### 6.1 安装流程

```text
用户浏览 PUBLISHED Pack Version
  -> 点击添加到我的学习
  -> 服务端校验 wallet session
  -> begin transaction
       锁定 Pack Version，确认仍为 PUBLISHED
       检查 owner + pack_version 是否已有 Installation
       创建 PACK Learning Project（READY）
       复制 Pack Chapters -> Chapters
       复制 Pack Cards -> Knowledge Cards
       创建 Card Pack Installation
       可选：移动到指定 Folder
     commit
  -> 返回 projectId
  -> 打开现有 Project 学习工作区
```

安装不应创建任何 Workflow Job。项目直接为 `READY`，因为内容在发布前已经完成校验。

### 6.2 项目标识与 hash

PACK Project 仍然需要内部稳定的 `source_hash` / `outline_hash` 以满足现有 Project 视图和审计合同，但这些 hash 只表示卡包版本的内容，不代表用户上传资料：

```text
source_hash  = H("mindmark:pack-source:v1:" + pack_version_id + ":" + content_hash)
outline_hash = manifest_hash
```

这些 hash 不提交 Monad，也不参与 Worker commitment。接口响应中应明确 `projectKind = PACK`，避免用户误以为有链上创建待确认。

### 6.3 安装失败与幂等

- 卡包不存在或未发布：返回 `404 pack_not_found`。
- 卡包已下架但已有安装：已有 Project 继续可学习；新安装返回 `409 pack_not_available`。
- 同一用户重复安装同一版本：返回已有 `projectId`，不创建新记录。
- 复制过程中任何章节或卡片失败：事务整体回滚，不留下半成品 Project。
- 复制完成后不再调用 AI 或链上系统，因此安装成功与否不依赖 Runner 在线。

## 7. API 设计

### 7.1 公开目录

```text
GET /api/packs
  查询参数：subject、language、level、query
  返回：已发布 Pack Version 的摘要、章节数、卡片数、预计学习时间

GET /api/packs/:packId
  返回：卡包元数据、版本、章节摘要、来源许可证、作者/归属信息

GET /api/packs/:packVersionId/chapters/:chapterId
  返回：章节预览和 Pack Card 内容
```

公开接口只返回 `PUBLISHED` 内容，不暴露草稿版本、内部审计字段或服务端路径。

### 7.2 安装

```text
POST /api/packs/:packVersionId/install
body: { folderId?: uuid | null }

response:
{
  "projectId": "0x...",
  "installationId": "uuid",
  "projectKind": "PACK",
  "packVersionId": "uuid",
  "status": "READY",
  "chapterCount": 16,
  "cardCount": 112,
  "idempotent": false
}
```

owner 只能从服务端 Wallet Session 获取。浏览器不能提交任意 owner，也不能提交 `project_kind` 来把普通项目伪装成 PACK。

### 7.3 用户已安装卡包

```text
GET /api/packs/installed
DELETE /api/packs/installations/:installationId
```

删除安装的 MVP 语义是删除用户自己的 PACK Project、卡片和复习状态，不删除公开 Card Pack。删除前需要明确提示复习进度会丢失；后续可以增加“归档”代替删除。

## 8. Web 信息架构

### 8.1 资料库入口

在 `/learn` 增加一个“卡包”入口或顶部 Tab：

```text
资料库
├── 我的资料
├── 我的卡包
└── 发现卡包
```

“发现卡包”展示公开目录；“我的卡包”展示已安装的 PACK Project；“我的资料”继续展示 UPLOAD Project。现有文件夹可以包含两类 Project，但列表需要显示来源标签：`PDF 资料` 或 `预置卡包`。

### 8.2 卡包详情页

首屏应直接展示：

- 卡包标题、主题、难度、语言和版本。
- 章节列表、每章卡片数量和预计时间。
- 许可证、作者、来源说明。
- “预览章节”和“添加到我的学习”操作。

不显示“AI 正在生成”或“需要发送 Monad 交易”。卡包内容已经就绪，用户安装后可以立即进入学习。

### 8.3 已安装卡包的 Project 工作区

复用现有 `/learn/projects/:projectId` 和章节页面，增加只读来源信息：

- 顶部显示 `Solidity Foundations · 卡包 v1`。
- Knowledge Card 的来源标签显示“卡包参考”，而不是“PDF 引用”。
- 隐藏或禁用重新分析资料结构、发送创建交易等只适用于 UPLOAD 的命令。
- 章节、卡片、困难/掌握/轻松和 FSRS 复习流程保持一致。

## 9. 卡包内容格式与发布流程

推荐把卡包作为仓库内可审查的版本化 fixture，先用 Git 发布；MVP 不需要后台 CMS。

```text
content/card-packs/
  solidity-foundations/
    v1/
    v2/
      manifest.json
      chapters/...
    v3/
    v4/
      manifest.json
      chapters/
        01-hello-web3.json
        02-value-types.json
        ...
        15-errors.json
      README.md
```

示例 manifest：

```json
{
  "slug": "solidity-foundations",
  "version": "1.0.0",
  "title": "Solidity 基础",
  "description": "从类型、状态变量、函数到错误处理的 Solidity 入门卡包。",
  "subject": "Solidity",
  "language": "zh-CN",
  "level": "beginner",
  "license": "CC BY 4.0",
  "attribution": "Mindmark Hackathon Team",
  "chapters": [
    {
      "id": 0,
      "slug": "types-and-values",
      "title": "类型与值",
      "summary": "理解 Solidity 常见类型及其数据位置。",
      "cardsFile": "chapters/01-types-and-values.json"
    }
  ]
}
```

每张 Pack Card 至少包含：

```text
packCardId
type: concept | qa | comparison | process | application | misconception
    | code_read | code_write | code_complete | code_debug
    | output_trace | security_review
question
answer
keyPoint
code?: {
  language: "solidity"
  starterCode?: string
  solutionCode: string
  testInput?: string
  expectedResult?: string
  hints?: string[]
}
tags
importance
initialDifficulty
sourceReference: { label, url?, locator?, quote? }
```

发布脚本必须在写入 Supabase 前执行：

1. Zod schema 校验和字段长度校验。
2. 章节和卡片 ID、position、数量一致性校验。
3. 卡片 question 的规范化去重。
4. 章节覆盖检查：每个章节都有卡片，且没有空章节。
5. 来源参考完整性和 URL/许可证检查。
6. 中英文混用检查，确保中文卡包不会全部生成英文。
7. 基础概念、对比、流程、应用和误区的覆盖检查。
8. 计算 manifest hash、content hash，并生成可回放的发布 artifact。

模型可以帮助起草卡片，但发布前必须把卡片当作固定内容审计；不能在用户点击安装时临时调用模型。

## 10. 质量策略

### 10.1 卡包质量与上传资料质量分开

UPLOAD Project 的质量主要验证：Source Block 逐字引用、Chapter 覆盖、Work Unit provenance 和 AI 生成候选。

PACK Project 的质量主要验证：来源参考、概念覆盖、卡片去重、难度梯度、章节顺序和许可证。两者不能共用“必须有 Work Unit 引用”的质量门。

### 10.2 Solidity 卡包建议的章节结构

v4 不把初学者刚接触的多个概念压进少数大章，而是按 WTF Academy Solidity 101 的递进关系拆成 16 个可完成的小步骤，并分成六个阶段。每章固定 7 张卡：概念、检查理解、读代码或运行推理、补全代码、独立写代码、应用和误区；其中 3 张是可执行的 Solidity 练习。

1. Hello Web3：三行合约与 Remix。
2. 值类型：bool、整数、地址、bytes 与 enum。
3. 函数：可见性、状态可变性与 payable。
4. 函数输出：return、returns 与解构赋值。
5. 数据位置：storage、memory、calldata。
6. 数组与结构体：组织可读的状态。
7. Mapping：用 key 建立账户索引。
8. 初始值与 delete：显式重置状态。
9. constant 与 immutable：固定配置的两种方式。
10. 控制流与插入排序：循环和边界。
11. 构造函数与 modifier：建立权限边界。
12. 事件：让状态变化可被链下观察。
13. 继承：virtual、override 与 super。
14. 接口与外部调用：IERC20 风格的最小 ABI。
15. 错误处理：require、revert、assert、custom error 与 MiniVault 审查。

每章 manifest 都声明至少三个 `learningObjectives`，并通过 `prerequisiteChapterIds` 依赖上一章；v4 还声明 `stageId`、`stageTitle`、`newConcepts`、`prerequisiteConcepts`、`practiceFocus` 和 `projectMilestone`。v4 校验器会拒绝缺少目标、非线性依赖、重复问题、代码字段不完整或中文问题为空的版本。课程正文和代码是 Mindmark 重写内容，只参考公开课程的顺序，不复制原文。

### 10.3 评分和反馈

现有 FSRS 的困难/掌握/轻松只表示记忆表现，不等于卡片内容正确。PACK 卡片继续使用现有卡片反馈入口，但反馈要带 `origin_pack_card_id` 和 `pack_version_id`，便于发现某个卡包版本的系统性问题。

## 11. 代码 Module 与 Adapter 划分

建议新增以下深 Module：

```text
packages/shared/src/card-pack.ts
  PackManifestSchema
  PackChapterSchema
  PackCardSchema
  validatePackManifest
  hashPackManifest

apps/web/lib/server/card-packs.ts
  listPublishedPacks
  getPublishedPack
  installPackForOwner
  listInstalledPacks

apps/web/lib/server/adapters/supabase/card-pack-store.ts
  目录查询、发布读取和安装事务 Adapter

apps/web/app/api/packs/**
  只做 session、request schema、application Module 调用和稳定错误转换
```

`card-packs.ts` 的 Interface 应隐藏以下细节：

- 卡包发布状态和版本选择。
- 安装幂等键。
- PACK Project / Chapter / Knowledge Card 的原子复制。
- 内容 hash 和 provenance 映射。
- Folder owner 校验。

Web 组件不能直接拼装卡包表字段，也不能直接插入 `learning_projects`、`chapters` 或 `knowledge_cards`。

Runner 不应该引用 Card Pack Module。卡包安装已经有最终内容，不需要 Worker。

## 12. 测试计划

### Shared

- manifest 缺字段、超长字段、重复 ID、空章节、重复 question 会失败。
- 同一 manifest 的 hash 稳定；字段顺序变化不会改变 canonical hash。
- 语言和 card type 枚举符合内容策略。

### Supabase

- 只有 PUBLISHED 版本可以安装。
- 同一 owner 重复安装返回同一 Project。
- 两个 owner 安装同一版本会得到不同 Project 和独立卡片状态。
- 安装事务中途失败不会留下半个 Project。
- PACK Project 不会生成 Workflow Job、Work Unit 或 Monad creation intent。
- PACK 卡片允许 `pack_reference`，UPLOAD 卡片仍必须使用 `source_block`。
- 删除 PACK Project 会删除用户状态，但不影响公开目录和其他用户。

### Web

- `/api/packs` 只显示 PUBLISHED 版本。
- 未登录用户可以浏览公开卡包，但不能安装。
- 安装成功后跳转到现有 Project 工作区。
- PACK Project 不显示发送 Monad 交易和重新分析资料结构按钮。
- PACK Project 的章节和卡片可以完整复习，评分后状态只影响当前用户。

### 回归

- UPLOAD Project 的现有 AI、Runner、链上和奖励测试全部保持通过。
- Runner 扫描队列时不会领取 PACK Project 的任务。
- Project 级复习和 Chapter 级复习都能处理 PACK Project。

## 13. 分阶段实施

### Phase 1：内容和共享 Schema

- 增加 `packages/shared/src/card-pack.ts`。
- 保留 `solidity-foundations/v1`、`v2`、`v3` 历史 fixture，并生成 `v4` 的 16 章、112 卡 manifest、章节和代码练习 fixture。
- v4 章节必须声明递进元数据，发布器按 major version 选择 `publish_card_pack_v4`。
- 增加发布校验脚本和固定测试集。
- 确定 `source_reference` 和 `project_kind` 的 JSON 合同。

### Phase 2：数据库基线

- 新增 `card_packs`、`card_pack_versions`、`card_pack_chapters`、`card_pack_cards`、`card_pack_installations`。
- 扩展 `learning_projects`、`chapters`、`knowledge_cards` 的来源字段和 CHECK/FK。
- 写入系统卡包 seed，并验证 manifest/content hash。
- 不修改既有 UPLOAD 数据的含义；旧卡片默认 `origin_type = WORK_UNIT`。

### Phase 3：目录和安装 Application Module

- 实现公开目录查询、版本详情、章节预览。
- 实现 owner-scoped、幂等的安装事务。
- 安装成功直接创建 `READY` PACK Project。
- 增加稳定错误码：`pack_not_found`、`pack_not_available`、`pack_already_installed`、`pack_install_failed`。

### Phase 4：Web 体验

- `/learn` 增加“发现卡包”和“我的卡包”。
- 卡包详情页支持按章节预览和一键添加。
- 现有 Project 页面显示内容来源标签。
- PACK Project 隐藏 Upload-only 操作，复用现有复习交互。

### Phase 5：质量和演示

- 运行全部 Shared/Web/Runner 测试、lint、typecheck、build。
- 用两个测试钱包安装同一 Solidity 卡包，确认复习进度完全隔离。
- 验证 Runner 停止时卡包仍能安装和复习。
- 在演示 runbook 中加入“发现卡包 -> 预览 -> 添加 -> 立即复习”的主路径。

## 14. MVP 暂不做的事情

- 不做用户在线编辑和发布卡包。
- 不做卡包市场、付费、分成或 NFT 所有权。
- 不在安装时重新调用 AI 改写卡片。
- 不自动把旧版本用户内容升级为新版本。
- 不把卡包卡片提交到 Monad Registry；链上 commitment 仍属于上传资料生成流程。
- 不引入外部消息队列或独立卡包微服务。

## 15. 后续演进

当卡包和上传资料都稳定后，可以再抽象一个通用 `Study Content Source` Interface：

```ts
type StudyContentSource =
  | { kind: "PROJECT"; projectId: Hex }
  | { kind: "PACK"; packVersionId: string };
```

该 Interface 可以统一目录、章节列表和卡片读取，但不应提前把两种 provenance、质量门和链上状态强行合并。当前 MVP 先采用“卡包发布目录 + 安装成 PACK Learning Project”的深 Module，保留未来扩展空间，同时让现有复习页面获得最大复用。
