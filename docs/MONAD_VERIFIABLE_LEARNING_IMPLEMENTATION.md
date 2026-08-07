# Monad 可验证学习层实施文档

## 1. 目标与结论

本方案把 Monad 从后台生成流程中的“隐藏基础设施”变成用户和评委可以直接检查的产品能力，同时保持学习内容与复习状态离链。

本轮实现两个能力：

1. 公开的 `Monad Verification Snapshot` 页面：展示 Project、Chapter、Work Unit、Project Finalization 和 Worker Reward 的证据链，并提供 Explorer 链接。
2. `Learning Completion Attestation`：当上传型 Learning Project 的全部 Knowledge Card 达到掌握条件后，由 Completion Attestor 签发短期授权，学习者用自己的钱包在 Monad 上领取一次性完成凭证。

明确不做：

- 不把 PDF、Source Block、Knowledge Card 正文、AI prompt、Tutor 对话或 FSRS 明文状态放到链上。
- 不把 `0.001 MON` 描述成模型调用成本、课程购买费用或学习费用。它是 `work-unit-pricing-v1` 的配置基数。
- 不在当前三个 Worker 都由同一 Runner 部署控制时宣称这是开放的去中心化 Worker 市场。
- 2026-08-07 的 Sponsor Escrow 深化取代了此前“本轮不实现 Escrow”的决定。Escrow 现在用于证明生成前已锁定完整 Work Unit 预算，并保证收款人只能来自 Registry commitment；它仍不代表开放的去中心化 Worker 市场。

## 2. 当前架构与问题

现有 Registry V2 已经保存以下不可篡改承诺：

- `ProjectCreated`：learner、sourceHash、goalHash、outlineHash、workUnitManifestRoot。
- `WorkUnitCommitted`：Worker、sourceUnitHash、workerCardsRoot、cardCount、committedBlock。
- `ChapterFinalized`：chapter cardsRoot、cardCount。
- `ProjectFinalized`：projectDeckRoot、initialPlanHash、totalCardCount。

Runner 还会在 Supabase 保存创建、Work Unit、Chapter、Project 和 Reward 的交易哈希。但这些数据分散在运行模块和运维页中，普通用户无法回答以下问题：

- 项目是否真的登记到了配置的 Monad Registry？
- 哪些 Worker 地址提交了哪些 Work Unit？
- 最终 Chapter/Card Deck 根是否已经上链？
- 每个冻结的 Worker Reward Quote 是否真的从 Reward Treasury 转给了已提交承诺的 Worker？
- 某个交易应该去哪里查看？

## 3. 目标架构

```text
                         public /verify/[projectId]
                                      |
                                      v
                    Monad Verification Snapshot module
                       /                         \
                      v                           v
          Registry V2 read adapter      Supabase evidence adapter
          Project / Chapter / WU        tx hashes / Reward intents
                      \                           /
                       v                         v
                     comparison + disclosure policy
                                      |
                                      v
                  verified / pending / mismatch / unavailable

learner project overview
          |
          v
completion eligibility endpoint -- all cards mastered + Project READY
          |
          v
Completion Attestor EIP-712 authorization (short-lived)
          |
          v
learner wallet -> LearningCompletionRegistry -> Monad event/state
```

`Monad Verification Snapshot` 是一个深模块。调用者只需要 Project ID，模块内部负责读取、并发、归一化、比较、隐私裁剪和错误分类。页面不直接拼 Supabase 查询，也不自己解释合约元组。

## 4. 公共验证快照

### 4.1 页面与入口

- 新页面：`/verify/[projectId]`。
- Learning Project 概览增加“Monad 验证”入口。
- 页面不要求登录，便于在黑客松演示、Explorer 和分享链接之间跳转。
- PACK Learning Project 不显示入口，因为 Pack Installation 不进入 Monad 工作流。

### 4.2 公共字段

允许公开：

- chainId、Registry 地址、最新读取区块。
- projectId、learner 地址、Project 状态。
- sourceHash、goalHash、outlineHash、manifestRoot、deckRoot、initialPlanHash。
- Chapter ID、sourceHash、cardsRoot、Work Unit 范围、cardCount、状态。
- Work Unit ID、Chapter ID、Worker 地址、sourceUnitHash、workerCardsRoot、cardCount、committedBlock。
- 已存的创建/提交/完成/Reward 交易哈希。
- Reward Treasury、recipient、amountWei、结算状态。

禁止公开：

- 项目标题、学习目标原文、文件名、PDF 地址和 Source Block 文本。
- Knowledge Card 问题、答案、引用原文。
- FSRS 明文状态、复习时间、错误次数、Tutor 对话。
- 任何私钥、签名密钥、Supabase service role 或模型配置。

### 4.3 证据状态

统一使用四种结果：

- `VERIFIED`：Registry 状态存在，且本地已保存字段与链上值一致；Reward 交易的 from/to/value/status 也一致。
- `PENDING`：对应链上阶段或 Reward 尚未完成，不能称为已验证。
- `MISMATCH`：本地证据与链上值冲突，必须醒目标出，不能自动选择一方掩盖。
- `UNAVAILABLE`：RPC 或辅助证据暂时不可读。页面说明无法完成本次核验，不把它等价为失败或成功。

### 4.4 权威来源

- Project、Chapter、Work Unit：Registry V2 合约读取结果为权威来源。
- Registry 交易：Supabase 只提供交易哈希索引；哈希本身链接到 Explorer。
- Worker Reward：Supabase 提供 Reward intent，Monad 交易必须是 Treasury 调用配置的 Project Escrow，calldata 必须是对应的 `releaseReward(projectId, workUnitId)`，receipt 必须包含匹配 Registry Worker 与该 Work Unit 冻结报价的 `RewardReleased` 事件。
- 页面不使用数据库里的 `READY` 代替链上 `READY`。

### 4.5 性能

- Project 先读取一次，再根据链上 chapterCount/workUnitCount 以最多 8 笔并发的只读 `eth_call` 分批读取；这样兼容不支持 Multicall 的 Monad RPC，也不会让 48 个 Work Unit 同时压向节点。
- Reward 交易只对存在 txHash 的记录核验；其余直接显示 pending/blocked。
- 页面使用短时服务端缓存，目标为 10 秒内反映新的链上状态。
- 单次快照最多 16 Chapter、48 Work Unit，严格沿用 Registry V2 上限。

## 5. Learning Completion Attestation

### 5.1 为什么使用独立合约

Registry V2 已部署且不可升级，并且其职责是 AI 生成承诺，不是学习进度。完成凭证放入独立 `LearningCompletionRegistry`，避免修改项目创建和 Runner 流程。

### 5.2 领取条件

服务端只有在全部条件满足时才签发 EIP-712 授权：

- 当前钱包是 Learning Project owner。
- `project_kind = UPLOAD`。
- 本地 Project 为 `READY`，存在 projectDeckRoot。
- Registry V2 中 Project 为 `READY`，learner 和 projectDeckRoot 与本地一致。
- Knowledge Card 数量大于零。
- 每张卡满足当前掌握策略：`reps >= 3 && lapses = 0`。
- 该 Project 尚未在 LearningCompletionRegistry 领取过。

### 5.3 链上校验

`claimCompletion(projectId, progressHash, deadline, signature)` 执行时再次校验：

- Registry V2 Project 状态为 `READY`。
- `msg.sender` 等于 Registry V2 learner。
- deckRoot 非零。
- authorization 未过期。
- EIP-712 签名来自 immutable Completion Attestor。
- projectId 尚未领取。

合约保存 learner、deckRoot、progressHash 和完成区块，并发出 `LearningCompletionClaimed`。

### 5.4 progressHash

`progressHash` 是以下 canonical snapshot 的 keccak256：

- schema/version domain。
- projectId、owner、projectDeckRoot。
- 按 cardId 排序后的每张卡：cardId、reps、lapses、lastReviewedAt。
- cardCount、masteredCount。

它证明签发时服务端见到的离链状态，没有把复习隐私明文放到链上。它不是公开成绩，也不允许从哈希反推出卡片内容。

### 5.5 诚实表述

该凭证表示：Mindmark 的 Completion Attestor 按当前掌握策略签发，学习者钱包在 Monad 上领取。它不是学校证书、职业资格或无需信任的知识证明。

## 6. 合约与配置

新增配置：

```dotenv
# Public Web
NEXT_PUBLIC_COMPLETION_REGISTRY_ADDRESS=0x...

# Web server only
COMPLETION_REGISTRY_ADDRESS=0x...
COMPLETION_ATTESTOR_PRIVATE_KEY=0x...
BLOCK_EXPLORER_URL=https://testnet.monadexplorer.com
```

部署顺序：

1. 保持现有 LearningProjectRegistryV2 地址不变。
2. 用 `REGISTRY_V2_ADDRESS` 和 `COMPLETION_ATTESTOR_ADDRESS` 部署 LearningCompletionRegistry。
3. Web server 配置合约地址和 Attestor 私钥。
4. 浏览器只配置 Completion Registry 公共地址，绝不暴露 Attestor 私钥。
5. 重启 Web，完成凭证入口才会启用。

## 7. 安全与失败处理

- 授权有效期短，默认 10 分钟。
- authorization 绑定 chainId、Completion Registry 地址、projectId、learner、deckRoot、progressHash 和 deadline，不能跨链、跨合约、跨项目或跨钱包重放。
- 每个 Project 只能领取一次。
- Attestor 私钥与 Registry Coordinator、Worker、Reward Treasury 私钥必须不同。
- RPC 不可用时不签发；数据库和链上不一致时不签发。
- 学习状态在签发后改变不会删除已经领取的凭证；凭证表达的是签发时快照。
- 验证页读取失败不影响学习和复习流程。

## 8. 实施顺序

1. 新增 shared ABI、验证快照 schema 和完成授权 schema。
2. 实现 Monad Verification Snapshot module 及其链上/数据库 adapter。
3. 实现公开验证页、Explorer 链接和 Learning Project 入口。
4. 实现 LearningCompletionRegistry、部署脚本和 Foundry 测试。
5. 实现完成资格检查、progressHash、EIP-712 授权 endpoint。
6. 实现学习者钱包领取控件和验证页完成凭证展示。
7. 补齐模块测试、TypeScript、ESLint、Vitest、Forge 和响应式页面检查。

## 9. 验收标准

- 任意人拿到 upload Project ID 都能打开验证页，不需要登录。
- 页面可以区分 Project 不存在、生成中、已完成、证据冲突和 RPC 不可用。
- 页面能看到三类核心链上身份：learner、Worker、Reward Treasury。
- 每个已保存交易哈希都有正确 Explorer 链接。
- Reward 只有在交易 recipient/value/from/status 全部匹配时显示 `VERIFIED`。
- 页面明确说明动态 Worker Reward Quote 的依据、策略版本和当前 Worker 拓扑限制。
- 未全部掌握、PACK Project、非 owner、链上/本地不一致时均不能获得完成授权。
- 授权不能由其他钱包、其他 Project、其他 chain 或过期后使用。
- 完成领取后，验证页显示 learner、deckRoot、progressHash、block 和交易事件。
- 未配置 Completion Registry 时，现有上传、生成、学习和验证页仍正常工作。

## 10. 黑客松演示路径

1. 上传 PDF，确认 Chapter，并由 learner 钱包创建 Monad Project。
2. 展示三个 Worker 对不同 Work Unit 的承诺交易。
3. 展示 Chapter/Project 最终根与本地卡片数量一致。
4. 展示一笔 Worker Reward，说明它是固定结算原型，不是 AI 成本。
5. 在 Explorer 打开交易，证明页面不是静态 mock。
6. 完成所有卡片的掌握条件后，用 learner 钱包领取 Learning Completion Attestation。
7. 切回公共验证页，展示生成来源和学习完成是两条独立、可核验的 Monad 记录。

## 11. 当前实现状态

截至 2026-08-05，仓库代码已完成：

- shared 验证快照 schema、Completion claim schema 和两个合约 ABI。
- `Monad Verification Snapshot` server module、Monad RPC adapter、Supabase evidence adapter 与 Reward 原生转账复核。
- `/verify/[projectId]` 公开页面、项目概览入口、Explorer 链接、Worker 拓扑与 Reward 语义披露。
- `LearningCompletionRegistry`、部署脚本、EIP-712 claim、服务端资格检查/签发 endpoint 和条件式领取控件。
- 合约测试、快照/Reward 冲突测试、完成资格与哈希稳定性测试。
- Reward 空 calldata 校验修复、阻止记录安全恢复函数，以及一笔真实 `0.001 MON` Testnet 结算。
- Reward Moss 四阶段公开证据和 Completion Claim 的签名前 Moss 审阅抽屉。

尚未执行外部部署：

- 当前 `.env` 未配置 Completion Registry，因此领取控件按设计隐藏。
- 需要按第 6 节和生产演练手册部署合约并重启 Web 后，完成凭证才会启用。
- Moss 官方当前只支持 Mainnet `143`；项目的 `10143` 运行模式明确标记为 Mindmark 实验性 Testnet 兼容。
- 该部署会发送真实 Monad 交易并消耗部署钱包 Gas，不属于本地代码实施步骤，不能在未确认目标钱包和网络时自动执行。
