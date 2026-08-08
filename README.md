# Mindmark AI 学习与可验证知识卡平台

Mindmark 把用户上传的资料整理成可学习的 Chapter 和带逐字引用的 Knowledge Card，并用 FSRS 安排复习；生成过程通过 Monad Registry、Project Escrow 和 Moss Verification 留下可核验的链上证据。

**一句话简介**：Mindmark 用 AI 把资料变成有来源的学习卡片，用 FSRS 帮用户长期复习，并用 Monad 记录生成承诺与 Worker Reward 结算证据。

## 项目简介

Mindmark 面向希望把长文档、课程资料和技术材料变成结构化学习路径的用户。它把“内容生成”和“学习进度”分开：AI Runner 负责异步生成，学习者在 Web 中阅读、复习和向 Chapter AI Tutor 提问。

当前支持两种内容来源：

- **UPLOAD Learning Project**：用户上传文本型 PDF，AI 规划 Chapter、设计 Card Blueprint、生成并检查 Knowledge Card。
- **PACK Learning Project**：用户安装经过校验的版本化 Card Pack，直接进入阅读和复习，不经过 AI 生成、Runner 或 Monad 登记流程。

基本关系：

```text
资料 / Card Pack
  -> Learning Project
      -> Chapter
          -> Knowledge Card
              -> Study Session / FSRS
```

`Work Unit` 是 Runner 内部的执行分片，用于并行生成、链上 commitment 和奖励结算，不出现在学习者的课程导航中。

## 解决的问题

很多资料学习工具只能完成“上传、总结、问答”，很难同时保证来源、结构和长期复习：

- 长资料缺少连续、可执行的章节学习路径。
- AI 生成的卡片容易脱离原文，用户无法快速回到证据位置。
- 生成失败、Runner 重启或 RPC 超时后，任务经常卡在中间状态。
- 贡献者、生成任务和奖励之间缺少明确的链上关系。
- 学习进度、文档内容和链上承诺混在一起，隐私边界不清楚。

Mindmark 将这些职责拆开：Supabase 保存学习与工作流状态，Monad 保存不可变承诺和资金结算证据，AI 不直接决定链上身份或奖励收款人。

## 核心流程

### 上传资料生成

```text
上传 PDF / 文本
  -> Source Intake
  -> PLAN_OUTLINE
  -> AI 生成 Chapter 大纲
  -> 用户确认 Chapter
  -> 用户钱包登记 Monad Project
  -> Sponsor Treasury 锁定完整生成预算
  -> 生成 Work Unit 候选卡片
  -> Chapter Quality Gate 检查引用、Rubric、重复项和覆盖率
  -> Worker 提交已批准的 Work Unit commitment
  -> 组装 Chapter 和 Project
  -> Chapter / Project READY
  -> 独立结算 Worker Reward
```

### 预置 Card Pack

```text
浏览 Card Pack 目录
  -> 预览版本与章节
  -> 安装到自己的 PACK Learning Project
  -> 阅读 Chapter
  -> 复习 Knowledge Card
  -> 独立保存 FSRS 进度
```

Card Pack 是不可变的版本化内容。重复安装同一版本会返回原有安装，不会创建重复卡片；不同钱包拥有彼此隔离的学习进度。

## 核心特性

- **Chapter-first 学习结构**：每个 Chapter 对应连续的 Source Block 范围，拥有学习目标、先修关系和自己的 Knowledge Card。
- **逐字引用**：生成卡片必须回指真实 Source Block，用户可以从卡片跳回原文或 PDF 页面。
- **Blueprint 驱动生成**：先建立 Chapter Concept Inventory 和 Card Blueprint，再让 Worker 按 Slot 生成卡片，避免只追求卡片数量。
- **质量检查与可恢复工作流**：每个 Runner 阶段使用 Supabase Workflow Job、租约和有限重试；模型失败不会留下伪造卡片。
- **Chapter AI Tutor**：只读取当前 Chapter Learning Snapshot，可返回经过回查的引用，但不会修改卡片、复习状态或链上承诺。
- **FSRS 复习**：浏览卡片不会推进进度，只有明确揭晓答案并评分的 Study Session 才会更新 FSRS。
- **原版 PDF 阅读**：原始 PDF 放在私有 Supabase Storage，通过短期 Signed URL 提供给项目所有者。
- **公开 Monad 验证页**：`/verify/[projectId]` 展示 Project、Chapter、Work Unit、Escrow 和 Worker Reward 的证据状态，不公开资料正文或复习隐私。
- **预置 Solidity Card Pack**：当前默认版本包含 16 个 Chapter、112 张 Knowledge Card 和 48 张 Solidity 代码练习。

## Sponsor Escrow 与动态定价

当前模型不是向学习者收取 AI 生成费用：

- 学习者只支付创建 Monad Project 的 Gas。
- Sponsor Treasury 在生成开始前为全部 Work Unit 锁定 MON 预算。
- AI API 成本由项目运营方承担，不由 Project Escrow 自动支付。
- Worker Reward 在 Quality Gate 通过并确认 commitment 后才进入结算流程。

每个 Work Unit 在生成前按照固定的定价策略生成报价，不使用 Worker 自报耗时或实际 Token 消耗：

```text
原文规模 + Blueprint Slot 类型 + 难度
  -> work-unit-pricing-v1
      -> S / M / L / XL
          -> 冻结 Worker Reward Quote
```

当前配置基数由 `WORKER_REWARD_AMOUNT_MON` 提供，S/M/L/XL 使用不同倍数。Project Escrow 锁定的是全部冻结报价之和，收款人从 Registry V2 的 Work Unit commitment 中读取，Runner 不能在结算时临时修改收款地址或金额。

## Monad 与 Moss 的职责边界

Monad 只保存可验证的承诺和结算事实，不保存：

- PDF、Source Block 或 Knowledge Card 正文；
- AI Prompt、Tutor 对话或模型原始输出；
- FSRS 明文复习状态。

Moss 在 Reward 流程中执行四阶段 Verification：

```text
discover
  -> load
  -> action
  -> simulate
```

Moss 会核对精确的 Escrow capability、Project/Work Unit calldata、Treasury、Worker、金额、Plan Hash、模拟 Warning 和资产变化。Moss 不持有私钥、不签名、不广播；最终交易由独立的 Reward Treasury signer 执行。

当前运行模式：

| Chain ID | 状态 |
|----------|------|
| `10143` | Mindmark 实验性 Monad Testnet 兼容模式 |
| `143` | Moss 官方目标 Monad Mainnet |

因此，Testnet 演示不能描述为 Moss 官方 Testnet 支持，也不能宣称当前三个 Worker 构成开放的去中心化 Worker 市场。

## 项目架构

```text
┌────────────────────────────────────────────────────────────┐
│ Browser / Next.js Web                                      │
│ Wallet Session · Upload · Reading · Tutor · Review          │
│ Monad wallet interaction · Public Verification Snapshot    │
└────────────────────────────┬───────────────────────────────┘
                             │ HTTPS / Supabase / RPC
┌────────────────────────────▼───────────────────────────────┐
│ Supabase                                                   │
│ Learning Project · Chapter · Card · FSRS                   │
│ Workflow Job · Workflow Event · Reward Intent              │
│ Private PDF Storage                                        │
└────────────────────────────┬───────────────────────────────┘
                             │ leased jobs
┌────────────────────────────▼───────────────────────────────┐
│ Node.js Agent Runner                                      │
│ Outline · Chapter Design · Worker · Quality · Assembly     │
│ Finalization · Moss Verification · Reward Settlement       │
└───────────────┬──────────────────────┬─────────────────────┘
                │                      │
                │ AI Gateway           │ Monad JSON-RPC
┌───────────────▼──────────────┐  ┌────▼─────────────────────┐
│ OpenAI-compatible Model API  │  │ Registry V2 / Project    │
│ Generation · Evaluation      │  │ Escrow / Completion      │
│ Embedding (optional)         │  │ Immutable commitments    │
└──────────────────────────────┘  └──────────────────────────┘
```

权威来源划分如下：

| 数据或行为 | 权威来源 |
|------------|----------|
| Learning Project、Chapter、Knowledge Card | Supabase Learning Data |
| Source Block、PDF 和阅读上下文 | Supabase PostgreSQL / Private Storage |
| Workflow Job、设计版本和运行事件 | Supabase Workflow |
| FSRS 复习状态 | Supabase Review Data |
| Project、Chapter、Work Unit commitment | Monad Registry V2 |
| Sponsor Budget 和 Reward release | Project Escrow + Monad receipt |
| Reward Verification evidence | Supabase intent + Monad receipt |

## 快速开始

### 本地依赖

| 环境 | 要求 |
|------|------|
| Node.js | 22 或更高版本 |
| pnpm | 10 或更高版本 |
| Foundry | `forge`、`cast` |
| Supabase | 可访问的 Project 和 Service Role Key |
| Monad | Testnet RPC、Registry 和 Escrow 地址 |
| AI Provider | OpenAI-compatible API Key 和 Tool-calling 模型 |

### 安装与配置

```bash
pnpm install
cp .env.example .env
```

在 `.env` 中填写 Monad、Supabase、AI 和 Runner 钱包配置。私钥、AI API Key、Supabase Service Role Key 和 Session Secret 只能存在服务端环境，不能提交 Git，也不能使用 `NEXT_PUBLIC_` 前缀。

### 验证代码

Shared 必须先构建，再构建 Runner 和 Web，避免 workspace 产物互相清理：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @mindmark/shared build
pnpm --filter @mindmark/ai-gateway build
pnpm --filter @mindmark/agent-runner build
pnpm --filter @mindmark/web build
forge test
git diff --check
```

### 启动 Web 与 Runner

两个进程需要分别启动：

```bash
pnpm --filter @mindmark/web dev
pnpm --filter @mindmark/agent-runner dev
```

Web 默认地址为 `http://localhost:3000`。Runner 是常驻后台进程，会从 Supabase 领取 Workflow Job 并访问 AI、Monad 和 Moss Verification。

### 预置 Card Pack

修改或首次发布固定课程内容时：

```bash
pnpm packs:generate:solidity:v5
pnpm packs:validate
pnpm packs:publish
```

发布后访问 `/learn/packs`。同一版本和同一 hash 的重复发布是幂等的。

## 合约部署顺序

首次部署到一个新的 Testnet 环境时，顺序如下：

1. 部署 `LearningProjectRegistryV2`。
2. 使用同一个 Registry 地址部署 `LearningProjectEscrow`。
3. 执行 Supabase migration，并刷新 Schema Cache。
4. 在 Web 和 Runner 中配置相同的 Registry、Escrow 和 Chain ID。
5. 用一个新项目跑通 Funding、Generation、Quality、Finalization 和 Reward。
6. 可选部署 `LearningCompletionRegistry`，启用学习完成凭证。

合约脚本位于 `contracts/script/`。详细的真实环境重建、故障注入和验收步骤见 [生产演练手册](docs/PRODUCTION_REHEARSAL_RUNBOOK.md)。

## 公网 Testnet 部署

保持 Monad Testnet `10143` 时，推荐使用一个 Railway Project 部署两个 Service：

- Web：使用 `/deploy/railway/web.railway.json`，生成公网 HTTPS 域名。
- Runner：使用 `/deploy/railway/runner.railway.json`，保持单实例常驻，不需要公网域名。

两个 Service 的 Root Directory 都必须是仓库根目录，不能设置为 `apps/web` 或 `apps/agent-runner`。详细的 Config as Code、环境变量、数据库闸门和 Smoke Test 见 [公网 Testnet 部署手册](docs/PUBLIC_TESTNET_DEPLOYMENT.md)。

上线前至少完成：

1. Supabase migration 和 `get_schema_capabilities_v1()` 检查。
2. Web `/api/health` 返回 `200`。
3. 钱包登录和 Monad Testnet Project 登记成功。
4. 一份真实 PDF 从上传到 Project `READY`。
5. `/verify/[projectId]` 可以读取链上证据。
6. Runner 重启后 Workflow Job 可以恢复。

## 运营与安全

- `/operations` 只对 `OPERATOR_WALLET_ADDRESSES` 白名单开放，页面只展示脱敏的任务和质量指标。
- `staleJobs`、`failedJobs`、`blockedRewards` 和 `failedProjects` 非零时需要人工处理。
- Reward 失败不会把已经 `READY` 的 Chapter 或 Project 回滚。
- Sponsor Treasury 需要单独的钱包、Gas 余额和预算上限，不能复用 Coordinator 或 Worker。
- AI API 需要配置配额、超时、有限重试和账单告警；Sponsor Escrow 不支付 AI Provider 账单。
- 公开开放前应增加每钱包/每 IP 的项目创建限额，并限制公开 Monad RPC 代理的调用量。
- 日志不能写入私钥、Service Role Key、Prompt、PDF 正文、Knowledge Card 正文或 signed transaction。

## 技术栈

### Web

| 技术 | 用途 |
|------|------|
| Next.js 16 + React 19 | 页面、Server API 和服务端渲染 |
| TypeScript | Web、Runner 和 Shared Domain |
| wagmi + viem | Monad 钱包连接和链上读取 |
| SIWE | 钱包登录和 Session 建立 |
| Supabase JS | PostgreSQL、Storage 和 RPC |
| FSRS | Knowledge Card 复习调度 |

### Runner 与 AI

| 技术 | 用途 |
|------|------|
| Node.js + TypeScript | 常驻 Agent Runner |
| Supabase Workflow Jobs | 可恢复任务领取、租约和重试 |
| OpenAI-compatible AI Gateway | Tool calling、评估、超时和错误分类 |
| `@themoss/core` + `@themoss/simulator` | Reward Verification 和模拟 |
| viem | Monad RPC、ABI、签名和 receipt 校验 |

### Smart Contracts

| 合约 | 职责 |
|------|------|
| `LearningProjectRegistryV2` | Project、Chapter 和 Work Unit commitment |
| `LearningProjectEscrow` | Sponsor Budget、冻结报价、Reward release 和退款 |
| `LearningCompletionRegistry` | 可选的学习完成凭证 |

## 相关文档

- [项目 Sponsor Escrow 实施文档](docs/PROJECT_SPONSOR_ESCROW_IMPLEMENTATION.md)
- [Monad 可验证学习层实施文档](docs/MONAD_VERIFIABLE_LEARNING_IMPLEMENTATION.md)
- [Moss Onchain Agent 实施文档](docs/MOSS_ONCHAIN_AGENT_IMPLEMENTATION.md)
- [生产演练手册](docs/PRODUCTION_REHEARSAL_RUNBOOK.md)
- [公网 Testnet 部署手册](docs/PUBLIC_TESTNET_DEPLOYMENT.md)
- [Card Pack 架构](docs/CARD_PACK_ARCHITECTURE.md)
- [原文阅读与知识卡双视图方案](docs/DOCUMENT_CARD_DUAL_VIEW_IMPLEMENTATION_PLAN.md)

## 已知限制

- 目前只支持文本型 PDF，最大 15 MB、30 页，提取文本最多 60,000 字符；扫描件需要先进行 OCR 或粘贴文本。
- Knowledge Card Hash 可以证明 commitment 后内容未被篡改，不能证明知识内容本身绝对正确。
- Monad Testnet `10143` 是 Mindmark 的实验性兼容模式，不等同于 Moss 官方 Testnet 支持。
- 当前三个 Worker 由同一个 Runner 管理，尚不是开放的去中心化 Worker 市场。
- Sponsor Escrow 是生成预算和结算约束，不是课程购买、AI API 账单或学习者余额。
- Learning Completion Attestation 不是学校证书、职业资格或无需信任的知识证明。
