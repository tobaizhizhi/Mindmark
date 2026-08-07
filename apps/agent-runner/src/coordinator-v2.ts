import type { ProjectRegistryGatewayV2 } from "./types-v2.js";
import type { WorkflowJobKindV2 } from "./types-v2.js";

type CoordinatorOptions = {
  pollIntervalMs?: number;
  maxWorkflowJobsPerRun?: number;
  startupRetryDelayMs?: number;
};

export type ProjectRunnerTick = {
  recoveredWorkflowJobs: number;
  plannedOutlines: number;
  processedWorkflowJobs: number;
  errors: unknown[];
};

/** The only seam the coordinator needs for the recover-and-dispatch loop. */
export interface WorkflowQueueRunnerV2 {
  recoverStaleJobs(): Promise<number>;
  runNextDetailed(): Promise<WorkflowJobKindV2 | null>;
}

export class ProjectCoordinatorV2 {
  private pollTimer: NodeJS.Timeout | null = null;
  private tickInProgress = false;
  private readonly workflowDispatcher: WorkflowQueueRunnerV2;
  private readonly options: CoordinatorOptions;

  constructor(
    private readonly registry: Pick<ProjectRegistryGatewayV2, "assertConfiguredWallets">,
    workflowDispatcher: WorkflowQueueRunnerV2,
    options?: CoordinatorOptions,
  ) {
    this.workflowDispatcher = workflowDispatcher;
    this.options = options ?? {};
  }

  async start(): Promise<void> {
    await this.assertConfiguredWallets();
    await this.runOnce();
    this.pollTimer = setInterval(() => void this.scheduleTick(), this.options.pollIntervalMs ?? 20_000);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async runOnce(): Promise<ProjectRunnerTick> {
    const tick: ProjectRunnerTick = {
      recoveredWorkflowJobs: 0,
      plannedOutlines: 0,
      processedWorkflowJobs: 0,
      errors: [],
    };
    try {
      tick.recoveredWorkflowJobs = await this.workflowDispatcher.recoverStaleJobs();
    } catch (error) {
      tick.errors.push(error);
    }
    // All Workflow Jobs, including PLAN_OUTLINE, use the same claim/complete/retry path.
    for (let index = 0; index < (this.options.maxWorkflowJobsPerRun ?? 64); index += 1) {
      try {
        const kind: WorkflowJobKindV2 | null = await this.workflowDispatcher.runNextDetailed();
        if (!kind) break;
        if (kind === "PLAN_OUTLINE") tick.plannedOutlines += 1;
        tick.processedWorkflowJobs += 1;
      } catch (error) {
        tick.errors.push(error);
        break;
      }
    }
    return tick;
  }

  private async scheduleTick(): Promise<void> {
    if (this.tickInProgress) return;
    this.tickInProgress = true;
    try {
      await this.runOnce();
    } finally {
      this.tickInProgress = false;
    }
  }

  private async assertConfiguredWallets(): Promise<void> {
    const retryDelayMs = this.options.startupRetryDelayMs ?? 2_000;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.registry.assertConfiguredWallets();
        return;
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** attempt));
      }
    }
  }
}
