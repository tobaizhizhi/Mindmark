# Mindmark 公网 Testnet 部署手册

> 目标：保持 Monad Testnet `10143`，将 Web 和 Agent Runner 部署到公网供邀请用户使用。本文不涉及 Monad Mainnet。

## 1. 部署拓扑

使用一个 Railway Project 创建两个 Service：

```text
Browser -> Mindmark Web -> Supabase / Monad Testnet / AI Tutor
                         \
                          Agent Runner -> Supabase / Monad Testnet / AI Model
```

- Web Service 提供公网域名、Next.js 页面和 API。
- Runner Service 是常驻后台进程，不需要公网域名，首个版本只运行一个实例。
- Supabase 继续保存学习、工作流、复习和审计状态。
- 用户和运营钱包继续使用 Monad Testnet `10143`。

不要部署到纯静态托管服务。Web 包含钱包会话、Service Role 数据访问、PDF 上传和服务端 API；Runner 还必须持续领取 Workflow Job。

## 2. 上线前数据库闸门

已有 Supabase 环境先备份，再按顺序执行尚未应用的 migration。当前升级必须包括：

```text
supabase/migrations/20260807000200_generation_failure_recovery.sql
supabase/migrations/20260807000300_dynamic_work_unit_pricing.sql
supabase/migrations/20260807000400_legacy_escrow_pricing_recovery.sql
supabase/migrations/20260808000100_parallel_worker_dispatch.sql
```

生产数据不可丢弃时，不要清空 `public` schema。执行 migration 后刷新 PostgREST Schema Cache，并在 SQL Editor 检查：

```sql
select public.get_schema_capabilities_v1();
select public.get_workflow_operations_v2();
```

要求：

- `schemaVersion = 2026-08-08.1`
- 七项 capability 全部为 `true`（包括 `parallelWorkerDispatch`）
- `missing = []`
- 首次开放时 `staleJobs = 0`、`failedJobs = 0`

## 3. Railway Web Service

1. 连接包含本仓库的 GitHub Repository。
2. Service Root Directory 保持仓库根目录，不要设为 `apps/web`，否则 pnpm workspace package 不可见。
3. Config as Code 文件设置为 `/deploy/railway/web.railway.json`。
4. 生成 Railway 公网域名。
5. 在 Variables 中设置下一节的 Web 环境变量，然后重新部署。

Railway 会从根 `package.json` 读取 Node.js `>=22` 和 pnpm `10.33.4`。配置文件依次构建 Shared、AI Gateway 和 Web，并用 `/api/health` 做存活检查。

### Web Variables

```dotenv
NEXT_PUBLIC_MONAD_RPC_URL=https://testnet-rpc.monad.xyz
NEXT_PUBLIC_MONAD_CHAIN_ID=10143
NEXT_PUBLIC_REGISTRY_V2_ADDRESS=<current-testnet-registry>
NEXT_PUBLIC_COMPLETION_REGISTRY_ADDRESS=
NEXT_PUBLIC_BLOCK_EXPLORER_URL=https://testnet.monadexplorer.com

MONAD_RPC_URL=https://testnet-rpc.monad.xyz
MONAD_CHAIN_ID=10143
REGISTRY_V2_ADDRESS=<same-testnet-registry>
PROJECT_ESCROW_ADDRESS=<current-testnet-escrow>
BLOCK_EXPLORER_URL=https://testnet.monadexplorer.com

SUPABASE_URL=<supabase-project-url>
SUPABASE_SERVICE_ROLE_KEY=<server-only-secret>
SESSION_SECRET=<at-least-32-random-characters>
OPERATOR_WALLET_ADDRESSES=<operator-wallets-separated-by-comma>

AI_API_KEY=<server-only-model-key>
AI_MODEL=<tool-calling-model>
# AI_BASE_URL=<optional-openai-compatible-endpoint>
# AI_TUTOR_MODEL=<optional-tutor-model>
```

`NEXT_PUBLIC_*` 在构建时写入浏览器 bundle，修改后必须重新部署。私钥、Service Role Key、模型 Key 和 Session Secret 禁止使用 `NEXT_PUBLIC_` 前缀。

## 4. Railway Runner Service

1. 从同一个 GitHub Repository 创建第二个 Service。
2. Root Directory 同样保持仓库根目录。
3. Config as Code 文件设置为 `/deploy/railway/runner.railway.json`。
4. 不生成公网域名，不配置 HTTP Healthcheck。
5. 首次只使用一个 Replica，并启用失败自动重启。

### Runner Variables

这些变量必须添加到 Railway 的 **Mindmark Runner Service -> Variables**。本地的
`.env` / `.env.local` 文件不会上传到 Railway，也不会被 Runner 的生产启动命令读取。
如果变量只添加到了 Web Service，Runner 仍会看到 `undefined` 并在启动预检阶段退出。
不要把下面的尖括号占位符原样粘贴进去，必须替换为真实值；可选变量如果没有值就删除，
不要创建空的 URL 变量。

```dotenv
MONAD_RPC_URL=https://testnet-rpc.monad.xyz
MONAD_CHAIN_ID=10143
REGISTRY_V2_ADDRESS=<current-testnet-registry>
PROJECT_ESCROW_ADDRESS=<current-testnet-escrow>

SUPABASE_URL=<supabase-project-url>
SUPABASE_SERVICE_ROLE_KEY=<server-only-secret>

AI_API_KEY=<server-only-model-key>
AI_MODEL=<tool-calling-model>
# AI_BASE_URL=<optional-openai-compatible-endpoint>
# AI_DESIGN_MODEL=<optional-design-model>
# AI_EVALUATION_MODEL=<optional-evaluator-model>
# AI_EMBEDDING_MODEL=<optional-embedding-model>
AI_TOOL_TIMEOUT_MS=120000
AI_CHAPTER_DESIGN_TIMEOUT_MS=20000

COORDINATOR_PRIVATE_KEY=<server-only-private-key>
WORKER_0_PRIVATE_KEY=<server-only-private-key>
WORKER_1_PRIVATE_KEY=<server-only-private-key>
WORKER_2_PRIVATE_KEY=<server-only-private-key>
REWARD_TREASURY_PRIVATE_KEY=<server-only-private-key>
WORKER_REWARD_AMOUNT_MON=0.001
RUNNER_POLL_INTERVAL_MS=5000
```

Registry、Escrow、Chain ID、Supabase URL 和 Service Role Key 必须与 Web 完全一致。Runner 启动时会核对数据库 capability、Escrow 引用的 Registry、钱包分工和 Moss 网络支持；失败时进程退出，由 Railway 标记部署失败或重启。

Runner 会固定启用三个安全的生成 lane：Worker 0/1/2 可并行生成不同的 Work Unit，
但同一 Worker 钱包同一时刻只会处理一个任务；质量检查、章节装配、最终确认与奖励结算仍串行。
不需要新增 Railway 并发变量。

部署后请在 Runner Service 的 **Deployments -> View Logs** 中确认先出现
`Mindmark Agent Runner: 6 isolated roles configured`。如果看到
`Agent Runner environment is invalid`，按日志列出的变量名回到该 Service 的 Variables 修正，
然后点击 **Redeploy**。Runner 是后台进程，没有 HTTP 页面；访问它的域名会显示
`Application failed to respond`，这是正常的，浏览器应访问 Web Service 的域名。

## 5. 钱包和资金

- 学习者钱包需要少量 Testnet MON 支付 Registry 登记交易 Gas。
- Coordinator、三个 Worker 和 Reward Treasury 钱包需要足够 Testnet MON。
- Reward Treasury 不得复用 Coordinator 或 Worker 钱包。
- 所有私钥只填写到 Runner Variables，不写入 GitHub、Railway Web Variables 或客户端代码。

当前旧版 Testnet Escrow 兼容路径可以继续运行，但它显示为 `LEGACY_FIXED`。若产品页面需要对新项目声明逐 Work Unit 动态报价，应在 Testnet 重新部署新版 `LearningProjectEscrow`，并用干净测试数据完成一次演练后再开放。

## 6. 公网 Smoke Test

使用 Railway 临时 HTTPS 域名依次验证：

1. 未登录可打开首页和 `/learn/packs`。
2. 钱包连接、SIWE 签名和退出登录正常。
3. 上传一份不超过 15 MB、30 页的文本型 PDF。
4. Outline 完成并确认 Chapter。
5. 学习者钱包完成 Monad Testnet Project 登记。
6. Runner 完成 Escrow funding、AI generation、quality、assembly、finalization 和 reward。
7. Project 进入 `READY`，刷新后 Chapter 和 Knowledge Card 保留。
8. `/verify/[projectId]` 能读取 Registry、Escrow 和 Reward 证据。
9. 运营钱包打开 `/operations`，确认没有 stale/failed job。
10. 重启 Runner，确认没有丢失或重复执行已完成任务。

Smoke Test 通过后再绑定自定义域名。SIWE 授权绑定域名和 URI，域名切换后旧 Session 失效一次是预期行为，用户重新签名即可。

## 7. 开放范围

当前项目要求钱包登录，但没有完整的“每钱包每日生成项目数”额度。公开搜索引擎收录前先采用邀请制，监控 AI 账单、Reward Treasury 余额、`failedJobs`、`staleJobs` 和 `blockedRewards`。完全开放前应增加项目创建额度以及 `/api/monad-rpc` 的共享限流。
