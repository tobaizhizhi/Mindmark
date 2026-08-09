# Mindmark AI 学习与 Monad Agent 支付平台

演示视频链接:https://youtu.be/hMycbpAJkhk

Mindmark 将书籍、论文、课程讲义等长资料整理为有章节顺序、带原文依据的知识卡，并通过主动回忆与 FSRS 复习调度算法帮助学习者持续复习。对于 AI 生成部分，Monad 负责登记 Project、锁定 Sponsor 预算和结算 Worker Reward，Moss 在 Treasury 签名前审阅资金操作。

**一句话简介**：Mindmark 用 AI 将长资料整理成带原文依据的知识卡片，通过主动回忆与 FSRS 复习调度算法帮助学习者复习，并利用 Monad 为每项 AI 生成任务锁定预算、验收质量和结算奖励。

## 项目简介

Mindmark 同时处理两个相互连接的问题：如何让 AI 生成的内容真正成为可学习、可复习的材料，以及如何让 AI 代理的工作量对应到可预先约束、事后可核验的支付。系统先把资料整理成有顺序的章节，再把每章划分为几个独立的内容片段，作为不同的生成任务。AI 针对每个任务生成知识卡片候选，质量检查会核对卡片是否引用原文、难度是否合适、是否覆盖章节重点；每个任务的预算在生成前就按预估工作量锁定，只有质量检查通过并完成对应的链上结果登记后，才会向工作代理释放奖励。

作为 Monad Hackathon 项目，Mindmark 将 Monad 用作这条支付链路的执行层：利用 EVM 兼容性复用 Solidity、Foundry 和现有钱包，利用低成本、高吞吐和较快确认支持细粒度工作结算。PDF、卡片正文和 FSRS 复习调度算法的明文状态仍保存在链下，Monad 只处理需要共享约束的 Project 身份、预算和结算状态。

当前支持两种内容来源：

- **上传型学习项目（UPLOAD）**：上传文本型 PDF，由 AI 规划章节、生成并检查知识卡片。
- **卡包学习项目（PACK）**：安装经过校验的版本化卡包，直接阅读和复习，不经过 AI 生成或 Monad 工作流。

## 应用场景

- **个人深度学习**：把书籍、论文、课程讲义或长篇资料转成可循序学习、可主动回忆的知识卡片。
- **专业技能与持续教育**：围绕技术、产品、法律、医疗、金融或安全等专业材料，建立带来源依据的学习路径。
- **学校、训练营与企业培训**：教师或培训者统一准备课程内容，学习者使用同一套资料，并分别保留自己的学习与复习进度。

## 核心流程

### 上传资料

```text
上传 PDF / 文本
  -> AI 规划章节
  -> 学习者确认大纲
  -> 钱包登记 Monad Project
  -> 赞助方资金库锁定各项生成任务的预算
  -> 工作代理生成候选卡片
  -> 质量检查验收引用、难度和覆盖率
  -> 提交该任务的结果承诺
  -> 章节 / 项目 READY
  -> Moss 审阅后结算工作奖励
```

### 卡包内容

```text
浏览版本 -> 预览章节 -> 安装到自己的学习项目 -> 阅读与复习
```

## 产品思路

Mindmark 同时处理学习效果和 AI 执行成本。被动重读容易产生熟悉感，却难以检验掌握度；主动回忆要求学习者在没有答案提示时提取知识，再用评分和间隔复习巩固记忆。

AI 生成也需要类似的约束。不同生成任务的复杂度不同，不能简单使用一个固定价格；生成前直接付款无法约束质量，生成后按工作代理自报 Token 或耗时结算又缺少稳定标准。因此 Mindmark 在生成前根据原文规模、Blueprint Slot 类型和难度冻结 S/M/L/XL 报价，先锁定项目预算，再在质量通过后付款。Monad 的低交易成本和高吞吐特性，使这种为每项生成任务单独报价、锁定预算、提交承诺并结算奖励的方式具备实际可行性，而不必把所有 AI 工作合并成一笔难以核验的固定付款。

AI 负责提出内容候选，质量检查决定内容能否采用，Supabase 保存可恢复的学习与工作流状态，Monad Escrow 管理预算和奖励规则，Moss 在资金库签名之前检查 AI 代理提出的资金动作。

## 核心特性

- **章节优先与原文引用**：每个章节对应连续的原文区块范围，知识卡片可以回到真实原文或 PDF 页面。
- **主动回忆 + FSRS 复习调度算法**：答案在揭晓前隐藏，学习者先作答；只有实际完成回忆和评分才会更新掌握度与复习计划。
- **动态 AI 生成任务报价**：在 Monad Project Escrow 中为每项生成任务冻结 S/M/L/XL 报价和赞助预算，重试不会抬高报价，质量未通过不会创建奖励。
- **可恢复的 AI 生成流程**：Runner 使用 Supabase 工作流任务、租约和有限重试，支持大纲、设计、生成、质量检查、组装和最终确认。
- **受约束的 AI 代理支付**：Moss 限制 Escrow capability 并模拟交易，Mindmark 核对收款人、金额、calldata 和资产变化，最终由独立资金库签名。

## AI 费用与支付

Mindmark 将三种费用分开：

| 费用 | 承担方 | 支付方式 |
|------|--------|----------|
| 模型 API 调用 | Mindmark 运营方 / 赞助方 | AI 服务商账户离链计费 |
| AI 工作奖励 | 赞助方资金库 | Monad Project Escrow 支付 MON |
| 项目登记 Gas | 学习者 | 钱包支付少量 Monad Gas |

Project Escrow 支付的是 AI 工作奖励，不是 OpenAI 兼容服务商的 API 账单，也不是用户购买课程的费用。当前用户不直接支付 AI 生成费；赞助方同时承担模型 API 账单和工作奖励预算。

支付流程如下：

```text
章节蓝图
  -> 计算每项生成任务的报价
  -> Sponsor 锁定全部 Quote 之和
  -> AI Worker 生成与质量检查
  -> 创建冻结金额的 Reward entitlement
  -> Moss discover / load / action / simulate
  -> Mindmark 核对目标、收款人、金额和资产变化
  -> Reward Treasury 签名广播
  -> Project Escrow 释放 MON
```

当前三个工作代理仍由同一个 Runner 管理，这是一套受约束的 AI 代理工作结算原型，不是开放竞价的去中心化工作代理市场。模型服务商的发票也不会被伪装成链上奖励。

## 后续计划

- **更多资料类型**：在文本型 PDF 之外接入 Markdown、网页和 EPUB，并为不同格式保留稳定的章节定位与原文引用，让生成的卡片仍然可以回到证据位置。
- **更灵活的费用模式**：在 Sponsor 预先锁定预算的基础上，增加用户自付、额度抵扣和混合支付，让项目创建者可以按课程、组织或活动配置 AI 生成费用的承担方式与预算上限。
- **学习效果分析**：基于主动回忆结果和 FSRS 复习调度算法数据，提供章节掌握度、遗忘风险和复习效果分析，帮助学习者和课程组织者发现需要加强的内容。

## 项目架构

```text
┌────────────────────────────────────────────────────────────┐
│ Browser / Next.js Web                                      │
│ Upload · Reading · Tutor · Review · Wallet Session          │
└────────────────────────────┬───────────────────────────────┘
                             │ HTTPS / RPC
┌────────────────────────────▼───────────────────────────────┐
│ Supabase                                                   │
│ Learning Data · FSRS 复习调度算法 · Workflow Jobs · Reward Intents      │
│ Private PDF Storage                                        │
└────────────────────────────┬───────────────────────────────┘
                             │ leased jobs
┌────────────────────────────▼───────────────────────────────┐
│ Node.js Agent Runner                                      │
│ Outline · Design · Workers · Quality · Assembly · Reward   │
└───────────────┬──────────────────────┬─────────────────────┘
                │                      │
                │ AI Gateway           │ Monad JSON-RPC
┌───────────────▼──────────────┐  ┌────▼─────────────────────┐
│ OpenAI-compatible Model API  │  │ Registry V2 / Project    │
│ Generation · Evaluation      │  │ Escrow / Completion      │
└──────────────────────────────┘  └──────────────────────────┘
```

Supabase 是学习状态和 Workflow 的权威来源；Monad Registry 和 Escrow 是 Project 身份、预算和 Reward 规则的权威来源；Moss 是签名前的 Agent 交易审阅层。

## 快速开始

### 环境要求

| 环境 | 要求 |
|------|------|
| 运行环境 | Node.js 22+、pnpm 10+ |
| 合约工具 | `forge`、`cast` |
| Supabase | 项目地址和 Service Role 密钥 |
| Monad | 测试网 RPC、Registry 和 Escrow 合约地址 |
| AI 服务 | OpenAI 兼容 API 密钥和支持工具调用的模型 |

### 安装与配置

```bash
pnpm install
cp .env.example .env
```

在 `.env` 中填写 Monad、Supabase、AI 和 Runner 所需的钱包与服务配置。私钥、AI API 密钥、Supabase Service Role 密钥和会话密钥只能放在服务端环境，不能提交 Git，也不能使用 `NEXT_PUBLIC_` 前缀。

### 验证代码

先构建共享代码包，再构建 Runner 和 Web：

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

### 启动服务

在两个终端分别启动网页端和后台运行器：

```bash
pnpm --filter @mindmark/web dev
pnpm --filter @mindmark/agent-runner dev
```

网页端默认地址为 `http://localhost:3000`。Runner 是常驻后台进程，会从 Supabase 领取工作流任务，并访问 AI、Monad 和 Moss。

### 发布卡包

```bash
pnpm packs:generate:solidity:v5
pnpm packs:validate
pnpm packs:publish
```

发布后访问 `/learn/packs`。同一版本和同一哈希的重复发布不会产生重复内容。

## 合约与数据库部署

新的测试网环境按以下顺序准备：

1. 部署 `LearningProjectRegistryV2`。
2. 使用同一个 Registry 地址部署 `LearningProjectEscrow`。
3. 按文件名顺序执行 Supabase 数据库迁移，并刷新数据库模式缓存（Schema Cache）。
4. 在 Web 和 Runner 中配置相同的链、Registry、Escrow 合约地址和 Supabase。
5. 用一个新项目跑通预算锁定、AI 生成、质量检查、最终确认和奖励结算。

合约脚本位于 `contracts/script/`。详细步骤见 [生产演练手册](docs/PRODUCTION_REHEARSAL_RUNBOOK.md)。

## 公网测试网部署

推荐在一个 Railway 项目中部署两个服务：

- 网页端：使用 `/deploy/railway/web.railway.json`，生成公网 HTTPS 域名。
- 后台运行器：使用 `/deploy/railway/runner.railway.json`，保持单实例常驻，不需要公网域名。

两个服务的根目录都必须是仓库根目录，不能设置为 `apps/web` 或 `apps/agent-runner`。详细环境变量和冒烟测试见[公网测试网部署手册](docs/PUBLIC_TESTNET_DEPLOYMENT.md)。

## 运营与安全

- `/operations` 只对运营钱包白名单开放。
- `staleJobs`、`failedJobs`、`blockedRewards` 和 `failedProjects` 非零时需要处理。
- 赞助方资金库必须与协调器、工作代理钱包分离，并设置预算与 Gas 上限。
- AI API 需要配置配额、超时、有限重试和账单告警。
- 公开开放前应增加项目创建限额，并限制公开 Monad RPC 代理调用量。

## 技术栈

| 层 | 技术 |
|----|------|
| 网页端 | Next.js 16、React 19、TypeScript、wagmi、viem、SIWE |
| 数据 | Supabase PostgreSQL、Storage、工作流任务、FSRS 复习调度算法 |
| AI | OpenAI 兼容 AI 网关、工具调用、质量评估器 |
| 代理运行器 | Node.js Runner、Moss Core、Moss Simulator |
| 区块链 | Solidity、Foundry、OpenZeppelin、Monad Registry V2、Project Escrow |

## 相关文档

- [赞助方托管实施文档](docs/PROJECT_SPONSOR_ESCROW_IMPLEMENTATION.md)
- [Moss 链上代理实施文档](docs/MOSS_ONCHAIN_AGENT_IMPLEMENTATION.md)
- [生产演练手册](docs/PRODUCTION_REHEARSAL_RUNBOOK.md)
- [公网测试网部署手册](docs/PUBLIC_TESTNET_DEPLOYMENT.md)
- [卡包架构](docs/CARD_PACK_ARCHITECTURE.md)
