# Mindmark V2 + Card Pack 生产演练手册

> 范围：Supabase、Monad 测试网、Web、Runner 和运营诊断  
> 前提：旧数据库内容已经明确允许丢弃  
> 禁止：在未备份、未暂停写入或未核对目标 Project 的情况下重建远程数据库

## 1. 上线前闸门

在仓库根目录执行：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @mindmark/shared build
pnpm --filter @mindmark/ai-gateway build
pnpm --filter @mindmark/agent-runner build
pnpm --filter @mindmark/web build
forge test
git diff --check
```

Shared build 必须先完成，再构建 Runner/Web，避免 Shared 清理 `dist` 时产生声明文件竞态。所有命令必须成功。不得用本地 PGlite 测试代替真实 Supabase smoke test，也不得用本地合约测试代替测试网 receipt。

## 2. 需要准备的地址和 Secret

- 一个 Web/learner 钱包。
- 一个 Registry Coordinator 钱包。
- 三个相互独立的 Worker 钱包。
- 一个不能复用 Coordinator 或 Worker 的 Reward Treasury 钱包。
- 一个或多个运营钱包，配置到 `OPERATOR_WALLET_ADDRESSES`。
- 已充值的 Monad 测试网余额、Supabase service role key、模型 API key 和至少 32 字节的 Session Secret。

私钥、service role key、模型 key 和 Session Secret 只能出现在服务端环境中，不能使用 `NEXT_PUBLIC_` 前缀，也不能提交到 Git。

## 3. 重建可丢弃的 Supabase

1. 暂停 Web 上传入口并停止 Runner。
2. 在目标 Supabase 项目中记录 `learning_projects` 数量，再次确认数据可以清空。
3. 导出一次加密备份，仅用于事故回看。
4. 清空目标项目的 `public` schema 和旧 migration history。
5. 按文件名顺序执行 `supabase/migrations` 中的全部 migration，最后一份必须是 `20260807000200_generation_failure_recovery.sql`。该文件可重复执行；已有环境需要重新执行更新后的完整文件，以修正 V3 已接受候选卡的 Work Unit 确认判断。
6. 刷新 PostgREST Schema Cache；最后一份 migration 已包含 `notify pgrst, 'reload schema'`，远端控制台执行后仍需等待 Cache 生效。
7. 使用 service role 调用 `get_schema_capabilities_v1()`，要求 `schemaVersion = 2026-08-07.2`，六项 capability（包括动态定价 `sponsorEscrow`）全部为 `true`、`missing = []`。`originalPdfStorage=true` 同时表示 `learning-source-files` 为私有 bucket、上限 15 MB 且只允许 `application/pdf`。
8. 核对最终 schema 包含 `workflow_jobs`、`workflow_events`、`get_workflow_operations_v2()` 和 `retry_failed_project_generation_v2(text,text)`，且不包含 V1 Journey/Chunk 表或扫描式 `claim_next_*` RPC。
9. 使用 service role 调用一次 `get_workflow_operations_v2()`；初始结果应满足 `staleJobs = 0`、`failedJobs = 0`。

这一步是数据库重建，不是旧数据迁移。执行任何远程删除前必须保留当次确认记录。

## 4. 部署 V2 Registry

使用独立部署钱包运行：

```bash
forge script contracts/script/DeployLearningProjectRegistryV2.s.sol:DeployLearningProjectRegistryV2 \
  --rpc-url "$MONAD_RPC_URL" \
  --broadcast
```

部署后记录 chain ID、合约地址和交易哈希。将同一个 `REGISTRY_V2_ADDRESS` 配置到 Web 与 Runner，确认合约的 Coordinator 和三个 Worker allowlist 与本地配置一致。

### 4.1 可选：部署学习完成凭证合约

为 Completion Attestor 单独生成钱包并配置 `COMPLETION_ATTESTOR_ADDRESS`。该地址不能与 Deployer、Coordinator、Worker 或 Reward Treasury 重用。然后运行：

```bash
forge script contracts/script/DeployLearningCompletionRegistry.s.sol:DeployLearningCompletionRegistry \
  --rpc-url "$MONAD_RPC_URL" \
  --broadcast
```

部署后先读取 `sourceRegistry()` 和 `attestor()`，确认它们分别等于当前 `REGISTRY_V2_ADDRESS` 和 `COMPLETION_ATTESTOR_ADDRESS`。再配置：

```text
COMPLETION_REGISTRY_ADDRESS=<deployed address>
COMPLETION_ATTESTOR_PRIVATE_KEY=<server only>
NEXT_PUBLIC_COMPLETION_REGISTRY_ADDRESS=<same deployed address>
```

若暂不演示学习完成凭证，三个配置保持为空。不得只配置浏览器地址或把 Attestor 私钥加上 `NEXT_PUBLIC_` 前缀。

## 5. 启动顺序

1. 配置并启动 Web。Web Node Runtime 会先调用 Schema Capability RPC；若返回 `deployment_schema_outdated`，停止发布并补齐 migration，不得继续接收上传。
2. 使用白名单运营钱包访问 `/operations`，确认页面可读且其他钱包返回 `403 operator_access_required`。
3. 启动 Runner。Runner 必须先通过 Schema Capability 预检，再通过钱包检查；任何一步失败都不得开始 claim Workflow Job、调用 AI 或发送链上交易。
4. 上传一份文本型 PDF，等待 `PLAN_OUTLINE` 完成并确认 Chapter 大纲。
5. 完成 Monad Project 创建交易，然后观察 `RECONCILE_PROJECT`、`GENERATE_WORK_UNIT`、`QUALITY_CHECK_CHAPTER`、`ASSEMBLE_CHAPTER` 和 `FINALIZE_PROJECT`。
6. 至少完成一张 Knowledge Card 的复习并刷新页面，确认 FSRS 状态没有回退。
7. 核对 Reward 失败不会把已经 `READY` 的 Chapter 或 Project 改回失败。

## 6. 预置卡包演示

先确认固定内容可发布；同一版本、同一 hash 可以重复执行发布命令：

```bash
pnpm packs:generate:solidity:v5
pnpm packs:validate
pnpm packs:publish
curl http://localhost:3000/api/packs
```

目录接口必须默认返回 `solidity-foundations@5.0.0`、16 个 Chapter 和 112 张 Knowledge Card，其中 48 张包含可渲染的 Solidity 练习。详情接口还必须返回每章的 `learningObjectives`、`prerequisiteChapterIds`、阶段、项目里程碑和 `readingBlocks`；第 2 章依赖第 1 章，第 16 章为错误处理综合审查。远程数据库必须按顺序执行六个卡包 migration，最后一份为 `20260802000300_card_pack_reading_v5.sql`。

1. 未登录访问 `/learn/packs`，确认可以浏览卡包目录和章节预览。
2. 使用钱包 A 登录，打开“Solidity 101 循序渐进实战”，点击“添加到我的学习”。
3. 确认直接进入 `READY` 的 PACK Learning Project，没有 AI 生成、Runner 等待或 Monad 交易步骤。
4. 打开一张写代码、补全或修错卡，确认题目代码在揭晓前可见，参考写法和运行结果只在揭晓后出现。
5. 立即复习一张卡并评分，刷新页面后确认 FSRS 进度保留。
6. 再次添加同一版本，必须返回原 Learning Project，不能复制第二份卡片实例。
7. 使用钱包 B 安装同一卡包并评分，确认钱包 A 的已学、到期和新卡数量不受影响。
8. 停止 Runner 后再安装一次卡包，安装与复习仍应可用；数据库中不得为 PACK Project 创建 Workflow Job 或 Work Unit。

PACK 卡片必须显示外部或作者参考来源，不显示伪造 PDF 页码；PACK Project 页面不得显示重新分析、发送 Monad 交易或 AI 生成状态。

## 7. 故障注入

每项故障都使用新的测试 Project，并保存 Project ID、job ID、request ID、交易哈希和恢复时间。

| 故障 | 注入方式 | 必须观察到的结果 |
| --- | --- | --- |
| 模型不可用 | 临时使用无效模型地址 | Outline 使用确定性降级；Work Unit job 可重试且不产生伪造卡片。 |
| Runner 重启 | job 进入 `RUNNING` 后停止 Runner 超过 90 秒 | 租约进入运营告警，重启后由通用 job recovery 恢复。 |
| 浏览器回调丢失 | Project 交易确认后关闭浏览器 | `RECONCILE_PROJECT` 根据链上事实推进，不要求重复交易。 |
| Monad RPC 超时 | 在提交窗口临时阻断 RPC | 已保存候选内容不丢失；恢复后只重试同一资源。 |
| 质量修复 | 让两个 Work Unit 返回重复问题 | Quality Gate 请求修复，不提交不满足最小卡数的 commitment。 |
| 奖励验证失败 | 使用与 commitment 不一致的收款意图 | Reward 进入 `BLOCKED`，学习内容保持 `READY`。 |
| 重复评分 | 重发同一 session/card 请求 | ReviewLog 与 FSRS 只推进一次。 |
| Schema 落后 | 在未执行最终 capability migration 的测试库启动 Web/Runner | 启动或请求明确失败为 `deployment_schema_outdated`，日志指向 `20260803000100_schema_capabilities.sql`，不进入 AI/Monad 工作。 |

## 8. 运营阈值

`/operations` 每 15 秒读取一次脱敏快照。以下任一值非零即需要人工处理：

- `staleJobs`：Runner 停机、处理超时或租约恢复异常。
- `failedJobs`：job 已达到最大重试次数。
- `blockedRewards`：Moss/recipient/treasury 验证不匹配。
- `failedProjects`：用户可见 Project 已进入可重试失败状态。

告警只显示 ID、状态、计数和受限错误摘要，不得把 Source Block、卡片正文、Prompt、私钥或 signed transaction 写入日志。

## 9. 开放上传入口

只有以下证据齐全时才能结束维护窗口：

1. 空库 migration chain 和 RLS smoke test 通过。
2. V2 Registry 地址及钱包 allowlist 已核对。
3. 一份真实 PDF 已完成“资料 -> 多 Chapter -> 多 Knowledge Card -> 复习 -> 刷新恢复”。
4. 预置卡包已完成“发现 -> 预览 -> 添加 -> 复习”，且双钱包进度隔离。
5. 七项核心故障注入均已恢复或按设计阻塞。
6. `/operations` 没有 stale/failed job 告警。
7. Web 和 Runner 日志中没有 Secret 或用户资料正文。

生产演练需要真实外部凭据和测试网 Gas；仓库内测试通过不能替代本节证据。
