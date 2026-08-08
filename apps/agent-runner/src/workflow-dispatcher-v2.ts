import { getAddress } from "viem";
import type { ChapterAssembler } from "./chapter-assembler.js";
import type { ChapterDesignWorkflowAgent } from "./chapter-design-agent.js";
import type { ChapterQualityGate } from "./chapter-quality-gate.js";
import type { ProjectFinalizerV2 } from "./project-finalizer-v2.js";
import type { ProjectDesignFreezer } from "./project-design-freezer.js";
import type { RegistryReconcilerV2 } from "./registry-reconciler-v2.js";
import type { WorkUnitSettlementAgentV2 } from "./reward-v2.js";
import type {
  ProjectRegistryGatewayV2,
  WorkflowDispatchRepositoryV2,
  WorkflowJobKindV2,
} from "./types-v2.js";
import type { WorkUnitWorkerAgent } from "./worker-v2.js";
import type { OutlinePlanningAgent } from "./outline-planning-agent.js";

const dispatchKinds = [
  "PLAN_OUTLINE",
  "DESIGN_CHAPTER",
  "FREEZE_PROJECT_DESIGN",
  "RECONCILE_PROJECT",
  "GENERATE_WORK_UNIT",
  "QUALITY_CHECK_CHAPTER",
  "ASSEMBLE_CHAPTER",
  "FINALIZE_PROJECT",
  "SETTLE_WORK_UNIT_REWARD",
] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Workflow handler failed";
}

export class ProjectWorkflowDispatcherV2 {
  private outlinePlanner?: OutlinePlanningAgent;

  constructor(
    private readonly repository: WorkflowDispatchRepositoryV2,
    private readonly registry: ProjectRegistryGatewayV2,
    private readonly workers: readonly [WorkUnitWorkerAgent, WorkUnitWorkerAgent, WorkUnitWorkerAgent],
    private readonly reconciler: RegistryReconcilerV2,
    private readonly qualityGate: ChapterQualityGate,
    private readonly assembler: ChapterAssembler,
    private readonly finalizer: ProjectFinalizerV2,
    private readonly settlement: WorkUnitSettlementAgentV2,
    private readonly chapterDesign?: ChapterDesignWorkflowAgent,
    private readonly designFreezer?: ProjectDesignFreezer,
    outlinePlanner?: OutlinePlanningAgent,
  ) {
    this.outlinePlanner = outlinePlanner;
  }

  setOutlinePlanner(outlinePlanner: OutlinePlanningAgent): void {
    this.outlinePlanner = outlinePlanner;
  }

  async recoverStaleJobs(): Promise<number> {
    return this.repository.recoverStaleWorkflowJobs();
  }

  async runNext(): Promise<boolean> {
    return (await this.runNextDetailed()) !== null;
  }

  async runNextDetailed(
    kinds: readonly WorkflowJobKindV2[] = dispatchKinds,
  ): Promise<WorkflowJobKindV2 | null> {
    const job = await this.repository.claimNextWorkflowJob([...kinds]);
    if (!job) return null;
    await this.processClaimedJob(job);
    return job.kind;
  }

  async runNextGenerationForWorker(workerIndex: number): Promise<WorkflowJobKindV2 | null> {
    const job = await this.repository.claimNextGenerationWorkflowJob(workerIndex);
    if (!job) return null;
    await this.processClaimedJob(job);
    return job.kind;
  }

  private async processClaimedJob(job: Awaited<ReturnType<WorkflowDispatchRepositoryV2["claimNextWorkflowJob"]>> extends infer T ? Exclude<T, null> : never): Promise<void> {
    try {
      const output = await this.dispatch(job);
      await this.repository.completeWorkflowJob(job.jobId, output);
    } catch (error) {
      await this.repository.retryWorkflowJob(job.jobId, errorMessage(error));
    }
  }

  private async dispatch(job: Awaited<ReturnType<WorkflowDispatchRepositoryV2["claimNextWorkflowJob"]>> extends infer T ? Exclude<T, null> : never) {
    switch (job.kind) {
      case "DESIGN_CHAPTER": {
        if (job.chapterId === null) throw new Error("DESIGN_CHAPTER requires a Chapter");
        if (!this.chapterDesign) throw new Error("Chapter Design handler is not configured");
        return this.chapterDesign.runClaimed({ projectId: job.projectId, chapterId: job.chapterId });
      }
      case "FREEZE_PROJECT_DESIGN": {
        if (!this.designFreezer) throw new Error("Project Design freezer is not configured");
        return this.designFreezer.runClaimed(job.projectId);
      }
      case "RECONCILE_PROJECT": {
        const state = await this.reconciler.reconcileProject(job.projectId);
        if (state === "PENDING") throw new Error("Monad Project creation is not visible yet");
        return { state };
      }
      case "GENERATE_WORK_UNIT": {
        if (job.workUnitId === null) throw new Error("GENERATE_WORK_UNIT requires a Work Unit");
        const worker = await this.workerFor(job.projectId, job.workUnitId);
        const unit = await this.repository.claimWorkflowWorkUnit(
          job.projectId,
          job.workUnitId,
          this.registry.workerAddress(worker.index),
        );
        if (!unit) return { state: "OBSOLETE" };
        await worker.agent.runClaimed(unit);
        return { state: "PROCESSED", workerIndex: worker.index };
      }
      case "QUALITY_CHECK_CHAPTER": {
        if (job.chapterId === null) throw new Error("QUALITY_CHECK_CHAPTER requires a Chapter");
        if (!(await this.repository.claimWorkflowChapterQualityCheck(job.projectId, job.chapterId))) {
          return { state: "OBSOLETE" };
        }
        return { state: await this.qualityGate.runClaimed({ projectId: job.projectId, chapterId: job.chapterId }) };
      }
      case "ASSEMBLE_CHAPTER": {
        if (job.chapterId === null) throw new Error("ASSEMBLE_CHAPTER requires a Chapter");
        if (!(await this.repository.claimWorkflowChapterAssembly(job.projectId, job.chapterId))) {
          return { state: "OBSOLETE" };
        }
        await this.assembler.runClaimed({ projectId: job.projectId, chapterId: job.chapterId });
        return { state: "ASSEMBLED" };
      }
      case "FINALIZE_PROJECT": {
        if (!(await this.repository.claimWorkflowProjectFinalization(job.projectId))) {
          return { state: "OBSOLETE" };
        }
        await this.finalizer.runClaimed(job.projectId);
        return { state: "FINALIZED" };
      }
      case "SETTLE_WORK_UNIT_REWARD": {
        if (job.workUnitId === null) throw new Error("SETTLE_WORK_UNIT_REWARD requires a Work Unit");
        const reward = await this.repository.claimWorkflowWorkUnitReward(job.projectId, job.workUnitId);
        if (!reward) return { state: "OBSOLETE" };
        const state = await this.settlement.runClaimed(reward);
        if (state === "RETRYABLE") throw new Error("Work Unit reward settlement is retryable");
        return { state };
      }
      case "PLAN_OUTLINE":
        if (!this.outlinePlanner) throw new Error("Outline planning handler is not configured");
        return this.outlinePlanner.runClaimed(job);
    }
  }

  private async workerFor(projectId: `0x${string}`, workUnitId: number) {
    const unit = await this.repository.getWorkUnit(projectId, workUnitId);
    const assignedIndex = unit.workerAddress
      ? this.workers.findIndex((_, index) =>
          getAddress(this.registry.workerAddress(index)) === getAddress(unit.workerAddress!),
        )
      : -1;
    const index = assignedIndex >= 0 ? assignedIndex : workUnitId % this.workers.length;
    return { index, agent: this.workers[index]! };
  }
}
