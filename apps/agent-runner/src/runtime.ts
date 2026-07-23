import { AddressSchema } from "@mindmark/shared";
import { z } from "zod";
import type { Hex } from "viem";
import { ViemRegistryGateway } from "./chain.js";
import { Coordinator } from "./coordinator.js";
import { FinalizerAgent } from "./finalizer.js";
import { OpenAICompatibleToolModel } from "./model.js";
import { SupabaseRunnerRepository } from "./repository.js";
import { WorkerAgent } from "./worker.js";

const PrivateKeySchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/u, "Expected a 32-byte private key")
  .transform((value) => value as Hex);

const RunnerEnvironmentSchema = z.object({
  MONAD_RPC_URL: z.string().url(),
  MONAD_CHAIN_ID: z.coerce.number().int().positive().default(10143),
  REGISTRY_ADDRESS: AddressSchema,
  CONTRACT_DEPLOYMENT_BLOCK: z.coerce.bigint().nonnegative(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  AI_API_KEY: z.string().min(1),
  AI_MODEL: z.string().min(1),
  AI_BASE_URL: z.string().url().optional(),
  COORDINATOR_PRIVATE_KEY: PrivateKeySchema,
  WORKER_0_PRIVATE_KEY: PrivateKeySchema,
  WORKER_1_PRIVATE_KEY: PrivateKeySchema,
  WORKER_2_PRIVATE_KEY: PrivateKeySchema,
  RUNNER_POLL_INTERVAL_MS: z.coerce.number().int().min(15_000).max(30_000).default(20_000),
});

export async function startRunnerFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Coordinator> {
  const configuration = RunnerEnvironmentSchema.parse(environment);
  const repository = SupabaseRunnerRepository.connect(
    configuration.SUPABASE_URL,
    configuration.SUPABASE_SERVICE_ROLE_KEY,
  );
  const registry = new ViemRegistryGateway({
    rpcUrl: configuration.MONAD_RPC_URL,
    chainId: configuration.MONAD_CHAIN_ID,
    registryAddress: configuration.REGISTRY_ADDRESS,
    coordinatorPrivateKey: configuration.COORDINATOR_PRIVATE_KEY,
    workerPrivateKeys: [
      configuration.WORKER_0_PRIVATE_KEY,
      configuration.WORKER_1_PRIVATE_KEY,
      configuration.WORKER_2_PRIVATE_KEY,
    ],
  });
  const model = new OpenAICompatibleToolModel({
    apiKey: configuration.AI_API_KEY,
    model: configuration.AI_MODEL,
    ...(configuration.AI_BASE_URL ? { baseUrl: configuration.AI_BASE_URL } : {}),
  });
  const workers = [
    new WorkerAgent(repository, registry, model),
    new WorkerAgent(repository, registry, model),
    new WorkerAgent(repository, registry, model),
  ] as const;
  const finalizer = new FinalizerAgent(repository, registry, model);
  const coordinator = new Coordinator(repository, registry, workers, finalizer, {
    deploymentBlock: configuration.CONTRACT_DEPLOYMENT_BLOCK,
    pollIntervalMs: configuration.RUNNER_POLL_INTERVAL_MS,
  });
  await coordinator.start();
  return coordinator;
}
