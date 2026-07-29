import type { OutlinePlanningAgent } from "./outline-planning-agent.js";
import type { ProjectRegistryGatewayV2 } from "./types-v2.js";
import type { ProjectWorkflowDispatcherV2 } from "./workflow-dispatcher-v2.js";

export type ProjectRunnerTick = {
  recoveredWorkflowJobs: number;
  plannedOutlines: number;
  processedWorkflowJobs: number;
  errors: unknown[];
};

export class ProjectCoordinatorV2 {
  private pollTimer: NodeJS.Timeout | null = null;
  private tickInProgress = false;

  constructor(
    private readonly registry: Pick<ProjectRegistryGatewayV2, "assertConfiguredWallets">,
    private readonly outlinePlanner: OutlinePlanningAgent,
    private readonly workflowDispatcher: ProjectWorkflowDispatcherV2,
    private readonly options: {
      pollIntervalMs?: number;
      maxOutlinePlansPerRun?: number;
      maxWorkflowJobsPerRun?: number;
    } = {},
  ) {}

  async start(): Promise<void> {
    await this.registry.assertConfiguredWallets();
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
    for (let index = 0; index < (this.options.maxOutlinePlansPerRun ?? 4); index += 1) {
      try {
        if (!(await this.outlinePlanner.runNext())) break;
        tick.plannedOutlines += 1;
      } catch (error) {
        tick.errors.push(error);
        break;
      }
    }
    for (let index = 0; index < (this.options.maxWorkflowJobsPerRun ?? 64); index += 1) {
      try {
        if (!(await this.workflowDispatcher.runNext())) break;
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
}
