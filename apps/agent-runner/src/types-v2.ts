import type {
  CardBlueprint,
  CardBlueprintSlot,
  CardRubricEvaluation,
  ChapterCardPolicy,
  ChapterConceptInventory,
  ChapterOutlineItem,
  ChapterStatus,
  KnowledgeCardContent,
  KnowledgeCardV2,
  ProjectStatus,
  ReviewPlan,
  SourceBlock,
  SourceExclusionRange,
  WorkerKnowledgeCardV2,
  WorkUnitPricingInput,
  WorkUnitStatus,
} from "@mindmark/shared";
import type { Hex } from "viem";
import type {
  ChainReceipt,
  MossRewardStage,
  PreparedWorkerReward,
  ProjectEscrowFunding,
  WorkerRewardReceipt,
  WorkerRewardStatus,
} from "./runtime-types.js";

export type RunnerProjectV2 = {
  projectId: Hex;
  ownerAddress: `0x${string}`;
  goal: string | null;
  sourceHash: Hex;
  goalHash: Hex;
  outlineHash: Hex;
  workUnitManifestRoot: Hex;
  status: ProjectStatus;
  projectDeckRoot: Hex | null;
  initialPlan: ReviewPlan | null;
  initialPlanHash: Hex | null;
  totalCardCount: number;
  generationPolicyVersion: 2 | 3;
};

export type RunnerChapterV2 = {
  projectId: Hex;
  chapterId: number;
  position: number;
  title: string;
  summary: string;
  sourceHash: Hex;
  importance: number;
  status: ChapterStatus;
  cardsRoot: Hex | null;
  cardCount: number;
  minCardCount: number;
  targetCardCount: number;
  maxCardCount: number;
  finalizeTxHash: Hex | null;
};

export type RunnerWorkUnitV2 = {
  projectId: Hex;
  workUnitId: number;
  chapterId: number;
  unitIndex: number;
  startBlock: number;
  endBlock: number;
  sourceText: string | null;
  sourceBlocks: SourceBlock[] | null;
  sourceUnitHash: Hex;
  manifestProof: Hex[];
  cardMinimum: number;
  cardTarget: number;
  cardBudget: number;
  workerAddress: `0x${string}` | null;
  status: WorkUnitStatus;
  attempt: number;
  workerCards: WorkerKnowledgeCardV2[];
  cardsRoot: Hex | null;
  cardCount: number | null;
  commitTxHash: Hex | null;
};

export type ChapterBundleV2 = {
  project: RunnerProjectV2;
  chapter: RunnerChapterV2;
  workUnits: RunnerWorkUnitV2[];
};

export type ProjectBundleV2 = {
  project: RunnerProjectV2;
  chapters: RunnerChapterV2[];
  cards: KnowledgeCardV2[];
};

export type RegistryProjectIntentV2 = {
  projectId: Hex;
  ownerAddress: `0x${string}`;
  sourceHash: Hex;
  goalHash: Hex;
  outlineHash: Hex;
  workUnitManifestRoot: Hex;
  chapterCount: number;
  workUnitCount: number;
  pricingInputs: WorkUnitPricingInput[];
};

export type SavedWorkUnitResultV2 = {
  cards: WorkerKnowledgeCardV2[];
  cardsRoot: Hex;
  generationMs: number;
  slotCandidates?: Array<{ slotId: Hex; cardId: Hex }>;
};

export type WorkUnitBlueprintContextV3 = {
  designRunId: string;
  inventory: ChapterConceptInventory;
  blueprint: CardBlueprint;
  slots: CardBlueprintSlot[];
  repairInstructions: Array<{
    slotId: Hex;
    candidateRevision: number;
    previousCard: KnowledgeCardContent;
    failureCodes: string[];
    instruction: string;
  }>;
};

export interface BlueprintWorkerRepositoryV3 {
  getWorkUnitBlueprintContext(projectId: Hex, workUnitId: number): Promise<WorkUnitBlueprintContextV3>;
}

export type BlueprintSlotCandidateV3 = {
  designRunId: string;
  slotId: Hex;
  workUnitId: number;
  candidateRevision: number;
  status: "CANDIDATE_READY" | "ACCEPTED";
  card: WorkerKnowledgeCardV2;
  acceptedEvaluation?: CardRubricEvaluation;
};

export type ChapterBlueprintQualityContextV3 = {
  designRunId: string;
  inventory: ChapterConceptInventory;
  blueprint: CardBlueprint;
  candidates: BlueprintSlotCandidateV3[];
};

export type BlueprintCandidateEvaluationV3 = {
  slotId: Hex;
  cardId: Hex;
  candidateRevision: number;
  verdict: "APPROVED" | "REPAIR_REQUESTED";
  hardFailures: string[];
  rubric: CardRubricEvaluation;
};

export type BlueprintQualityDecisionV3 = {
  projectId: Hex;
  chapterId: number;
  designRunId: string;
  evaluations: BlueprintCandidateEvaluationV3[];
  coverageResult: Record<string, unknown>;
  duplicatePairs: Array<{
    leftCandidateId: string;
    rightCandidateId: string;
    reason: "EXACT_NORMALIZED" | "SEMANTIC";
    similarity: number;
  }>;
  evaluatorModel: string;
  promptVersion: string;
};

export interface BlueprintQualityRepositoryV3 {
  getChapterBlueprintQualityContext(
    projectId: Hex,
    chapterId: number,
  ): Promise<ChapterBlueprintQualityContextV3>;
  approveChapterBlueprintCandidates(
    decision: BlueprintQualityDecisionV3 & { workUnits: ApprovedWorkUnitResultV2[] },
  ): Promise<void>;
  requestChapterBlueprintRepairs(
    decision: BlueprintQualityDecisionV3 & { repairs: Array<{ slotId: Hex; reason: string }> },
  ): Promise<void>;
}

export type ApprovedWorkUnitResultV2 = {
  workUnitId: number;
  cards: WorkerKnowledgeCardV2[];
  cardsRoot: Hex;
};

export type ChapterAssemblyV2 = {
  cards: KnowledgeCardV2[];
  cardsRoot: Hex;
};

export type WorkflowJobKindV2 =
  | "PLAN_OUTLINE"
  | "DESIGN_CHAPTER"
  | "FREEZE_PROJECT_DESIGN"
  | "RECONCILE_PROJECT"
  | "GENERATE_WORK_UNIT"
  | "QUALITY_CHECK_CHAPTER"
  | "ASSEMBLE_CHAPTER"
  | "FINALIZE_PROJECT"
  | "SETTLE_WORK_UNIT_REWARD";

export type WorkflowJobStatusV2 =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "RETRYABLE"
  | "FAILED"
  | "CANCELLED";

export type WorkflowJobV2 = {
  jobId: string;
  projectId: Hex;
  kind: WorkflowJobKindV2;
  chapterId: number | null;
  workUnitId: number | null;
  status: WorkflowJobStatusV2;
  attempt: number;
  input: Record<string, unknown>;
  lastError: string | null;
};

export type OutlinePlanningSourceV2 = {
  projectId: Hex;
  ownerAddress: `0x${string}`;
  goal: string | null;
  sourceHash: Hex;
  headVersion: number | null;
  sourceBlocks: SourceBlock[];
};

export type ChapterDesignSourceV3 = {
  projectId: Hex;
  goal: string | null;
  outlineVersion: number;
  chapter: ChapterOutlineItem;
  cardPolicy: ChapterCardPolicy;
  sourceBlocks: SourceBlock[];
};

export type ChapterDesignRunV3 = {
  designRunId: string;
  projectId: Hex;
  chapterId: number;
  outlineVersion: number;
  policyVersion: 3;
  status: "RUNNING" | "COMPLETED" | "REPAIR_EXHAUSTED" | "FAILED" | "CANCELLED";
  attempt: number;
};

export type ProjectDesignFreezeSourceV3 = {
  projectId: Hex;
  sourceHash: Hex;
  goalHash: Hex;
  outlineHash: Hex;
  outlineVersion: number;
  chapters: ChapterOutlineItem[];
  chapterPolicies: ChapterCardPolicy[];
  sourceBlocks: SourceBlock[];
  excludedRanges: SourceExclusionRange[];
  designs: Array<{
    chapterId: number;
    inventory: ChapterConceptInventory;
    blueprint: CardBlueprint;
    inventoryHash: Hex;
    blueprintHash: Hex;
  }>;
};

export type SavedProjectOutlineDraftV2 = {
  projectId: Hex;
  ownerAddress: `0x${string}`;
  expectedHeadVersion: number | null;
  outlineHash: Hex;
  plannerVersion: string;
  chapters: Record<string, unknown>[];
  exclusions: Record<string, unknown>[];
};

export interface WorkflowJobRepositoryV2 {
  recoverStaleWorkflowJobs(): Promise<number>;
  claimNextWorkflowJob(kinds: WorkflowJobKindV2[]): Promise<WorkflowJobV2 | null>;
  completeWorkflowJob(jobId: string, output: Record<string, unknown>): Promise<void>;
  retryWorkflowJob(jobId: string, message: string): Promise<void>;
  loadOutlinePlanningSource(projectId: Hex): Promise<OutlinePlanningSourceV2>;
  saveProjectOutlineDraft(input: SavedProjectOutlineDraftV2): Promise<number>;
}

export interface ChapterDesignRepositoryV3 {
  loadChapterDesignSource(projectId: Hex, chapterId: number): Promise<ChapterDesignSourceV3>;
  startChapterDesign(
    projectId: Hex,
    chapterId: number,
    outlineVersion: number,
  ): Promise<ChapterDesignRunV3>;
  completeChapterDesign(input: {
    designRunId: string;
    inventory: ChapterConceptInventory;
    blueprint: CardBlueprint;
    inventoryHash: Hex;
    blueprintHash: Hex;
    promptVersion: string;
    modelId: string;
    metrics: Record<string, unknown>;
  }): Promise<void>;
  failChapterDesign(designRunId: string, message: string, exhausted?: boolean): Promise<void>;
}

export interface ProjectDesignFreezeRepositoryV3 {
  loadProjectDesignFreezeSource(projectId: Hex): Promise<ProjectDesignFreezeSourceV3>;
  freezeProjectDesign(input: {
    projectId: Hex;
    outlineVersion: number;
    workUnitManifestRoot: Hex;
    workUnits: Record<string, unknown>[];
    slotAssignments: Array<{ slot_id: Hex; work_unit_id: number }>;
    frozenDesignHash: Hex;
    creationIntent: Record<string, unknown>;
  }): Promise<void>;
}

export interface WorkflowDispatchRepositoryV2 extends WorkflowJobRepositoryV2 {
  claimNextGenerationWorkflowJob(workerIndex: number): Promise<WorkflowJobV2 | null>;
  getWorkUnit(projectId: Hex, workUnitId: number): Promise<RunnerWorkUnitV2>;
  claimWorkflowWorkUnit(
    projectId: Hex,
    workUnitId: number,
    workerAddress: `0x${string}`,
  ): Promise<RunnerWorkUnitV2 | null>;
  claimWorkflowChapterQualityCheck(projectId: Hex, chapterId: number): Promise<boolean>;
  claimWorkflowChapterAssembly(projectId: Hex, chapterId: number): Promise<boolean>;
  claimWorkflowProjectFinalization(projectId: Hex): Promise<boolean>;
  claimWorkflowWorkUnitReward(projectId: Hex, workUnitId: number): Promise<WorkUnitRewardV2 | null>;
}

export type ProjectAgentEventV2 = {
  projectId: Hex;
  chapterId?: number;
  workUnitId?: number;
  role: "worker" | "chapter-quality-gate" | "chapter-assembler" | "project-finalizer" | "settlement-agent";
  type: string;
  payload?: Record<string, string | number | boolean>;
  txHash?: Hex;
};

export type ProjectFinalizationV2 = {
  projectId: Hex;
  projectDeckRoot: Hex;
  initialPlan: ReviewPlan;
  initialPlanHash: Hex;
  totalCardCount: number;
};

export interface RegistryReconciliationRepositoryV2 {
  getPendingRegistryProject(projectId: Hex): Promise<RegistryProjectIntentV2 | null>;
  markProjectRegistryReconciled(projectId: Hex, funding: ProjectEscrowFunding): Promise<void>;
}

export interface WorkUnitGenerationRepositoryV2 extends Partial<BlueprintWorkerRepositoryV3> {
  getWorkUnit(projectId: Hex, workUnitId: number): Promise<RunnerWorkUnitV2>;
  getChapterBundle(projectId: Hex, chapterId: number): Promise<ChapterBundleV2>;
  markWorkUnitValidating(projectId: Hex, workUnitId: number): Promise<void>;
  saveWorkUnitResult(projectId: Hex, workUnitId: number, result: SavedWorkUnitResultV2): Promise<void>;
  markWorkUnitSubmitting(projectId: Hex, workUnitId: number, txHash: Hex): Promise<void>;
  markWorkUnitConfirmed(
    projectId: Hex,
    workUnitId: number,
    confirmation: { txHash: Hex | null; blockNumber: bigint; gasUsed: bigint | null; confirmationMs: number },
  ): Promise<void>;
  markWorkUnitRetryable(projectId: Hex, workUnitId: number, message: string): Promise<void>;
  recordProjectAgentEvent(event: ProjectAgentEventV2): Promise<void>;
}

export interface ChapterQualityRepositoryV2 extends Partial<BlueprintQualityRepositoryV3> {
  getChapterBundle(projectId: Hex, chapterId: number): Promise<ChapterBundleV2>;
  approveChapterCandidates(
    projectId: Hex,
    chapterId: number,
    workUnits: ApprovedWorkUnitResultV2[],
  ): Promise<void>;
  requestChapterCandidateRepair(projectId: Hex, chapterId: number, message: string): Promise<void>;
  markChapterRetryable(projectId: Hex, chapterId: number, message: string): Promise<void>;
  recordProjectAgentEvent(event: ProjectAgentEventV2): Promise<void>;
}

export interface ChapterCommitmentRepositoryV2 {
  getChapterBundle(projectId: Hex, chapterId: number): Promise<ChapterBundleV2>;
  saveChapterAssembly(projectId: Hex, chapterId: number, assembly: ChapterAssemblyV2): Promise<void>;
  markChapterReady(projectId: Hex, chapterId: number, txHash: Hex | null): Promise<void>;
  markChapterRetryable(projectId: Hex, chapterId: number, message: string): Promise<void>;
  recordProjectAgentEvent(event: ProjectAgentEventV2): Promise<void>;
}

export interface ProjectCommitmentRepositoryV2 {
  getProjectBundle(projectId: Hex): Promise<ProjectBundleV2>;
  saveProjectFinalization(input: ProjectFinalizationV2): Promise<void>;
  markProjectReady(input: ProjectFinalizationV2 & { txHash: Hex | null }): Promise<void>;
  markProjectRetryable(projectId: Hex, message: string): Promise<void>;
  recordProjectAgentEvent(event: ProjectAgentEventV2): Promise<void>;
}

export type ChainProjectStateV2 = {
  learner: `0x${string}`;
  sourceHash: Hex;
  goalHash: Hex;
  outlineHash: Hex;
  workUnitManifestRoot: Hex;
  status: "CREATED" | "READY" | "CANCELLED";
  projectDeckRoot: Hex | null;
  initialPlanHash: Hex | null;
  chapterCount: number;
  workUnitCount: number;
  totalCardCount: number;
};

export type ChainChapterStateV2 = {
  status: "OPEN" | "READY";
  sourceHash: Hex;
  cardsRoot: Hex | null;
  firstWorkUnitId: number;
  workUnitCount: number;
  cardCount: number;
};

export type ChainWorkUnitCommitmentV2 = {
  chapterId: number;
  sourceUnitHash: Hex;
  cardsRoot: Hex;
  worker: `0x${string}`;
  committedBlock: bigint;
  cardCount: number;
};

export interface ProjectRegistryGatewayV2 {
  workerAddress(workerIndex: number): `0x${string}`;
  coordinatorAddress(): `0x${string}`;
  assertConfiguredWallets(): Promise<void>;
  readTransactionStatus(txHash: Hex): Promise<"PENDING" | "SUCCESS" | "REVERTED" | "NOT_FOUND">;
  readProject(projectId: Hex): Promise<ChainProjectStateV2 | null>;
  readChapter(projectId: Hex, chapterId: number): Promise<ChainChapterStateV2 | null>;
  readWorkUnit(projectId: Hex, workUnitId: number): Promise<ChainWorkUnitCommitmentV2 | null>;
  commitWorkUnit(
    workerIndex: number,
    input: {
      projectId: Hex;
      workUnitId: number;
      chapterId: number;
      sourceUnitHash: Hex;
      cardsRoot: Hex;
      cardCount: number;
      manifestProof: Hex[];
    },
    onSubmitted?: (txHash: Hex) => Promise<void>,
  ): Promise<ChainReceipt>;
  finalizeChapter(input: {
    projectId: Hex;
    chapterId: number;
    cardsRoot: Hex;
    cardCount: number;
  }): Promise<ChainReceipt>;
  finalizeProject(input: {
    projectId: Hex;
    projectDeckRoot: Hex;
    initialPlanHash: Hex;
    totalCardCount: number;
  }): Promise<ChainReceipt>;
}


export type WorkUnitRewardV2 = {
  projectId: Hex;
  workUnitId: number;
  treasuryAddress: `0x${string}`;
  recipientAddress: `0x${string}`;
  amountWei: bigint;
  status: WorkerRewardStatus;
  attempt: number;
  mossStage: MossRewardStage;
  mossPlanHash: Hex | null;
  simulationStatus: "NOT_RUN" | "PASSED" | "FAILED";
  simulationWarningCodes: string[];
  simulationGas: bigint | null;
  signedTransaction: import("viem").TransactionSerialized | null;
  treasuryNonce: bigint | null;
  txHash: Hex | null;
};

export interface WorkUnitRewardRepositoryV2 {
  markWorkUnitRewardStage(
    projectId: Hex,
    workUnitId: number,
    stage: Exclude<MossRewardStage, "PENDING" | "SIMULATED">,
  ): Promise<void>;
  markWorkUnitRewardPrepared(projectId: Hex, workUnitId: number, prepared: PreparedWorkerReward): Promise<void>;
  markWorkUnitRewardSubmitting(projectId: Hex, workUnitId: number, txHash: Hex): Promise<void>;
  markWorkUnitRewardConfirmed(projectId: Hex, workUnitId: number, receipt: WorkerRewardReceipt): Promise<void>;
  markWorkUnitRewardRetryable(projectId: Hex, workUnitId: number, message: string): Promise<void>;
  markWorkUnitRewardBlocked(projectId: Hex, workUnitId: number, message: string, warningCodes?: string[]): Promise<void>;
}
