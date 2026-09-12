import { quoteWorkUnitRewards } from "@mindmark/shared";
import { getAddress } from "viem";
import type { ProjectSponsorGateway } from "./runtime-types.js";
import type {
  ProjectRegistryGatewayV2,
  RegistryProjectIntentV2,
  RegistryReconciliationRepositoryV2,
} from "./types-v2.js";

export class RegistryReconcilerV2 {
  constructor(
    private readonly repository: RegistryReconciliationRepositoryV2,
    private readonly registry: ProjectRegistryGatewayV2,
    private readonly sponsor: ProjectSponsorGateway,
    private readonly baseRewardWei: bigint,
  ) {}

  async reconcileProject(projectId: `0x${string}`): Promise<"RECONCILED" | "PENDING" | "OBSOLETE"> {
    const intent = await this.repository.getPendingRegistryProject(projectId);
    if (!intent) return "OBSOLETE";
    return (await this.reconcileIntent(intent)) ? "RECONCILED" : "PENDING";
  }

  private async reconcileIntent(intent: RegistryProjectIntentV2): Promise<boolean> {
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
    const quotes = quoteWorkUnitRewards(intent.pricingInputs, this.baseRewardWei);
    const funding = await this.sponsor.ensureProjectFunded({
      projectId: intent.projectId,
      quotes,
      legacyRewardPerWorkUnitWei: this.baseRewardWei,
    });
    await this.repository.markProjectRegistryReconciled(intent.projectId, funding);
    return true;
  }
}
