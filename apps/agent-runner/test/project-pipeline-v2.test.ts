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
import type { AgentToolCall, ToolCallingModel } from "../src/runtime-types.js";
import type {
  ChapterAssemblyV2,
  ChainChapterStateV2,
  ChainProjectStateV2,
  ChainWorkUnitCommitmentV2,
  ProjectBundleV2,
  ProjectRegistryGatewayV2,
  ProjectRunnerRepositoryV2,
  RunnerChapterV2,
  RunnerProjectV2,
  RunnerWorkUnitV2,
  SavedWorkUnitResultV2,
  WorkflowDispatchRepositoryV2,
  WorkflowJobV2,
  WorkUnitRewardV2,
} from "../src/types-v2.js";
import { WorkUnitWorkerAgent } from "../src/worker-v2.js";
import { address, hex } from "./fakes.js";

const projectId = hex("9");
const workers = [address("2"), address("3"), address("4")] as const;

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

class InMemoryProjectRepositoryV2 implements ProjectRunnerRepositoryV2 {
  state = fixtureState();
  claims: Array<{ workUnitId: number; worker: string }> = [];
  events: string[] = [];
  pendingRegistry = false;

  async listPendingRegistryProjects() {
    if (!this.pendingRegistry) return [];
    return [{
      projectId,
      ownerAddress: this.state.project.ownerAddress,
      sourceHash: this.state.project.sourceHash,
      goalHash: this.state.project.goalHash,
      outlineHash: this.state.project.outlineHash,
      workUnitManifestRoot: this.state.project.workUnitManifestRoot,
      chapterCount: this.state.chapters.length,
      workUnitCount: this.state.units.length,
    }];
  }
  async markProjectRegistryReconciled() {
    this.pendingRegistry = false;
    this.state.project.status = "GENERATING";
  }
  async getWorkUnit(_id: Hex, workUnitId: number) { return structuredClone(this.state.units[workUnitId]!); }
  async markWorkUnitValidating(_id: Hex, workUnitId: number) { this.state.units[workUnitId]!.status = "VALIDATING"; }
  async saveWorkUnitResult(_id: Hex, workUnitId: number, result: SavedWorkUnitResultV2) {
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
    workUnits: Parameters<ProjectRunnerRepositoryV2["approveChapterCandidates"]>[2],
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
  async saveProjectFinalization(input: Parameters<ProjectRunnerRepositoryV2["saveProjectFinalization"]>[0]) {
    Object.assign(this.state.project, {
      projectDeckRoot: input.projectDeckRoot,
      initialPlan: input.initialPlan,
      initialPlanHash: input.initialPlanHash,
      totalCardCount: input.totalCardCount,
    });
  }
  async markProjectReady(input: Parameters<ProjectRunnerRepositoryV2["markProjectReady"]>[0]) {
    Object.assign(this.state.project, {
      status: "READY", projectDeckRoot: input.projectDeckRoot,
      initialPlan: input.initialPlan, initialPlanHash: input.initialPlanHash,
      totalCardCount: input.totalCardCount,
    });
  }
  async markProjectRetryable() { this.state.project.status = "FAILED_RETRYABLE"; }
  async recordProjectAgentEvent(event: Parameters<ProjectRunnerRepositoryV2["recordProjectAgentEvent"]>[0]) {
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
    workUnits: Parameters<ProjectRunnerRepositoryV2["approveChapterCandidates"]>[2],
  ) {
    await super.approveChapterCandidates(id, chapterId, workUnits);
    for (const unit of this.state.units.filter((candidate) => candidate.chapterId === chapterId)) {
      this.enqueue("GENERATE_WORK_UNIT", chapterId, unit.workUnitId);
    }
  }

  override async markWorkUnitConfirmed(
    id: Hex,
    workUnitId: number,
    confirmation: Parameters<ProjectRunnerRepositoryV2["markWorkUnitConfirmed"]>[2],
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

describe("Chapter-first V2 Runner pipeline", () => {
  it("recovers a Project when the wallet callback was lost after Registry creation", async () => {
    const repository = new InMemoryProjectRepositoryV2();
    repository.state.project.status = "AWAITING_REGISTRY";
    repository.pendingRegistry = true;
    const registry = new FakeProjectRegistryV2();

    await expect(new RegistryReconcilerV2(repository, registry).reconcileProject(projectId)).resolves.toBe("RECONCILED");
    expect(repository.state.project.status).toBe("GENERATING");
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

  it("does not commit candidates that fail Chapter-level cross-Work-Unit deduplication", async () => {
    const repository = new InMemoryWorkflowRepositoryV2();
    const registry = new FakeProjectRegistryV2();
    const workerAgents = [0, 1, 2].map((index) =>
      new WorkUnitWorkerAgent(repository, registry, new AdaptiveWorkUnitModel(undefined, true), index),
    ) as [WorkUnitWorkerAgent, WorkUnitWorkerAgent, WorkUnitWorkerAgent];
    const assembler = new ChapterAssembler(repository, registry);
    const finalizer = new ProjectFinalizerV2(repository, registry);
    const settlement = new WorkUnitSettlementAgentV2(repository, registry, {} as never);
    const coordinator = new ProjectCoordinatorV2(
      registry,
      new OutlinePlanningAgent(repository, new AdaptiveWorkUnitModel()),
      new ProjectWorkflowDispatcherV2(
        repository,
        registry,
        workerAgents,
        new RegistryReconcilerV2(repository, registry),
        new ChapterQualityGate(repository),
        assembler,
        finalizer,
        settlement,
      ),
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
      new RegistryReconcilerV2(repository, registry),
      new ChapterQualityGate(repository),
      assembler,
      finalizer,
      settlement,
    );
    const coordinator = new ProjectCoordinatorV2(
      registry,
      new OutlinePlanningAgent(repository, new AdaptiveWorkUnitModel()),
      dispatcher,
    );

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
