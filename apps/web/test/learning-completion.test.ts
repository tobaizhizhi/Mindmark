import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import {
  authorizeLearningCompletionClaim,
  getLearningCompletionClaimStatus,
  hashCompletionProgress,
  reviewLearningCompletionClaim,
  type LearningCompletionAuthorizationSigner,
  type LearningCompletionChainReader,
  type LearningCompletionMossReviewer,
  type LearningCompletionStore,
} from "@/lib/server/learning-completion";

const hex = (value: string) => `0x${value.repeat(64).slice(0, 64)}` as Hex;
const address = (value: string) => `0x${value.repeat(40).slice(0, 40)}` as Address;
const projectId = hex("1");
const owner = address("a");
const registryAddress = address("b");
const completionAddress = address("c");
const attestor = address("d");
const deckRoot = hex("2");

function storeWith(reps: number, lapses = 0): LearningCompletionStore {
  return {
    async load() {
      return {
        projectKind: "UPLOAD" as const,
        status: "READY",
        projectDeckRoot: deckRoot,
        cards: [
          { cardId: hex("3"), reps, lapses, lastReviewedAt: "2026-08-05T00:00:00.000Z" },
          { cardId: hex("4"), reps, lapses, lastReviewedAt: "2026-08-05T01:00:00.000Z" },
        ],
      };
    },
  };
}

const chain: LearningCompletionChainReader = {
  async readRegistryProject() { return { learner: owner, projectDeckRoot: deckRoot, status: 2 }; },
  async readCompletionContract() { return { sourceRegistry: registryAddress, attestor, claimedBy: address("0") }; },
};

class CapturingSigner implements LearningCompletionAuthorizationSigner {
  readonly address = attestor;
  input: Parameters<LearningCompletionAuthorizationSigner["sign"]>[0] | null = null;
  async sign(input: Parameters<LearningCompletionAuthorizationSigner["sign"]>[0]) {
    this.input = input;
    return `0x${"12".repeat(65)}` as Hex;
  }
}

function dependencies(store: LearningCompletionStore, signer = new CapturingSigner()) {
  return {
    chainId: 10143,
    registryAddress,
    completionRegistryAddress: completionAddress,
    store,
    chain,
    signer,
    now: () => new Date("2026-08-05T10:00:00.000Z"),
  };
}

describe("Learning Completion Attestation", () => {
  it("does not authorize a Project until every card satisfies the mastery policy", async () => {
    const status = await getLearningCompletionClaimStatus(projectId, owner, dependencies(storeWith(2)));
    expect(status).toMatchObject({ eligible: false, reason: "MASTERY_INCOMPLETE", cardCount: 2, masteredCount: 0 });
  });

  it("creates a short-lived authorization bound to learner, deck and progress hash", async () => {
    const signer = new CapturingSigner();
    const authorization = await authorizeLearningCompletionClaim(
      projectId,
      owner,
      dependencies(storeWith(3), signer),
    );

    expect(authorization).toMatchObject({
      projectId,
      contractAddress: completionAddress,
      projectDeckRoot: deckRoot,
      deadline: 1_785_924_600,
    });
    expect(signer.input).toMatchObject({ projectId, learner: owner, projectDeckRoot: deckRoot });
    expect(signer.input?.progressHash).toBe(authorization.progressHash);
  });

  it("returns a passed Moss review before the learner wallet may sign", async () => {
    const reviewer: LearningCompletionMossReviewer = {
      async review(input) {
        return {
          sdkVersion: "0.1.0",
          networkSupport: "EXPERIMENTAL_TESTNET",
          operation: "COMPLETION_CLAIM",
          intent: `为项目 ${input.authorization.projectId} 领取完成凭证`,
          capability: {
            protocol: "mindmark-learning",
            method: "claimCompletion",
            verb: "claim",
            category: "rewards",
            declaredRisks: ["fundOut"],
          },
          account: input.learner,
          target: input.authorization.contractAddress,
          valueWei: "0",
          calldataHash: hex("5"),
          stage: "SIMULATED",
          planHash: hex("6"),
          simulation: { status: "PASSED", warningCodes: [], gas: "45000" },
          expectedEffects: { nativeOutWei: "0", recipient: null, approvalCount: 0 },
          signerAuthority: "LEARNER_WALLET",
        };
      },
    };
    const result = await reviewLearningCompletionClaim(
      projectId,
      owner,
      { ...dependencies(storeWith(3)), reviewer },
    );

    expect(result.authorization).toMatchObject({ projectId, contractAddress: completionAddress });
    expect(result.mossReview).toMatchObject({
      stage: "SIMULATED",
      simulation: { status: "PASSED", warningCodes: [] },
      signerAuthority: "LEARNER_WALLET",
    });
  });

  it("refuses authorization when the Completion contract points at another Registry", async () => {
    const wrongChain: LearningCompletionChainReader = {
      ...chain,
      async readCompletionContract() { return { sourceRegistry: address("e"), attestor, claimedBy: address("0") }; },
    };
    const input = { ...dependencies(storeWith(3)), chain: wrongChain };
    const status = await getLearningCompletionClaimStatus(projectId, owner, input);
    expect(status).toMatchObject({ eligible: false, reason: "CHAIN_MISMATCH" });
    await expect(authorizeLearningCompletionClaim(projectId, owner, input)).rejects.toMatchObject({ code: "completion_not_eligible" });
  });

  it("hashes the same qualified state identically regardless of card query order", () => {
    const cards = [
      { cardId: hex("3"), reps: 3, lapses: 0, lastReviewedAt: "2026-08-05T00:00:00.000Z" },
      { cardId: hex("4"), reps: 4, lapses: 0, lastReviewedAt: "2026-08-05T01:00:00.000Z" },
    ];
    const first = hashCompletionProgress({ projectId, owner, projectDeckRoot: deckRoot, cards });
    const second = hashCompletionProgress({ projectId, owner, projectDeckRoot: deckRoot, cards: [...cards].reverse() });
    expect(first).toBe(second);
  });
});
