import {
  CompletionClaimAuthorizationSchema,
  CompletionClaimReviewSchema,
  CompletionClaimStatusSchema,
  canonicalJson,
  learningCompletionRegistryAbi,
  learningProjectRegistryV2Abi,
  type CompletionClaimAuthorization,
  type CompletionClaimReview,
  type CompletionClaimStatus,
  type MossOnchainReview,
} from "@mindmark/shared";
import {
  createPublicClient,
  defineChain,
  http,
  keccak256,
  stringToHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getServerEnvironment } from "./config";
import { ApiError } from "./http";
import { MossCompletionReviewer } from "./moss-completion-review";
import { getSupabaseAdmin } from "./supabase";

const AUTHORIZATION_TTL_SECONDS = 10 * 60;

export type CompletionLearningState = {
  cardId: Hex;
  reps: number;
  lapses: number;
  lastReviewedAt: string | null;
};

type CompletionProject = {
  projectKind: "UPLOAD" | "PACK";
  status: string;
  projectDeckRoot: Hex | null;
  cards: CompletionLearningState[];
};

type RegistryCompletionProject = {
  learner: Address;
  projectDeckRoot: Hex;
  status: number;
};

type CompletionContractState = {
  sourceRegistry: Address;
  attestor: Address;
  claimedBy: Address;
};

export interface LearningCompletionStore {
  load(projectId: Hex, owner: Address): Promise<CompletionProject | null>;
}

export interface LearningCompletionChainReader {
  readRegistryProject(projectId: Hex): Promise<RegistryCompletionProject>;
  readCompletionContract(projectId: Hex): Promise<CompletionContractState>;
}

export interface LearningCompletionAuthorizationSigner {
  address: Address;
  sign(input: {
    projectId: Hex;
    learner: Address;
    projectDeckRoot: Hex;
    progressHash: Hex;
    deadline: number;
  }): Promise<Hex>;
}

export interface LearningCompletionMossReviewer {
  review(input: {
    learner: Address;
    authorization: CompletionClaimAuthorization;
  }): Promise<MossOnchainReview>;
}

type CompletionDependencies = {
  chainId: number;
  registryAddress: Address;
  completionRegistryAddress: Address | null;
  store: LearningCompletionStore;
  chain: LearningCompletionChainReader | null;
  signer: LearningCompletionAuthorizationSigner | null;
  reviewer?: LearningCompletionMossReviewer | null;
  now: () => Date;
};

class SupabaseLearningCompletionStore implements LearningCompletionStore {
  async load(projectId: Hex, owner: Address): Promise<CompletionProject | null> {
    const client = getSupabaseAdmin();
    const [projectResult, cardResult, stateResult] = await Promise.all([
      client.from("learning_projects")
        .select("project_kind,status,project_deck_root")
        .eq("project_id", projectId).eq("owner_address", owner).maybeSingle(),
      client.from("knowledge_cards")
        .select("card_id").eq("project_id", projectId).order("card_id"),
      client.from("card_learning_states")
        .select("card_id,reps,lapses,last_reviewed_at")
        .eq("project_id", projectId).eq("owner_address", owner).order("card_id"),
    ]);
    const firstError = [projectResult.error, cardResult.error, stateResult.error].find(Boolean);
    if (firstError) throw new Error(`Could not load completion eligibility: ${firstError.message}`);
    if (!projectResult.data) return null;
    const states = new Map((stateResult.data ?? []).map((state) => [state.card_id, state]));
    return {
      projectKind: projectResult.data.project_kind as "UPLOAD" | "PACK",
      status: projectResult.data.status,
      projectDeckRoot: projectResult.data.project_deck_root as Hex | null,
      cards: (cardResult.data ?? []).map((card) => {
        const state = states.get(card.card_id);
        return {
          cardId: card.card_id as Hex,
          reps: Number(state?.reps ?? 0),
          lapses: Number(state?.lapses ?? 0),
          lastReviewedAt: state?.last_reviewed_at ?? null,
        };
      }),
    };
  }
}

class ViemLearningCompletionChainReader implements LearningCompletionChainReader {
  private readonly client;

  constructor(
    rpcUrl: string,
    chainId: number,
    private readonly registryAddress: Address,
    private readonly completionRegistryAddress: Address,
  ) {
    this.client = createPublicClient({
      chain: defineChain({
        id: chainId,
        name: `Monad ${chainId}`,
        nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
      }),
      transport: http(rpcUrl, { timeout: 12_000 }),
    });
  }

  async readRegistryProject(projectId: Hex): Promise<RegistryCompletionProject> {
    const result = await this.client.readContract({
      address: this.registryAddress,
      abi: learningProjectRegistryV2Abi,
      functionName: "projects",
      args: [projectId],
    });
    return { learner: result[0], projectDeckRoot: result[5], status: Number(result[10]) };
  }

  async readCompletionContract(projectId: Hex): Promise<CompletionContractState> {
    const results = await this.client.multicall({
      allowFailure: false,
      contracts: [
        { address: this.completionRegistryAddress, abi: learningCompletionRegistryAbi, functionName: "sourceRegistry" },
        { address: this.completionRegistryAddress, abi: learningCompletionRegistryAbi, functionName: "attestor" },
        { address: this.completionRegistryAddress, abi: learningCompletionRegistryAbi, functionName: "completions", args: [projectId] },
      ],
    });
    return { sourceRegistry: results[0], attestor: results[1], claimedBy: results[2][0] };
  }
}

class ViemLearningCompletionAuthorizationSigner implements LearningCompletionAuthorizationSigner {
  private readonly account;
  readonly address: Address;

  constructor(
    privateKey: Hex,
    private readonly chainId: number,
    private readonly completionRegistryAddress: Address,
  ) {
    this.account = privateKeyToAccount(privateKey);
    this.address = this.account.address;
  }

  sign(input: {
    projectId: Hex;
    learner: Address;
    projectDeckRoot: Hex;
    progressHash: Hex;
    deadline: number;
  }): Promise<Hex> {
    return this.account.signTypedData({
      domain: {
        name: "Mindmark Learning Completion",
        version: "1",
        chainId: this.chainId,
        verifyingContract: this.completionRegistryAddress,
      },
      types: {
        CompletionAuthorization: [
          { name: "projectId", type: "bytes32" },
          { name: "learner", type: "address" },
          { name: "projectDeckRoot", type: "bytes32" },
          { name: "progressHash", type: "bytes32" },
          { name: "deadline", type: "uint64" },
        ],
      },
      primaryType: "CompletionAuthorization",
      message: { ...input, deadline: BigInt(input.deadline) },
    });
  }
}

export function hashCompletionProgress(input: {
  projectId: Hex;
  owner: Address;
  projectDeckRoot: Hex;
  cards: CompletionLearningState[];
}): Hex {
  const cards = [...input.cards]
    .sort((left, right) => left.cardId.localeCompare(right.cardId))
    .map((card) => ({
      cardId: card.cardId.toLowerCase(),
      reps: card.reps,
      lapses: card.lapses,
      lastReviewedAt: card.lastReviewedAt,
    }));
  return keccak256(stringToHex(canonicalJson({
    domain: "MINDMARK_LEARNING_COMPLETION_V1",
    projectId: input.projectId.toLowerCase(),
    owner: input.owner.toLowerCase(),
    projectDeckRoot: input.projectDeckRoot.toLowerCase(),
    cardCount: cards.length,
    masteredCount: cards.filter((card) => card.reps >= 3 && card.lapses === 0).length,
    cards,
  })));
}

function defaultDependencies(): CompletionDependencies {
  const environment = getServerEnvironment();
  const completionRegistryAddress = environment.COMPLETION_REGISTRY_ADDRESS ?? null;
  const chain = completionRegistryAddress
    ? new ViemLearningCompletionChainReader(
      environment.MONAD_RPC_URL,
      environment.MONAD_CHAIN_ID,
      environment.REGISTRY_V2_ADDRESS,
      completionRegistryAddress,
    )
    : null;
  const signer = completionRegistryAddress && environment.COMPLETION_ATTESTOR_PRIVATE_KEY
    ? new ViemLearningCompletionAuthorizationSigner(
      environment.COMPLETION_ATTESTOR_PRIVATE_KEY as Hex,
      environment.MONAD_CHAIN_ID,
      completionRegistryAddress,
    )
    : null;
  return {
    chainId: environment.MONAD_CHAIN_ID,
    registryAddress: environment.REGISTRY_V2_ADDRESS,
    completionRegistryAddress,
    store: new SupabaseLearningCompletionStore(),
    chain,
    signer,
    reviewer: completionRegistryAddress
      ? new MossCompletionReviewer({
        rpcUrl: environment.MONAD_RPC_URL,
        chainId: environment.MONAD_CHAIN_ID,
      })
      : null,
    now: () => new Date(),
  };
}

async function evaluateCompletionClaim(
  projectId: Hex,
  owner: Address,
  dependencies: CompletionDependencies,
): Promise<{ status: CompletionClaimStatus; project: CompletionProject | null; progressHash: Hex | null }> {
  const base = {
    projectId,
    contractAddress: dependencies.completionRegistryAddress,
    projectDeckRoot: null,
    cardCount: 0,
    masteredCount: 0,
  };
  if (!dependencies.completionRegistryAddress || !dependencies.chain || !dependencies.signer) {
    return {
      status: CompletionClaimStatusSchema.parse({
        ...base, enabled: false, eligible: false, claimed: false, reason: "NOT_CONFIGURED",
      }),
      project: null,
      progressHash: null,
    };
  }
  const project = await dependencies.store.load(projectId, owner);
  if (!project) throw new ApiError(404, "project_not_found", "Learning Project was not found");
  const masteredCount = project.cards.filter((card) => card.reps >= 3 && card.lapses === 0).length;
  const statusBase = {
    ...base,
    enabled: true,
    projectDeckRoot: project.projectDeckRoot,
    cardCount: project.cards.length,
    masteredCount,
  };
  if (project.projectKind === "PACK") {
    return { status: CompletionClaimStatusSchema.parse({ ...statusBase, eligible: false, claimed: false, reason: "PACK_PROJECT" }), project, progressHash: null };
  }
  if (project.status !== "READY" || !project.projectDeckRoot) {
    return { status: CompletionClaimStatusSchema.parse({ ...statusBase, eligible: false, claimed: false, reason: "PROJECT_NOT_READY" }), project, progressHash: null };
  }
  if (project.cards.length === 0) {
    return { status: CompletionClaimStatusSchema.parse({ ...statusBase, eligible: false, claimed: false, reason: "NO_CARDS" }), project, progressHash: null };
  }
  if (masteredCount !== project.cards.length) {
    return { status: CompletionClaimStatusSchema.parse({ ...statusBase, eligible: false, claimed: false, reason: "MASTERY_INCOMPLETE" }), project, progressHash: null };
  }

  let registryProject: RegistryCompletionProject;
  let completionContract: CompletionContractState;
  try {
    [registryProject, completionContract] = await Promise.all([
      dependencies.chain.readRegistryProject(projectId),
      dependencies.chain.readCompletionContract(projectId),
    ]);
  } catch {
    throw new ApiError(503, "monad_rpc_unavailable", "Monad completion state is temporarily unavailable");
  }
  const chainMatches = registryProject.status === 2
    && registryProject.learner.toLowerCase() === owner.toLowerCase()
    && registryProject.projectDeckRoot.toLowerCase() === project.projectDeckRoot.toLowerCase()
    && completionContract.sourceRegistry.toLowerCase() === dependencies.registryAddress.toLowerCase()
    && completionContract.attestor.toLowerCase() === dependencies.signer.address.toLowerCase();
  if (!chainMatches) {
    return { status: CompletionClaimStatusSchema.parse({ ...statusBase, eligible: false, claimed: false, reason: "CHAIN_MISMATCH" }), project, progressHash: null };
  }
  if (completionContract.claimedBy !== zeroAddress) {
    return { status: CompletionClaimStatusSchema.parse({ ...statusBase, eligible: false, claimed: true, reason: "ALREADY_CLAIMED" }), project, progressHash: null };
  }
  const progressHash = hashCompletionProgress({
    projectId,
    owner,
    projectDeckRoot: project.projectDeckRoot,
    cards: project.cards,
  });
  return {
    status: CompletionClaimStatusSchema.parse({ ...statusBase, eligible: true, claimed: false, reason: "AVAILABLE" }),
    project,
    progressHash,
  };
}

export async function getLearningCompletionClaimStatus(
  projectId: Hex,
  owner: Address,
  dependencies: CompletionDependencies = defaultDependencies(),
): Promise<CompletionClaimStatus> {
  return (await evaluateCompletionClaim(projectId, owner, dependencies)).status;
}

export async function authorizeLearningCompletionClaim(
  projectId: Hex,
  owner: Address,
  dependencies: CompletionDependencies = defaultDependencies(),
): Promise<CompletionClaimAuthorization> {
  const evaluation = await evaluateCompletionClaim(projectId, owner, dependencies);
  if (!evaluation.status.enabled || !dependencies.completionRegistryAddress || !dependencies.signer) {
    throw new ApiError(503, "completion_not_configured", "Learning Completion Attestation is not configured");
  }
  if (!evaluation.status.eligible || !evaluation.project?.projectDeckRoot || !evaluation.progressHash) {
    throw new ApiError(409, "completion_not_eligible", `Completion claim is not available: ${evaluation.status.reason}`);
  }
  const deadline = Math.floor(dependencies.now().getTime() / 1_000) + AUTHORIZATION_TTL_SECONDS;
  const signature = await dependencies.signer.sign({
    projectId,
    learner: owner,
    projectDeckRoot: evaluation.project.projectDeckRoot,
    progressHash: evaluation.progressHash,
    deadline,
  });
  return CompletionClaimAuthorizationSchema.parse({
    projectId,
    contractAddress: dependencies.completionRegistryAddress,
    projectDeckRoot: evaluation.project.projectDeckRoot,
    progressHash: evaluation.progressHash,
    deadline,
    signature,
  });
}

export async function reviewLearningCompletionClaim(
  projectId: Hex,
  owner: Address,
  dependencies: CompletionDependencies = defaultDependencies(),
): Promise<CompletionClaimReview> {
  const authorization = await authorizeLearningCompletionClaim(projectId, owner, dependencies);
  if (!dependencies.reviewer) {
    throw new ApiError(503, "moss_not_configured", "Moss completion review is not configured");
  }
  let mossReview: MossOnchainReview;
  try {
    mossReview = await dependencies.reviewer.review({ learner: owner, authorization });
  } catch (error) {
    throw new ApiError(
      409,
      "moss_simulation_blocked",
      error instanceof Error ? error.message : "Moss blocked the completion claim",
    );
  }
  return CompletionClaimReviewSchema.parse({ authorization, mossReview });
}
