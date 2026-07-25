import { z } from "zod";

export const MAX_SOURCE_PAGES = 30;
export const MAX_SOURCE_CHARACTERS = 60_000;
export const MAX_SOURCE_CHUNKS = 12;

export const Bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/u, "Expected a 32-byte hex value")
  .transform((value) => value.toLowerCase() as `0x${string}`);

export const AddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/u, "Expected an EVM address")
  .transform((value) => value.toLowerCase() as `0x${string}`);

export const SourcePageSchema = z
  .object({
    pageNumber: z.number().int().positive(),
    text: z.string().trim().min(1).max(30_000),
  })
  .strict();

export const CardSourceSchema = z
  .object({
    page: z.number().int().positive(),
    quote: z.string().trim().min(20).max(400),
  })
  .strict();

export const KnowledgeCardContentSchema = z
  .object({
    type: z.enum(["concept", "qa"]),
    question: z.string().trim().min(1).max(500),
    answer: z.string().trim().min(1).max(1_500),
    keyPoint: z.string().trim().min(1).max(500),
    source: CardSourceSchema,
    tags: z.array(z.string().trim().min(1).max(40)).min(1).max(8),
    importance: z.number().int().min(1).max(5),
    initialDifficulty: z.number().int().min(1).max(5),
  })
  .strict();

export const KnowledgeCardSchema = KnowledgeCardContentSchema.extend({
  id: Bytes32Schema,
  cardHash: Bytes32Schema,
  chunkId: z.number().int().min(0).max(65_535),
}).strict();

export const CommittedKnowledgeCardSchema = KnowledgeCardSchema.extend({
  cardProof: z.array(Bytes32Schema),
}).strict();

export const SourceChunkContentSchema = z
  .object({
    chunkId: z.number().int().min(0).max(65_535),
    pageStart: z.number().int().positive(),
    pageEnd: z.number().int().positive(),
    title: z.string().trim().min(1).max(200),
    text: z.string().trim().min(1).max(30_000),
  })
  .strict()
  .refine((chunk) => chunk.pageEnd >= chunk.pageStart, {
    message: "pageEnd must be greater than or equal to pageStart",
    path: ["pageEnd"],
  });

export const SourceChunkSchema = SourceChunkContentSchema.extend({
  journeyId: Bytes32Schema,
  sourceChunkHash: Bytes32Schema,
  manifestProof: z.array(Bytes32Schema),
  cardBudget: z.number().int().min(1).max(30),
}).strict();

export const ChunkResultSchema = z
  .object({
    journeyId: Bytes32Schema,
    chunkId: z.number().int().min(0).max(65_535),
    cards: z.array(CommittedKnowledgeCardSchema).min(1).max(30),
    cardsRoot: Bytes32Schema,
    cardCount: z.number().int().min(1).max(30),
  })
  .strict()
  .refine((result) => result.cardCount === result.cards.length, {
    message: "cardCount must equal cards.length",
    path: ["cardCount"],
  });

export const PlannedDaySchema = z
  .object({
    dayOffset: z.number().int().min(0).max(6),
    newCardIds: z.array(Bytes32Schema).max(8),
    reviewCardIds: z.array(Bytes32Schema).max(15),
  })
  .strict()
  .refine((day) => day.newCardIds.length + day.reviewCardIds.length <= 15, {
    message: "A planned day cannot contain more than 15 tasks",
  });

export const ReviewPlanSchema = z
  .object({
    version: z.number().int().positive(),
    generatedAt: z.string().datetime({ offset: true }),
    days: z.array(PlannedDaySchema).length(7),
  })
  .strict();

export const SessionSummarySchema = z
  .object({
    sessionId: z.string().uuid(),
    journeyId: Bytes32Schema,
    reviewedAt: z.string().datetime({ offset: true }),
    reviewedCount: z.number().int().min(0).max(15),
    forgottenCount: z.number().int().min(0).max(15),
    averageResponseMs: z.number().int().nonnegative(),
    dueForecast: z.array(z.number().int().nonnegative()).length(7),
  })
  .strict()
  .refine((summary) => summary.forgottenCount <= summary.reviewedCount, {
    message: "forgottenCount cannot exceed reviewedCount",
    path: ["forgottenCount"],
  });

export const PrepareJourneyRequestSchema = z
  .object({
    pages: z.array(SourcePageSchema).min(1).max(MAX_SOURCE_PAGES),
    goal: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const pageNumbers = request.pages.map((page) => page.pageNumber);
    if (new Set(pageNumbers).size !== pageNumbers.length) {
      context.addIssue({
        code: "custom",
        message: "pageNumber values must be unique",
        path: ["pages"],
      });
    }
    if (pageNumbers.some((pageNumber, index) => index > 0 && pageNumber <= pageNumbers[index - 1]!)) {
      context.addIssue({
        code: "custom",
        message: "pages must be ordered by pageNumber",
        path: ["pages"],
      });
    }
    const totalCharacters = request.pages.reduce((total, page) => total + page.text.length, 0);
    if (totalCharacters > MAX_SOURCE_CHARACTERS) {
      context.addIssue({
        code: "custom",
        message: `Extracted source text cannot exceed ${MAX_SOURCE_CHARACTERS.toLocaleString()} characters`,
        path: ["pages"],
      });
    }
  });

export const CreateJourneyArgsSchema = z
  .object({
    journeyId: Bytes32Schema,
    sourceHash: Bytes32Schema,
    goalHash: Bytes32Schema,
    chunkManifestRoot: Bytes32Schema,
    chunkCount: z.number().int().min(2).max(MAX_SOURCE_CHUNKS),
  })
  .strict();

export const PrepareJourneyResponseSchema = z
  .object({
    journeyId: Bytes32Schema,
    createJourneyArgs: CreateJourneyArgsSchema,
    chunks: z
      .array(
        z
          .object({
            chunkId: z.number().int().min(0).max(MAX_SOURCE_CHUNKS - 1),
            pageStart: z.number().int().positive(),
            pageEnd: z.number().int().positive(),
            title: z.string().min(1).max(200),
            cardBudget: z.number().int().min(1).max(30),
          })
          .strict(),
      )
      .min(2)
      .max(MAX_SOURCE_CHUNKS),
  })
  .strict();

export const AuthNonceRequestSchema = z
  .object({ address: AddressSchema })
  .strict();

export const AuthNonceResponseSchema = z
  .object({
    nonce: z.string().min(8).max(64),
    expiresAt: z.string().datetime({ offset: true }),
    chainId: z.number().int().positive(),
    domain: z.string().min(1),
    uri: z.string().url(),
  })
  .strict();

export const AuthVerifyRequestSchema = z
  .object({
    message: z.string().min(1).max(4_000),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/u),
  })
  .strict();

export const AuthVerifyResponseSchema = z
  .object({ address: AddressSchema, expiresAt: z.string().datetime({ offset: true }) })
  .strict();

export const SaveCreateTransactionRequestSchema = z
  .object({ txHash: Bytes32Schema })
  .strict();

export const SaveCreateTransactionResponseSchema = z
  .object({
    journeyId: Bytes32Schema,
    status: z.literal("CREATED"),
    blockNumber: z.string().regex(/^\d+$/u),
  })
  .strict();

export const ReviewRatingSchema = z.enum(["again", "hard", "good", "easy"]);

export const SubmitReviewRequestSchema = z
  .object({
    sessionId: z.string().uuid(),
    cardId: Bytes32Schema,
    rating: ReviewRatingSchema,
    responseMs: z.number().int().min(0).max(3_600_000),
    reviewedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const SubmitReviewResponseSchema = z
  .object({
    accepted: z.boolean(),
    duplicate: z.boolean(),
    nextReviewAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const CardProvenanceSchema = z
  .object({
    chunkId: z.number().int().min(0).max(65_535),
    cardLeaf: Bytes32Schema,
    chunkProof: z.array(Bytes32Schema),
  })
  .strict();

export const JourneyStatusSchema = z.enum([
  "PREPARING",
  "AWAITING_CREATE_TX",
  "CREATED",
  "GENERATING",
  "FINALIZING",
  "READY",
  "FAILED_RETRYABLE",
  "CANCELLED",
]);

export const ChunkProgressSchema = z
  .object({
    chunkId: z.number().int().min(0).max(MAX_SOURCE_CHUNKS - 1),
    pageStart: z.number().int().positive(),
    pageEnd: z.number().int().positive(),
    title: z.string().min(1).max(200),
    sourceChunkHash: Bytes32Schema,
    cardsRoot: Bytes32Schema.nullable(),
    workerAddress: AddressSchema.nullable(),
    status: z.enum([
      "QUEUED",
      "GENERATING",
      "VALIDATING",
      "SAVED",
      "SUBMITTING",
      "CONFIRMED",
      "MERGED",
      "RETRYABLE",
    ]),
    cardCount: z.number().int().min(1).max(30).nullable(),
    commitTxHash: Bytes32Schema.nullable(),
    confirmedBlock: z.string().regex(/^\d+$/u).nullable(),
    gasUsed: z.string().regex(/^\d+$/u).nullable(),
    generationMs: z.number().int().nonnegative().nullable(),
    confirmationMs: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const MossRewardProgressSchema = z
  .object({
    chunkId: z.number().int().min(0).max(MAX_SOURCE_CHUNKS - 1),
    treasuryAddress: AddressSchema,
    recipientAddress: AddressSchema,
    amountWei: z.string().regex(/^\d+$/u),
    status: z.enum([
      "PENDING",
      "PROCESSING",
      "PREPARED",
      "SUBMITTING",
      "CONFIRMED",
      "RETRYABLE",
      "BLOCKED",
    ]),
    mossStage: z.enum(["PENDING", "DISCOVERED", "LOADED", "BUILT", "SIMULATED"]),
    simulationStatus: z.enum(["NOT_RUN", "PASSED", "FAILED"]),
    simulationWarningCodes: z.array(z.string().max(80)).max(20),
    simulationGas: z.string().regex(/^\d+$/u).nullable(),
    mossPlanHash: Bytes32Schema.nullable(),
    txHash: Bytes32Schema.nullable(),
    confirmedBlock: z.string().regex(/^\d+$/u).nullable(),
    gasUsed: z.string().regex(/^\d+$/u).nullable(),
    confirmationMs: z.number().int().nonnegative().nullable(),
    lastError: z.string().max(500).nullable(),
  })
  .strict();

export const StudyQueueItemSchema = z
  .object({
    reason: z.enum(["due", "planned"]),
    card: CommittedKnowledgeCardSchema,
  })
  .strict();

export const StudyQueueSchema = z
  .object({
    dueCount: z.number().int().nonnegative(),
    newCount: z.number().int().nonnegative(),
    queue: z.array(StudyQueueItemSchema).max(15),
  })
  .strict();

export const JourneyDetailResponseSchema = z
  .object({
    journeyId: Bytes32Schema,
    status: JourneyStatusSchema,
    sourceHash: Bytes32Schema,
    chunkManifestRoot: Bytes32Schema,
    createTxHash: Bytes32Schema.nullable(),
    finalizeTxHash: Bytes32Schema.nullable(),
    deckRoot: Bytes32Schema.nullable(),
    planHash: Bytes32Schema.nullable(),
    planVersion: z.number().int().positive(),
    deck: z.array(CommittedKnowledgeCardSchema).min(4).max(30).nullable(),
    provenance: z.record(Bytes32Schema, CardProvenanceSchema).nullable(),
    plan: ReviewPlanSchema.nullable(),
    chunks: z.array(ChunkProgressSchema).min(2).max(MAX_SOURCE_CHUNKS),
    rewards: z.array(MossRewardProgressSchema).default([]),
    studiedCardIds: z.array(Bytes32Schema).max(30).default([]),
    studyQueue: StudyQueueSchema.nullable(),
  })
  .strict();

export const CompleteSessionRequestSchema = z
  .object({ sessionId: z.string().uuid() })
  .strict();

export const CompleteSessionResponseSchema = z
  .object({
    summary: SessionSummarySchema,
    planUpdated: z.boolean(),
    planVersion: z.number().int().positive(),
    triggerReasons: z.array(z.string().min(1).max(80)).max(5),
  })
  .strict();

export type SourcePage = z.infer<typeof SourcePageSchema>;
export type KnowledgeCardContent = z.infer<typeof KnowledgeCardContentSchema>;
export type KnowledgeCard = z.infer<typeof KnowledgeCardSchema>;
export type CommittedKnowledgeCard = z.infer<typeof CommittedKnowledgeCardSchema>;
export type SourceChunkContent = z.infer<typeof SourceChunkContentSchema>;
export type SourceChunk = z.infer<typeof SourceChunkSchema>;
export type ChunkResult = z.infer<typeof ChunkResultSchema>;
export type ReviewPlan = z.infer<typeof ReviewPlanSchema>;
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export type PrepareJourneyRequest = z.infer<typeof PrepareJourneyRequestSchema>;
export type PrepareJourneyResponse = z.infer<typeof PrepareJourneyResponseSchema>;
export type AuthNonceRequest = z.infer<typeof AuthNonceRequestSchema>;
export type AuthNonceResponse = z.infer<typeof AuthNonceResponseSchema>;
export type AuthVerifyRequest = z.infer<typeof AuthVerifyRequestSchema>;
export type AuthVerifyResponse = z.infer<typeof AuthVerifyResponseSchema>;
export type SaveCreateTransactionRequest = z.infer<
  typeof SaveCreateTransactionRequestSchema
>;
export type SaveCreateTransactionResponse = z.infer<
  typeof SaveCreateTransactionResponseSchema
>;
export type SubmitReviewRequest = z.infer<typeof SubmitReviewRequestSchema>;
export type SubmitReviewResponse = z.infer<typeof SubmitReviewResponseSchema>;
export type JourneyStatus = z.infer<typeof JourneyStatusSchema>;
export type ChunkProgress = z.infer<typeof ChunkProgressSchema>;
export type MossRewardProgress = z.infer<typeof MossRewardProgressSchema>;
export type StudyQueue = z.infer<typeof StudyQueueSchema>;
export type JourneyDetailResponse = z.infer<typeof JourneyDetailResponseSchema>;
export type CompleteSessionRequest = z.infer<typeof CompleteSessionRequestSchema>;
export type CompleteSessionResponse = z.infer<typeof CompleteSessionResponseSchema>;
export type CardProvenance = z.infer<typeof CardProvenanceSchema>;
