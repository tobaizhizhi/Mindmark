import { Registry, createRuntime } from "@themoss/core";
import { createTraceSimulator } from "@themoss/simulator";
import { hashWorkUnitPricingV1, learningProjectEscrowAbi } from "@mindmark/shared";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseEventLogs,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  zeroAddress,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createMindmarkEscrowManifest,
  verifyMossEscrowReleasePlan,
  verifyMossEscrowReleaseSimulation,
} from "./moss-project-escrow.js";
import { WorkerRewardVerificationError } from "./reward-error.js";
import type {
  MossRewardStage,
  PreparedWorkerReward,
  ProjectEscrowFunding,
  ProjectSponsorGateway,
  WorkerRewardGateway,
  WorkerRewardReceipt,
} from "./runtime-types.js";

export type MossRewardGatewayConfiguration = {
  rpcUrl: string;
  chainId: number;
  registryAddress: Address;
  escrowAddress: Address;
  treasuryPrivateKey: Hex;
};

// Testnet has an earlier fixed-price Escrow deployment. Its getter and funding
// entrypoint differ from the per-Work-Unit pricing contract used by Mainnet.
const legacyLearningProjectEscrowAbi = parseAbi([
  "function projectEscrows(bytes32 projectId) view returns (address sponsor, uint128 rewardPerWorkUnit, uint128 remainingBudget, uint16 workUnitCount, uint16 settledWorkUnitCount, uint64 fundedBlock, bool refunded)",
  "function fundProject(bytes32 projectId, uint256 rewardPerWorkUnit) payable",
  "event ProjectFunded(bytes32 indexed projectId, address indexed sponsor, uint256 rewardPerWorkUnit, uint16 workUnitCount, uint256 totalBudget)",
]);

function sameAddress(left: string, right: string): boolean {
  return getAddress(left) === getAddress(right);
}

function releaseData(projectId: Hex, workUnitId: number): Hex {
  return encodeFunctionData({
    abi: learningProjectEscrowAbi,
    functionName: "releaseReward",
    args: [projectId, workUnitId],
  });
}

export class MossViemRewardGateway implements WorkerRewardGateway, ProjectSponsorGateway {
  private readonly runtime;
  private readonly registry;
  private readonly publicClient;
  private readonly walletClient;
  private readonly account: PrivateKeyAccount;
  private readonly chain;
  private readonly projectEscrowAddress: Address;

  constructor(private readonly configuration: MossRewardGatewayConfiguration) {
    this.chain = defineChain({
      id: configuration.chainId,
      name: `Monad ${configuration.chainId}`,
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [configuration.rpcUrl] } },
    });
    this.runtime = createRuntime({ rpcUrl: configuration.rpcUrl, chainId: configuration.chainId });
    this.projectEscrowAddress = getAddress(configuration.escrowAddress);
    this.registry = new Registry(this.runtime);
    this.registry.use(createMindmarkEscrowManifest(this.projectEscrowAddress));
    this.account = privateKeyToAccount(configuration.treasuryPrivateKey);
    this.publicClient = createPublicClient({ chain: this.chain, transport: http(configuration.rpcUrl) });
    this.walletClient = createWalletClient({
      account: this.account,
      chain: this.chain,
      transport: http(configuration.rpcUrl),
    });
  }

  treasuryAddress(): Address {
    return this.account.address;
  }

  sponsorAddress(): Address {
    return this.account.address;
  }

  escrowAddress(): Address {
    return this.projectEscrowAddress;
  }

  async assertConfiguredEscrow(registryAddress: Address): Promise<void> {
    const [rpcChainId, configuredRegistry] = await Promise.all([
      this.publicClient.getChainId(),
      this.publicClient.readContract({
        address: this.projectEscrowAddress,
        abi: learningProjectEscrowAbi,
        functionName: "registry",
      }),
    ]);
    if (rpcChainId !== this.configuration.chainId) {
      throw new WorkerRewardVerificationError(
        `Reward RPC chain ${rpcChainId} does not match configured chain ${this.configuration.chainId}`,
      );
    }
    if (!sameAddress(configuredRegistry, registryAddress)
      || !sameAddress(configuredRegistry, this.configuration.registryAddress)) {
      throw new WorkerRewardVerificationError("Project Escrow is attached to another Learning Registry");
    }
  }

  async ensureProjectFunded(input: {
    projectId: Hex;
    quotes: ProjectEscrowFunding["quotes"];
    legacyRewardPerWorkUnitWei: bigint;
  }): Promise<ProjectEscrowFunding> {
    const quotes = [...input.quotes].sort((left, right) => left.workUnitId - right.workUnitId);
    const workUnitCount = quotes.length;
    if (workUnitCount <= 0 || workUnitCount > 48 || quotes.some((quote, index) => quote.workUnitId !== index)) {
      throw new WorkerRewardVerificationError("Project Escrow Work Unit count is invalid");
    }
    const rewardAmountsWei = quotes.map((quote) => quote.rewardAmountWei);
    if (rewardAmountsWei.some((amount) => amount <= 0n)) {
      throw new WorkerRewardVerificationError("Project Escrow reward must be positive");
    }
    if (input.legacyRewardPerWorkUnitWei <= 0n) {
      throw new WorkerRewardVerificationError("Legacy Project Escrow reward must be positive");
    }
    const dynamicTotalBudgetWei = rewardAmountsWei.reduce((total, amount) => total + amount, 0n);
    const pricingRoot = hashWorkUnitPricingV1(input.projectId, rewardAmountsWei);
    let state = await this.readProjectEscrow(input.projectId);
    const totalBudgetWei = state.pricingMode === "LEGACY_FIXED"
      ? input.legacyRewardPerWorkUnitWei * BigInt(workUnitCount)
      : dynamicTotalBudgetWei;
    let fundingTxHash: Hex;
    let fundedBlock: bigint;
    if (state.sponsor === zeroAddress) {
      const balance = await this.publicClient.getBalance({ address: this.account.address });
      if (balance <= totalBudgetWei) {
        throw new Error("Sponsor Treasury balance cannot fund the Project budget and transaction fee");
      }
      fundingTxHash = state.pricingMode === "LEGACY_FIXED"
        ? await this.walletClient.writeContract({
            account: this.account,
            address: this.projectEscrowAddress,
            abi: legacyLearningProjectEscrowAbi,
            functionName: "fundProject",
            args: [input.projectId, input.legacyRewardPerWorkUnitWei],
            value: totalBudgetWei,
          })
        : await this.walletClient.writeContract({
            account: this.account,
            address: this.projectEscrowAddress,
            abi: learningProjectEscrowAbi,
            functionName: "fundProject",
            args: [input.projectId, rewardAmountsWei],
            value: totalBudgetWei,
          });
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: fundingTxHash });
      if (receipt.status !== "success") throw new Error("Project Escrow funding transaction reverted");
      fundedBlock = receipt.blockNumber;
      state = await this.readProjectEscrow(input.projectId);
    } else {
      fundedBlock = state.fundedBlock;
      const fundingLog = state.pricingMode === "LEGACY_FIXED"
        ? (await this.publicClient.getContractEvents({
            address: this.projectEscrowAddress,
            abi: legacyLearningProjectEscrowAbi,
            eventName: "ProjectFunded",
            args: { projectId: input.projectId },
            fromBlock: fundedBlock,
            toBlock: fundedBlock,
          })).find((log) =>
            typeof log.args.sponsor === "string"
            && sameAddress(log.args.sponsor, state.sponsor)
            && log.args.rewardPerWorkUnit === input.legacyRewardPerWorkUnitWei
            && Number(log.args.workUnitCount) === workUnitCount
            && log.args.totalBudget === totalBudgetWei)
        : (await this.publicClient.getContractEvents({
            address: this.projectEscrowAddress,
            abi: learningProjectEscrowAbi,
            eventName: "ProjectFunded",
            args: { projectId: input.projectId },
            fromBlock: fundedBlock,
            toBlock: fundedBlock,
          })).find((log) =>
            typeof log.args.sponsor === "string"
            && sameAddress(log.args.sponsor, state.sponsor)
            && log.args.pricingRoot === pricingRoot
            && Number(log.args.workUnitCount) === workUnitCount
            && log.args.totalBudget === totalBudgetWei);
      if (!fundingLog) throw new WorkerRewardVerificationError("Project Escrow funding event is missing");
      fundingTxHash = fundingLog.transactionHash;
    }
    const frozenAmountsWei = state.pricingMode === "DYNAMIC"
      ? await Promise.all(rewardAmountsWei.map((_, workUnitId) =>
          this.publicClient.readContract({
            address: this.projectEscrowAddress,
            abi: learningProjectEscrowAbi,
            functionName: "workUnitRewardAmounts",
            args: [input.projectId, workUnitId],
          })))
      : [];
    if (
      !sameAddress(state.sponsor, this.account.address)
      || state.totalBudgetWei !== totalBudgetWei
      || state.workUnitCount !== workUnitCount
      || state.refunded
      || state.remainingBudgetWei !== totalBudgetWei
      || state.settledWorkUnitCount !== 0
      || (state.pricingMode === "DYNAMIC" && (
        state.pricingRoot !== pricingRoot
        || frozenAmountsWei.some((amount, index) => amount !== rewardAmountsWei[index])
      ))
      || (state.pricingMode === "LEGACY_FIXED"
        && state.rewardPerWorkUnitWei !== input.legacyRewardPerWorkUnitWei)
    ) {
      throw new WorkerRewardVerificationError("Project Escrow funding does not match the frozen Project design");
    }
    return {
      projectId: input.projectId,
      escrowAddress: this.projectEscrowAddress,
      sponsorAddress: state.sponsor,
      pricingMode: state.pricingMode,
      pricingRoot: state.pricingMode === "DYNAMIC" ? pricingRoot : null,
      rewardPerWorkUnitWei: state.pricingMode === "LEGACY_FIXED"
        ? input.legacyRewardPerWorkUnitWei
        : null,
      quotes,
      totalBudgetWei,
      remainingBudgetWei: state.remainingBudgetWei,
      workUnitCount,
      settledWorkUnitCount: state.settledWorkUnitCount,
      fundingTxHash,
      fundedBlock,
    };
  }

  async prepare(
    input: {
      projectId: Hex;
      workUnitId: number;
      recipientAddress: Address;
      amountWei: bigint;
    },
    onStage?: (stage: Exclude<MossRewardStage, "PENDING" | "SIMULATED">) => Promise<void>,
  ): Promise<PreparedWorkerReward> {
    if (input.amountWei <= 0n) throw new WorkerRewardVerificationError("Worker reward amount must be positive");
    const recipient = getAddress(input.recipientAddress);
    const treasury = this.account.address;
    const [rpcChainId, balance, escrow, alreadyReleased] = await Promise.all([
      this.publicClient.getChainId(),
      this.publicClient.getBalance({ address: treasury }),
      this.readProjectEscrow(input.projectId),
      this.publicClient.readContract({
        address: this.projectEscrowAddress,
        abi: learningProjectEscrowAbi,
        functionName: "rewardReleased",
        args: [input.projectId, input.workUnitId],
      }),
    ]);
    const frozenRewardAmount = escrow.pricingMode === "LEGACY_FIXED"
      ? escrow.rewardPerWorkUnitWei
      : await this.publicClient.readContract({
          address: this.projectEscrowAddress,
          abi: learningProjectEscrowAbi,
          functionName: "workUnitRewardAmounts",
          args: [input.projectId, input.workUnitId],
        });
    if (rpcChainId !== this.configuration.chainId) {
      throw new WorkerRewardVerificationError(
        `Reward RPC chain ${rpcChainId} does not match configured chain ${this.configuration.chainId}`,
      );
    }
    if (
      !sameAddress(escrow.sponsor, treasury)
      || frozenRewardAmount !== input.amountWei
      || escrow.remainingBudgetWei < input.amountWei
      || escrow.refunded
    ) {
      throw new WorkerRewardVerificationError("Worker reward is not covered by the Project Escrow");
    }
    if (alreadyReleased) throw new WorkerRewardVerificationError("Work Unit reward is already released on Monad");

    const coordinates = this.registry.discover({
      verb: "transfer",
      category: "rewards",
      protocol: "mindmark-escrow",
    });
    if (!coordinates.some((item) => item.method === "releaseWorkUnitReward")) {
      throw new WorkerRewardVerificationError("Moss did not discover the Mindmark Escrow Capability");
    }
    await onStage?.("DISCOVERED");
    const [stub] = this.registry.load([{
      protocol: "mindmark-escrow",
      method: "releaseWorkUnitReward",
    }]);
    if (
      !stub
      || stub.kind !== "capability"
      || stub.verb !== "transfer"
      || stub.category !== "rewards"
      || !stub.risk.includes("fundOut")
    ) {
      throw new WorkerRewardVerificationError("Moss loaded an unexpected Escrow Capability");
    }
    await onStage?.("LOADED");
    const action = await this.registry.action(
      "mindmark-escrow",
      "releaseWorkUnitReward",
      treasury,
      { projectId: input.projectId, workUnitId: input.workUnitId },
    );
    if (action.kind !== "plan") throw new WorkerRewardVerificationError("Moss did not produce an Escrow Plan");
    verifyMossEscrowReleasePlan(action, {
      chainId: this.configuration.chainId,
      sponsor: treasury,
      escrowAddress: this.projectEscrowAddress,
      projectId: input.projectId,
      workUnitId: input.workUnitId,
    });
    await onStage?.("BUILT");

    const simulator = createTraceSimulator(this.runtime, {
      prefundWei: balance,
      observer: this.registry.observer(),
    });
    const outcome = await simulator.simulate([action]);
    const simulationGas = verifyMossEscrowReleaseSimulation(action, outcome, {
      projectId: input.projectId,
      workUnitId: input.workUnitId,
      recipient,
      amountWei: input.amountWei,
    });
    const tx = action.txs[0]!;
    const request = await this.walletClient.prepareTransactionRequest({
      account: this.account,
      to: tx.to,
      data: tx.data,
      value: 0n,
    });
    const maximumFee = request.maxFeePerGas ?? request.gasPrice ?? 0n;
    const maximumCost = (request.gas ?? 0n) * maximumFee;
    if (balance < maximumCost) throw new Error("Sponsor Treasury balance cannot cover the release transaction fee");
    const signedTransaction = await this.walletClient.signTransaction(request);
    return {
      projectId: input.projectId,
      workUnitId: input.workUnitId,
      treasuryAddress: treasury,
      recipientAddress: recipient,
      amountWei: input.amountWei,
      mossPlanHash: action.planHash,
      simulationWarningCodes: [],
      simulationGas,
      signedTransaction,
      treasuryNonce: BigInt(request.nonce),
      txHash: keccak256(signedTransaction),
    };
  }

  async settlePrepared(
    input: PreparedWorkerReward,
    onSubmitted?: (txHash: Hex) => Promise<void>,
  ): Promise<WorkerRewardReceipt> {
    if (keccak256(input.signedTransaction) !== input.txHash) {
      throw new WorkerRewardVerificationError("Persisted reward transaction hash is invalid");
    }
    const expectedData = releaseData(input.projectId, input.workUnitId);
    const parsed = parseTransaction(input.signedTransaction);
    const signer = await recoverTransactionAddress({ serializedTransaction: input.signedTransaction });
    if (
      !sameAddress(signer, input.treasuryAddress)
      || !parsed.to
      || !sameAddress(parsed.to, this.projectEscrowAddress)
      || (parsed.value ?? 0n) !== 0n
      || (parsed.data ?? "0x") !== expectedData
      || parsed.nonce === undefined
      || BigInt(parsed.nonce) !== input.treasuryNonce
      || parsed.chainId !== this.configuration.chainId
    ) {
      throw new WorkerRewardVerificationError("Persisted signed Escrow transaction does not match reward intent");
    }
    const startedAt = performance.now();
    let receipt;
    try {
      receipt = await this.publicClient.getTransactionReceipt({ hash: input.txHash });
    } catch (error) {
      if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
    }
    if (!receipt) {
      let isKnown = true;
      try {
        await this.publicClient.getTransaction({ hash: input.txHash });
      } catch (error) {
        if (!(error instanceof TransactionNotFoundError)) throw error;
        isKnown = false;
      }
      if (!isKnown) {
        const submittedHash = await this.publicClient.sendRawTransaction({
          serializedTransaction: input.signedTransaction,
        });
        if (submittedHash !== input.txHash) {
          throw new WorkerRewardVerificationError("RPC returned a different reward transaction hash");
        }
      }
      await onSubmitted?.(input.txHash);
      receipt = await this.publicClient.waitForTransactionReceipt({ hash: input.txHash });
    }
    if (receipt.status !== "success") throw new WorkerRewardVerificationError("Escrow reward transaction reverted");
    const transaction = await this.publicClient.getTransaction({ hash: input.txHash });
    if (
      !sameAddress(transaction.from, input.treasuryAddress)
      || !transaction.to
      || !sameAddress(transaction.to, this.projectEscrowAddress)
      || transaction.value !== 0n
      || transaction.input !== expectedData
      || transaction.nonce !== Number(input.treasuryNonce)
    ) {
      throw new WorkerRewardVerificationError("Confirmed Escrow transaction does not match persisted intent");
    }
    const events = parseEventLogs({
      abi: learningProjectEscrowAbi,
      eventName: "RewardReleased",
      logs: receipt.logs.filter((log) => sameAddress(log.address, this.projectEscrowAddress)),
      strict: true,
    });
    const rewardEvent = events.find((event) =>
      event.args.projectId === input.projectId
      && Number(event.args.workUnitId) === input.workUnitId
      && sameAddress(event.args.worker, input.recipientAddress)
      && event.args.amount === input.amountWei);
    if (!rewardEvent) throw new WorkerRewardVerificationError("Confirmed receipt is missing the exact Worker reward event");
    return {
      txHash: input.txHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      confirmationMs: Math.round(performance.now() - startedAt),
    };
  }

  private async readProjectEscrow(projectId: Hex) {
    try {
      const state = await this.publicClient.readContract({
        address: this.projectEscrowAddress,
        abi: learningProjectEscrowAbi,
        functionName: "projectEscrows",
        args: [projectId],
      });
      return {
        pricingMode: "DYNAMIC" as const,
        sponsor: state[0],
        pricingRoot: state[1],
        rewardPerWorkUnitWei: null,
        totalBudgetWei: state[2],
        remainingBudgetWei: state[3],
        workUnitCount: Number(state[4]),
        settledWorkUnitCount: Number(state[5]),
        fundedBlock: state[6],
        refunded: state[7],
      };
    } catch (error) {
      try {
        const state = await this.publicClient.readContract({
          address: this.projectEscrowAddress,
          abi: legacyLearningProjectEscrowAbi,
          functionName: "projectEscrows",
          args: [projectId],
        });
        return {
          pricingMode: "LEGACY_FIXED" as const,
          sponsor: state[0],
          pricingRoot: null,
          rewardPerWorkUnitWei: state[1],
          totalBudgetWei: state[1] * BigInt(state[3]),
          remainingBudgetWei: state[2],
          workUnitCount: Number(state[3]),
          settledWorkUnitCount: Number(state[4]),
          fundedBlock: state[5],
          refunded: state[6],
        };
      } catch {
        throw error;
      }
    }
  }
}
