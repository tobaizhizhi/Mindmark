import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import {
  getMonadVerificationSnapshot,
  type MonadVerificationChainReader,
  type MonadVerificationEvidenceStore,
} from "@/lib/server/monad-verification";

const hex = (value: string) => `0x${value.repeat(64).slice(0, 64)}` as Hex;
const address = (value: string) => `0x${value.repeat(40).slice(0, 40)}` as Address;
const projectId = hex("1");
const learner = address("a");
const worker = address("b");
const treasury = address("c");
const registryAddress = address("d");
const escrowAddress = address("8");
const txHash = hex("e");
const pricingRoot = hex("f");

class ReadyChain implements MonadVerificationChainReader {
  async getBlockNumber() { return 900n; }
  async readProject() {
    return {
      learner,
      sourceHash: hex("2"), goalHash: hex("3"), outlineHash: hex("4"),
      workUnitManifestRoot: hex("5"), projectDeckRoot: hex("6"), initialPlanHash: hex("7"),
      chapterCount: 1, workUnitCount: 1, totalCardCount: 4, status: "READY" as const,
    };
  }
  async readChapters() {
    return [{
      sourceHash: hex("8"), cardsRoot: hex("9"), firstWorkUnitId: 0,
      workUnitCount: 1, cardCount: 4, status: "READY" as const,
    }];
  }
  async readWorkUnits() {
    return [{
      chapterId: 0, sourceUnitHash: hex("a"), workerCardsRoot: hex("b"),
      worker, committedBlock: 880n, cardCount: 4,
    }];
  }
  async readProjectEscrow() {
    return {
      pricingMode: "DYNAMIC" as const, sponsor: treasury, pricingRoot,
      rewardPerWorkUnitWei: null, totalBudgetWei: 1_000_000_000_000_000n,
      remainingBudgetWei: 0n, workUnitCount: 1, settledWorkUnitCount: 1,
      fundedBlock: 870n, refunded: false, rewardAmountsWei: [1_000_000_000_000_000n],
    };
  }
  async readEscrowRelease() {
    return {
      from: treasury, projectId, workUnitId: 0, worker,
      amountWei: 1_000_000_000_000_000n, blockNumber: 890n, succeeded: true,
    };
  }
  async readCompletion() { return null; }
}

class MatchingStore implements MonadVerificationEvidenceStore {
  constructor(private readonly cardsRoot: Hex = hex("b")) {}
  async load() {
    return {
      project: {
        ownerAddress: learner, status: "READY", sourceHash: hex("2"), goalHash: hex("3"),
        outlineHash: hex("4"), workUnitManifestRoot: hex("5"), projectDeckRoot: hex("6"),
        initialPlanHash: hex("7"), totalCardCount: 4,
        createTransactionHash: hex("c"), finalizeTransactionHash: hex("d"),
        escrowAddress, sponsorAddress: treasury,
        pricingPolicyVersion: "work-unit-pricing-v1",
        pricingRoot,
        rewardPerWorkUnitWei: null,
        totalBudgetWei: 1_000_000_000_000_000n,
        remainingBudgetWei: 0n,
        escrowWorkUnitCount: 1, settledWorkUnitCount: 1,
        fundingTransactionHash: hex("8"), fundedBlock: 870n, escrowState: "FUNDED" as const,
      },
      chapters: [{ chapterId: 0, sourceHash: hex("8"), cardsRoot: hex("9"), cardCount: 4, transactionHash: hex("f") }],
      workUnits: [{
        workUnitId: 0, chapterId: 0, sourceUnitHash: hex("a"), cardsRoot: this.cardsRoot,
        worker, cardCount: 4, transactionHash: txHash, confirmedBlock: 880n,
        workloadScore: 18, rewardTier: "M" as const, rewardAmountWei: 1_000_000_000_000_000n,
      }],
      rewards: [{
        workUnitId: 0, escrowAddress, treasury, recipient: worker, amountWei: 1_000_000_000_000_000n,
        status: "CONFIRMED", transactionHash: txHash, confirmedBlock: 890n,
        mossStage: "SIMULATED" as const,
        mossPlanHash: hex("1"),
        simulationStatus: "PASSED" as const,
        simulationWarningCodes: [],
        simulationGas: 21_000n,
      }],
    };
  }
}

const configuration = {
  chainId: 10143,
  registryAddress,
  escrowAddress,
  explorerUrl: "https://testnet.monadexplorer.com",
};

describe("Monad Verification Snapshot", () => {
  it("verifies Registry commitments, Sponsor Budget, and an exact Escrow release", async () => {
    const snapshot = await getMonadVerificationSnapshot(projectId, {
      configuration,
      chain: new ReadyChain(),
      store: new MatchingStore(),
    });

    expect(snapshot.overallState).toBe("VERIFIED");
    expect(snapshot.checks).toContainEqual(expect.objectContaining({
      key: "moss_network_policy",
      state: "VERIFIED",
      detail: expect.stringContaining("实验性 Testnet"),
    }));
    expect(snapshot.workUnits[0]).toMatchObject({ worker, evidenceState: "VERIFIED" });
    expect(snapshot.rewards[0]).toMatchObject({
      escrowAddress,
      evidenceState: "VERIFIED",
      amountWei: "1000000000000000",
      mossReview: {
        target: escrowAddress,
        valueWei: "0",
        capability: { protocol: "mindmark-escrow", method: "releaseWorkUnitReward" },
        networkSupport: "EXPERIMENTAL_TESTNET",
        stage: "SIMULATED",
        planHash: hex("1"),
        simulation: { status: "PASSED", warningCodes: [], gas: "21000" },
      },
    });
    expect(snapshot.sponsorBudget).toMatchObject({
      escrowAddress,
      sponsor: treasury,
      totalBudgetWei: "1000000000000000",
      remainingBudgetWei: "0",
      evidenceState: "VERIFIED",
      pricingPolicyVersion: "work-unit-pricing-v1",
      pricingRoot,
      quotes: [{
        workUnitId: 0,
        workloadScore: 18,
        rewardTier: "M",
        amountWei: "1000000000000000",
        evidenceState: "VERIFIED",
      }],
    });
    expect(JSON.stringify(snapshot)).not.toContain("sourceText");
  });

  it("surfaces a cardsRoot mismatch instead of accepting the local transaction index", async () => {
    const snapshot = await getMonadVerificationSnapshot(projectId, {
      configuration,
      chain: new ReadyChain(),
      store: new MatchingStore(hex("0")),
    });

    expect(snapshot.overallState).toBe("MISMATCH");
    expect(snapshot.workUnits[0]?.evidenceState).toBe("MISMATCH");
  });

  it("keeps the public on-chain view available when Supabase evidence is unavailable", async () => {
    const store: MonadVerificationEvidenceStore = { async load() { throw new Error("offline"); } };
    const snapshot = await getMonadVerificationSnapshot(projectId, {
      configuration,
      chain: new ReadyChain(),
      store,
    });

    expect(snapshot.overallState).toBe("VERIFIED");
    expect(snapshot.localEvidenceAvailable).toBe(false);
    expect(snapshot.checks).toContainEqual(expect.objectContaining({ key: "local_evidence", state: "UNAVAILABLE" }));
    expect(snapshot.rewards).toEqual([]);
  });

  it("marks a confirmed Reward mismatch when Monad sent another amount", async () => {
    class WrongTransferChain extends ReadyChain {
      override async readEscrowRelease() {
        return { from: treasury, projectId, workUnitId: 0, worker, amountWei: 2n, blockNumber: 890n, succeeded: true };
      }
    }
    const snapshot = await getMonadVerificationSnapshot(projectId, {
      configuration,
      chain: new WrongTransferChain(),
      store: new MatchingStore(),
    });

    expect(snapshot.overallState).toBe("MISMATCH");
    expect(snapshot.rewards[0]?.evidenceState).toBe("MISMATCH");
  });

  it("treats locally confirmed evidence missing from Registry state as a conflict", async () => {
    class MissingCommitmentChain implements MonadVerificationChainReader {
      async getBlockNumber() { return 900n; }
      async readProject() {
        return {
          learner, sourceHash: hex("2"), goalHash: hex("3"), outlineHash: hex("4"),
          workUnitManifestRoot: hex("5"), projectDeckRoot: hex("0"), initialPlanHash: hex("0"),
          chapterCount: 1, workUnitCount: 1, totalCardCount: 0, status: "CREATED" as const,
        };
      }
      async readChapters() {
        return [{ sourceHash: hex("8"), cardsRoot: hex("0"), firstWorkUnitId: 0, workUnitCount: 1, cardCount: 0, status: "OPEN" as const }];
      }
      async readWorkUnits() {
        return [{ chapterId: 0, sourceUnitHash: hex("0"), workerCardsRoot: hex("0"), worker: address("0"), committedBlock: 0n, cardCount: 0 }];
      }
      async readProjectEscrow() { return new ReadyChain().readProjectEscrow(); }
      async readEscrowRelease() { return new ReadyChain().readEscrowRelease(); }
      async readCompletion() { return null; }
    }
    const snapshot = await getMonadVerificationSnapshot(projectId, {
      configuration,
      chain: new MissingCommitmentChain(),
      store: new MatchingStore(),
    });

    expect(snapshot.overallState).toBe("MISMATCH");
    expect(snapshot.chapters[0]?.evidenceState).toBe("MISMATCH");
    expect(snapshot.workUnits[0]).toMatchObject({ worker: address("0"), evidenceState: "MISMATCH" });
  });
});
