# Project Sponsor Escrow 实施文档

## 目标

Mindmark 不再把 Monad 只用作生成结果的事后哈希展示。每个上传型 Learning Project 在 AI 生成开始前，必须由 Hackathon Sponsor Treasury 在 Monad 锁定完整 Work Unit 预算。

```text
Learner 在 Registry 创建 Project
→ Runner 按冻结的 Blueprint 为每个 Work Unit 生成 S/M/L/XL 报价
→ Sponsor Treasury 按全部报价之和锁定完整预算
→ AI Worker 生成候选卡
→ Chapter Quality Gate 验收
→ Worker 提交已批准 commitment
→ 数据库创建对应冻结报价的 Reward entitlement
→ Moss discover / load / action / simulate Escrow release
→ Sponsor Treasury 签名广播
→ Project Escrow 向 Registry Worker 付款
```

学习者只支付创建 Project 的 Gas，不支付 Worker Reward。PDF、卡片正文和复习状态不上链。

## 链上 Module

`LearningProjectEscrow` 引用不可变的 `LearningProjectRegistryV2`，并提供：

- `fundProject(projectId, rewardAmounts)`：报价数量必须等于 Registry Work Unit 数量，只接受报价总和的精确金额，一个 Project 只能执行一次。
- `workUnitRewardAmounts(projectId, workUnitId)`：公开读取生成前冻结的逐任务奖励。
- `releaseReward(projectId, workUnitId)`：只允许该 Project Sponsor 调用；从 Registry 读取 Worker，并释放该 Work Unit 的冻结报价；每个 Work Unit 只能释放一次。
- `refundCancelledProject(projectId)`：只有 Registry 已取消时才退回未结算余额。
- `ProjectFunded`、`RewardReleased`、`ProjectRefunded`：为公开验证页和 Moss observation 提供事件证据。

合约不保存 PDF、知识卡正文、模型输出、学习进度或 API 成本。

## 数据不变量

- 一个上传型 Learning Project 对应一个 Project Escrow 预算。
- 总预算必须等于所有冻结 Work Unit 报价之和。
- 报价只使用生成前可复核的原文字符数、Blueprint Slot 类型与难度，不使用实际 token、耗时或 Worker 自报工作量。
- `work-unit-pricing-v1` 将工作量分数映射为 `S/M/L/XL`，金额为配置基数的 `0.8/1.2/1.8/2.5` 倍。
- Project 未足额 funding 时不能从 `AWAITING_REGISTRY` 进入 `GENERATING`。
- Work Unit 未处于 `APPROVED / SUBMITTING / CONFIRMED` 或缺少 V3 Quality Gate evidence 时不能创建 Reward。
- commitment confirmation RPC 不接收 Treasury 或金额，条款只能读取对应 Work Unit 的冻结报价。
- Reward settlement 失败不回滚 Chapter 或 Learning Project 的学习状态。

## Moss Capability

Reward 使用自定义 `mindmark-escrow.releaseWorkUnitReward` Capability，不再使用通用 `erc20.transfer`：

- Plan target 必须是配置的 Escrow。
- calldata 必须精确匹配 `releaseReward(projectId, workUnitId)`。
- signer 必须是该 Project Sponsor Treasury。
- signer transaction value 必须为 `0`，资金已在 Escrow 中。
- simulate 必须无 revert、无 Warning、无 Sponsor 钱包意外资产变化。
- Moss observation 必须看到匹配 Project、Work Unit、Worker 和金额的 `RewardReleased`。

Moss 不读取私钥、不签名、不广播。Sponsor Treasury 保留最终签名权。

## 部署顺序

1. 部署或确认 `LearningProjectRegistryV2`。
2. 部署 Project Escrow：

```bash
forge script contracts/script/DeployLearningProjectEscrow.s.sol:DeployLearningProjectEscrow \
  --rpc-url "$MONAD_RPC_URL" \
  --broadcast
```

3. 执行 `supabase/migrations/20260807000100_project_sponsor_escrow.sql`，然后刷新 Supabase Schema Cache。
4. 配置服务端：

```dotenv
PROJECT_ESCROW_ADDRESS=0x...
REWARD_TREASURY_PRIVATE_KEY=0x...
# 定价基数；不是每个 Work Unit 的固定奖励。
WORKER_REWARD_AMOUNT_MON=0.001
```

5. 应用 `20260807000300_dynamic_work_unit_pricing.sql`。
6. 重启 Web 与 Agent Runner。Runner 启动时会验证 Escrow 引用的是当前 `REGISTRY_V2_ADDRESS`。
7. 使用新项目验收；旧版统一单价 Escrow 的 ABI 不兼容，必须重新部署，旧项目也不应伪装成动态定价流程。

## 验收

- `forge test`：资金金额、未 commitment、收款人、重复释放和取消退款。
- Agent Runner tests：Moss Capability、sealed Plan、observation、签名交易与 receipt event。
- Database migration tests：Sponsor Escrow capability、无调用方 Reward 条款、Quality Gate evidence。
- 公开 `/verify/[projectId]`：显示 Sponsor 总预算、剩余预算、funding tx、Escrow 地址和 release 核验结果。
