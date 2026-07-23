import { learningJourneyRegistryAbi } from "@mindmark/shared";
import {
  createPublicClient,
  decodeEventLog,
  defineChain,
  getAddress,
  http,
  type Hex,
} from "viem";
import { getServerEnvironment } from "./config";
import { ApiError } from "./http";
import { getSupabaseAdmin } from "./supabase";
import type { StoredJourney } from "./journeys";

const cancellableStatuses = new Set([
  "CREATED",
  "GENERATING",
  "FINALIZING",
  "FAILED_RETRYABLE",
]);

export interface JourneyDeletionStore {
  findOwned(journeyId: Hex, owner: `0x${string}`): Promise<StoredJourney | null>;
  deleteOwned(journeyId: Hex, owner: `0x${string}`): Promise<boolean>;
}

export interface JourneyCancellationGateway {
  ensureStopped(
    journeyId: Hex,
    owner: `0x${string}`,
    cancellationTxHash?: Hex,
  ): Promise<void>;
}

export class SupabaseJourneyDeletionStore implements JourneyDeletionStore {
  async findOwned(journeyId: Hex, owner: `0x${string}`): Promise<StoredJourney | null> {
    const { data, error } = await getSupabaseAdmin()
      .from("learning_journeys")
      .select(
        "journey_id,learner_address,source_hash,goal_hash,chunk_manifest_root,chunk_count,status,create_tx_hash",
      )
      .eq("journey_id", journeyId)
      .eq("learner_address", owner)
      .maybeSingle();
    if (error) throw new Error(`Could not read learning project for deletion: ${error.message}`);
    return data as StoredJourney | null;
  }

  async deleteOwned(journeyId: Hex, owner: `0x${string}`): Promise<boolean> {
    const { data, error } = await getSupabaseAdmin()
      .from("learning_journeys")
      .delete()
      .eq("journey_id", journeyId)
      .eq("learner_address", owner)
      .select("journey_id");
    if (error) throw new Error(`Could not delete learning project: ${error.message}`);
    return data?.length === 1;
  }
}

function createMonadPublicClient() {
  const environment = getServerEnvironment();
  const chain = defineChain({
    id: environment.MONAD_CHAIN_ID,
    name: "Monad",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [environment.MONAD_RPC_URL] } },
  });
  return createPublicClient({ chain, transport: http(environment.MONAD_RPC_URL) });
}

export class MonadJourneyCancellationGateway implements JourneyCancellationGateway {
  async ensureStopped(
    journeyId: Hex,
    owner: `0x${string}`,
    cancellationTxHash?: Hex,
  ): Promise<void> {
    const environment = getServerEnvironment();
    const client = createMonadPublicClient();
    if (cancellationTxHash) {
      const receipt = await client.waitForTransactionReceipt({
        hash: cancellationTxHash,
        confirmations: 1,
        timeout: 60_000,
      });
      if (
        receipt.status !== "success" ||
        receipt.to?.toLowerCase() !== environment.REGISTRY_ADDRESS
      ) {
        throw new ApiError(409, "cancellation_failed", "Monad cancellation transaction failed");
      }
      const cancellationEvent = receipt.logs.some((log) => {
        if (log.address.toLowerCase() !== environment.REGISTRY_ADDRESS) return false;
        try {
          const decoded = decodeEventLog({
            abi: learningJourneyRegistryAbi,
            eventName: "JourneyCancelled",
            data: log.data,
            topics: log.topics,
            strict: true,
          });
          return (
            decoded.args.journeyId === journeyId &&
            decoded.args.learner.toLowerCase() === owner
          );
        } catch {
          return false;
        }
      });
      if (!cancellationEvent) {
        throw new ApiError(409, "cancellation_event_mismatch", "JourneyCancelled event is missing");
      }
      return;
    }

    if ((await client.getChainId()) !== environment.MONAD_CHAIN_ID) {
      throw new ApiError(502, "wrong_rpc_chain", "Monad RPC returned an unexpected chain ID");
    }
    const journey = await client.readContract({
      address: environment.REGISTRY_ADDRESS,
      abi: learningJourneyRegistryAbi,
      functionName: "journeys",
      args: [journeyId],
    });
    const learner = getAddress(journey[0]).toLowerCase() as `0x${string}`;
    const status = Number(journey[8]);
    if (learner !== owner) {
      throw new ApiError(403, "journey_owner_mismatch", "Monad Journey belongs to another wallet");
    }
    if (status === 3 || status === 2) return;
    if (status !== 1) {
      throw new ApiError(409, "invalid_chain_state", "Monad Journey is not cancellable");
    }
    throw new ApiError(
      409,
      "chain_cancellation_required",
      "Cancel the active Monad Journey before deleting its learning data",
    );
  }
}

export async function deleteJourneyForOwner(
  journeyId: Hex,
  owner: `0x${string}`,
  cancellationTxHash?: Hex,
  store: JourneyDeletionStore = new SupabaseJourneyDeletionStore(),
  gateway: JourneyCancellationGateway = new MonadJourneyCancellationGateway(),
): Promise<{ deleted: true; journeyId: Hex; chainRecordRetained: boolean }> {
  const journey = await store.findOwned(journeyId, owner);
  if (!journey) throw new ApiError(404, "journey_not_found", "Learning project not found");

  if (cancellableStatuses.has(journey.status)) {
    await gateway.ensureStopped(journeyId, owner, cancellationTxHash);
  }
  if (journey.status === "AWAITING_CREATE_TX" && journey.create_tx_hash) {
    throw new ApiError(
      409,
      "creation_transaction_pending",
      "The Monad creation transaction is still recorded; wait for confirmation before deleting",
    );
  }

  if (!(await store.deleteOwned(journeyId, owner))) {
    throw new ApiError(409, "delete_conflict", "Learning project changed before deletion");
  }
  return {
    deleted: true,
    journeyId,
    chainRecordRetained: Boolean(journey.create_tx_hash),
  };
}
