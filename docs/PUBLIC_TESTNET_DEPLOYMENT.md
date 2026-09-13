# Mindmark 公网 Testnet 部署手册

> 目标：保持 Monad Testnet `10143`，通过 Railway 私有网络隔离模型供应商、Agent 执行和确定性工作流。

## 1. 部署拓扑

同一个 Railway Project 创建四个 Service：

```text
Browser -> Web -----------------------> Supabase / Monad
           |                               ^
           | private HTTP                  | Workflow Jobs
           v                               |
       AI Gateway <- Agent Runner <- Workflow Runner
           |
           v
       Model Provider
```

- Web 是唯一公网服务。Chapter AI Tutor 通过 Railway 私有域名调用 AI Gateway。
- AI Gateway 是独立 Python HTTP 服务，唯一持有模型供应商 API Key。
- Agent Runner 是独立 Python HTTP 服务，处理工具调用 transcript、模型 profile 和瞬时错误重试。
- Workflow Runner 是常驻 TypeScript 进程，领取 Supabase Workflow Job，并负责确定性校验、Monad 和 Moss。

AI Gateway 和 Agent Runner 的域名、内部令牌均不得使用 `NEXT_PUBLIC_` 前缀。

## 2. 上线前数据库闸门

已有 Supabase 环境先备份，再按顺序执行尚未应用的 migration。当前升级必须包括：

```text
supabase/migrations/20260807000200_generation_failure_recovery.sql
supabase/migrations/20260807000300_dynamic_work_unit_pricing.sql
supabase/migrations/20260807000400_legacy_escrow_pricing_recovery.sql
supabase/migrations/20260808000100_parallel_worker_dispatch.sql
```

执行后刷新 PostgREST Schema Cache，并检查：

```sql
select public.get_schema_capabilities_v1();
select public.get_workflow_operations_v2();
```

要求 `schemaVersion = 2026-08-08.1`、全部 capability 为 `true`、`missing = []`，并且首次开放时没有 stale/failed job。

## 3. AI Gateway Service

使用 `/deploy/railway/ai-gateway.railway.json`。Root Directory 保持仓库根目录，生成 Railway 私有域名，不开放公网域名。

```dotenv
AI_GATEWAY_INTERNAL_TOKEN=<at-least-32-random-characters>
AI_API_KEY=<server-only-model-key>
AI_MODEL=<tool-calling-model>
# AI_BASE_URL=<optional-openai-compatible-endpoint>
# AI_TUTOR_MODEL=<optional-tutor-model>
# AI_DESIGN_MODEL=<optional-design-model>
# AI_EVALUATION_MODEL=<optional-evaluator-model>
# AI_EVALUATION_API_KEY=<optional-separate-key>
# AI_EVALUATION_BASE_URL=<optional-endpoint>
# AI_EMBEDDING_MODEL=<optional-embedding-model>
# AI_EMBEDDING_API_KEY=<optional-separate-key>
# AI_EMBEDDING_BASE_URL=<optional-endpoint>
# AI_FALLBACK_API_KEY=<optional-deepseek-key>
# AI_FALLBACK_MODEL=deepseek-chat
# AI_FALLBACK_BASE_URL=https://api.deepseek.com/v1
```

`/health/ready` 必须返回 `200`。模型 Key 只配置在这个 Service。

## 4. Agent Runner Service

使用 `/deploy/railway/agent-runner.railway.json`。只生成 Railway 私有域名。

```dotenv
AGENT_RUNNER_INTERNAL_TOKEN=<at-least-32-random-characters>
AI_GATEWAY_URL=http://<ai-gateway-private-domain>
AI_GATEWAY_INTERNAL_TOKEN=<same-token-as-ai-gateway>
```

`/health/ready` 会检查 AI Gateway，因此两个服务之间的 URL 或令牌错误会直接阻止部署进入 Ready。

## 5. Web Service

使用 `/deploy/railway/web.railway.json`，生成公网 HTTPS 域名。

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

AGENT_RUNNER_URL=http://<agent-runner-private-domain>
AGENT_RUNNER_INTERNAL_TOKEN=<same-token-as-agent-runner>
```

Web 不配置 `AI_API_KEY` 或 AI Gateway 令牌。Chapter AI Tutor 只通过私有 HTTP/SSE 调用 Agent Runner，内部令牌只在 Next.js 服务端读取。

## 6. Workflow Runner Service

使用 `/deploy/railway/workflow-runner.railway.json`，保持一个 Replica，不生成公网域名。

```dotenv
MONAD_RPC_URL=https://testnet-rpc.monad.xyz
MONAD_CHAIN_ID=10143
REGISTRY_V2_ADDRESS=<current-testnet-registry>
PROJECT_ESCROW_ADDRESS=<current-testnet-escrow>
SUPABASE_URL=<supabase-project-url>
SUPABASE_SERVICE_ROLE_KEY=<server-only-secret>

AGENT_RUNNER_URL=http://<agent-runner-private-domain>
AGENT_RUNNER_INTERNAL_TOKEN=<same-token-as-agent-runner>
AI_EMBEDDING_ENABLED=false
# AI_GATEWAY_URL=http://<ai-gateway-private-domain>
# AI_GATEWAY_INTERNAL_TOKEN=<same-token-as-ai-gateway>
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

只有 AI Gateway 持有模型 Key；只有 Workflow Runner 持有钱包私钥和 Supabase Service Role。`AI_EMBEDDING_ENABLED=true` 前，必须先在 AI Gateway 配置 `AI_EMBEDDING_MODEL`，并为 Workflow Runner 配置上面的 AI Gateway 私有地址和内部令牌。

Workflow Runner 固定启用三个生成 lane。日志出现 `Mindmark Workflow Runner: 6 isolated roles configured` 表示启动成功。

## 7. 钱包和资金

- 学习者钱包需要少量 Testnet MON 支付 Registry 登记交易 Gas。
- Coordinator、三个 Worker 和 Reward Treasury 钱包需要足够 Testnet MON。
- Reward Treasury 不得复用 Coordinator 或 Worker 钱包。
- 私钥不得写入 Web、AI Gateway 或 Agent Runner。

## 8. 公网 Smoke Test

1. 确认 AI Gateway 和 Agent Runner 的 `/health/ready` 均为 `200`。
2. 未登录可打开首页和 `/learn/packs`。
3. 完成钱包连接、SIWE 登录和退出。
4. 上传不超过 15 MB、30 页的文本型 PDF。
5. 完成 Outline 并确认 Chapter。
6. 学习者钱包完成 Monad Testnet Project 登记。
7. Workflow Runner 完成生成、质量检查、组装、最终确认和奖励。
8. PDF 内 AI Tutor 能流式回答并返回有效引用。
9. `/verify/[projectId]` 能读取 Registry、Escrow 和 Reward 证据。
10. 重启 Workflow Runner，确认没有丢失或重复执行已完成任务。

Smoke Test 通过后再绑定自定义域名。完全开放前应增加项目创建额度和 `/api/monad-rpc` 共享限流。
