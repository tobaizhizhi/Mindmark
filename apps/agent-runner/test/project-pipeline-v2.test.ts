import { afterEach, describe, expect, it, vi } from "vitest";
import { hashGoal, hashInitialPlan, hashKnowledgeCard, hashWorkUnitSourceV2, intakeSource } from "@mindmark/shared";
import type { Hex } from "viem";
import { ChapterAssembler } from "../src/chapter-assembler.js";
import { ChapterQualityGate } from "../src/chapter-quality-gate.js";
import { ProjectCoordinatorV2 } from "../src/coordinator-v2.js";
import { OutlinePlanningAgent } from "../src/outline-planning-agent.js";
import { ProjectFinalizerV2 } from "../src/project-finalizer-v2.js";
import { RegistryReconcilerV2 } from "../src/registry-reconciler-v2.js";
import { ProjectWorkflowDispatcherV2 } from "../src/workflow-dispatcher-v2.js";
import { WorkUnitSettlementAgentV2 } from "../src/reward-v2.js";
import type { AgentToolCall, ProjectSponsorGateway, ToolCallingModel } from "../src/runtime-types.js";
import type {
  ChapterAssemblyV2,
  ChapterBlueprintQualityContextV3,
  BlueprintQualityDecisionV3,
  ChainChapterStateV2,
  ChainProjectStateV2,
  ChainWorkUnitCommitmentV2,
  ChapterCommitmentRepositoryV2,
  ChapterQualityRepositoryV2,
  ProjectBundleV2,
  ProjectCommitmentRepositoryV2,
  ProjectRegistryGatewayV2,
  RegistryReconciliationRepositoryV2,
  RunnerChapterV2,
  RunnerProjectV2,
  RunnerWorkUnitV2,
  SavedWorkUnitResultV2,
  WorkUnitBlueprintContextV3,
  WorkUnitGenerationRepositoryV2,
  WorkflowDispatchRepositoryV2,
  WorkflowJobV2,
  WorkUnitRewardV2,
} from "../src/types-v2.js";
import { WorkUnitWorkerAgent, workUnitToolTimeoutMs } from "../src/worker-v2.js";
import type { CardQualityEvaluatorV3 } from "../src/quality-evaluator-v3.js";
import { address, hex } from "./fakes.js";

const projectId = hex("9");
const workers = [address("2"), address("3"), address("4")] as const;
const sponsorGateway: ProjectSponsorGateway = {
  escrowAddress: () => address("e"),
  sponsorAddress: () => address("f"),
  async assertConfiguredEscrow() {},
  async ensureProjectFunded(input) {
    const totalBudgetWei = input.quotes.reduce((total, quote) => total + quote.rewardAmountWei, 0n);
    return {
      projectId: input.projectId,
      escrowAddress: address("e"),
      sponsorAddress: address("f"),
      pricingMode: "DYNAMIC",
      pricingRoot: hex("d"),
      rewardPerWorkUnitWei: null,
      quotes: input.quotes,
      totalBudgetWei,
      remainingBudgetWei: totalBudgetWei,
      workUnitCount: input.quotes.length,
      settledWorkUnitCount: 0,
      fundingTxHash: hex("e"),
      fundedBlock: 10n,
    };
  },
};

afterEach(() => {
  vi.useRealTimers();
});

function fixtureState() {
  const source = intakeSource([
    { pageNumber: 1, text: "第一章 原理\n\n原理资料足够长，用于验证第一组知识卡引用必须逐字来自资料。" },
    { pageNumber: 2, text: "原理扩展资料足够长，用于验证第二组知识卡由另一个工作单元贡献。" },
    { pageNumber: 3, text: "第二章 防御\n\n防御资料足够长，用于验证第三组知识卡引用必须逐字来自资料。" },
    { pageNumber: 4, text: "防御扩展资料足够长，用于验证第四组知识卡由动态工作池处理。" },
  ]);
  const groups = [
    source.blocks.slice(0, 2),
    source.blocks.slice(2, 3),
    source.blocks.slice(3, 5),
    source.blocks.slice(5),
  ];
  const project: RunnerProjectV2 = {
    projectId,
    ownerAddress: address("a"),
    goal: "理解原理与防御",
    sourceHash: source.sourceHash,
    goalHash: hashGoal("理解原理与防御"),
    outlineHash: hex("7"),
    workUnitManifestRoot: hex("8"),
    status: "GENERATING",
    projectDeckRoot: null,
    initialPlan: null,
    initialPlanHash: null,
    totalCardCount: 0,
    generationPolicyVersion: 2,
  };
  const chapters: RunnerChapterV2[] = [0, 1].map((chapterId) => ({
    projectId,
    chapterId,
    position: chapterId,
    title: chapterId === 0 ? "原理" : "防御",
    summary: chapterId === 0 ? "理解调用原理" : "理解防御顺序",
    sourceHash: hex(chapterId === 0 ? "a" : "b"),
    importance: 5,
    status: "CONFIRMED",
    cardsRoot: null,
    cardCount: 0,
    minCardCount: 3,
    targetCardCount: 4,
    maxCardCount: 6,
    finalizeTxHash: null,
  }));
  const units: RunnerWorkUnitV2[] = groups.map((blocks, workUnitId) => ({
    projectId,
    workUnitId,
    chapterId: workUnitId < 2 ? 0 : 1,
    unitIndex: workUnitId % 2,
    startBlock: blocks[0]!.blockIndex,
    endBlock: blocks.at(-1)!.blockIndex,
    sourceText: blocks.map((block) => block.text).join("\n\n"),
    sourceBlocks: blocks,
    sourceUnitHash: hashWorkUnitSourceV2(blocks),
    manifestProof: [],
    cardMinimum: 2,
    cardTarget: 2,
    cardBudget: 2,
    workerAddress: null,
    status: "QUEUED",
    attempt: 0,
    workerCards: [],
    cardsRoot: null,
    cardCount: null,
    commitTxHash: null,
  }));
  return { project, chapters, units, cards: [] as ChapterAssemblyV2["cards"] };
}

class InMemoryProjectRepositoryV2 implements
  RegistryReconciliationRepositoryV2,
  WorkUnitGenerationRepositoryV2,
  ChapterQualityRepositoryV2,
  ChapterCommitmentRepositoryV2,
  ProjectCommitmentRepositoryV2 {
  state = fixtureState();
  claims: Array<{ workUnitId: number; worker: string }> = [];
  events: string[] = [];
  pendingRegistry = false;
  blueprintContext: WorkUnitBlueprintContextV3 | null = null;
  blueprintQualityContext: ChapterBlueprintQualityContextV3 | null = null;
  lastSavedWorkUnitResult: SavedWorkUnitResultV2 | null = null;
  lastBlueprintApproval: (BlueprintQualityDecisionV3 & {
    workUnits: Parameters<ChapterQualityRepositoryV2["approveChapterCandidates"]>[2];
  }) | null = null;
  lastBlueprintRepairs: (BlueprintQualityDecisionV3 & {
    repairs: Array<{ slotId: Hex; reason: string }>;
  }) | null = null;

  async getPendingRegistryProject(candidateProjectId: Hex) {
    if (!this.pendingRegistry || candidateProjectId !== projectId) return null;
    return {
      projectId,
      ownerAddress: this.state.project.ownerAddress,
      sourceHash: this.state.project.sourceHash,
      goalHash: this.state.project.goalHash,
      outlineHash: this.state.project.outlineHash,
      workUnitManifestRoot: this.state.project.workUnitManifestRoot,
      chapterCount: this.state.chapters.length,
      workUnitCount: this.state.units.length,
      pricingInputs: this.state.units.map((unit) => ({
        workUnitId: unit.workUnitId,
        sourceCharacterCount: unit.sourceText!.length,
        slots: Array.from({ length: unit.cardTarget }, () => ({ type: "concept" as const, difficulty: 1 })),
      })),
    };
  }
  async markProjectRegistryReconciled() {
    this.pendingRegistry = false;
    this.state.project.status = "GENERATING";
  }
  async getWorkUnit(_id: Hex, workUnitId: number) { return structuredClone(this.state.units[workUnitId]!); }
  async getWorkUnitBlueprintContext() {
    if (!this.blueprintContext) throw new Error("Blueprint context is not configured");
    return structuredClone(this.blueprintContext);
  }
  async getChapterBlueprintQualityContext() {
    if (!this.blueprintQualityContext) throw new Error("Blueprint quality context is not configured");
    return structuredClone(this.blueprintQualityContext);
  }
  async approveChapterBlueprintCandidates(
    decision: BlueprintQualityDecisionV3 & {
      workUnits: Parameters<ChapterQualityRepositoryV2["approveChapterCandidates"]>[2];
    },
  ) {
    this.lastBlueprintApproval = structuredClone(decision);
    await this.approveChapterCandidates(decision.projectId, decision.chapterId, decision.workUnits);
  }
  async requestChapterBlueprintRepairs(
    decision: BlueprintQualityDecisionV3 & { repairs: Array<{ slotId: Hex; reason: string }> },
  ) {
    this.lastBlueprintRepairs = structuredClone(decision);
    const repairSlots = new Set(decision.repairs.map((repair) => repair.slotId));
    const workUnitIds = new Set(
      this.blueprintQualityContext!.candidates
        .filter((candidate) => repairSlots.has(candidate.slotId))
        .map((candidate) => candidate.workUnitId),
    );
    for (const workUnitId of workUnitIds) {
      Object.assign(this.state.units[workUnitId]!, {
        status: "REPAIRING",
        workerCards: [],
        cardsRoot: null,
        cardCount: null,
      });
    }
    this.state.chapters[decision.chapterId]!.status = "GENERATING";
  }
  async markWorkUnitValidating(_id: Hex, workUnitId: number) { this.state.units[workUnitId]!.status = "VALIDATING"; }
  async saveWorkUnitResult(_id: Hex, workUnitId: number, result: SavedWorkUnitResultV2) {
    this.lastSavedWorkUnitResult = structuredClone(result);
    Object.assign(this.state.units[workUnitId]!, {
      workerCards: structuredClone(result.cards), cardsRoot: result.cardsRoot,
      cardCount: result.cards.length, status: "CANDIDATE_READY",
    });
  }
  async markWorkUnitSubmitting(_id: Hex, workUnitId: number, txHash: Hex) {
    Object.assign(this.state.units[workUnitId]!, { status: "SUBMITTING", commitTxHash: txHash });
  }
  async markWorkUnitConfirmed(_id: Hex, workUnitId: number, confirmation: { txHash: Hex | null }) {
    Object.assign(this.state.units[workUnitId]!, {
      status: "CONFIRMED",
      ...(confirmation.txHash ? { commitTxHash: confirmation.txHash } : {}),
    });
  }
  async markWorkUnitRetryable(_id: Hex, workUnitId: number) {
    const unit = this.state.units[workUnitId]!;
    unit.status = unit.cardsRoot && ["APPROVED", "SUBMITTING"].includes(unit.status)
      ? "APPROVED"
      : "RETRYABLE";
  }
  async approveChapterCandidates(
    _id: Hex,
    chapterId: number,
    workUnits: Parameters<ChapterQualityRepositoryV2["approveChapterCandidates"]>[2],
  ) {
    for (const approved of workUnits) {
      Object.assign(this.state.units[approved.workUnitId]!, {
        workerCards: structuredClone(approved.cards),
        cardsRoot: approved.cardsRoot,
        cardCount: approved.cards.length,
        status: "APPROVED",
      });
    }
    this.state.chapters[chapterId]!.status = "GENERATING";
  }
  async requestChapterCandidateRepair(_id: Hex, chapterId: number) {
    for (const unit of this.state.units.filter((candidate) => candidate.chapterId === chapterId)) {
      Object.assign(unit, {
        status: "REPAIRING",
        workerCards: [],
        cardsRoot: null,
        cardCount: null,
        commitTxHash: null,
      });
    }
    this.state.chapters[chapterId]!.status = "GENERATING";
  }
  async getChapterBundle(_id: Hex, chapterId: number) {
    return structuredClone({
      project: this.state.project,
      chapter: this.state.chapters[chapterId]!,
      workUnits: this.state.units.filter((unit) => unit.chapterId === chapterId),
    });
  }
  async saveChapterAssembly(_id: Hex, chapterId: number, assembly: ChapterAssemblyV2) {
    this.state.cards.push(...structuredClone(assembly.cards));
    Object.assign(this.state.chapters[chapterId]!, { cardsRoot: assembly.cardsRoot, cardCount: assembly.cards.length });
  }
  async markChapterReady(_id: Hex, chapterId: number, txHash: Hex | null) {
    Object.assign(this.state.chapters[chapterId]!, { status: "READY", finalizeTxHash: txHash });
  }
  async markChapterRetryable(_id: Hex, chapterId: number) { this.state.chapters[chapterId]!.status = "FAILED_RETRYABLE"; }
  async getProjectBundle(): Promise<ProjectBundleV2> {
    return structuredClone({ project: this.state.project, chapters: this.state.chapters, cards: this.state.cards });
  }
  async saveProjectFinalization(input: Parameters<ProjectCommitmentRepositoryV2["saveProjectFinalization"]>[0]) {
    Object.assign(this.state.project, {
      projectDeckRoot: input.projectDeckRoot,
      initialPlan: input.initialPlan,
      initialPlanHash: input.initialPlanHash,
      totalCardCount: input.totalCardCount,
    });
  }
  async markProjectReady(input: Parameters<ProjectCommitmentRepositoryV2["markProjectReady"]>[0]) {
    Object.assign(this.state.project, {
      status: "READY", projectDeckRoot: input.projectDeckRoot,
      initialPlan: input.initialPlan, initialPlanHash: input.initialPlanHash,
      totalCardCount: input.totalCardCount,
    });
  }
  async markProjectRetryable() { this.state.project.status = "FAILED_RETRYABLE"; }
  async recordProjectAgentEvent(event: Parameters<WorkUnitGenerationRepositoryV2["recordProjectAgentEvent"]>[0]) {
    this.events.push(event.type);
  }
}

class InMemoryWorkflowRepositoryV2 extends InMemoryProjectRepositoryV2 implements WorkflowDispatchRepositoryV2 {
  private jobs: WorkflowJobV2[];
  private nextJob = 1;

  constructor() {
    super();
    this.jobs = [];
    for (const unit of this.state.units) {
      this.enqueue("GENERATE_WORK_UNIT", unit.chapterId, unit.workUnitId);
    }
  }

  async recoverStaleWorkflowJobs() { return 0; }

  async claimNextWorkflowJob(kinds: WorkflowJobV2["kind"][]) {
    const job = this.jobs.find((candidate) =>
      kinds.includes(candidate.kind) && ["QUEUED", "RETRYABLE"].includes(candidate.status),
    );
    if (!job) return null;
    job.status = "RUNNING";
    job.attempt += 1;
    return structuredClone(job);
  }

  async completeWorkflowJob(jobId: string) {
    const job = this.jobs.find((candidate) => candidate.jobId === jobId)!;
    job.status = "SUCCEEDED";
  }

  async retryWorkflowJob(jobId: string, message: string) {
    const job = this.jobs.find((candidate) => candidate.jobId === jobId)!;
    job.status = "RETRYABLE";
    job.lastError = message;
  }

  async loadOutlinePlanningSource(): Promise<never> { throw new Error("not used by workflow dispatch test"); }
  async saveProjectOutlineDraft(): Promise<never> { throw new Error("not used by workflow dispatch test"); }

  async claimWorkflowWorkUnit(_id: Hex, workUnitId: number, workerAddress: `0x${string}`) {
    const unit = this.state.units[workUnitId];
    if (!unit || !["QUEUED", "RETRYABLE", "REPAIRING", "APPROVED", "SUBMITTING", "GENERATING"].includes(unit.status)) {
      return null;
    }
    if (["QUEUED", "RETRYABLE", "REPAIRING"].includes(unit.status)) {
      unit.status = "GENERATING";
      unit.workerAddress = workerAddress;
      unit.attempt += 1;
      this.state.chapters[unit.chapterId]!.status = "GENERATING";
    } else if (unit.workerAddress !== workerAddress) {
      return null;
    }
    this.claims.push({ workUnitId, worker: workerAddress });
    return structuredClone(unit);
  }

  async claimWorkflowChapterQualityCheck(_id: Hex, chapterId: number) {
    const chapter = this.state.chapters[chapterId];
    if (!chapter || !["GENERATING", "FAILED_RETRYABLE"].includes(chapter.status)) return false;
    if (!this.state.units.filter((unit) => unit.chapterId === chapterId).every((unit) => unit.status === "CANDIDATE_READY")) return false;
    chapter.status = "QUALITY_CHECK";
    return true;
  }

  async claimWorkflowChapterAssembly(_id: Hex, chapterId: number) {
    const chapter = this.state.chapters[chapterId];
    if (!chapter || !["GENERATING", "FAILED_RETRYABLE"].includes(chapter.status)) return false;
    if (!this.state.units.filter((unit) => unit.chapterId === chapterId).every((unit) => unit.status === "CONFIRMED")) return false;
    chapter.status = "ASSEMBLING";
    return true;
  }

  async claimWorkflowProjectFinalization() {
    if (this.state.project.status !== "GENERATING" || this.state.chapters.some((chapter) => chapter.status !== "READY")) return false;
    this.state.project.status = "FINALIZING";
    return true;
  }

  async claimWorkflowWorkUnitReward(): Promise<WorkUnitRewardV2 | null> { return null; }
  async markWorkUnitRewardStage() {}
  async markWorkUnitRewardPrepared() {}
  async markWorkUnitRewardSubmitting() {}
  async markWorkUnitRewardConfirmed() {}
  async markWorkUnitRewardRetryable() {}
  async markWorkUnitRewardBlocked() {}

  override async saveWorkUnitResult(
    id: Hex,
    workUnitId: number,
    result: SavedWorkUnitResultV2,
  ) {
    await super.saveWorkUnitResult(id, workUnitId, result);
    const unit = this.state.units[workUnitId]!;
    if (this.state.units.filter((candidate) => candidate.chapterId === unit.chapterId)
      .every((candidate) => candidate.status === "CANDIDATE_READY")) {
      this.enqueue("QUALITY_CHECK_CHAPTER", unit.chapterId);
    }
  }

  override async approveChapterCandidates(
    id: Hex,
    chapterId: number,
    workUnits: Parameters<ChapterQualityRepositoryV2["approveChapterCandidates"]>[2],
  ) {
    await super.approveChapterCandidates(id, chapterId, workUnits);
    for (const unit of this.state.units.filter((candidate) => candidate.chapterId === chapterId)) {
      this.enqueue("GENERATE_WORK_UNIT", chapterId, unit.workUnitId);
    }
  }

  override async markWorkUnitConfirmed(
    id: Hex,
    workUnitId: number,
    confirmation: Parameters<WorkUnitGenerationRepositoryV2["markWorkUnitConfirmed"]>[2],
  ) {
    await super.markWorkUnitConfirmed(id, workUnitId, confirmation);
    const unit = this.state.units[workUnitId]!;
    if (this.state.units.filter((candidate) => candidate.chapterId === unit.chapterId)
      .every((candidate) => candidate.status === "CONFIRMED")) {
      this.enqueue("ASSEMBLE_CHAPTER", unit.chapterId);
    }
  }

  override async markChapterReady(id: Hex, chapterId: number, txHash: Hex | null) {
    await super.markChapterReady(id, chapterId, txHash);
    if (this.state.chapters.every((chapter) => chapter.status === "READY")) {
      this.enqueue("FINALIZE_PROJECT");
    }
  }

  workflowJobs() { return structuredClone(this.jobs); }

  private enqueue(kind: WorkflowJobV2["kind"], chapterId: number | null = null, workUnitId: number | null = null) {
    const active = this.jobs.find((job) =>
      job.kind === kind && job.chapterId === chapterId && job.workUnitId === workUnitId &&
      ["QUEUED", "RUNNING", "RETRYABLE"].includes(job.status),
    );
    if (active) return active;
    const job: WorkflowJobV2 = {
      jobId: `123e4567-e89b-42d3-a456-${String(this.nextJob++).padStart(12, "0")}`,
      projectId,
      kind,
      chapterId,
      workUnitId,
      status: "QUEUED",
      attempt: 0,
      input: {},
      lastError: null,
    };
    this.jobs.push(job);
    return job;
  }
}

class FakeProjectRegistryV2 implements ProjectRegistryGatewayV2 {
  workUnits = new Map<number, ChainWorkUnitCommitmentV2>();
  chapters = new Map<number, ChainChapterStateV2>();
  project: ChainProjectStateV2 = {
    learner: address("a"), sourceHash: fixtureState().project.sourceHash,
    goalHash: fixtureState().project.goalHash, outlineHash: fixtureState().project.outlineHash,
    workUnitManifestRoot: fixtureState().project.workUnitManifestRoot,
    status: "CREATED", projectDeckRoot: null, initialPlanHash: null,
    chapterCount: 2, workUnitCount: 4, totalCardCount: 0,
  };
  txIndex = 1;

  workerAddress(index: number) { return workers[index]!; }
  coordinatorAddress() { return address("5"); }
  async assertConfiguredWallets() {}
  async readTransactionStatus() { return "SUCCESS" as const; }
  async readProject() { return structuredClone(this.project); }
  async readChapter(_id: Hex, chapterId: number) {
    return structuredClone(this.chapters.get(chapterId) ?? {
      status: "OPEN" as const, sourceHash: hex(chapterId === 0 ? "a" : "b"), cardsRoot: null,
      firstWorkUnitId: chapterId * 2, workUnitCount: 2, cardCount: 0,
    });
  }
  async readWorkUnit(_id: Hex, workUnitId: number) { return structuredClone(this.workUnits.get(workUnitId) ?? null); }
  async commitWorkUnit(workerIndex: number, input: Parameters<ProjectRegistryGatewayV2["commitWorkUnit"]>[1], onSubmitted?: (txHash: Hex) => Promise<void>) {
    const txHash = hex((this.txIndex++).toString(16));
    await onSubmitted?.(txHash);
    this.workUnits.set(input.workUnitId, {
      chapterId: input.chapterId, sourceUnitHash: input.sourceUnitHash,
      cardsRoot: input.cardsRoot, worker: this.workerAddress(workerIndex),
      committedBlock: 100n, cardCount: input.cardCount,
    });
    return { txHash, blockNumber: 100n, gasUsed: 80_000n, confirmationMs: 5 };
  }
  async finalizeChapter(input: Parameters<ProjectRegistryGatewayV2["finalizeChapter"]>[0]) {
    this.chapters.set(input.chapterId, {
      status: "READY", sourceHash: hex(input.chapterId === 0 ? "a" : "b"),
      cardsRoot: input.cardsRoot, firstWorkUnitId: input.chapterId * 2,
      workUnitCount: 2, cardCount: input.cardCount,
    });
    return { txHash: hex((this.txIndex++).toString(16)), blockNumber: 200n, gasUsed: 90_000n, confirmationMs: 5 };
  }
  async finalizeProject(input: Parameters<ProjectRegistryGatewayV2["finalizeProject"]>[0]) {
    this.project = {
      ...this.project, status: "READY", projectDeckRoot: input.projectDeckRoot,
      initialPlanHash: input.initialPlanHash, totalCardCount: input.totalCardCount,
    };
    return { txHash: hex("f"), blockNumber: 300n, gasUsed: 100_000n, confirmationMs: 5 };
  }
}

class AdaptiveWorkUnitModel implements ToolCallingModel {
  constructor(
    private readonly fixedCardCount?: number,
    private readonly repeatAcrossWorkUnits = false,
  ) {}

  async nextTool(input: Parameters<ToolCallingModel["nextTool"]>[0]): Promise<AgentToolCall> {
    const step = input.transcript.length;
    if (step === 0) return { id: "read", name: "read_assigned_work_unit", arguments: {} };
    if (step === 1) {
      const result = input.transcript[0]!.result as { blocks: Array<{ blockIndex: number; pageNumber: number; text: string }> };
      const block = result.blocks.find((candidate) => candidate.text.length >= 20) ?? result.blocks[0]!;
      const cardCount = this.fixedCardCount ?? (result as typeof result & { cardTarget?: number }).cardTarget ?? 2;
      const cards = Array.from({ length: cardCount }, (_, cardIndex) => ({
        type: "qa" as const,
        question: this.repeatAcrossWorkUnits
          ? `本章关键内容 ${cardIndex + 1} 是什么？`
          : `资料块 ${block.blockIndex} 的关键内容 ${cardIndex + 1} 是什么？`,
        answer: `该资料块强调：${block.text}`,
        keyPoint: this.repeatAcrossWorkUnits
          ? `本章核心 ${cardIndex + 1}`
          : `资料块 ${block.blockIndex} 的核心 ${cardIndex + 1}`,
        source: { page: block.pageNumber, quote: block.text },
        tags: [`block-${block.blockIndex}`],
        importance: 4,
        initialDifficulty: 3,
      }));
      cards.forEach((content) => hashKnowledgeCard(content));
      return { id: "save", name: "save_work_unit_draft", arguments: { cards } };
    }
    if (step === 2) return { id: "validate", name: "validate_work_unit_cards", arguments: {} };
    if (step === 3) return { id: "get", name: "get_work_unit_commitment", arguments: {} };
    return { id: "submit", name: "submit_work_unit_commitment", arguments: {} };
  }
}

class WaitingWorkUnitModel implements ToolCallingModel {
  async nextTool(input: Parameters<ToolCallingModel["nextTool"]>[0]): Promise<AgentToolCall> {
    return new Promise((_, reject) => {
      const abort = () => reject(input.signal.reason);
      if (input.signal.aborted) abort();
      else input.signal.addEventListener("abort", abort, { once: true });
    });
  }
}

class NonAbortableWorkUnitModel implements ToolCallingModel {
  async nextTool(): Promise<AgentToolCall> {
    return new Promise(() => undefined);
  }
}

class TransientFailureModel implements ToolCallingModel {
  failures = 0;

  constructor(private readonly delegate: ToolCallingModel) {}

  async nextTool(input: Parameters<ToolCallingModel["nextTool"]>[0]): Promise<AgentToolCall> {
    if (this.failures === 0) {
      this.failures += 1;
      throw new Error("AI model request failed with status 503");
    }
    return this.delegate.nextTool(input);
  }
}

class BlueprintWorkUnitModel implements ToolCallingModel {
  repairInstructions: unknown = null;
  batchSizes: number[] = [];

  constructor(
    private readonly omitLastSlot = false,
    private readonly paraphraseCitation = false,
  ) {}

  async nextTool(input: Parameters<ToolCallingModel["nextTool"]>[0]): Promise<AgentToolCall> {
    const step = input.transcript.length;
    if (step === 0) return { id: "read", name: "read_assigned_work_unit", arguments: {} };
    if (step % 2 === 0) return { id: `validate-${step}`, name: "validate_work_unit_cards", arguments: {} };
    const result = input.transcript[0]!.result as {
      blocks: Array<{ blockIndex: number; pageNumber: number; text: string }>;
      blueprintSlots: Array<{
        blueprintSlotId: Hex;
        conceptName: string;
        objective: string;
        type: "concept" | "comparison" | "process" | "application" | "misconception";
        difficulty: number;
        evidenceBlockIndexes: number[];
      }>;
      repairInstructions?: unknown[];
    };
    this.repairInstructions = result.repairInstructions ?? [];
    const slots = this.omitLastSlot ? result.blueprintSlots.slice(0, -1) : result.blueprintSlots;
    this.batchSizes.push(result.blueprintSlots.length);
    return {
      id: `save-${step}`,
      name: "save_work_unit_draft",
      arguments: {
        cards: slots.map((slot) => {
          const block = result.blocks.find(
            (candidate) => candidate.blockIndex === slot.evidenceBlockIndexes[0],
          )!;
          return {
            blueprintSlotId: slot.blueprintSlotId,
            type: slot.type === "concept" ? "concept" : "qa",
            question: `${slot.conceptName}：${slot.objective}？`,
            answer: block.text,
            keyPoint: `${slot.conceptName} / ${slot.objective}`,
            source: {
              page: block.pageNumber,
              quote: this.paraphraseCitation
                ? "这是一段由模型改写而非从证据块逐字复制的引用内容。"
                : block.text,
            },
            tags: [slot.conceptName],
            importance: 4,
            initialDifficulty: slot.difficulty,
          };
        }),
      },
    };
  }
}

class LanguageRepairBlueprintModel implements ToolCallingModel {
  calls = 0;

  async nextTool(input: Parameters<ToolCallingModel["nextTool"]>[0]): Promise<AgentToolCall> {
    const step = input.transcript.length;
    this.calls += 1;
    if (step === 0) return { id: "read", name: "read_assigned_work_unit", arguments: {} };
    const result = input.transcript[0]!.result as {
      blocks: Array<{ blockIndex: number; pageNumber: number; text: string }>;
      blueprintSlots: Array<{
        blueprintSlotId: Hex;
        conceptName: string;
        objective: string;
        type: "concept" | "comparison" | "process" | "application" | "misconception";
        difficulty: number;
        evidenceBlockIndexes: number[];
      }>;
    };
    const chinese = step >= 2;
    return {
      id: chinese ? "save-chinese" : "save-english",
      name: "save_work_unit_draft",
      arguments: {
        cards: result.blueprintSlots.map((slot, slotIndex) => {
          const block = result.blocks.find(
            (candidate) => candidate.blockIndex === slot.evidenceBlockIndexes[0],
          )!;
          const slotSuffix = slot.blueprintSlotId.slice(-4);
          return {
            blueprintSlotId: slot.blueprintSlotId,
            type: slot.type === "concept" ? "concept" : "qa",
            question: chinese
              ? `${slot.conceptName}的关键机制${slotIndex + 1}-${slotSuffix}是什么？`
              : `What is key mechanism ${slotIndex + 1}-${slotSuffix}?`,
            answer: chinese ? `资料指出：${block.text}` : `The source states: ${block.text}`,
            keyPoint: chinese
              ? `理解资料中的核心机制${slotIndex + 1}-${slotSuffix}`
              : `Understand core mechanism ${slotIndex + 1}-${slotSuffix}`,
            source: { page: block.pageNumber, quote: block.text },
            tags: chinese ? ["核心机制"] : ["core mechanism"],
            importance: 4,
            initialDifficulty: slot.difficulty,
          };
        }),
      },
    };
  }
}

function blueprintContextFor(unit: RunnerWorkUnitV2): WorkUnitBlueprintContextV3 {
  const evidenceBlockIndex = unit.sourceBlocks!.find((block) => block.text.length >= 20)!.blockIndex;
  const conceptId = hex("c");
  const slots: WorkUnitBlueprintContextV3["slots"] = [
    {
      slotId: hex("d"),
      conceptId,
      type: "concept",
      objective: "准确说明核心机制",
      difficulty: 2,
      sourceBlockIndexes: [evidenceBlockIndex],
      required: true,
    },
    {
      slotId: hex("e"),
      conceptId,
      type: "application",
      objective: "根据机制判断应用场景",
      difficulty: 4,
      sourceBlockIndexes: [evidenceBlockIndex],
      required: true,
    },
  ];
  return {
    designRunId: "00000000-0000-4000-8000-000000000003",
    inventory: {
      projectId,
      chapterId: unit.chapterId,
      outlineVersion: 1,
      sourceHash: hex("a"),
      policyVersion: 3,
      concepts: [{
        conceptId,
        name: "调用原理",
        importance: 5,
        learningObjective: "解释调用原理并应用它",
        sourceBlockIndexes: [evidenceBlockIndex],
        prerequisites: [],
        misconceptions: [],
      }],
    },
    blueprint: {
      projectId,
      chapterId: unit.chapterId,
      outlineVersion: 1,
      inventoryHash: hex("b"),
      policyVersion: 3,
      slots,
    },
    slots,
    repairInstructions: [],
  };
}

function configureBlueprintQualityContext(repository: InMemoryProjectRepositoryV2): void {
  const context = repository.blueprintContext!;
  const cards = repository.state.units[0]!.workerCards;
  repository.blueprintQualityContext = {
    designRunId: context.designRunId,
    inventory: context.inventory,
    blueprint: context.blueprint,
    candidates: context.slots.map((slot, index) => ({
      designRunId: context.designRunId,
      slotId: slot.slotId,
      workUnitId: 0,
      candidateRevision: 1,
      status: "CANDIDATE_READY",
      card: cards[index]!,
    })),
  };
}

describe("Chapter-first V2 Runner pipeline", () => {
  it("scales the Worker tool-loop timeout for legacy oversized Blueprint batches", () => {
    expect(workUnitToolTimeoutMs(120_000, 8)).toBe(156_000);
    expect(workUnitToolTimeoutMs(120_000, 22)).toBe(324_000);
    expect(workUnitToolTimeoutMs(300_000, 2)).toBe(300_000);
  });

  it("recovers a Project when the wallet callback was lost after Registry creation", async () => {
    const repository = new InMemoryProjectRepositoryV2();
    repository.state.project.status = "AWAITING_REGISTRY";
    repository.pendingRegistry = true;
    const registry = new FakeProjectRegistryV2();

    await expect(new RegistryReconcilerV2(repository, registry, sponsorGateway, 1n)
      .reconcileProject(projectId)).resolves.toBe("RECONCILED");
    expect(repository.state.project.status).toBe("GENERATING");
  });

  it("reconciles only the exact pending Project requested by its Workflow Job", async () => {
    const repository = new InMemoryProjectRepositoryV2();
    repository.state.project.status = "AWAITING_REGISTRY";
    repository.pendingRegistry = true;
    const registry = new FakeProjectRegistryV2();

    await expect(new RegistryReconcilerV2(repository, registry, sponsorGateway, 1n)
      .reconcileProject(hex("1"))).resolves.toBe("OBSOLETE");
    expect(repository.pendingRegistry).toBe(true);
    expect(repository.state.project.status).toBe("AWAITING_REGISTRY");
  });

  it("does not commit a Work Unit that returns fewer cards than required", async () => {
    const repository = new InMemoryWorkflowRepositoryV2();
    const registry = new FakeProjectRegistryV2();
    const worker = new WorkUnitWorkerAgent(
      repository,
      registry,
      new AdaptiveWorkUnitModel(1),
      0,
      { maxToolCalls: 5 },
    );

    const unit = await repository.claimWorkflowWorkUnit(projectId, 0, registry.workerAddress(0));
    expect(unit).not.toBeNull();
    await expect(worker.runClaimed(unit!)).rejects.toThrow(/minimum|at least/u);

    expect(registry.workUnits.size).toBe(0);
    expect(repository.state.units[0]?.status).toBe("RETRYABLE");
  });

  it("generates exactly one grounded candidate for each V3 Blueprint Slot", async () => {
    const repository = new InMemoryWorkflowRepositoryV2();
    repository.state.units = repository.state.units.filter((unit) => unit.chapterId !== 0 || unit.workUnitId === 0);
    repository.state.project.generationPolicyVersion = 3;
    repository.blueprintContext = blueprintContextFor(repository.state.units[0]!);
    const registry = new FakeProjectRegistryV2();
    const worker = new WorkUnitWorkerAgent(repository, registry, new BlueprintWorkUnitModel(), 0);

    const unit = await repository.claimWorkflowWorkUnit(projectId, 0, registry.workerAddress(0));
    await expect(worker.runClaimed(unit!)).resolves.toBeUndefined();

    expect(repository.state.units[0]?.status).toBe("CANDIDATE_READY");
    expect(repository.lastSavedWorkUnitResult?.slotCandidates).toEqual([
      { slotId: hex("d"), cardId: repository.state.units[0]!.workerCards[0]!.id },
      { slotId: hex("e"), cardId: repository.state.units[0]!.workerCards[1]!.id },
    ]);
  });

  it("batches a legacy oversized V3 Work Unit without changing its persisted commitment", async () => {
    const repository = new InMemoryWorkflowRepositoryV2();
    repository.state.units = repository.state.units.filter((unit) => unit.chapterId !== 0 || unit.workUnitId === 0);
    repository.state.project.generationPolicyVersion = 3;
    const context = blueprintContextFor(repository.state.units[0]!);
    const template = context.slots[0]!;
    const slots = Array.from({ length: 21 }, (_, index) => ({
      ...template,
      slotId: `0x${(index + 1).toString(16).padStart(64, "0")}` as Hex,
      objective: `准确说明核心机制 ${index + 1}`,
    }));
    repository.blueprintContext = {
      ...context,
      blueprint: { ...context.blueprint, slots },
      slots,
    };
    Object.assign(repository.state.units[0]!, {
      cardMinimum: 21,
      cardTarget: 21,
      cardBudget: 21,
    });
    const registry = new FakeProjectRegistryV2();
    const model = new BlueprintWorkUnitModel();
    const worker = new WorkUnitWorkerAgent(repository, registry, model, 0);

    const unit = await repository.claimWorkflowWorkUnit(projectId, 0, registry.workerAddress(0));
    await expect(worker.runClaimed(unit!)).resolves.toBeUndefined();

    expect(model.batchSizes).toEqual(Array.from({ length: 21 }, () => 1));
    expect(repository.lastSavedWorkUnitResult?.cards).toHaveLength(21);
    expect(repository.lastSavedWorkUnitResult?.slotCandidates).toHaveLength(21);
    expect(repository.state.units[0]?.status).toBe("CANDIDATE_READY");
  });

  it("derives a verbatim Slot citation when the model paraphrases its quote", async () => {
    const repository = new InMemoryWorkflowRepositoryV2();
    repository.state.units = repository.state.units.filter((unit) => unit.chapterId !== 0 || unit.workUnitId === 0);
    repository.state.project.generationPolicyVersion = 3;
    repository.blueprintContext = blueprintContextFor(repository.state.units[0]!);
    const registry = new FakeProjectRegistryV2();
    const worker = new WorkUnitWorkerAgent(repository, registry, new BlueprintWorkUnitModel(false, true), 0);

    const unit = await repository.claimWorkflowWorkUnit(projectId, 0, registry.workerAddress(0));
    await expect(worker.runClaimed(unit!)).resolves.toBeUndefined();

    const sourceBlocks = repository.state.units[0]!.sourceBlocks!;
    expect(repository.state.units[0]!.workerCards).toHaveLength(2);
    for (const card of repository.state.units[0]!.workerCards) {
      expect(sourceBlocks.some((block) =>
        block.pageNumber === card.source.page && block.text.includes(card.source.quote),
      )).toBe(true);
    }
  });

  it("recovers a frozen Blueprint whose Slot cites only a short section heading", async () => {
    const repository = new InMemoryWorkflowRepositoryV2();
    repository.state.units = repository.state.units.filter((unit) => unit.chapterId !== 0 || unit.workUnitId === 0);
    repository.state.project.generationPolicyVersion = 3;
    const sourceBlocks = repository.state.units[0]!.sourceBlocks!;
    const heading = sourceBlocks[0]!;
    heading.kind = "heading";
    heading.text = "2. 实时调度算法";
    const body = sourceBlocks[1]!;
    body.kind = "paragraph";
    body.text = "实时调度会依据任务截止时间和优先级决定执行顺序，并保证硬实时任务按时完成。";
    const context = blueprintContextFor(repository.state.units[0]!);
    context.inventory.concepts[0]!.sourceBlockIndexes = [heading.blockIndex];
    context.slots = context.slots.map((slot) => ({
      ...slot,
      sourceBlockIndexes: [heading.blockIndex],
    }));
    context.blueprint.slots = structuredClone(context.slots);
    repository.blueprintContext = context;
    const registry = new FakeProjectRegistryV2();
    const worker = new WorkUnitWorkerAgent(
      repository,
      registry,
      new BlueprintWorkUnitModel(false, true),
      0,
    );

    const unit = await repository.claimWorkflowWorkUnit(projectId, 0, registry.workerAddress(0));
    await expect(worker.runClaimed(unit!)).resolves.toBeUndefined();

    expect(repository.state.units[0]?.status).toBe("CANDIDATE_READY");
    expect(repository.state.units[0]?.workerCards).toHaveLength(2);
    expect(repository.state.units[0]?.workerCards.every((card) =>
      card.source.page === body.pageNumber && body.text.includes(card.source.quote),
    )).toBe(true);
  });

  it("uses expanded legacy evidence and a deterministic Rubric when the quality model fails", async () => {
    const repository = new InMemoryWorkflowRepositoryV2();
    repository.state.units = repository.state.units.filter((unit) => unit.chapterId !== 0 || unit.workUnitId === 0);
    repository.state.project.generationPolicyVersion = 3;
    repository.state.chapters[0]!.minCardCount = 2;
    const sourceBlocks = repository.state.units[0]!.sourceBlocks!;
    const heading = sourceBlocks[0]!;
    heading.kind = "heading";
    heading.text = "2. 实时调度算法";
    const body = sourceBlocks[1]!;
    body.kind = "paragraph";
    body.text = "实时调度会依据任务截止时间和优先级决定执行顺序，并保证硬实时任务按时完成。";
    const context = blueprintContextFor(repository.state.units[0]!);
    context.inventory.concepts[0]!.sourceBlockIndexes = [heading.blockIndex];
    context.slots = context.slots.map((slot) => ({ ...slot, sourceBlockIndexes: [heading.blockIndex] }));
    context.blueprint.slots = structuredClone(context.slots);
    repository.blueprintContext = context;
    const registry = new FakeProjectRegistryV2();
    const unit = await repository.claimWorkflowWorkUnit(projectId, 0, registry.workerAddress(0));
    await new WorkUnitWorkerAgent(
      repository,
      registry,
      new BlueprintWorkUnitModel(false, true),
      0,
    ).runClaimed(unit!);
    configureBlueprintQualityContext(repository);
    repository.state.chapters[0]!.status = "QUALITY_CHECK";
    const evaluatedEvidence: number[][] = [];
    const unavailableEvaluator: CardQualityEvaluatorV3 = {
      modelId: "unavailable-rubric-model",
      promptVersion: "unavailable-rubric-model-1",
      async evaluate(input) {
        evaluatedEvidence.push(input.evidenceBlocks.map((block) => block.blockIndex));
        throw new Error("AI evaluation request timed out");
      },
    };
    const orthogonalEmbeddings = {
      modelId: "orthogonal-test-embedding",
      async embed(texts: string[]) { return texts.map((_, index) => index === 0 ? [1, 0] : [0, 1]); },
    };

    await expect(new ChapterQualityGate(
      repository,
      orthogonalEmbeddings,
      unavailableEvaluator,
    ).runClaimed({ projectId, chapterId: 0 })).resolves.toBe("APPROVED");

    expect(evaluatedEvidence).toEqual([
      expect.arrayContaining([heading.blockIndex, body.blockIndex]),
      expect.arrayContaining([heading.blockIndex, body.blockIndex]),
    ]);
    expect(repository.lastBlueprintApproval?.evaluatorModel).toContain("deterministic-rubric-v1");
  });

  it("retries a transient model gateway failure inside the current Blueprint batch", async () => {
    vi.useFakeTimers();
    const repository = new InMemoryWorkflowRepositoryV2();
    repository.state.units = repository.state.units.filter((unit) => unit.chapterId !== 0 || unit.workUnitId === 0);
    repository.state.project.generationPolicyVersion = 3;
    repository.blueprintContext = blueprintContextFor(repository.state.units[0]!);
    const registry = new FakeProjectRegistryV2();
    const model = new TransientFailureModel(new BlueprintWorkUnitModel());
    const worker = new WorkUnitWorkerAgent(repository, registry, model, 0);

    const unit = await repository.claimWorkflowWorkUnit(projectId, 0, registry.workerAddress(0));
    const run = worker.runClaimed(unit!);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(run).resolves.toBeUndefined();
    expect(model.failures).toBe(1);
    expect(repository.state.units[0]?.status).toBe("CANDIDATE_READY");
  });

  it("repairs English cards before saving candidates for Chinese source material", async () => {
    const repository = new InMemoryWorkflowRepositoryV2();
    repository.state.units = repository.state.units.filter((unit) => unit.chapterId !== 0 || unit.workUnitId === 0);
    repository.state.project.generationPolicyVersion = 3;
    repository.blueprintContext = blueprintContextFor(repository.state.units[0]!);
    const registry = new FakeProjectRegistryV2();
    const model = new LanguageRepairBlueprintModel();
    const worker = new WorkUnitWorkerAgent(repository, registry, model, 0);

    const unit = await repository.claimWorkflowWorkUnit(projectId, 0, registry.workerAddress(0));
    await expect(worker.runClaimed(unit!)).resolves.toBeUndefined();

    expect(model.calls).toBe(4);
    expect(repository.state.units[0]?.workerCards.every((card) => /[\u3400-\u9fff]/u.test(card.question))).toBe(true);
  });

  it("deterministically fills missing V3 Slot candidates after model repair is exhausted", async () => {
    const repository = new InMemoryWorkflowRepositoryV2();
    repository.state.units = repository.state.units.filter((unit) => unit.chapterId !== 0 || unit.workUnitId === 0);
    repository.state.project.generationPolicyVersion = 3;
    repository.blueprintContext = blueprintContextFor(repository.state.units[0]!);
    const registry = new FakeProjectRegistryV2();
    const worker = new WorkUnitWorkerAgent(
      repository,
      registry,
      new BlueprintWorkUnitModel(true),
      0,
      { maxToolCalls: 6 },
    );

    const unit = await repository.claimWorkflowWorkUnit(projectId, 0, registry.workerAddress(0));
    await expect(worker.runClaimed(unit!)).resolves.toBeUndefined();

    expect(repository.state.units[0]?.status).toBe("CANDIDATE_READY");
    expect(repository.lastSavedWorkUnitResult?.cards).toHaveLength(2);
    expect(repository.lastSavedWorkUnitResult?.slotCandidates?.map((candidate) => candidate.slotId)).toEqual([
      hex("d"),
      hex("e"),
    ]);
  });

  it("approves V3 candidates only after Blueprint coverage and duplicate evaluation", async () => {
    const repository = new InMemoryWorkflowRepositoryV2();
    repository.state.units = repository.state.units.filter((unit) => unit.chapterId !== 0 || unit.workUnitId === 0);
    repository.state.project.generationPolicyVersion = 3;
    repository.state.chapters[0]!.minCardCount = 2;
    repository.blueprintContext = blueprintContextFor(repository.state.units[0]!);
    const registry = new FakeProjectRegistryV2();
    const unit = await repository.claimWorkflowWorkUnit(projectId, 0, registry.workerAddress(0));
    await new WorkUnitWorkerAgent(repository, registry, new BlueprintWorkUnitModel(), 0).runClaimed(unit!);
    configureBlueprintQualityContext(repository);
    repository.state.chapters[0]!.status = "QUALITY_CHECK";

    await expect(new ChapterQualityGate(repository).runClaimed({ projectId, chapterId: 0 }))
      .resolves.toBe("APPROVED");

    expect(repository.state.units[0]?.status).toBe("APPROVED");
    expect(repository.lastBlueprintApproval?.coverageResult).toMatchObject({
      passes: true,
      weightedCoverage: 1,
    });
    expect(repository.lastBlueprintApproval?.evaluations.every(
      (evaluation) => evaluation.verdict === "APPROVED",
    )).toBe(true);
  });

  it("fails clearly when a frozen V3 Blueprint exceeds its Chapter card capacity", async () => {
    const repository = new InMemoryWorkflowRepositoryV2();
    repository.state.units = repository.state.units.filter((unit) => unit.chapterId !== 0 || unit.workUnitId === 0);
    repository.state.project.generationPolicyVersion = 3;
    repository.state.chapters[0]!.minCardCount = 1;
    repository.state.chapters[0]!.maxCardCount = 1;
    repository.blueprintContext = blueprintContextFor(repository.state.units[0]!);
    const registry = new FakeProjectRegistryV2();
    const unit = await repository.claimWorkflowWorkUnit(projectId, 0, registry.workerAddress(0));
    await new WorkUnitWorkerAgent(repository, registry, new BlueprintWorkUnitModel(), 0).runClaimed(unit!);
    configureBlueprintQualityContext(repository);
    repository.state.chapters[0]!.status = "QUALITY_CHECK";

    await expect(new ChapterQualityGate(repository).runClaimed({ projectId, chapterId: 0 }))
      .rejects.toThrow(/Blueprint has 2 Slots.*maximum is 1/u);

    expect(repository.lastBlueprintRepairs).toBeNull();
    expect(repository.lastBlueprintApproval).toBeNull();
  });

  it("freezes an accepted V3 Slot across later repair rounds", async () => {
    const repository = new InMemoryWorkflowRepositoryV2();
    repository.state.units = repository.state.units.filter((unit) => unit.chapterId !== 0 || unit.workUnitId === 0);
    repository.state.project.generationPolicyVersion = 3;
    repository.state.chapters[0]!.minCardCount = 2;
    repository.blueprintContext = blueprintContextFor(repository.state.units[0]!);
    const registry = new FakeProjectRegistryV2();
    const unit = await repository.claimWorkflowWorkUnit(projectId, 0, registry.workerAddress(0));
    await new WorkUnitWorkerAgent(repository, registry, new BlueprintWorkUnitModel(), 0).runClaimed(unit!);
    configureBlueprintQualityContext(repository);
    const accepted = repository.blueprintQualityContext!.candidates[0]!;
    accepted.status = "ACCEPTED";
    accepted.acceptedEvaluation = {
      cardId: accepted.card.id,
      citationSufficient: true,
      factuality: 5,
      learningValue: 4,
      clarity: 4,
      completeness: 4,
      citationRelevance: 5,
      difficultyFit: 5,
      verdict: "ACCEPT",
      reasons: [],
    };
    repository.state.chapters[0]!.status = "QUALITY_CHECK";
    const evaluatedSlotIds: string[] = [];
    const evaluator: CardQualityEvaluatorV3 = {
      modelId: "unstable-evaluator",
      promptVersion: "unstable-evaluator-1",
      async evaluate(input) {
        evaluatedSlotIds.push(input.slot.slotId);
        if (input.slot.slotId === accepted.slotId) throw new Error("accepted Slot was re-evaluated");
        return {
          cardId: input.card.id,
          citationSufficient: true,
          factuality: 5,
          learningValue: 4,
          clarity: 4,
          completeness: 4,
          citationRelevance: 5,
          difficultyFit: 5,
          verdict: "ACCEPT",
          reasons: [],
        };
      },
    };
    const orthogonalEmbeddings = {
      modelId: "orthogonal-test-embedding",
      async embed(texts: string[]) { return texts.map((_, index) => index === 0 ? [1, 0] : [0, 1]); },
    };

    await expect(new ChapterQualityGate(
      repository,
      orthogonalEmbeddings,
      evaluator,
    ).runClaimed({ projectId, chapterId: 0 })).resolves.toBe("APPROVED");

    expect(evaluatedSlotIds).toEqual([hex("e")]);
    expect(repository.lastBlueprintApproval?.evaluations).toHaveLength(2);
    expect(repository.lastBlueprintApproval?.evaluations[0]).toMatchObject({
      slotId: accepted.slotId,
      verdict: "APPROVED",
      rubric: accepted.acceptedEvaluation,
    });
  });

  it("evaluates V3 card Rubrics sequentially for rate-limited gateways", async () => {
    const repository = new InMemoryWorkflowRepositoryV2();
    repository.state.units = repository.state.units.filter((unit) => unit.chapterId !== 0 || unit.workUnitId === 0);
    repository.state.project.generationPolicyVersion = 3;
    repository.state.chapters[0]!.minCardCount = 2;
    repository.blueprintContext = blueprintContextFor(repository.state.units[0]!);
    const registry = new FakeProjectRegistryV2();
    const unit = await repository.claimWorkflowWorkUnit(projectId, 0, registry.workerAddress(0));
    await new WorkUnitWorkerAgent(repository, registry, new BlueprintWorkUnitModel(), 0).runClaimed(unit!);
    configureBlueprintQualityContext(repository);
    repository.state.chapters[0]!.status = "QUALITY_CHECK";
    let activeEvaluations = 0;
    let maximumConcurrency = 0;
    const evaluator: CardQualityEvaluatorV3 = {
      modelId: "rate-limited-evaluator",
      promptVersion: "rate-limited-evaluator-1",
      async evaluate(input) {
        activeEvaluations += 1;
        maximumConcurrency = Math.max(maximumConcurrency, activeEvaluations);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeEvaluations -= 1;
        return {
          cardId: input.card.id,
          citationSufficient: true,
          factuality: 5,
          learningValue: 4,
          clarity: 4,
          completeness: 4,
          citationRelevance: 5,
          difficultyFit: 5,
          verdict: "ACCEPT",
          reasons: [],
        };
      },
    };
    const orthogonalEmbeddings = {
      modelId: "orthogonal-test-embedding",
      async embed(texts: string[]) { return texts.map((_, index) => index === 0 ? [1, 0] : [0, 1]); },
    };

    await expect(new ChapterQualityGate(
      repository,
      orthogonalEmbeddings,
      evaluator,
    ).runClaimed({ projectId, chapterId: 0 })).resolves.toBe("APPROVED");

    expect(maximumConcurrency).toBe(1);
  });

  it("requests repair only for the V3 Slot rejected as a semantic duplicate", async () => {
    const repository = new InMemoryWorkflowRepositoryV2();
    repository.state.units = repository.state.units.filter((unit) => unit.chapterId !== 0 || unit.workUnitId === 0);
    repository.state.project.generationPolicyVersion = 3;
    repository.state.chapters[0]!.minCardCount = 2;
    repository.blueprintContext = blueprintContextFor(repository.state.units[0]!);
    const registry = new FakeProjectRegistryV2();
    const unit = await repository.claimWorkflowWorkUnit(projectId, 0, registry.workerAddress(0));
    await new WorkUnitWorkerAgent(repository, registry, new BlueprintWorkUnitModel(), 0).runClaimed(unit!);
    configureBlueprintQualityContext(repository);
    repository.state.chapters[0]!.status = "QUALITY_CHECK";
    const identicalEmbeddings = {
      modelId: "deterministic-test-embedding",
      async embed(texts: string[]) { return texts.map(() => [1, 0]); },
    };

    await expect(new ChapterQualityGate(repository, identicalEmbeddings).runClaimed({ projectId, chapterId: 0 }))
      .resolves.toBe("REPAIR_REQUESTED");

    expect(repository.lastBlueprintRepairs?.repairs).toEqual([expect.objectContaining({
      slotId: hex("e"),
      reason: expect.stringContaining("distinct assessment target"),
    })]);
    expect(repository.state.units[0]?.status).toBe("REPAIRING");
    expect(repository.lastBlueprintApproval).toBeNull();
  });

  it("routes a citation-sufficiency Rubric failure to its exact V3 Slot", async () => {
    const repository = new InMemoryWorkflowRepositoryV2();
    repository.state.units = repository.state.units.filter((unit) => unit.chapterId !== 0 || unit.workUnitId === 0);
    repository.state.project.generationPolicyVersion = 3;
    repository.state.chapters[0]!.minCardCount = 2;
    repository.blueprintContext = blueprintContextFor(repository.state.units[0]!);
    const registry = new FakeProjectRegistryV2();
    const unit = await repository.claimWorkflowWorkUnit(projectId, 0, registry.workerAddress(0));
    await new WorkUnitWorkerAgent(repository, registry, new BlueprintWorkUnitModel(), 0).runClaimed(unit!);
    configureBlueprintQualityContext(repository);
    repository.state.chapters[0]!.status = "QUALITY_CHECK";
    const orthogonalEmbeddings = {
      modelId: "orthogonal-test-embedding",
      async embed(texts: string[]) { return texts.map((_, index) => index === 0 ? [1, 0] : [0, 1]); },
    };
    const rubricEvaluator: CardQualityEvaluatorV3 = {
      modelId: "rubric-test-model",
      promptVersion: "rubric-test-1",
      async evaluate(input) {
        const fails = input.slot.slotId === hex("e");
        return {
          cardId: input.card.id,
          citationSufficient: !fails,
          factuality: fails ? 2 : 4,
          learningValue: 4,
          clarity: 4,
          completeness: fails ? 2 : 4,
          citationRelevance: fails ? 1 : 4,
          difficultyFit: 5,
          verdict: fails ? "REPAIR" : "ACCEPT",
          reasons: fails ? ["引用没有支持应用场景中的结论。"] : [],
        };
      },
    };

    await expect(new ChapterQualityGate(
      repository,
      orthogonalEmbeddings,
      rubricEvaluator,
    ).runClaimed({ projectId, chapterId: 0 })).resolves.toBe("REPAIR_REQUESTED");

    expect(repository.lastBlueprintRepairs?.repairs.map((repair) => repair.slotId)).toEqual([hex("e")]);
    expect(repository.lastBlueprintRepairs?.evaluations[1]).toMatchObject({
      verdict: "REPAIR_REQUESTED",
      hardFailures: expect.arrayContaining([
        "CITATION_INSUFFICIENT",
        "FACTUALITY_BELOW_MINIMUM",
        "CITATION_RELEVANCE_BELOW_MINIMUM",
      ]),
      rubric: { reasons: ["引用没有支持应用场景中的结论。"] },
    });
    expect(repository.lastBlueprintRepairs?.repairs).toContainEqual({
      slotId: hex("e"),
      reason: "Replace the rejected card and fix: 引用没有支持应用场景中的结论。",
    });
  });

  it("gives a V3 repair Worker only its rejected card and Slot-specific instruction", async () => {
    const repository = new InMemoryWorkflowRepositoryV2();
    repository.state.units = repository.state.units.filter((unit) => unit.chapterId !== 0 || unit.workUnitId === 0);
    repository.state.project.generationPolicyVersion = 3;
    const context = blueprintContextFor(repository.state.units[0]!);
    const evidence = repository.state.units[0]!.sourceBlocks!.find((block) => block.text.length >= 20)!;
    context.repairInstructions = [{
      slotId: hex("e"),
      candidateRevision: 1,
      previousCard: {
        type: "qa",
        question: "旧问题是什么？",
        answer: "旧答案遗漏了必要条件。",
        keyPoint: "旧关键点",
        source: { page: evidence.pageNumber, quote: evidence.text },
        tags: ["旧标签"],
        importance: 4,
        initialDifficulty: 4,
      },
      failureCodes: ["COMPLETENESS_BELOW_MINIMUM"],
      instruction: "Replace the rejected card and include the missing precondition.",
    }];
    repository.blueprintContext = context;
    const registry = new FakeProjectRegistryV2();
    const unit = await repository.claimWorkflowWorkUnit(projectId, 0, registry.workerAddress(0));
    const model = new BlueprintWorkUnitModel();

    await new WorkUnitWorkerAgent(repository, registry, model, 0).runClaimed(unit!);

    expect(model.repairInstructions).toEqual([{
      blueprintSlotId: hex("e"),
      rejectedCandidateRevision: 1,
      failureCodes: ["COMPLETENESS_BELOW_MINIMUM"],
      instruction: "Replace the rejected card and include the missing precondition.",
      rejectedCard: context.repairInstructions[0]!.previousCard,
    }]);
  });

  it("allows a normal AI generation call to run longer than 45 seconds", async () => {
    vi.useFakeTimers();
    const repository = new InMemoryWorkflowRepositoryV2();
    const registry = new FakeProjectRegistryV2();
    const worker = new WorkUnitWorkerAgent(repository, registry, new WaitingWorkUnitModel(), 0);
    const unit = await repository.claimWorkflowWorkUnit(projectId, 0, registry.workerAddress(0));
    expect(unit).not.toBeNull();

    let settled = false;
    const run = worker.runClaimed(unit!).then(
      () => { settled = true; return null; },
      (error: unknown) => { settled = true; return error; },
    );
    await vi.advanceTimersByTimeAsync(45_001);

    expect(settled).toBe(false);
    expect(repository.state.units[0]?.status).toBe("GENERATING");

    await vi.advanceTimersByTimeAsync(75_000);
    await expect(run).resolves.toBeInstanceOf(Error);
    expect(repository.state.units[0]?.status).toBe("RETRYABLE");
  });

  it("hard-stops a model endpoint that ignores AbortSignal", async () => {
    vi.useFakeTimers();
    const repository = new InMemoryWorkflowRepositoryV2();
    const registry = new FakeProjectRegistryV2();
    const worker = new WorkUnitWorkerAgent(repository, registry, new NonAbortableWorkUnitModel(), 0);
    const unit = await repository.claimWorkflowWorkUnit(projectId, 0, registry.workerAddress(0));
    const run = worker.runClaimed(unit!).then(
      () => null,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(120_001);

    await expect(run).resolves.toEqual(expect.objectContaining({ message: expect.stringMatching(/timed out|aborted/u) }));
    expect(repository.state.units[0]?.status).toBe("RETRYABLE");
  });

  it("does not commit candidates that fail Chapter-level cross-Work-Unit deduplication", async () => {
    const repository = new InMemoryWorkflowRepositoryV2();
    const registry = new FakeProjectRegistryV2();
    const workerAgents = [0, 1, 2].map((index) =>
      new WorkUnitWorkerAgent(repository, registry, new AdaptiveWorkUnitModel(undefined, true), index),
    ) as [WorkUnitWorkerAgent, WorkUnitWorkerAgent, WorkUnitWorkerAgent];
    const assembler = new ChapterAssembler(repository, registry);
    const finalizer = new ProjectFinalizerV2(repository, registry);
    const settlement = new WorkUnitSettlementAgentV2(repository, registry, {} as never);
    const dispatcher = new ProjectWorkflowDispatcherV2(
        repository,
        registry,
        workerAgents,
        new RegistryReconcilerV2(repository, registry, sponsorGateway, 1n),
        new ChapterQualityGate(repository),
        assembler,
        finalizer,
        settlement,
        undefined,
        undefined,
        new OutlinePlanningAgent(repository, new AdaptiveWorkUnitModel()),
      );
    const coordinator = new ProjectCoordinatorV2(
      registry,
      dispatcher,
      { maxWorkflowJobsPerRun: 6 },
    );

    const result = await coordinator.runOnce();

    expect(result.errors).toEqual([]);
    expect(registry.workUnits.size).toBe(0);
    expect(repository.state.project.status).toBe("GENERATING");
  });

  it("dispatches the complete Project pipeline from exact Workflow Jobs", async () => {
    const repository = new InMemoryWorkflowRepositoryV2();
    const registry = new FakeProjectRegistryV2();
    const workerAgents = [0, 1, 2].map((index) =>
      new WorkUnitWorkerAgent(repository, registry, new AdaptiveWorkUnitModel(), index),
    ) as [WorkUnitWorkerAgent, WorkUnitWorkerAgent, WorkUnitWorkerAgent];
    const assembler = new ChapterAssembler(repository, registry);
    const finalizer = new ProjectFinalizerV2(repository, registry, () => new Date("2026-07-26T00:00:00.000Z"));
    const settlement = new WorkUnitSettlementAgentV2(
      repository,
      registry,
      {} as never,
    );
    const dispatcher = new ProjectWorkflowDispatcherV2(
      repository,
      registry,
      workerAgents,
      new RegistryReconcilerV2(repository, registry, sponsorGateway, 1n),
      new ChapterQualityGate(repository),
      assembler,
      finalizer,
      settlement,
    );
    dispatcher.setOutlinePlanner(new OutlinePlanningAgent(repository, new AdaptiveWorkUnitModel()));
    const coordinator = new ProjectCoordinatorV2(registry, dispatcher);

    const result = await coordinator.runOnce();

    expect(result.errors).toEqual([]);
    expect(result.processedWorkflowJobs).toBeGreaterThanOrEqual(13);
    expect(repository.state.project.status).toBe("READY");
    expect(repository.workflowJobs().every((job) => job.status === "SUCCEEDED")).toBe(true);
    expect(new Set(repository.claims.map((claim) => claim.worker)).size).toBe(3);
    expect(repository.state.chapters.map((chapter) => chapter.status)).toEqual(["READY", "READY"]);
    expect(repository.state.project.totalCardCount).toBe(8);
    expect(hashInitialPlan(repository.state.project.initialPlan!)).toBe(repository.state.project.initialPlanHash);
    expect(repository.events.filter((event) => event === "WORK_UNIT_CONFIRMED")).toHaveLength(4);
    expect(repository.events.filter((event) => event === "CHAPTER_READY")).toHaveLength(2);
    expect(repository.events).toContain("PROJECT_READY");
  });
});
