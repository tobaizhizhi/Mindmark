import { AddressSchema, mossNetworkSupport } from "@mindmark/shared";
import { z } from "zod";
import { parseEther, type Hex } from "viem";
import { ViemProjectRegistryGatewayV2 } from "./chain-v2.js";
import { ChapterAssembler } from "./chapter-assembler.js";
import { ChapterDesignWorkflowAgent } from "./chapter-design-agent.js";
import { ChapterQualityGate } from "./chapter-quality-gate.js";
import { ProjectCoordinatorV2 } from "./coordinator-v2.js";
import {
  DeterministicCardEmbeddingGatewayV3,
  RemoteEmbeddingGatewayV3,
} from "./embedding-v3.js";
import { ProjectFinalizerV2 } from "./project-finalizer-v2.js";
import { ProjectDesignFreezer } from "./project-design-freezer.js";
import { RemoteCardQualityEvaluatorV3 } from "./quality-evaluator-v3.js";
import { RemoteAgentToolModel } from "./model.js";
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

const EnvironmentBooleanSchema = z.preprocess(
  (value) => typeof value === "string" ? value.trim().toLowerCase() : value,
  z.union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((value) => value === true || value === "true")
    .default(false),
);

export const RunnerEnvironmentSchema = z.object({
  MONAD_RPC_URL: z.string().url(),
  MONAD_CHAIN_ID: z.coerce.number().int().positive().default(10143),
  REGISTRY_V2_ADDRESS: AddressSchema,
  PROJECT_ESCROW_ADDRESS: AddressSchema,
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  AGENT_RUNNER_URL: z.string().url(),
  AGENT_RUNNER_INTERNAL_TOKEN: z.string().min(16),
  AI_GATEWAY_URL: z.string().url().optional(),
  AI_GATEWAY_INTERNAL_TOKEN: z.string().min(16).optional(),
  AI_EMBEDDING_ENABLED: EnvironmentBooleanSchema,
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
}).superRefine((configuration, context) => {
  if (!configuration.AI_EMBEDDING_ENABLED) return;
  if (!configuration.AI_GATEWAY_URL) {
    context.addIssue({
      code: "custom",
      path: ["AI_GATEWAY_URL"],
      message: "AI_GATEWAY_URL is required when AI_EMBEDDING_ENABLED is true",
    });
  }
  if (!configuration.AI_GATEWAY_INTERNAL_TOKEN) {
    context.addIssue({
      code: "custom",
      path: ["AI_GATEWAY_INTERNAL_TOKEN"],
      message: "AI_GATEWAY_INTERNAL_TOKEN is required when AI_EMBEDDING_ENABLED is true",
    });
  }
});

function embeddingGatewayConfiguration(configuration: z.infer<typeof RunnerEnvironmentSchema>): {
  baseUrl: string;
  internalToken: string;
} | null {
  if (!configuration.AI_EMBEDDING_ENABLED) return null;
  if (!configuration.AI_GATEWAY_URL || !configuration.AI_GATEWAY_INTERNAL_TOKEN) {
    throw new Error("AI Gateway embedding configuration is missing");
  }
  return {
    baseUrl: configuration.AI_GATEWAY_URL,
    internalToken: configuration.AI_GATEWAY_INTERNAL_TOKEN,
  };
}

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
  const generationModel = new RemoteAgentToolModel({
    baseUrl: configuration.AGENT_RUNNER_URL,
    internalToken: configuration.AGENT_RUNNER_INTERNAL_TOKEN,
    profile: "generation",
    timeoutMs: configuration.AI_TOOL_TIMEOUT_MS,
  });
  const designModel = new RemoteAgentToolModel({
    baseUrl: configuration.AGENT_RUNNER_URL,
    internalToken: configuration.AGENT_RUNNER_INTERNAL_TOKEN,
    profile: "design",
    timeoutMs: configuration.AI_TOOL_TIMEOUT_MS,
  });
  const embeddingGateway = embeddingGatewayConfiguration(configuration);
  const embeddings = embeddingGateway
    ? new RemoteEmbeddingGatewayV3({
        ...embeddingGateway,
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
      new RemoteCardQualityEvaluatorV3({
        baseUrl: configuration.AGENT_RUNNER_URL,
        internalToken: configuration.AGENT_RUNNER_INTERNAL_TOKEN,
        modelId: "agent-runner:evaluation",
        timeoutMs: configuration.AI_TOOL_TIMEOUT_MS,
      }),
    ),
    assembler,
    finalizer,
    settlement,
    new ChapterDesignWorkflowAgent(persistence.design, designModel, {
      timeoutMs: configuration.AI_CHAPTER_DESIGN_TIMEOUT_MS,
      modelId: "agent-runner:design",
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
    return error instanceof Error ? error.message : "Workflow Runner failed to start";
  }

  const issues = error.issues.map((issue) => {
    const path = issue.path.join(".") || "environment";
    const message = issue.code === "invalid_type" && /received undefined$/u.test(issue.message)
      ? "required"
      : issue.message;
    return `${path}: ${message}`;
  });
  return [
    "Workflow Runner environment is invalid.",
    ...issues.map((issue) => `- ${issue}`),
    "Set these variables on Railway in the Mindmark Workflow Runner service (not only in .env.local or the Web service).",
    "Reference: docs/PUBLIC_TESTNET_DEPLOYMENT.md, section 4 (Runner Variables).",
  ].join("\n");
}
