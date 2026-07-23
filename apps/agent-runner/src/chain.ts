import { learningJourneyRegistryAbi } from "@mindmark/shared";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  zeroAddress,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type {
  ChainJourneyState,
  ChainReceipt,
  RegistryGateway,
} from "./types.js";

export type ViemRegistryConfiguration = {
  rpcUrl: string;
  chainId: number;
  registryAddress: Address;
  coordinatorPrivateKey: Hex;
  workerPrivateKeys: readonly [Hex, Hex, Hex];
};

export function splitInclusiveBlockRange(
  fromBlock: bigint,
  toBlock: bigint,
  maxBlocks: bigint,
): Array<{ fromBlock: bigint; toBlock: bigint }> {
  if (maxBlocks <= 0n) throw new RangeError("maxBlocks must be positive");
  if (fromBlock > toBlock) return [];

  const ranges: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  for (let start = fromBlock; start <= toBlock; start += maxBlocks) {
    const end = start + maxBlocks - 1n;
    ranges.push({ fromBlock: start, toBlock: end < toBlock ? end : toBlock });
  }
  return ranges;
}

export class ViemRegistryGateway implements RegistryGateway {
  private readonly chain;
  private readonly publicClient;
  private readonly coordinator: PrivateKeyAccount;
  private readonly workers: readonly [PrivateKeyAccount, PrivateKeyAccount, PrivateKeyAccount];
  private readonly coordinatorClient;
  private readonly workerClients;
  private readonly registryAddress: Address;

  constructor(configuration: ViemRegistryConfiguration) {
    this.chain = defineChain({
      id: configuration.chainId,
      name: `Monad ${configuration.chainId}`,
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [configuration.rpcUrl] } },
    });
    this.registryAddress = getAddress(configuration.registryAddress);
    this.coordinator = privateKeyToAccount(configuration.coordinatorPrivateKey);
    this.workers = configuration.workerPrivateKeys.map((key) =>
      privateKeyToAccount(key),
    ) as unknown as readonly [PrivateKeyAccount, PrivateKeyAccount, PrivateKeyAccount];
    this.publicClient = createPublicClient({ chain: this.chain, transport: http(configuration.rpcUrl) });
    this.coordinatorClient = createWalletClient({
      account: this.coordinator,
      chain: this.chain,
      transport: http(configuration.rpcUrl),
    });
    this.workerClients = this.workers.map((account) =>
      createWalletClient({ account, chain: this.chain, transport: http(configuration.rpcUrl) }),
    );
  }

  workerAddress(workerIndex: number): Address {
    const worker = this.workers[workerIndex];
    if (!worker) throw new RangeError(`Unknown Worker index: ${workerIndex}`);
    return worker.address;
  }

  coordinatorAddress(): Address {
    return this.coordinator.address;
  }

  async assertConfiguredWallets(): Promise<void> {
    const configuredCoordinator = await this.publicClient.readContract({
      address: this.registryAddress,
      abi: learningJourneyRegistryAbi,
      functionName: "coordinator",
    });
    if (getAddress(configuredCoordinator) !== getAddress(this.coordinator.address)) {
      throw new Error("Configured Coordinator wallet does not match the Registry contract");
    }
    const allowed = await Promise.all(
      this.workers.map((worker) =>
        this.publicClient.readContract({
          address: this.registryAddress,
          abi: learningJourneyRegistryAbi,
          functionName: "isWorker",
          args: [worker.address],
        }),
      ),
    );
    if (allowed.some((value) => !value)) {
      throw new Error("At least one configured Worker wallet is not allowlisted");
    }
  }

  async readJourney(journeyId: Hex): Promise<ChainJourneyState | null> {
    const value = await this.publicClient.readContract({
      address: this.registryAddress,
      abi: learningJourneyRegistryAbi,
      functionName: "journeys",
      args: [journeyId],
    });
    const deckRoot = value[4];
    const planHash = value[5];
    const totalCardCount = value[7];
    const status = value[8];
    if (status === 0) return null;
    const labels = ["NONE", "CREATED", "READY", "CANCELLED"] as const;
    const label = labels[status];
    if (!label || label === "NONE") throw new Error(`Unknown on-chain Journey status: ${status}`);
    return {
      status: label,
      deckRoot: /^0x0{64}$/u.test(deckRoot) ? null : deckRoot,
      planHash: /^0x0{64}$/u.test(planHash) ? null : planHash,
      totalCardCount,
    };
  }

  async readTransactionStatus(
    txHash: Hex,
  ): Promise<"PENDING" | "SUCCESS" | "REVERTED" | "NOT_FOUND"> {
    try {
      const receipt = await this.publicClient.getTransactionReceipt({ hash: txHash });
      return receipt.status === "success" ? "SUCCESS" : "REVERTED";
    } catch (error) {
      if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
    }
    try {
      await this.publicClient.getTransaction({ hash: txHash });
      return "PENDING";
    } catch (error) {
      if (error instanceof TransactionNotFoundError) return "NOT_FOUND";
      throw error;
    }
  }

  async readChunk(journeyId: Hex, chunkId: number) {
    const value = await this.publicClient.readContract({
      address: this.registryAddress,
      abi: learningJourneyRegistryAbi,
      functionName: "chunks",
      args: [journeyId, chunkId],
    });
    if (value[2] === zeroAddress) return null;
    return {
      sourceChunkHash: value[0],
      cardsRoot: value[1],
      agent: value[2],
      committedBlock: value[3],
      cardCount: value[4],
    };
  }

  async commitChunk(
    workerIndex: number,
    input: {
      journeyId: Hex;
      chunkId: number;
      sourceChunkHash: Hex;
      cardsRoot: Hex;
      cardCount: number;
      manifestProof: Hex[];
    },
    onSubmitted?: (txHash: Hex) => Promise<void>,
  ): Promise<ChainReceipt> {
    const client = this.workerClients[workerIndex];
    if (!client) throw new RangeError(`Unknown Worker index: ${workerIndex}`);
    const startedAt = performance.now();
    const txHash = await client.writeContract({
      address: this.registryAddress,
      abi: learningJourneyRegistryAbi,
      functionName: "commitChunk",
      args: [
        input.journeyId,
        input.chunkId,
        input.sourceChunkHash,
        input.cardsRoot,
        input.cardCount,
        input.manifestProof,
      ],
    });
    await onSubmitted?.(txHash);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error("Chunk commitment transaction reverted");
    return {
      txHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      confirmationMs: Math.round(performance.now() - startedAt),
    };
  }

  async finalizeDeck(input: {
    journeyId: Hex;
    deckRoot: Hex;
    planHash: Hex;
    totalCardCount: number;
  }): Promise<ChainReceipt> {
    const startedAt = performance.now();
    const txHash = await this.coordinatorClient.writeContract({
      address: this.registryAddress,
      abi: learningJourneyRegistryAbi,
      functionName: "finalizeDeck",
      args: [input.journeyId, input.deckRoot, input.planHash, input.totalCardCount],
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error("Deck finalization transaction reverted");
    return {
      txHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      confirmationMs: Math.round(performance.now() - startedAt),
    };
  }

  async getJourneyCreatedIds(fromBlock: bigint): Promise<Hex[]> {
    const latestBlock = await this.publicClient.getBlockNumber();
    const journeyIds: Hex[] = [];
    const ranges = splitInclusiveBlockRange(fromBlock, latestBlock, 100n);
    const concurrentRequests = 8;
    for (let index = 0; index < ranges.length; index += concurrentRequests) {
      const batches = await Promise.all(
        ranges.slice(index, index + concurrentRequests).map((range) =>
          this.publicClient.getContractEvents({
            address: this.registryAddress,
            abi: learningJourneyRegistryAbi,
            eventName: "JourneyCreated",
            fromBlock: range.fromBlock,
            toBlock: range.toBlock,
          }),
        ),
      );
      for (const logs of batches) {
        journeyIds.push(
          ...logs.flatMap((log) => (log.args.journeyId ? [log.args.journeyId] : [])),
        );
      }
    }
    return journeyIds;
  }

  watchJourneyCreated(onJourney: (journeyId: Hex) => void): () => void {
    return this.publicClient.watchContractEvent({
      address: this.registryAddress,
      abi: learningJourneyRegistryAbi,
      eventName: "JourneyCreated",
      onLogs(logs) {
        for (const log of logs) {
          if (log.args.journeyId) onJourney(log.args.journeyId);
        }
      },
    });
  }
}
