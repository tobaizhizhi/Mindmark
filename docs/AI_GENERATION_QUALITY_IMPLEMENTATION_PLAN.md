# AI Generation Quality Implementation Plan

> Status: Proposed
> Scope: V2 Learning Project -> Chapter -> Knowledge Card pipeline
> Decision: Improve generation quality with a versioned learning-design layer before introducing a larger model framework

## 1. Executive Decision

The current pipeline validates that a Knowledge Card is well-formed, cited, and bounded by a card budget. It does not first decide which concepts a learner must master or which card types should assess those concepts. This is the main quality gap.

The target pipeline is:

```text
Source Blocks
  -> ChapterConceptInventory
  -> CardBlueprint
  -> candidate Knowledge Cards
  -> deterministic validation
  -> semantic quality and coverage evaluation
  -> targeted repair
  -> Chapter approval
  -> Monad commitment
```

The implementation must preserve the current V2 invariants:

- `Chapter` remains a stable learner-facing range of `Source Blocks`.
- `Work Unit` remains an internal execution shard and never becomes learner-facing structure.
- `Knowledge Card` remains cited, Chapter-scoped, and provenance-preserving.
- Supabase remains the authority for learning state, Workflow Jobs, and audit events.
- Monad remains the authority for immutable commitments and receipts.
- A Learning Project whose Chapter or Work Unit has been committed cannot be silently regenerated in place.

LangGraph is an optional implementation Adapter for the AI-internal graph. It must not replace the Supabase business Workflow or become a second source of truth.

## 2. Current State and Problem

The current path is approximately:

```text
PDF extraction
  -> Source Block normalization
  -> AI or deterministic Chapter outline
  -> Work Unit partition by source size
  -> AI Worker generates cards for each Work Unit
  -> schema/citation/count checks
  -> Chapter Quality Gate
  -> Worker commitment and Chapter assembly
```

The current `Worker` prompt asks for distinct, self-contained cards from assigned Source Blocks, but the model decides which knowledge is important and which card form to use. The current card policy derives target quantity primarily from non-heading character count and Chapter importance. The current quality gate checks candidate readiness, exact normalized duplicates, and minimum/maximum counts; it does not assess semantic coverage or pedagogical usefulness.

This creates four failure modes:

1. High-value concepts can be omitted while low-value prose is converted into cards.
2. Several cards can restate one concept with different wording.
3. A chapter can contain only definitions and lack comparison, process, application, or misconception cards.
4. A valid citation can still be irrelevant to the answer or insufficient to teach the concept.

The architecture correction in [MATERIAL_CHAPTER_CARD_ARCHITECTURE_CORRECTION.md](MATERIAL_CHAPTER_CARD_ARCHITECTURE_CORRECTION.md) already establishes the required Chapter, Work Unit, and Knowledge Card invariants. This document turns those decisions into an implementation sequence.

## 3. Goals and Non-goals

### Goals

- Make expected learning coverage explicit before card wording is generated.
- Make every generated card traceable to a concept and a blueprint slot.
- Detect semantic duplicates and missing important concepts before commitment.
- Repair only failed slots or Work Units instead of regenerating an entire Chapter.
- Version the policy, prompts, model, design snapshot, and evaluation results.
- Provide a fixed evaluation corpus and repeatable quality metrics.
- Keep Monad commitment and Workflow recovery semantics intact.

### Non-goals

- Replacing Supabase Workflow Jobs with LangGraph.
- Changing the V2 Registry contract in the first implementation.
- Training or fine-tuning a model in the first implementation.
- Silently replacing cards in an already committed Learning Project.
- Storing complete model transcripts or raw source text in operational logs.

## 4. Quality Contract

The quality contract has hard gates and soft scores.

### Hard gates

Every card set must satisfy all of these before it can be approved:

- The output conforms to the card schema.
- Every citation is a verbatim match within the assigned Chapter Source Blocks.
- The citation supports the answer, not merely appears somewhere in the Chapter.
- The card is self-contained and does not depend on missing context.
- The card is assigned to a valid blueprint slot.
- Required slots have a candidate or an explicit repair result.
- Important concepts meet their minimum coverage requirement.
- Semantic duplicate rate is below the policy threshold.
- The Chapter card count is between policy minimum and maximum.

### Soft scores

The evaluator records a 0-5 score for each dimension:

| Dimension | Meaning |
| --- | --- |
| Factuality | The answer is supported by the source and contains no invented claim. |
| Learning value | The card tests a meaningful concept rather than a trivial sentence. |
| Clarity | The question and answer are direct and unambiguous. |
| Completeness | The answer satisfies the stated learning objective. |
| Citation relevance | The quoted evidence is sufficient and directly relevant. |
| Difficulty fit | The difficulty matches the blueprint slot. |

The initial thresholds should be calibrated from the Phase 0 baseline. The intended production targets are 100% hard-gate pass rate, at least 95% important-concept coverage, semantic duplicate rate below 5%, and at least 80% human acceptance.

## 5. Domain Objects

These are Mindmark domain objects, not framework-specific objects.

### 5.1 `ChapterConceptInventory`

The inventory answers: “What should a learner master in this Chapter?”

```ts
type ChapterConceptInventory = {
  chapterId: number;
  sourceHash: Hex;
  concepts: Array<{
    conceptId: string;
    name: string;
    importance: 1 | 2 | 3 | 4 | 5;
    learningObjective: string;
    sourceBlockIndexes: number[];
    prerequisites: string[];
    misconceptions: string[];
  }>;
  policyVersion: number;
};
```

Invariants:

- Every concept has at least one Source Block reference within the Chapter.
- Concept IDs are stable within one design run and derived by the server.
- Concepts cannot overlap semantically without an explicit relationship.
- Importance 4 or 5 concepts must receive at least one required blueprint slot.
- Prerequisites and misconceptions are references or statements grounded in the Chapter source.

### 5.2 `CardBlueprint`

The blueprint answers: “What cards should assess those concepts?”

```ts
type CardBlueprint = {
  chapterId: number;
  inventoryVersion: number;
  slots: Array<{
    slotId: string;
    conceptId: string;
    type: "concept" | "comparison" | "process" | "application" | "misconception";
    objective: string;
    difficulty: 1 | 2 | 3 | 4 | 5;
    sourceBlockIndexes: number[];
    required: boolean;
  }>;
};
```

The blueprint is a plan, not learner-facing content. A single important concept may receive multiple slots, for example one concept card, one application card, and one misconception card. A small factual detail may receive only one slot.

### 5.3 Candidate and evaluation metadata

`blueprintSlotId` should be persisted as off-chain metadata in the first version. It should not be added to the content hash without an explicit commitment-version decision, because V2 `cardHash` currently covers the learner-visible card content only. The mapping is used for quality, repair, and audit; it does not change the existing V2 Registry ABI.

## 6. Target Workflow

The current outline confirmation path must be split so that the teaching design exists before Work Units and the Monad manifest are frozen:

```text
OUTLINE_READY
  -> DESIGNING_CARDS
  -> AWAITING_REGISTRY
  -> GENERATING
  -> QUALITY_CHECK
  -> ASSEMBLING
  -> READY
```

Detailed transitions:

1. The user confirms an Outline Draft.
2. The database materializes confirmed Chapters, but does not yet freeze Work Units for Registry creation.
3. One `DESIGN_CHAPTER` Workflow Job is queued per Chapter.
4. Each job creates and validates a `ChapterConceptInventory` and `CardBlueprint`.
5. Once all Chapters have a valid blueprint, `Work Planning Module` assigns blueprint slots to contiguous Work Units.
6. The complete Work Unit manifest is persisted and the Learning Project becomes `AWAITING_REGISTRY`.
7. The user creates the Monad Project using the now-finalized plan.
8. Workers generate candidates against assigned blueprint slots.
9. `QUALITY_CHECK_CHAPTER` evaluates coverage and quality before approved candidates can commit.

The existing database command that currently confirms an outline and materializes Work Units must be split into two transactional commands or two clearly separated phases. The exact HTTP command names may remain stable, but the response must expose that the project is designing cards rather than pretending it is already ready to create on Monad.

## 7. AI Graph Design

### 7.1 `ChapterDesignGraph`

This graph runs inside the `DESIGN_CHAPTER` Workflow Job.

```text
loadChapterContext
  -> extractConcepts
  -> validateInventory
  -> [repairInventory]        when validation fails
  -> designBlueprint
  -> validateBlueprint
  -> [repairBlueprint]        when validation fails
  -> persistDesignSnapshot
```

The graph must have bounded loops: one inventory repair and one blueprint repair by default. A failed graph returns a retryable Workflow Job; it must not create partial Work Units or a partial Monad intent.

### 7.2 `ChapterEvaluationGraph`

This graph runs inside the existing `QUALITY_CHECK_CHAPTER` Workflow Job.

```text
loadBlueprintAndCandidates
  -> deterministicCitationAndSchemaGate
  -> semanticDeduplication
  -> conceptCoverageEvaluation
  -> rubricEvaluation
  -> [targetedRepair]         when failures are repairable
  -> approveCandidateSet
```

The graph returns one of:

- `APPROVED`: all hard gates pass and the quality score is acceptable.
- `REPAIR_REQUESTED`: specific slots or Work Units need another attempt.
- `RETRYABLE`: the graph or external Model Adapter failed.
- `FAILED`: the bounded repair budget was exhausted or the Chapter cannot meet its policy.

LangGraph, if adopted, should implement these two graphs only. Supabase remains responsible for Workflow Job leases, idempotency, recovery, and domain state. Monad and Reward Treasury operations remain outside the graph.

## 8. Module and File Changes

### Shared Domain Module

Add:

```text
packages/shared/src/chapter-concepts.ts
packages/shared/src/card-blueprint.ts
packages/shared/src/card-quality.ts
```

These files contain Zod schemas, stable IDs, policy validation, coverage calculations, and pure testable functions. They must not import Supabase, fetch, model clients, or wallet code.

Update:

```text
packages/shared/src/card-policy.ts
packages/shared/src/work-planning.ts
packages/shared/src/project-v2.ts
packages/shared/src/index.ts
```

`ChapterCardPolicy` becomes the learner-facing acceptance policy. `WorkUnitCardRequest` becomes the internal allocation request. They must no longer be represented by one ambiguous budget field.

### Runner Model Generation Module

Add or consolidate:

```text
apps/agent-runner/src/model/prompt-registry.ts
apps/agent-runner/src/model/chapter-design-graph.ts
apps/agent-runner/src/model/chapter-evaluation-graph.ts
apps/agent-runner/src/model/quality-evaluator.ts
apps/agent-runner/src/model/embedding-gateway.ts
```

Update:

```text
apps/agent-runner/src/outline-planning-agent.ts
apps/agent-runner/src/worker-v2.ts
apps/agent-runner/src/chapter-quality-gate.ts
apps/agent-runner/src/workflow-dispatcher-v2.ts
apps/agent-runner/src/repository-v2.ts
apps/agent-runner/src/types-v2.ts
```

The existing OpenAI-compatible model Adapter can remain the transport Adapter. LangGraph and LangChain packages must not leak into Shared Domain Module or Web.

### Web Module

The Web must display the design operation explicitly:

- `DESIGNING_CARDS`: AI is analyzing concepts and planning card types.
- `AWAITING_REGISTRY`: the teaching plan is ready for Monad creation.
- `GENERATING`: Workers are writing candidates from the frozen blueprint.
- `QUALITY_CHECK`: candidates are being evaluated and repaired.

Add learner feedback only after the quality pipeline has stable card provenance. Feedback is an input to evaluation and future audits, not an automatic training signal.

## 9. Database Changes

Create a new additive migration, for example `20260730000100_learning_design_v3.sql`.

### `chapter_design_runs`

One immutable versioned design snapshot per Chapter attempt:

```text
design_run_id uuid primary key
project_id text
chapter_id smallint
source_hash text
status text
inventory jsonb
blueprint jsonb
inventory_hash text
blueprint_hash text
policy_version text
prompt_version text
model_id text
attempt smallint
metrics jsonb
last_error text
created_at timestamptz
completed_at timestamptz
```

### `card_blueprint_slots`

Normalized slots are required for targeted repair and coverage queries:

```text
project_id text
chapter_id smallint
design_run_id uuid
slot_id text
concept_id text
card_type text
objective text
difficulty smallint
source_block_indexes jsonb
required boolean
assigned_work_unit_id smallint nullable
status text
```

The unique key is `(project_id, chapter_id, design_run_id, slot_id)`. A slot must not be assigned to a Work Unit whose contiguous source range cannot satisfy its citation indexes.

### `card_quality_evaluations`

Store structured results, not raw model transcripts:

```text
evaluation_id uuid
project_id text
chapter_id smallint
slot_id text nullable
card_id text nullable
hard_failures jsonb
rubric_scores jsonb
coverage_result jsonb
repair_reason text nullable
evaluator_model text
prompt_version text
created_at timestamptz
```

### `knowledge_card_feedback`

Store owner feedback separately from the immutable card content:

```text
feedback_id uuid
owner_address text
project_id text
chapter_id smallint
card_id text
rating text
reason text
corrected_content jsonb nullable
created_at timestamptz
```

All tables need the same forced RLS and service-role-only pattern as the existing V2 workflow tables. Raw PDF text and complete AI transcripts must not enter standard operations payloads.

## 10. Prompt and Model Policy

Each AI node has a separate prompt and model policy. Do not use one temperature and one generic system prompt for every role.

| Node | Input | Output | Temperature guidance |
| --- | --- | --- | --- |
| Concept extractor | Chapter Source Blocks, goal | Concept inventory | Low, structured |
| Blueprint planner | Inventory, policy | Blueprint slots | Low, structured |
| Card generator | One slot, assigned evidence | Card content only | Moderate, constrained |
| Quality evaluator | Card, evidence, rubric | Scores and reasons | Low, deterministic |
| Repair generator | Failed slot and reason | Replacement card | Low/moderate |

Every model response must use a strict tool/schema contract. The model may write learner-visible content but may not write IDs, hashes, proofs, status, wallet, or transaction fields.

The Prompt Registry must version prompt text, tool schemas, policy version, model ID, and decoding parameters. A prompt change is a generation policy change and must run the fixed evaluation set before rollout.

## 11. Semantic Quality and Coverage

The first implementation should use a dedicated `EmbeddingGateway` Adapter for within-Chapter semantic similarity. The gateway may initially call the existing provider's embedding endpoint; it must have a deterministic fake for tests.

Semantic deduplication should compare normalized question/key point plus embedding similarity. The evaluator must retain the reason for a duplicate decision and never silently delete all cards from one Work Unit.

Coverage evaluation should compare generated cards to the inventory:

- Every importance 5 concept has a required slot.
- Importance 4 concepts have at least one accepted card.
- A required comparison/process/application slot must be satisfied when the Chapter source supports that type.
- A concept with a declared misconception should receive a misconception slot when policy requires it.
- Coverage is measured before Chapter approval and recorded in `card_quality_evaluations`.

## 12. Fixed Evaluation Set

Create a local evaluation corpus under:

```text
fixtures/ai-quality/
  concepts/
  blueprints/
  source/
  expected-metrics.json
```

The corpus should contain 8-12 sanitized or synthetic materials covering:

- Concept-heavy technical prose
- Formula and calculation content
- Step-by-step procedures
- Comparison-heavy material
- Code-heavy material
- Multi-level headings
- Chinese/English mixed material
- Repetition and low-value prose

The expected output should describe concepts, required coverage, and quality constraints rather than demand exact wording. Model response fixtures should be replayable in CI. Live-model evaluation runs separately because network and provider output are not deterministic.

The evaluation command should report:

```text
source fixture
policy version
model and prompt version
concept coverage
required-slot coverage
hard-gate failure rate
semantic duplicate rate
rubric averages
repair rate
cards per Chapter
latency and token/cost estimates
```

## 13. Tests

### Shared Domain tests

- Inventory source indexes are inside the Chapter.
- Important concepts receive required slots.
- Blueprint types and difficulties obey policy.
- Slots are assignable to contiguous Work Units.
- Coverage and duplicate calculations are deterministic.

### Graph tests

Use Fake Model Adapters and replay fixtures to test:

- Invalid inventory repair.
- Invalid blueprint repair.
- Deterministic fallback after model/schema failure.
- Bounded repair loops.
- Targeted repair of one slot without changing approved slots.
- Evaluator output normalization.

### Database tests

Use PGlite to verify:

- Design runs are immutable and versioned.
- Only one active design run exists per Chapter.
- Work Units are not materialized before all required blueprints pass.
- `DESIGNING_CARDS -> AWAITING_REGISTRY` is atomic.
- Retry does not create duplicate design runs or slots.
- Project creation cannot use a missing or invalid blueprint hash.

### Integration and contract tests

- Existing V2 source, Work Unit, Chapter, and Project hash vectors remain unchanged for the current policy.
- A new project can run design, generation, quality, commitment, assembly, and finalization end to end.
- A failed quality graph cannot trigger a Work Unit commitment.
- A committed V2 project cannot be rewritten by a policy-v3 retry.

## 14. Rollout Plan

### Phase 0: Audit and baseline

Deliverables:

- Manual audit of the current card sample.
- Rubric and failure taxonomy.
- Fixed evaluation corpus.
- Baseline report and replay command.

No production Workflow change.

### Phase 1: Domain and persistence

Deliverables:

- Shared Inventory and Blueprint schemas.
- Policy versioning.
- Design-run and blueprint-slot tables.
- PGlite state-transition tests.

The design path can run offline before it controls Project creation.

### Phase 2: Chapter Design Graph

Deliverables:

- Concept extraction and blueprint planning nodes.
- Deterministic validators and bounded repair.
- `DESIGN_CHAPTER` Workflow Job.
- Web operation states for design progress.

Run in shadow mode for new Projects. Do not create Monad Projects from shadow output.

### Phase 3: Blueprint-driven generation and evaluation

Deliverables:

- Worker slot-aware generation.
- Chapter Evaluation Graph.
- Semantic deduplication.
- Coverage and rubric evaluation.
- Targeted repair.

### Phase 4: Canary release

- Enable `generation_policy_version = 3` for internal Projects first.
- Compare against the fixed evaluation set and human audits.
- Enable for a small percentage of new Projects.
- Keep policy-v2 fallback only before Monad creation.
- Never switch policy after a Project has committed on Monad.

## 15. Operational Metrics and Alerts

Record safe metrics per Design Run, Work Unit, Chapter, and Project:

- Concept extraction success rate.
- Blueprint validation failure rate.
- Candidate hard-gate failure rate.
- Important-concept coverage.
- Semantic duplicate rate.
- Human acceptance rate.
- Repair count and repair success rate.
- AI latency, token usage, and estimated cost.
- Cards per Chapter and cards per source character range.
- Jobs stuck in `RUNNING`, `RETRYABLE`, or expired lease.

Alert on hard-gate failures, missing required concepts, repeated repair exhaustion, and quality regressions. Do not log raw source, full answers, API keys, wallet keys, or complete transcripts.

## 16. Delivery Checklist

- [ ] Audit current cards and publish baseline metrics.
- [ ] Add `ChapterConceptInventory` schemas and validators.
- [ ] Add `CardBlueprint` schemas and validators.
- [ ] Add versioned Design Run persistence.
- [ ] Split outline confirmation from Work Unit materialization.
- [ ] Add `DESIGN_CHAPTER` Workflow Job and recovery path.
- [ ] Implement Chapter Design Graph with bounded repair.
- [ ] Assign blueprint slots to Work Units before manifest creation.
- [ ] Make Worker generation slot-aware.
- [ ] Implement semantic duplicate and coverage evaluation.
- [ ] Implement Chapter Evaluation Graph with targeted repair.
- [ ] Add fixed evaluation fixtures and replay tests.
- [ ] Add human feedback capture.
- [ ] Run shadow and canary Projects.
- [ ] Verify Monad commitment immutability and V2 hash vectors.
- [ ] Enable policy-v3 only after all quality thresholds pass.

## 17. Definition of Done

The implementation is complete when:

- Every accepted Knowledge Card maps to one concept and one blueprint slot.
- Important concepts and required card types have explicit coverage results.
- Hard citation/schema/provenance gates remain at 100%.
- Semantic duplicate rate and human acceptance meet the release thresholds.
- Repair is local and bounded rather than full-Chapter regeneration.
- Prompt, model, policy, design snapshot, and evaluation scores are auditable.
- Fixed evaluation fixtures catch quality regressions before release.
- Existing committed V2 Projects remain immutable and learnable.
- Supabase remains the only business-state authority; LangGraph, if used, is an internal AI Workflow Adapter.

## 18. Detailed Execution Specification

This section is normative for the first policy-v3 implementation. Where it
conflicts with an earlier illustrative example, this section wins.

### 18.1 Workflow Job kinds and state transitions

Add two Workflow Job kinds to the existing V2 queue:

```ts
type WorkflowJobKind =
  | "PLAN_OUTLINE"
  | "DESIGN_CHAPTER"
  | "FREEZE_PROJECT_DESIGN"
  | "RECONCILE_PROJECT"
  | "GENERATE_WORK_UNIT"
  | "QUALITY_CHECK_CHAPTER"
  | "ASSEMBLE_CHAPTER"
  | "FINALIZE_PROJECT"
  | "SETTLE_WORK_UNIT_REWARD";
```

`DESIGN_CHAPTER` is Chapter-scoped. `FREEZE_PROJECT_DESIGN` is
Learning-Project-scoped and is the only command allowed to create Work Units
for policy v3. This separation prevents a partially designed Chapter from
being included in a Monad Work Unit manifest.

| Current state | Command or job | Required preconditions | Atomic result | Failure result |
| --- | --- | --- | --- | --- |
| `OUTLINE_READY` | user confirms outline | Draft is current and belongs to owner | Materialize Chapters, set Project to `DESIGNING_CARDS`, enqueue one `DESIGN_CHAPTER` job per Chapter | No Chapter or Work Unit partial write |
| `DESIGNING_CARDS` | `DESIGN_CHAPTER` | Confirmed Chapter, no active completed design for this policy | Persist one completed Chapter Design Run and its Card Blueprint Slots | Job becomes retryable; Project remains `DESIGNING_CARDS` |
| `DESIGNING_CARDS` | `FREEZE_PROJECT_DESIGN` | Every Chapter has exactly one completed design for the same policy version | Plan Work Units, assign every Card Blueprint Slot, build manifest, set Project to `AWAITING_REGISTRY` | No Work Units or manifest persisted |
| `AWAITING_REGISTRY` | user creates Project on Monad | Creation intent has a complete manifest | Record transaction and enqueue/reuse reconciliation | Remains recoverable by reconciliation |
| `GENERATING` | `GENERATE_WORK_UNIT` | Work Unit has assigned slots and an allowed Worker | Save only candidates for those slots | Retry only that Work Unit |
| `QUALITY_CHECK` | `QUALITY_CHECK_CHAPTER` | All required Work Units have candidates or an explicit repair state | Approve candidates or request exact failed slots | Only failed Work Units or slots return to repair |

The database check on `learning_projects.status` must add `DESIGNING_CARDS`.
Confirmed Chapters remain `CONFIRMED` while they are designed; this avoids
overloading learner-facing Chapter state with internal AI activity.

### 18.2 Idempotency, retries, and cancellation

Every command and job must use a stable idempotency key:

| Operation | Idempotency key | Retry rule |
| --- | --- | --- |
| Confirm outline for policy v3 | `(project_id, outline_version, policy_version)` | Return existing active design set if present |
| Design Chapter | `(project_id, chapter_id, outline_version, policy_version)` | Resume or create a new versioned attempt after the previous attempt is terminal |
| Freeze Project design | `(project_id, outline_version, policy_version)` | Return existing manifest if already frozen |
| Generate slot candidates | `(project_id, work_unit_id, design_run_id)` | Preserve accepted slots; regenerate only failed slots |
| Evaluate Chapter | `(project_id, chapter_id, design_run_id, candidate_revision)` | Reuse an existing final evaluation result |

Transient provider, RPC, or database errors use the existing exponential
backoff. Invalid model output, missing evidence, and failed hard gates are
not transport retries: they consume the bounded repair budget. The initial
limits are one repair for inventory, one repair for blueprint, and two repair
rounds for candidate slots. Exhaustion marks the relevant Workflow Job
`FAILED` with a safe error summary and leaves the Learning Project in a
recoverable, pre-Monad state.

Cancellation is allowed only before `FREEZE_PROJECT_DESIGN` completes. A
cancelled design must retain its audit rows but must not leave Work Units,
manifest proofs, or a Monad creation intent. After the manifest is frozen,
the selected generation policy is immutable for that Learning Project.

### 18.3 Chapter Design Module Interface

The Chapter Design Module is the deep Module that hides prompt sequencing,
model parsing, repair loops, inventory validation, blueprint validation, and
slot allocation from callers. Its external interface is deliberately small:

```ts
type DesignChapterInput = {
  projectId: Hex;
  chapterId: number;
  outlineVersion: number;
  policy: GenerationPolicy;
};

type DesignChapterResult =
  | { state: "DESIGNED"; designRunId: string; inventoryHash: Hex; blueprintHash: Hex }
  | { state: "REPAIR_EXHAUSTED"; reason: string };

interface ChapterDesignModule {
  design(input: DesignChapterInput): Promise<DesignChapterResult>;
}
```

Callers only know the identifiers, the selected Generation Policy, and the
terminal result. The Implementation loads Source Blocks internally and stores
all snapshots through the repository Adapter. This gives the Workflow Handler
leverage and keeps model details local to the Module.

`GenerationPolicy` is a versioned Shared Domain object. It contains card
count ranges, required coverage by importance, allowed card types, semantic
duplicate thresholds, hard-gate rules, repair limits, and prompt/model
versions. A policy change creates a new version; callers never mutate a
policy in place.

### 18.4 ChapterDesignGraph node contracts

The graph state contains IDs and structured results, not raw PDF data. Each
node reloads the smallest required Source Block range through the repository
Adapter. Graph checkpoints must not become an independent source of truth;
completed node outputs are persisted in the Chapter Design Run.

| Node | Reads | Writes | Rejects when |
| --- | --- | --- | --- |
| `loadChapterContext` | Chapter, Source Blocks, goal, policy | In-memory scoped context | Source is missing or Chapter range is invalid |
| `extractConcepts` | Scoped context | Untrusted concept proposal | Model output is not strict structured output |
| `validateInventory` | Proposal, Source Blocks, policy | Valid inventory or repair issues | Evidence is outside Chapter, IDs duplicate, important source area is uncovered |
| `repairInventory` | Previous proposal, machine-readable issues | Replacement proposal | Repair count exceeds policy |
| `designBlueprint` | Valid inventory, policy | Untrusted blueprint proposal | Slot count/type/evidence is invalid |
| `validateBlueprint` | Blueprint, inventory, policy | Valid blueprint or repair issues | Important concept lacks a required slot or a slot cannot be evidenced |
| `repairBlueprint` | Previous blueprint, issues | Replacement blueprint | Repair count exceeds policy |
| `persistDesignSnapshot` | Valid inventory and blueprint | Immutable completed design run and slots | Concurrent design has already completed |

The Concept Extractor and Blueprint Planner use strict tool calls. The server
derives `conceptId`, `slotId`, hashes, and source index normalization; a model
proposal may provide labels and relationships but never authority-bearing IDs.

If LangGraph is introduced, node routing maps directly to this table. The
first release does not require a LangGraph checkpointer: persistent outputs in
Supabase plus Workflow Job retry provide recovery. A LangGraph checkpointer may
be evaluated later only if it can reuse the same Chapter Design Run IDs without
duplicating state ownership.

### 18.5 Work Planning from Card Blueprint Slots

The existing Work Planning Module partitions Source Blocks primarily by size.
Policy v3 changes its input, not the meaning of a Work Unit. The resulting
Work Units remain contiguous internal shards and must still cover every Source
Block in their Chapter exactly once.

The allocation algorithm is:

1. For every Card Blueprint Slot, calculate its smallest contiguous evidence
   range from `min(sourceBlockIndexes)` through `max(sourceBlockIndexes)`.
2. Group slots whose evidence ranges overlap or whose concepts require the
   same primary Source Block.
3. Pack groups in Source Block order into contiguous Work Units, respecting
   the existing maximum of eight Work Units per Chapter and the configured
   context-size ceiling.
4. Add Source Blocks with no slot as context to their adjacent Work Unit so
   that the Chapter remains fully covered.
5. Assign each slot to exactly one Work Unit whose source range contains all
   of the slot's evidence indexes.
6. Derive `cardMinimum`, `cardTarget`, and `cardBudget` from assigned required
   and optional slots, rather than only from character count.
7. Build the Work Unit manifest only after every slot is assigned.

A comparison or process slot whose evidence cannot fit in one Work Unit is a
blueprint validation failure. The Blueprint Planner must simplify the slot,
merge its relevant Source Block range, or split it into independently cited
slots before the manifest is frozen. A Worker may never cite a Source Block
outside its assigned Work Unit.

### 18.6 Candidate generation and targeted repair contract

Workers receive the Card Blueprint Slots assigned to their Work Unit. For each
slot, the model receives the concept, objective, type, difficulty, allowed
evidence, and the exact repair reason if it is a retry. The Worker returns a
candidate keyed by `slotId`; it never chooses its own number of cards.

Candidate states are:

```text
PLANNED -> ASSIGNED -> GENERATING -> CANDIDATE_READY
                                   -> REPAIR_REQUESTED -> GENERATING
                                   -> REJECTED
                         CANDIDATE_READY -> ACCEPTED
```

The evaluator selects at most one accepted candidate per required slot. An
optional slot can be omitted only when the Chapter still satisfies its policy.
An accepted candidate is immutable for the current design run. A repair
creates a new candidate revision; it does not overwrite the previous one.

The mapping from candidate to slot is off-chain metadata. The V2 learner card
content hash remains unchanged. A side table or explicit mapping column must
link the final `Knowledge Card` to its `Card Blueprint Slot` without adding
that metadata to `KnowledgeCardContent` or changing the Registry ABI.

### 18.7 Chapter Quality Module Interface

The Chapter Quality Module centralizes selection, semantic duplicate handling,
coverage, rubric scoring, and repair decisions. It replaces a growing set of
independent checks in the Worker and Chapter Quality Gate with one testable
Interface:

```ts
type EvaluateChapterInput = {
  projectId: Hex;
  chapterId: number;
  designRunId: string;
  candidateRevision: number;
};

type EvaluateChapterResult =
  | { state: "APPROVED"; acceptedCardIds: Hex[]; metrics: ChapterQualityMetrics }
  | { state: "REPAIR_REQUESTED"; repairs: SlotRepairRequest[]; metrics: ChapterQualityMetrics }
  | { state: "FAILED"; reason: string; metrics: ChapterQualityMetrics };

interface ChapterQualityModule {
  evaluate(input: EvaluateChapterInput): Promise<EvaluateChapterResult>;
}
```

This Module's Interface is the quality test surface. Workers do not need to
know coverage thresholds, embedding thresholds, or Chapter-wide duplicate
policy; they only need the slot contract and any directed repair request.

## 19. Data and Transaction Detail

### 19.1 Required database constraints

The migration must express the following constraints in both database objects
and repository validation. Application checks alone are insufficient.

| Object | Constraint |
| --- | --- |
| `chapter_design_runs` | Unique completed run per `(project_id, chapter_id, outline_version, policy_version)` |
| `chapter_design_runs` | Snapshot, hashes, model, prompt, and policy are immutable after completion |
| `card_blueprint_slots` | Unique `slot_id` within a Design Run; referenced concept exists in its inventory |
| `card_blueprint_slots` | `source_block_indexes` is non-empty, ordered, and contained by the Chapter |
| `card_blueprint_slots` | Assigned Work Unit belongs to the same Chapter and covers all cited indexes |
| Candidate-slot mapping | One accepted candidate at most per required slot per revision |
| `card_quality_evaluations` | Result refers to the same Design Run as its slot/card |
| `knowledge_card_feedback` | Owner may create feedback only for a card they may read |

PostgreSQL cannot express every Source Block containment check with a simple
foreign key because indexes are stored as an array. Implement a
`validate_card_blueprint_slots_v3` security-definer function that locks the
Design Run and Chapter, verifies the indexes against `source_blocks`, verifies
the assigned Work Unit range, and inserts slots transactionally.

### 19.2 Transactional commands

The following repository operations are the only write paths for policy v3:

```text
start_chapter_design_v3(project_id, owner, outline_version, policy_version)
complete_chapter_design_v3(design_run_id, inventory, blueprint, metadata)
freeze_project_design_v3(project_id, outline_version, policy_version)
save_slot_candidates_v3(project_id, work_unit_id, design_run_id, revision, candidates)
record_chapter_quality_v3(project_id, chapter_id, design_run_id, revision, evaluation)
apply_slot_repairs_v3(project_id, chapter_id, design_run_id, repairs)
```

`freeze_project_design_v3` must do all of the following in one transaction:

1. Lock the Learning Project and verify it is `DESIGNING_CARDS`.
2. Verify a completed Design Run exists for every confirmed Chapter.
3. Verify that every required Card Blueprint Slot is assigned.
4. Create all Work Units and their source hashes and manifest proofs.
5. Persist the selected design run IDs and generation policy version in the
   Project creation intent.
6. Transition to `AWAITING_REGISTRY` and enqueue nothing except the normal
   reconciliation path after the browser transaction is recorded.

If any step fails, the transaction rolls back completely. No caller may create
a Monad Project from a manifest that does not have a completed frozen design.

### 19.3 Migration compatibility

The first policy-v3 migration is additive. It must not rewrite existing V2
Projects, Knowledge Cards, Work Units, Registry data, or card hashes.

New nullable columns may be added to `learning_projects` for
`generation_policy_version`, `frozen_design_hash`, and `frozen_at`. Existing
projects receive `generation_policy_version = 2` logically through the read
adapter until a later backfill migration is proven safe. New V3 Projects must
persist `generation_policy_version = 3` before outline confirmation completes.

All new functions receive a `_v3` suffix. Existing V2 functions remain in
place while policy-v2 Projects can still recover. Removing or replacing a V2
function is a separate cleanup decision after no V2 Projects remain active.

## 20. Evaluation Algorithms and Dataset Detail

### 20.1 Quality calculation order

The evaluator applies checks in this order. Later checks never repair a hard
gate failure silently.

1. Parse card and candidate-slot metadata with Zod schemas.
2. Verify citation page and verbatim quote against allowed Source Blocks.
3. Verify the quote is sufficient for the asserted answer using a structured
   evaluator result. This result may reject, but cannot override a failed
   verbatim check.
4. Reject context-dependent wording and exact normalized duplicates.
5. Build embeddings for surviving candidates within the same Chapter and card
   type. Flag pairs at or above the calibrated similarity threshold.
6. For each slot, select the surviving candidate with the highest deterministic
   evidence result and rubric score.
7. Calculate weighted concept coverage from accepted required slots.
8. Calculate Chapter-level card type distribution and count policy.
9. Produce `APPROVED`, precise `REPAIR_REQUESTED` entries, or `FAILED`.

The initial semantic duplicate threshold is an evaluation parameter, not a
permanent constant. Start with a conservative threshold such as `0.92`, label
false positives and false negatives in the audit set, then tune only through a
new Generation Policy version.

Weighted concept coverage is:

```text
sum(importance(concept) for every covered required concept)
/
sum(importance(concept) for every required concept)
```

Importance 5 concepts are additionally a binary release gate: all of them
must be covered, regardless of the aggregate percentage.

### 20.2 Rubric evaluator output

The rubric evaluator must return strict structured data:

```ts
type CardRubricEvaluation = {
  cardId: Hex;
  factuality: 0 | 1 | 2 | 3 | 4 | 5;
  learningValue: 0 | 1 | 2 | 3 | 4 | 5;
  clarity: 0 | 1 | 2 | 3 | 4 | 5;
  completeness: 0 | 1 | 2 | 3 | 4 | 5;
  citationRelevance: 0 | 1 | 2 | 3 | 4 | 5;
  difficultyFit: 0 | 1 | 2 | 3 | 4 | 5;
  verdict: "ACCEPT" | "REPAIR" | "REJECT";
  reasons: string[];
};
```

The evaluator receives the slot objective, card, and the evidence snippets
only. It must not see the candidate's Worker identity, reward information, or
other candidates' scores. A score below the policy threshold returns an
actionable repair reason such as `answer omits the condition under which EDF
is optimal`, not an opaque judgement.

### 20.3 Evaluation corpus layout

Each fixture uses a manifest and named files rather than an implicit test
convention:

```text
fixtures/ai-quality/<fixture-name>/
  source.json
  expected-inventory.json
  blueprint-requirements.json
  candidate-cases.json
  expected-metrics.json
  README.md
```

`source.json` stores sanitized Source Pages. `expected-inventory.json` stores
required concepts, allowed aliases, importance, and supporting Source Block
ranges. `blueprint-requirements.json` stores required card types and maximum
card counts. `candidate-cases.json` includes deliberately bad candidates for
citation, duplicate, coverage, and repair tests. `expected-metrics.json`
stores ranges rather than exact model text.

Copyrighted user material is never committed. It may be scored in a local,
access-controlled audit run that writes only aggregate metrics and anonymous
failure categories.

### 20.4 Human audit protocol

For each policy/model candidate, sample at least 50 cards across at least five
fixtures. Reviewers score cards independently using the rubric, without being
told which model or policy created them. Record disagreement rather than
forcing one reviewer to overwrite another. A release candidate requires:

- Citation hard-gate pass rate of 100%.
- All importance 5 concepts covered.
- Weighted concept coverage at or above 95%.
- Semantic duplicate rate below 5%.
- At least 80% human acceptance.
- No fixture with a human acceptance rate below 70%.

These thresholds are initial release gates. Changing one requires an explicit
Generation Policy version and a fresh baseline comparison.

## 21. Detailed Test Matrix

| Layer | Scenario | Signal | Required fixture or fake |
| --- | --- | --- | --- |
| Shared Domain Module | Concept cites outside Chapter | Validation rejects with source-index issue | Small synthetic Source Block list |
| Shared Domain Module | Importance 5 concept without required slot | Blueprint rejects | Inventory with one high-priority concept |
| Shared Domain Module | Slot spans incompatible Work Units | Work Planning rejects before manifest | Two non-overlapping Source ranges |
| Chapter Design Module | Invalid JSON/tool result | Bounded repair then retryable job | Fake Model Adapter sequence |
| Chapter Design Module | Concurrent design job | One completed Design Run only | Repository fake plus transaction test |
| Worker | Candidate misses assigned slot | Candidate is rejected or repair requested | Slot-aware fake model |
| Chapter Quality Module | Semantic duplicate across Workers | One accepted candidate, one targeted repair | Fixed embedding vectors |
| Chapter Quality Module | Important concept missing | No commitment; repair names missing slot | Inventory and candidate fixture |
| Supabase integration | Last Chapter design completes | Exactly one freeze job is queued | PGlite Project with multiple Chapters |
| Supabase integration | Freeze fails halfway | No Work Units and no manifest are visible | Injected transaction failure |
| Workflow integration | Runner restart during design | Same Design Run resumes safely | Lease-expiry fixture |
| Contract integration | V3 Project after freeze | Existing Registry creates and commits without ABI change | Foundry/Viem test |
| Quality regression | Prompt/model update | Metrics stay within release gates | Full fixed corpus replay |

Tests that depend on live model output are not part of the required pull
request suite. They run in a protected evaluation environment and publish a
versioned report. Deterministic replay tests are mandatory in CI.

## 22. Delivery Work Packages

The following order minimizes risk and preserves a usable V2 recovery path.

### Work package A: Baseline and policy contract

1. Add the rubric, failure taxonomy, and aggregate audit report format.
2. Create the first five synthetic evaluation fixtures and replay harness.
3. Run the current policy-v2 Worker against the fixtures and record baseline.
4. Agree the initial Generation Policy v3 thresholds before implementation.

Exit gate: baseline report exists and at least one known poor candidate fails
for every hard-gate category.

### Work package B: Shared Domain and persistence

1. Implement Inventory, Blueprint, Slot, and Generation Policy schemas in
   `@mindmark/shared`.
2. Implement deterministic inventory, blueprint, coverage, and Work Unit
   assignment validators.
3. Add the additive V3 migration, RLS, transactional functions, and PGlite
   tests.
4. Add V3 workflow job kinds to shared schemas, repository types, and the
   operations view.

Exit gate: a PGlite test can create, validate, freeze, and recover a V3 design
without a model or Monad RPC.

### Work package C: Design graph in shadow mode

1. Add the Prompt Registry and strict structured Model Adapter calls.
2. Implement Chapter Design Module nodes and bounded repairs.
3. Add `DESIGN_CHAPTER` and `FREEZE_PROJECT_DESIGN` handlers.
4. Add Web progress views for `DESIGNING_CARDS`.
5. Run the graph against internal materials but do not use its output for
   Monad creation.

Exit gate: shadow runs persist complete snapshots and meet fixed-corpus gates
without altering policy-v2 Work Units.

### Work package D: Blueprint-driven candidate generation

1. Change Worker input from a scalar target count to assigned Card Blueprint
   Slots.
2. Persist candidate-slot revisions and final card-slot mapping.
3. Implement semantic duplicate and coverage evaluation before commitment.
4. Implement local repair routing and a bounded repair budget.

Exit gate: an end-to-end fake-model run repairs one failed slot and commits
only the accepted candidates.

### Work package E: Canary and feedback

1. Enable policy-v3 only for internal Learning Projects.
2. Run blinded human audits and compare policy v2/v3 reports.
3. Add learner feedback capture after card-slot provenance is visible.
4. Enable a small canary percentage for new Learning Projects.

Exit gate: all release gates in Section 20.4 pass for the canary sample and
there is no increase in workflow failure or recovery time.

## 23. Deployment, Rollback, and Operations Runbook

### 23.1 Deployment sequence

1. Deploy Shared Domain and Runner code that can read both policy v2 and v3,
   while the v3 feature flag remains disabled.
2. Apply the additive V3 database migration and verify RLS, grants, and
   operations snapshots.
3. Deploy Web status labels and read-only Design Run diagnostics.
4. Enable shadow design for internal Projects and collect evaluation reports.
5. Enable V3 freeze and Monad creation only after the shadow exit gate passes.
6. Enable Worker slot generation and Chapter Quality Module for the canary.

At each step, verify that a policy-v2 Project can still resume and finalize.
No deployment step is allowed to leave the sole Runner unable to dispatch a
previously queued V2 Workflow Job.

### 23.2 Rollback rules

| Situation | Safe action |
| --- | --- |
| V3 migration or Runner boot fails before flag enablement | Disable deployment, keep V2 handlers and data untouched |
| Design graph quality is poor before manifest freeze | Disable V3 flag; cancel active Design Runs; return affected Project to `OUTLINE_READY` or allow explicit V2 confirmation |
| V3 Project is `AWAITING_REGISTRY` | Keep V3 support; do not reinterpret its frozen manifest as V2 |
| V3 Project has any committed Work Unit | Never roll back its policy or replace cards; continue V3 recovery handlers until terminal |
| Embedding/evaluator provider is unavailable | Mark evaluation retryable; do not approve candidates by bypassing quality gates |

Cancellation and rollback audit events must include Project ID, policy version,
run ID, safe reason code, and request ID. They must not include source text or
full card content.

### 23.3 Operator diagnostics

Extend the Operations view with these safe fields:

```text
policyVersion
designRunStatus
designAttempt
requiredSlotCount
acceptedSlotCount
missingConceptCount
semanticDuplicateCount
repairRound
evaluationVerdict
promptVersion
modelId
```

The default list view exposes counts and status only. An authorized operator
can inspect sanitized repair reasons, never raw source blocks or complete model
transcripts. Alerting thresholds are configured from the Generation Policy,
not hard-coded in the Web.
