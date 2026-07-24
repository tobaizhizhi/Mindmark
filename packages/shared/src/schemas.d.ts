import { z } from "zod";
export declare const MAX_SOURCE_PAGES = 30;
export declare const MAX_SOURCE_CHARACTERS = 60000;
export declare const MAX_SOURCE_CHUNKS = 12;
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
export declare const JourneyStatusSchema: z.ZodEnum<{
    CREATED: "CREATED";
    PREPARING: "PREPARING";
    AWAITING_CREATE_TX: "AWAITING_CREATE_TX";
    GENERATING: "GENERATING";
    FINALIZING: "FINALIZING";
    READY: "READY";
    FAILED_RETRYABLE: "FAILED_RETRYABLE";
    CANCELLED: "CANCELLED";
}>;
export declare const ChunkProgressSchema: z.ZodObject<{
    chunkId: z.ZodNumber;
    pageStart: z.ZodNumber;
    pageEnd: z.ZodNumber;
    title: z.ZodString;
    sourceChunkHash: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
    cardsRoot: z.ZodNullable<z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>>;
    workerAddress: z.ZodNullable<z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>>;
    status: z.ZodEnum<{
        GENERATING: "GENERATING";
        QUEUED: "QUEUED";
        VALIDATING: "VALIDATING";
        SAVED: "SAVED";
        SUBMITTING: "SUBMITTING";
        CONFIRMED: "CONFIRMED";
        MERGED: "MERGED";
        RETRYABLE: "RETRYABLE";
    }>;
    cardCount: z.ZodNullable<z.ZodNumber>;
    commitTxHash: z.ZodNullable<z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>>;
    confirmedBlock: z.ZodNullable<z.ZodString>;
    gasUsed: z.ZodNullable<z.ZodString>;
    generationMs: z.ZodNullable<z.ZodNumber>;
    confirmationMs: z.ZodNullable<z.ZodNumber>;
}, z.core.$strict>;
export declare const StudyQueueItemSchema: z.ZodObject<{
    reason: z.ZodEnum<{
        due: "due";
        planned: "planned";
    }>;
    card: z.ZodObject<{
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
}, z.core.$strict>;
export declare const StudyQueueSchema: z.ZodObject<{
    dueCount: z.ZodNumber;
    newCount: z.ZodNumber;
    queue: z.ZodArray<z.ZodObject<{
        reason: z.ZodEnum<{
            due: "due";
            planned: "planned";
        }>;
        card: z.ZodObject<{
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
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const JourneyDetailResponseSchema: z.ZodObject<{
    journeyId: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
    status: z.ZodEnum<{
        CREATED: "CREATED";
        PREPARING: "PREPARING";
        AWAITING_CREATE_TX: "AWAITING_CREATE_TX";
        GENERATING: "GENERATING";
        FINALIZING: "FINALIZING";
        READY: "READY";
        FAILED_RETRYABLE: "FAILED_RETRYABLE";
        CANCELLED: "CANCELLED";
    }>;
    sourceHash: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
    chunkManifestRoot: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
    createTxHash: z.ZodNullable<z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>>;
    finalizeTxHash: z.ZodNullable<z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>>;
    deckRoot: z.ZodNullable<z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>>;
    planHash: z.ZodNullable<z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>>;
    planVersion: z.ZodNumber;
    deck: z.ZodNullable<z.ZodArray<z.ZodObject<{
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
    }, z.core.$strict>>>;
    provenance: z.ZodNullable<z.ZodRecord<z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>, z.ZodObject<{
        chunkId: z.ZodNumber;
        cardLeaf: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
        chunkProof: z.ZodArray<z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>>;
    }, z.core.$strict>>>;
    plan: z.ZodNullable<z.ZodObject<{
        version: z.ZodNumber;
        generatedAt: z.ZodString;
        days: z.ZodArray<z.ZodObject<{
            dayOffset: z.ZodNumber;
            newCardIds: z.ZodArray<z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>>;
            reviewCardIds: z.ZodArray<z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    chunks: z.ZodArray<z.ZodObject<{
        chunkId: z.ZodNumber;
        pageStart: z.ZodNumber;
        pageEnd: z.ZodNumber;
        title: z.ZodString;
        sourceChunkHash: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
        cardsRoot: z.ZodNullable<z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>>;
        workerAddress: z.ZodNullable<z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>>;
        status: z.ZodEnum<{
            GENERATING: "GENERATING";
            QUEUED: "QUEUED";
            VALIDATING: "VALIDATING";
            SAVED: "SAVED";
            SUBMITTING: "SUBMITTING";
            CONFIRMED: "CONFIRMED";
            MERGED: "MERGED";
            RETRYABLE: "RETRYABLE";
        }>;
        cardCount: z.ZodNullable<z.ZodNumber>;
        commitTxHash: z.ZodNullable<z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>>;
        confirmedBlock: z.ZodNullable<z.ZodString>;
        gasUsed: z.ZodNullable<z.ZodString>;
        generationMs: z.ZodNullable<z.ZodNumber>;
        confirmationMs: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>>;
    studyQueue: z.ZodNullable<z.ZodObject<{
        dueCount: z.ZodNumber;
        newCount: z.ZodNumber;
        queue: z.ZodArray<z.ZodObject<{
            reason: z.ZodEnum<{
                due: "due";
                planned: "planned";
            }>;
            card: z.ZodObject<{
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
        }, z.core.$strict>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const CompleteSessionRequestSchema: z.ZodObject<{
    sessionId: z.ZodString;
}, z.core.$strict>;
export declare const CompleteSessionResponseSchema: z.ZodObject<{
    summary: z.ZodObject<{
        sessionId: z.ZodString;
        journeyId: z.ZodPipe<z.ZodString, z.ZodTransform<`0x${string}`, string>>;
        reviewedAt: z.ZodString;
        reviewedCount: z.ZodNumber;
        forgottenCount: z.ZodNumber;
        averageResponseMs: z.ZodNumber;
        dueForecast: z.ZodArray<z.ZodNumber>;
    }, z.core.$strict>;
    planUpdated: z.ZodBoolean;
    planVersion: z.ZodNumber;
    triggerReasons: z.ZodArray<z.ZodString>;
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
export type JourneyStatus = z.infer<typeof JourneyStatusSchema>;
export type ChunkProgress = z.infer<typeof ChunkProgressSchema>;
export type StudyQueue = z.infer<typeof StudyQueueSchema>;
export type JourneyDetailResponse = z.infer<typeof JourneyDetailResponseSchema>;
export type CompleteSessionRequest = z.infer<typeof CompleteSessionRequestSchema>;
export type CompleteSessionResponse = z.infer<typeof CompleteSessionResponseSchema>;
export type CardProvenance = z.infer<typeof CardProvenanceSchema>;
//# sourceMappingURL=schemas.d.ts.map