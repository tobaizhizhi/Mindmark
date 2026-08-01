import { AddressSchema } from "@mindmark/shared";
import { z } from "zod";
import { parseEther, type Hex } from "viem";
import { ViemProjectRegistryGatewayV2 } from "./chain-v2.js";
import { ChapterAssembler } from "./chapter-assembler.js";
import { ChapterDesignWorkflowAgent } from "./chapter-design-agent.js";
import { ChapterQualityGate } from "./chapter-quality-gate.js";
import { ProjectCoordinatorV2 } from "./coordinator-v2.js";
import {
  DeterministicCardEmbeddingGatewayV3,
  OpenAICompatibleCardEmbeddingGatewayV3,
} from "./embedding-v3.js";
import { ProjectFinalizerV2 } from "./project-finalizer-v2.js";
import { ProjectDesignFreezer } from "./project-design-freezer.js";
import { ModelCardQualityEvaluatorV3 } from "./quality-evaluator-v3.js";
import { OpenAICompatibleToolModel } from "./model.js";
import { OutlinePlanningAgent } from "./outline-planning-agent.js";
import { SupabaseProjectRunnerRepositoryV2 } from "./repository-v2.js";
import { MossViemRewardGateway } from "./reward.js";
import { WorkUnitSettlementAgentV2 } from "./reward-v2.js";
import { DEFAULT_AI_TOOL_TIMEOUT_MS } from "./runtime-types.js";
import { WorkUnitWorkerAgent } from "./worker-v2.js";
import { ProjectWorkflowDispatcherV2 } from "./workflow-dispatcher-v2.js";
import { RegistryReconcilerV2 } from "./registry-reconciler-v2.js";

const PrivateKeySchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/u, "Expected a 32-byte private key")
  .transform((value) => value as Hex);

const RunnerEnvironmentSchema = z.object({
  MONAD_RPC_URL: z.string().url(),
  MONAD_CHAIN_ID: z.coerce.number().int().positive().default(10143),
  REGISTRY_V2_ADDRESS: AddressSchema,
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  AI_API_KEY: z.string().min(1),
  AI_MODEL: z.string().min(1),
  AI_BASE_URL: z.string().url().optional(),
  AI_DESIGN_MODEL: z.string().min(1).optional(),
  AI_EVALUATION_MODEL: z.string().min(1).optional(),
  AI_EVALUATION_API_KEY: z.string().min(1).optional(),
  AI_EVALUATION_BASE_URL: z.string().url().optional(),
  AI_EMBEDDING_MODEL: z.string().min(1).optional(),
  AI_EMBEDDING_API_KEY: z.string().min(1).optional(),
  AI_EMBEDDING_BASE_URL: z.string().url().optional(),
  AI_TOOL_TIMEOUT_MS: z.coerce.number().int().min(45_000).max(600_000).default(DEFAULT_AI_TOOL_TIMEOUT_MS),
  COORDINATOR_PRIVATE_KEY: PrivateKeySchema,
  WORKER_0_PRIVATE_KEY: PrivateKeySchema,
  WORKER_1_PRIVATE_KEY: PrivateKeySchema,
  WORKER_2_PRIVATE_KEY: PrivateKeySchema,
  REWARD_TREASURY_PRIVATE_KEY: PrivateKeySchema,
  WORKER_REWARD_AMOUNT_MON: z
    .string()
    .regex(/^\d+(?:\.\d{1,18})?$/u, "Expected a positive MON amount with at most 18 decimals")
    .transform((value) => parseEther(value))
    .refine((value) => value > 0n, "Worker reward amount must be positive")
    .default(parseEther("0.001")),
  RUNNER_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).max(30_000).default(5_000),
});

export interface RunnerController {
  stop(): void;
}

export async function startRunnerFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ProjectCoordinatorV2> {
  const configuration = RunnerEnvironmentSchema.parse(environment);
  const registry = new ViemProjectRegistryGatewayV2({
    rpcUrl: configuration.MONAD_RPC_URL,
    chainId: configuration.MONAD_CHAIN_ID,
    registryAddress: configuration.REGISTRY_V2_ADDRESS,
    coordinatorPrivateKey: configuration.COORDINATOR_PRIVATE_KEY,
    workerPrivateKeys: [
      configuration.WORKER_0_PRIVATE_KEY,
      configuration.WORKER_1_PRIVATE_KEY,
      configuration.WORKER_2_PRIVATE_KEY,
    ],
  });
  const rewardGateway = new MossViemRewardGateway({
    rpcUrl: configuration.MONAD_RPC_URL,
    chainId: configuration.MONAD_CHAIN_ID,
    treasuryPrivateKey: configuration.REWARD_TREASURY_PRIVATE_KEY,
  });
  const operationalAddresses = [
    registry.coordinatorAddress(),
    registry.workerAddress(0),
    registry.workerAddress(1),
    registry.workerAddress(2),
  ];
  if (operationalAddresses.some((address) =>
    address.toLowerCase() === rewardGateway.treasuryAddress().toLowerCase())) {
    throw new Error("Reward Treasury must not reuse the V2 Coordinator or a Worker wallet");
  }
  const repository = SupabaseProjectRunnerRepositoryV2.connect(
    configuration.SUPABASE_URL,
    configuration.SUPABASE_SERVICE_ROLE_KEY,
    { treasuryAddress: rewardGateway.treasuryAddress(), amountWei: configuration.WORKER_REWARD_AMOUNT_MON },
  );
  const generationModel = new OpenAICompatibleToolModel({
    apiKey: configuration.AI_API_KEY,
    model: configuration.AI_MODEL,
    ...(configuration.AI_BASE_URL ? { baseUrl: configuration.AI_BASE_URL } : {}),
  });
  const designModelId = configuration.AI_DESIGN_MODEL ?? configuration.AI_MODEL;
  const designModel = designModelId === configuration.AI_MODEL
    ? generationModel
    : new OpenAICompatibleToolModel({
        apiKey: configuration.AI_API_KEY,
        model: designModelId,
        ...(configuration.AI_BASE_URL ? { baseUrl: configuration.AI_BASE_URL } : {}),
      });
  const evaluationModelId = configuration.AI_EVALUATION_MODEL ?? configuration.AI_MODEL;
  const evaluationModel = new OpenAICompatibleToolModel({
    apiKey: configuration.AI_EVALUATION_API_KEY ?? configuration.AI_API_KEY,
    model: evaluationModelId,
    ...(configuration.AI_EVALUATION_BASE_URL
      ? { baseUrl: configuration.AI_EVALUATION_BASE_URL }
      : configuration.AI_BASE_URL ? { baseUrl: configuration.AI_BASE_URL } : {}),
    temperature: 0,
  });
  const embeddings = configuration.AI_EMBEDDING_MODEL
    ? new OpenAICompatibleCardEmbeddingGatewayV3({
        apiKey: configuration.AI_EMBEDDING_API_KEY ?? configuration.AI_API_KEY,
        model: configuration.AI_EMBEDDING_MODEL,
        ...(configuration.AI_EMBEDDING_BASE_URL
          ? { baseUrl: configuration.AI_EMBEDDING_BASE_URL }
          : configuration.AI_BASE_URL ? { baseUrl: configuration.AI_BASE_URL } : {}),
        timeoutMs: configuration.AI_TOOL_TIMEOUT_MS,
      })
    : new DeterministicCardEmbeddingGatewayV3();
  const workers = [0, 1, 2].map((index) =>
    new WorkUnitWorkerAgent(repository, registry, generationModel, index, {
      timeoutMs: configuration.AI_TOOL_TIMEOUT_MS,
    }),
  ) as [WorkUnitWorkerAgent, WorkUnitWorkerAgent, WorkUnitWorkerAgent];
  const assembler = new ChapterAssembler(repository, registry);
  const finalizer = new ProjectFinalizerV2(repository, registry);
  const settlement = new WorkUnitSettlementAgentV2(repository, registry, rewardGateway);
  const dispatcher = new ProjectWorkflowDispatcherV2(
    repository,
    registry,
    workers,
    new RegistryReconcilerV2(repository, registry),
    new ChapterQualityGate(
      repository,
      embeddings,
      new ModelCardQualityEvaluatorV3(evaluationModel, {
        modelId: evaluationModelId,
        timeoutMs: configuration.AI_TOOL_TIMEOUT_MS,
      }),
    ),
    assembler,
    finalizer,
    settlement,
    new ChapterDesignWorkflowAgent(repository, designModel, {
      timeoutMs: configuration.AI_TOOL_TIMEOUT_MS,
      modelId: designModelId,
    }),
    new ProjectDesignFreezer(repository),
  );
  const coordinator = new ProjectCoordinatorV2(
    registry,
    new OutlinePlanningAgent(repository, designModel, { timeoutMs: configuration.AI_TOOL_TIMEOUT_MS }),
    dispatcher,
    { pollIntervalMs: configuration.RUNNER_POLL_INTERVAL_MS },
  );
  await coordinator.start();
  return coordinator;
}
