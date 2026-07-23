import {
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { learningJourneyRegistryAbi } from "@mindmark/shared";
import { resetServerEnvironmentForTests } from "@/lib/server/config";
import type { JourneyStore, StoredJourney } from "@/lib/server/journeys";
import {
  confirmCreateJourneyTransaction,
  type MonadReceiptClient,
} from "@/lib/server/registry";

const journeyId = `0x${"21".repeat(32)}` as Hex;
const owner = `0x${"aa".repeat(20)}` as `0x${string}`;
const registryAddress = `0x${"bb".repeat(20)}` as `0x${string}`;
const txHash = `0x${"cc".repeat(32)}` as Hex;
const sourceHash = `0x${"31".repeat(32)}` as Hex;
const goalHash = `0x${"32".repeat(32)}` as Hex;
const manifestRoot = `0x${"33".repeat(32)}` as Hex;

beforeAll(() => {
  process.env.MONAD_RPC_URL = "http://127.0.0.1:8545";
  process.env.MONAD_CHAIN_ID = "10143";
  process.env.REGISTRY_ADDRESS = registryAddress;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-for-tests-only";
  process.env.SESSION_SECRET = "session-secret-for-tests-only-32-bytes";
  resetServerEnvironmentForTests();
});

class MemoryJourneyStore implements JourneyStore {
  marked = false;
  recorded = false;
  constructor(public journey: StoredJourney | null) {}
  async savePrepared(): Promise<void> {}
  async findOwned(id: Hex, address: `0x${string}`): Promise<StoredJourney | null> {
    return this.journey?.journey_id === id && this.journey.learner_address === address
      ? this.journey
      : null;
  }
  async markCreated(id: Hex, address: `0x${string}`, hash: Hex): Promise<void> {
    expect([id, address, hash]).toEqual([journeyId, owner, txHash]);
    this.marked = true;
  }
  async recordCreateTransaction(id: Hex, address: `0x${string}`, hash: Hex): Promise<void> {
    expect([id, address, hash]).toEqual([journeyId, owner, txHash]);
    this.recorded = true;
  }
}

function storedJourney(): StoredJourney {
  return {
    journey_id: journeyId,
    learner_address: owner,
    source_hash: sourceHash,
    goal_hash: goalHash,
    chunk_manifest_root: manifestRoot,
    chunk_count: 3,
    status: "AWAITING_CREATE_TX",
    create_tx_hash: null,
  };
}

function receipt(overrides?: { emittedJourneyId?: Hex; status?: "success" | "reverted" }) {
  const emittedJourneyId = overrides?.emittedJourneyId ?? journeyId;
  const topics = encodeEventTopics({
    abi: learningJourneyRegistryAbi,
    eventName: "JourneyCreated",
    args: { journeyId: emittedJourneyId, learner: owner },
  });
  return {
    blockHash: `0x${"41".repeat(32)}`,
    blockNumber: 42n,
    contractAddress: null,
    cumulativeGasUsed: 100_000n,
    effectiveGasPrice: 1n,
    from: owner,
    gasUsed: 100_000n,
    logs: [
      {
        address: registryAddress,
        blockHash: `0x${"41".repeat(32)}`,
        blockNumber: 42n,
        data: encodeAbiParameters(
          [
            { type: "bytes32" },
            { type: "bytes32" },
            { type: "bytes32" },
            { type: "uint16" },
          ],
          [sourceHash, goalHash, manifestRoot, 3],
        ),
        logIndex: 0,
        removed: false,
        topics,
        transactionHash: txHash,
        transactionIndex: 0,
      },
    ],
    logsBloom: `0x${"00".repeat(256)}`,
    status: overrides?.status ?? "success",
    to: registryAddress,
    transactionHash: txHash,
    transactionIndex: 0,
    type: "eip1559",
  } as unknown as TransactionReceipt;
}

function client(transactionReceipt: TransactionReceipt): MonadReceiptClient {
  return {
    async getChainId() {
      return 10143;
    },
    async waitForTransactionReceipt() {
      return transactionReceipt;
    },
  };
}

describe("JourneyCreated receipt verification", () => {
  it("marks the database only after every event field matches", async () => {
    const store = new MemoryJourneyStore(storedJourney());
    const result = await confirmCreateJourneyTransaction(
      journeyId,
      owner,
      txHash,
      store,
      client(receipt()),
    );
    expect(store.marked).toBe(true);
    expect(store.recorded).toBe(true);
    expect(result).toEqual({ journeyId, status: "CREATED", blockNumber: "42" });
  });

  it("rejects a successful receipt for another Journey", async () => {
    const store = new MemoryJourneyStore(storedJourney());
    await expect(
      confirmCreateJourneyTransaction(
        journeyId,
        owner,
        txHash,
        store,
        client(receipt({ emittedJourneyId: `0x${"99".repeat(32)}` })),
      ),
    ).rejects.toMatchObject({ code: "event_mismatch" });
    expect(store.marked).toBe(false);
  });

  it("does not reveal a Journey owned by another wallet", async () => {
    const store = new MemoryJourneyStore(storedJourney());
    await expect(
      confirmCreateJourneyTransaction(
        journeyId,
        `0x${"dd".repeat(20)}`,
        txHash,
        store,
        client(receipt()),
      ),
    ).rejects.toMatchObject({ status: 404, code: "journey_not_found" });
  });
});
