import { z } from "zod";
import { AddressSchema, Bytes32Schema } from "./schemas.js";
import { MAX_PROJECT_CHAPTERS, MAX_PROJECT_WORK_UNITS } from "./project-v2.js";
import { WorkUnitRewardTierSchema } from "./work-unit-pricing.js";

export const MOSS_SDK_VERSION = "0.1.0";

export const MossNetworkSupportSchema = z.enum([
  "OFFICIAL_MAINNET",
  "EXPERIMENTAL_TESTNET",
]);

export function mossNetworkSupport(chainId: number): z.infer<typeof MossNetworkSupportSchema> {
  if (chainId === 143) return "OFFICIAL_MAINNET";
  if (chainId === 10143) return "EXPERIMENTAL_TESTNET";
  throw new Error(`Moss ${MOSS_SDK_VERSION} is not approved for chain ${chainId}`);
}

export const MossRewardStageSchema = z.enum([
  "PENDING",
  "DISCOVERED",
  "LOADED",
  "BUILT",
  "SIMULATED",
]);

export const MossOnchainReviewSchema = z.object({
  sdkVersion: z.string().min(1).max(30),
  networkSupport: MossNetworkSupportSchema,
  operation: z.enum(["WORKER_REWARD", "COMPLETION_CLAIM"]),
  intent: z.string().min(1).max(300),
  capability: z.object({
    protocol: z.string().min(1).max(80),
    method: z.string().min(1).max(80),
    verb: z.string().min(1).max(40),
    category: z.string().min(1).max(40),
    declaredRisks: z.array(z.string().min(1).max(80)).max(12),
  }).strict(),
  account: AddressSchema,
  target: AddressSchema,
  valueWei: z.string().regex(/^\d+$/u),
  calldataHash: Bytes32Schema.nullable(),
  stage: MossRewardStageSchema,
  planHash: Bytes32Schema.nullable(),
  simulation: z.object({
    status: z.enum(["NOT_RUN", "PASSED", "FAILED"]),
    warningCodes: z.array(z.string().min(1).max(100)).max(32),
    gas: z.string().regex(/^\d+$/u).nullable(),
  }).strict(),
  expectedEffects: z.object({
    nativeOutWei: z.string().regex(/^\d+$/u),
    recipient: AddressSchema.nullable(),
    approvalCount: z.number().int().nonnegative().max(32),
  }).strict(),
  signerAuthority: z.enum(["REWARD_TREASURY", "LEARNER_WALLET"]),
}).strict();

export const MonadEvidenceStateSchema = z.enum([
  "VERIFIED",
  "PENDING",
  "MISMATCH",
  "UNAVAILABLE",
]);

export const MonadProjectStatusSchema = z.enum([
  "NONE",
  "CREATED",
  "READY",
  "CANCELLED",
]);

export const MonadChapterStatusSchema = z.enum(["NONE", "OPEN", "READY"]);

export const MonadEvidenceCheckSchema = z.object({
  key: z.string().min(1).max(80),
  label: z.string().min(1).max(100),
  state: MonadEvidenceStateSchema,
  detail: z.string().min(1).max(300).nullable(),
}).strict();

export const MonadVerificationChapterSchema = z.object({
  chapterId: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS - 1),
  sourceHash: Bytes32Schema,
  cardsRoot: Bytes32Schema,
  firstWorkUnitId: z.number().int().min(0).max(MAX_PROJECT_WORK_UNITS - 1),
  workUnitCount: z.number().int().min(1).max(8),
  cardCount: z.number().int().nonnegative().max(200),
  status: MonadChapterStatusSchema,
  transactionHash: Bytes32Schema.nullable(),
  evidenceState: MonadEvidenceStateSchema,
}).strict();

export const MonadVerificationWorkUnitSchema = z.object({
  workUnitId: z.number().int().min(0).max(MAX_PROJECT_WORK_UNITS - 1),
  chapterId: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS - 1),
  sourceUnitHash: Bytes32Schema,
  workerCardsRoot: Bytes32Schema,
  worker: AddressSchema,
  committedBlock: z.string().regex(/^\d+$/u),
  cardCount: z.number().int().nonnegative().max(30),
  transactionHash: Bytes32Schema.nullable(),
  evidenceState: MonadEvidenceStateSchema,
}).strict();

export const MonadVerificationRewardSchema = z.object({
  workUnitId: z.number().int().min(0).max(MAX_PROJECT_WORK_UNITS - 1),
  escrowAddress: AddressSchema,
  treasury: AddressSchema,
  recipient: AddressSchema,
  amountWei: z.string().regex(/^\d+$/u),
  status: z.string().min(1).max(30),
  transactionHash: Bytes32Schema.nullable(),
  confirmedBlock: z.string().regex(/^\d+$/u).nullable(),
  evidenceState: MonadEvidenceStateSchema,
  detail: z.string().min(1).max(300).nullable(),
  mossReview: MossOnchainReviewSchema,
}).strict();

export const MonadVerificationSponsorBudgetSchema = z.object({
  escrowAddress: AddressSchema,
  sponsor: AddressSchema,
  pricingPolicyVersion: z.string().min(1).max(80).nullable(),
  pricingRoot: Bytes32Schema,
  totalBudgetWei: z.string().regex(/^\d+$/u),
  remainingBudgetWei: z.string().regex(/^\d+$/u),
  workUnitCount: z.number().int().min(1).max(MAX_PROJECT_WORK_UNITS),
  settledWorkUnitCount: z.number().int().min(0).max(MAX_PROJECT_WORK_UNITS),
  fundingTransactionHash: Bytes32Schema.nullable(),
  fundedBlock: z.string().regex(/^\d+$/u),
  state: z.enum(["UNFUNDED", "FUNDED", "REFUNDED"]),
  evidenceState: MonadEvidenceStateSchema,
  quotes: z.array(z.object({
    workUnitId: z.number().int().min(0).max(MAX_PROJECT_WORK_UNITS - 1),
    workloadScore: z.number().int().min(1).max(64).nullable(),
    rewardTier: WorkUnitRewardTierSchema.nullable(),
    amountWei: z.string().regex(/^\d+$/u),
    evidenceState: MonadEvidenceStateSchema,
  }).strict()).min(1).max(MAX_PROJECT_WORK_UNITS),
}).strict();

export const MonadVerificationCompletionSchema = z.object({
  contractAddress: AddressSchema,
  learner: AddressSchema,
  projectDeckRoot: Bytes32Schema,
  progressHash: Bytes32Schema,
  completedBlock: z.string().regex(/^\d+$/u),
  evidenceState: MonadEvidenceStateSchema,
}).strict();

export const MonadVerificationSnapshotSchema = z.object({
  projectId: Bytes32Schema,
  chainId: z.number().int().positive(),
  registryAddress: AddressSchema,
  escrowAddress: AddressSchema,
  explorerUrl: z.string().url(),
  observedBlock: z.string().regex(/^\d+$/u),
  generatedAt: z.string().datetime({ offset: true }),
  overallState: MonadEvidenceStateSchema,
  localEvidenceAvailable: z.boolean(),
  project: z.object({
    learner: AddressSchema,
    sourceHash: Bytes32Schema,
    goalHash: Bytes32Schema,
    outlineHash: Bytes32Schema,
    workUnitManifestRoot: Bytes32Schema,
    projectDeckRoot: Bytes32Schema,
    initialPlanHash: Bytes32Schema,
    chapterCount: z.number().int().min(0).max(MAX_PROJECT_CHAPTERS),
    workUnitCount: z.number().int().min(0).max(MAX_PROJECT_WORK_UNITS),
    totalCardCount: z.number().int().nonnegative().max(200),
    status: MonadProjectStatusSchema,
    createTransactionHash: Bytes32Schema.nullable(),
    finalizeTransactionHash: Bytes32Schema.nullable(),
  }).strict(),
  checks: z.array(MonadEvidenceCheckSchema).max(16),
  chapters: z.array(MonadVerificationChapterSchema).max(MAX_PROJECT_CHAPTERS),
  workUnits: z.array(MonadVerificationWorkUnitSchema).max(MAX_PROJECT_WORK_UNITS),
  rewards: z.array(MonadVerificationRewardSchema).max(MAX_PROJECT_WORK_UNITS),
  sponsorBudget: MonadVerificationSponsorBudgetSchema,
  completion: MonadVerificationCompletionSchema.nullable(),
}).strict();

export const CompletionClaimReasonSchema = z.enum([
  "AVAILABLE",
  "NOT_CONFIGURED",
  "PACK_PROJECT",
  "PROJECT_NOT_READY",
  "NO_CARDS",
  "MASTERY_INCOMPLETE",
  "ALREADY_CLAIMED",
  "CHAIN_MISMATCH",
]);

export const CompletionClaimStatusSchema = z.object({
  projectId: Bytes32Schema,
  enabled: z.boolean(),
  eligible: z.boolean(),
  claimed: z.boolean(),
  reason: CompletionClaimReasonSchema,
  contractAddress: AddressSchema.nullable(),
  projectDeckRoot: Bytes32Schema.nullable(),
  cardCount: z.number().int().nonnegative().max(200),
  masteredCount: z.number().int().nonnegative().max(200),
}).strict();

export const CompletionClaimAuthorizationSchema = z.object({
  projectId: Bytes32Schema,
  contractAddress: AddressSchema,
  projectDeckRoot: Bytes32Schema,
  progressHash: Bytes32Schema,
  deadline: z.number().int().positive(),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/u),
}).strict();

export const CompletionClaimReviewSchema = z.object({
  authorization: CompletionClaimAuthorizationSchema,
  mossReview: MossOnchainReviewSchema,
}).strict();

export type MonadEvidenceState = z.infer<typeof MonadEvidenceStateSchema>;
export type MonadVerificationSnapshot = z.infer<typeof MonadVerificationSnapshotSchema>;
export type CompletionClaimStatus = z.infer<typeof CompletionClaimStatusSchema>;
export type CompletionClaimAuthorization = z.infer<typeof CompletionClaimAuthorizationSchema>;
export type CompletionClaimReview = z.infer<typeof CompletionClaimReviewSchema>;
export type MossNetworkSupport = z.infer<typeof MossNetworkSupportSchema>;
export type MossOnchainReview = z.infer<typeof MossOnchainReviewSchema>;
