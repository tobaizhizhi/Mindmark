import { z } from "zod";
export declare const Bytes32Schema: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
export declare const AddressSchema: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
export declare const SourcePageSchema: z.ZodObject<{
    pageNumber: z.ZodNumber;
    text: z.ZodString;
}, z.core.$strict>;
export declare const CardSourceSchema: z.ZodObject<{
    page: z.ZodNumber;
    quote: z.ZodString;
}, z.core.$strict>;
export declare const KnowledgeCardContentSchema: z.ZodObject<{
    type: z.ZodEnum<{
        concept: "concept";
        qa: "qa";
    }>;
    question: z.ZodString;
    answer: z.ZodString;
    keyPoint: z.ZodString;
    source: z.ZodObject<{
        page: z.ZodNumber;
        quote: z.ZodString;
    }, z.core.$strict>;
    tags: z.ZodArray<z.ZodString>;
    importance: z.ZodNumber;
    initialDifficulty: z.ZodNumber;
}, z.core.$strict>;
export declare const KnowledgeCardSchema: z.ZodObject<{
    type: z.ZodEnum<{
        concept: "concept";
        qa: "qa";
    }>;
    question: z.ZodString;
    answer: z.ZodString;
    keyPoint: z.ZodString;
    source: z.ZodObject<{
        page: z.ZodNumber;
        quote: z.ZodString;
    }, z.core.$strict>;
    tags: z.ZodArray<z.ZodString>;
    importance: z.ZodNumber;
    initialDifficulty: z.ZodNumber;
    id: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
    cardHash: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
    chunkId: z.ZodNumber;
}, z.core.$strict>;
export declare const CommittedKnowledgeCardSchema: z.ZodObject<{
    type: z.ZodEnum<{
        concept: "concept";
        qa: "qa";
    }>;
    question: z.ZodString;
    answer: z.ZodString;
    keyPoint: z.ZodString;
    source: z.ZodObject<{
        page: z.ZodNumber;
        quote: z.ZodString;
    }, z.core.$strict>;
    tags: z.ZodArray<z.ZodString>;
    importance: z.ZodNumber;
    initialDifficulty: z.ZodNumber;
    id: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
    cardHash: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
    chunkId: z.ZodNumber;
    cardProof: z.ZodArray<z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>>;
}, z.core.$strict>;
export declare const SourceChunkContentSchema: z.ZodObject<{
    chunkId: z.ZodNumber;
    pageStart: z.ZodNumber;
    pageEnd: z.ZodNumber;
    title: z.ZodString;
    text: z.ZodString;
}, z.core.$strict>;
export declare const SourceChunkSchema: z.ZodObject<{
    chunkId: z.ZodNumber;
    pageStart: z.ZodNumber;
    pageEnd: z.ZodNumber;
    title: z.ZodString;
    text: z.ZodString;
    journeyId: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
    sourceChunkHash: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
    manifestProof: z.ZodArray<z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>>;
    cardBudget: z.ZodNumber;
}, z.core.$strict>;
export declare const ChunkResultSchema: z.ZodObject<{
    journeyId: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
    chunkId: z.ZodNumber;
    cards: z.ZodArray<z.ZodObject<{
        type: z.ZodEnum<{
            concept: "concept";
            qa: "qa";
        }>;
        question: z.ZodString;
        answer: z.ZodString;
        keyPoint: z.ZodString;
        source: z.ZodObject<{
            page: z.ZodNumber;
            quote: z.ZodString;
        }, z.core.$strict>;
        tags: z.ZodArray<z.ZodString>;
        importance: z.ZodNumber;
        initialDifficulty: z.ZodNumber;
        id: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
        cardHash: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
        chunkId: z.ZodNumber;
        cardProof: z.ZodArray<z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>>;
    }, z.core.$strict>>;
    cardsRoot: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
    cardCount: z.ZodNumber;
}, z.core.$strict>;
export declare const PlannedDaySchema: z.ZodObject<{
    dayOffset: z.ZodNumber;
    newCardIds: z.ZodArray<z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>>;
    reviewCardIds: z.ZodArray<z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>>;
}, z.core.$strict>;
export declare const ReviewPlanSchema: z.ZodObject<{
    version: z.ZodNumber;
    generatedAt: z.ZodString;
    days: z.ZodArray<z.ZodObject<{
        dayOffset: z.ZodNumber;
        newCardIds: z.ZodArray<z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>>;
        reviewCardIds: z.ZodArray<z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const SessionSummarySchema: z.ZodObject<{
    sessionId: z.ZodString;
    journeyId: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
    reviewedAt: z.ZodString;
    reviewedCount: z.ZodNumber;
    forgottenCount: z.ZodNumber;
    averageResponseMs: z.ZodNumber;
    dueForecast: z.ZodArray<z.ZodNumber>;
}, z.core.$strict>;
export declare const PrepareJourneyRequestSchema: z.ZodObject<{
    pages: z.ZodArray<z.ZodObject<{
        pageNumber: z.ZodNumber;
        text: z.ZodString;
    }, z.core.$strict>>;
    goal: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const CreateJourneyArgsSchema: z.ZodObject<{
    journeyId: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
    sourceHash: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
    goalHash: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
    chunkManifestRoot: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
    chunkCount: z.ZodNumber;
}, z.core.$strict>;
export declare const PrepareJourneyResponseSchema: z.ZodObject<{
    journeyId: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
    createJourneyArgs: z.ZodObject<{
        journeyId: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
        sourceHash: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
        goalHash: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
        chunkManifestRoot: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
        chunkCount: z.ZodNumber;
    }, z.core.$strict>;
    chunks: z.ZodArray<z.ZodObject<{
        chunkId: z.ZodNumber;
        pageStart: z.ZodNumber;
        pageEnd: z.ZodNumber;
        title: z.ZodString;
        cardBudget: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const AuthNonceRequestSchema: z.ZodObject<{
    address: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
}, z.core.$strict>;
export declare const AuthNonceResponseSchema: z.ZodObject<{
    nonce: z.ZodString;
    expiresAt: z.ZodString;
    chainId: z.ZodNumber;
    domain: z.ZodString;
    uri: z.ZodString;
}, z.core.$strict>;
export declare const AuthVerifyRequestSchema: z.ZodObject<{
    message: z.ZodString;
    signature: z.ZodString;
}, z.core.$strict>;
export declare const AuthVerifyResponseSchema: z.ZodObject<{
    address: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
    expiresAt: z.ZodString;
}, z.core.$strict>;
export declare const SaveCreateTransactionRequestSchema: z.ZodObject<{
    txHash: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
}, z.core.$strict>;
export declare const SaveCreateTransactionResponseSchema: z.ZodObject<{
    journeyId: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
    status: z.ZodLiteral<"CREATED">;
    blockNumber: z.ZodString;
}, z.core.$strict>;
export declare const ReviewRatingSchema: z.ZodEnum<{
    again: "again";
    hard: "hard";
    good: "good";
    easy: "easy";
}>;
export declare const SubmitReviewRequestSchema: z.ZodObject<{
    sessionId: z.ZodString;
    cardId: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
    rating: z.ZodEnum<{
        again: "again";
        hard: "hard";
        good: "good";
        easy: "easy";
    }>;
    responseMs: z.ZodNumber;
    reviewedAt: z.ZodString;
}, z.core.$strict>;
export declare const SubmitReviewResponseSchema: z.ZodObject<{
    accepted: z.ZodBoolean;
    duplicate: z.ZodBoolean;
    nextReviewAt: z.ZodString;
}, z.core.$strict>;
export declare const CardProvenanceSchema: z.ZodObject<{
    chunkId: z.ZodNumber;
    cardLeaf: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
    chunkProof: z.ZodArray<z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>>;
}, z.core.$strict>;
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
export type SaveCreateTransactionRequest = z.infer<typeof SaveCreateTransactionRequestSchema>;
export type SaveCreateTransactionResponse = z.infer<typeof SaveCreateTransactionResponseSchema>;
export type SubmitReviewRequest = z.infer<typeof SubmitReviewRequestSchema>;
export type SubmitReviewResponse = z.infer<typeof SubmitReviewResponseSchema>;
export type CardProvenance = z.infer<typeof CardProvenanceSchema>;
