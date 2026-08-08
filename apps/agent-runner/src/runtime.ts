import { AddressSchema, mossNetworkSupport } from "@mindmark/shared";
import type { OpenAICompatibleGatewayConfiguration } from "@mindmark/ai-gateway";
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
import { connectRunnerPersistence } from "./persistence/index.js";
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

const OptionalUrlSchema = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().url().optional(),
);

const OptionalStringSchema = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(1).optional(),
);

const DefaultStringSchema = (fallback: string) => z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(1).default(fallback),
);

export const RunnerEnvironmentSchema = z.object({
  MONAD_RPC_URL: z.string().url(),
  MONAD_CHAIN_ID: z.coerce.number().int().positive().default(10143),
  REGISTRY_V2_ADDRESS: AddressSchema,
  PROJECT_ESCROW_ADDRESS: AddressSchema,
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  AI_API_KEY: z.string().min(1),
  AI_MODEL: z.string().min(1),
  AI_BASE_URL: OptionalUrlSchema,
  AI_FALLBACK_API_KEY: OptionalStringSchema,
  AI_FALLBACK_MODEL: DefaultStringSchema("deepseek-chat"),
  AI_FALLBACK_BASE_URL: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().url().default("https://api.deepseek.com/v1"),
  ),
  AI_DESIGN_MODEL: OptionalStringSchema,
  AI_EVALUATION_MODEL: OptionalStringSchema,
  AI_EVALUATION_API_KEY: OptionalStringSchema,
  AI_EVALUATION_BASE_URL: OptionalUrlSchema,
  AI_EMBEDDING_MODEL: OptionalStringSchema,
  AI_EMBEDDING_API_KEY: OptionalStringSchema,
  AI_EMBEDDING_BASE_URL: OptionalUrlSchema,
  AI_TOOL_TIMEOUT_MS: z.coerce.number().int().min(45_000).max(600_000).default(DEFAULT_AI_TOOL_TIMEOUT_MS),
  AI_CHAPTER_DESIGN_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(120_000).default(20_000),
  COORDINATOR_PRIVATE_KEY: PrivateKeySchema,
  WORKER_0_PRIVATE_KEY: PrivateKeySchema,
  WORKER_1_PRIVATE_KEY: PrivateKeySchema,
  WORKER_2_PRIVATE_KEY: PrivateKeySchema,
  REWARD_TREASURY_PRIVATE_KEY: PrivateKeySchema,
  WORKER_REWARD_AMOUNT_MON: z
    .string()
    .regex(/^\d+(?:\.\d{1,18})?$/u, "Expected a positive MON amount with at most 18 decimals")
    .transform((value) => parseEther(value))
    .refine((value) => value > 0n, "Worker reward pricing base must be positive")
    .default(parseEther("0.001")),
  RUNNER_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).max(30_000).default(5_000),
});

export async function startRunnerFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ProjectCoordinatorV2> {
  const configuration = RunnerEnvironmentSchema.parse(environment);
  const mossNetwork = mossNetworkSupport(configuration.MONAD_CHAIN_ID);
  if (mossNetwork === "EXPERIMENTAL_TESTNET") {
    console.warn(
      "Moss 0.1.0 is running in Mindmark experimental Monad Testnet mode; official Moss support targets Monad Mainnet (143).",
    );
  }
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
    registryAddress: configuration.REGISTRY_V2_ADDRESS,
    escrowAddress: configuration.PROJECT_ESCROW_ADDRESS,
    treasuryPrivateKey: configuration.REWARD_TREASURY_PRIVATE_KEY,
  });
  await rewardGateway.assertConfiguredEscrow(configuration.REGISTRY_V2_ADDRESS);
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
  const persistence = connectRunnerPersistence(
    configuration.SUPABASE_URL,
    configuration.SUPABASE_SERVICE_ROLE_KEY,
  );
  await persistence.assertSchemaCapabilities();
  const deepSeekFallback: OpenAICompatibleGatewayConfiguration | undefined = configuration.AI_FALLBACK_API_KEY
    ? {
        apiKey: configuration.AI_FALLBACK_API_KEY,
        model: configuration.AI_FALLBACK_MODEL,
        baseUrl: configuration.AI_FALLBACK_BASE_URL,
        maxTokensParameter: "max_tokens",
        providerOptions: { thinking: { type: "disabled" } },
      }
    : undefined;
  const generationModel = new OpenAICompatibleToolModel({
    apiKey: configuration.AI_API_KEY,
    model: configuration.AI_MODEL,
    ...(configuration.AI_BASE_URL ? { baseUrl: configuration.AI_BASE_URL } : {}),
    ...(deepSeekFallback ? { fallback: deepSeekFallback } : {}),
  });
  const designModelId = configuration.AI_DESIGN_MODEL ?? configuration.AI_MODEL;
  const designModel = designModelId === configuration.AI_MODEL
    ? generationModel
    : new OpenAICompatibleToolModel({
        apiKey: configuration.AI_API_KEY,
        model: designModelId,
        ...(configuration.AI_BASE_URL ? { baseUrl: configuration.AI_BASE_URL } : {}),
        ...(deepSeekFallback ? { fallback: deepSeekFallback } : {}),
      });
  const evaluationModelId = configuration.AI_EVALUATION_MODEL ?? configuration.AI_MODEL;
  const evaluationModel = new OpenAICompatibleToolModel({
    apiKey: configuration.AI_EVALUATION_API_KEY ?? configuration.AI_API_KEY,
    model: evaluationModelId,
    ...(configuration.AI_EVALUATION_BASE_URL
      ? { baseUrl: configuration.AI_EVALUATION_BASE_URL }
      : configuration.AI_BASE_URL ? { baseUrl: configuration.AI_BASE_URL } : {}),
    ...(deepSeekFallback ? { fallback: deepSeekFallback } : {}),
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
    new WorkUnitWorkerAgent(persistence.generation, registry, generationModel, index, {
      timeoutMs: configuration.AI_TOOL_TIMEOUT_MS,
    }),
  ) as [WorkUnitWorkerAgent, WorkUnitWorkerAgent, WorkUnitWorkerAgent];
  const outlinePlanner = new OutlinePlanningAgent(persistence.workflow, designModel, {
    timeoutMs: configuration.AI_TOOL_TIMEOUT_MS,
  });
  const assembler = new ChapterAssembler(persistence.commitment, registry);
  const finalizer = new ProjectFinalizerV2(persistence.commitment, registry);
  const settlement = new WorkUnitSettlementAgentV2(persistence.reward, registry, rewardGateway);
  const dispatcher = new ProjectWorkflowDispatcherV2(
    persistence.workflow,
    registry,
    workers,
    new RegistryReconcilerV2(
      persistence.commitment,
      registry,
      rewardGateway,
      configuration.WORKER_REWARD_AMOUNT_MON,
    ),
    new ChapterQualityGate(
      persistence.generation,
      embeddings,
      new ModelCardQualityEvaluatorV3(evaluationModel, {
        modelId: evaluationModelId,
        timeoutMs: configuration.AI_TOOL_TIMEOUT_MS,
      }),
    ),
    assembler,
    finalizer,
    settlement,
    new ChapterDesignWorkflowAgent(persistence.design, designModel, {
      timeoutMs: configuration.AI_CHAPTER_DESIGN_TIMEOUT_MS,
      modelId: designModelId,
    }),
    new ProjectDesignFreezer(persistence.design),
    outlinePlanner,
  );
  const coordinator = new ProjectCoordinatorV2(
    registry,
    dispatcher,
    { pollIntervalMs: configuration.RUNNER_POLL_INTERVAL_MS },
  );
  await coordinator.start();
  return coordinator;
}

/**
 * Keep deployment logs actionable without printing secret values. Zod v4's
 * default Error.message is a JSON array, which is difficult to read in Railway
 * and can be interleaved when the service restarts repeatedly.
 */
export function formatRunnerEnvironmentError(error: unknown): string {
  if (!(error instanceof z.ZodError)) {
    return error instanceof Error ? error.message : "Agent Runner failed to start";
  }

  const issues = error.issues.map((issue) => {
    const path = issue.path.join(".") || "environment";
    const message = issue.code === "invalid_type" && /received undefined$/u.test(issue.message)
      ? "required"
      : issue.message;
    return `${path}: ${message}`;
  });
  return [
    "Agent Runner environment is invalid.",
    ...issues.map((issue) => `- ${issue}`),
    "Set these variables on Railway in the Mindmark Runner service (not only in .env.local or the Web service).",
    "Reference: docs/PUBLIC_TESTNET_DEPLOYMENT.md, section 4 (Runner Variables).",
  ].join("\n");
}
