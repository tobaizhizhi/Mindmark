# Step 9-11 验证、学习与部署手册

## 1. 生成与验证

创建 Journey 后，Web 每 3 秒读取一次鉴权状态 API，直到 `READY` 或 `CANCELLED`。
进度表只展示数据库和 receipt 中的真实状态，不计算或模拟百分比。

“验证卡组”会在浏览器直接读取 Registry：

1. 重算卡片正文 Hash 和确定性 cardId；
2. 校验每张卡的 chunk proof；
3. 对照 Worker 地址、sourceChunkHash、cardsRoot 和 cardCount；
4. 重算 deckRoot 并对照链上 READY Journey。

只有三种结果：`全部匹配`、`部分不匹配`、`无法验证：缺少数据`。该结果证明 Hash
一致，不证明知识内容一定正确。没有重新选择原 PDF 时，不宣称重新验证了原资料正文。

## 2. FSRS 与 Plan v2

Review API 使用固定的 `ts-fsrs` 参数，四档评分对应 Again、Hard、Good、Easy。
`submit_learning_review` 在数据库行锁内校验 owner、卡片和旧 FSRS 状态，再同时写 ReviewLog
与新状态。唯一键保证重复请求返回第一次结果而不二次推进。

Session 完成后计算 7 日 due forecast。高遗忘率、重要卡遗忘、连续薄弱标签、单日到期超过
15 或每 3 个 Session 会触发 Plan v2。Plan v2 只更新 Supabase；失败时今日队列仍按 FSRS
到期顺序工作。

## 3. 并发对照

额外配置：

```text
BENCHMARK_LEARNER_PRIVATE_KEY
BENCHMARK_RUNS=5
BENCHMARK_OUTPUT=artifacts/commit-concurrency.json  # 相对 apps/agent-runner
```

运行：

```bash
pnpm --filter @mindmark/agent-runner benchmark:commits
```

Mode A 为同一 Worker 预分配连续 nonce 后同时广播；Mode B 为三个 Worker 使用独立 nonce
同时广播。每种模式使用不同 Journey，三笔 calldata 结构与数量保持一致。报告保留 sender、
nonce、提交/receipt 时间、区块、Gas 和状态，并只给出确认时间中位数与范围。

## 4. 部署顺序

1. 创建 Supabase 项目并按文件名顺序执行全部 migrations。
2. 创建 Coordinator、三个 Worker 和演示 Learner 钱包，充值赛事测试 Gas。
3. 部署 Registry，记录 chain ID、合约地址和部署区块。
4. 配置并启动 Runner，核对启动时的钱包 allowlist 检查。
5. 配置并部署 Web，确认 service role 和私钥未进入浏览器构建。
6. 每种并发模式至少运行 5 次并保存原始 JSON。
7. 使用生产 URL 连续完成至少 3 次上传到复习，全流程彩排至少 5 次。
8. 填写 README 的公共 URL、合约、Agent 地址和部署区块后冻结版本。

## 5. 故障彩排

- 停止 Runner 后创建 Journey，再启动并确认事件重放恢复。
- 让一个 Worker 模型超时，确认另外两个 chunk 保持 `CONFIRMED`。
- 在 `SAVED` 后临时断开 RPC，恢复后确认没有重新生成卡片。
- 修改数据库最终卡片副本，确认浏览器显示“部分不匹配”。
- 重复提交同一评分，确认 ReviewLog 和 FSRS 只变化一次。
- 让 Finalizer 失败，确认学习 Tab 不开放。
- 让 Plan v2 更新失败，确认 FSRS 到期队列仍可使用。

远程部署、公共 URL、生产交易和五次生产彩排需要实际赛事凭据；本地测试不能替代这些证据。
