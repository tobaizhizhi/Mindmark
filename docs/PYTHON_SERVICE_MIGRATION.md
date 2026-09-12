# Python AI 服务迁移边界

当前迁移采用可回滚的分阶段边界：

```text
Next.js Web ──private HTTP──> Python AI Gateway
                                  ▲
TypeScript Workflow Runner ──HTTP─┘
        │
        └── Supabase Workflow Jobs、确定性校验、Monad、Moss
```

## 已迁移

- `apps/ai-gateway/`：Python 3.12 标准库 HTTP 服务。
  - `POST /v1/tool-calls`
  - `POST /v1/tool-calls/stream`
  - `POST /v1/embeddings`
  - `GET /health/live`、`GET /health/ready`
- `apps/agent-runner/`：Python 内部服务，负责 transcript 转换、Agent profile 和 AI Gateway 重试。
  - `POST /v1/next-tool`
  - `POST /v1/embeddings`
  - `GET /health/live`、`GET /health/ready`
- `packages/ai-client/`：TypeScript HTTP 客户端，不再直连模型供应商。
- Web Chapter AI Tutor：只调用 AI Gateway，不再读取 `AI_API_KEY`。
- 模型供应商密钥：只配置在 AI Gateway 服务。

## 暂未迁移

- `apps/workflow-runner/` 仍是 TypeScript，因为它包含 Supabase persistence、Monad/viem、Moss simulator、钱包私钥和现有确定性状态机。
- Workflow Job 仍由 Supabase 承载；Web 通过现有 Supabase RPC 入队，Workflow Runner 轮询并执行。
- Python Agent Runner 当前是模型执行边界，不是完整的链上 Workflow Runner 重写。

## 本地运行

```bash
PYTHONPATH=apps/ai-gateway/src PORT=8101 python3 -m mindmark_ai_gateway.app
PYTHONPATH=apps/agent-runner/src PORT=8102 python3 -m mindmark_agent_runner.app
pnpm --filter @mindmark/web dev
pnpm --filter @mindmark/workflow-runner dev
```

## 安全约束

- AI Gateway、Agent Runner 和 Workflow Runner 使用内部 Bearer Token。
- AI Gateway 与 Agent Runner 不接触 Monad 私钥。
- Workflow Runner 不接触模型供应商 API Key。
- 内部服务不得使用 `NEXT_PUBLIC_` 环境变量。
