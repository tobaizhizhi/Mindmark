# Step 6-8 Agent Runner 运行手册

## 1. 已实现链路

```text
JourneyCreated 事件重放 + Supabase 轮询
→ Coordinator 按 journeyId 幂等认领
→ Worker 0/1/2 使用 Promise.allSettled 并行运行
→ 引用校验、服务端生成 cardId / cardsRoot / proof
→ 先保存结果，再由三个 Worker 钱包 commitChunk
→ Finalizer 对照 Monad 重算每个 cardsRoot
→ 只选择已有卡片并生成 7 日计划
→ 先保存 Deck / Plan，再由 Coordinator finalizeDeck
→ receipt 确认后将 Journey 标记为 READY
```

Runner 不把 Monad 当作 AI 调度器。Monad 在这里承担三个并行 Worker 结果的公开承诺、
顺序确认和最终卡组锚定；Supabase 保存原文、卡片正文、运行租约和恢复状态。

## 2. 数据库迁移

按文件名顺序执行 `supabase/migrations`。Step 6-8 的第二个迁移增加：

- Journey 和 chunk 独立租约；
- 原子认领 Journey、chunk 和 Finalizer 的 RPC；
- 超时 Worker 恢复；
- RPC 失败时保留 `SAVED` 卡片，避免重新调用模型。

Runner 必须使用 `SUPABASE_SERVICE_ROLE_KEY`，不能将该 Key 或任何钱包私钥放进
`NEXT_PUBLIC_` 环境变量。

## 3. Runner 环境变量

除 Web 已使用的服务端变量外，还需要：

```text
CONTRACT_DEPLOYMENT_BLOCK
AI_API_KEY
AI_MODEL
AI_BASE_URL                  # 可选，兼容 OpenAI tool-calling API
COORDINATOR_PRIVATE_KEY
WORKER_0_PRIVATE_KEY
WORKER_1_PRIVATE_KEY
WORKER_2_PRIVATE_KEY
RUNNER_POLL_INTERVAL_MS      # 15000-30000，默认 20000
```

启动：

```bash
pnpm --filter @mindmark/agent-runner build
pnpm --filter @mindmark/agent-runner start
```

启动时 Runner 会读取合约的 `coordinator()` 和 `isWorker()`，配置钱包不匹配会立即停止。

## 4. 恢复规则

- 重复 `JourneyCreated`：由 `journeyId` 去重，不能重复生成。
- Runner 停机错过事件：部署区块日志重放和 15-30 秒数据库轮询负责恢复。
- Worker 生成超时：租约过期后进入 `RETRYABLE`，模型生成最多两次。
- 卡片已经保存但 RPC 失败：状态回到 `SAVED`，只重试 Monad 提交。
- 交易结果不确定：先读 `chunks(journeyId, chunkId)`；匹配则恢复为 `CONFIRMED`。
- `finalizeDeck` 已成功但数据库未更新：读取链上 READY 状态并核对 deckRoot、planHash
  和卡片数，匹配后恢复数据库，不发送第二笔交易。
- 链上 Root 与数据库正文不匹配：立即停止，不重新生成或覆盖链上结果。

## 5. Agent 边界

Worker 最多 8 次工具调用、60 秒、一次引用修正。模型不能提供 `cardId`、Root、proof
或交易 calldata；`submit_chunk_commitment` 不接收参数，并从已保存结果组装交易。

Finalizer 最多 6 次工具调用、30 秒、一次选择修正。它只能返回已有 cardId 和前置关系，
不能改写问题、答案、引用或卡片 Hash。初始计划固定 7 天，每天最多 8 张新卡、15 个总任务。

`agent_events.payload` 使用字段白名单，只允许计数、状态、区块、Gas 和确认耗时等脱敏
标量，禁止保存原文、卡片内容、完整 Prompt、隐藏推理和 Secret。

## 6. 本地验收

无需 AI Key、Supabase 或 Monad RPC 的确定性测试：

```bash
pnpm --filter @mindmark/agent-runner test
```

测试覆盖模型伪造 Root、单次修正、保存后续提、链上恢复、卡片篡改、三 Worker 并行、
单 Worker 失败保留其他结果、Finalizer 只选已有卡片、计划限制和重复事件幂等。

真实网络验收仍需赛事 Monad RPC、已部署 Registry、已执行迁移的 Supabase、可用模型 Key
以及四个已充值的 Runner 钱包。没有这些 Secret 时不能宣称已完成远程交易验收。
