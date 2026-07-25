import { describe, expect, it } from "vitest";
import { NATIVE, computePlanHash, type Plan } from "@themoss/core";
import type { SimulateOutcome } from "@themoss/simulator";
import {
  SettlementAgent,
  verifyMossRewardPlan,
  verifyMossRewardSimulation,
} from "../src/reward.js";
import type {
  PreparedWorkerReward,
  WorkerRewardGateway,
  WorkerRewardReceipt,
} from "../src/types.js";
import type { TransactionSerialized } from "viem";
import {
  FakeRegistry,
  InMemoryRepository,
  address,
  hex,
  journeyId,
  workerAddresses,
} from "./fakes.js";

class FakeRewardGateway implements WorkerRewardGateway {
  prepareCalls = 0;
  settleCalls = 0;
  readonly stages: string[] = [];

  treasuryAddress() {
    return address("e");
  }

  async prepare(
    input: { recipientAddress: `0x${string}`; amountWei: bigint },
    onStage?: (stage: "DISCOVERED" | "LOADED" | "BUILT") => Promise<void>,
  ): Promise<PreparedWorkerReward> {
    this.prepareCalls += 1;
    for (const stage of ["DISCOVERED", "LOADED", "BUILT"] as const) {
      this.stages.push(stage);
      await onStage?.(stage);
    }
    return {
      treasuryAddress: this.treasuryAddress(),
      recipientAddress: input.recipientAddress,
      amountWei: input.amountWei,
      mossPlanHash: hex("a"),
      simulationWarningCodes: [],
      simulationGas: 21_000n,
      signedTransaction: "0x01" as TransactionSerialized,
      treasuryNonce: 4n,
      txHash: hex("b"),
    };
  }

  async settlePrepared(
    input: PreparedWorkerReward,
    onSubmitted?: (txHash: `0x${string}`) => Promise<void>,
  ): Promise<WorkerRewardReceipt> {
    this.settleCalls += 1;
    await onSubmitted?.(input.txHash);
    return { txHash: input.txHash, blockNumber: 100n, gasUsed: 21_000n, confirmationMs: 10 };
  }
}

function eligibleFixture() {
  const repository = new InMemoryRepository();
  const registry = new FakeRegistry();
  repository.state.chunks[0]!.workerAddress = workerAddresses[0];
  repository.state.chunks[0]!.status = "CONFIRMED";
  repository.markChunkConfirmed(journeyId, 0, { txHash: hex("c") });
  registry.commitments.set(0, {
    sourceChunkHash: hex("1"),
    cardsRoot: hex("2"),
    agent: workerAddresses[0],
    committedBlock: 10n,
    cardCount: 2,
  });
  return { repository, registry };
}

describe("Worker reward settlement", () => {
  it("runs Moss stages and confirms one independent reward", async () => {
    const { repository, registry } = eligibleFixture();
    const gateway = new FakeRewardGateway();
    const count = await new SettlementAgent(repository, registry, gateway).runOnce();

    expect(count).toBe(1);
    expect(gateway.stages).toEqual(["DISCOVERED", "LOADED", "BUILT"]);
    expect(gateway.prepareCalls).toBe(1);
    expect(gateway.settleCalls).toBe(1);
    expect(repository.rewards[0]!.status).toBe("CONFIRMED");
  });

  it("blocks a recipient mismatch without attempting to sign or send", async () => {
    const { repository, registry } = eligibleFixture();
    registry.commitments.set(0, {
      sourceChunkHash: hex("1"),
      cardsRoot: hex("2"),
      agent: address("f"),
      committedBlock: 10n,
      cardCount: 2,
    });
    const gateway = new FakeRewardGateway();
    await new SettlementAgent(repository, registry, gateway).runOnce();

    expect(gateway.prepareCalls).toBe(0);
    expect(gateway.settleCalls).toBe(0);
    expect(repository.rewards[0]!.status).toBe("BLOCKED");
  });

  it("replays a prepared transaction without rebuilding the Moss action", async () => {
    const { repository, registry } = eligibleFixture();
    Object.assign(repository.rewards[0]!, {
      status: "PREPARED",
      mossStage: "SIMULATED",
      mossPlanHash: hex("a"),
      simulationStatus: "PASSED",
      signedTransaction: "0x01" as TransactionSerialized,
      treasuryNonce: 4n,
      txHash: hex("b"),
    });
    const gateway = new FakeRewardGateway();
    await new SettlementAgent(repository, registry, gateway).runOnce();

    expect(gateway.prepareCalls).toBe(0);
    expect(gateway.settleCalls).toBe(1);
    expect(repository.rewards[0]!.status).toBe("CONFIRMED");
  });
});

function mossPlan(overrides: Partial<Plan> = {}): Plan {
  const draft = {
    kind: "plan" as const,
    protocol: "erc20",
    method: "transfer",
    verb: "transfer" as const,
    chainId: 10143,
    account: address("e"),
    intent: "Transfer 0.001 native",
    declaredRisk: ["fundOut" as const],
    expects: { out: [{ token: NATIVE, amountMax: "1000000000000000" }] },
    confirms: [],
    txs: [{
      from: address("e"),
      to: workerAddresses[0],
      data: "0x" as const,
      value: "0x38d7ea4c68000" as const,
    }],
    planHash: hex("0"),
    ...overrides,
  };
  return { ...draft, planHash: computePlanHash(draft) };
}

function mossOutcome(plan: Plan): SimulateOutcome {
  return {
    results: [{
      protocol: plan.protocol,
      method: plan.method,
      intent: plan.intent,
      planHash: plan.planHash,
      planHashValid: true,
      reverted: false,
      effects: {
        assetsOut: [{ token: NATIVE, amount: "1000000000000000" }],
        assetsIn: [],
        approvals: [],
        nftApprovals: [],
        nftsOut: [],
        nftsIn: [],
        recipients: [workerAddresses[0]],
      },
      observations: [],
      warnings: [],
      gasPerTx: ["21000"],
    }],
  };
}

describe("Moss reward signing gate", () => {
  it("accepts only the exact native MON Plan and effects", () => {
    const plan = mossPlan();
    expect(() => verifyMossRewardPlan(plan, {
      chainId: 10143,
      treasury: address("e"),
      recipient: workerAddresses[0],
      amountWei: 1_000_000_000_000_000n,
    })).not.toThrow();
    expect(verifyMossRewardSimulation(plan, mossOutcome(plan), {
      recipient: workerAddresses[0],
      amountWei: 1_000_000_000_000_000n,
    })).toBe(21_000n);
  });

  it("blocks a warning or an unexpected recipient before signing", () => {
    const plan = mossPlan();
    const warned = mossOutcome(plan);
    warned.results[0]!.warnings.push({ code: "UNDECLARED_OUTFLOW", message: "unexpected" });
    expect(() => verifyMossRewardSimulation(plan, warned, {
      recipient: workerAddresses[0],
      amountWei: 1_000_000_000_000_000n,
    })).toThrow(/signing gate/u);

    const mismatch = mossOutcome(plan);
    mismatch.results[0]!.effects.recipients = [address("f")];
    expect(() => verifyMossRewardSimulation(plan, mismatch, {
      recipient: workerAddresses[0],
      amountWei: 1_000_000_000_000_000n,
    })).toThrow(/effects/u);
  });
});
