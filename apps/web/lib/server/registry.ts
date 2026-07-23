import {
  learningJourneyRegistryAbi,
  SaveCreateTransactionResponseSchema,
  type SaveCreateTransactionResponse,
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
import { SupabaseJourneyStore, type JourneyStore, type StoredJourney } from "./journeys";

export interface MonadReceiptClient {
  getChainId(): Promise<number>;
  waitForTransactionReceipt(input: {
    hash: Hex;
    confirmations: number;
    timeout?: number;
  }): Promise<TransactionReceipt>;
}

function createMonadClient(): MonadReceiptClient {
  const environment = getServerEnvironment();
  const chain = defineChain({
    id: environment.MONAD_CHAIN_ID,
    name: "Monad",
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [environment.MONAD_RPC_URL] } },
  });
  return createPublicClient({ chain, transport: http(environment.MONAD_RPC_URL) });
}

function findJourneyCreatedEvent(
  receipt: TransactionReceipt,
  registryAddress: `0x${string}`,
): {
  journeyId: Hex;
  learner: `0x${string}`;
  sourceHash: Hex;
  goalHash: Hex;
  chunkManifestRoot: Hex;
  chunkCount: number;
} | null {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== registryAddress) continue;
    try {
      const decoded = decodeEventLog({
        abi: learningJourneyRegistryAbi,
        eventName: "JourneyCreated",
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      return {
        journeyId: decoded.args.journeyId,
        learner: decoded.args.learner.toLowerCase() as `0x${string}`,
        sourceHash: decoded.args.sourceHash,
        goalHash: decoded.args.goalHash,
        chunkManifestRoot: decoded.args.chunkManifestRoot,
        chunkCount: decoded.args.chunkCount,
      };
    } catch {
      // Other Registry events in the receipt are irrelevant here.
    }
  }
  return null;
}

function eventMatchesJourney(
  event: NonNullable<ReturnType<typeof findJourneyCreatedEvent>>,
  journey: StoredJourney,
): boolean {
  return (
    event.journeyId === journey.journey_id &&
    event.learner === journey.learner_address &&
    event.sourceHash === journey.source_hash &&
    event.goalHash === journey.goal_hash &&
    event.chunkManifestRoot === journey.chunk_manifest_root &&
    event.chunkCount === journey.chunk_count
  );
}

export async function confirmCreateJourneyTransaction(
  journeyId: Hex,
  owner: `0x${string}`,
  txHash: Hex,
  store: JourneyStore = new SupabaseJourneyStore(),
  client: MonadReceiptClient = createMonadClient(),
): Promise<SaveCreateTransactionResponse> {
  const environment = getServerEnvironment();
  const journey = await store.findOwned(journeyId, owner);
  if (!journey) throw new ApiError(404, "journey_not_found", "Learning project not found");
  if (journey.status === "CREATED" && journey.create_tx_hash === txHash) {
    const receipt = await client.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 1,
      timeout: 60_000,
    });
    return SaveCreateTransactionResponseSchema.parse({
      journeyId,
      status: "CREATED",
      blockNumber: receipt.blockNumber.toString(),
    });
  }
  if (journey.status !== "AWAITING_CREATE_TX") {
    throw new ApiError(409, "invalid_journey_state", "Learning project cannot accept this transaction");
  }
  if (journey.create_tx_hash && journey.create_tx_hash !== txHash) {
    throw new ApiError(
      409,
      "transaction_mismatch",
      "A different create transaction is already recorded",
    );
  }
  if (!journey.create_tx_hash) {
    await store.recordCreateTransaction(journeyId, owner, txHash);
  }

  if ((await client.getChainId()) !== environment.MONAD_CHAIN_ID) {
    throw new ApiError(502, "wrong_rpc_chain", "Monad RPC returned an unexpected chain ID");
  }
  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
    timeout: 60_000,
  });
  if (
    receipt.status !== "success" ||
    receipt.to?.toLowerCase() !== environment.REGISTRY_ADDRESS
  ) {
    throw new ApiError(409, "transaction_failed", "Transaction did not succeed on the Registry");
  }
  const event = findJourneyCreatedEvent(receipt, environment.REGISTRY_ADDRESS);
  if (!event || !eventMatchesJourney(event, journey)) {
    throw new ApiError(409, "event_mismatch", "JourneyCreated does not match prepared data");
  }

  await store.markCreated(journeyId, owner, txHash);
  return SaveCreateTransactionResponseSchema.parse({
    journeyId,
    status: "CREATED",
    blockNumber: receipt.blockNumber.toString(),
  });
}
