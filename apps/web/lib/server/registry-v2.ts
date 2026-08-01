import {
  SaveCreateProjectResponseSchema,
  learningProjectRegistryV2Abi,
  type SaveCreateProjectResponse,
} from "@mindmark/shared";
import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  http,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { getServerEnvironment } from "./config";
import { ApiError } from "./http";
import { getSupabaseAdmin } from "./supabase";

type StoredProjectV2 = {
  project_id: Hex;
  owner_address: `0x${string}`;
  source_hash: Hex;
  goal_hash: Hex;
  outline_hash: Hex;
  work_unit_manifest_root: Hex;
  outline_version: number;
  status: string;
  create_tx_hash: Hex | null;
  chapter_count: number;
  work_unit_count: number;
};

export interface ProjectRegistryV2Store {
  findOwned(projectId: Hex, owner: `0x${string}`): Promise<StoredProjectV2 | null>;
  recordCreateTransaction(projectId: Hex, owner: `0x${string}`, txHash: Hex): Promise<void>;
  markCreated(projectId: Hex, owner: `0x${string}`, txHash: Hex): Promise<void>;
}

export class SupabaseProjectRegistryV2Store implements ProjectRegistryV2Store {
  async findOwned(projectId: Hex, owner: `0x${string}`): Promise<StoredProjectV2 | null> {
    const { data, error } = await getSupabaseAdmin()
      .from("learning_projects")
      .select(
        "project_id,owner_address,source_hash,goal_hash,outline_hash,work_unit_manifest_root,outline_version,status,create_tx_hash,chapters(count),work_units(count)",
      )
      .eq("project_id", projectId)
      .eq("owner_address", owner)
      .maybeSingle();
    if (error) throw new Error(`Could not read Project: ${error.message}`);
    if (!data) return null;
    const row = data as unknown as StoredProjectV2 & {
      chapters: Array<{ count: number }>;
      work_units: Array<{ count: number }>;
    };
    return {
      ...row,
      chapter_count: Number(row.chapters?.[0]?.count ?? 0),
      work_unit_count: Number(row.work_units?.[0]?.count ?? 0),
    };
  }

  async recordCreateTransaction(projectId: Hex, owner: `0x${string}`, txHash: Hex): Promise<void> {
    const { data, error } = await getSupabaseAdmin()
      .from("learning_projects")
      .update({ create_tx_hash: txHash })
      .eq("project_id", projectId)
      .eq("owner_address", owner)
      .eq("status", "AWAITING_REGISTRY")
      .or(`create_tx_hash.is.null,create_tx_hash.eq.${txHash}`)
      .select("project_id");
    if (error) throw new Error(`Could not record Project transaction: ${error.message}`);
    if (!data || data.length !== 1) throw new Error("A different Project transaction is already recorded");
  }

  async markCreated(projectId: Hex, owner: `0x${string}`, txHash: Hex): Promise<void> {
    const { data, error } = await getSupabaseAdmin()
      .from("learning_projects")
      .update({ status: "GENERATING", create_tx_hash: txHash })
      .eq("project_id", projectId)
      .eq("owner_address", owner)
      .in("status", ["AWAITING_REGISTRY", "GENERATING"])
      .or(`create_tx_hash.is.null,create_tx_hash.eq.${txHash}`)
      .select("project_id");
    if (error) throw new Error(`Could not mark Project created: ${error.message}`);
    if (!data || data.length !== 1) throw new Error("Project state changed before confirmation");
  }
}

interface MonadReceiptClientV2 {
  getChainId(): Promise<number>;
  waitForTransactionReceipt(input: {
    hash: Hex;
    confirmations: number;
    timeout?: number;
  }): Promise<TransactionReceipt>;
}

function createMonadClient(): MonadReceiptClientV2 {
  const environment = getServerEnvironment();
  const chain = defineChain({
    id: environment.MONAD_CHAIN_ID,
    name: "Monad",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [environment.MONAD_RPC_URL] } },
  });
  return createPublicClient({ chain, transport: http(environment.MONAD_RPC_URL) });
}

function v2RegistryAddress(): `0x${string}` {
  const environment = getServerEnvironment();
  if (!environment.REGISTRY_V2_ADDRESS) {
    throw new ApiError(503, "registry_v2_unconfigured", "V2 Registry contract is not configured");
  }
  return environment.REGISTRY_V2_ADDRESS;
}

function findProjectCreatedEvent(receipt: TransactionReceipt, registryAddress: `0x${string}`) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== registryAddress) continue;
    try {
      const decoded = decodeEventLog({
        abi: learningProjectRegistryV2Abi,
        eventName: "ProjectCreated",
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      const args = decoded.args;
      return {
        projectId: args.projectId,
        learner: args.learner,
        sourceHash: args.sourceHash,
        outlineHash: args.outlineHash,
        chapterCount: args.chapterCount,
        workUnitCount: args.workUnitCount,
      };
    } catch {
      // Ignore unrelated logs from the same transaction.
    }
  }
  return null;
}

export async function confirmCreateProjectTransaction(
  projectId: Hex,
  owner: `0x${string}`,
  txHash: Hex,
  store: ProjectRegistryV2Store = new SupabaseProjectRegistryV2Store(),
  client: MonadReceiptClientV2 = createMonadClient(),
): Promise<SaveCreateProjectResponse> {
  const environment = getServerEnvironment();
  const project = await store.findOwned(projectId, owner);
  if (!project) throw new ApiError(404, "project_not_found", "Learning Project was not found");
  if (!["AWAITING_REGISTRY", "GENERATING"].includes(project.status)) {
    throw new ApiError(409, "invalid_project_state", "Project cannot accept this transaction");
  }
  if (project.create_tx_hash && project.create_tx_hash !== txHash) {
    throw new ApiError(409, "transaction_mismatch", "A different Project transaction is already recorded");
  }
  if (project.status === "AWAITING_REGISTRY" && !project.create_tx_hash) {
    await store.recordCreateTransaction(projectId, owner, txHash);
  }
  if ((await client.getChainId()) !== environment.MONAD_CHAIN_ID) {
    throw new ApiError(502, "wrong_rpc_chain", "Monad RPC returned an unexpected chain ID");
  }
  const receipt = await client.waitForTransactionReceipt({ hash: txHash, confirmations: 1, timeout: 60_000 });
  const registryAddress = v2RegistryAddress();
  if (receipt.status !== "success" || receipt.to?.toLowerCase() !== registryAddress.toLowerCase()) {
    throw new ApiError(409, "transaction_failed", "Transaction did not succeed on the V2 Registry");
  }
  const event = findProjectCreatedEvent(receipt, registryAddress.toLowerCase() as `0x${string}`);
  if (
    !event ||
    event.projectId !== project.project_id ||
    event.learner.toLowerCase() !== project.owner_address ||
    event.sourceHash !== project.source_hash ||
    event.outlineHash !== project.outline_hash ||
    event.chapterCount !== project.chapter_count ||
    event.workUnitCount !== project.work_unit_count
  ) {
    throw new ApiError(409, "event_mismatch", "ProjectCreated does not match confirmed outline");
  }
  await store.markCreated(projectId, owner, txHash);
  return SaveCreateProjectResponseSchema.parse({ projectId, status: "CREATED", blockNumber: receipt.blockNumber.toString() });
}
