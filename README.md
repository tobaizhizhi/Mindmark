# Mindmark

Mindmark 把用户上传的学习资料拆成可引用的知识卡，并用 FSRS 安排复习。三个独立 AI
Worker 并行处理资料，分别将 `cardsRoot` 提交到 Monad；Finalizer 只能选择已承诺的卡片，
Coordinator 最后提交 `deckRoot`。

## 本地运行

要求 Node.js 22、pnpm 10 和 Foundry。

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
forge test
```

配置变量见 `.env.example`。Web 与 Runner 分开启动：

```bash
pnpm --filter @mindmark/web dev
pnpm --filter @mindmark/agent-runner dev
```

数据库迁移必须按 `supabase/migrations` 文件名顺序执行。任何私钥、模型 Key、service role
Key 和 Session Secret 都只能配置在服务端 Secret 中。

从旧的 4 分段版本升级时，必须额外执行
`20260723000100_expand_material_capacity.sql`，并重新部署 Registry 合约后更新
`REGISTRY_ADDRESS`、`NEXT_PUBLIC_REGISTRY_ADDRESS` 和 `CONTRACT_DEPLOYMENT_BLOCK`；旧合约仍会拒绝 5～12 个分段。

## 核心流程

```text
PDF / 文本
→ 先识别章节，再生成 2-12 个章节子分段
→ 3 个 Worker Agent 并行生成带逐字引用的知识卡
→ ChunkCommitted × N
→ Finalizer 选卡与初始 7 日计划
→ DeckFinalized
→ 浏览器验证 cardsRoot / deckRoot
→ ChunkConfirmed 后 Settlement Agent 用 Moss 模拟 0.001 MON Worker 奖励
→ FSRS 四档复习
→ 必要时生成链下 Plan v2
```

Monad 保存轻量承诺、Worker 地址和确认顺序；Supabase 保存业务数据。Monad 不调度模型，
也不证明卡片语义正确。独立 Reward Treasury 不属于 Registry 合约：Moss 只发现、构建和模拟
`erc20.transfer(native)`，通过严格效果校验后由 viem signer 广播同一笔预签名交易。

## 并发对照

配置一个 Learner 和三个已充值 Worker 私钥后运行：

```bash
pnpm --filter @mindmark/agent-runner benchmark:commits
```

脚本默认每种模式运行 5 次，并写入
`apps/agent-runner/artifacts/commit-concurrency.json`。报告比较同钱包连续
nonce 与三个钱包独立 nonce 的确认观测值，保留逐笔原始数据、中位数和范围，不是 TPS 测试。
仓库中的 `apps/agent-runner/artifacts/local-anvil-commit-concurrency.json` 是本地 Anvil
脚本验收结果，不代表 Monad 公网性能。

## 部署信息

- 公共 URL：部署后填写
- Monad chain ID：部署后填写
- Registry：部署后填写
- Coordinator：部署后填写
- Worker 0 / 1 / 2：部署后填写
- Reward Treasury：部署后填写（必须不同于 Coordinator 和三个 Worker）
- 部署区块：部署后填写

详细步骤见 [Step 3-5](docs/STEP_3_5_RUNBOOK.md)、
[Step 6-8](docs/STEP_6_8_RUNBOOK.md) 和
[Step 9-11](docs/STEP_9_11_RUNBOOK.md)。

## 已知限制

- 只支持文本型、最多 30 页和 15 MB 的 PDF，提取文本最多 60,000 字符；扫描件需要改用粘贴文本。
- 卡片 Hash 可以证明内容未被提交后篡改，不能证明知识内容一定正确。
- Plan v2 保存在 Supabase，不产生额外 Monad 交易。
- 赛事 Monad、Supabase 和模型的远程验收需要部署方提供有效凭据和 Gas。
