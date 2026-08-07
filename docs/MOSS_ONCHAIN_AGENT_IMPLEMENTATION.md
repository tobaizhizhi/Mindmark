# Moss Onchain Agent 实施文档

## 1. 实施结果

Mindmark 现在把 Moss 从后台 SDK 依赖提升为两条可见的链上安全能力：

1. `Worker Reward Moss Review`：公开验证页展示 Reward 的结构化意图、Capability、四阶段、Plan Hash、模拟结果、Warnings、预期资产变化和签名边界。
2. `Completion Claim Moss Review`：学习者领取完成凭证前，服务端使用自定义 `mindmark-learning.claimCompletion` Capability 完成 `discover → load → action → simulate`；只有无 revert、无 Warning、无意外资产变化时才把审阅结果交给浏览器，学习者再次确认后由钱包签名。

Moss 始终不接触私钥、不签名、不发送交易。Reward 由独立 Reward Treasury 签名；Completion Claim 由学习者钱包签名。

## 2. 历史 P0：直接 Reward 结算修复

本节记录 2026-08-05 的直接转账实现与验收。2026-08-07 起，新项目使用 Project Sponsor Escrow；直接 `erc20.transfer` 不再是当前 Reward 路径。

### 2.1 根因

`viem.parseTransaction()` 解析一笔无 calldata 的原生 MON 转账时，`data` 为 `undefined`，不是字符串 `"0x"`。旧校验硬性要求：

```ts
parsed.data === "0x"
```

因此合法交易在 Moss 模拟通过、Treasury 签名之后，仍会被误判为：

```text
Persisted signed transaction does not match reward intent
```

修复后把 `undefined` 与 `"0x"` 统一解释为无 calldata；任意非空 calldata 仍会被阻止。签名者、recipient、amount、nonce、chain ID、tx hash 等校验未放宽。

### 2.2 真实链上验收

2026-08-05 在 Monad Testnet 完成一笔真实 Reward：

- Project：`0x7c7675f9aebf531370501595cac419d7783d973445f46ced49f148577c2db800`
- Work Unit：`0`
- 金额：`0.001 MON`
- Moss：`SIMULATED / PASSED`
- Warning：`0`
- Transaction：`0xda2b479126ba7e9d94f0788d6904c2c0875b9690f2cd5b21888c7909e4086367`
- Block：`51112632`
- Gas Used：`21165`
- Confirmation：`4224ms`

只恢复并结算了 `WU.00`。另外四笔历史误判记录继续保持 `BLOCKED`，避免一次性产生多笔外部转账。

### 2.3 安全恢复

迁移 `20260805000200_retry_blocked_moss_rewards.sql` 新增 service-role 专用函数：

```sql
public.retry_blocked_work_unit_reward_v2(project_id, work_unit_id)
```

恢复时会清空：

- 旧 signed transaction
- 旧 Treasury nonce
- 旧 tx hash
- 旧 Moss Plan 和 simulation 数据

随后重新入队，必须再次走完整 Moss Verification。不能直接重播历史签名，因为多笔从未广播的交易可能共享相同 nonce。

## 3. 网络兼容策略

项目固定依赖：

```text
@themoss/core@0.1.0
@themoss/simulator@0.1.0
```

Moss 当前官方文档声明只支持 Monad Mainnet `143`。已发布的 `0.1.0` Runtime 接受显式 chain ID，Mindmark 已在 Monad Testnet `10143` 完成模拟和真实结算。

Mindmark 对此采用明确策略：

| Chain ID | 标记 | 行为 |
| --- | --- | --- |
| `143` | `OFFICIAL_MAINNET` | Moss 官方 Mainnet |
| `10143` | `EXPERIMENTAL_TESTNET` | Mindmark 实验性 Testnet 兼容 |
| 其他 | 不支持 | Runner 和 Reviewer 拒绝运行 |

Testnet 可用于黑客松演示，但不得表述为 Moss 官方 Testnet 支持。Runner 启动时打印兼容警告，公开验证页也展示该状态。

## 4. Worker Reward Moss Review

### 4.1 执行链

```text
confirmed Work Unit
  -> Worker Reward intent
  -> Moss discover mindmark-escrow.releaseWorkUnitReward
  -> Moss load params + fundOut risk
  -> Moss action creates sealed Plan
  -> Mindmark verifies exact Project/Work Unit/Escrow calldata
  -> Moss simulate
  -> Mindmark verifies planHash/warnings/RewardReleased observation/gas
  -> Reward Treasury prepares and signs
  -> signed transaction is verified again
  -> broadcast + confirmed transaction verification
```

### 4.2 公开字段

每笔 Reward 公开以下审阅证据：

- SDK version 与 network support。
- 结构化 intent。
- `mindmark-escrow.releaseWorkUnitReward` Capability、`transfer` verb 和 `fundOut` risk。
- 当前 Moss stage。
- Plan Hash 与空 calldata hash。
- simulation status、Warning codes、gas。
- expected native MON outflow、recipient、approval count。
- signer authority：`REWARD_TREASURY`。

签名交易本体不会暴露在公开页面。

## 5. Completion Claim Moss Review

### 5.1 自定义 Capability

Protocol：`mindmark-learning`

Capability：`claimCompletion`

Verb：`claim`

输入：

- Completion Registry address
- Project ID
- progress hash
- authorization deadline
- Completion Attestor signature

Moss `0.1.0` 要求每个 Capability 至少声明一个 risk label，因此该操作保守声明 `fundOut`。Plan 的量化预期仍为 `0 MON` outflow、`0` approvals，模拟也必须观测到零资产变化。这个声明是风险上界，不代表交易实际转账。

### 5.2 签名门

浏览器拿到审阅结果前，服务端必须验证：

- RPC chain ID 与配置一致。
- discover 命中唯一目标 Capability。
- load 返回预期参数和 `fundOut` 风险上界。
- Plan 的 protocol、method、verb、account、target、calldata、value 全部与 authorization 一致。
- Plan 未声明资产流出、流入、approval 或 NFT 变化。
- simulation 不 revert、不 halt、Plan Hash 有效且 Warning 数为零。
- simulation 实际 effects 中没有资产、approval、recipient 或 NFT 变化。

审阅通过后，UI 才显示“确认并唤起钱包”。授权过期后必须重新模拟。

## 6. 用户界面

### 6.1 签名前审阅抽屉

抽屉显示：

- Monad chain 与 Moss 兼容标记。
- 原始结构化意图和 Capability。
- Discover、Load、Action、Simulate 四阶段。
- learner、target contract、MON outflow、approval count、gas、Warnings。
- Plan Hash 与 calldata hash。
- “Moss 不签名、不发送，学习者钱包保留最终签名权”的执行边界。

### 6.2 公开验证页

Reward 主列表保持紧凑。每笔记录可展开 Moss 审阅证据，不展开时仍可快速比较 Treasury、recipient、amount、tx hash 和链上证据状态。

## 7. 经济模型边界

当前 `0.001 MON` 是 `work-unit-pricing-v1` 的演示性定价基数；每个 Work Unit 在生成前按 `S/M/L/XL` 冻结不同报价。它不是：

- AI API 成本
- 课程购买费用
- 学习者学费
- 开放市场报价

三个 Worker 仍由同一 Runner 部署管理，所以当前产品是“可验证多 Agent 结算原型”，不是去中心化 Worker 市场。2026-08-07 已加入项目级 Sponsor Escrow：它保证生成前预算与结算收款人，不扩展为开放 Worker 市场、竞价或争议仲裁。

## 8. 部署与演示前检查

1. 应用 Supabase migration `20260805000200_retry_blocked_moss_rewards.sql`。
2. 保持 Moss 版本精确锁定，不自动升级。
3. 确认 Web、Runner、钱包配置使用同一个 chain ID。
4. 部署 `LearningCompletionRegistry`，配置独立 Completion Attestor。
5. 配置 `COMPLETION_REGISTRY_ADDRESS`、`NEXT_PUBLIC_COMPLETION_REGISTRY_ADDRESS` 和 `COMPLETION_ATTESTOR_PRIVATE_KEY`。
6. 重启 Web 后，完成凭证入口和 Moss 审阅抽屉才会启用。
7. 公开验证页检查真实 Reward tx、Plan Hash、simulation passed 和零 Warning。

当前 Completion Registry 尚未在本地 `.env` 配置，因此领取控件仍按设计隐藏；Reward Moss Review 与公开证据不受影响。
