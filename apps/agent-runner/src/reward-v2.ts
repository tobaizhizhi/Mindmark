import { getAddress } from "viem";
import { WorkerRewardVerificationError } from "./reward.js";
import type { PreparedWorkerReward, WorkerRewardGateway } from "./runtime-types.js";
import type {
  ProjectRegistryGatewayV2,
  WorkUnitRewardRepositoryV2,
  WorkUnitRewardV2,
} from "./types-v2.js";

const sameAddress = (left: string, right: string) => getAddress(left) === getAddress(right);

function preparedFromReward(reward: WorkUnitRewardV2): PreparedWorkerReward {
  if (!reward.mossPlanHash || !reward.signedTransaction || reward.treasuryNonce === null || !reward.txHash) {
    throw new WorkerRewardVerificationError("Prepared Work Unit reward is missing transaction data");
  }
  return {
    treasuryAddress: reward.treasuryAddress,
    recipientAddress: reward.recipientAddress,
    amountWei: reward.amountWei,
    mossPlanHash: reward.mossPlanHash,
    simulationWarningCodes: reward.simulationWarningCodes,
    simulationGas: reward.simulationGas,
    signedTransaction: reward.signedTransaction,
    treasuryNonce: reward.treasuryNonce,
    txHash: reward.txHash,
  };
}

export class WorkUnitSettlementAgentV2 {
  constructor(
    private readonly repository: WorkUnitRewardRepositoryV2,
    private readonly registry: ProjectRegistryGatewayV2,
    private readonly rewardGateway: WorkerRewardGateway,
  ) {}

  async runClaimed(reward: WorkUnitRewardV2): Promise<"SETTLED" | "BLOCKED" | "RETRYABLE"> {
    try {
      let prepared: PreparedWorkerReward;
      if (reward.status === "PREPARED" || reward.status === "SUBMITTING") {
        prepared = preparedFromReward(reward);
      } else {
        const commitment = await this.registry.readWorkUnit(reward.projectId, reward.workUnitId);
        if (!commitment || !sameAddress(commitment.worker, reward.recipientAddress)) {
          throw new WorkerRewardVerificationError(
            "Work Unit reward recipient does not match the confirmed Monad commitment",
          );
        }
        if (!sameAddress(reward.treasuryAddress, this.rewardGateway.treasuryAddress())) {
          throw new WorkerRewardVerificationError("Work Unit reward targets another Treasury");
        }
        prepared = await this.rewardGateway.prepare(
          { recipientAddress: reward.recipientAddress, amountWei: reward.amountWei },
          (stage) => this.repository.markWorkUnitRewardStage(
            reward.projectId,
            reward.workUnitId,
            stage,
          ),
        );
        await this.repository.markWorkUnitRewardPrepared(reward.projectId, reward.workUnitId, prepared);
      }
      const receipt = await this.rewardGateway.settlePrepared(prepared, (txHash) =>
        this.repository.markWorkUnitRewardSubmitting(reward.projectId, reward.workUnitId, txHash),
      );
      await this.repository.markWorkUnitRewardConfirmed(reward.projectId, reward.workUnitId, receipt);
      return "SETTLED";
    } catch (error) {
      if (error instanceof WorkerRewardVerificationError) {
        await this.repository.markWorkUnitRewardBlocked(
          reward.projectId,
          reward.workUnitId,
          error.message,
          error.warningCodes,
        );
        return "BLOCKED";
      }
      await this.repository.markWorkUnitRewardRetryable(
        reward.projectId,
        reward.workUnitId,
        error instanceof Error ? error.message : "Unknown Work Unit reward failure",
      );
      return "RETRYABLE";
    }
  }
}
