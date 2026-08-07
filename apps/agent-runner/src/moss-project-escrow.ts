import {
  Capability,
  Event,
  Protocol,
  createHandle,
  defineProtocolPackage,
  plan,
  uint,
  type DecodedEvent,
  type MossRuntime,
  type Plan,
  type SemanticType,
} from "@themoss/core";
import type { SimulateOutcome } from "@themoss/simulator";
import { learningProjectEscrowAbi } from "@mindmark/shared";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { WorkerRewardVerificationError } from "./reward-error.js";

const bytes32: SemanticType<Hex> = {
  describe: "A 32-byte 0x-prefixed Project identifier",
  decode(value) {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(value)) {
      throw new Error("Expected a 32-byte Project identifier");
    }
    return value as Hex;
  },
};

function sameAddress(left: string, right: string): boolean {
  return getAddress(left) === getAddress(right);
}

export function createMindmarkEscrowManifest(escrowAddress: Address) {
  class MindmarkEscrowProtocol {
    declare readonly runtime: MossRuntime;

    releaseWorkUnitReward(input: { projectId: Hex; workUnitId: bigint }) {
      const escrow = createHandle(learningProjectEscrowAbi, escrowAddress, this.runtime.client);
      return plan([escrow.releaseReward([input.projectId, Number(input.workUnitId)])]);
    }

    rewardReleased(events: DecodedEvent[]) {
      const event = events[0];
      if (!event) return null;
      return {
        projectId: String(event.args.projectId),
        workUnitId: Number(event.args.workUnitId),
        worker: String(event.args.worker),
        amount: BigInt(event.args.amount as bigint).toString(),
      };
    }
  }

  Capability({
    intent: "Release the quality-approved reward for Mindmark Project {projectId} Work Unit {workUnitId}",
    verb: "transfer",
    params: { projectId: bytes32, workUnitId: uint },
    risk: ["fundOut"],
    tags: ["mindmark", "quality-gated", "escrow", "worker-reward"],
    confirms: ["rewardReleased"],
  })(
    MindmarkEscrowProtocol.prototype.releaseWorkUnitReward,
    { kind: "method", static: false } as ClassMethodDecoratorContext,
  );
  Event<MindmarkEscrowProtocol, "Released {amount} wei to Worker {worker}">({
    events: { escrow: ["RewardReleased"] },
    intent: "Released {amount} wei to Worker {worker}",
  })(
    MindmarkEscrowProtocol.prototype.rewardReleased,
    { kind: "method", static: false } as ClassMethodDecoratorContext,
  );
  const RegisteredProtocol = Protocol({
    name: "mindmark-escrow",
    category: "rewards",
    description: "Release the frozen Sponsor-funded quote only for a committed Mindmark Work Unit.",
    contracts: {
      escrow: { abi: learningProjectEscrowAbi, addr: escrowAddress },
    },
  })(
    MindmarkEscrowProtocol,
    { kind: "class" } as ClassDecoratorContext<typeof MindmarkEscrowProtocol>,
  );
  return defineProtocolPackage({
    name: "mindmark-escrow",
    protocols: [RegisteredProtocol],
  });
}

export function verifyMossEscrowReleasePlan(
  candidate: Plan,
  expected: {
    chainId: number;
    sponsor: Address;
    escrowAddress: Address;
    projectId: Hex;
    workUnitId: number;
  },
): void {
  const expectedData = encodeFunctionData({
    abi: learningProjectEscrowAbi,
    functionName: "releaseReward",
    args: [expected.projectId, expected.workUnitId],
  });
  const transaction = candidate.txs[0];
  if (
    candidate.protocol !== "mindmark-escrow"
    || candidate.method !== "releaseWorkUnitReward"
    || candidate.verb !== "transfer"
    || candidate.chainId !== expected.chainId
    || !sameAddress(candidate.account, expected.sponsor)
    || candidate.declaredRisk.length !== 1
    || candidate.declaredRisk[0] !== "fundOut"
    || candidate.confirms.length !== 1
    || candidate.confirms[0] !== "rewardReleased"
    || candidate.txs.length !== 1
    || !transaction
    || !sameAddress(transaction.from, expected.sponsor)
    || !sameAddress(transaction.to, expected.escrowAddress)
    || transaction.data !== expectedData
    || BigInt(transaction.value) !== 0n
    || (candidate.expects.out?.length ?? 0) !== 0
    || (candidate.expects.in?.length ?? 0) !== 0
    || (candidate.expects.approvals?.length ?? 0) !== 0
    || (candidate.expects.nfts?.length ?? 0) !== 0
  ) {
    throw new WorkerRewardVerificationError("Moss Escrow Plan does not match the Work Unit reward intent");
  }
}

export function verifyMossEscrowReleaseSimulation(
  plan: Plan,
  outcome: SimulateOutcome,
  expected: { projectId: Hex; workUnitId: number; recipient: Address; amountWei: bigint },
): bigint | null {
  const result = outcome.results[0];
  const warningCodes = result?.warnings.map((warning) => warning.code) ?? [];
  const observation = result?.observations.find((item) => item.name === "rewardReleased");
  if (
    outcome.results.length !== 1
    || !result
    || result.planHash !== plan.planHash
    || !result.planHashValid
    || result.reverted
    || Boolean(outcome.halted)
    || warningCodes.length > 0
  ) {
    throw new WorkerRewardVerificationError(
      "Moss Escrow simulation did not pass the signing gate",
      warningCodes,
    );
  }
  if (
    result.effects.assetsOut.length !== 0
    || result.effects.assetsIn.length !== 0
    || result.effects.approvals.length !== 0
    || result.effects.nftApprovals.length !== 0
    || result.effects.nftsOut.length !== 0
    || result.effects.nftsIn.length !== 0
    || result.effects.recipients.length !== 0
  ) {
    throw new WorkerRewardVerificationError("Escrow release produced unexpected Sponsor wallet effects");
  }
  if (
    !observation
    || observation.data.projectId !== expected.projectId
    || Number(observation.data.workUnitId) !== expected.workUnitId
    || typeof observation.data.worker !== "string"
    || !sameAddress(observation.data.worker, expected.recipient)
    || BigInt(String(observation.data.amount)) !== expected.amountWei
  ) {
    throw new WorkerRewardVerificationError("Moss did not observe the exact Escrow Worker reward");
  }
  const gas = result.gasPerTx[0];
  return gas === null || gas === undefined ? null : BigInt(gas);
}
