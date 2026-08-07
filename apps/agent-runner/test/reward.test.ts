import { describe, expect, it, vi } from "vitest";
import { Registry, createRuntime, type Plan } from "@themoss/core";
import type { SimulateOutcome } from "@themoss/simulator";
import { learningProjectEscrowAbi } from "@mindmark/shared";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  type Address,
  type Hex,
  type TransactionSerialized,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MossViemRewardGateway } from "../src/reward.js";
import {
  createMindmarkEscrowManifest,
  verifyMossEscrowReleasePlan,
  verifyMossEscrowReleaseSimulation,
} from "../src/moss-project-escrow.js";

const chainId = 10143;
const treasuryPrivateKey = `0x${"11".repeat(32)}` as Hex;
const recipient = `0x${"22".repeat(20)}` as Address;
const registryAddress = `0x${"44".repeat(20)}` as Address;
const escrowAddress = `0x${"55".repeat(20)}` as Address;
const projectId = `0x${"66".repeat(32)}` as Hex;

describe("MossViemRewardGateway", () => {
  it("reads the legacy seven-field Project Escrow getter", async () => {
    const gateway = new MossViemRewardGateway({
      rpcUrl: "http://127.0.0.1:8545",
      chainId,
      registryAddress,
      escrowAddress,
      treasuryPrivateKey,
    });
    const readContract = vi.fn()
      .mockRejectedValueOnce(new Error("legacy Escrow getter has no refunded field"))
      .mockResolvedValueOnce([
        recipient,
        1_000n,
        2_000n,
        5n,
        3n,
        99n,
        false,
      ]);
    Object.defineProperty(gateway, "publicClient", { value: { readContract } });

    const state = await (gateway as unknown as {
      readProjectEscrow(id: Hex): Promise<{
        pricingMode: "LEGACY_FIXED";
        sponsor: Address;
        pricingRoot: null;
        rewardPerWorkUnitWei: bigint;
        totalBudgetWei: bigint;
        remainingBudgetWei: bigint;
        workUnitCount: number;
        settledWorkUnitCount: number;
        fundedBlock: bigint;
        refunded: boolean;
      }>;
    }).readProjectEscrow(projectId);
    expect(state).toEqual({
      pricingMode: "LEGACY_FIXED",
      sponsor: recipient,
      pricingRoot: null,
      rewardPerWorkUnitWei: 1_000n,
      totalBudgetWei: 5_000n,
      remainingBudgetWei: 2_000n,
      workUnitCount: 5,
      settledWorkUnitCount: 3,
      fundedBlock: 99n,
      refunded: false,
    });
    expect(readContract).toHaveBeenCalledTimes(2);
  });

  it("funds the legacy Escrow with one fixed reward instead of a dynamic quote array", async () => {
    const gateway = new MossViemRewardGateway({
      rpcUrl: "http://127.0.0.1:8545",
      chainId,
      registryAddress,
      escrowAddress,
      treasuryPrivateKey,
    });
    const sponsor = privateKeyToAccount(treasuryPrivateKey).address;
    const emptyState = {
      pricingMode: "LEGACY_FIXED" as const,
      sponsor: "0x0000000000000000000000000000000000000000" as Address,
      pricingRoot: null,
      rewardPerWorkUnitWei: 0n,
      totalBudgetWei: 0n,
      remainingBudgetWei: 0n,
      workUnitCount: 0,
      settledWorkUnitCount: 0,
      fundedBlock: 0n,
      refunded: false,
    };
    const fundedState = {
      ...emptyState,
      sponsor,
      rewardPerWorkUnitWei: 1_000n,
      totalBudgetWei: 2_000n,
      remainingBudgetWei: 2_000n,
      workUnitCount: 2,
      fundedBlock: 101n,
    };
    const readProjectEscrow = vi.fn()
      .mockResolvedValueOnce(emptyState)
      .mockResolvedValueOnce(fundedState);
    Object.defineProperty(gateway, "readProjectEscrow", { value: readProjectEscrow });
    Object.defineProperty(gateway, "publicClient", { value: {
      getBalance: vi.fn().mockResolvedValue(10_000n),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: "success", blockNumber: 101n }),
    } });
    const fundingTxHash = `0x${"88".repeat(32)}` as Hex;
    const writeContract = vi.fn().mockResolvedValue(fundingTxHash);
    Object.defineProperty(gateway, "walletClient", { value: { writeContract } });

    const funding = await gateway.ensureProjectFunded({
      projectId,
      legacyRewardPerWorkUnitWei: 1_000n,
      quotes: [
        { workUnitId: 0, workloadScore: 10, rewardTier: "S", rewardAmountWei: 800n, pricingPolicyVersion: "work-unit-pricing-v1" },
        { workUnitId: 1, workloadScore: 30, rewardTier: "L", rewardAmountWei: 1_800n, pricingPolicyVersion: "work-unit-pricing-v1" },
      ],
    });

    expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: "fundProject",
      args: [projectId, 1_000n],
      value: 2_000n,
    }));
    expect(funding).toMatchObject({
      pricingMode: "LEGACY_FIXED",
      pricingRoot: null,
      rewardPerWorkUnitWei: 1_000n,
      totalBudgetWei: 2_000n,
      fundingTxHash,
    });
  });

  it("discovers and seals the exact Mindmark Escrow release Capability", async () => {
    const account = privateKeyToAccount(treasuryPrivateKey);
    const registry = new Registry(createRuntime({ rpcUrl: "http://127.0.0.1:8545", chainId }));
    registry.use(createMindmarkEscrowManifest(escrowAddress));
    expect(registry.discover({ verb: "transfer", category: "rewards" })).toContainEqual(
      expect.objectContaining({ protocol: "mindmark-escrow", method: "releaseWorkUnitReward" }),
    );
    const action = await registry.action("mindmark-escrow", "releaseWorkUnitReward", account.address, {
      projectId,
      workUnitId: 0,
    });
    if (action.kind !== "plan") throw new Error("Expected a Moss Plan");
    expect(() => verifyMossEscrowReleasePlan(action, {
      chainId,
      sponsor: account.address,
      escrowAddress,
      projectId,
      workUnitId: 0,
    })).not.toThrow();

    const outcome: SimulateOutcome = {
      results: [{
        protocol: action.protocol,
        method: action.method,
        intent: action.intent,
        planHash: action.planHash,
        planHashValid: true,
        reverted: false,
        effects: {
          assetsOut: [], assetsIn: [], approvals: [], nftApprovals: [],
          nftsOut: [], nftsIn: [], recipients: [],
        },
        observations: [{
          protocol: "mindmark-escrow",
          name: "rewardReleased",
          intent: "Released 1 wei",
          data: { projectId, workUnitId: 0, worker: recipient, amount: "1" },
        }],
        warnings: [],
        gasPerTx: ["50000"],
      }],
    };
    expect(verifyMossEscrowReleaseSimulation(action as Plan, outcome, {
      projectId,
      workUnitId: 0,
      recipient,
      amountWei: 1n,
    })).toBe(50_000n);
  });

  it("accepts a signed Escrow release only when its receipt pays the expected Worker", async () => {
    const account = privateKeyToAccount(treasuryPrivateKey);
    const data = encodeFunctionData({
      abi: learningProjectEscrowAbi,
      functionName: "releaseReward",
      args: [projectId, 0],
    });
    const signedTransaction = await account.signTransaction({
      chainId,
      to: escrowAddress,
      value: 0n,
      data,
      nonce: 0,
      gas: 21_000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
      type: "eip1559",
    }) as TransactionSerialized;
    const txHash = keccak256(signedTransaction);
    const gateway = new MossViemRewardGateway({
      rpcUrl: "http://127.0.0.1:8545",
      chainId,
      registryAddress,
      escrowAddress,
      treasuryPrivateKey,
    });
    Object.defineProperty(gateway, "publicClient", {
      value: {
        async getTransactionReceipt() {
          return {
            status: "success",
            blockNumber: 9n,
            gasUsed: 21_000n,
            logs: [{
              address: escrowAddress,
              topics: encodeEventTopics({
                abi: learningProjectEscrowAbi,
                eventName: "RewardReleased",
                args: { projectId, workUnitId: 0, worker: recipient },
              }),
              data: encodeAbiParameters([{ type: "uint256" }], [1n]),
            }],
          };
        },
        async getTransaction() {
          return {
            from: account.address,
            to: escrowAddress,
            value: 0n,
            input: data,
            nonce: 0,
          };
        },
      },
    });

    await expect(gateway.settlePrepared({
      projectId,
      workUnitId: 0,
      treasuryAddress: account.address,
      recipientAddress: recipient,
      amountWei: 1n,
      mossPlanHash: `0x${"33".repeat(32)}`,
      simulationWarningCodes: [],
      simulationGas: 21_000n,
      signedTransaction,
      treasuryNonce: 0n,
      txHash,
    })).resolves.toMatchObject({ txHash, blockNumber: 9n, gasUsed: 21_000n });
  });
});
