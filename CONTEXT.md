# Mindmark Chapter-first Learning Context

Mindmark turns uploaded material into AI-planned Chapters, generates cited Knowledge Cards through internal Work Units, and independently settles a small MON reward for each Worker whose Work Unit commitment is confirmed. This context keeps the learning state machine and the reward state machine distinct.

## Language

**Learning Project**:
A user-owned learning space whose uploaded source becomes an approved Chapter outline, cited Knowledge Cards, and chapter-scoped study progress.
_Avoid_: job, order, campaign

**Workflow Job**:
A recoverable Supabase queue record that schedules one Runner action for a Learning Project. It has a lease, bounded retries, and operational events; it is never learner-facing content.
_Avoid_: Chapter, Work Unit, learning task

**Chapter**:
A stable, user-visible learning unit planned from a contiguous range of Source Blocks. A Chapter owns its Knowledge Cards and can become ready independently.
_Avoid_: Chunk, Worker task, visual group

**Source Block**:
A deterministic, ordered paragraph, heading, or code block produced from uploaded material and used to validate Chapter coverage and card citations.
_Avoid_: Chapter, page blob

**Work Unit**:
An internal execution shard contained by exactly one Chapter. Work Units exist for Worker scheduling and commitments and are not part of the learner navigation.
_Avoid_: Chapter, user section

**Knowledge Card**:
A cited review item that belongs to exactly one Chapter and retains provenance to one source Work Unit.
_Avoid_: Worker result, deck row

**Chapter Progress**:
The chapter-scoped aggregate of total, studied, due, new, and mastered Knowledge Cards.
_Avoid_: Project progress, Worker completion

**Chapter Concept Inventory**:
A versioned, source-grounded account of the concepts a learner must master in one Chapter, including importance, learning objectives, prerequisites, misconceptions, and supporting Source Blocks.
_Avoid_: card list, model thoughts

**Card Blueprint**:
A versioned plan that maps Chapter Concept Inventory concepts to the required kinds, objectives, difficulty, and evidence for Knowledge Cards before the Worker writes learner-visible wording.
_Avoid_: final card content, Work Unit manifest

**Card Blueprint Slot**:
One required or optional Card Blueprint entry assigned to one concept and, after Work Planning, to one Work Unit that can supply its evidence.
_Avoid_: Knowledge Card, learner-facing card position

**Chapter Design Run**:
A recoverable Runner attempt that creates and validates one Chapter Concept Inventory and one Card Blueprint before a Learning Project's Work Unit manifest is frozen.
_Avoid_: Workflow Job, Chapter rewrite

**Worker**:
An isolated Runner role that dynamically claims one Work Unit, generates cited Knowledge Cards within its Chapter, and submits its content commitment with its own wallet.
_Avoid_: Moss agent, payout worker

**Worker Reward**:
An idempotent, fixed-amount MON compensation entitlement created only after a Worker Work Unit commitment is confirmed.
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

- A **Learning Project** contains one to sixteen **Chapters**.
- A **Workflow Job** may plan a Learning Project's Chapter outline before Chapters are confirmed; its outcome is separate from learner progress.
- A **Chapter** contains one or more **Work Units**, and a Work Unit never crosses Chapter scope.
- A **Learning Project** contains no more than forty-eight Work Units.
- A **Knowledge Card** belongs to exactly one Chapter and retains one Work Unit provenance.
- **Chapter Progress** is derived from Knowledge Cards and their per-card FSRS state.
- A **Chapter Design Run** creates one versioned **Chapter Concept Inventory** and **Card Blueprint** for a confirmed Chapter.
- A **Card Blueprint Slot** maps one concept to evidence within one Work Unit before a Worker generates its Knowledge Card candidate.
- A confirmed Work Unit creates exactly one **Worker Reward**.
- A **Worker Reward** names exactly one Worker recipient and one Reward Treasury intent.
- A **Settlement Agent** may settle a Worker Reward after its Chapter or Learning Project is already `READY`.
- **Moss Verification** produces an unsigned transaction; only the **Reward Treasury** signer may sign and broadcast it.
- A failed Worker Reward never moves a Chapter or Learning Project out of `READY`.

## Example dialogue

> **Dev:** "When does the Settlement Agent pay a Worker?"
>
> **Domain expert:** "Only after the Work Unit receipt is confirmed and the Worker address matches the Registry commitment. Moss verifies the exact native transfer, then the independent Reward Treasury broadcasts it."
>
> **Dev:** "Does a blocked Moss simulation make the Learning Project fail?"
>
> **Domain expert:** "No. The reward becomes `BLOCKED` for operator review; Chapter and Learning Project learning state remain unchanged."

## Flagged ambiguities

- "Agent" can mean a model-driven Worker or the Settlement Agent. In code, use the role-specific term.
- "Chapter" and "Work Unit" are not aliases. Chapter is learner-facing structure; Work Unit is internal execution structure.
- "Moss execution" is misleading: Moss never signs or broadcasts. Use **Moss Verification** for its actual role.
