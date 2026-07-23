# Mindmark 一周黑客松实现步骤
pnpm --parallel \
  --filter @mindmark/web \
  --filter @mindmark/agent-runner \
  dev --hostname 0.0.0.0 --port 3000
> 版本：Implementation Steps v1.0  
> 周期：7 天  
> 前置规格：[HACKATHON_MVP_IMPLEMENTATION.md](./HACKATHON_MVP_IMPLEMENTATION.md)  
> 目标：从空仓库实现一个可公开演示的 AI 知识卡学习产品，并真实展示 Monad 的快速确认与并行友好状态设计。

## 1. 最终交付

七天结束时必须跑通下面这条链路：

```text
上传 PDF / 粘贴文本
→ 浏览器提取页面文本
→ Coordinator 建立 3 个语义分段和 Merkle 清单
→ User 在 Monad 创建 Journey
→ 3 个 Worker Agent 并行生成知识卡
→ 3 个 Worker 钱包分别 commitChunk
→ Finalizer 选择、去重并生成 4～30 张最终卡片
→ Coordinator finalizeDeck
→ 用户验证 cardsRoot / deckRoot
→ 用户逐张复习并提交四档评分
→ FSRS 更新到期时间
→ Learning Coach 必要时生成链下 Plan v2
```

P0 必须保留：

- 三个独立 Worker 上下文和三个独立 Monad 钱包。
- `JourneyCreated → ChunkCommitted × 3 → DeckFinalized`。
- `commitChunk` 写不同 `journeyId + chunkId`，不写共享计数器。
- 动态生成 4～30 张带逐字引用的知识卡。
- “验证卡组”功能，而不只是展示交易哈希。
- 单卡学习、四档评分和 FSRS。

时间不足时依次删除 Plan v2、PDF 上传和非核心动画；不能删除三 Worker、分段承诺、Deck Finalize 或卡组验证。

## 2. 实现原则

1. 先固定 Hash 与 Merkle 规范，再写合约、数据库和 Agent。
2. 用户只看到一个 Learning Coach；多 Worker 是内部执行机制。
3. Coordinator 负责任务分派、重试与合并，Monad 不调度 AI。
4. Supabase 保存完整业务数据，Monad 只保存 Hash、Root、数量和 Agent 地址。
5. Worker 先校验、保存结果，再发交易；RPC 失败不能导致重新生成卡片。
6. 所有任务、API 和交易重试必须幂等。
7. 页面只显示真实状态、receipt 和测量时间，不模拟进度或 TPS。

## 3. 推荐目录

```text
Mindmark/
├── apps/
│   ├── web/                    # Next.js Web、Route Handlers、钱包交互
│   └── agent-runner/           # Coordinator、Worker × 3、Finalizer
├── packages/
│   └── shared/                 # Zod schema、canonicalize、Hash、Merkle、类型
├── contracts/
│   ├── src/                    # LearningJourneyRegistry.sol
│   ├── test/                   # Foundry tests
│   └── script/                 # 部署与并发提交脚本
├── supabase/
│   └── migrations/             # 表、索引、RLS、清理函数
├── fixtures/
│   ├── reentrancy.pdf          # 演示资料
│   ├── reentrancy-pages.json   # 固定解析结果
│   └── hash-vectors.json       # 跨端 Hash golden vectors
└── docs/
```

只部署四个单元：Next.js、Agent Runner、Supabase、Monad 合约。不要引入 Redis、消息队列、向量数据库或微服务网关。

## 4. 环境与钱包

Web 公共变量：

```text
NEXT_PUBLIC_MONAD_RPC_URL
NEXT_PUBLIC_MONAD_CHAIN_ID
NEXT_PUBLIC_REGISTRY_ADDRESS
NEXT_PUBLIC_BLOCK_EXPLORER_URL
```

Web Server 私密变量：

```text
MONAD_RPC_URL
REGISTRY_ADDRESS
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SESSION_SECRET
```

Runner 私密变量：

```text
MONAD_RPC_URL
REGISTRY_ADDRESS
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
AI_API_KEY
AI_MODEL
COORDINATOR_PRIVATE_KEY
WORKER_0_PRIVATE_KEY
WORKER_1_PRIVATE_KEY
WORKER_2_PRIVATE_KEY
```

钱包职责：

| 钱包 | 行为 |
| --- | --- |
| User | `createJourney`、必要时 `cancelJourney` |
| Worker 0 | 为分配到的 chunk 调用 `commitChunk` |
| Worker 1 | 为分配到的 chunk 调用 `commitChunk` |
| Worker 2 | 为分配到的 chunk 调用 `commitChunk` |
| Coordinator | 全部分段确认后调用 `finalizeDeck` |

私钥只能进入 Runner 的部署 Secret，不能使用 `NEXT_PUBLIC_` 前缀、写入数据库、日志或浏览器包。

## 5. 状态机

数据库 Journey 状态：

```text
PREPARING
→ AWAITING_CREATE_TX
→ CREATED
→ GENERATING
→ FINALIZING
→ READY

任意生成阶段 → FAILED_RETRYABLE
创建后且 READY 前 → CANCELLED
```

数据库 Chunk 状态：

```text
QUEUED
→ GENERATING
→ VALIDATING
→ SAVED
→ SUBMITTING
→ CONFIRMED
→ MERGED

GENERATING / VALIDATING / SUBMITTING → RETRYABLE
```

链上 Journey 状态：

```text
NONE → CREATED → READY
          └→ CANCELLED
```

数据库状态用于恢复执行，链上状态用于公开验证。数据库不能仅凭前端回调标记链上成功，必须校验 receipt 或事件。

## 6. Step 0：固定演示资料与验收数据

### 实现

- 选择一份 6～10 页、文本可提取的 Solidity 重入攻击资料。
- 保存 PDF 和固定的逐页解析 JSON。
- 固定演示目标：“理解重入攻击原理、调用顺序和防御方式”。
- 人工列出 8～15 个应被覆盖的关键知识点，只用于验收，不作为固定制卡数量。
- 准备一份短文本和一份含错误页码/伪造引用的测试数据。

### 完成标准

- 同一 PDF 在演示浏览器中每次得到相同页面文本。
- 资料可以稳定拆成三个有意义的语义分段。
- 团队能人工判断生成卡是否遗漏核心攻击机制。

## 7. Step 1：初始化工程

### 实现

- 使用 pnpm workspace 初始化 `apps/web`、`apps/agent-runner` 和 `packages/shared`。
- Web 使用 Next.js App Router、TypeScript、Tailwind、Lucide、wagmi 和 viem。
- Runner 使用 TypeScript，提供独立的 `dev`、`test`、`start` 命令。
- 固定核心依赖版本：`zod`、`json-canonicalize`、`@openzeppelin/merkle-tree`、`@supabase/supabase-js`、`pdfjs-dist`、`siwe`、`ts-fsrs`、`viem` 和 `wagmi`。
- 初始化 Foundry 合约目录，引入 OpenZeppelin Contracts。
- 初始化 Supabase migrations。
- 根目录提供统一的 `lint`、`typecheck`、`test`、`build` 命令。

### 完成标准

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
forge test
```

以上命令在空功能状态下全部通过。

## 8. Step 2：共享 Schema、Hash 与 Merkle

这是第一条关键路径。合约、Web 和 Runner 开发前必须先完成。

### Schema

在 `packages/shared` 定义并导出：

- `KnowledgeCardSchema`
- `SourceChunkSchema`
- `ChunkResultSchema`
- `ReviewPlanSchema`
- `SessionSummarySchema`
- API request/response schema

禁止在 Web 和 Runner 中复制类型。

### Canonical Hash

- 使用同一个 JSON canonicalization 包处理页面、卡片和计划，例如 `json-canonicalize`。
- 使用 viem `keccak256` 对 UTF-8 canonical JSON 求 Hash。
- 卡片内容 Hash 不能包含 `id`、交易状态、生成耗时或 Merkle proof。
- `journeyId` 在 prepare 阶段生成，后续不得变化。

```text
sourceHash      = keccak256(canonical pages)
sourceChunkHash = keccak256(canonical chunk)
cardHash        = keccak256(canonical card)
cardId          = keccak256(abi.encode(journeyId, chunkId, cardHash))
initialPlanHash = keccak256(canonical initial plan)
```

### Merkle

使用 `@openzeppelin/merkle-tree` 的 `SimpleMerkleTree`，pair hashing 与 Solidity `MerkleProof` 保持一致。先按业务 ID 排序，再显式设置 `{ sortLeaves: false }`，避免库再次按 leaf hash 改变顺序：

```text
manifestLeaf      = keccak256(abi.encode(journeyId, chunkId, sourceChunkHash))
chunkManifestRoot = merkleRoot(manifestLeaf[] sorted by chunkId)

cardLeaf          = cardId
cardsRoot         = merkleRoot(cardLeaf[] sorted by cardId)
deckRoot          = merkleRoot(selected cardLeaf[] sorted by cardId)
```

Finalizer 为每张入选卡保存：

```ts
type CardProvenance = {
  chunkId: number;
  cardLeaf: `0x${string}`;
  chunkProof: `0x${string}`[];
};
```

这样可以删除未入选卡片，同时仍能证明最终卡片属于 Worker 提交的 `cardsRoot`。

### 测试

- 同一 `journeyId + input` 得到相同 Hash 和 Root。
- 任意卡片正文、引用或 `chunkId` 改变后 Root 改变。
- 每个 manifest proof 和 card proof 都能通过本地验证。
- 错误 proof 必须失败。
- 将固定输入与输出写入 `fixtures/hash-vectors.json`，供 Foundry 和 TypeScript 共用。

### 完成标准

TypeScript 与 Solidity 对同一 golden vector 得到完全相同的 manifest leaf、Root 和 proof 结果。

## 9. Step 3：实现 Monad 合约

### 合约

实现 `LearningJourneyRegistry.sol`：

```solidity
createJourney(
    bytes32 journeyId,
    bytes32 sourceHash,
    bytes32 goalHash,
    bytes32 chunkManifestRoot,
    uint16 chunkCount
)

commitChunk(
    bytes32 journeyId,
    uint16 chunkId,
    bytes32 sourceChunkHash,
    bytes32 cardsRoot,
    uint16 cardCount,
    bytes32[] calldata manifestProof
)

finalizeDeck(
    bytes32 journeyId,
    bytes32 deckRoot,
    bytes32 initialPlanHash,
    uint16 totalCardCount
)

cancelJourney(bytes32 journeyId)
```

### 必须遵守

- 构造函数固定一个 Coordinator 和三个 Worker 地址。
- `chunkCount` 只能为 2～4。
- `commitChunk` 由 allowlisted Worker 调用并记录真实 `msg.sender`。
- `commitChunk` 验证 manifest proof，同一 chunk 只能成功一次。
- `commitChunk` 只写 `chunks[journeyId][chunkId]`。
- 禁止 `committedCount++`、全局任务数组和 Session 数组。
- `finalizeDeck` 最多循环四个 chunk，确认全部存在后一次写入 Journey。
- Finalizer 卡片数量为 4～30，且不超过各 chunk 卡片数之和。
- 不加入支付、升级、管理员改地址和暂停逻辑。

### Foundry 测试

- 创建 Journey 成功；重复 ID、空 Hash、非法 chunk 数失败。
- 非 Worker、错误 proof、越界 chunk 和空 Root 提交失败。
- 三个 Worker 可提交三个不同 chunk，记录的 Agent 正确。
- 同一 chunk 重复提交失败。
- 少任意 chunk 时 finalize 失败。
- 非 Coordinator finalize 失败；重复 finalize 失败。
- 取消权限和状态转换正确。
- 通过 storage inspection 或代码审查确认三个 chunk 使用不同 mapping key。

### 完成标准

- `forge test` 全部通过。
- 合约部署到赛事指定 Monad 网络。
- 浏览器能查看合约、`JourneyCreated`、`ChunkCommitted` 和 `DeckFinalized`。

## 10. Step 4：Supabase 数据库

### `learning_journeys`

核心字段：

```text
id uuid primary key
journey_id bytes32 unique
learner_address text
source_hash text
goal_hash text
chunk_manifest_root text
chunk_count smallint
status text
deck jsonb
card_provenance jsonb
deck_root text
plan jsonb
plan_hash text
plan_version integer
fsrs_states jsonb
create_tx_hash text
finalize_tx_hash text
created_at / updated_at
```

### `source_chunks`

```text
journey_id + chunk_id composite primary key
page_start / page_end
source_text text
source_chunk_hash text
manifest_proof jsonb
card_budget smallint
worker_address text
attempt integer
status text
cards jsonb
cards_root text
card_count smallint
commit_tx_hash text
confirmed_block bigint
generation_ms / confirmation_ms
updated_at
```

### `review_logs`

- 唯一键为 `journey_id + session_id + card_id`。
- 保存 rating、response time 和 reviewed time。
- 插入后不修改，重复请求返回原结果。

### `agent_events`

- 保存 journey、chunk、Agent role、事件类型、脱敏 payload、tx hash 和时间。
- 禁止保存页面正文、完整 Prompt、模型隐藏推理和私钥。

### 权限与清理

- anon/authenticated Supabase 客户端默认不能直接读写这些表。
- Web Server 使用 service role，但每个 API 必须先校验钱包 session 和 Journey owner。
- 用户通过 API 只能读取自己的 Journey、Deck、Plan 和 ReviewLog。
- `source_chunks.source_text` 只允许 service role 读取。
- 客户端生成状态通过 API 返回脱敏视图，不能直接查询原文。
- Journey READY 后立即删除分段正文和未入选卡片草稿；异常任务最迟 24 小时清理。

### 完成标准

- RLS 测试证明浏览器 Supabase key 不能直接读取表，API 测试证明一个钱包不能读取另一钱包的数据。
- 重复 ReviewLog 和重复 chunk result 不产生第二条有效记录。
- 清理函数不会删除最终 Deck、引用、Root、入选卡片 provenance 或 proof。

## 11. Step 5：资料上传与创建 Journey

### Web

- 浏览器使用 `pdfjs-dist` 解析文本型 PDF，不上传原文件。
- 限制 10 页、5 MB、提取文本 20,000 字符。
- 显示页数和字符数；无文本时提示粘贴文本。
- 学习目标可选，不提供截止日期和每日学习时间输入。

### 钱包 Session

- 提供 `POST /api/auth/nonce` 和 `POST /api/auth/verify`。
- 使用 EIP-4361 格式签名，消息包含 domain、address、chain ID、nonce、签发和过期时间。
- nonce 只能使用一次，验证后签发短期、HttpOnly、SameSite=Lax Cookie；生产环境启用 Secure，本地开发关闭 Secure。
- 所有 Journey 和 Review API 都重新校验 session address；前端传入的 learner address 不能作为权限依据。
- 浏览器不直接查询 Supabase，生成状态使用受鉴权 API 轮询，避免一周内再实现一套 Supabase 钱包 JWT。

### `POST /api/journeys/prepare`

1. 校验页面文本和目标。
2. 生成随机非零 `journeyId`。
3. 按标题、页面、段落和长度确定性拆成 2～4 段。
4. 估算知识密度并分配合计不超过 30 的卡片预算。
5. 计算 source/chunk Hash、manifest leaves、Root 和 proofs。
6. 事务写入 Journey 与 chunks，状态为 `AWAITING_CREATE_TX`。
7. 返回 `createJourney` 所需参数，不返回已保存的其他分段原文。

### 钱包交易

1. User 调用 `createJourney`。
2. Web 保存 tx hash，但不直接宣称创建成功。
3. API 或 Runner 校验 receipt 中的合约地址、chain ID、事件和 learner。
4. 校验通过后将数据库状态改为 `CREATED`。

### 完成标准

上传演示 PDF 后，Monad 浏览器出现正确的 `JourneyCreated`，数据库包含三个带有效 proof 的 chunk。

## 12. Step 6：Coordinator 与事件恢复

### Runner 主循环

- 从合约部署区块开始监听 `JourneyCreated`，同时每 15～30 秒轮询数据库恢复漏掉的任务。
- 用 `journeyId` 做幂等键，同一事件重复到达不能再次创建任务。
- 读取三个 chunk，固定分配给三个 Worker。
- 使用 `Promise.allSettled` 启动 Worker，不使用 `Promise.all`。
- 单个 Worker 失败时保留其他结果，只重派失败 chunk。
- 全部 chunk 链上确认后只触发一次 Finalizer。

### 超时与重派

- `GENERATING` 超过 60 秒标记为 `RETRYABLE`。
- 同一 chunk 最多两次模型生成尝试。
- 重派前先读取链上 chunk；若已提交，按链上结果恢复数据库。
- 不确定交易是否成功时先查 receipt 和合约状态，禁止直接再生成卡片。

### 完成标准

停止 Runner、创建 Journey、再启动 Runner，任务仍能恢复并完成；重放同一事件不会生成重复卡片或交易。

## 13. Step 7：Worker Agent

每个 Worker 是同一套实现的独立实例，拥有独立任务上下文、workerId、日志标签和钱包。

Worker 使用 bounded tool-calling loop：最多 8 次工具调用、60 秒超时、最多一次内容修正。必须先读取被分配的 chunk，只有本地校验通过后才能调用提交工具。

### 工具

```text
read_assigned_chunk
save_chunk_draft
validate_chunk_cards
get_chunk_commitment
submit_chunk_commitment
```

`submit_chunk_commitment` 不接受模型自由填写的 Root、数量或 proof，而是按 `journeyId + chunkId` 读取已经校验并保存的数据库结果后组装交易。

### 执行流程

1. 只读取分配到的 chunk、页面范围、目标和卡片预算。
2. 建立局部 Knowledge Map。
3. 生成预算内的 `concept | qa` 原子卡片；模型不生成 `cardId`。
4. 本地 Zod 与引用校验失败时，向模型返回结构化错误并只修正一次。
5. 服务端计算 cardHash 和确定性 cardId，再生成 Merkle tree、`cardsRoot` 和 card proofs。
6. 在数据库事务中保存卡片与 Root，状态进入 `SAVED`。
7. 再次校验 `sourceChunkHash` 和 manifest proof。
8. 使用对应 Worker 钱包调用 `commitChunk`。
9. receipt 确认后记录区块、Gas、确认耗时和 `CONFIRMED` 状态。

### 卡片校验

- quote 必须是该页规范化文本的连续子串。
- 页码有效，quote 长度为 20～400 字符。
- 问题、答案、关键点非空。
- 一张卡只包含一个中心知识点。
- 卡片不依赖“根据上文”等缺失上下文。
- 分段内无精确重复。
- importance 与 initialDifficulty 为 1～5。

### 完成标准

演示 Journey 的三个 Worker 同时进入 `GENERATING`，随后由三个地址产生三个真实 `ChunkCommitted`，任意数据库卡片被修改后 Root 校验失败。

## 14. Step 8：Finalizer 与初始计划

### Finalizer

Finalizer 最多执行 6 次工具调用、30 秒超时和一次选择修正；它可以判断重复与覆盖，但不能修改 Worker 已承诺的卡片正文。

1. 从 Monad 读取每个 chunk 的 Agent、`cardsRoot` 和 cardCount。
2. 重新计算数据库 `cardsRoot`，任何不一致立即停止。
3. 合并局部 Knowledge Map，识别跨分段重复和前置关系。
4. 只选择或删除卡片，不改写已被 Worker 承诺的卡片正文。
5. 保留 4～30 张卡；不足 4 张则返回可重试错误。
6. 为每张入选卡保存其 `chunkId + cardLeaf + chunkProof`。
7. 计算最终 `deckRoot`。
8. 按重要度、难度和前置关系生成滚动 7 日初始计划。
9. 模拟未来负担，确保单次新卡不超过 8、总任务不超过 15。
10. 保存 Deck/Plan 后，由 Coordinator 调用 `finalizeDeck`。

### 完成标准

- 链上 `deckRoot` 与数据库最终 Deck 一致。
- 每张最终卡都能验证属于其 Worker 的 `cardsRoot`。
- `DeckFinalized` 确认前 UI 不显示“Monad 已验证”。

## 15. Step 9：并行生成页与“验证卡组”

### 生成页

每个 chunk 固定一行，展示：

```text
章节范围 | Worker 地址 | 状态 | 卡片数 | tx | 区块 | Gas | 确认耗时
```

状态来自数据库和链上 receipt：

```text
等待 → Agent 生成 → 引用校验 → Monad 提交 → 已确认 → 已合并
```

不得用定时器制造假百分比。使用轮询或 Supabase Realtime 更新真实阶段。

### 验证卡组

用户点击“验证卡组”后，浏览器：

1. 读取链上 Journey 和所有 ChunkCommitment。
2. 对每张最终卡重新计算 `cardHash` 和 `cardLeaf`。
3. 使用保存的 `chunkProof` 验证卡片属于对应 `cardsRoot`。
4. 重新计算 `deckRoot` 并与链上值比较。
5. 显示每个 chunk 的 Worker 地址、交易和匹配结果。
6. 用户重新选择原 PDF 时，可额外重新计算 `sourceHash`；没有原文件时不宣称验证了原资料正文。

结果只允许显示：

```text
全部匹配
部分不匹配
无法验证：缺少数据
```

不能把 Hash 匹配描述为“知识内容一定正确”。

### 完成标准

正常 Deck 全部匹配；手工修改一张卡后，该卡和最终 Deck 都显示不匹配。

## 16. Step 10：卡片学习、FSRS 与 Plan v2

### 今日队列

- FSRS 到期卡优先。
- 再按计划引入 3～8 张新卡。
- 单次总任务最多 15 张。
- 一次只显示一张卡，先显示问题，再显示答案和引用。

### Review API

1. 校验钱包 session、Journey ownership、cardId 和 rating。
2. 在事务中写入唯一 ReviewLog。
3. 使用固定版本与参数的 `ts-fsrs` 更新 card state。
4. 重复请求返回第一次结果，不重复更新 FSRS。
5. 会话结束后生成 Session Summary 和未来 7 日 due forecast。

### Learning Coach 重排

以下任一条件触发链下 Plan v2：

- 本次遗忘率大于等于 40%。
- importance 为 5 的卡片被评为“忘记”。
- 同一标签连续两个 Session 薄弱。
- 任一天到期卡超过 15。
- 每完成 3 个 Session 周期复盘。

Plan v2 只写 Supabase，不发 Monad 交易。生成失败时继续使用 FSRS 到期队列。

### 完成标准

- 四档评分正确映射 FSRS。
- 刷新后进度存在。
- 重复提交不产生重复 ReviewLog。
- 忘记重要卡后能看到合理的计划变化或明确的 FSRS 兜底。

## 17. Step 11：并发脚本、稳定性与部署

### 公平对照脚本

准备两种模式，每种至少运行 5 次：

```text
Mode A：同一 Worker 钱包预分配连续 nonce，同时广播三个 commitChunk
Mode B：三个 Worker 钱包使用各自 nonce，同时广播三个 commitChunk
```

每笔交易记录：

```text
runId
mode
sender
nonce
submittedAt
receiptAt
blockNumber
gasUsed
status
```

两种模式使用不同 Journey，其他 calldata 规模保持一致。Mode A 不能通过“等上一笔 receipt 后再发下一笔”人为变慢。报告展示原始数据、中位数和范围，不将三笔交易称为 TPS 测试，也不保证 Mode B 每次都更快。

### 错误状态

- PDF 无文本：切换粘贴文本或示例资料。
- AI 超时：只重派失败 chunk。
- RPC 失败：保留 SAVED 结果并重试交易。
- receipt 丢失：按 tx hash 和合约状态恢复。
- Runner 漏事件：按数据库 `CREATED/GENERATING` 状态 replay。
- Finalizer 失败：不开放学习，显示明确重试操作。
- Plan 失败：使用 FSRS 队列。

### 部署顺序

1. 创建生产 Supabase 项目并执行 migrations。
2. 生成 Coordinator 与三个 Worker 专用钱包并充值测试 Gas。
3. 部署合约，记录 chain ID、地址、部署区块和浏览器链接。
4. 配置 Runner secrets，启动并验证事件监听与轮询恢复。
5. 配置 Web 环境变量并部署。
6. 用生产 URL 跑五次完整流程。
7. 固定最终合约与前端版本，不再加入功能。

### 完成标准

- 公共 URL 连续三次完成上传到复习。
- 三 Worker 地址、合约和交易可在浏览器查看。
- 卡组验证能发现篡改。
- Runner 重启后任务可恢复。
- 原文清理、RLS、错误提示和备份演示项目可用。

## 18. 七天安排

| 日期 | 主任务 | 当日退出标准 |
| --- | --- | --- |
| Day 1 | Step 0～3：fixture、工程、Hash/Merkle、合约 | 三个地址能向三个独立 chunk 提交，golden vectors 一致 |
| Day 2 | Step 4～5：Supabase、PDF、prepare、createJourney | 上传后产生真实 `JourneyCreated` 和三个 chunk |
| Day 3 | Step 6～7：Coordinator、三个 Worker、commitChunk | 三个 Worker 并行生成并链上确认 |
| Day 4 | Step 8～9：Finalizer、初始计划、生成页、卡组验证 | `DeckFinalized` 后可验证并开始学习 |
| Day 5 | Step 10：卡片复习、FSRS、Plan v2 | 完成一次复习闭环，冻结 P0 |
| Day 6 | Step 11：错误恢复、部署、并发脚本、五次彩排 | 公共环境连续三次跑通 |
| Day 7 | 只修阻断问题、演示、视频、README | 三分钟演示稳定，准备历史项目与备份视频 |

## 19. 团队分工

四人团队：

| 角色 | 负责 |
| --- | --- |
| A | Shared Hash/Merkle、Solidity、部署、并发脚本 |
| B | Coordinator、Worker、Finalizer、Agent 工具与重试 |
| C | Supabase、API、钱包 session、FSRS 与数据恢复 |
| D | PDF、生成页、卡片学习、验证卡组与演示体验 |

两人团队：

- A：Shared、合约、Runner、部署。
- B：Web、Supabase、FSRS、验证与演示。
- Day 3 和 Day 6 共同完成端到端集成。

## 20. 最终检查清单

### AI

- [ ] 资料按语义拆分而非固定字符硬切。
- [ ] 三个 Worker 拥有独立上下文、钱包和任务日志。
- [ ] 卡片数量由知识密度决定，总数为 4～30。
- [ ] 所有卡片引用均可定位。
- [ ] Finalizer 不改写已承诺卡片。
- [ ] Learning Coach 的计划有 FSRS 兜底。

### Monad

- [ ] User、三个 Worker、Coordinator 地址不同。
- [ ] `commitChunk` 不写共享计数器。
- [ ] 三个 `ChunkCommitted` 与一个 `DeckFinalized` 可查。
- [ ] 页面展示真实区块、Gas 和确认耗时。
- [ ] 同钱包/三钱包脚本公平运行并保存原始数据。
- [ ] 不宣称 Monad 调度 Agent、加速推理或证明语义正确。

### 产品与数据

- [ ] 原始 PDF 不上传，临时分段正文按规则删除。
- [ ] 私钥、service role key 和模型 key 不进入前端。
- [ ] 用户不能读取其他人的学习项目。
- [ ] 重复 API、事件或交易重试不产生重复结果。
- [ ] “验证卡组”能通过，并能检测人工篡改。
- [ ] Monad 或 Agent 暂时失败时，已保存数据不会丢失。

### 交付

- [ ] `lint`、`typecheck`、Web/Runner tests、`build`、`forge test` 全部通过。
- [ ] README 包含公共 URL、合约地址、Agent 地址和已知限制。
- [ ] 完成至少五次端到端彩排。
- [ ] 准备一个明确标记的真实历史学习项目和无剪辑备份视频。
