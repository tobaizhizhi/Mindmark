# Mindmark Chapter-first Learning Context

Mindmark turns uploaded material into AI-planned Chapters, generates cited Knowledge Cards through internal Work Units, and independently settles a small MON reward for each Worker whose Work Unit commitment is confirmed. This context keeps the learning state machine and the reward state machine distinct.

## Language

**Learning Project**:
A user-owned learning space whose uploaded source or installed Card Pack becomes an approved Chapter outline, Knowledge Cards, and chapter-scoped study progress.
_Avoid_: job, order, campaign

**Card Pack**:
A public, versioned, immutable collection of curated learning Chapters and Knowledge Cards. A Card Pack has no learner-specific review state and is installed into a user-owned Learning Project before study.
_Avoid_: uploaded document, Workflow Job, shared review deck

**Card Pack Version**:
An immutable published release of a Card Pack with a manifest hash, content hash, license, Chapters, and Pack Cards. Corrections create a new version instead of mutating an installed version.
_Avoid_: draft project, outline version

**Pack Installation**:
An idempotent owner-scoped operation that copies one published Card Pack Version into a PACK Learning Project and gives the learner independent FSRS progress.
_Avoid_: subscription, AI generation job, chain transaction

**Pack Card**:
A curated Knowledge Card in a Card Pack Version with stable pack provenance and an external or authored source reference; it does not require Work Unit provenance.
_Avoid_: Worker result, generated candidate

**Workflow Job**:
A recoverable Supabase queue record that schedules one Runner action for a Learning Project. It has a lease, bounded retries, and operational events; it is never learner-facing content.
_Avoid_: Chapter, Work Unit, learning task

**Schema Capability**:
A read-only deployment fact that reports whether the current Supabase schema provides the complete Learning Design, Card Pack Reading, Original PDF Storage, and Learner Progress contracts required by this application version.
_Avoid_: feature flag, migration history row, learner progress

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

**Chapter Learning Snapshot**:
An owner-scoped, read-only view of one Chapter's ordered reading blocks and Knowledge Card source links. It can be derived from uploaded Source Blocks or immutable Card Pack lesson blocks and is the grounding input for reading navigation and the Chapter AI Tutor.
_Avoid_: entire PDF, Tutor conversation, review queue

**Chapter AI Tutor**:
A synchronous, read-only learning assistant grounded in one Chapter Learning Snapshot, the learner's current PDF page, and optional selected text. It may return verified citations but never creates Knowledge Cards, changes Chapter content, advances review state, or writes Monad commitments.
_Avoid_: Worker, Chapter Design Agent, card generator

**Study Session**:
A learner-scoped sequence of due and new Knowledge Cards whose revealed answers and ratings update per-card FSRS state. Browsing cards, reading a Chapter, or asking the Chapter AI Tutor does not create or advance a Study Session.
_Avoid_: Chapter, Tutor conversation, Workflow Job

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

**Sponsor Budget**:
A Project-scoped MON budget funded by the Hackathon Sponsor Treasury before AI generation starts. It equals the sum of all frozen Work Unit Reward Quotes and is held by Project Escrow, not by the learner.
_Avoid_: learner payment, model API fee, database credit

**Project Escrow**:
The Monad contract that locks one Sponsor Budget and pricing root, derives each recipient from Registry V2, releases the frozen quote for each committed Work Unit, and refunds only the unsettled balance after Project cancellation.
_Avoid_: course checkout, general Treasury wallet, Worker marketplace

**Worker Reward Quote**:
A deterministic pre-generation `S/M/L/XL` quote derived from frozen source size and Blueprint Slot complexity under a versioned pricing policy.
_Avoid_: token reimbursement, Worker self-report, post-generation estimate

**Worker Reward**:
An idempotent MON compensation entitlement whose amount comes from its frozen Worker Reward Quote and is created only after a quality-approved Worker Work Unit commitment is confirmed.
_Avoid_: Token reward, payment promise

**Settlement Agent**:
The Runner role that consumes Worker Reward records, verifies the on-chain recipient, and coordinates Moss simulation with the independent Reward Treasury signer.
_Avoid_: Coordinator, Moss signer

**Moss Verification**:
The four stock Moss phases `discover`, `load`, `action`, and `simulate` plus Mindmark's exact `mindmark-escrow.releaseWorkUnitReward` calldata, observation, and effect checks before signing.
_Avoid_: Moss execution, Moss payment

**Moss Onchain Review**:
A user-visible, structured projection of Moss Verification containing the original intent, Capability, declared risks, Plan hash, simulation status, Warnings, expected effects, network support, and the wallet that retains final signing authority.
_Avoid_: transaction approval, Moss signature, guaranteed execution

**Reward Treasury**:
An independent Sponsor EOA that funds each Project Escrow and signs the already verified reward-release call; it is not the Registry Coordinator and is never controlled by Moss.
_Avoid_: Coordinator wallet, contract treasury

**Monad Verification Snapshot**:
A public, read-only projection that compares one Learning Project's Registry V2 state with its stored transaction references and Worker Reward settlements without exposing source text, Knowledge Card content, or learner review history.
_Avoid_: Project workspace, operations dashboard, database dump

**Learning Completion Attestation**:
A one-time Monad record claimed by the Learning Project learner after every Knowledge Card in the finalized deck satisfies the current mastery policy. It binds the learner, Project deck root, and a hash of the qualified off-chain learning state.
_Avoid_: course certificate, Project finalization, Study Session completion

**Completion Attestor**:
An independent server-side signer that authorizes a Learning Completion Attestation only after checking owner scope, finalized Project state, full-card mastery, and the exact learning-state hash. It never submits the learner's transaction.
_Avoid_: learner wallet, Registry Coordinator, certificate issuer

## Relationships

- A **Learning Project** contains one to sixteen **Chapters**.
- A **Card Pack** contains immutable **Card Pack Versions**; each version contains one or more Pack Chapters and Pack Cards.
- A **Pack Installation** creates one owner-scoped PACK Learning Project snapshot; later Card Pack Versions never mutate that snapshot.
- A **Workflow Job** may plan a Learning Project's Chapter outline before Chapters are confirmed; its outcome is separate from learner progress.
- Web and Runner must verify all required **Schema Capabilities** before accepting work; a missing capability never becomes a Workflow Job retry.
- A **Chapter** contains one or more **Work Units**, and a Work Unit never crosses Chapter scope.
- A **Learning Project** contains no more than forty-eight Work Units.
- A **Knowledge Card** belongs to exactly one Chapter and retains one Work Unit provenance.
- A **Chapter Learning Snapshot** belongs to one owner-visible Chapter and provides reading and citation context without changing learning content.
- A **Chapter AI Tutor** reads one Chapter Learning Snapshot and never modifies a Knowledge Card or Study Session.
- A **Study Session** consumes Knowledge Cards from one Chapter or Learning Project scope and only advances through explicit learner ratings.
- A PACK Learning Project's Knowledge Cards retain Pack Card provenance instead of Work Unit provenance and never enter the Runner or Monad workflow.
- **Chapter Progress** is derived from Knowledge Cards and their per-card FSRS state.
- A **Chapter Design Run** creates one versioned **Chapter Concept Inventory** and **Card Blueprint** for a confirmed Chapter.
- A **Card Blueprint Slot** maps one concept to evidence within one Work Unit before a Worker generates its Knowledge Card candidate.
- Each upload **Learning Project** must have one fully funded **Sponsor Budget** before it enters AI generation.
- A **Sponsor Budget** equals the sum of all **Worker Reward Quotes** frozen before generation.
- A **Project Escrow** derives the Reward recipient from Registry V2 and never accepts a recipient from the Runner.
- A confirmed Work Unit creates exactly one **Worker Reward**.
- A **Worker Reward** names exactly one Registry Worker recipient, one Project Escrow, and one Reward Treasury release intent.
- A **Settlement Agent** may settle a Worker Reward after its Chapter or Learning Project is already `READY`.
- **Moss Verification** produces an unsigned transaction; only the **Reward Treasury** signer may sign and broadcast it.
- A **Moss Onchain Review** may expose verification evidence but never exposes a signed transaction, private key, source content, or learner progress details.
- Monad Testnet `10143` is labeled as Mindmark experimental compatibility for the pinned Moss `0.1.0`; only Monad Mainnet `143` is described as officially supported by Moss.
- A failed Worker Reward never moves a Chapter or Learning Project out of `READY`.
- A **Monad Verification Snapshot** treats Registry V2 contract reads as authoritative for Project, Chapter, and Work Unit commitments; Supabase contributes transaction references and Worker Reward intents that are independently checked against Monad.
- A **Monad Verification Snapshot** never contains Source Block text, Knowledge Card content, PDF metadata, Tutor conversation, or learner review state.
- A **Learning Completion Attestation** can exist only for a `READY` upload Learning Project whose learner and Project deck root still match Registry V2.
- A **Completion Attestor** signs a short-lived claim authorization; the learner pays for and submits the attestation transaction from the learner wallet.
- A Card Pack never receives a **Learning Completion Attestation** because Pack Installation bypasses Registry V2.

## Example dialogue

> **Dev:** "When does the Settlement Agent pay a Worker?"
>
> **Domain expert:** "Only after Quality Gate approval and Work Unit commitment. Moss verifies the exact Escrow release call and observed Worker payout, then the independent Reward Treasury broadcasts it."
>
> **Dev:** "Does a blocked Moss simulation make the Learning Project fail?"
>
> **Domain expert:** "No. The reward becomes `BLOCKED` for operator review; Chapter and Learning Project learning state remain unchanged."

## Flagged ambiguities

- "Agent" can mean a model-driven Worker or the Settlement Agent. In code, use the role-specific term.
- "Chapter" and "Work Unit" are not aliases. Chapter is learner-facing structure; Work Unit is internal execution structure.
- "Moss execution" is misleading: Moss never signs or broadcasts. Use **Moss Verification** for its actual role.
