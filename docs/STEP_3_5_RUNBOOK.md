# Step 3-5 部署与运行手册

## 1. 本地检查

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
forge test
```

## 2. Supabase

创建 Supabase 项目后执行 `supabase/migrations` 中的迁移。浏览器不使用 Supabase
客户端；只有 Next.js Route Handler 和 Agent Runner 可以持有 service role key。

迁移会创建：

- `learning_journeys`
- `source_chunks`
- `review_logs`
- `agent_events`
- `auth_nonces`
- `wallet_sessions`

业务表启用并强制 RLS，且不向 `anon` 或 `authenticated` 提供 policy。服务端通过
`prepare_learning_journey` 原子写入 Journey 与 chunks，通过
`consume_auth_nonce` 原子消费登录 nonce。

## 3. 部署 Registry

准备 Coordinator 和三个不同的 Worker 地址，并给部署钱包充值赛事 Monad 网络的 Gas。

```bash
export DEPLOYER_PRIVATE_KEY=0x...
export COORDINATOR_ADDRESS=0x...
export WORKER_0_ADDRESS=0x...
export WORKER_1_ADDRESS=0x...
export WORKER_2_ADDRESS=0x...

forge script \
  contracts/script/DeployLearningJourneyRegistry.s.sol:DeployLearningJourneyRegistry \
  --rpc-url "$MONAD_RPC_URL" \
  --broadcast
```

部署后分别调用 `coordinator()`、`worker0()`、`worker1()` 和 `worker2()` 检查地址，
并把合约地址同时写入服务端 `REGISTRY_ADDRESS` 和前端
`NEXT_PUBLIC_REGISTRY_ADDRESS`。

## 4. Web 环境变量

复制 `.env.example` 中的变量名到部署平台 Secret。以下变量严禁进入浏览器配置：

- `SUPABASE_SERVICE_ROLE_KEY`
- `SESSION_SECRET`
- 任何私钥

生成 session secret：

```bash
openssl rand -hex 32
```

## 5. Step 5 验收

1. 打开首页并连接赛事要求的 Monad 钱包网络。
2. 点击“使用示例”或导入不超过 10 页、5 MB 的文本型 PDF。
3. 签署 EIP-4361 登录消息。
4. 点击“拆分资料”，确认生成 2-4 个 chunk 和动态卡片预算。
5. 点击“在 Monad 创建”，钱包调用 `createJourney`。
6. API 校验 receipt 和 `JourneyCreated` 的合约、链、learner 及所有 Hash 后，数据库才进入 `CREATED`。

原始 PDF 不会发送到服务器。Journey `READY` 时数据库 trigger 会立即删除
`source_chunks.source_text` 和 Worker 草稿；异常数据由清理函数在 24 小时后处理。

