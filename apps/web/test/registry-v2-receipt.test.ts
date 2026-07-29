import {
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { learningProjectRegistryV2Abi } from "@mindmark/shared";
import { resetServerEnvironmentForTests } from "@/lib/server/config";
import {
  confirmCreateProjectTransaction,
  type ProjectRegistryV2Store,
} from "@/lib/server/registry-v2";

const projectId = `0x${"51".repeat(32)}` as Hex;
const owner = `0x${"aa".repeat(20)}` as `0x${string}`;
const registryAddress = `0x${"bb".repeat(20)}` as `0x${string}`;
const txHash = `0x${"cc".repeat(32)}` as Hex;
const sourceHash = `0x${"61".repeat(32)}` as Hex;
const goalHash = `0x${"62".repeat(32)}` as Hex;
const outlineHash = `0x${"63".repeat(32)}` as Hex;
const manifestRoot = `0x${"64".repeat(32)}` as Hex;

beforeAll(() => {
  process.env.MONAD_RPC_URL = "http://127.0.0.1:8545";
  process.env.MONAD_CHAIN_ID = "10143";
  process.env.REGISTRY_V2_ADDRESS = registryAddress;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-for-tests-only";
  process.env.SESSION_SECRET = "session-secret-for-tests-only-32-bytes";
  resetServerEnvironmentForTests();
});

function storedProject() {
  return {
    project_id: projectId,
    owner_address: owner,
    source_hash: sourceHash,
    goal_hash: goalHash,
    outline_hash: outlineHash,
    work_unit_manifest_root: manifestRoot,
    outline_version: 1,
    status: "AWAITING_REGISTRY",
    create_tx_hash: null,
    chapter_count: 2,
    work_unit_count: 3,
  };
}

class MemoryProjectStore implements ProjectRegistryV2Store {
  marked = false;
  recorded = false;

  constructor(private readonly project: ReturnType<typeof storedProject> | null = storedProject()) {}

  async findOwned(id: Hex, address: `0x${string}`) {
    return this.project?.project_id === id && this.project.owner_address === address
      ? this.project
      : null;
  }

  async recordCreateTransaction(id: Hex, address: `0x${string}`, hash: Hex) {
    expect([id, address, hash]).toEqual([projectId, owner, txHash]);
    this.recorded = true;
  }

  async markCreated(id: Hex, address: `0x${string}`, hash: Hex) {
    expect([id, address, hash]).toEqual([projectId, owner, txHash]);
    this.marked = true;
  }
}

function receipt(overrides: { emittedProjectId?: Hex; chapterCount?: number } = {}) {
  const topics = encodeEventTopics({
    abi: learningProjectRegistryV2Abi,
    eventName: "ProjectCreated",
    args: { projectId: overrides.emittedProjectId ?? projectId, learner: owner },
  });
  return {
    blockHash: `0x${"71".repeat(32)}`,
    blockNumber: 88n,
    contractAddress: null,
    cumulativeGasUsed: 100_000n,
    effectiveGasPrice: 1n,
    from: owner,
    gasUsed: 100_000n,
    logs: [{
      address: registryAddress,
      blockHash: `0x${"71".repeat(32)}`,
      blockNumber: 88n,
      data: encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "uint16" },
          { type: "uint16" },
        ],
        [sourceHash, outlineHash, overrides.chapterCount ?? 2, 3],
      ),
      logIndex: 0,
      removed: false,
      topics,
      transactionHash: txHash,
      transactionIndex: 0,
    }],
    logsBloom: `0x${"00".repeat(256)}`,
    status: "success",
    to: registryAddress,
    transactionHash: txHash,
    transactionIndex: 0,
    type: "eip1559",
  } as unknown as TransactionReceipt;
}

const client = (transactionReceipt: TransactionReceipt) => ({
  async getChainId() { return 10143; },
  async waitForTransactionReceipt() { return transactionReceipt; },
});

describe("ProjectCreated V2 receipt verification", () => {
  it("marks the Project generating only after all committed fields match", async () => {
    const store = new MemoryProjectStore();
    await expect(
      confirmCreateProjectTransaction(projectId, owner, txHash, store, client(receipt())),
    ).resolves.toEqual({ projectId, status: "CREATED", blockNumber: "88" });
    expect(store.recorded).toBe(true);
    expect(store.marked).toBe(true);
  });

  it("rejects another Project or a different confirmed outline shape", async () => {
    const wrongIdStore = new MemoryProjectStore();
    await expect(
      confirmCreateProjectTransaction(
        projectId,
        owner,
        txHash,
        wrongIdStore,
        client(receipt({ emittedProjectId: `0x${"99".repeat(32)}` })),
      ),
    ).rejects.toMatchObject({ code: "event_mismatch" });
    expect(wrongIdStore.marked).toBe(false);

    await expect(
      confirmCreateProjectTransaction(
        projectId,
        owner,
        txHash,
        new MemoryProjectStore(),
        client(receipt({ chapterCount: 3 })),
      ),
    ).rejects.toMatchObject({ code: "event_mismatch" });
  });

  it("does not reveal a Project owned by another wallet", async () => {
    await expect(
      confirmCreateProjectTransaction(
        projectId,
        `0x${"dd".repeat(20)}`,
        txHash,
        new MemoryProjectStore(),
        client(receipt()),
      ),
    ).rejects.toMatchObject({ status: 404, code: "project_not_found" });
  });
});
