import { describe, expect, it } from "vitest";
import { Registry, createRuntime, type Plan } from "@themoss/core";
import type { SimulateOutcome } from "@themoss/simulator";
import type { CompletionClaimAuthorization } from "@mindmark/shared";
import type { Address, Hex } from "viem";
import {
  mindmarkLearningManifest,
  verifyMossCompletionPlan,
  verifyMossCompletionSimulation,
} from "@/lib/server/moss-completion-review";

const hex = (value: string) => `0x${value.repeat(64).slice(0, 64)}` as Hex;
const address = (value: string) => `0x${value.repeat(40).slice(0, 40)}` as Address;
const learner = address("a");
const authorization: CompletionClaimAuthorization = {
  projectId: hex("1"),
  contractAddress: address("b"),
  projectDeckRoot: hex("2"),
  progressHash: hex("3"),
  deadline: 1_900_000_000,
  signature: `0x${"44".repeat(65)}`,
};

async function buildPlan(): Promise<Plan> {
  const registry = new Registry(createRuntime({ rpcUrl: "http://127.0.0.1:8545", chainId: 10143 }));
  registry.use(mindmarkLearningManifest);
  expect(registry.discover({ verb: "claim", category: "rewards" })).toContainEqual(
    expect.objectContaining({ protocol: "mindmark-learning", method: "claimCompletion" }),
  );
  expect(registry.load([{ protocol: "mindmark-learning", method: "claimCompletion" }])).toContainEqual(
    expect.objectContaining({ kind: "capability", risk: ["fundOut"] }),
  );
  const action = await registry.action("mindmark-learning", "claimCompletion", learner, {
    completionRegistry: authorization.contractAddress,
    projectId: authorization.projectId,
    progressHash: authorization.progressHash,
    deadline: authorization.deadline,
    signature: authorization.signature,
  });
  if (action.kind !== "plan") throw new Error("Expected a Moss Plan");
  return action;
}

function outcomeFor(plan: Plan, warningCodes: string[] = []): SimulateOutcome {
  return {
    results: [{
      protocol: plan.protocol,
      method: plan.method,
      intent: plan.intent,
      planHash: plan.planHash,
      planHashValid: true,
      reverted: false,
      effects: {
        assetsOut: [], assetsIn: [], approvals: [], nftApprovals: [],
        nftsOut: [], nftsIn: [], recipients: [],
      },
      observations: [],
      warnings: warningCodes.map((code) => ({ code: code as "REVERTED", message: code })),
      gasPerTx: ["45678"],
    }],
  };
}

describe("Moss completion review", () => {
  it("discovers, loads and builds the exact no-fund-out completion Capability", async () => {
    const plan = await buildPlan();
    expect(() => verifyMossCompletionPlan(plan, {
      chainId: 10143,
      learner,
      authorization,
    })).not.toThrow();
    expect(verifyMossCompletionSimulation(plan, outcomeFor(plan))).toBe("45678");
    expect(plan).toMatchObject({
      protocol: "mindmark-learning",
      method: "claimCompletion",
      verb: "claim",
      declaredRisk: ["fundOut"],
      account: learner,
    });
  });

  it("blocks signing when Moss reports any simulation Warning", async () => {
    const plan = await buildPlan();
    expect(() => verifyMossCompletionSimulation(
      plan,
      outcomeFor(plan, ["UNDECLARED_OUTFLOW"]),
    )).toThrow("did not pass the signing gate");
  });
});
