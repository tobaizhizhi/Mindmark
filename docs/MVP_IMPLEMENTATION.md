# Recal LA AI 辅助学习 MVP 实现文档

> 状态：Implementation Draft 0.1
> 目标网络：Monad Testnet
> 首发语言：简体中文（`zh-CN`）
> 文档用途：产品、前端、后端、Agent 与合约开发的共同实现基线

## 1. 产品定义

Recal LA 的 MVP 不是通用 Agent 市场，而是一条可链上支付、可验证交付的学习闭环：

1. 用户使用 Passkey 或钱包登录智能账户，并存入约 5 USDC。
2. 用户上传一份不超过 100 页的 PDF，指定学习目的、卡片数、难度、截止时间和预算。
3. 平台展示经过审核的制卡 Agent 报价，用户选择或接受自动推荐。
4. 用户将任务预算存入 `TaskEscrow`。
5. 制卡 Agent 根据结构化文档生成带原文引用和页码的知识卡。
6. 独立审校 Agent 执行确定性检查和模型抽检，不合格则退回修改。
7. 合格卡包交付后释放 90% 任务款，剩余 10% 进入 72 小时保留期。
8. 用户开始 FSRS 间隔复习；完成三日复习后释放尾款，未操作则到期自动释放。
9. 用户可在复习中请求导师 Agent 讲解，通过 EIP-712 累计付款凭证按次付费。
10. 卡包内容哈希、生成与审校身份、父版本和收益分配写入 `DeckRegistry`。

MVP 的核心价值不是“LLM 能生成卡片”，而是“能在十分钟左右交付有证据、经过独立验收、可以持续复习的卡包，并完成完整链上结算”。

## 2. MVP 边界

### 2.1 首版支持

- 中文文本型 PDF，最多 100 页，单文件最大 50 MB。
- 30～50 张卡片。
- 概念卡、问答卡、单选题三种卡型。
- 每张卡至少包含一个可定位的原文引用和页码。
- 一个任务只能有一个制卡 Agent 和一个独立审校 Agent。
- 平台审核过的 Agent；制卡报价至少展示两个候选项。
- FSRS 间隔复习和四档反馈：忘记、困难、记得、简单。
- Monad 上的 USDC 托管、结算和导师累计微支付。
- 卡包版本、内容哈希和 Agent 身份溯源。
- 用户错误报告和 72 小时尾款争议期。

### 2.2 明确不支持

- 扫描件 OCR、手写文档、音视频和网页导入。
- 多语言混合卡包。
- 开放注册后自动接单的无审核 Agent 市场。
- 平台 Token、DAO、NFT、跨链结算和收益挖矿。
- 将原始 PDF、卡片正文或复习记录上传公开链或 IPFS。
- 让 LLM 的主观评分自动罚没 Agent 保证金。
- 多 Agent 自由协商、动态组队或无限返工。
- 长期学习效果 Oracle。首版只记录交付质量和短期复习完成事实。

### 2.3 首版默认参数

| 参数 | 默认值 | 约束 |
| --- | ---: | --- |
| 卡片数量 | 40 | 30～50 |
| 文档页数 | 100 | 不接受超限文件 |
| 文档大小 | 50 MB | 上传前后都检查 |
| 生成截止时间 | 10 分钟 | 用户可选择更长截止时间 |
| 模型抽检比例 | 30% | 按卡型和文档章节分层抽样 |
| 最大返工次数 | 1 次 | 第二次仍不合格则任务失败 |
| 尾款比例 | 10% | 审校通过先释放 90% |
| 尾款保留期 | 72 小时 | 从卡包交付时间开始 |
| 导师默认单价 | 0.008 USDC | Agent 可报价，前端展示后确认 |
| 导师通道默认上限 | 0.20 USDC | 用户可下调 |

## 3. 成功标准

### 3.1 功能验收

- 用户能通过 Passkey 创建或恢复智能账户，并向账户转入 USDC。
- 一次用户操作可完成 USDC 授权和任务托管，Gas 由平台代付。
- 真实 PDF 能经过解析、生成、审校、交付和结算完整流程。
- 所有卡片均能从引用定位到具体 PDF 页和文本块。
- 制卡与审校地址不同，且均来自平台审核的 Agent。
- 审校拒绝时可以完成一次返工；超时或最终失败时按规则退款。
- 交付后能进行 FSRS 复习、查看证据、报告错误和购买导师讲解。
- 导师连续调用只产生链下累计签名，Agent 最终用最新凭证领取一次。
- 卡包正文和 PDF 不上链，链上可以查到卡包 Merkle Root 和版本关系。

### 3.2 试点指标

这些指标用于判断是否继续投入，不作为单次任务的链上判定条件：

- 从托管成功到卡包可复习：P50 小于 10 分钟，P95 小于 20 分钟。
- 确定性引用检查通过率：100%。
- 人工复核引用准确率：至少 98%。
- 首次审校通过率：至少 80%。
- 任务退款率：低于 10%。
- 卡包交付后 24 小时内开始复习的用户比例：至少 50%。
- 开始复习的用户中完成三日复习的比例：至少 30%。
- 至少 10% 的活跃复习用户使用一次付费导师讲解。

## 4. 系统架构

```text
┌──────────────────────── Next.js PWA ────────────────────────┐
│ 登录/智能账户  上传与报价  任务进度  卡片复习  卡包溯源     │
└───────────────┬──────────────────────────┬───────────────────┘
                │ HTTPS                    │ UserOperation/EIP-712
                ▼                          ▼
┌──────────────────────── API/BFF ───────────────┐   ┌──────────────┐
│ Auth、任务、卡包、复习、报价、支付通道、争议   │   │ Monad RPC/AA │
└───────────────┬───────────────────────────────┘   └──────┬───────┘
                │ DB transaction + outbox                  │
                ▼                                          ▼
┌───────────┐  ┌────────────┐  ┌────────────────────────────────────┐
│PostgreSQL │  │Redis/BullMQ│  │ TaskEscrow / AgentRegistry         │
│+ pgvector │  │任务队列     │  │ DeckRegistry / TutorPaymentChannel │
└───────────┘  └──────┬─────┘  └────────────────────────────────────┘
                      │
              ┌───────▼────────┐
              │ Worker/编排器   │
              │解析、检索、状态 │
              └──┬──────┬──────┘
                 │      │ signed HTTP
         ┌───────▼──┐ ┌─▼───────────┐       ┌──────────────┐
         │制卡 Agent│ │独立审校 Agent│       │导师 Agent     │
         └──────────┘ └─────────────┘       └──────────────┘
                 │
          ┌──────▼──────────┐
          │加密对象存储/KMS  │
          │PDF、页块、卡包    │
          └─────────────────┘
```

### 4.1 链上职责

- 保管 USDC、释放款项和退款。
- 记录任务规范哈希、参与者、截止时间、交付哈希和审校结果。
- 记录 Agent 注册、保证金和由协议产生的客观统计。
- 记录卡包 Root、版本关系、Agent 身份、许可和收益分配。
- 验证累计支付凭证并只支付尚未领取的差额。
- 对超时未交付等链上可证明行为执行客观处理。

### 4.2 链下职责

- 保存和加密用户 PDF、结构化文本、卡片正文及复习记录。
- 解析文档、切块、向量检索、生成和审校编排。
- 执行引用定位、去重和模型质量判断。
- 维护报价索引、展示统计和任务实时进度。
- 收集用户错误报告并对主观争议进行人工处理。

链下审校结论由已分配的审校 Agent 签名，编排器提交链上。MVP 信任模型是“平台审核 Agent + 公开链上结算”，不是完全无许可、无信任的质量 Oracle。

## 5. 推荐仓库结构

```text
recalla/
├── apps/
│   ├── web/                     # Next.js PWA、Route Handlers、BFF
│   └── worker/                  # BullMQ consumers、任务编排、链上同步
├── services/
│   ├── generator-agent/         # 首批平台制卡 Agent
│   ├── verifier-agent/          # 独立审校 Agent
│   └── tutor-agent/             # 按次讲解 Agent
├── packages/
│   ├── domain/                  # 领域类型、状态机、Zod schema
│   ├── db/                      # Drizzle schema、迁移和 repository
│   ├── agent-protocol/          # JCS 哈希、签名、Agent HTTP client
│   ├── chain/                   # viem clients、ABI、事件索引
│   ├── learning/                # FSRS 与复习用例
│   ├── storage/                 # 对象存储、加密和短期访问 URL
│   └── ui/                      # 共享界面组件
├── contracts/                   # Foundry 项目
├── infra/                       # Docker Compose、部署和监控配置
└── docs/
    └── MVP_IMPLEMENTATION.md
```

建议使用 `pnpm` workspace + Turborepo。TypeScript 开启 `strict`；跨进程数据必须先通过 Zod schema 验证，不能只依赖 TypeScript 类型。

## 6. 技术选型

| 能力 | MVP 选择 | 说明 |
| --- | --- | --- |
| Web/PWA | Next.js App Router + React + TypeScript | 服务端渲染任务列表，复习页客户端交互 |
| UI | Tailwind CSS + 项目内组件库 + Lucide | 移动端优先，避免引入重型设计系统 |
| 数据库 | PostgreSQL 16 + pgvector | 业务数据、引用块、向量和审计事件 |
| ORM | Drizzle ORM | 类型明确，迁移文件进入版本库 |
| 队列 | Redis + BullMQ | 可重试、延迟任务、并发限制 |
| 对象存储 | S3 兼容存储 + KMS | 私有 Bucket、服务端加密、短期签名 URL |
| PDF 解析 | `pdfjs-dist` worker | 保留页码、文本块和坐标；首版无 OCR |
| FSRS | `ts-fsrs` | 固定版本并用测试锁定调度行为 |
| Agent 模型供应商 | generator/tutor 使用 OpenAI；verifier 使用 Anthropic | 具体模型 ID 由评测后写入发布 manifest |
| 合约 | Solidity + OpenZeppelin + Foundry | 单元、模糊和不变量测试 |
| 链交互 | viem + wagmi | 前端和 worker 共用 ABI 类型 |
| 智能账户 | ZeroDev Kernel + Passkey validator | 使用 permissions/session key；钱包作为恢复 owner |
| Bundler/Paymaster | ZeroDev 主服务 + Pimlico 备用验证 | 通过 Adapter 隔离，仅赞助白名单调用 |
| 网络 | Monad Testnet | 使用官方 Testnet USDC 跑通完整协议 |
| 可观测性 | OpenTelemetry + Sentry + 结构化日志 | 统一 `requestId`、`taskId`、`txHash` |

智能账户供应商必须封装为 `SmartAccountAdapter`，至少暴露 `getAddress`、`sendUserOperation`、`signTypedData`、`createSession` 和 `revokeSession`。这样供应商变化不会进入任务和学习领域代码。

## 7. 领域模型

### 7.1 核心实体

| 实体 | 说明 |
| --- | --- |
| `User` | 平台用户，不直接保存 Passkey 私钥 |
| `SmartAccount` | 用户在 Monad 上的 ERC-4337 账户 |
| `SourceDocument` | 加密 PDF 及解析状态 |
| `SourceManifest` | 文档哈希、页数、页块哈希和解析版本 |
| `StudyTask` | 用户需求、预算、截止时间和完整状态机 |
| `Agent` | 已审核服务身份、钱包、能力、端点和统计 |
| `AgentQuote` | 价格、预计时长、保证金和有效期 |
| `Deck` | 可复习卡包及版本元数据 |
| `Card` | 概念、问答或单选卡及引用 |
| `VerificationRun` | 确定性结果、抽检样本、错误和结论 |
| `ReviewState` | FSRS 调度状态和最近复习时间 |
| `ReviewLog` | 一次不可变的复习反馈事件 |
| `TutorChannel` | 用户与导师 Agent 的预付累计付款通道 |
| `TutorInteraction` | 一次导师请求、响应和累计金额 |
| `Dispute` | 用户错误报告或尾款争议 |

### 7.2 ID 与金额约定

- 数据库主键使用 UUIDv7，便于按创建时间排序。
- 发给链上的 `taskId` 为 `keccak256(utf8(uuid))`，数据库同时保存原始 UUID 和 `bytes32`。
- USDC 使用 6 位小数，数据库和代码统一使用最小单位的 `bigint`，禁止浮点计算。
- 时间在接口中使用 ISO 8601 UTC；签名和链上使用 Unix 秒。
- 内容哈希统一使用 Keccak-256，JSON 先经过 RFC 8785 JCS 规范化。
- 文件原始哈希额外保存 SHA-256，用于对象完整性检查；不能与链上内容哈希混用。

## 8. 数据模型

下表列出必须字段，迁移实现时可以补充时间戳和审计字段。

### 8.1 用户与账户

```text
users
  id uuid pk
  locale text
  status text

smart_accounts
  id uuid pk
  user_id uuid fk unique
  chain_id integer
  address bytea
  provider text
  created_tx_hash bytea null

spending_policies
  id uuid pk
  smart_account_id uuid fk
  agent_id uuid null
  per_call_limit_usdc bigint
  daily_limit_usdc bigint
  valid_until timestamptz
  session_key_address bytea null
  revoked_at timestamptz null
```

### 8.2 文档与引用块

```text
source_documents
  id uuid pk
  user_id uuid fk
  object_key text unique
  original_filename text
  mime_type text
  size_bytes bigint
  sha256 bytea
  page_count integer null
  status text
  encryption_key_ref text
  deleted_at timestamptz null

source_pages
  id uuid pk
  document_id uuid fk
  page_number integer
  normalized_text text
  page_hash bytea
  unique(document_id, page_number)

source_blocks
  id uuid pk
  page_id uuid fk
  block_index integer
  text text
  normalized_text text
  bbox jsonb
  block_hash bytea
  embedding vector
  unique(page_id, block_index)

source_manifests
  id uuid pk
  document_id uuid fk
  parser_version text
  canonical_json jsonb
  manifest_hash bytea unique
```

`bbox` 格式固定为 `{ x, y, width, height }`，数值归一化到 0～1。页面从 1 开始编号，任何 API 都不得使用从 0 开始的页码。

### 8.3 任务与报价

```text
study_tasks
  id uuid pk
  chain_task_id bytea unique
  user_id uuid fk
  source_manifest_id uuid fk
  learning_goal text
  card_count integer
  difficulty text
  language text
  deadline timestamptz
  max_payment_usdc bigint
  generator_agent_id uuid null
  verifier_agent_id uuid null
  status text
  revision_count integer default 0
  escrow_tx_hash bytea null
  onchain_status text null
  version integer default 0

agent_quotes
  id uuid pk
  task_id uuid fk
  agent_id uuid fk
  role text
  price_usdc bigint
  estimated_seconds integer
  stake_usdc bigint
  expires_at timestamptz
  signed_quote jsonb
  quote_hash bytea unique

task_events
  id uuid pk
  task_id uuid fk
  sequence bigint
  type text
  payload jsonb
  actor_type text
  actor_id text
  created_at timestamptz
  unique(task_id, sequence)
```

任务写操作使用乐观锁：更新时必须带当前 `version`。任务事件只追加、不修改，用于进度页、审计和故障恢复。

### 8.4 卡包、卡片与审校

```text
decks
  id uuid pk
  task_id uuid fk unique
  parent_deck_id uuid null
  version integer
  title text
  manifest_json jsonb
  manifest_hash bytea unique
  deck_root bytea unique
  object_key text
  status text
  registered_tx_hash bytea null

cards
  id uuid pk
  deck_id uuid fk
  ordinal integer
  type text
  front jsonb
  back jsonb
  content_hash bytea
  unique(deck_id, ordinal)

card_citations
  id uuid pk
  card_id uuid fk
  page_number integer
  block_start_id uuid fk
  block_end_id uuid fk
  quote text
  quote_hash bytea

verification_runs
  id uuid pk
  task_id uuid fk
  deck_id uuid fk
  verifier_agent_id uuid fk
  attempt integer
  deterministic_result jsonb
  model_result jsonb
  verdict text
  signed_result jsonb
  result_hash bytea unique
```

### 8.5 复习、导师与争议

```text
review_states
  user_id uuid fk
  card_id uuid fk
  due_at timestamptz
  stability double precision
  difficulty double precision
  elapsed_days integer
  scheduled_days integer
  reps integer
  lapses integer
  state integer
  last_review_at timestamptz null
  primary key(user_id, card_id)

review_logs
  id uuid pk
  user_id uuid fk
  card_id uuid fk
  rating integer
  reviewed_at timestamptz
  previous_state jsonb
  next_state jsonb

tutor_channels
  id uuid pk
  channel_id bytea unique
  user_id uuid fk
  tutor_agent_id uuid fk
  chain_id integer
  deposit_usdc bigint
  cumulative_signed_usdc bigint
  cumulative_claimed_usdc bigint
  channel_nonce bigint
  expires_at timestamptz
  status text
  open_tx_hash bytea

tutor_interactions
  id uuid pk
  channel_id uuid fk
  card_id uuid fk
  request_json jsonb
  response_json jsonb
  price_usdc bigint
  cumulative_amount_usdc bigint
  voucher_json jsonb
  request_hash bytea unique

disputes
  id uuid pk
  task_id uuid fk
  card_id uuid null
  user_id uuid fk
  category text
  description text
  evidence_object_key text null
  evidence_hash bytea null
  status text
  resolution text null
```

## 9. 任务状态机

```text
DRAFT
  → QUOTING
  → AWAITING_FUNDING
  → FUNDED
  → PARSING
  → GENERATING
  → VERIFYING
      ├─→ REVISION → GENERATING → VERIFYING
      ├─→ FAILED → REFUNDING → REFUNDED
      └─→ VERIFIED
  → DELIVERED
  → REVIEW_HOLD
      ├─→ DISPUTED → RESOLVED
      └─→ SETTLED
```

### 9.1 状态规则

- `DRAFT`：只存在本地草稿，未联系 Agent。
- `QUOTING`：解析了 PDF 基本信息，正在收集有效报价。
- `AWAITING_FUNDING`：已选中制卡和审校 Agent，等待托管。
- `FUNDED`：链上事件达到确认数后进入，不以浏览器交易回执为准。
- `PARSING`：完成逐页文本与块定位；解析失败全额退款。
- `GENERATING`：制卡 Agent 已接受签名任务。
- `VERIFYING`：确定性检查通过后才调用审校 Agent。
- `REVISION`：允许一次，必须携带结构化错误列表，不增加用户预算。
- `VERIFIED`：审校 Agent 已签名通过，交付物哈希已提交链上。
- `DELIVERED`：卡包可复习，`DeckRegistry` 注册成功。
- `REVIEW_HOLD`：首期 90% 已释放，10% 等待三日复习、争议或超时。
- `DISPUTED`：只暂停尚未释放的 10%，已经支付的 90% 不追回。
- `SETTLED`：所有任务资金已完成分配。

任何 BullMQ job 都不能直接“设置任意目标状态”，必须调用领域包中的状态迁移函数。状态迁移与 outbox 写入在同一数据库事务中完成。

### 9.2 幂等与重试

- 每个 job 使用 `{taskId}:{jobType}:{attempt}` 作为稳定 `jobId`。
- Agent 请求携带 `Idempotency-Key`，同一任务与尝试必须返回相同结果。
- 链上提交使用业务键检查数据库和合约状态后再发送，不能仅按交易哈希判断。
- 网络错误指数退避重试；模型内容错误不得作为网络错误自动无限重试。
- 每类任务设置死信队列，人工恢复操作必须写入 `task_events`。

## 10. PDF 解析与 Source Manifest

### 10.1 上传流程

1. Web 请求一次性上传 URL，服务端校验用户配额。
2. 浏览器直传私有对象存储，Content-Type 只能为 `application/pdf`。
3. 上传完成后 worker 重新检查 MIME magic bytes、文件大小和 SHA-256。
4. 使用沙箱进程解析 PDF，限制 CPU、内存、执行时间和输出大小。
5. 检查页数小于等于 100，并计算每页有效字符密度。
6. 如果超过 20% 页面没有可提取文本，判定为扫描件并明确提示首版不支持。
7. 提取页面文本块、顺序和坐标，执行 Unicode NFC、空白合并和断词修复。
8. 生成页级和块级哈希、向量，并构造 `SourceManifest`。

### 10.2 Source Manifest 示例

```json
{
  "schemaVersion": "1.0",
  "documentSha256": "0x...",
  "pageCount": 42,
  "language": "zh-CN",
  "parser": {
    "name": "recalla-pdfjs",
    "version": "0.1.0"
  },
  "pages": [
    {
      "pageNumber": 1,
      "pageHash": "0x...",
      "blocks": [
        { "blockId": "blk_...", "blockHash": "0x..." }
      ]
    }
  ]
}
```

Manifest 不包含对象存储地址和用户身份。`sourceManifestHash` 是 JCS 规范化后 JSON 的 Keccak-256。

### 10.3 切块策略

- 块必须保留页面边界；跨页段落拆成两个可分别引用的块。
- 检索 chunk 目标为 800～1200 tokens，重叠不超过 150 tokens。
- 标题和所在章节作为 chunk 元数据，不修改原文 quote。
- Agent 获得结构化 chunk 和短期读取授权，默认不获得原始 PDF 下载地址。
- 外部 Agent 的读取授权与任务绑定，最长有效 30 分钟，并记录访问审计。

## 11. 卡片与卡包格式

### 11.1 卡片 schema

```json
{
  "id": "card_01J...",
  "type": "qa",
  "front": {
    "question": "什么是重入攻击？"
  },
  "back": {
    "answer": "外部调用在原函数状态更新前再次进入该函数的攻击方式。",
    "explanation": "关键风险来自控制权转移与状态更新顺序。"
  },
  "citations": [
    {
      "pageNumber": 12,
      "blockStartRef": "p12:b0",
      "blockEndRef": "p12:b0",
      "quote": "...",
      "quoteHash": "0x..."
    }
  ],
  "tags": ["安全", "重入"],
  "difficulty": "medium"
}
```

卡型约束：

- `concept`：`front.term`、`back.definition`、可选 `back.example`。
- `qa`：`front.question`、`back.answer`、可选 `back.explanation`。
- `multiple_choice`：题干、恰好 4 个选项、唯一正确选项、答案解释。
- 所有卡型都必须包含至少一个 citation；单个引用不得超过 600 个 Unicode 字符。
- 问题不能依赖“上文”“如下图”等脱离卡片上下文后失效的指代。
- 答案必须能由引用直接支持，不得把模型常识伪装成文档事实。

### 11.2 内容哈希和 Deck Root

1. 去除 UI 状态、数据库 ID、生成时间等非内容字段。
2. 按固定 schema 生成 canonical card JSON。
3. 每张卡计算 `cardHash = keccak256(JCS(card))`。
4. 按 `ordinal` 排序，构造带位置的叶子：`keccak256(ordinal || cardHash)`。
5. 使用排序固定、奇数叶复制末项的 Merkle 算法计算 `deckRoot`。
6. 算法版本写入 Deck Manifest，避免以后升级产生无法解释的 Root 差异。

### 11.3 Deck Manifest

```json
{
  "schemaVersion": "1.0",
  "deckId": "deck_01J...",
  "version": 1,
  "parentDeckRoot": null,
  "sourceManifestHash": "0x...",
  "deckRoot": "0x...",
  "cardCount": 40,
  "language": "zh-CN",
  "generatorAgent": "0x...",
  "verifierAgent": "0x...",
  "verificationResultHash": "0x...",
  "license": "private-personal-use",
  "revenueSplit": [
    { "recipient": "0xGenerator", "bps": 6500 },
    { "recipient": "0xVerifier", "bps": 2000 },
    { "recipient": "0xProtocol", "bps": 1500 }
  ],
  "merkleAlgorithm": "recalla-merkle-v1"
}
```

## 12. Agent 协议

### 12.1 身份与独立性

- Agent 使用登记在 `AgentRegistry` 的钱包签署报价、接单、交付和审校结果。
- 同一钱包地址不能同时担任一个任务的 generator 与 verifier。
- 地址不同不等于审校独立。最终演示中的 generator/verifier 必须使用不同钱包、服务部署、Prompt 和模型提供商；链下仍记录 `operator_group_id` 供展示和后续路由使用。
- Agent 端点只通过 HTTPS 暴露，`AgentRegistry` 保存端点规范化后的哈希，实际 URL 保存在平台 Agent 目录中。

### 12.2 任务协议

```json
{
  "schemaVersion": "1.0",
  "taskId": "task_01J...",
  "chainTaskId": "0x...",
  "type": "deck_generation",
  "sourceManifestHash": "0x...",
  "requirements": {
    "learningGoal": "理解核心概念并准备考试",
    "cardCount": 40,
    "cardTypes": ["concept", "qa", "multiple_choice"],
    "difficulty": "medium",
    "citationRequired": true,
    "language": "zh-CN"
  },
  "deadline": 1780000000,
  "maxPayment": {
    "asset": "USDC",
    "amount": "800000",
    "chainId": 10143
  },
  "callbackUrl": "https://api.example.com/v1/agent-callbacks/task_01J...",
  "attempt": 1
}
```

金额字段传 USDC 最小单位字符串，不传 `"0.8 USDC"` 这种不可直接计算的展示文本。

### 12.3 Agent HTTP API

```text
POST /v1/quotes
  输入：任务摘要、requirements、deadline
  输出：签名报价、预计耗时、保证金和有效期

POST /v1/tasks
  输入：签名任务、Source Manifest 读取授权
  输出：accepted、agentTaskId

GET /v1/tasks/{agentTaskId}
  输出：状态和进度；仅用于 webhook 丢失后的恢复

POST callbackUrl
  输入：progress | delivery | verification_result | failure
  要求：Agent 签名、时间戳、nonce、Idempotency-Key
```

签名 envelope：

```json
{
  "payload": {},
  "payloadHash": "0x...",
  "signer": "0x...",
  "signature": "0x...",
  "issuedAt": 1780000000,
  "nonce": "0x..."
}
```

服务端必须重新规范化 `payload` 并计算哈希，验证签名地址、任务分配、时间窗口和 nonce。不能信任 Agent 自报的 `signer` 字段。

### 12.4 报价与选择

推荐分数只用于排序，不上链：

```text
score = 0.35 × 引用准确率
      + 0.20 × 按时完成率
      + 0.15 × (1 - 退款率)
      + 0.15 × 价格分
      + 0.10 × 预计耗时分
      + 0.05 × 保证金覆盖率
```

新 Agent 不显示虚假的 0% 统计，而标记为“样本不足”。自动选择必须遵守用户最大预算，并在托管前明确展示最终 Agent 和费用拆分。

## 13. 审校机制

### 13.1 第一层：全量确定性检查

所有卡片都执行：

- schema、字段、卡型和数量完整性。
- 页码在 `1..pageCount` 范围内。
- `blockStartRef` 和 `blockEndRef` 属于声明页，使用稳定 `pN:bN` 引用且顺序合法。
- 规范化后的 quote 能在引用块连续文本中精确定位。
- quote 哈希与保存内容一致。
- 单选题恰好一个正确答案且选项不重复。
- 卡片内容哈希和 Deck Root 可重复计算。
- 问题、答案的精确重复检查。
- 语义近重复检查：embedding cosine similarity 大于等于 0.92 时进入人工规则复判。
- 禁止空泛卡片、纯标题卡片和依赖缺失上下文的指代词模式。

任何引用定位、哈希或 schema 错误都直接退回制卡 Agent，不进入模型抽检。

### 13.2 第二层：独立模型抽检

- 抽检 30%，最少 10 张；卡片不足时仍抽 10 张。
- 按卡型、章节和难度分层，不能纯随机导致只检查文档开头。
- 审校 Agent 只能看到卡片、必要引用上下文和需求，不能看到生成 Agent 的推理过程。
- 每张样本检查：答案支持度、事实正确性、问题歧义、选项质量、学习价值。
- 输出 `pass`、`major_error` 或 `critical_error`，并使用固定错误代码。

错误代码至少包括：

```text
UNSUPPORTED_ANSWER
CONTRADICTED_BY_SOURCE
AMBIGUOUS_QUESTION
MULTIPLE_CORRECT_OPTIONS
MISSING_CONTEXT
LOW_LEARNING_VALUE
DUPLICATE_CARD
BROKEN_CITATION
```

整批退回条件：

- 任意一个 `critical_error`；或
- 抽样 `major_error` 比例超过 10%；或
- 确定性检查存在任意未修复错误。

允许一次返工。返工任务必须携带 card ID、错误代码和最小必要说明，审校 Agent 对修改卡全量复查，并重新抽取未修改卡样本。

### 13.3 第三层：用户争议

- 用户可在任意时间报告错误卡片；72 小时内提交会暂停 10% 尾款。
- 报告必须选择错误类型并可附说明，不能只提供主观星级。
- MVP 由平台审核员处理争议，决定释放尾款、部分退还尾款或退还全部尾款。
- 主观质量争议不罚没 Agent 保证金，只影响链下展示统计和后续审核。
- 已释放的 90% 不自动追回；这是限制争议成本和合约复杂度的明确取舍。

## 14. FSRS 复习

### 14.1 学习流程

1. 进入卡包时优先展示到期卡，其次展示未学习的新卡。
2. 首屏只显示问题；用户点击“显示答案”后才能评分。
3. 答案状态提供原文证据入口，点击后打开页码、quote 和上下文。
4. 用户选择忘记、困难、记得、简单，对应 FSRS rating 1～4。
5. 服务端根据当前 `ReviewState` 和 rating 计算下一状态，在一个事务中写 `ReviewLog` 和更新 `ReviewState`。
6. 同一客户端请求带 `reviewAttemptId`，重复提交只产生一个日志。

FSRS 参数在 MVP 期间全局固定并记录版本。以后调整参数不能重写历史 `ReviewLog`。

### 14.2 三日复习完成条件

“完成三日复习”是短期参与事实，不代表掌握程度。满足以下条件即可：

- 卡包交付后，在 3 个不同 UTC 日期产生有效复习记录；且
- 累计复习至少 `min(20, ceil(cardCount × 0.6))` 张不同卡片。

满足后平台 attestor 提交 `confirmReviewCompletion(taskId, evidenceHash)`，触发 10% 尾款释放。未满足且无争议时，72 小时到期后任何人都可以调用 `finalize` 自动释放尾款。

## 15. 页面与交互

### 15.1 学习主页 `/`

- 智能账户 USDC 可用余额、已托管余额和充值/取回入口。
- 正在处理的任务及当前阶段，使用事件流实时更新。
- 今日到期卡片数量和“开始复习”主操作。
- 最近卡包、进度和最近复习时间。
- 余额不足时只在相关操作附近提示，不使用全屏阻断。

### 15.2 创建任务 `/tasks/new`

- PDF 拖放/文件选择、页数和文件大小校验。
- 学习目的、卡片数量、难度、截止时间、最大预算。
- 上传后先显示解析可用性，再进入报价。
- 固定费用拆分：解析、制卡、审校、协议费、最大费用。
- 提交时保存草稿，刷新页面不丢失已上传文件和填写项。

### 15.3 Agent 报价 `/tasks/{taskId}/quotes`

- 至少两个制卡 Agent；审校 Agent 由系统从不同运营主体中匹配。
- 显示报价、历史任务数、引用准确率、退款率、预计完成时间和保证金。
- 默认选中综合性价比最高者，但用户可切换。
- 报价过期自动刷新；托管前锁定最终金额和参与者。

### 15.4 任务进度 `/tasks/{taskId}`

- 固定五阶段：解析、生成、审校、交付、结算。
- 展示当前说明、开始时间、耗时和返工原因。
- 链上区域展示网络、托管金额、交易哈希和区块浏览器链接。
- 浏览器只在首次托管时发起 UserOperation；后续由协议按状态执行，不逐笔要求用户签名。
- 失败状态明确展示退款金额、已产生费用和预计到账状态。

### 15.5 卡片复习 `/decks/{deckId}/review`

- 移动端一次一张卡，卡片容器尺寸稳定，长内容允许内部滚动。
- 先回答再显示答案；显示答案后出现四档评分按钮。
- “查看证据”打开底部抽屉，包含页码、原文和有限上下文。
- 导师按钮打开解释方式菜单：换种说法、举例、追问检验。
- 发起付费前显示本次价格和今日剩余导师预算。
- 错误报告不会打断当前复习队列。

### 15.6 卡包溯源 `/decks/{deckId}/provenance`

- 卡包版本、Deck Root、Manifest Hash 和父版本。
- 生成 Agent、审校 Agent、许可和收益分配。
- 链上注册交易与审校结果哈希。
- 不展示原始 PDF 地址、文件哈希反查入口或用户身份。

## 16. 应用 API

所有写接口要求登录、CSRF 防护和 `Idempotency-Key`。响应错误使用稳定 `code`，不让前端解析自然语言。

```text
POST   /api/uploads                         创建私有上传会话
POST   /api/uploads/{id}/complete           完成上传并排队检查

POST   /api/tasks                           创建任务草稿
GET    /api/tasks/{id}                      任务详情
POST   /api/tasks/{id}/quotes               收集/刷新报价
POST   /api/tasks/{id}/selection            选择制卡 Agent
POST   /api/tasks/{id}/fund-intent          返回托管 UserOperation 数据
GET    /api/tasks/{id}/events               SSE 任务事件
POST   /api/tasks/{id}/disputes             提交尾款争议

GET    /api/decks                           用户卡包列表
GET    /api/decks/{id}                      卡包与进度
GET    /api/decks/{id}/review/next          下一张到期卡
POST   /api/cards/{id}/reviews              提交 FSRS rating
POST   /api/cards/{id}/reports              报告错误
GET    /api/cards/{id}/citation-context     获取有限证据上下文

POST   /api/tutor/channels                   创建预付通道意图
POST   /api/tutor/interactions/quote         获取一次讲解报价
POST   /api/tutor/interactions               提交累计凭证并取得讲解
POST   /api/tutor/channels/{id}/close-intent 关闭并退回未使用余额

POST   /api/agent-callbacks/{taskId}         Agent 签名回调
```

资源权限必须从登录用户和数据库归属关系重新计算，不能以 URL 中的 user ID 或 Agent 回调参数作为授权依据。

## 17. 链上实现

### 17.1 部署组成

智能账户使用第三方审计过的 ERC-4337 实现，不在 MVP 自研。项目部署四个业务合约：

1. `TaskEscrow`
2. `AgentRegistry`
3. `DeckRegistry`
4. `TutorPaymentChannel`

所有合约部署在 Monad Testnet，chain ID 为 `10143`。使用 Circle Faucet 提供的官方 USDC `0x534b2f3A21130d7a60830c2Df862319e593943A3`。地址仍按环境变量注入，业务代码不得散落硬编码地址。部署脚本必须校验目标代币合约存在、`symbol()` 为 `USDC` 且 `decimals()` 为 6，并在每次重新部署前从 Monad 官方 x402 指南重新核验地址。

### 17.2 TaskEscrow

核心结构：

```solidity
struct Task {
    address user;
    address generator;
    address verifier;
    address token;
    bytes32 taskSpecHash;
    bytes32 sourceManifestHash;
    bytes32 deliveryManifestHash;
    bytes32 verificationResultHash;
    uint96 parserAmount;
    uint96 generatorAmount;
    uint96 verifierAmount;
    uint96 protocolAmount;
    uint48 deliveryDeadline;
    uint48 holdDeadline;
    TaskStatus status;
}
```

核心方法：

```solidity
createAndFundTask(TaskParams params)
commitSourceManifest(bytes32 taskId, bytes32 sourceManifestHash, bytes parserSig)
submitDelivery(bytes32 taskId, bytes32 deliveryManifestHash, bytes generatorSig)
submitVerification(bytes32 taskId, Verdict verdict, bytes32 resultHash, bytes verifierSig)
submitRevisionDelivery(bytes32 taskId, bytes32 deliveryManifestHash, bytes generatorSig)
raiseDispute(bytes32 taskId, bytes32 evidenceHash)
confirmReviewCompletion(bytes32 taskId, bytes32 evidenceHash)
resolveDispute(bytes32 taskId, Resolution resolution)
refundExpired(bytes32 taskId)
finalize(bytes32 taskId)
```

资金规则：

- 托管金额等于 parser、generator、verifier 和 protocol 四项之和，不能超过用户签署的最大预算。
- 托管时 `sourceManifestHash` 为零；完整解析完成后由 parser attestor 对任务、规范和 manifest 签名，并通过 `commitSourceManifest` 一次性写入。写入后不得替换。
- 审校通过后，各收款方先收到各自费用的 90%，剩余 10% 留在合约。
- 三日复习 attestation 或 72 小时无争议到期后释放剩余 10%。
- 解析失败：全额退款。
- generator 截止前未交付：generator 金额退款；未发生审校时 verifier 金额也退款；平台只在解析成功时获得明确展示的解析费。
- 审校最终拒绝：generator 金额退款，verifier 获得报价中包含的一次审校和一次复查费用，未使用部分退款。
- 争议最多影响尚未释放的 10%。

解析服务和协议可以使用同一个 treasury 收款地址，但 `parserAmount` 与 `protocolAmount` 必须在任务结构中分别保存，退款时不能依靠链下临时拆分。

重要事件：

```solidity
TaskFunded
SourceManifestCommitted
DeliverySubmitted
VerificationSubmitted
RevisionRequested
InitialPaymentReleased
DisputeRaised
TaskRefunded
TaskSettled
```

### 17.3 AgentRegistry

保存：钱包地址、metadata hash、endpoint hash、任务类型 bitmask、报价范围、USDC 保证金、完成/退款/争议计数和 active 状态。

```solidity
registerAgent(AgentProfile profile)
updateMetadata(bytes32 metadataHash, bytes32 endpointHash)
depositStake(uint256 amount)
requestStakeWithdrawal(uint256 amount)
executeStakeWithdrawal()
setAgentActive(bool active)
lockStake(address agent, bytes32 taskId, uint256 amount)
releaseStake(address agent, bytes32 taskId)
slashForTimeout(address agent, bytes32 taskId)
recordOutcome(bytes32 taskId, Outcome outcome)
```

- `lockStake`、`releaseStake`、`slashForTimeout` 和 `recordOutcome` 只允许 `TaskEscrow` 调用。
- 保证金提取有冷却期，已锁定部分不能提取。
- MVP 唯一自动罚没条件是链上任务到达截止时间仍无交付记录。
- “答案不好”“模型评分低”和普通用户举报只能影响审核状态或尾款，不能触发保证金罚没。
- 哈希不一致只有在合约能够同时验证 Agent 签名承诺与实际提交哈希时才可作为客观证据；否则留给人工争议处理。

### 17.4 DeckRegistry

```solidity
struct DeckRecord {
    bytes32 deckRoot;
    bytes32 parentDeckRoot;
    bytes32 manifestHash;
    address creator;
    address generatorAgent;
    address verifierAgent;
    bytes32 licenseHash;
    bytes32 revenueSplitHash;
    uint48 registeredAt;
}

registerDeck(DeckRecord record, RevenueRecipient[] recipients)
```

- 一个 `deckRoot` 只能注册一次。
- generator 与 verifier 地址必须不同且在 `AgentRegistry` 中有效。
- 收益分配 bps 总和必须为 10,000，收款方数量最多 5 个。
- `parentDeckRoot` 为零表示首版，否则父版本必须已注册。
- 仅协议 registrar 可以登记，且必须关联已通过审校的任务。
- 不保存 PDF 哈希、对象存储地址、卡片正文或用户复习信息。

### 17.5 TutorPaymentChannel

用户先预存一个小额上限，之后每次调用只签累计凭证：

```solidity
struct Channel {
    address payer;
    address payee;
    address token;
    uint96 deposit;
    uint96 claimed;
    uint64 nonce;
    uint64 lastSequence;
    uint48 expiresAt;
    bool closed;
}

openChannel(address payee, uint96 deposit, uint48 expiresAt)
claim(PaymentVoucher voucher, bytes payerSignature)
closeExpired(bytes32 channelId)
cooperativeClose(bytes32 channelId, uint96 finalAmount, bytes payeeSignature)
```

EIP-712 凭证：

```text
PaymentVoucher(
  bytes32 channelId,
  address payer,
  address payee,
  address token,
  uint256 chainId,
  uint64 channelNonce,
  uint96 cumulativeAmount,
  uint64 sequence,
  uint48 validUntil
)
```

领取规则：

- 验证智能账户 ERC-1271 签名、chain ID、合约 domain、付款方、收款方和有效期。
- `cumulativeAmount` 必须小于等于 deposit 且大于当前 claimed。
- `sequence` 必须大于通道保存的 `lastSequence`。
- 实际转账为 `cumulativeAmount - claimed`，然后同时更新 claimed 和 `lastSequence`。
- 旧凭证因累计金额不大于 claimed 无法重复领取。
- `channelNonce` 在新通道或关闭后递增，旧通道凭证不能跨通道使用。
- 合约先更新状态再转账，并使用重入保护。

调用示例：

```text
第 1 次：cumulativeAmount = 8,000
第 2 次：cumulativeAmount = 16,000
第 3 次：cumulativeAmount = 24,000
Agent 只提交第 3 份凭证，领取 24,000 个 USDC 最小单位。
```

## 18. 智能账户与 Gas 代付

- Passkey 是智能账户 owner validator，不将私钥传给应用服务端。
- 用户可添加普通钱包作为恢复 owner；恢复流程必须有冷却期和明确提示。
- 首次托管把 `approve(TaskEscrow)` 与 `createAndFundTask` 打包为一个 UserOperation。
- 导师通道把 approve 与 `openChannel` 打包；日常讲解只签 EIP-712 voucher。
- Paymaster 只赞助白名单 target、函数选择器、金额上限和已登录用户。
- session key 只能调用指定合约，包含单次、每日、Agent 和到期时间限制。
- 提取未锁定 USDC 必须由 owner Passkey 或恢复钱包确认，session key 无权提款。
- 后端的预算检查用于用户体验，链上 deposit 和 session policy 才是最终资金上限。

## 19. 费用与退款示例

预算展示：

```text
资料解析       0.10 USDC
制卡 Agent     0.65 USDC
审校 Agent     0.20 USDC
协议费用       0.05 USDC
最大费用       1.00 USDC
```

正常通过时：

- 审校通过后立即释放 0.90 USDC，按原费用比例分配。
- 三日复习完成或 72 小时到期后释放 0.10 USDC。

generator 超时且解析已完成、审校未开始时：

- 解析费用 0.10 USDC 可结算。
- generator 0.65、verifier 0.20 和协议费用 0.05 共 0.90 USDC 退回用户。
- generator 被记录一次超时，并按锁定保证金规则处理。

最终审校失败时，具体 verifier 费用必须在托管前展示并固定。MVP 建议审校报价包含一次初审和一次复查，完成两次检查后可领取其报价；generator 费用退回用户。

## 20. 队列与后台任务

| Queue | Job | 并发与重试 |
| --- | --- | --- |
| `document` | validate、parse、embed、manifest | 低并发；解析最多 2 次基础设施重试 |
| `quotes` | collect、expire | 每 Agent 独立超时，整体最多等待 15 秒 |
| `generation` | dispatch、poll-recovery、deadline | 按 Agent 限流，不自动重试内容失败 |
| `verification` | deterministic、dispatch、revision | 确定性检查本地执行，模型按预算限流 |
| `chain` | submit、confirm、reconcile | 等待配置确认数，replacement tx 可恢复 |
| `settlement` | release、refund、hold-expiry | 延迟 job + 定时链上扫描双保险 |
| `learning` | daily-due、completion-attestation | 按用户时区生成提醒，结算按 UTC 事实 |
| `retention` | delete-source、revoke-url | 每日执行并留下删除审计记录 |

所有业务状态都能从 PostgreSQL、不可变 task events 和链上事件重建。Redis 丢失不能导致资金或任务永久丢失。

## 21. 链上事件同步

- worker 保存每个网络最后确认的 block number 和 block hash。
- 事件达到配置确认数后才更新最终业务状态；前端可以先显示“确认中”。
- 同步器按 `(chainId, txHash, logIndex)` 去重。
- 检测短链重组时回滚未最终确认的派生状态，再重新消费事件。
- 每 5 分钟运行 reconciliation：比较 FUNDED/DELIVERED/SETTLED 本地状态与合约查询结果。
- 管理后台提供按 task ID 重放事件能力，但不能绕过领域状态机。

## 22. 隐私与安全

### 22.1 文档与数据

- 原始 PDF、解析块、卡包正文均使用私有 Bucket 和 KMS 服务端加密。
- 对象 key 使用随机 ID，不包含用户名、原文件名或文档标题。
- Agent 只获得完成任务所需的最小内容和短期授权。
- 日志禁止记录 PDF 文本、卡片答案、签名 URL、Passkey 数据和完整 Agent 响应。
- 默认在卡包交付 30 天后删除原始 PDF；用户可提前删除。删除前提示可能影响后续证据查看。
- 解析文本和卡包保留策略在隐私政策中单独说明。

### 22.2 上传与 Agent 隔离

- PDF 解析在无网络、非 root、资源受限的容器中运行。
- 验证文件 magic bytes，防止仅靠扩展名绕过。
- 解析器和依赖固定版本并接受恶意 PDF 回归样本测试。
- Agent 输出按 schema 限制深度、字符串长度、数组长度和总响应大小。
- 文档中的 prompt injection 视为不可信内容；系统提示明确禁止执行文档内指令。
- 外部 Agent 端点启用超时、并发限制、出站域名策略和响应签名验证。

### 22.3 合约安全

- 使用 `SafeERC20`、`ReentrancyGuard`、checks-effects-interactions。
- EIP-712 domain 包含 name、version、chainId 和 verifyingContract。
- 所有金额进入窄类型前检查范围，不使用浮点或字符串解析。
- 管理角色使用多签；部署者个人地址不保留测试网管理员权限。
- 紧急暂停只能阻止新任务和新通道，不能阻止用户退款或到期提款。
- 升级策略首版优先不可升级的小合约；如必须代理升级，使用 timelock 和明确事件。
- 最终演示前进行独立合约审阅，并设置协议总托管上限。

## 23. 可观测性与运营

### 23.1 统一关联字段

每条日志和 trace 尽可能包含：

```text
requestId
userId（内部 ID，不记录钱包之外的敏感身份）
taskId
agentId
agentTaskId
jobId
chainId
txHash
```

### 23.2 告警

- 任务在任一阶段超过该阶段 P95 两倍。
- Agent 回调签名连续失败或 endpoint 错误率超过阈值。
- 链上交易 pending 超过 3 分钟或 reconciliation 不一致。
- 托管余额与数据库待结算总额不一致。
- 引用确定性检查失败率突然升高。
- Paymaster 单用户、单函数或每日花费异常。
- Tutor claim 失败或凭证累计金额出现倒退。

### 23.3 管理后台最低能力

- 按 task ID 查询全量事件、Agent 请求和链上状态。
- 暂停 Agent 接单、调整展示审核状态。
- 重试安全的基础设施 job、重发 Agent 回调确认。
- 审理用户争议并生成链上 resolution 操作。
- 查看协议余额、待释放资金和即将到期任务。
- 管理操作全部写审计日志，不提供直接编辑任务状态的按钮。

## 24. 测试策略

### 24.1 领域与 API

- 状态机每条合法和非法迁移的单元测试。
- 金额拆分、四舍五入余数和退款组合测试。
- JCS 哈希、Merkle Root 和 Agent 签名跨语言测试向量。
- API 权限、幂等键、并发版本冲突和重复回调测试。
- FSRS 固定输入/输出 golden tests。

### 24.2 PDF 与 Agent

建立至少 20 份已授权中文 PDF 的 golden set，覆盖：

- 多栏排版、目录、页眉页脚、表格、公式和中英文混排。
- 空白页、重复页、不可提取文本和损坏文件。
- 正确引用、错误页码、quote 篡改、重复卡和歧义单选题。
- 文档内 prompt injection 和超长异常输出。

每次模型或 prompt 变更都运行离线评估，保存引用准确率、错误类型、成本和耗时。未达到当前基线不能发布。

### 24.3 合约

- Foundry 单元测试覆盖所有状态和权限分支。
- fuzz：金额、截止时间、累计 voucher、重复 claim、退款与结算顺序。
- invariant：合约持有 USDC 始终大于等于所有未结算负债。
- invariant：单任务累计支付与退款之和不超过托管金额。
- invariant：Tutor channel 累计领取不超过 deposit。
- invariant：同一 voucher 不能产生二次付款。
- fork test：Monad USDC 行为、ERC-1271 智能账户签名和实际 decimals。

### 24.4 端到端

Playwright 覆盖桌面和移动视口：

1. Passkey 测试账户登录。
2. 上传 PDF 并创建 40 卡任务。
3. 选择报价、发起托管并查看确认状态。
4. 模拟生成、一次审校返工和最终交付。
5. 复习卡片、查看证据并提交四档评分。
6. 打开 Tutor channel，连续三次签累计 voucher，只领取一次。
7. 查看卡包溯源并核对链上 Root。
8. 提交错误报告并确认尾款暂停。

## 25. 开发与部署环境

### 25.1 环境

```text
local        本地 Anvil、PostgreSQL、Redis、MinIO、mock Agent
test         Monad Testnet、官方 Testnet USDC、真实 Agent staging endpoint
```

环境变量按模块管理，至少包括：

```text
DATABASE_URL
REDIS_URL
OBJECT_STORAGE_ENDPOINT
OBJECT_STORAGE_BUCKET
KMS_KEY_ID
MONAD_RPC_URL
BUNDLER_URL
PAYMASTER_URL
CHAIN_ID
USDC_ADDRESS
TASK_ESCROW_ADDRESS
AGENT_REGISTRY_ADDRESS
DECK_REGISTRY_ADDRESS
TUTOR_PAYMENT_CHANNEL_ADDRESS
PROTOCOL_TREASURY_ADDRESS
ATTESTOR_SIGNER_ADDRESS
```

私钥、KMS 凭据和 Agent API secret 只进入 secrets manager，不写 `.env.example` 的真实值、不进入 CI 日志。

### 25.2 发布顺序

1. 本地 Anvil 跑通全部资金状态和 mock Agent 闭环。
2. Monad Testnet 部署合约，固定 ABI 和 EIP-712 测试向量。
3. 内部团队使用测试 PDF 完成 50 次端到端任务。
4. 对合约和 PDF/Agent 隔离做安全审阅，修复 P0/P1 问题。
5. 设置总托管上限和单任务 1 USDC 左右上限。
6. 使用 Circle Faucet 余额完成完整测试网演示。
7. 根据成功指标决定是否扩展 Agent 数量、语言或文档类型。

## 26. 分阶段实施计划

### 阶段 0：技术验证（3～5 天）

- 选择并验证 Passkey 智能账户、ERC-1271 和 Gas 代付组合。
- 在 Monad Testnet 完成 USDC approve、托管和退款。
- 用 3 份真实中文 PDF 验证页码、block、quote 精确定位。
- 固化 JCS、card hash、Deck Root 和 EIP-712 测试向量。

退出标准：四个最高风险接口各自有可运行 spike，无阻断性供应商限制。

### 阶段 1：链下学习闭环（1.5～2 周）

- 上传、解析、Source Manifest、制卡、确定性检查和审校 Agent。
- 任务状态机、BullMQ、任务进度页和加密对象存储。
- 卡包、卡片复习、证据查看和 FSRS。
- 使用 mock escrow 完成端到端测试。

退出标准：20 份 golden PDF 中至少 18 份能生成可复习卡包，引用确定性检查 100% 通过。

### 阶段 2：托管与溯源（1.5～2 周）

- `TaskEscrow`、`AgentRegistry`、`DeckRegistry` 合约与测试。
- 智能账户、Gas 赞助、链上事件索引和 reconciliation。
- 报价页、费用拆分、退款、90/10 结算和卡包溯源。

退出标准：Monad Testnet 连续 10 个任务无资金对账差异，所有失败路径可以退款或恢复。

### 阶段 3：导师累计微支付（约 1 周）

- `TutorPaymentChannel`、EIP-712 voucher 和 ERC-1271 验证。
- Tutor Agent 的报价、讲解响应、预算限制和批量领取。
- 重放、旧凭证、超额凭证、过期通道和关闭退款测试。

退出标准：连续多次讲解只需一次开通链上操作和一次 Agent claim，旧凭证无法重复领取。

### 阶段 4：Testnet 演示交付（约 1 周）

- 安全审阅、托管上限、监控、告警和运营后台。
- 官方 Testnet USDC 任务和争议演练。
- 收集交付时间、引用准确率、三日复习和导师使用指标。

退出标准：至少 5 名演示用户完成 10 个完整任务，资金账目完全一致，无未解决 P0/P1 问题。

## 27. Definition of Done

只有同时满足以下条件，MVP 才算完成：

- Monad Testnet 上至少一条官方 USDC 任务从托管走到最终结算。
- 用户无需在解析、生成、审校、交付和自动结算各阶段重复签名。
- 一份真实中文 PDF 在目标时间内产生 30～50 张可复习卡。
- 每张卡都能定位到未公开的原文页码和引用块。
- generator 与 verifier 身份独立，审校结果有签名和哈希。
- 审校拒绝、generator 超时、解析失败和用户争议都有确定结果。
- 卡片正文、PDF 和复习记录未写入公链或公共存储。
- FSRS 复习、三日完成判断和尾款释放真实工作。
- Tutor Agent 完成至少三次链下累计计费和一次链上领取。
- Deck Registry 能查询版本、Root、Agent 和收益分配。
- 自动化测试覆盖核心资金不变量，监控能发现卡住任务和资金对账差异。

## 28. 实施决策状态

阶段 0 的实现基线已记录在 [ADR 索引](./adr/README.md)：

1. [Monad 网络与官方 USDC](./adr/0001-monad-network-and-usdc.md)：Accepted。
2. [ZeroDev Kernel、Passkey、Bundler 与 Paymaster](./adr/0002-smart-account-provider.md)：Provisional，Step 1 Spike 通过后转为 Accepted。
3. [Agent 身份、模型供应商与资料边界](./adr/0003-agent-data-boundary.md)：Accepted。
4. [费用、退款、保证金与争议](./adr/0004-fees-refunds-and-disputes.md)：Accepted。
5. [文档和日志保留策略](./adr/0005-document-retention.md)：Accepted。
6. [合约角色、密钥与紧急管理](./adr/0006-contract-roles-and-administration.md)：Accepted。

`0002` 未通过前不进入正式智能账户集成。
