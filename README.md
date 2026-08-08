# Mindmark AI 学习与 Monad Agent 支付平台

Mindmark 把长资料整理成带原文依据的 Chapter 和 Knowledge Card，让学习者通过主动回忆与 FSRS 复习真正掌握知识；AI Work Unit 的预算在生成前锁定到 Monad Project Escrow，质量通过后再由 Moss Verification 完成 Worker Reward 结算。

**一句话简介**：Mindmark 用 AI 生成有来源的学习卡片，用主动回忆提高学习效果，并借助 Monad 上的 Escrow 为 AI Agent 的细粒度工作提供受约束的预算与支付流程。

## 项目简介

上传资料并得到总结，不等于形成了可以持续学习的路径。Mindmark 先把资料拆成有顺序的 Chapter，再把每个 Chapter 设计成带引用的 Knowledge Card。学习者需要先回答问题、再揭晓答案，FSRS 根据实际回忆表现安排下一次复习，而不是只记录阅读次数。对于需要 AI 生成的项目，学习内容之外的 Project 身份、预算和 Reward 规则由 Monad 统一约束。

当前支持两种内容来源：

- **UPLOAD Learning Project**：上传文本型 PDF，由 AI 规划 Chapter、生成并检查 Knowledge Card。
- **PACK Learning Project**：安装经过校验的版本化 Card Pack，直接阅读和复习，不经过 AI 生成或 Monad 工作流。

## 应用场景

- **个人深度学习**：把书籍、论文、课程讲义或长篇资料转成可循序学习、可主动回忆的知识卡片。
- **专业技能与持续教育**：围绕技术、产品、法律、医疗、金融或安全等专业材料，建立带来源依据的学习路径。
- **学校、训练营与企业培训**：教师或培训者统一准备课程内容，学习者使用同一套资料，并分别保留自己的学习与复习进度。

## 核心流程

### 上传资料

```text
上传 PDF / 文本
  -> AI 规划 Chapter
  -> 学习者确认大纲
  -> 钱包登记 Monad Project
  -> Sponsor Treasury 锁定 Work Unit 预算
  -> Worker 生成候选卡片
  -> Quality Gate 验收引用、难度和覆盖率
  -> 提交 Work Unit commitment
  -> Chapter / Project READY
  -> Moss Verification 后结算 Worker Reward
```

### Card Pack

```text
浏览版本 -> 预览 Chapter -> 安装到自己的 Learning Project -> 阅读与复习
```

## 产品思路

Mindmark 同时处理学习效果和 AI 执行成本。被动重读容易产生熟悉感，却难以检验掌握度；主动回忆要求学习者在没有答案提示时提取知识，再用评分和间隔复习巩固记忆。

AI 生成也需要类似的约束。不同 Work Unit 的复杂度不同，不能简单使用一个固定价格；生成前直接付款无法约束质量，生成后按 Worker 自报 Token 或耗时结算又缺少稳定标准。因此 Mindmark 在生成前根据原文规模、Blueprint Slot 类型和难度冻结 S/M/L/XL 报价，先锁定项目预算，再在质量通过后付款。

AI 负责提出内容候选，Quality Gate 决定内容能否采用，Supabase 保存可恢复的学习与工作流状态，Monad Escrow 管理预算和 Reward 规则，Moss 在 Treasury 签名之前检查 Agent 提出的资金动作。

## 核心特性

- **Chapter-first + 原文引用**：每个 Chapter 对应连续的 Source Block 范围，Knowledge Card 可以回到真实原文或 PDF 页面。
- **主动回忆 + FSRS**：答案在揭晓前隐藏，学习者先作答；只有实际完成回忆和评分才会更新掌握度与复习计划。
- **动态 AI Work Unit 报价**：在 Monad Project Escrow 中生成前冻结 S/M/L/XL Quote 和 Sponsor Budget，重试不会抬高报价，质量未通过不会创建 Reward。
- **可恢复的 AI Pipeline**：Runner 使用 Supabase Workflow Job、租约和有限重试，支持 Outline、Design、Generation、Quality、Assembly 和 Finalization。
- **受约束的 Agent 支付**：Moss 限制 Escrow capability 并模拟交易，Mindmark 核对 recipient、amount、calldata 和 effects，最终由独立 Treasury 签名。

## AI 费用与支付

Mindmark 将三种费用分开：

| 费用 | 承担方 | 支付方式 |
|------|--------|----------|
| 模型 API 调用 | Mindmark 运营方 / Sponsor | AI Provider 账户离链计费 |
| AI Worker Reward | Sponsor Treasury | Monad Project Escrow 支付 MON |
| Project 登记 Gas | 学习者 | 钱包支付少量 Monad Gas |

Project Escrow 支付的是 Worker Reward，不是 OpenAI-compatible Provider 的 API 账单，也不是用户购买课程的费用。当前用户不直接支付 AI 生成费；Sponsor 同时承担模型 API 账单和 Worker Reward 预算。

支付流程如下：

```text
Chapter Blueprint
  -> 计算 Work Unit Quote
  -> Sponsor 锁定全部 Quote 之和
  -> AI Worker 生成与质量检查
  -> 创建冻结金额的 Reward entitlement
  -> Moss discover / load / action / simulate
  -> Mindmark 核对目标、收款人、金额和资产变化
  -> Reward Treasury 签名广播
  -> Project Escrow 释放 MON
```

当前三个 Worker 仍由同一个 Runner 管理，这是一套受约束的 AI Agent 工作结算原型，不是开放竞价的去中心化 Worker 市场。模型 Provider 的发票也不会被伪装成链上 Reward。

## Monad 与 Moss

Monad 在 Mindmark 中主要承担 AI 工作的可编程支付：它的 EVM 兼容性让项目可以复用 Solidity、Foundry、viem 和现有钱包体系；Registry V2 记录 Project/Work Unit 身份，Project Escrow 在生成前锁定预算，并限制每个 Work Unit 只能按冻结报价释放一次。

Moss 位于 Reward Intent 和 Treasury 签名之间。它先发现并加载受限的 Escrow capability，生成 sealed Plan，再模拟 revert、Warning、gas 和资产变化；Mindmark 还会独立核对 calldata、recipient 和 amount。Moss 不持有私钥、不签名、不广播，Treasury 保留最终资金控制权。

AI 内容、Prompt、PDF、Knowledge Card 正文和 FSRS 明文状态仍保存在链下。Monad 只处理预算、commitment 和 Reward release 等需要共享规则与资金约束的部分。

当前网络状态：

| Chain ID | 状态 |
|----------|------|
| `10143` | Mindmark 实验性 Monad Testnet 兼容模式 |
| `143` | Moss 官方目标 Monad Mainnet |

## 项目架构

```text
┌────────────────────────────────────────────────────────────┐
│ Browser / Next.js Web                                      │
│ Upload · Reading · Tutor · Review · Wallet Session          │
└────────────────────────────┬───────────────────────────────┘
                             │ HTTPS / RPC
┌────────────────────────────▼───────────────────────────────┐
│ Supabase                                                   │
│ Learning Data · FSRS · Workflow Jobs · Reward Intents      │
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
| Runtime | Node.js 22+、pnpm 10+ |
| Foundry | `forge`、`cast` |
| Supabase | Project URL 和 Service Role Key |
| Monad | Testnet RPC、Registry 和 Escrow 地址 |
| AI Provider | OpenAI-compatible API Key 和 Tool-calling 模型 |

### 安装与配置

```bash
pnpm install
cp .env.example .env
```

在 `.env` 中填写 Monad、Supabase、AI 和 Runner 钱包配置。私钥、AI API Key、Supabase Service Role Key 和 Session Secret 只能放在服务端环境，不能提交 Git，也不能使用 `NEXT_PUBLIC_` 前缀。

### 验证代码

Shared 必须先构建，再构建 Runner 和 Web：

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

```bash
pnpm --filter @mindmark/web dev
pnpm --filter @mindmark/agent-runner dev
```

Web 默认地址为 `http://localhost:3000`。Runner 是常驻后台进程，会从 Supabase 领取 Workflow Job 并访问 AI、Monad 和 Moss。

### 发布 Card Pack

```bash
pnpm packs:generate:solidity:v5
pnpm packs:validate
pnpm packs:publish
```

发布后访问 `/learn/packs`。同一版本和同一 hash 的重复发布是幂等的。

## 合约与数据库部署

新的 Testnet 环境按以下顺序准备：

1. 部署 `LearningProjectRegistryV2`。
2. 使用同一个 Registry 地址部署 `LearningProjectEscrow`。
3. 按文件名顺序执行 Supabase migrations 并刷新 Schema Cache。
4. 在 Web 和 Runner 中配置相同的 Chain、Registry、Escrow 和 Supabase。
5. 用一个新项目跑通 Funding、Generation、Quality、Finalization 和 Reward。

合约脚本位于 `contracts/script/`。详细步骤见 [生产演练手册](docs/PRODUCTION_REHEARSAL_RUNBOOK.md)。

## 公网 Testnet 部署

推荐使用一个 Railway Project 部署两个 Service：

- Web：使用 `/deploy/railway/web.railway.json`，生成公网 HTTPS 域名。
- Runner：使用 `/deploy/railway/runner.railway.json`，保持单实例常驻，不需要公网域名。

两个 Service 的 Root Directory 都必须是仓库根目录，不能设置为 `apps/web` 或 `apps/agent-runner`。详细环境变量和 Smoke Test 见 [公网 Testnet 部署手册](docs/PUBLIC_TESTNET_DEPLOYMENT.md)。

## 运营与安全

- `/operations` 只对运营钱包白名单开放。
- `staleJobs`、`failedJobs`、`blockedRewards` 和 `failedProjects` 非零时需要处理。
- Sponsor Treasury 必须与 Coordinator、Worker 钱包分离，并设置预算与 Gas 上限。
- AI API 需要配置配额、超时、有限重试和账单告警。
- 公开开放前应增加项目创建限额，并限制公开 Monad RPC 代理调用量。

## 技术栈

| 层 | 技术 |
|----|------|
| Web | Next.js 16、React 19、TypeScript、wagmi、viem、SIWE |
| Data | Supabase PostgreSQL、Storage、Workflow Jobs、FSRS |
| AI | OpenAI-compatible AI Gateway、Tool calling、Quality Evaluator |
| Agent | Node.js Runner、Moss Core、Moss Simulator |
| Chain | Solidity、Foundry、OpenZeppelin、Monad Registry V2、Project Escrow |

## 相关文档

- [Sponsor Escrow 实施文档](docs/PROJECT_SPONSOR_ESCROW_IMPLEMENTATION.md)
- [Moss Onchain Agent 实施文档](docs/MOSS_ONCHAIN_AGENT_IMPLEMENTATION.md)
- [生产演练手册](docs/PRODUCTION_REHEARSAL_RUNBOOK.md)
- [公网 Testnet 部署手册](docs/PUBLIC_TESTNET_DEPLOYMENT.md)
- [Card Pack 架构](docs/CARD_PACK_ARCHITECTURE.md)

## 已知限制

- 只支持文本型 PDF，最大 15 MB、30 页，提取文本最多 60,000 字符。
- Knowledge Card Hash 只能证明 commitment 后未被篡改，不能保证内容绝对正确。
- Monad Testnet `10143` 是 Mindmark 的实验性兼容模式，不等同于 Moss 官方 Testnet 支持。
- 当前三个 Worker 由同一个 Runner 管理，尚不是开放的去中心化 Worker 市场。
- AI Provider 账单、Sponsor Reward 预算和学习者 Project Gas 是三种不同成本。
