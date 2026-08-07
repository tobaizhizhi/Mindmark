import {
  Capability,
  Protocol,
  Registry,
  createHandle,
  createRuntime,
  defineProtocolPackage,
  plan,
  uint,
  type MossRuntime,
  type Plan,
  type SemanticType,
} from "@themoss/core";
import { createTraceSimulator, type SimulateOutcome } from "@themoss/simulator";
import {
  learningCompletionRegistryAbi,
  MOSS_SDK_VERSION,
  MossOnchainReviewSchema,
  mossNetworkSupport,
  type CompletionClaimAuthorization,
  type MossOnchainReview,
} from "@mindmark/shared";
import {
  encodeFunctionData,
  getAddress,
  keccak256,
  parseEther,
  type Address,
  type Hex,
} from "viem";

const bytes32: SemanticType<Hex> = {
  describe: "A 32-byte 0x-prefixed hex value",
  decode(value) {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(value)) {
      throw new Error("Expected a 32-byte hex value");
    }
    return value as Hex;
  },
};

const bytes: SemanticType<Hex> = {
  describe: "A non-empty 0x-prefixed byte string",
  decode(value) {
    if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/u.test(value)) {
      throw new Error("Expected a non-empty byte string");
    }
    return value as Hex;
  },
};

class MindmarkLearningProtocol {
  declare readonly runtime: MossRuntime;

  claimCompletion(input: {
    completionRegistry: Address;
    projectId: Hex;
    progressHash: Hex;
    deadline: bigint;
    signature: Hex;
  }) {
    const completion = createHandle(
      learningCompletionRegistryAbi,
      input.completionRegistry,
      this.runtime.client,
    );
    return plan([completion.claimCompletion([
      input.projectId,
      input.progressHash,
      input.deadline,
      input.signature,
    ])]);
  }
}

Capability({
  intent: "为项目 {projectId} 领取 Mindmark 学习完成凭证",
  verb: "claim",
  params: {
    completionRegistry: {
      describe: "The deployed Mindmark LearningCompletionRegistry address",
      decode(value: unknown) {
        if (typeof value !== "string") throw new Error("Expected a completion Registry address");
        return getAddress(value);
      },
    },
    projectId: bytes32,
    progressHash: bytes32,
    deadline: uint,
    signature: bytes,
  },
  risk: ["fundOut"],
  tags: ["learning", "attestation", "no-fund-out"],
})(
  MindmarkLearningProtocol.prototype.claimCompletion,
  { kind: "method", static: false } as ClassMethodDecoratorContext,
);

const RegisteredMindmarkLearningProtocol = Protocol({
  name: "mindmark-learning",
  category: "rewards",
  description: "Claim a learner-owned Mindmark completion attestation without transferring assets.",
  contracts: {},
})(
  MindmarkLearningProtocol,
  { kind: "class" } as ClassDecoratorContext<typeof MindmarkLearningProtocol>,
);

export const mindmarkLearningManifest = defineProtocolPackage({
  name: "mindmark-learning",
  protocols: [RegisteredMindmarkLearningProtocol],
});

export class MossCompletionVerificationError extends Error {
  constructor(message: string, readonly warningCodes: string[] = []) {
    super(message);
    this.name = "MossCompletionVerificationError";
  }
}

function sameAddress(left: string, right: string): boolean {
  return getAddress(left) === getAddress(right);
}

export function verifyMossCompletionPlan(
  candidate: Plan,
  expected: {
    chainId: number;
    learner: Address;
    authorization: CompletionClaimAuthorization;
  },
): void {
  const { authorization } = expected;
  const expectedData = encodeFunctionData({
    abi: learningCompletionRegistryAbi,
    functionName: "claimCompletion",
    args: [
      authorization.projectId,
      authorization.progressHash,
      BigInt(authorization.deadline),
      authorization.signature as Hex,
    ],
  });
  const transaction = candidate.txs[0];
  if (
    candidate.protocol !== "mindmark-learning"
    || candidate.method !== "claimCompletion"
    || candidate.verb !== "claim"
    || candidate.chainId !== expected.chainId
    || !sameAddress(candidate.account, expected.learner)
    || candidate.declaredRisk.length !== 1
    || candidate.declaredRisk[0] !== "fundOut"
    || candidate.txs.length !== 1
    || !transaction
    || !sameAddress(transaction.from, expected.learner)
    || !sameAddress(transaction.to, authorization.contractAddress)
    || transaction.data !== expectedData
    || BigInt(transaction.value) !== 0n
    || (candidate.expects.out?.length ?? 0) !== 0
    || (candidate.expects.in?.length ?? 0) !== 0
    || (candidate.expects.approvals?.length ?? 0) !== 0
    || (candidate.expects.nfts?.length ?? 0) !== 0
  ) {
    throw new MossCompletionVerificationError("Moss completion Plan does not match the learner intent");
  }
}

export function verifyMossCompletionSimulation(plan: Plan, outcome: SimulateOutcome): string | null {
  const result = outcome.results[0];
  const warningCodes = result?.warnings.map((warning) => warning.code) ?? [];
  if (
    outcome.results.length !== 1
    || !result
    || result.planHash !== plan.planHash
    || !result.planHashValid
    || result.reverted
    || Boolean(outcome.halted)
    || warningCodes.length > 0
  ) {
    throw new MossCompletionVerificationError(
      "Moss completion simulation did not pass the signing gate",
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
    throw new MossCompletionVerificationError("Completion claim simulation produced unexpected asset effects");
  }
  return result.gasPerTx[0] ?? null;
}

export class MossCompletionReviewer {
  private readonly runtime;
  private readonly registry;

  constructor(private readonly configuration: { rpcUrl: string; chainId: number }) {
    mossNetworkSupport(configuration.chainId);
    this.runtime = createRuntime(configuration);
    this.registry = new Registry(this.runtime);
    this.registry.use(mindmarkLearningManifest);
  }

  async review(input: {
    learner: Address;
    authorization: CompletionClaimAuthorization;
  }): Promise<MossOnchainReview> {
    const rpcChainId = await this.runtime.client.getChainId();
    if (rpcChainId !== this.configuration.chainId) {
      throw new MossCompletionVerificationError(
        `Moss RPC chain ${rpcChainId} does not match configured chain ${this.configuration.chainId}`,
      );
    }
    const coordinates = this.registry.discover({
      verb: "claim",
      category: "rewards",
      protocol: "mindmark-learning",
    });
    if (!coordinates.some((item) => item.method === "claimCompletion")) {
      throw new MossCompletionVerificationError("Moss did not discover the completion claim Capability");
    }
    const [stub] = this.registry.load([{
      protocol: "mindmark-learning",
      method: "claimCompletion",
    }]);
    if (!stub || stub.kind !== "capability" || !stub.risk.includes("fundOut")) {
      throw new MossCompletionVerificationError("Moss loaded an unexpected completion claim Capability");
    }
    const action = await this.registry.action(
      "mindmark-learning",
      "claimCompletion",
      input.learner,
      {
        completionRegistry: input.authorization.contractAddress,
        projectId: input.authorization.projectId,
        progressHash: input.authorization.progressHash,
        deadline: input.authorization.deadline,
        signature: input.authorization.signature,
      },
    );
    if (action.kind !== "plan") {
      throw new MossCompletionVerificationError("Moss completion action did not produce a Plan");
    }
    verifyMossCompletionPlan(action, {
      chainId: this.configuration.chainId,
      learner: input.learner,
      authorization: input.authorization,
    });
    const simulator = createTraceSimulator(this.runtime, {
      prefundWei: parseEther("0.1"),
      observer: this.registry.observer(),
    });
    const outcome = await simulator.simulate([action]);
    const simulationGas = verifyMossCompletionSimulation(action, outcome);
    const transaction = action.txs[0]!;
    return MossOnchainReviewSchema.parse({
      sdkVersion: MOSS_SDK_VERSION,
      networkSupport: mossNetworkSupport(this.configuration.chainId),
      operation: "COMPLETION_CLAIM",
      intent: action.intent,
      capability: {
        protocol: action.protocol,
        method: action.method,
        verb: action.verb,
        category: stub.category,
        declaredRisks: action.declaredRisk,
      },
      account: input.learner,
      target: transaction.to,
      valueWei: BigInt(transaction.value).toString(),
      calldataHash: keccak256(transaction.data),
      stage: "SIMULATED",
      planHash: action.planHash,
      simulation: {
        status: "PASSED",
        warningCodes: [],
        gas: simulationGas,
      },
      expectedEffects: {
        nativeOutWei: "0",
        recipient: null,
        approvalCount: 0,
      },
      signerAuthority: "LEARNER_WALLET",
    });
  }
}
