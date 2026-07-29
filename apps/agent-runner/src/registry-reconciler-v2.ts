import { getAddress } from "viem";
import type { ProjectRegistryGatewayV2, ProjectRunnerRepositoryV2 } from "./types-v2.js";

export class RegistryReconcilerV2 {
  constructor(
    private readonly repository: ProjectRunnerRepositoryV2,
    private readonly registry: ProjectRegistryGatewayV2,
  ) {}

  async reconcileProject(projectId: `0x${string}`): Promise<"RECONCILED" | "PENDING" | "OBSOLETE"> {
    const intent = (await this.repository.listPendingRegistryProjects(64))
      .find((candidate) => candidate.projectId === projectId);
    if (!intent) return "OBSOLETE";
    return (await this.reconcileIntent(intent)) ? "RECONCILED" : "PENDING";
  }

  private async reconcileIntent(intent: Awaited<ReturnType<ProjectRunnerRepositoryV2["listPendingRegistryProjects"]>>[number]): Promise<boolean> {
    const chain = await this.registry.readProject(intent.projectId);
    if (!chain) return false;
    if (
      chain.status !== "CREATED" ||
      getAddress(chain.learner) !== getAddress(intent.ownerAddress) ||
      chain.sourceHash !== intent.sourceHash ||
      chain.goalHash !== intent.goalHash ||
      chain.outlineHash !== intent.outlineHash ||
      chain.workUnitManifestRoot !== intent.workUnitManifestRoot ||
      chain.chapterCount !== intent.chapterCount ||
      chain.workUnitCount !== intent.workUnitCount
    ) {
      throw new Error(`Monad Project ${intent.projectId} does not match its persisted creation intent`);
    }
    await this.repository.markProjectRegistryReconciled(intent.projectId);
    return true;
  }
}
