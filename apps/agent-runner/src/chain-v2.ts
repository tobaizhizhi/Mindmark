import { learningProjectRegistryV2Abi } from "@mindmark/shared";
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
import type { ChainReceipt } from "./runtime-types.js";
import type { ProjectRegistryGatewayV2 } from "./types-v2.js";

export type ViemProjectRegistryConfigurationV2 = {
  rpcUrl: string;
  chainId: number;
  registryAddress: Address;
  coordinatorPrivateKey: Hex;
  workerPrivateKeys: readonly [Hex, Hex, Hex];
};

const isZeroHash = (value: Hex) => /^0x0{64}$/u.test(value);

export class ViemProjectRegistryGatewayV2 implements ProjectRegistryGatewayV2 {
  private readonly chain;
  private readonly publicClient;
  private readonly coordinator: PrivateKeyAccount;
  private readonly workers: readonly [PrivateKeyAccount, PrivateKeyAccount, PrivateKeyAccount];
  private readonly coordinatorClient;
  private readonly workerClients;
  private readonly registryAddress: Address;

  constructor(configuration: ViemProjectRegistryConfigurationV2) {
    this.chain = defineChain({
      id: configuration.chainId,
      name: `Monad ${configuration.chainId}`,
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [configuration.rpcUrl] } },
    });
    this.registryAddress = getAddress(configuration.registryAddress);
    this.coordinator = privateKeyToAccount(configuration.coordinatorPrivateKey);
    this.workers = configuration.workerPrivateKeys.map((key) => privateKeyToAccount(key)) as unknown as readonly [PrivateKeyAccount, PrivateKeyAccount, PrivateKeyAccount];
    this.publicClient = createPublicClient({ chain: this.chain, transport: http(configuration.rpcUrl) });
    this.coordinatorClient = createWalletClient({ account: this.coordinator, chain: this.chain, transport: http(configuration.rpcUrl) });
    this.workerClients = this.workers.map((account) => createWalletClient({ account, chain: this.chain, transport: http(configuration.rpcUrl) }));
  }

  workerAddress(workerIndex: number): Address {
    const worker = this.workers[workerIndex];
    if (!worker) throw new RangeError(`Unknown V2 Worker index: ${workerIndex}`);
    return worker.address;
  }

  coordinatorAddress(): Address {
    return this.coordinator.address;
  }

  async assertConfiguredWallets(): Promise<void> {
    const configured = await this.publicClient.readContract({
      address: this.registryAddress,
      abi: learningProjectRegistryV2Abi,
      functionName: "coordinator",
    });
    if (getAddress(configured) !== getAddress(this.coordinator.address)) {
      throw new Error("Configured V2 Coordinator wallet does not match the Registry");
    }
    const allowed = await Promise.all(this.workers.map((worker) => this.publicClient.readContract({
      address: this.registryAddress,
      abi: learningProjectRegistryV2Abi,
      functionName: "isWorker",
      args: [worker.address],
    })));
    if (allowed.some((value) => !value)) throw new Error("A configured V2 Worker is not allowlisted");
  }

  async readTransactionStatus(txHash: Hex): Promise<"PENDING" | "SUCCESS" | "REVERTED" | "NOT_FOUND"> {
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

  async readProject(projectId: Hex) {
    const value = await this.publicClient.readContract({
      address: this.registryAddress,
      abi: learningProjectRegistryV2Abi,
      functionName: "projects",
      args: [projectId],
    });
    if (value[10] === 0) return null;
    const status = (["NONE", "CREATED", "READY", "CANCELLED"] as const)[value[10]];
    if (!status || status === "NONE") throw new Error(`Unknown on-chain Project status: ${value[10]}`);
    return {
      learner: value[0],
      sourceHash: value[1],
      goalHash: value[2],
      outlineHash: value[3],
      workUnitManifestRoot: value[4],
      status,
      projectDeckRoot: isZeroHash(value[5]) ? null : value[5],
      initialPlanHash: isZeroHash(value[6]) ? null : value[6],
      chapterCount: value[7],
      workUnitCount: value[8],
      totalCardCount: value[9],
    };
  }

  async readChapter(projectId: Hex, chapterId: number) {
    const value = await this.publicClient.readContract({
      address: this.registryAddress,
      abi: learningProjectRegistryV2Abi,
      functionName: "chapters",
      args: [projectId, chapterId],
    });
    if (value[5] === 0) return null;
    const status = (["NONE", "OPEN", "READY"] as const)[value[5]];
    if (!status || status === "NONE") throw new Error(`Unknown on-chain Chapter status: ${value[5]}`);
    return {
      sourceHash: value[0],
      cardsRoot: isZeroHash(value[1]) ? null : value[1],
      firstWorkUnitId: value[2],
      workUnitCount: value[3],
      cardCount: value[4],
      status,
    };
  }

  async readWorkUnit(projectId: Hex, workUnitId: number) {
    const value = await this.publicClient.readContract({
      address: this.registryAddress,
      abi: learningProjectRegistryV2Abi,
      functionName: "workUnits",
      args: [projectId, workUnitId],
    });
    if (value[3] === zeroAddress) return null;
    return {
      chapterId: value[0],
      sourceUnitHash: value[1],
      cardsRoot: value[2],
      worker: value[3],
      committedBlock: value[4],
      cardCount: value[5],
    };
  }

  async commitWorkUnit(workerIndex: number, input: Parameters<ProjectRegistryGatewayV2["commitWorkUnit"]>[1], onSubmitted?: (txHash: Hex) => Promise<void>): Promise<ChainReceipt> {
    const client = this.workerClients[workerIndex];
    if (!client) throw new RangeError(`Unknown V2 Worker index: ${workerIndex}`);
    const startedAt = performance.now();
    const txHash = await client.writeContract({
      address: this.registryAddress,
      abi: learningProjectRegistryV2Abi,
      functionName: "commitWorkUnit",
      args: [input.projectId, input.workUnitId, input.chapterId, input.sourceUnitHash, input.cardsRoot, input.cardCount, input.manifestProof],
    });
    await onSubmitted?.(txHash);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error("Work Unit commitment transaction reverted");
    return { txHash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, confirmationMs: Math.round(performance.now() - startedAt) };
  }

  async finalizeChapter(input: Parameters<ProjectRegistryGatewayV2["finalizeChapter"]>[0]): Promise<ChainReceipt> {
    const startedAt = performance.now();
    const txHash = await this.coordinatorClient.writeContract({
      address: this.registryAddress,
      abi: learningProjectRegistryV2Abi,
      functionName: "finalizeChapter",
      args: [input.projectId, input.chapterId, input.cardsRoot, input.cardCount],
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error("Chapter finalization transaction reverted");
    return { txHash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, confirmationMs: Math.round(performance.now() - startedAt) };
  }

  async finalizeProject(input: Parameters<ProjectRegistryGatewayV2["finalizeProject"]>[0]): Promise<ChainReceipt> {
    const startedAt = performance.now();
    const txHash = await this.coordinatorClient.writeContract({
      address: this.registryAddress,
      abi: learningProjectRegistryV2Abi,
      functionName: "finalizeProject",
      args: [input.projectId, input.projectDeckRoot, input.initialPlanHash, input.totalCardCount],
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error("Project finalization transaction reverted");
    return { txHash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, confirmationMs: Math.round(performance.now() - startedAt) };
  }
}
