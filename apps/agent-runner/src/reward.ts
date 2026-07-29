import { NATIVE, Registry, createRuntime, type Plan } from "@themoss/core";
import { ercManifest } from "@themoss/erc";
import { createTraceSimulator, type SimulateOutcome } from "@themoss/simulator";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  formatEther,
  http,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type {
  MossRewardStage,
  PreparedWorkerReward,
  WorkerRewardGateway,
  WorkerRewardReceipt,
} from "./runtime-types.js";

export class WorkerRewardVerificationError extends Error {
  constructor(
    message: string,
    readonly warningCodes: string[] = [],
  ) {
    super(message);
    this.name = "WorkerRewardVerificationError";
  }
}

export type MossRewardGatewayConfiguration = {
  rpcUrl: string;
  chainId: number;
  treasuryPrivateKey: Hex;
};

function sameAddress(left: string, right: string): boolean {
  return getAddress(left) === getAddress(right);
}

export function verifyMossRewardPlan(
  plan: Plan,
  expected: { chainId: number; treasury: Address; recipient: Address; amountWei: bigint },
): void {
  if (plan.protocol !== "erc20" || plan.method !== "transfer" || plan.verb !== "transfer") {
    throw new WorkerRewardVerificationError("Moss selected an unexpected capability");
  }
  if (plan.chainId !== expected.chainId || !sameAddress(plan.account, expected.treasury)) {
    throw new WorkerRewardVerificationError("Moss Plan chain or account does not match the reward intent");
  }
  if (plan.txs.length !== 1) {
    throw new WorkerRewardVerificationError("Worker reward must contain exactly one transaction");
  }
  const tx = plan.txs[0]!;
  if (
    !sameAddress(tx.from, expected.treasury) ||
    !sameAddress(tx.to, expected.recipient) ||
    tx.data !== "0x" ||
    BigInt(tx.value) !== expected.amountWei
  ) {
    throw new WorkerRewardVerificationError("Moss unsigned transaction does not match the reward intent");
  }
  const out = plan.expects.out ?? [];
  if (
    out.length !== 1 ||
    out[0]!.token !== NATIVE ||
    BigInt(out[0]!.amountMax) !== expected.amountWei ||
    (plan.expects.in?.length ?? 0) > 0 ||
    (plan.expects.approvals?.length ?? 0) > 0 ||
    (plan.expects.nfts?.length ?? 0) > 0
  ) {
    throw new WorkerRewardVerificationError("Moss declared effects do not exactly match native MON reward");
  }
}

export function verifyMossRewardSimulation(
  plan: Plan,
  outcome: SimulateOutcome,
  expected: { recipient: Address; amountWei: bigint },
): bigint | null {
  const result = outcome.results[0];
  const warningCodes = result?.warnings.map((warning) => warning.code) ?? [];
  if (
    outcome.results.length !== 1 ||
    !result ||
    result.planHash !== plan.planHash ||
    !result.planHashValid ||
    result.reverted ||
    outcome.halted ||
    warningCodes.length > 0
  ) {
    throw new WorkerRewardVerificationError("Moss simulation did not pass the signing gate", warningCodes);
  }
  const effects = result.effects;
  if (
    effects.assetsOut.length !== 1 ||
    effects.assetsOut[0]!.token !== NATIVE ||
    BigInt(effects.assetsOut[0]!.amount) !== expected.amountWei ||
    effects.recipients.length !== 1 ||
    !sameAddress(effects.recipients[0]!, expected.recipient) ||
    effects.assetsIn.length > 0 ||
    effects.approvals.length > 0 ||
    effects.nftApprovals.length > 0 ||
    effects.nftsOut.length > 0 ||
    effects.nftsIn.length > 0
  ) {
    throw new WorkerRewardVerificationError("Moss simulated effects do not exactly match the reward intent");
  }
  const gas = result.gasPerTx[0];
  return gas === null || gas === undefined ? null : BigInt(gas);
}

export class MossViemRewardGateway implements WorkerRewardGateway {
  private readonly runtime;
  private readonly registry;
  private readonly publicClient;
  private readonly walletClient;
  private readonly account: PrivateKeyAccount;
  private readonly chain;

  constructor(private readonly configuration: MossRewardGatewayConfiguration) {
    this.chain = defineChain({
      id: configuration.chainId,
      name: `Monad ${configuration.chainId}`,
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [configuration.rpcUrl] } },
    });
    this.runtime = createRuntime({
      rpcUrl: configuration.rpcUrl,
      chainId: configuration.chainId,
    });
    this.registry = new Registry(this.runtime);
    this.registry.use(ercManifest);
    this.account = privateKeyToAccount(configuration.treasuryPrivateKey);
    this.publicClient = createPublicClient({
      chain: this.chain,
      transport: http(configuration.rpcUrl),
    });
    this.walletClient = createWalletClient({
      account: this.account,
      chain: this.chain,
      transport: http(configuration.rpcUrl),
    });
  }

  treasuryAddress(): Address {
    return this.account.address;
  }

  async prepare(
    input: { recipientAddress: Address; amountWei: bigint },
    onStage?: (
      stage: Exclude<MossRewardStage, "PENDING" | "SIMULATED">,
    ) => Promise<void>,
  ): Promise<PreparedWorkerReward> {
    if (input.amountWei <= 0n) {
      throw new WorkerRewardVerificationError("Worker reward amount must be positive");
    }
    const recipient = getAddress(input.recipientAddress);
    const treasury = this.account.address;
    const balance = await this.publicClient.getBalance({ address: treasury });
    if (balance <= input.amountWei) {
      throw new Error("Reward Treasury balance cannot cover the reward and transaction fee");
    }

    const coordinates = this.registry.discover({ verb: "transfer", category: "token" });
    if (!coordinates.some((item) => item.protocol === "erc20" && item.method === "transfer")) {
      throw new WorkerRewardVerificationError("Moss did not discover erc20.transfer");
    }
    await onStage?.("DISCOVERED");

    const [stub] = this.registry.load([{ protocol: "erc20", method: "transfer" }]);
    if (
      !stub ||
      stub.kind !== "capability" ||
      stub.verb !== "transfer" ||
      stub.category !== "token" ||
      !stub.risk.includes("fundOut")
    ) {
      throw new WorkerRewardVerificationError("Moss loaded an unexpected transfer capability");
    }
    await onStage?.("LOADED");

    const action = await this.registry.action("erc20", "transfer", treasury, {
      token: NATIVE,
      to: recipient,
      amount: formatEther(input.amountWei),
    });
    if (action.kind !== "plan") {
      throw new WorkerRewardVerificationError("Moss transfer action did not produce a Plan");
    }
    verifyMossRewardPlan(action, {
      chainId: this.configuration.chainId,
      treasury,
      recipient,
      amountWei: input.amountWei,
    });
    await onStage?.("BUILT");

    const simulator = createTraceSimulator(this.runtime, {
      prefundWei: balance,
      observer: this.registry.observer(),
    });
    const outcome = await simulator.simulate([action]);
    const simulationGas = verifyMossRewardSimulation(action, outcome, {
      recipient,
      amountWei: input.amountWei,
    });

    const tx = action.txs[0]!;
    const request = await this.walletClient.prepareTransactionRequest({
      account: this.account,
      to: tx.to,
      data: tx.data,
      value: BigInt(tx.value),
    });
    const maximumFee = request.maxFeePerGas ?? request.gasPrice ?? 0n;
    const maximumCost = input.amountWei + (request.gas ?? 0n) * maximumFee;
    if (balance < maximumCost) {
      throw new Error("Reward Treasury balance cannot cover the prepared transaction fee");
    }
    const signedTransaction = await this.walletClient.signTransaction(request);
    return {
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
    const parsed = parseTransaction(input.signedTransaction);
    const signer = await recoverTransactionAddress({ serializedTransaction: input.signedTransaction });
    if (
      !sameAddress(signer, input.treasuryAddress) ||
      !parsed.to ||
      !sameAddress(parsed.to, input.recipientAddress) ||
      parsed.value !== input.amountWei ||
      parsed.data !== "0x" ||
      parsed.nonce === undefined ||
      BigInt(parsed.nonce) !== input.treasuryNonce ||
      parsed.chainId !== this.configuration.chainId
    ) {
      throw new WorkerRewardVerificationError("Persisted signed transaction does not match reward intent");
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
    if (receipt.status !== "success") {
      throw new WorkerRewardVerificationError("Worker reward transaction reverted");
    }
    const transaction = await this.publicClient.getTransaction({ hash: input.txHash });
    if (
      !sameAddress(transaction.from, input.treasuryAddress) ||
      !transaction.to ||
      !sameAddress(transaction.to, input.recipientAddress) ||
      transaction.value !== input.amountWei ||
      transaction.input !== "0x" ||
      transaction.nonce !== Number(input.treasuryNonce)
    ) {
      throw new WorkerRewardVerificationError("Confirmed reward transaction does not match persisted intent");
    }
    return {
      txHash: input.txHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      confirmationMs: Math.round(performance.now() - startedAt),
    };
  }
}
