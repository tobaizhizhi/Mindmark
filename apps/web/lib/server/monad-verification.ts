import {
  learningCompletionRegistryAbi,
  learningProjectEscrowAbi,
  learningProjectRegistryV2Abi,
  MOSS_SDK_VERSION,
  MonadVerificationSnapshotSchema,
  mossNetworkSupport,
  WORK_UNIT_PRICING_POLICY_VERSION,
  type MonadEvidenceState,
  type MonadVerificationSnapshot,
} from "@mindmark/shared";
import {
  createPublicClient,
  decodeFunctionData,
  defineChain,
  encodeFunctionData,
  formatEther,
  http,
  keccak256,
  parseEventLogs,
  parseAbi,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { getServerEnvironment } from "./config";
import { ApiError } from "./http";
import { getSupabaseAdmin } from "./supabase";

const PROJECT_STATUSES = ["NONE", "CREATED", "READY", "CANCELLED"] as const;
const CHAPTER_STATUSES = ["NONE", "OPEN", "READY"] as const;

const legacyLearningProjectEscrowAbi = parseAbi([
  "function projectEscrows(bytes32 projectId) view returns (address sponsor, uint128 rewardPerWorkUnit, uint128 remainingBudget, uint16 workUnitCount, uint16 settledWorkUnitCount, uint64 fundedBlock, bool refunded)",
]);

function releaseRewardCalldata(projectId: Hex, workUnitId: number): Hex {
  return encodeFunctionData({
    abi: learningProjectEscrowAbi,
    functionName: "releaseReward",
    args: [projectId, workUnitId],
  });
}

type ChainProject = {
  learner: Address;
  sourceHash: Hex;
  goalHash: Hex;
  outlineHash: Hex;
  workUnitManifestRoot: Hex;
  projectDeckRoot: Hex;
  initialPlanHash: Hex;
  chapterCount: number;
  workUnitCount: number;
  totalCardCount: number;
  status: typeof PROJECT_STATUSES[number];
};

type ChainChapter = {
  sourceHash: Hex;
  cardsRoot: Hex;
  firstWorkUnitId: number;
  workUnitCount: number;
  cardCount: number;
  status: typeof CHAPTER_STATUSES[number];
};

type ChainWorkUnit = {
  chapterId: number;
  sourceUnitHash: Hex;
  workerCardsRoot: Hex;
  worker: Address;
  committedBlock: bigint;
  cardCount: number;
};

type EscrowRelease = {
  from: Address;
  projectId: Hex | null;
  workUnitId: number | null;
  worker: Address | null;
  amountWei: bigint | null;
  blockNumber: bigint | null;
  succeeded: boolean;
};

type ChainSponsorBudget = {
  pricingMode: "DYNAMIC" | "LEGACY_FIXED";
  sponsor: Address;
  pricingRoot: Hex;
  rewardPerWorkUnitWei: bigint | null;
  totalBudgetWei: bigint;
  remainingBudgetWei: bigint;
  workUnitCount: number;
  settledWorkUnitCount: number;
  fundedBlock: bigint;
  refunded: boolean;
  rewardAmountsWei: bigint[];
};

type ChainCompletion = {
  learner: Address;
  projectDeckRoot: Hex;
  progressHash: Hex;
  completedBlock: bigint;
};

type LocalEvidence = {
  project: {
    ownerAddress: Address;
    status: string;
    sourceHash: Hex;
    goalHash: Hex;
    outlineHash: Hex;
    workUnitManifestRoot: Hex | null;
    projectDeckRoot: Hex | null;
    initialPlanHash: Hex | null;
    totalCardCount: number;
    createTransactionHash: Hex | null;
    finalizeTransactionHash: Hex | null;
    escrowAddress: Address | null;
    sponsorAddress: Address | null;
    pricingPolicyVersion: string | null;
    pricingRoot: Hex | null;
    rewardPerWorkUnitWei: bigint | null;
    totalBudgetWei: bigint | null;
    remainingBudgetWei: bigint | null;
    escrowWorkUnitCount: number | null;
    settledWorkUnitCount: number | null;
    fundingTransactionHash: Hex | null;
    fundedBlock: bigint | null;
    escrowState: "UNFUNDED" | "FUNDED" | "REFUNDED";
  } | null;
  chapters: Array<{
    chapterId: number;
    sourceHash: Hex;
    cardsRoot: Hex | null;
    cardCount: number;
    transactionHash: Hex | null;
  }>;
  workUnits: Array<{
    workUnitId: number;
    chapterId: number;
    sourceUnitHash: Hex;
    cardsRoot: Hex | null;
    worker: Address | null;
    cardCount: number | null;
    transactionHash: Hex | null;
    confirmedBlock: bigint | null;
    workloadScore: number | null;
    rewardTier: "S" | "M" | "L" | "XL" | null;
    rewardAmountWei: bigint | null;
  }>;
  rewards: Array<{
    workUnitId: number;
    escrowAddress: Address;
    treasury: Address;
    recipient: Address;
    amountWei: bigint;
    status: string;
    transactionHash: Hex | null;
    confirmedBlock: bigint | null;
    mossStage: "PENDING" | "DISCOVERED" | "LOADED" | "BUILT" | "SIMULATED";
    mossPlanHash: Hex | null;
    simulationStatus: "NOT_RUN" | "PASSED" | "FAILED";
    simulationWarningCodes: string[];
    simulationGas: bigint | null;
  }>;
};

export interface MonadVerificationChainReader {
  getBlockNumber(): Promise<bigint>;
  readProject(projectId: Hex): Promise<ChainProject>;
  readChapters(projectId: Hex, count: number): Promise<ChainChapter[]>;
  readWorkUnits(projectId: Hex, count: number): Promise<ChainWorkUnit[]>;
  readProjectEscrow(projectId: Hex): Promise<ChainSponsorBudget>;
  readEscrowRelease(transactionHash: Hex): Promise<EscrowRelease>;
  readCompletion(projectId: Hex): Promise<ChainCompletion | null>;
}

export interface MonadVerificationEvidenceStore {
  load(projectId: Hex): Promise<LocalEvidence>;
}

type VerificationConfiguration = {
  chainId: number;
  registryAddress: Address;
  escrowAddress: Address;
  completionRegistryAddress?: Address;
  explorerUrl: string;
};

class ViemMonadVerificationChainReader implements MonadVerificationChainReader {
  private readonly client;

  constructor(
    rpcUrl: string,
    chainId: number,
    private readonly registryAddress: Address,
    private readonly escrowAddress: Address,
    private readonly completionRegistryAddress?: Address,
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

  getBlockNumber() {
    return this.client.getBlockNumber();
  }

  async readProject(projectId: Hex): Promise<ChainProject> {
    const result = await this.client.readContract({
      address: this.registryAddress,
      abi: learningProjectRegistryV2Abi,
      functionName: "projects",
      args: [projectId],
    });
    const status = PROJECT_STATUSES[Number(result[10])];
    if (!status) throw new Error(`Registry returned unknown Project status ${result[10]}`);
    return {
      learner: result[0], sourceHash: result[1], goalHash: result[2], outlineHash: result[3],
      workUnitManifestRoot: result[4], projectDeckRoot: result[5], initialPlanHash: result[6],
      chapterCount: Number(result[7]), workUnitCount: Number(result[8]),
      totalCardCount: Number(result[9]), status,
    };
  }

  async readChapters(projectId: Hex, count: number): Promise<ChainChapter[]> {
    if (count === 0) return [];
    const results = await this.readRegistryRows(count, (chapterId) =>
      this.client.readContract({
        address: this.registryAddress,
        abi: learningProjectRegistryV2Abi,
        functionName: "chapters" as const,
        args: [projectId, chapterId] as const,
      }));
    return results.map((result) => {
      const status = CHAPTER_STATUSES[Number(result[5])];
      if (!status) throw new Error(`Registry returned unknown Chapter status ${result[5]}`);
      return {
        sourceHash: result[0], cardsRoot: result[1], firstWorkUnitId: Number(result[2]),
        workUnitCount: Number(result[3]), cardCount: Number(result[4]), status,
      };
    });
  }

  async readWorkUnits(projectId: Hex, count: number): Promise<ChainWorkUnit[]> {
    if (count === 0) return [];
    const results = await this.readRegistryRows(count, (workUnitId) =>
      this.client.readContract({
        address: this.registryAddress,
        abi: learningProjectRegistryV2Abi,
        functionName: "workUnits" as const,
        args: [projectId, workUnitId] as const,
      }));
    return results.map((result) => ({
      chapterId: Number(result[0]), sourceUnitHash: result[1], workerCardsRoot: result[2],
      worker: result[3], committedBlock: result[4], cardCount: Number(result[5]),
    }));
  }

  async readProjectEscrow(projectId: Hex): Promise<ChainSponsorBudget> {
    try {
      const result = await this.client.readContract({
        address: this.escrowAddress,
        abi: learningProjectEscrowAbi,
        functionName: "projectEscrows",
        args: [projectId],
      });
      const workUnitCount = Number(result[4]);
      const rewardAmountsWei = await this.readRegistryRows(workUnitCount, (workUnitId) =>
        this.client.readContract({
          address: this.escrowAddress,
          abi: learningProjectEscrowAbi,
          functionName: "workUnitRewardAmounts" as const,
          args: [projectId, workUnitId] as const,
        }));
      return {
        pricingMode: "DYNAMIC",
        sponsor: result[0],
        pricingRoot: result[1],
        rewardPerWorkUnitWei: null,
        totalBudgetWei: result[2],
        remainingBudgetWei: result[3],
        workUnitCount,
        settledWorkUnitCount: Number(result[5]),
        fundedBlock: result[6],
        refunded: result[7],
        rewardAmountsWei,
      };
    } catch (error) {
      try {
        const result = await this.client.readContract({
          address: this.escrowAddress,
          abi: legacyLearningProjectEscrowAbi,
          functionName: "projectEscrows",
          args: [projectId],
        });
        const workUnitCount = Number(result[3]);
        return {
          pricingMode: "LEGACY_FIXED",
          sponsor: result[0],
          pricingRoot: zeroHash,
          rewardPerWorkUnitWei: result[1],
          totalBudgetWei: result[1] * BigInt(workUnitCount),
          remainingBudgetWei: result[2],
          workUnitCount,
          settledWorkUnitCount: Number(result[4]),
          fundedBlock: result[5],
          refunded: result[6],
          rewardAmountsWei: Array.from({ length: workUnitCount }, () => result[1]),
        };
      } catch {
        throw error;
      }
    }
  }

  async readEscrowRelease(transactionHash: Hex): Promise<EscrowRelease> {
    const [transaction, receipt] = await Promise.all([
      this.client.getTransaction({ hash: transactionHash }),
      this.client.getTransactionReceipt({ hash: transactionHash }),
    ]);
    let projectId: Hex | null = null;
    let workUnitId: number | null = null;
    if (transaction.to && transaction.to.toLowerCase() === this.escrowAddress.toLowerCase()) {
      try {
        const decoded = decodeFunctionData({ abi: learningProjectEscrowAbi, data: transaction.input });
        if (decoded.functionName === "releaseReward") {
          projectId = decoded.args[0];
          workUnitId = Number(decoded.args[1]);
        }
      } catch {
        // The caller will classify malformed Escrow calldata as a mismatch.
      }
    }
    const events = parseEventLogs({
      abi: learningProjectEscrowAbi,
      eventName: "RewardReleased",
      logs: receipt.logs.filter((log) => log.address.toLowerCase() === this.escrowAddress.toLowerCase()),
      strict: true,
    });
    const event = events.find((candidate) =>
      candidate.args.projectId === projectId && Number(candidate.args.workUnitId) === workUnitId);
    return {
      from: transaction.from,
      projectId,
      workUnitId,
      worker: event?.args.worker ?? null,
      amountWei: event?.args.amount ?? null,
      blockNumber: receipt.blockNumber,
      succeeded: receipt.status === "success" && transaction.value === 0n,
    };
  }

  async readCompletion(projectId: Hex): Promise<ChainCompletion | null> {
    if (!this.completionRegistryAddress) return null;
    const result = await this.client.readContract({
      address: this.completionRegistryAddress,
      abi: learningCompletionRegistryAbi,
      functionName: "completions",
      args: [projectId],
    });
    if (result[0] === zeroAddress) return null;
    return {
      learner: result[0], projectDeckRoot: result[1], progressHash: result[2], completedBlock: result[3],
    };
  }

  private async readRegistryRows<T>(count: number, read: (index: number) => Promise<T>): Promise<T[]> {
    const rows: T[] = [];
    const concurrency = 8;
    for (let offset = 0; offset < count; offset += concurrency) {
      const batchSize = Math.min(concurrency, count - offset);
      rows.push(...await Promise.all(
        Array.from({ length: batchSize }, (_, index) => read(offset + index)),
      ));
    }
    return rows;
  }
}

class SupabaseMonadVerificationEvidenceStore implements MonadVerificationEvidenceStore {
  async load(projectId: Hex): Promise<LocalEvidence> {
    const client = getSupabaseAdmin();
    const [projectResult, chapterResult, workUnitResult, rewardResult] = await Promise.all([
      client.from("learning_projects")
        .select("owner_address,status,source_hash,goal_hash,outline_hash,work_unit_manifest_root,project_deck_root,initial_plan_hash,total_card_count,create_tx_hash,finalize_tx_hash,project_escrow_address,sponsor_treasury_address,reward_per_work_unit_wei,pricing_policy_version,pricing_root,escrow_total_budget_wei,escrow_remaining_budget_wei,escrow_work_unit_count,escrow_settled_work_unit_count,escrow_funding_tx_hash,escrow_funded_block,escrow_state")
        .eq("project_id", projectId).maybeSingle(),
      client.from("chapters")
        .select("chapter_id,source_hash,cards_root,card_count,finalize_tx_hash")
        .eq("project_id", projectId).order("chapter_id"),
      client.from("work_units")
        .select("work_unit_id,chapter_id,source_unit_hash,cards_root,worker_address,card_count,commit_tx_hash,confirmed_block,workload_score,reward_tier,reward_amount_wei")
        .eq("project_id", projectId).order("work_unit_id"),
      client.from("work_unit_rewards")
        .select("work_unit_id,escrow_address,treasury_address,recipient_address,amount_wei,status,tx_hash,confirmed_block,moss_stage,moss_plan_hash,simulation_status,simulation_warning_codes,simulation_gas")
        .eq("project_id", projectId).order("work_unit_id"),
    ]);
    const firstError = [projectResult.error, chapterResult.error, workUnitResult.error, rewardResult.error]
      .find(Boolean);
    if (firstError) throw new Error(`Could not load Monad verification evidence: ${firstError.message}`);
    const project = projectResult.data;
    return {
      project: project ? {
        ownerAddress: project.owner_address as Address,
        status: project.status,
        sourceHash: project.source_hash as Hex,
        goalHash: project.goal_hash as Hex,
        outlineHash: project.outline_hash as Hex,
        workUnitManifestRoot: project.work_unit_manifest_root as Hex | null,
        projectDeckRoot: project.project_deck_root as Hex | null,
        initialPlanHash: project.initial_plan_hash as Hex | null,
        totalCardCount: Number(project.total_card_count),
        createTransactionHash: project.create_tx_hash as Hex | null,
        finalizeTransactionHash: project.finalize_tx_hash as Hex | null,
        escrowAddress: project.project_escrow_address as Address | null,
        sponsorAddress: project.sponsor_treasury_address as Address | null,
        pricingPolicyVersion: project.pricing_policy_version,
        pricingRoot: project.pricing_root as Hex | null,
        rewardPerWorkUnitWei: project.reward_per_work_unit_wei === null
          ? null
          : BigInt(project.reward_per_work_unit_wei),
        totalBudgetWei: project.escrow_total_budget_wei === null ? null : BigInt(project.escrow_total_budget_wei),
        remainingBudgetWei: project.escrow_remaining_budget_wei === null ? null : BigInt(project.escrow_remaining_budget_wei),
        escrowWorkUnitCount: project.escrow_work_unit_count === null ? null : Number(project.escrow_work_unit_count),
        settledWorkUnitCount: project.escrow_settled_work_unit_count === null ? null : Number(project.escrow_settled_work_unit_count),
        fundingTransactionHash: project.escrow_funding_tx_hash as Hex | null,
        fundedBlock: project.escrow_funded_block === null ? null : BigInt(project.escrow_funded_block),
        escrowState: project.escrow_state as "UNFUNDED" | "FUNDED" | "REFUNDED",
      } : null,
      chapters: (chapterResult.data ?? []).map((row) => ({
        chapterId: Number(row.chapter_id), sourceHash: row.source_hash as Hex,
        cardsRoot: row.cards_root as Hex | null, cardCount: Number(row.card_count),
        transactionHash: row.finalize_tx_hash as Hex | null,
      })),
      workUnits: (workUnitResult.data ?? []).map((row) => ({
        workUnitId: Number(row.work_unit_id), chapterId: Number(row.chapter_id),
        sourceUnitHash: row.source_unit_hash as Hex, cardsRoot: row.cards_root as Hex | null,
        worker: row.worker_address as Address | null, cardCount: row.card_count === null ? null : Number(row.card_count),
        transactionHash: row.commit_tx_hash as Hex | null,
        confirmedBlock: row.confirmed_block === null ? null : BigInt(row.confirmed_block),
        workloadScore: row.workload_score === null ? null : Number(row.workload_score),
        rewardTier: row.reward_tier as LocalEvidence["workUnits"][number]["rewardTier"],
        rewardAmountWei: row.reward_amount_wei === null ? null : BigInt(row.reward_amount_wei),
      })),
      rewards: (rewardResult.data ?? []).map((row) => ({
        workUnitId: Number(row.work_unit_id), escrowAddress: row.escrow_address as Address,
        treasury: row.treasury_address as Address,
        recipient: row.recipient_address as Address, amountWei: BigInt(row.amount_wei),
        status: row.status, transactionHash: row.tx_hash as Hex | null,
        confirmedBlock: row.confirmed_block === null ? null : BigInt(row.confirmed_block),
        mossStage: row.moss_stage as LocalEvidence["rewards"][number]["mossStage"],
        mossPlanHash: row.moss_plan_hash as Hex | null,
        simulationStatus: row.simulation_status as LocalEvidence["rewards"][number]["simulationStatus"],
        simulationWarningCodes: Array.isArray(row.simulation_warning_codes)
          ? row.simulation_warning_codes.map(String)
          : [],
        simulationGas: row.simulation_gas === null ? null : BigInt(row.simulation_gas),
      })),
    };
  }
}

function sameHex(left: string | null | undefined, right: string | null | undefined) {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function localChapterState(chain: ChainChapter, local: LocalEvidence["chapters"][number] | undefined): MonadEvidenceState {
  if (!local) return "UNAVAILABLE";
  if (!sameHex(chain.sourceHash, local.sourceHash)) return "MISMATCH";
  if (chain.status === "READY") {
    return sameHex(chain.cardsRoot, local.cardsRoot) && chain.cardCount === local.cardCount
      ? "VERIFIED" : "MISMATCH";
  }
  if (local.transactionHash) return "MISMATCH";
  return "PENDING";
}

function localWorkUnitState(chain: ChainWorkUnit, local: LocalEvidence["workUnits"][number] | undefined): MonadEvidenceState {
  if (chain.worker === zeroAddress) return local?.confirmedBlock === null || !local
    ? "PENDING" : "MISMATCH";
  if (!local) return "UNAVAILABLE";
  return sameHex(chain.sourceUnitHash, local.sourceUnitHash)
    && sameHex(chain.workerCardsRoot, local.cardsRoot)
    && sameHex(chain.worker, local.worker)
    && chain.cardCount === local.cardCount
    ? "VERIFIED" : "MISMATCH";
}

async function rewardSnapshot(
  reward: LocalEvidence["rewards"][number],
  workUnit: ChainWorkUnit | undefined,
  chain: MonadVerificationChainReader,
  chainId: number,
  projectId: Hex,
): Promise<MonadVerificationSnapshot["rewards"][number]> {
  let evidenceState: MonadEvidenceState = "PENDING";
  let detail: string | null = reward.status === "BLOCKED" ? "Reward 已阻止，等待运维处理" : null;
  if (reward.status === "CONFIRMED") {
    if (!reward.transactionHash || !workUnit || workUnit.worker === zeroAddress) {
      evidenceState = "MISMATCH";
      detail = "已确认 Reward 缺少交易或 Work Unit 收款证据";
    } else {
      try {
        const release = await chain.readEscrowRelease(reward.transactionHash);
        const matches = release.succeeded
          && sameHex(release.from, reward.treasury)
          && release.projectId === projectId
          && release.workUnitId === reward.workUnitId
          && sameHex(release.worker, reward.recipient)
          && sameHex(reward.recipient, workUnit.worker)
          && release.amountWei === reward.amountWei
          && (reward.confirmedBlock === null || release.blockNumber === reward.confirmedBlock);
        evidenceState = matches ? "VERIFIED" : "MISMATCH";
        detail = matches ? "Escrow release、Registry Worker 与 Reward intent 完全一致" : "Monad Escrow 交易与 Reward intent 不一致";
      } catch {
        evidenceState = "UNAVAILABLE";
        detail = "RPC 暂时无法读取 Reward 交易";
      }
    }
  }
  return {
    workUnitId: reward.workUnitId,
    escrowAddress: reward.escrowAddress,
    treasury: reward.treasury,
    recipient: reward.recipient,
    amountWei: reward.amountWei.toString(),
    status: reward.status,
    transactionHash: reward.transactionHash,
    confirmedBlock: reward.confirmedBlock?.toString() ?? null,
    evidenceState,
    detail,
    mossReview: {
      sdkVersion: MOSS_SDK_VERSION,
      networkSupport: mossNetworkSupport(chainId),
      operation: "WORKER_REWARD",
      intent: `向已提交 WU.${String(reward.workUnitId).padStart(2, "0")} 承诺的 Worker 支付 ${formatEther(reward.amountWei)} MON`,
      capability: {
        protocol: "mindmark-escrow",
        method: "releaseWorkUnitReward",
        verb: "transfer",
        category: "rewards",
        declaredRisks: ["fundOut"],
      },
      account: reward.treasury,
      target: reward.escrowAddress,
      valueWei: "0",
      calldataHash: reward.mossPlanHash ? keccak256(releaseRewardCalldata(projectId, reward.workUnitId)) : null,
      stage: reward.mossStage,
      planHash: reward.mossPlanHash,
      simulation: {
        status: reward.simulationStatus,
        warningCodes: reward.simulationWarningCodes,
        gas: reward.simulationGas?.toString() ?? null,
      },
      expectedEffects: {
        nativeOutWei: "0",
        recipient: reward.recipient,
        approvalCount: 0,
      },
      signerAuthority: "REWARD_TREASURY",
    },
  };
}

function defaultDependencies() {
  const environment = getServerEnvironment();
  const configuration: VerificationConfiguration = {
    chainId: environment.MONAD_CHAIN_ID,
    registryAddress: environment.REGISTRY_V2_ADDRESS,
    escrowAddress: environment.PROJECT_ESCROW_ADDRESS,
    completionRegistryAddress: environment.COMPLETION_REGISTRY_ADDRESS,
    explorerUrl: environment.BLOCK_EXPLORER_URL,
  };
  return {
    configuration,
    chain: new ViemMonadVerificationChainReader(
      environment.MONAD_RPC_URL,
      environment.MONAD_CHAIN_ID,
      environment.REGISTRY_V2_ADDRESS,
      environment.PROJECT_ESCROW_ADDRESS,
      environment.COMPLETION_REGISTRY_ADDRESS,
    ),
    store: new SupabaseMonadVerificationEvidenceStore(),
  };
}

export async function getMonadVerificationSnapshot(
  projectId: Hex,
  dependencies?: {
    configuration: VerificationConfiguration;
    chain: MonadVerificationChainReader;
    store: MonadVerificationEvidenceStore;
  },
): Promise<MonadVerificationSnapshot> {
  const { configuration, chain, store } = dependencies ?? defaultDependencies();
  let observedBlock: bigint;
  let project: ChainProject;
  try {
    [observedBlock, project] = await Promise.all([chain.getBlockNumber(), chain.readProject(projectId)]);
  } catch {
    throw new ApiError(503, "monad_rpc_unavailable", "Monad RPC is temporarily unavailable");
  }
  if (project.status === "NONE" || project.learner === zeroAddress) {
    throw new ApiError(404, "project_not_found_on_chain", "Project was not found in Registry V2");
  }
  if (project.chapterCount > 16 || project.workUnitCount > 48) {
    throw new ApiError(502, "registry_shape_invalid", "Registry returned counts outside V2 limits");
  }

  let chapters: ChainChapter[];
  let workUnits: ChainWorkUnit[];
  let completion: ChainCompletion | null;
  let sponsorBudget: ChainSponsorBudget;
  try {
    [chapters, workUnits, completion, sponsorBudget] = await Promise.all([
      chain.readChapters(projectId, project.chapterCount),
      chain.readWorkUnits(projectId, project.workUnitCount),
      chain.readCompletion(projectId),
      chain.readProjectEscrow(projectId),
    ]);
  } catch {
    throw new ApiError(503, "monad_rpc_unavailable", "Monad evidence could not be read completely");
  }

  let localEvidence: LocalEvidence | null = null;
  try {
    localEvidence = await store.load(projectId);
  } catch {
    // Registry evidence remains useful when the optional local transaction index is unavailable.
  }
  const localProject = localEvidence?.project ?? null;
  const checks: MonadVerificationSnapshot["checks"] = [{
    key: "registry_project",
    label: "Registry Project",
    state: "VERIFIED",
    detail: `在区块 ${observedBlock} 读取到 ${project.status} 状态`,
  }];
  const networkSupport = mossNetworkSupport(configuration.chainId);
  checks.push({
    key: "moss_network_policy",
    label: "Moss 网络策略",
    state: "VERIFIED",
    detail: networkSupport === "OFFICIAL_MAINNET"
      ? `Moss ${MOSS_SDK_VERSION} 运行在官方 Monad Mainnet 143`
      : `Moss ${MOSS_SDK_VERSION} 运行在 Mindmark 实验性 Testnet 10143 模式`,
  });
  if (localProject) {
    const identityMatches = sameHex(localProject.ownerAddress, project.learner)
      && sameHex(localProject.sourceHash, project.sourceHash)
      && sameHex(localProject.goalHash, project.goalHash)
      && sameHex(localProject.outlineHash, project.outlineHash)
      && sameHex(localProject.workUnitManifestRoot, project.workUnitManifestRoot);
    checks.push({
      key: "project_commitments", label: "Project 承诺对照",
      state: identityMatches ? "VERIFIED" : "MISMATCH",
      detail: identityMatches ? "owner 与创建阶段哈希全部一致" : "本地 Project 字段与 Registry 不一致",
    });
    const finalizationMatches = project.status !== "READY"
      ? localProject.status === "READY" || Boolean(localProject.finalizeTransactionHash) ? false : null
      : sameHex(localProject.projectDeckRoot, project.projectDeckRoot)
        && sameHex(localProject.initialPlanHash, project.initialPlanHash)
        && localProject.totalCardCount === project.totalCardCount;
    checks.push({
      key: "project_finalization", label: "Project 最终卡组",
      state: finalizationMatches === null ? "PENDING" : finalizationMatches ? "VERIFIED" : "MISMATCH",
      detail: finalizationMatches === null ? "Project 尚未在 Registry 完成" : finalizationMatches ? "deckRoot、planHash 与卡片数一致" : "最终卡组证据不一致",
    });
  } else {
    checks.push({
      key: "local_evidence", label: "本地交易索引", state: "UNAVAILABLE",
      detail: "仅展示 Registry 链上状态，交易与 Reward 辅助证据当前不可用",
    });
  }

  const chapterSnapshots = chapters.map((chapter, chapterId) => {
    const local = localEvidence?.chapters.find((candidate) => candidate.chapterId === chapterId);
    return {
      chapterId, sourceHash: chapter.sourceHash, cardsRoot: chapter.cardsRoot,
      firstWorkUnitId: chapter.firstWorkUnitId, workUnitCount: chapter.workUnitCount,
      cardCount: chapter.cardCount, status: chapter.status,
      transactionHash: local?.transactionHash ?? null,
      evidenceState: localChapterState(chapter, local),
    };
  });
  const workUnitSnapshots = workUnits.map((workUnit, workUnitId) => {
    const local = localEvidence?.workUnits.find((candidate) => candidate.workUnitId === workUnitId);
    return {
      workUnitId, chapterId: workUnit.chapterId, sourceUnitHash: workUnit.sourceUnitHash,
      workerCardsRoot: workUnit.workerCardsRoot, worker: workUnit.worker,
      committedBlock: workUnit.committedBlock.toString(), cardCount: workUnit.cardCount,
      transactionHash: local?.transactionHash ?? null,
      evidenceState: localWorkUnitState(workUnit, local),
    };
  }).filter((workUnit) => workUnit.worker !== zeroAddress || workUnit.evidenceState === "MISMATCH");
  const rewards = await Promise.all((localEvidence?.rewards ?? []).map((reward) =>
    rewardSnapshot(reward, workUnits[reward.workUnitId], chain, configuration.chainId, projectId)));
  const quoteSnapshots = sponsorBudget.rewardAmountsWei.map((amount, workUnitId) => {
    const local = localEvidence?.workUnits.find((candidate) => candidate.workUnitId === workUnitId);
    const evidenceState = sponsorBudget.sponsor === zeroAddress
      ? "PENDING" as const
      : !local
        ? "UNAVAILABLE" as const
        : sponsorBudget.pricingMode === "LEGACY_FIXED"
          ? localProject?.rewardPerWorkUnitWei === amount
            ? "VERIFIED" as const
            : "MISMATCH" as const
          : local.rewardAmountWei === amount && local.workloadScore !== null && local.rewardTier !== null
          ? "VERIFIED" as const
          : "MISMATCH" as const;
    return {
      workUnitId,
      workloadScore: local?.workloadScore ?? null,
      rewardTier: local?.rewardTier ?? null,
      amountWei: amount.toString(),
      evidenceState,
    };
  });
  const localPricingMatches = sponsorBudget.pricingMode === "LEGACY_FIXED"
    ? localProject?.pricingPolicyVersion === null
      && localProject?.pricingRoot === null
      && localProject?.rewardPerWorkUnitWei === sponsorBudget.rewardPerWorkUnitWei
    : sameHex(localProject?.pricingRoot, sponsorBudget.pricingRoot)
      && localProject?.pricingPolicyVersion === WORK_UNIT_PRICING_POLICY_VERSION;
  const localBudgetMatches = Boolean(localProject)
    && sameHex(localProject?.escrowAddress, configuration.escrowAddress)
    && sameHex(localProject?.sponsorAddress, sponsorBudget.sponsor)
    && localPricingMatches
    && localProject?.totalBudgetWei === sponsorBudget.totalBudgetWei
    && localProject?.remainingBudgetWei === sponsorBudget.remainingBudgetWei
    && localProject?.escrowWorkUnitCount === sponsorBudget.workUnitCount
    && localProject?.settledWorkUnitCount === sponsorBudget.settledWorkUnitCount
    && localProject?.fundedBlock === sponsorBudget.fundedBlock
    && sponsorBudget.rewardAmountsWei.reduce((total, amount) => total + amount, 0n)
      === sponsorBudget.totalBudgetWei
    && quoteSnapshots.every((quote) => quote.evidenceState === "VERIFIED");
  const completionSnapshot = completion && configuration.completionRegistryAddress ? {
    contractAddress: configuration.completionRegistryAddress,
    learner: completion.learner,
    projectDeckRoot: completion.projectDeckRoot,
    progressHash: completion.progressHash,
    completedBlock: completion.completedBlock.toString(),
    evidenceState: sameHex(completion.learner, project.learner)
      && sameHex(completion.projectDeckRoot, project.projectDeckRoot) ? "VERIFIED" as const : "MISMATCH" as const,
  } : null;

  const allStates = [
    ...checks.map((check) => check.state),
    ...chapterSnapshots.map((chapter) => chapter.evidenceState),
    ...workUnitSnapshots.map((workUnit) => workUnit.evidenceState),
    ...rewards.filter((reward) => reward.status === "CONFIRMED").map((reward) => reward.evidenceState),
    ...(completionSnapshot ? [completionSnapshot.evidenceState] : []),
  ];
  const overallState: MonadEvidenceState = allStates.includes("MISMATCH")
    ? "MISMATCH"
    : project.status === "READY" ? "VERIFIED" : "PENDING";

  return MonadVerificationSnapshotSchema.parse({
    projectId,
    chainId: configuration.chainId,
    registryAddress: configuration.registryAddress,
    escrowAddress: configuration.escrowAddress,
    explorerUrl: configuration.explorerUrl,
    observedBlock: observedBlock.toString(),
    generatedAt: new Date().toISOString(),
    overallState,
    localEvidenceAvailable: Boolean(localProject),
    project: {
      learner: project.learner, sourceHash: project.sourceHash, goalHash: project.goalHash,
      outlineHash: project.outlineHash, workUnitManifestRoot: project.workUnitManifestRoot,
      projectDeckRoot: project.projectDeckRoot, initialPlanHash: project.initialPlanHash,
      chapterCount: project.chapterCount, workUnitCount: project.workUnitCount,
      totalCardCount: project.totalCardCount, status: project.status,
      createTransactionHash: localProject?.createTransactionHash ?? null,
      finalizeTransactionHash: localProject?.finalizeTransactionHash ?? null,
    },
    checks,
    chapters: chapterSnapshots,
    workUnits: workUnitSnapshots,
    rewards,
    sponsorBudget: {
      escrowAddress: configuration.escrowAddress,
      sponsor: sponsorBudget.sponsor,
      pricingPolicyVersion: localProject?.pricingPolicyVersion ?? null,
      pricingRoot: sponsorBudget.pricingRoot,
      totalBudgetWei: sponsorBudget.totalBudgetWei.toString(),
      remainingBudgetWei: sponsorBudget.remainingBudgetWei.toString(),
      workUnitCount: sponsorBudget.workUnitCount,
      settledWorkUnitCount: sponsorBudget.settledWorkUnitCount,
      fundingTransactionHash: localProject?.fundingTransactionHash ?? null,
      fundedBlock: sponsorBudget.fundedBlock.toString(),
      state: sponsorBudget.sponsor === zeroAddress ? "UNFUNDED" : sponsorBudget.refunded ? "REFUNDED" : "FUNDED",
      evidenceState: sponsorBudget.sponsor === zeroAddress ? "PENDING" : localBudgetMatches ? "VERIFIED" : "MISMATCH",
      quotes: quoteSnapshots,
    },
    completion: completionSnapshot,
  });
}
