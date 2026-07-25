# Mindmark Learning Settlement Context

Mindmark turns cited source chunks into a verifiable learning journey and independently settles a small MON reward for each Worker whose chunk commitment is confirmed. This context keeps the learning state machine and the reward state machine distinct.

## Language

**Learning Journey**:
A user-owned learning project whose content moves from preparation to a Monad-anchored ready deck.
_Avoid_: Job, order, campaign

**Worker**:
An isolated Runner role that generates cited cards for one source chunk and submits its content commitment with its own wallet.
_Avoid_: Moss agent, payout worker

**Worker Reward**:
An idempotent, fixed-amount MON compensation entitlement created only after a Worker chunk commitment is confirmed.
_Avoid_: Token reward, payment promise

**Settlement Agent**:
The Runner role that consumes Worker Reward records, verifies the on-chain recipient, and coordinates Moss simulation with the independent Reward Treasury signer.
_Avoid_: Coordinator, Moss signer

**Moss Verification**:
The four stock Moss phases `discover`, `load`, `action`, and `simulate` plus Mindmark's exact plan/effect checks before signing.
_Avoid_: Moss execution, Moss payment

**Reward Treasury**:
An independent EOA that signs and broadcasts the already verified native MON transfer; it is not the Registry Coordinator and is never controlled by Moss.
_Avoid_: Coordinator wallet, contract treasury

## Relationships

- A **Learning Journey** contains two to twelve source chunks.
- A confirmed source chunk creates exactly one **Worker Reward**.
- A **Worker Reward** names exactly one Worker recipient and one Reward Treasury intent.
- A **Settlement Agent** may settle a Worker Reward after the Learning Journey is already `READY`.
- **Moss Verification** produces an unsigned transaction; only the **Reward Treasury** signer may sign and broadcast it.
- A failed Worker Reward never moves a Learning Journey out of `READY`.

## Example dialogue

> **Dev:** "When does the Settlement Agent pay a Worker?"
>
> **Domain expert:** "Only after the chunk receipt is confirmed and the Worker address matches the Registry commitment. Moss verifies the exact native transfer, then the independent Reward Treasury broadcasts it."
>
> **Dev:** "Does a blocked Moss simulation make the Journey failed?"
>
> **Domain expert:** "No. The reward becomes `BLOCKED` for operator review; the Learning Journey keeps its own confirmed or ready state."

## Flagged ambiguities

- "Agent" can mean a model-driven Worker or the Settlement Agent. In code, use the role-specific term.
- "Moss execution" is misleading: Moss never signs or broadcasts. Use **Moss Verification** for its actual role.
