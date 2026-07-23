import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildChunkManifest, learningJourneyRegistryAbi } from "@mindmark/shared";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

const PrivateKeySchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/u).transform((key) => key as Hex);
const EnvironmentSchema = z.object({
  MONAD_RPC_URL: z.string().url(),
  MONAD_CHAIN_ID: z.coerce.number().int().positive(),
  REGISTRY_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/u).transform((value) => value as Address),
  BENCHMARK_LEARNER_PRIVATE_KEY: PrivateKeySchema,
  WORKER_0_PRIVATE_KEY: PrivateKeySchema,
  WORKER_1_PRIVATE_KEY: PrivateKeySchema,
  WORKER_2_PRIVATE_KEY: PrivateKeySchema,
  BENCHMARK_RUNS: z.coerce.number().int().min(5).default(5),
  BENCHMARK_OUTPUT: z.string().min(1).default("artifacts/commit-concurrency.json"),
});

export type BenchmarkMode = "single-wallet" | "three-wallets";

export type TransactionMeasurement = {
  runId: string;
  mode: BenchmarkMode;
  sender: Address;
  nonce: number;
  submittedAt: string;
  receiptAt: string | null;
  blockNumber: string | null;
  gasUsed: string | null;
  status: "success" | "reverted" | "submission_failed";
};

export type ModeSummary = {
  mode: BenchmarkMode;
  successfulTransactions: number;
  medianConfirmationMs: number | null;
  minConfirmationMs: number | null;
  maxConfirmationMs: number | null;
};

export function summarizeMeasurements(
  measurements: TransactionMeasurement[],
  mode: BenchmarkMode,
): ModeSummary {
  const latencies = measurements
    .filter(
      (measurement) =>
        measurement.mode === mode &&
        measurement.status === "success" &&
        measurement.receiptAt,
    )
    .map((measurement) => Date.parse(measurement.receiptAt!) - Date.parse(measurement.submittedAt))
    .sort((left, right) => left - right);
  if (latencies.length === 0) {
    return {
      mode,
      successfulTransactions: 0,
      medianConfirmationMs: null,
      minConfirmationMs: null,
      maxConfirmationMs: null,
    };
  }
  const middle = Math.floor(latencies.length / 2);
  const median =
    latencies.length % 2 === 0
      ? Math.round((latencies[middle - 1]! + latencies[middle]!) / 2)
      : latencies[middle]!;
  return {
    mode,
    successfulTransactions: latencies.length,
    medianConfirmationMs: median,
    minConfirmationMs: latencies[0]!,
    maxConfirmationMs: latencies.at(-1)!,
  };
}

async function runBenchmark() {
  const configuration = EnvironmentSchema.parse(process.env);
  const chain = defineChain({
    id: configuration.MONAD_CHAIN_ID,
    name: `Monad ${configuration.MONAD_CHAIN_ID}`,
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [configuration.MONAD_RPC_URL] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(configuration.MONAD_RPC_URL) });
  const learner = privateKeyToAccount(configuration.BENCHMARK_LEARNER_PRIVATE_KEY);
  const workers = [
    privateKeyToAccount(configuration.WORKER_0_PRIVATE_KEY),
    privateKeyToAccount(configuration.WORKER_1_PRIVATE_KEY),
    privateKeyToAccount(configuration.WORKER_2_PRIVATE_KEY),
  ] as const;
  const learnerClient = createWalletClient({
    account: learner,
    chain,
    transport: http(configuration.MONAD_RPC_URL),
  });
  const workerClients = workers.map((account) =>
    createWalletClient({ account, chain, transport: http(configuration.MONAD_RPC_URL) }),
  );
  const measurements: TransactionMeasurement[] = [];

  async function executeMode(runNumber: number, mode: BenchmarkMode) {
    const runId = `${String(runNumber).padStart(2, "0")}-${mode}`;
    const journeyId = keccak256(stringToHex(randomUUID()));
    const chunks = Array.from({ length: 3 }, (_, chunkId) => ({
      chunkId,
      sourceChunkHash: keccak256(stringToHex(`source-${runNumber}-${chunkId}`)),
      cardsRoot: keccak256(stringToHex(`cards-${runNumber}-${chunkId}`)),
      cardCount: 2,
    }));
    const manifest = buildChunkManifest(journeyId, chunks);
    const createHash = await learnerClient.writeContract({
      address: configuration.REGISTRY_ADDRESS,
      abi: learningJourneyRegistryAbi,
      functionName: "createJourney",
      args: [
        journeyId,
        keccak256(stringToHex(`source-${runId}`)),
        keccak256(stringToHex(`goal-${runId}`)),
        manifest.root,
        3,
      ],
    });
    const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
    if (createReceipt.status !== "success") throw new Error(`createJourney failed for ${runId}`);

    const accounts: readonly PrivateKeyAccount[] =
      mode === "single-wallet" ? [workers[0], workers[0], workers[0]] : workers;
    const clients = mode === "single-wallet"
      ? [workerClients[0], workerClients[0], workerClients[0]]
      : workerClients;
    const baseNonce =
      mode === "single-wallet"
        ? await publicClient.getTransactionCount({ address: workers[0].address, blockTag: "pending" })
        : null;
    const nonces = await Promise.all(
      accounts.map((account, index) =>
        baseNonce === null
          ? publicClient.getTransactionCount({ address: account.address, blockTag: "pending" })
          : Promise.resolve(baseNonce + index),
      ),
    );

    const submissions = await Promise.allSettled(
      chunks.map(async (chunk, index) => {
        const submittedAt = new Date().toISOString();
        const client = clients[index]!;
        try {
          const commitment = manifest.chunks[index]!;
          const hash = await client.writeContract({
            account: accounts[index]!,
            address: configuration.REGISTRY_ADDRESS,
            abi: learningJourneyRegistryAbi,
            functionName: "commitChunk",
            args: [
              journeyId,
              chunk.chunkId,
              chunk.sourceChunkHash,
              chunk.cardsRoot,
              chunk.cardCount,
              commitment.proof,
            ],
            nonce: nonces[index]!,
          });
          return { index, hash, submittedAt };
        } catch {
          measurements.push({
            runId,
            mode,
            sender: accounts[index]!.address,
            nonce: nonces[index]!,
            submittedAt,
            receiptAt: null,
            blockNumber: null,
            gasUsed: null,
            status: "submission_failed",
          });
          throw new Error(`submission failed for ${runId} chunk ${index}`);
        }
      }),
    );

    await Promise.all(
      submissions.flatMap((submission) =>
        submission.status === "fulfilled"
          ? [
              (async () => {
                const receipt = await publicClient.waitForTransactionReceipt({
                  hash: submission.value.hash,
                });
                const index = submission.value.index;
                measurements.push({
                  runId,
                  mode,
                  sender: accounts[index]!.address,
                  nonce: nonces[index]!,
                  submittedAt: submission.value.submittedAt,
                  receiptAt: new Date().toISOString(),
                  blockNumber: receipt.blockNumber.toString(),
                  gasUsed: receipt.gasUsed.toString(),
                  status: receipt.status === "success" ? "success" : "reverted",
                });
              })(),
            ]
          : [],
      ),
    );
  }

  for (let runNumber = 1; runNumber <= configuration.BENCHMARK_RUNS; runNumber += 1) {
    await executeMode(runNumber, "single-wallet");
    await executeMode(runNumber, "three-wallets");
  }

  measurements.sort(
    (left, right) => left.runId.localeCompare(right.runId) || left.nonce - right.nonce,
  );
  const output = {
    generatedAt: new Date().toISOString(),
    chainId: configuration.MONAD_CHAIN_ID,
    registryAddress: configuration.REGISTRY_ADDRESS,
    disclaimer:
      "This compares transaction confirmation observations for two wallet layouts; it is not a TPS benchmark.",
    summaries: [
      summarizeMeasurements(measurements, "single-wallet"),
      summarizeMeasurements(measurements, "three-wallets"),
    ],
    measurements,
  };
  const outputPath = path.resolve(configuration.BENCHMARK_OUTPUT);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Wrote ${measurements.length} transaction measurements to ${outputPath}`);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  runBenchmark().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Benchmark failed");
    process.exitCode = 1;
  });
}
