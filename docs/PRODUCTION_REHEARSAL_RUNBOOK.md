# Mindmark V2 生产演练手册

> 范围：Supabase、Monad 测试网、Web、Runner 和运营诊断  
> 前提：旧数据库内容已经明确允许丢弃  
> 禁止：在未备份、未暂停写入或未核对目标 Project 的情况下重建远程数据库

## 1. 上线前闸门

在仓库根目录执行：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
forge test
git diff --check
```

所有命令必须成功。不得用本地 PGlite 测试代替真实 Supabase smoke test，也不得用本地合约测试代替测试网 receipt。

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
5. 按文件名顺序执行 `supabase/migrations` 中的全部 V2 migration。
6. 核对最终 schema 包含 `workflow_jobs`、`workflow_events` 和 `get_workflow_operations_v2()`，且不包含 V1 Journey/Chunk 表或扫描式 `claim_next_*` RPC。
7. 使用 service role 调用一次 `get_workflow_operations_v2()`；初始结果应满足 `staleJobs = 0`、`failedJobs = 0`。

这一步是数据库重建，不是旧数据迁移。执行任何远程删除前必须保留当次确认记录。

## 4. 部署 V2 Registry

使用独立部署钱包运行：

```bash
forge script contracts/script/DeployLearningProjectRegistryV2.s.sol:DeployLearningProjectRegistryV2 \
  --rpc-url "$MONAD_RPC_URL" \
  --broadcast
```

部署后记录 chain ID、合约地址和交易哈希。将同一个 `REGISTRY_V2_ADDRESS` 配置到 Web 与 Runner，确认合约的 Coordinator 和三个 Worker allowlist 与本地配置一致。

## 5. 启动顺序

1. 配置并启动 Web，先访问 `/learn` 完成钱包登录。
2. 使用白名单运营钱包访问 `/operations`，确认页面可读且其他钱包返回 `403 operator_access_required`。
3. 启动 Runner。启动时的钱包检查必须通过。
4. 上传一份文本型 PDF，等待 `PLAN_OUTLINE` 完成并确认 Chapter 大纲。
5. 完成 Monad Project 创建交易，然后观察 `RECONCILE_PROJECT`、`GENERATE_WORK_UNIT`、`QUALITY_CHECK_CHAPTER`、`ASSEMBLE_CHAPTER` 和 `FINALIZE_PROJECT`。
6. 至少完成一张 Knowledge Card 的复习并刷新页面，确认 FSRS 状态没有回退。
7. 核对 Reward 失败不会把已经 `READY` 的 Chapter 或 Project 改回失败。

## 6. 故障注入

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

## 7. 运营阈值

`/operations` 每 15 秒读取一次脱敏快照。以下任一值非零即需要人工处理：

- `staleJobs`：Runner 停机、处理超时或租约恢复异常。
- `failedJobs`：job 已达到最大重试次数。
- `blockedRewards`：Moss/recipient/treasury 验证不匹配。
- `failedProjects`：用户可见 Project 已进入可重试失败状态。

告警只显示 ID、状态、计数和受限错误摘要，不得把 Source Block、卡片正文、Prompt、私钥或 signed transaction 写入日志。

## 8. 开放上传入口

只有以下证据齐全时才能结束维护窗口：

1. 空库 migration chain 和 RLS smoke test 通过。
2. V2 Registry 地址及钱包 allowlist 已核对。
3. 一份真实 PDF 已完成“资料 -> 多 Chapter -> 多 Knowledge Card -> 复习 -> 刷新恢复”。
4. 六项核心故障注入均已恢复或按设计阻塞。
5. `/operations` 没有 stale/failed job 告警。
6. Web 和 Runner 日志中没有 Secret 或用户资料正文。

生产演练需要真实外部凭据和测试网 Gas；仓库内测试通过不能替代本节证据。
