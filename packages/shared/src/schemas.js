import { z } from "zod";
export const Bytes32Schema = z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/u, "Expected a 32-byte hex value")
    .transform((value) => value.toLowerCase());
export const AddressSchema = z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/u, "Expected an EVM address")
    .transform((value) => value.toLowerCase());
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
    pages: z.array(SourcePageSchema).min(1).max(10),
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
    if (pageNumbers.some((pageNumber, index) => index > 0 && pageNumber <= pageNumbers[index - 1])) {
        context.addIssue({
            code: "custom",
            message: "pages must be ordered by pageNumber",
            path: ["pages"],
        });
    }
    const totalCharacters = request.pages.reduce((total, page) => total + page.text.length, 0);
    if (totalCharacters > 20_000) {
        context.addIssue({
            code: "custom",
            message: "Extracted source text cannot exceed 20,000 characters",
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
    chunkCount: z.number().int().min(2).max(4),
})
    .strict();
export const PrepareJourneyResponseSchema = z
    .object({
    journeyId: Bytes32Schema,
    createJourneyArgs: CreateJourneyArgsSchema,
    chunks: z
        .array(z
        .object({
        chunkId: z.number().int().min(0).max(3),
        pageStart: z.number().int().positive(),
        pageEnd: z.number().int().positive(),
        title: z.string().min(1).max(200),
        cardBudget: z.number().int().min(1).max(30),
    })
        .strict())
        .min(2)
        .max(4),
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
//# sourceMappingURL=schemas.js.map