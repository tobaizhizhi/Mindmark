# Mindmark Monad AI 学习 Agent 黑客松 MVP

> 版本：Hackathon Scope v2.2  
> 周期：7 天  
> 建议团队：2～4 人  
> 赛道：AI Agent × Monad  
> 原长期方案：[MVP_IMPLEMENTATION.md](./MVP_IMPLEMENTATION.md)
> 实现步骤：[HACKATHON_IMPLEMENTATION_STEPS.md](./HACKATHON_IMPLEMENTATION_STEPS.md)

## 1. 产品定义

### 一句话产品

Mindmark 把用户上传的学习资料拆成类似单词卡的知识卡片。一个面向用户的 AI Learning Coach 负责整个学习项目，内部 Worker Agent 并行处理不同资料分段；Monad 实时登记每批知识卡的来源、Agent 身份和内容承诺，Learning Coach 再根据知识结构和实际记忆反馈制定并调整复习计划。

### 核心体验

Mindmark 借鉴单词卡应用“一次学习一张卡”的体验，但扩展到任意知识领域：

- Solidity 文档变成概念、机制和安全要点卡。
- 课程讲义变成定义、因果关系和问答卡。
- 产品手册变成功能、流程和注意事项卡。
- 考试资料变成高频知识点和易错点卡。

用户不需要决定卡片数量、手工制卡或计算复习日期。AI Agent 负责把“资料”转化为结构合理、可以持续复习的学习任务。

本文在产品文案中统一使用“学习项目”；代码和合约内部使用 `LearningJourney`、`journeyId`，一次复习使用 `ReviewSession`。用户只看到一个 Learning Coach；Coordinator、Worker 和 Finalizer 是内部执行角色，不做 Agent 市场或多角色聊天界面。

## 2. 核心流程

```text
上传 PDF / 粘贴文本
        ↓
可选填写学习目标
        ↓
浏览器解析资料，Coordinator 建立 2～4 个语义分段
        ↓
用户在 Monad 创建学习项目，登记 sourceHash + chunkManifestRoot
        ↓
3 个 Worker Agent 并行处理不同分段
        ↓
各 Worker 用独立钱包提交 sourceChunkHash + cardsRoot
        ↓
Coordinator 验证引用、去重并合并 4～30 张卡
        ↓
Finalizer 提交最终 deckRoot + initialPlanHash
        ↓
用户按今日计划逐张复习并选择四档评分
        ↓
FSRS 更新单卡记忆状态
        ↓
Learning Coach 达到触发条件时在链下生成 Plan v2
```

链上服务失败不能丢失已经生成的卡片或复习记录。Worker 结果先保存到 Supabase，链上提交可以幂等重试；未确认前明确显示“等待 Monad 验证”，不能伪装成已验证。

## 3. 项目亮点

### 3.1 一个 Learning Coach，内部并行 Agent

MVP 对用户只提供一个持久化的 `Learning Coach`，内部由固定、受控的 Agent 组成：

- `Coordinator Agent`：监听 `JourneyCreated`，读取分段清单，分派任务和跟踪重试。
- `Worker Agent × 3`：各自拥有独立上下文、分段任务和 Monad 钱包，并行提取知识点、生成卡片、验证引用和提交分段承诺。
- `Finalizer`：由 Coordinator 执行最终工具步骤，读取全部分段，检查覆盖率、跨分段重复和总卡片数，生成初始计划并提交最终 Deck。
- `Learning Coach`：卡组完成后持续读取 FSRS 汇总，必要时调整链下复习计划。

Worker 可以使用相同模型和同一套工具，但必须拥有独立任务上下文、钱包和执行日志。它们不是通过换 Prompt 伪装出的角色，也不互相聊天；Coordinator 只负责明确的分派、状态机、超时和一次重试。

每个 Agent 都在最大步骤、超时和模型预算内运行。页面只展示任务状态、结构化结果和交易，不展示或保存模型隐藏推理。

### 3.2 AI 与 FSRS 分工

AI Agent 负责：

- 判断哪些知识点值得制卡。
- 识别重要度、难度、标签和前置关系。
- 安排知识顺序、新卡量、重点标签和学习负担。
- 根据遗忘情况调整未来计划。

`ts-fsrs` 负责：

- 根据四档评分更新单张卡的记忆状态。
- 计算单张卡的下次到期时间。
- 保证间隔调度可重复测试。

不让 LLM 随意发明复习间隔，也不自行实现记忆算法。

### 3.3 动态知识建模

Agent 不接受“必须生成 N 张”的业务配额，而是先判断资料中有多少知识值得成为卡片：

1. 建立章节、主题、概念和前置关系组成的 Knowledge Map。
2. 将能独立提问、独立回答的叶子节点作为候选卡片。
3. 拆分包含多个中心概念的候选项，合并语义重复项。
4. 为候选项评估重要度、初始难度和资料覆盖价值。
5. 正常输出 4～30 张卡；少于 4 个有效知识点时提示资料过短。
6. 超过 30 个候选项时按重要度、章节覆盖和前置关系裁剪，不生成低价值填充卡。

最终卡片数、裁剪原因和章节覆盖率写入 Agent Trace，用户可以理解 AI 如何拆解资料。

### 3.4 Monad 是并行 Agent 输出的实时可信状态层

一个学习项目的核心链上过程为：

```text
JourneyCreated       User 钱包       sourceHash + chunkManifestRoot
ChunkCommitted #0    Worker A 钱包   sourceChunkHash + cardsRoot
ChunkCommitted #1    Worker B 钱包   sourceChunkHash + cardsRoot
ChunkCommitted #2    Worker C 钱包   sourceChunkHash + cardsRoot
DeckFinalized        Coordinator     deckRoot + initialPlanHash
```

这里突出 Monad 的两个能力：

1. **快速确认进入真实产品流程**：每个 Worker 完成后立即提交，前端监听 receipt 和事件，逐行显示 Agent 地址、卡片数、区块、Gas 和实际确认耗时。用户不必等整个 Deck 完成才看到结果。
2. **独立状态的并行提交**：Worker 使用不同钱包，分别写入 `chunks[journeyId][chunkId]`。`commitChunk` 不更新全局数组、共享计数器或 Journey 内的完成数量，因此不同分段之间没有写冲突，也不受同一 EOA nonce 串行化限制。

| Monad 官方能力 | Mindmark 中的对应设计 | 演示证据 |
| --- | --- | --- |
| 400ms 区块频率、约 800ms 完整最终确认 | Worker 结果确认直接驱动分段状态更新 | 记录广播、上块、最终确认三个时间点 |
| 10,000 TPS 的官方性能定位 | 大量用户和 Worker 产生常数大小的分段承诺 | 作为扩展依据，P0 不宣称测出最大 TPS |
| Optimistic Parallel Execution | 不同 EOA 写不同 `journeyId + chunkId`，构造无写冲突工作集 | 三个 Worker 同时广播并展示独立状态 |
| EVM 与 Ethereum RPC 兼容 | Solidity、Foundry、viem、wagmi 直接使用 | 已验证合约、交易与浏览器链接 |

以上架构指标来自 Monad 官方的 [开发者介绍](https://docs.monad.xyz/introduction/monad-for-developers)和[并行执行文档](https://docs.monad.xyz/monad-arch/execution/parallel-execution)；实际演示仍以赛事指定网络的测量结果为准。

Coordinator 负责任务拆分、调度、超时、重试和结果合并；Monad 不负责运行或调度 AI。Monad 负责公开登记“哪个 Agent 在何时提交了哪一批结果”，提供顺序、身份和不可篡改的内容承诺。

链上承诺能够证明数据库展示的资料分段和卡片与已提交哈希一致，但不能证明知识卡在语义上一定正确。卡片质量仍由逐字引用校验、跨分段去重和 Finalizer 检查保证。P0 的 Worker 均由项目方运行，因此链上价值是公开来源与版本记录，不宣称已经获得第三方去中心化信任。

应用提供实时 Monad 验证面板：

- 每个分段分别展示 `生成中 → 提交中 → 已确认 → 已合并`。
- 展示 Worker 地址、交易哈希、区块、Gas、卡片数量和实际确认耗时。
- 分开统计 Agent 推理、RPC 广播和链上确认耗时。
- Day 6 对照同一钱包预分配连续 nonce 后同时广播，与三个钱包各自 nonce 同时广播；记录数据但不预设谁一定更快。

演示结果只说明本项目交易在当时网络环境下的表现，不包装成 Monad 最大 TPS 基准，也不声称 AI 推理因上链而变快。

## 4. 一周 MVP 范围

### P0：必须完成

资料与卡片：

- 文本型 PDF 或粘贴文本。
- PDF 最多 10 页、5 MB，提取后最多 20,000 字符。
- 首发仅支持简体中文。
- 用户可以填写学习目标；留空时默认提取资料核心知识。
- Agent 根据 Knowledge Map 动态生成 4～30 张 `concept | qa` 知识卡。
- 每张卡包含正面提示、答案、关键点、页码和逐字引用。
- 所有展示卡片必须通过本地引用校验。

复习体验：

- Dashboard 展示今日新卡、到期卡、卡片总数和重点标签。
- 一次只学习一张卡，先思考再显示答案。
- 显示答案后选择忘记、困难、记得、简单。
- FSRS 更新卡片状态与下次到期时间。
- 会话结束后展示评分分布、遗忘卡片和薄弱标签。
- 刷新或重新登录后能够恢复进度。

AI 计划：

- Agent 生成未来 7 天的滚动计划。
- 计划包含知识顺序、每日新卡、复习上限和重点标签。
- 每次会话最多引入 8 张新卡，总任务不超过 15 张，避免负担失控。
- 每次会话后 Learning Coach 检查重排条件；只有计划真正变化时才保存下一版本。
- Agent 失败时使用 FSRS 到期队列作为兜底。

Monad：

- User 创建学习项目并登记资料与分段清单的哈希承诺。
- 部署三个 Worker Agent 钱包，对不同 `chunkId` 并发调用 `commitChunk`。
- Coordinator/Finalizer 使用独立钱包，在全部分段确认后调用 `finalizeDeck`。
- 每个 `commitChunk` 只写独立分段状态，不写共享完成计数器。
- 页面实时展示每个分段的 Agent 地址、交易、区块、Gas 和确认耗时。
- 合约只保存哈希、数量和 Agent 地址，不保存资料正文、卡片正文、评分或资金。
- 提供同一钱包连续 nonce 与三钱包独立 nonce 的可重复并发测试脚本。

### P1：稳定后再做

- 针对当前卡片提供“换种说法”和“举个例子”。
- 连续遗忘时自动生成一张补充卡。
- 卡片编辑、删除和置顶。
- 多资料合并为一个学习项目。
- 简单知识关系图。
- 智能账户或 Paymaster 隐藏首次 Gas。
- Deck 新版本、计划版本和学习里程碑承诺。
- 多学习项目并发提交压测与可下载报告。

第 5 天之后不增加 P1。

### 本周不做

- Agent 市场、第三方 Agent 接入、Agent 竞赛、赏金、支付、质押和争议。
- USDC、Token、NFT、DAO 和跨链。
- OCR、扫描件、音视频和网页抓取。
- 长文档 RAG、向量数据库和 embedding 管道。
- 开放式聊天、无限工具循环和自研记忆算法。
- 社交、排行榜、卡包市场和防作弊学习证书。
- 生产级账户恢复、合约升级和运营后台。

## 5. 成功标准

- 一份真实 PDF 能按知识密度生成 4～30 张引用有效的知识卡。
- 从 `JourneyCreated` 到 `DeckFinalized`，目标在 90 秒内。
- 至少三个资料分段由三个 Worker 钱包真实并发处理和提交。
- 每个 `ChunkCommitted` 都能在页面对应到 Agent、资料分段、卡片数量和交易。
- 初始计划有明确知识顺序，并将全部新卡分配到滚动队列。
- 用户能完成今日复习并提交四档评分。
- FSRS 产生新到期时间；达到重排条件时 Agent 产生 `planVersion + 1`。
- 全部分段确认后由 Finalizer 生成唯一的 `deckRoot + initialPlanHash` 并写入 Monad。
- Agent 或 RPC 失败时，基础复习仍然可用。
- 页面刷新后能恢复学习项目、计划和卡片状态。
- PDF、卡片正文和具体评分不上链。
- Monad 验证面板展示至少三笔 Worker 交易的确认耗时与 Gas。
- 同钱包与三钱包脚本均记录广播、交易 nonce、上块和最终确认时间，不用串行等待 receipt 人为放大差异。
- 公共环境完成至少 5 次端到端彩排。

## 6. 最小架构

```text
┌────────────────── Next.js Web ──────────────────┐
│ PDF │ 并行生成状态 │ Dashboard │ 卡片复习 │ 进度 │
└────────────┬───────────────────────┬────────────┘
             │ HTTPS                 │ wagmi/viem
             ▼                       ▼
┌──────────────────────┐   ┌─────────────────────────┐
│ Supabase             │   │ Monad                   │
│ Chunks/Deck/FSRS/Logs│   │ LearningJourneyRegistry │
└────────────▲─────────┘   └──────────┬──────────────┘
             │ tools                  │ events / tx
             ▼                        ▼
┌──────────────────────────────────────────────────┐
│ Learning Coach Agent Runner                      │
│ Coordinator │ Worker × 3 │ Finalizer │ 4 wallets│
└──────────────────────────────────────────────────┘
```

部署单元只有：

1. Next.js Web/API。
2. 一个常驻 Node.js Agent Runner，内部并发运行 Coordinator 和三个 Worker，不拆成微服务。
3. 一个 Supabase 项目。
4. 一个 Monad 合约。

不引入 Redis、BullMQ、向量库、微服务网关或 Kubernetes。

### 技术栈

| 能力 | 选择 |
| --- | --- |
| Web | Next.js + React + TypeScript |
| UI | Tailwind CSS + Lucide |
| PDF | `pdfjs-dist` 浏览器解析 |
| Agent | 支持 tool calling 与 bounded loop 的 TypeScript SDK |
| Schema | Zod |
| 复习 | `ts-fsrs` |
| 数据 | Supabase Postgres |
| 合约 | Solidity + Foundry |
| 链交互 | viem + wagmi |

Monad 网络、RPC、Chain ID 和浏览器地址在 Day 1 按赛事官方文档确认，通过环境变量注入。

## 7. 核心数据

### Knowledge Card

```ts
type KnowledgeCard = {
  id: string;
  type: "concept" | "qa";
  tag: string;
  importance: 1 | 2 | 3 | 4 | 5;
  initialDifficulty: 1 | 2 | 3 | 4 | 5;
  front: {
    title: string;
    prompt: string;
  };
  back: {
    answer: string;
    keyPoints: string[];
    example?: string;
  };
  citation: {
    pageNumber: number;
    quote: string;
  };
};
```

卡片必须是一个可独立复习的原子知识点，而不是一整章摘要。

### Source Chunk 与链上承诺

```ts
type SourceChunk = {
  journeyId: string;
  chunkId: number;
  pageStart: number;
  pageEnd: number;
  text: string;                 // 仅临时保存在 Supabase
  sourceChunkHash: `0x${string}`;
  merkleProof: `0x${string}`[];
};

type ChunkResult = {
  journeyId: string;
  chunkId: number;
  workerAddress: `0x${string}`;
  cards: KnowledgeCard[];
  cardsRoot: `0x${string}`;
  cardCount: number;
  txHash: `0x${string}` | null;
  status: "QUEUED" | "GENERATING" | "SUBMITTING" | "CONFIRMED" | "MERGED";
};
```

`sourceHash`、`sourceChunkHash`、`cardsRoot` 和 `deckRoot` 必须使用固定字段顺序和规范化 JSON 生成。卡片叶子同时包含 `journeyId`、`chunkId`、卡片内容哈希和引用哈希，防止跨项目复用。`deckRoot` 由最终选中的卡片叶子及其来源 `chunkId` 生成，Finalizer 只能选择已经存在于某个 `cardsRoot` 的卡片。相同输入必须得到相同 Root，并提供独立的本地校验函数。

P0 统一使用 `keccak256` 和 OpenZeppelin 兼容的 sorted-pair Merkle Tree：

```text
sourceHash        = hash(canonical pages)
sourceChunkHash   = hash(canonical chunk)
manifestLeaf      = hash(abi.encode(journeyId, chunkId, sourceChunkHash))
chunkManifestRoot = merkleRoot(manifestLeaf[])
cardLeaf          = hash(abi.encode(journeyId, chunkId, hash(canonical card)))
cardsRoot         = merkleRoot(cardLeaf[])
deckRoot          = merkleRoot(selected cardLeaf[] sorted by cardId)
initialPlanHash   = hash(canonical initial plan)
```

前后端共享同一个 `canonicalize` 包和 golden vectors；禁止分别实现两套字段排序逻辑。

### Review Plan

```ts
type ReviewPlan = {
  version: number;
  timezone: string;
  strategySummary: string;
  days: Array<{
    date: string;
    newCardIds: string[];
    maxReviewCards: number;
    focusTags: string[];
  }>;
  basedOnSessionId: string | null;
};
```

### Session Summary

```ts
type SessionSummary = {
  sessionId: string;
  reviewedCount: number;
  ratingCounts: [number, number, number, number];
  forgottenCardIds: string[];
  weakTags: string[];
  averageResponseMs: number;
};
```

评分固定映射到 FSRS：`忘记=1`、`困难=2`、`记得=3`、`简单=4`。

## 8. Agent 工作流

### 资料准备与分派

1. 浏览器解析 PDF，API 校验页数、字符数并生成 `journeyId`。
2. Coordinator 按标题、页面和长度边界建立 2～4 个语义分段，不把同一段落切开。
3. Coordinator 估算各分段知识密度，分配合计不超过 30 的卡片预算。
4. 系统计算 `sourceHash`、各 `sourceChunkHash` 和 `chunkManifestRoot`。
5. User 调用 `createJourney` 登记清单 Root 和分段数。
6. Runner 监听 `JourneyCreated`，将不同 `chunkId` 分派给最多三个空闲 Worker。

演示资料固定产生三个分段，以保证三钱包并行路径可见；真实资料允许 2～4 个分段，超过三个时由先完成的 Worker 领取下一段。

### Worker 并行生成

每个 Worker 只处理被分派的资料分段：

1. `read_assigned_chunk` 读取分段和卡片预算。
2. 建立局部 Knowledge Map，拆分原子知识点及前置关系。
3. 按预算生成带页码和逐字引用的卡片。
4. `validate_chunk_cards` 检查 schema、引用和分段内重复。
5. 有错误时修正一次；仍失败则返回 Coordinator 重派或终止。
6. 保存 `ChunkResult`，计算确定性的 `cardsRoot`。
7. 使用本 Worker 的钱包调用 `commitChunk`，等待 receipt 后标记为 `CONFIRMED`。

每个 Worker 最多 8 次工具调用、一次内容修正、60 秒超时和固定模型预算。不同 Worker 通过 `Promise.allSettled` 并发执行；一个 Worker 失败不能取消已完成分段。

### Finalizer 合并

全部分段链上确认后，Coordinator 执行 Finalizer 步骤：

1. 读取所有已确认 `ChunkResult`，拒绝数据库 Root 与链上 Root 不一致的结果。
2. 合并局部 Knowledge Map，检查跨分段重复、章节覆盖和前置关系。
3. 必要时只选择或删除重复、低价值卡片，不改写已承诺卡片正文，也不凭空补卡，最终保留 4～30 张。
4. 生成滚动 7 日计划并执行 `simulate_review_plan`。
5. 保存最终 Deck/Plan，计算 `deckRoot + initialPlanHash`。
6. Coordinator 钱包调用 `finalizeDeck`，确认后开放卡片学习。

Finalizer 最多 6 次工具调用、一次修正和 30 秒超时。完整流程目标在 90 秒内完成。

### 会话后重排

1. API 保存评分并用 FSRS 更新 Card State。
2. 会话结束时生成未来 7 天 due forecast。
3. 学习项目标记为 `SESSION_PENDING`。
4. Agent 读取 Session Summary、当前计划和 due forecast。
5. 触发重排时，Learning Coach 调整新卡量、复习上限和重点标签。
6. 计划模拟通过后在 Supabase 保存 `Plan vN+1`。
7. 未触发重排时直接结束，继续使用当前计划。

P0 的计划更新不上链。Monad 主线集中在多 Agent 并行生成、分段承诺和最终 Deck 验证，避免用高频复习交易稀释演示重点。

重排触发条件：

- 本次遗忘率大于等于 40%。
- 任意重要度为 5 的卡片被评为“忘记”。
- 同一标签连续两个 Session 进入薄弱标签。
- 未来任一天的 FSRS 到期卡超过 15 张。
- 每完成 3 个 Session 进行一次周期复盘。

### 卡片校验

全部生成卡片必须满足：

- Zod schema 通过。
- 页码有效。
- 规范化后的 quote 是对应页面的连续子串。
- 单个引用为 20～400 字符。
- 问题、答案和引用非空。
- 卡片之间没有精确重复。
- 不使用“根据上文”“如下所示”等缺失上下文的表述。
- `importance`、`initialDifficulty` 在 1～5。

卡片少于 4 张、超过 30 张，或第二次仍存在无效卡片时，学习项目显示可重试错误，不提交初始计划。

## 9. 复习计划规则

- 滚动 7 日只是 Agent 的当前规划窗口，不代表学习项目必须在 7 天内完成。
- 每过一个自然日自动向后补一天，时区由浏览器自动获取。
- 高重要度基础概念先于低重要度应用卡。
- 初始每次引入 3～8 张新卡，总任务不超过 15 张。
- FSRS 到期卡优先于新卡。
- 连续遗忘的标签进入下一次重点复习。
- 遗忘率大于等于 40% 时减少新卡；低于 15% 且触发周期复盘时最多增加 2 张新卡。
- 未来到期量过高时减少新卡，而不是延后到期卡。
- Agent 更新失败时，按 FSRS due time 直接生成今日队列。

## 10. Monad 合约

只实现一个不处理资金的 `LearningJourneyRegistry`。

### 状态与数据

```text
NONE → CREATED → READY
          └→ CANCELLED
```

```solidity
struct Journey {
    address learner;
    bytes32 sourceHash;
    bytes32 goalHash;
    bytes32 chunkManifestRoot;
    bytes32 deckRoot;
    bytes32 initialPlanHash;
    uint16 chunkCount;
    uint16 totalCardCount;
    uint48 createdAt;
    uint48 finalizedAt;
    JourneyStatus status;
}

struct ChunkCommitment {
    bytes32 sourceChunkHash;
    bytes32 cardsRoot;
    address agent;
    uint16 cardCount;
    uint48 committedAt;
}

mapping(bytes32 journeyId => Journey) public journeys;
mapping(bytes32 journeyId => mapping(uint16 chunkId => ChunkCommitment)) public chunks;
mapping(address agent => bool allowed) public isWorker;
```

`coordinatorAgent` 在构造函数中设为 immutable；三个 Worker 地址在部署时写入 `isWorker`，不提供赛中修改入口，不增加管理员、资金和升级逻辑。

### 方法

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
) onlyWorker

finalizeDeck(
    bytes32 journeyId,
    bytes32 deckRoot,
    bytes32 initialPlanHash,
    uint16 totalCardCount
) onlyCoordinator

cancelJourney(bytes32 journeyId)
```

### 规则

- `journeyId` 是 Web 生成的随机非零 `bytes32`，不得重复。
- `chunkCount` 只能为 2～4；`chunkManifestRoot` 承诺确定的 `(journeyId, chunkId, sourceChunkHash)` 叶子集合。
- 只有 learner 能取消自己的学习项目；`READY` 后不能取消。
- 只有部署时登记的 Worker 能提交分段；实际提交者由 `msg.sender` 记录，不能由参数伪造。
- `commitChunk` 使用 OpenZeppelin `MerkleProof` 校验分段属于清单，要求 `chunkId < chunkCount`、`cardsRoot != 0`、`cardCount > 0`。
- 同一 `journeyId + chunkId` 只能成功提交一次。Worker 超时后可以重派，但先确认的有效交易获胜。
- `commitChunk` 只写 `chunks[journeyId][chunkId]`，不更新 Journey 完成数量或任何全局计数器。
- 只有 Coordinator 能调用 `finalizeDeck`；方法最多循环四个分段，要求每个分段均已提交。
- Finalizer 要求 `4 <= totalCardCount <= 30`，并且最终数量不能超过各分段 `cardCount` 之和，然后将 Journey 置为 `READY`。
- `sourceHash`、Root、卡片数量和 Agent 地址上链，资料正文、卡片正文、具体评分和私钥不上链。

事件：`JourneyCreated`、`ChunkCommitted`、`DeckFinalized`、`JourneyCancelled`。

并行友好性来自不同 Worker EOA 写入不同的内层 mapping key。单一 EOA 即使同时广播连续 nonce，也存在发送者级顺序依赖；不同 EOA 消除共同 nonce 序列。若在 `commitChunk` 中增加共享 `committedCount++`，还会制造合约状态写热点，因此 P0 明确不这样实现。

合约未审计，只用于测试网。

## 11. 链下存储与接口

Supabase Postgres 保留四类数据：

- `learning_journeys`：用户、最终 Deck、Plan、FSRS states、Root 和版本。
- `source_chunks`：临时分段文本、哈希、Merkle proof、Worker、Root 和状态。
- `review_logs`：不可变的卡片评分事件，按 session 分组。
- `agent_events`：Coordinator/Worker 的脱敏工具事件、任务尝试和交易状态。

原始 PDF 不上传。浏览器只把提取后的页面文本发送给 API；分段文本在 Deck 生成后删除，最迟保留 24 小时，卡片只保留复习所需的短引用。链上哈希不是加密，已知或低熵内容仍可能被猜中，因此不为每条短引用单独上链，只提交完整分段和卡片集合的 Root。叶子加入 `journeyId` 只用于域隔离、防止跨项目复用，不宣称能够隐藏内容。

最小接口：

```text
POST /api/journeys/prepare
POST /api/journeys
GET  /api/journeys/{id}
GET  /api/journeys/{id}/generation
POST /api/journeys/{id}/reviews
POST /api/journeys/{id}/sessions/{sessionId}/complete

POST /api/internal/journeys/{id}/chunks/{chunkId}/claim
PUT  /api/internal/journeys/{id}/chunks/{chunkId}/result
POST /api/internal/journeys/{id}/finalize
PUT  /api/internal/journeys/{id}/revised-plan
POST /api/internal/journeys/{id}/events
```

用户通过一次钱包签名建立短期 Web session。每个内部 Agent 使用独立 token，服务端将 token 身份与预期钱包地址绑定；所有写入重新校验 schema、权限、哈希和乐观版本。Agent 私钥只存在于 Runner 的服务端 secret 中。

## 12. 页面

### 新建学习项目

- PDF/粘贴文本和可选学习目标。
- 解析后显示页数和字符数。
- 主按钮为“生成知识卡与计划”。
- 点击后连接钱包并在 Monad 创建学习项目。

### 并行生成与 Monad 验证

- 顶部显示 Learning Coach 当前阶段：拆分资料、并行生成、合并验证、制定计划。
- 每个资料分段固定占一行，状态为 `等待 → Agent 生成 → Monad 提交 → 已确认 → 已合并`。
- 行内显示章节范围、Worker 地址、卡片数、交易链接、区块、Gas 和确认耗时。
- 三个 Worker 同时运行时并排更新，不用虚假进度条模拟并行。
- 分开显示推理耗时、RPC 广播耗时和链上确认耗时。
- 单个分段失败时只重试或重派该分段，不清空其他已经确认的结果。

### 学习 Dashboard

- 今日新卡、到期卡、卡片总数和知识标签覆盖。
- “开始今日复习”主操作。
- 紧凑展示未来 7 日负担和重点标签。
- 紧凑展示 Deck 验证状态和 `deckRoot`，详细交易保留在生成记录页。

### 卡片复习

- 一次一张，先显示正面提示。
- 点击后展示答案、关键点、示例、页码和短引用。
- 显示答案后出现四档评分。
- 顶部显示本次进度和剩余卡片数。

### 会话结果

- 本次评分分布、遗忘卡片和薄弱标签。
- 触发重排时对比 `Plan v1 → v2` 的任务和重点变化。
- 未触发重排时明确显示“当前计划继续有效”，不制造虚假版本变化。
- 明确显示“学习数据已保存”；P0 不把单次复习包装成链上证明。

## 13. 七天计划

### Day 1：风险验证

- 初始化 Web、Agent Runner 和 Foundry。
- 确认 Monad 官方网络配置。
- 写出 `createJourney`、`commitChunk`、`finalizeDeck` 的最小合约测试。
- 用三个本地 Worker 钱包同时向三个 `chunkId` 提交，确认不存在共享写计数器。
- 固定一份资料，验证规范化哈希、Merkle proof、`cardsRoot` 和 `deckRoot` 可重复。
- 单次模型调用生成数量合理、引用可定位的卡片。

退出标准：三个 Worker EOA 能写入三个独立状态槽，错误 proof 被拒绝，相同输入得到相同 Root。

### Day 2：资料与学习项目

- PDF 解析、粘贴文本和输入限制。
- Coordinator 生成 2～4 个语义分段、卡片预算和 `chunkManifestRoot`。
- Supabase 四类数据、钱包 session 和临时文本清理字段。
- `prepare/create` API、用户钱包交易和 receipt。
- Runner 捕获 `JourneyCreated` 并恢复对应分段任务。

退出标准：用户上传后能创建带真实分段清单 Root 的 Journey，Runner 自动获得任务。

### Day 3：Worker 并行生成

- 完成 Worker 的读取、Knowledge Map、制卡、引用校验和一次修正工具。
- 三个独立上下文与钱包通过 `Promise.allSettled` 并行运行。
- 每个 Worker 保存结果并调用 `commitChunk`，失败任务支持重派和幂等重试。
- 页面逐行展示 Worker、交易、区块、Gas 和确认耗时。

退出标准：真实资料的三个分段并行生成，并产生三个可在浏览器查看的 `ChunkCommitted`。

### Day 4：Finalizer 与初始计划

- 校验链上/链下 Root，合并 Knowledge Map，完成跨分段去重和覆盖检查。
- 动态保留 4～30 张卡，生成 7 日滚动计划并模拟负担。
- Coordinator 调用 `finalizeDeck`，Dashboard 展示已验证 Deck 和今日任务。
- 卡片正反面、页码、引用和手机/桌面基础布局。

退出标准：从上传到 `DeckFinalized` 首次端到端跑通。冻结 Chunk/Card/Plan schema。

### Day 5：复习闭环与 Coach 重排

- 四档评分、ReviewLog 幂等写入和 FSRS 更新。
- 到期卡优先的今日队列、Session Summary、薄弱标签和 due forecast。
- 达到触发条件时生成链下 Plan v2，并通过负担模拟和乐观版本写入。
- 结果页展示评分与计划差异；Agent 失败时使用 FSRS 队列。
- 测试 Runner 重启、重复事件、Worker 重派和交易重试。

退出标准：用户可完成一次复习；遗忘重要卡片后计划合理变化。冻结全部 P0。

### Day 6：稳定与部署

- PDF、AI、数据库、钱包和 RPC 错误状态。
- Agent 失败时 FSRS 兜底。
- 部署正式 Web、Runner 和合约。
- 完成实时 Monad 验证面板，展示真实确认耗时、Gas 和 Agent 地址。
- 完成同钱包连续 nonce 与三钱包独立 nonce 的并发对照脚本，各重复至少 5 次并记录广播、receipt 和区块数据。
- 完成 5 次端到端测试。

退出标准：公共 URL 连续完成 3 次彩排。

### Day 7：交付

- 只修 P0 阻断问题。
- 运行合约、Agent 工具、类型检查和构建。
- 准备架构图、3 分钟讲稿和无剪辑视频。
- README 写明合约地址、Agent 地址和已知限制。
- 明确写出“Monad 负责登记和验证，不负责调度 Agent，也不证明卡片语义正确”。
- 固定最终部署版本。

## 14. 测试与降级

必须测试：

- 动态生成的全部卡片通过 schema 和引用定位。
- 错误页码、伪造引用、重复卡会被拒绝。
- 相同分段得到相同 `sourceChunkHash` 和 `cardsRoot`。
- 相同 Deck 得到相同 `deckRoot`。
- 错误 `manifestProof`、越界 `chunkId` 和未授权钱包调用 `commitChunk` 均失败。
- 同一 `journeyId + chunkId` 不能重复提交。
- 三个 Worker 提交后，链上记录的 `agent` 分别等于三个实际 `msg.sender`。
- 三个 `commitChunk` 写入不同 mapping key；合约不存在共享完成计数器。
- 缺少任意分段时不能 `finalizeDeck`，齐全后只能 Finalizer 成功调用一次。
- 最终卡片数必须为 4～30，且不能超过各分段卡片数量之和。
- 四档评分正确映射到 FSRS，重复 review 不重复写入。
- 到期卡优先于计划新卡。
- 连续遗忘后，Agent 提高对应标签优先级。
- Worker 或链上失败不会删除其他已经保存的分段结果。
- 数据库卡片被修改后，本地 Root 校验能够发现与链上承诺不一致。

降级策略：

| 风险 | 降级 |
| --- | --- |
| PDF 无文本 | 使用粘贴文本或示例资料 |
| Worker 超时 | 只重派失败分段；演示时可打开明确标记的真实历史项目 |
| 计划生成失败 | 使用 FSRS 基础到期队列 |
| Runner 漏事件 | 按 `journeyId` replay |
| Monad RPC 不稳定 | 保留已生成结果，按唯一分段 key 幂等重试交易 |
| 时间不足 | 删除 Plan v2 和全部 P1，保留三个 Worker、分段承诺与 Deck Finalize |

## 15. 三分钟演示

1. 上传一份 Solidity 重入攻击资料，可选填写“理解攻击原理与防御方式”，展示三个语义分段。
2. User 在 Monad 创建学习项目，页面出现三个 Worker 行和各自钱包地址。
3. 三个 Worker 并行生成知识卡并分别确认 `ChunkCommitted`；页面实时出现卡片数、交易、区块、Gas 和确认耗时。
4. Finalizer 合并卡片、提交 `DeckFinalized`，页面显示最终 `deckRoot` 和“Monad 已验证”。
5. 打开两张知识卡，展示知识点、答案和可定位的原文引用，再完成一次四档评分。
6. 打开验证面板或 Monad 浏览器，展示三个 Worker EOA 写入三个独立 `chunkId`，并展示同钱包与三钱包测试的原始数据，不承诺三笔交易能构成吞吐基准。

超过演示时间时切换到明确标记的真实历史学习项目。

## 16. Definition of Done

- 公共 URL 可上传真实 PDF 并创建 Monad 学习项目。
- Coordinator 由链上事件触发，三个 Worker 以独立上下文和钱包并发处理不同分段。
- 每个 Worker 生成的引用有效卡片均产生可核验的 `cardsRoot` 和 `ChunkCommitted`。
- Finalizer 根据 Knowledge Map 合并出 4～30 张知识卡，并提交唯一的 `deckRoot`。
- Agent 生成包含知识顺序、新卡量和重点标签的滚动计划。
- 用户能逐张复习并提交四档反馈。
- FSRS 正确更新，重复提交不会产生重复日志。
- 达到重排条件后 Agent 能根据薄弱标签生成 Plan v2。
- User、三个 Worker 和 Coordinator 使用不同钱包完成 `JourneyCreated`、`ChunkCommitted` 和 `DeckFinalized`。
- `commitChunk` 不写共享计数器；页面展示 Agent、分段、交易、Gas、区块和确认耗时。
- 同钱包连续 nonce 与三钱包独立 nonce 的并发脚本可重复运行并导出原始交易数据。
- Agent 或 Monad 失败时基础复习仍可用。
- PDF、卡片正文、具体评分和 Agent 私钥不上链。
- 合约、Merkle proof、引用/Root/计划测试、类型检查和构建通过。
- 公共环境完成至少 5 次彩排并准备备份视频。

## 17. 赛后扩展

1. Deck 版本更新、学习里程碑和跨应用可携带的学习身份。
2. 开放第三方 Worker Agent、Agent 声誉、支付与争议处理，使链上信任从团队内部扩展到开放协议。
3. 多资料、知识图谱和跨 Deck 前置关系。
4. 卡片编辑、补充卡、按卡 AI 讲解、长文档 RAG、OCR 和更多语言。
5. 智能账户与 Paymaster。

扩展仍以学习效果为第一优先级，不为增加 Agent 数量或链上交易而偏离知识卡与复习计划主线。
