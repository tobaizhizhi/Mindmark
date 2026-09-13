# Python AI 服务迁移边界

当前迁移采用可回滚的分阶段边界：

```text
Next.js Web ──Tutor HTTP/SSE──────┐
                                  ▼
TypeScript Workflow Runner ──> Python Agent Runner ──> Python AI Gateway
        │                    领域 LangGraph、Prompt、重试      ▲
        ├── Embedding HTTP────────────────────────────────────┘
        └── Supabase Workflow Jobs、确定性校验、Monad、Moss
```

## 已迁移

- `apps/ai-gateway/`：Python 3.12 标准库 HTTP 服务。
  - `POST /v1/tool-calls`
  - `POST /v1/tool-calls/stream`
  - `POST /v1/embeddings`
  - `GET /health/live`、`GET /health/ready`
- `apps/agent-runner/`：Python 内部 Module，LangChain 模型 Adapter 继续调用 AI Gateway，LangGraph 负责模型编排和重试。
  - `POST /v1/next-tool`
  - `POST /v1/outline-planning/next-tool`
  - `POST /v1/chapter-design/next-tool`
  - `POST /v1/blueprint-worker/next-tool`
  - `POST /v1/card-quality-evaluations`
  - `POST /v1/chapter-tutor/answers`
  - `POST /v1/chapter-tutor/answers/stream`
  - `GET /health/live`、`GET /health/ready`
- Outline Planning：Python 持有 Prompt 和工具 Schema；TypeScript 保留排除范围、数量、标题、语言和覆盖校验。
- Chapter Design：Python 编排 Concept Inventory 与 Card Blueprint 候选；TypeScript 生成稳定 ID、hash 并持久化。
- V3 Blueprint Worker：Python 生成和修复卡片候选；TypeScript 保留引用落地、commitment、持久化和链上操作。
- Card Quality：Python 负责模型评分；TypeScript Quality Gate 保留最终批准或返工决定。
- Chapter AI Tutor：Python 负责章节内检索、Prompt 和流式解析；Next.js 保留 owner 鉴权、限流、Snapshot 读取和引用回查。
- `packages/ai-client/`：TypeScript 仅用其 Embedding 客户端直连 AI Gateway。
- 模型供应商密钥：只配置在 AI Gateway 服务。

## 暂未迁移

- V2 Work Unit Worker 的旧 Prompt 仍在 TypeScript，仅用于存量 policy v2 项目；新 V3 路径已迁移。
- `apps/workflow-runner/` 的 Supabase persistence、Monad/viem、Moss simulator、钱包私钥和确定性状态机不迁移。
- Workflow Job 仍由 Supabase 承载；Web 通过现有 Supabase RPC 入队，Workflow Runner 轮询并执行。
- LangGraph 状态随 HTTP transcript/observation 重建，不取代 Supabase Workflow Job，也不持有业务事实。

## 本地运行

```bash
pnpm setup:python
PYTHONPATH=apps/ai-gateway/src PORT=8101 .venv/bin/python -m mindmark_ai_gateway.app
PORT=8102 .venv/bin/python -m mindmark_agent_runner.app
pnpm --filter @mindmark/web dev
pnpm --filter @mindmark/workflow-runner dev
```

## 安全约束

- AI Gateway、Agent Runner 和 Workflow Runner 使用内部 Bearer Token。
- AI Gateway 与 Agent Runner 不接触 Monad 私钥。
- Workflow Runner 不接触模型供应商 API Key。
- Web 和 Workflow Runner 不接触模型供应商 API Key；它们只持有对应 Python Module 的内部令牌。
- 内部服务不得使用 `NEXT_PUBLIC_` 环境变量。
